// access.ts — доступ зрителя к каналам карточки (В4.1, К2; решение 17.09
// Екатерины). Эндпоинта «мои права на репо» у платформы нет, поэтому
// доступ выражается исходом реального чтения данных PAT зрителя:
//   CI       — GET /repos/{org}/{repo}/cicd/runs?page_size=1
//   Security — REST GET /repos/{org}/{repo} → id → AppSec GET /v1/scans/latest?gitRepo=<id>
//   repo     — тот же REST repo-GET (только для приватных репо)
// Один REST repo-GET на показ переиспользуется для repo и id AppSec.
// Семантика ответа: 200 → granted; 403/404 → denied; 401 → pat-expired;
// 0/429/5xx/таймаут → check-failed. Зритель без сессии/PAT → no-pat без
// единого запроса. Кэш в памяти процесса: ключ (user, repo, channel), TTL
// Config.access.cacheTtlMs; смена/удаление PAT сбрасывает записи юзера.
// Значение PAT не логируется и не хранится.
// В4.1-fix: AppSec scans/latest 404 при repo-GET 200 → granted (скана ещё
// нет — право есть, Ф1.4); check-failed кэшируется на
// Config.access.failedTtlMs (сбой ≠ результат, но и не повод долбить
// платформу — Ф1.6); предел кэша Config.access.maxEntries с вытеснением
// старейших; одновременные проверки (user, repo, поколение PAT) склеиваются
// в один in-flight промис; поколение PAT (Ф1.12) — счётчик на юзера:
// clearUser повышает, запись результата старого поколения отбрасывается.
import type { AppsecClient } from "../collectors/appsec";
import type { ScClient } from "../collectors/http";

export type ChannelAccess = "granted" | "denied" | "no-pat" | "pat-expired" | "check-failed";

export type AccessChannel = "cicd" | "appsec" | "repo";

export interface AccessResult {
  cicd: ChannelAccess;
  appsec: ChannelAccess;
  repo: ChannelAccess;
}

/** Аноним / зритель без PAT: всё закрыто, запросов нет. */
export const NO_PAT_ACCESS: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };

export interface AccessViewer {
  userId: number;
  /** расшифрованный PAT зрителя; null = PAT не сохранён */
  pat: string | null;
}

export interface AccessRepo {
  id: number;
  org: string;
  repo: string;
  visibility: string;
}

export interface AccessCache {
  get(userId: number, repoId: number, channel: AccessChannel, now: number): ChannelAccess | null;
  /** gen — поколение PAT на момент начала проверки: устаревшее поколение не пишется (Ф1.12) */
  set(userId: number, repoId: number, channel: AccessChannel, value: ChannelAccess, now: number, gen?: number): void;
  /** сброс при смене/удалении PAT (PUT/DELETE /api/me/pat): записи юзера удаляются, поколение +1 */
  clearUser(userId: number): void;
  /** текущее поколение PAT юзера */
  generation(userId: number): number;
  /** число записей (предел maxEntries) */
  size(): number;
  /** склейка одновременных проверок: ключ (user, repo, поколение) → промис результата */
  inflight: Map<string, Promise<AccessResult>>;
}

export interface AccessCacheOptions {
  /** TTL check-failed (Config.access.failedTtlMs, дефолт 60 с) */
  failedTtlMs?: number;
  /** предел записей (Config.access.maxEntries, дефолт 10 000): сверх — вытеснение старейших */
  maxEntries?: number;
}

export function makeAccessCache(ttlMs: number, opts: AccessCacheOptions = {}): AccessCache {
  const failedTtlMs = opts.failedTtlMs ?? 60_000;
  const maxEntries = Math.max(1, opts.maxEntries ?? 10_000);
  // Map хранит порядок вставки: первая запись — старейшая
  const entries = new Map<string, { value: ChannelAccess; expiresAt: number }>();
  const generations = new Map<number, number>();
  const key = (userId: number, repoId: number, channel: AccessChannel) => `${userId}:${repoId}:${channel}`;
  const generation = (userId: number) => generations.get(userId) ?? 0;
  return {
    get(userId, repoId, channel, now) {
      const k = key(userId, repoId, channel);
      const e = entries.get(k);
      if (!e) return null;
      if (e.expiresAt <= now) {
        entries.delete(k);
        return null;
      }
      return e.value;
    },
    set(userId, repoId, channel, value, now, gen) {
      // результат проверки старым PAT после его смены — не знание о новых правах
      if (gen !== undefined && gen !== generation(userId)) return;
      // сбой проверки — не знание о правах: короткий TTL, чтобы не долбить платформу
      const ttl = value === "check-failed" ? failedTtlMs : ttlMs;
      const k = key(userId, repoId, channel);
      entries.delete(k);
      entries.set(k, { value, expiresAt: now + ttl });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clearUser(userId) {
      generations.set(userId, generation(userId) + 1);
      const prefix = `${userId}:`;
      for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
    },
    generation,
    size: () => entries.size,
    inflight: new Map(),
  };
}

export interface AccessDeps {
  /** REST-клиент на PAT зрителя */
  restClient: (pat: string) => ScClient;
  /** AppSec-клиент на PAT зрителя */
  appsecClient: (pat: string) => AppsecClient;
  cache: AccessCache;
  now?: () => number;
}

/**
 * В4.8.5 (К8.5.6): ОДИН классификатор ответа SourceCraft для пробы PAT,
 * проверки прав избранного, доступа карточки и предпроверки запуска.
 * Вердикт о правах — только 200 / 403-404 / 401; сбой платформы (сеть,
 * таймаут = 0, 429, 5xx, прочее) — «проверка не удалась», а не «прав нет»:
 * такой ответ не пишется в сохранённые права, не кэшируется как `denied`,
 * не списывает окна проб и запусков.
 * 401 — токен отклонён (перезапись прав при нём верна, ложен был только текст);
 * 401 или 403 у ИСТЕКШЕГО токена — предположение ступени 1, проверка — сессией
 * владельца на гейте.
 */
export type ScVerdict = "ok" | "denied" | "token-rejected" | "unavailable";

export function classifyScStatus(status: number): ScVerdict {
  if (status === 200) return "ok";
  if (status === 401) return "token-rejected";
  if (status === 403 || status === 404) return "denied";
  return "unavailable";
}

/** HTTP-статус чтения → доступ к каналу (контракт К2; AppSec 404 — отдельно, Ф1.4) — через общий классификатор. */
export function accessFromStatus(status: number): ChannelAccess {
  switch (classifyScStatus(status)) {
    case "ok":
      return "granted";
    case "denied":
      return "denied";
    case "token-rejected":
      return "pat-expired";
    default:
      return "check-failed";
  }
}

/**
 * AppSec `scans/latest` 404 («скана ещё нет»): право есть, только если его
 * подтверждает другой канал (CI granted или приватный с repo granted —
 * Ф1.4 + круг 2 LOW-5). В4.8.5 (К8.5.6, С8-6): если подтверждающий канал сам
 * не проверился (сбой CI, отклонённый токен), 404 — «неизвестно», а не отказ:
 * иначе сбой CI превращался в `denied` Security, закэшированный на 15 минут.
 */
export function appsecOn404(cicd: ChannelAccess, visibility: string, repoAccess: ChannelAccess): ChannelAccess {
  // закрытие В4.8.5 (ревью): «репо виден токену» подтверждает права только у
  // ПРИВАТНОГО — internal видит любой вошедший в SourceCraft токен (живой
  // зонд 22.09), а «неизвестно» ничего не доказывает; иначе чужой internal с
  // 404 AppSec становился «своим» (К8.5.14) и открывал Security
  const corroborated = cicd === "granted" || (visibility === "private" && repoAccess === "granted");
  if (corroborated) return "granted";
  if (cicd === "check-failed" || cicd === "pat-expired") return "check-failed";
  return "denied";
}

// ---------- В4.8.5 (К8.5.14): «свой» — одно определение для сервера и UI ----------

/** Доступ зрителя к репозиторию, нормализованный для правила «свой». */
export interface NormalizedAccess {
  repo: ChannelAccess;
  cicd: ChannelAccess;
  appsec: ChannelAccess;
  /** видимость: карточка — из БД, живая проверка — из тела repo-GET */
  visibility: "public" | "internal" | "private" | "unknown";
}

/**
 * «Свой» репозиторий (правило `me.ts:668` до В4.8.5, вынесенное в общую
 * функцию): CI или Security доступны токену, или репозиторий приватный и
 * виден токену. Неизвестно (сбой проверки, нет токена, нет сессии) — НЕ свой
 * (fail-closed). Известная граница: публичный репозиторий, где токен не видит
 * ни CI, ни Security, своим не считается.
 */
export function isOwnRepo(a: NormalizedAccess): boolean {
  // В5.3 (25.09, Екатерина): internal-репозиторий, код которого виден токену, — тоже
  // «свой» для анализа (как приватный): «у нас же есть доступ к коду». AI-обзор ему
  // при этом недоступен без прав на CI/CD и Безопасность (гейт маршрута /summary)
  return (
    a.cicd === "granted" ||
    a.appsec === "granted" ||
    ((a.visibility === "private" || a.visibility === "internal") && a.repo === "granted")
  );
}

/**
 * «Свой» НЕ ОПРЕДЕЛЁН (К8.5.6, круг 2 П1): репозиторий виден токену, правило
 * «свой» не выполнено, но хотя бы один канал (CI, Security) не проверился —
 * сбой SourceCraft/AppSec (0/429/5xx) или отклонённый токен. Это не вердикт
 * «не свой»: прежние права не перезаписываются, заявка не делает вывода, ждём
 * удачной проверки. Предпроверка `/scan` (доступ карточки из кэша); проверка
 * прав избранного — то же правило по `RepoProbe.channelsFailed` живой пробы
 * (там видно, спрашивался ли AppSec).
 */
export function ownUndecided(a: NormalizedAccess): boolean {
  if (isOwnRepo(a) || a.repo !== "granted") return false;
  const undecided = (c: ChannelAccess) => c === "check-failed" || c === "pat-expired";
  return undecided(a.cicd) || undecided(a.appsec);
}

/** Видимость строки `repos` → нормализованная. */
export function visibilityOf(raw: unknown): NormalizedAccess["visibility"] {
  // гейт В4.8.5: у SourceCraft три значения (`Repository.Visibility`:
  // public, internal, private); internal видят все вошедшие в SourceCraft —
  // это не «свой» и не публичный рейтинг
  return raw === "private" ? "private" : raw === "public" ? "public" : raw === "internal" ? "internal" : "unknown";
}

/** Исход живой проверки прав одного репозитория (repo-GET → cicd/runs → AppSec). */
export interface RepoProbe {
  access: NormalizedAccess;
  /** тело repo-GET — чтобы предпроверка запуска не делала его второй раз */
  repoRes: { status: number; json: unknown };
  /**
   * Круг 2 (П1): спрошенный канал (CI или AppSec) не ответил — сбой
   * (0/429/5xx) или отклонённый токен. Неспрошенный AppSec (тело repo-GET
   * без `id`) сбоем не считается: это форма ответа, а не отказ платформы.
   */
  channelsFailed: boolean;
}

/**
 * Живая проверка прав PAT зрителя на один репозиторий — ОДНА для
 * автопроверки при добавлении в избранное, фоновой перепроверки и
 * предпроверки запуска (К8.5.14): до 3 запросов (repo-GET, cicd/runs,
 * AppSec scans/latest), те же правила, что у карточки (`resolveAccess`).
 * repo-GET не дал доступа — каналы закрыты той же причиной, без запросов.
 */
export async function probeRepoAccess(io: ProbeIo, org: string, repo: string): Promise<RepoProbe> {
  const slugPath = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const res = await io.restGet(slugPath);
  const repoAccess = accessFromStatus(res.status);
  const body = (res.status === 200 ? res.json : null) as { visibility?: unknown; id?: unknown } | null;
  const visibility = visibilityOf(body?.visibility);
  const repoRes = { status: res.status, json: res.json };
  if (repoAccess !== "granted") {
    return { access: { repo: repoAccess, cicd: repoAccess, appsec: repoAccess, visibility }, repoRes, channelsFailed: false };
  }
  const ci = await io.restGet(`${slugPath}/cicd/runs?page_size=1`);
  const cicd = accessFromStatus(ci.status);
  const id = typeof body?.id === "string" && body.id !== "" ? body.id : null;
  let appsecAccess: ChannelAccess = "check-failed"; // форма ответа без id — не знание о правах
  if (id !== null) {
    const sec = await io.appsecLatest(id);
    appsecAccess = sec.status === 404 ? appsecOn404(cicd, visibility, repoAccess) : accessFromStatus(sec.status);
  }
  const failed = (c: ChannelAccess) => c === "check-failed" || c === "pat-expired";
  const channelsFailed = failed(cicd) || (id !== null && failed(appsecAccess));
  return { access: { repo: repoAccess, cicd, appsec: appsecAccess, visibility }, repoRes, channelsFailed };
}

/** Ввод-вывод живой проверки: REST GET и AppSec scans/latest (тесты — фейки, сервер — клиенты на PAT зрителя). */
export interface ProbeIo {
  restGet: (path: string) => Promise<{ status: number; json: unknown }>;
  appsecLatest: (gitRepo: string) => Promise<{ status: number }>;
}

/** Клиенты на PAT → ввод-вывод проверки. */
export function probeIoOf(rest: ScClient, appsec: AppsecClient): ProbeIo {
  return {
    restGet: (path) => rest.get(path).then((r) => ({ status: r.status, json: r.json })),
    appsecLatest: (gitRepo) => appsec.get("/v1/scans/latest", { gitRepo }).then((r) => ({ status: r.status })),
  };
}

export async function resolveAccess(deps: AccessDeps, viewer: AccessViewer | null, repo: AccessRepo): Promise<AccessResult> {
  if (!viewer || !viewer.pat) return { ...NO_PAT_ACCESS };
  // Ф1.6: одновременные показы одному зрителю одного репо — одна проверка
  const gen = deps.cache.generation(viewer.userId);
  const flightKey = `${viewer.userId}:${repo.id}:${gen}`;
  const running = deps.cache.inflight.get(flightKey);
  if (running) return { ...(await running) };
  const promise = resolveUncached(deps, { userId: viewer.userId, pat: viewer.pat }, repo, gen);
  deps.cache.inflight.set(flightKey, promise);
  try {
    return { ...(await promise) };
  } finally {
    deps.cache.inflight.delete(flightKey);
  }
}

async function resolveUncached(deps: AccessDeps, viewer: { userId: number; pat: string }, repo: AccessRepo, gen: number): Promise<AccessResult> {
  const pat = viewer.pat;
  const now = deps.now ? deps.now() : Date.now();
  const cached = (channel: AccessChannel) => deps.cache.get(viewer.userId, repo.id, channel, now);
  const store = (channel: AccessChannel, value: ChannelAccess) => {
    // круг 2 (LOW-9): сбой проверки доступа к приватному репо не кэшируется — иначе 60 с 404 владельцу
    if (channel === "repo" && value === "check-failed") return;
    deps.cache.set(viewer.userId, repo.id, channel, value, now, gen);
  };
  const slugPath = `/repos/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.repo)}`;

  let rest: ScClient | null = null;
  const restOf = () => (rest ??= deps.restClient(pat));

  // один REST repo-GET на показ: и доступ к приватному репо, и id для AppSec
  let repoGet: { access: ChannelAccess; id: string | null } | null = null;
  const readRepo = async () => {
    if (repoGet) return repoGet;
    const res = await restOf().get(slugPath);
    const id = (res.json as { id?: unknown } | null)?.id;
    repoGet = { access: accessFromStatus(res.status), id: typeof id === "string" && id !== "" ? id : null };
    return repoGet;
  };

  const isPublic = repo.visibility === "public";
  let repoAccess: ChannelAccess | null = isPublic ? "granted" : cached("repo");
  if (repoAccess === null) {
    repoAccess = (await readRepo()).access;
    store("repo", repoAccess);
  }
  // приватный без доступа: карточки не будет — каналы закрыты той же причиной, без запросов
  if (!isPublic && repoAccess !== "granted") {
    return { cicd: repoAccess, appsec: repoAccess, repo: repoAccess };
  }

  let cicd = cached("cicd");
  if (cicd === null) {
    const res = await restOf().get(`${slugPath}/cicd/runs?page_size=1`);
    cicd = accessFromStatus(res.status);
    store("cicd", cicd);
  }

  let appsec = cached("appsec");
  if (appsec === null) {
    const r = await readRepo();
    if (r.access !== "granted") {
      appsec = r.access;
    } else if (r.id === null) {
      appsec = "check-failed"; // форма ответа неожиданная — не знание о правах
    } else {
      const res = await deps.appsecClient(pat).get("/v1/scans/latest", { gitRepo: r.id });
      // Ф1.4 + круг 2 (LOW-5): 404 «скана ещё нет» считается доступом только
      // при другом подтверждении прав PAT — CI granted или приватный репо с
      // repo granted; иначе 404 — отказ (живой зонд чужим PAT — Ф2.6).
      // В4.8.5 (К8.5.6, С8-6): неподтверждённый из-за СБОЯ CI 404 — «неизвестно»
      appsec = res.status === 404 ? appsecOn404(cicd, repo.visibility, repoAccess) : accessFromStatus(res.status);
    }
    store("appsec", appsec);
  }

  return { cicd, appsec, repo: repoAccess };
}
