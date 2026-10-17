// Доступ зрителя к каналам карточки. Эндпоинта «мои права на репо» у
// SourceCraft нет, поэтому доступ – это исход реального чтения данных PAT
// зрителя:
//   CI       – GET /repos/{org}/{repo}/cicd/runs?page_size=1
//   Security – REST GET /repos/{org}/{repo} → id → AppSec GET /v1/scans/latest?gitRepo=<id>
//   repo     – тот же REST repo-GET (только для непубличных репо)
// Ответ: 200 → granted; 403/404 → denied; 401 → pat-expired;
// 0/429/5xx/таймаут → check-failed. Без сессии или PAT – no-pat без запросов.
// Результаты кэшируются в памяти процесса по (user, repo, channel); смена или
// удаление PAT повышает «поколение» пользователя, и результаты проверок
// старым PAT больше не записываются. Значение PAT не логируется и не хранится.
import type { AppsecClient } from "../collectors/appsec";
import type { ScClient } from "../collectors/http";

export type ChannelAccess = "granted" | "denied" | "no-pat" | "pat-expired" | "check-failed";

export type AccessChannel = "cicd" | "appsec" | "repo";

export interface AccessResult {
  cicd: ChannelAccess;
  appsec: ChannelAccess;
  repo: ChannelAccess;
}

/** Аноним или зритель без PAT: все закрыто, запросов нет. */
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
  /** gen – поколение PAT на момент начала проверки: результат устаревшего поколения не пишется */
  set(userId: number, repoId: number, channel: AccessChannel, value: ChannelAccess, now: number, gen?: number): void;
  /** сброс при смене/удалении PAT (PUT/DELETE /api/me/pat): записи юзера удаляются, поколение +1 */
  clearUser(userId: number): void;
  generation(userId: number): number;
  size(): number;
  /** склейка одновременных проверок: ключ (user, repo, поколение) → промис результата */
  inflight: Map<string, Promise<AccessResult>>;
}

export interface AccessCacheOptions {
  /** короткий TTL для check-failed (Config.access.failedTtlMs, по умолчанию 60 с) */
  failedTtlMs?: number;
  /** предел записей (Config.access.maxEntries, по умолчанию 10 000): сверх него вытесняются старейшие */
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
  restClient: (pat: string) => ScClient;
  appsecClient: (pat: string) => AppsecClient;
  cache: AccessCache;
  now?: () => number;
}

/**
 * Единый классификатор ответа SourceCraft для пробы PAT, проверки прав
 * избранного, доступа карточки и предпроверки запуска. Вердикт о правах дают
 * только 200, 403/404 и 401 (токен отклонен). Сбой платформы (сеть, таймаут
 * = 0, 429, 5xx, прочее) – «проверка не удалась», а не «прав нет»: такой
 * ответ не пишется в сохраненные права и не кэшируется как `denied`.
 * Что именно отдает истекший токен – 401 или 403 – не проверено.
 */
export type ScVerdict = "ok" | "denied" | "token-rejected" | "unavailable";

export function classifyScStatus(status: number): ScVerdict {
  if (status === 200) return "ok";
  if (status === 401) return "token-rejected";
  if (status === 403 || status === 404) return "denied";
  return "unavailable";
}

/** HTTP-статус чтения → доступ к каналу. AppSec 404 разбирается отдельно (`appsecOn404`). */
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
 * AppSec `scans/latest` отвечает 404 и когда скана еще нет, и когда прав нет.
 * Поэтому 404 – доступ, только если права подтверждает другой канал (CI
 * granted или приватный репо с repo granted). Если подтверждающий канал сам
 * не проверился (сбой CI, отклонен токен), 404 – «неизвестно», а не отказ:
 * иначе сбой CI превращался бы в закэшированный `denied` для Security.
 */
export function appsecOn404(cicd: ChannelAccess, visibility: string, repoAccess: ChannelAccess): ChannelAccess {
  // «репо виден токену» подтверждает права только у приватного: internal видит
  // любой вошедший в SourceCraft токен, и чужой internal иначе открыл бы Security
  const corroborated = cicd === "granted" || (visibility === "private" && repoAccess === "granted");
  if (corroborated) return "granted";
  if (cicd === "check-failed" || cicd === "pat-expired") return "check-failed";
  return "denied";
}

// ---------- «свой» репозиторий: одно определение для сервера и UI ----------

/** Доступ зрителя к репозиторию, нормализованный для правила «свой». */
export interface NormalizedAccess {
  repo: ChannelAccess;
  cicd: ChannelAccess;
  appsec: ChannelAccess;
  /** видимость: карточка — из БД, живая проверка — из тела repo-GET */
  visibility: "public" | "internal" | "private" | "unknown";
}

/**
 * «Свой» репозиторий: токену доступны CI или Security, либо репозиторий
 * приватный или internal и виден токену. Неизвестность (сбой проверки, нет
 * токена или сессии) – не свой. Публичный репозиторий, где токен не видит ни
 * CI, ни Security, своим не считается: анализ по кнопке ему открывает членство
 * в организации (`launchRightOf`), а AI-обзор и закрытые категории – нет.
 */
export function isOwnRepo(a: NormalizedAccess): boolean {
  // internal с видимым кодом – «свой» для анализа, как приватный; AI-обзор ему
  // все равно недоступен без прав на CI/CD и Безопасность (гейт маршрута /summary)
  return (
    a.cicd === "granted" ||
    a.appsec === "granted" ||
    ((a.visibility === "private" || a.visibility === "internal") && a.repo === "granted")
  );
}

/**
 * «Свой» не определен: репозиторий виден токену, правило «свой» не выполнено,
 * но хотя бы один канал (CI, Security) не проверился – сбой SourceCraft/AppSec
 * или отклоненный токен. Это не вердикт «не свой»: прежние права не
 * перезаписываются, ждем удачной проверки. Проверка прав избранного применяет
 * то же правило через `RepoProbe.channelsFailed`.
 */
export function ownUndecided(a: NormalizedAccess): boolean {
  if (isOwnRepo(a) || a.repo !== "granted") return false;
  const undecided = (c: ChannelAccess) => c === "check-failed" || c === "pat-expired";
  return undecided(a.cicd) || undecided(a.appsec);
}

// ---------- право запустить анализ по кнопке ----------

/**
 * Есть ли репозиторий в списке SourceCraft по токену пользователя (`/me/repos`):
 * закрытые, которые видит токен, и публичные репозитории его организаций.
 * `unknown` – списка нет (сбой SourceCraft, окно обходов исчерпано) или обход
 * прервался раньше, чем дошел до репозитория.
 */
export type TokenMembership = "yes" | "no" | "unknown";

/**
 * Право запустить анализ по кнопке:
 *   own            – свой (`isOwnRepo`): без ограничения частоты на репозиторий;
 *   member         – публичный репозиторий из списка по токену, а свой не доказан:
 *                    запуск с ограничением частоты на репозиторий (`repoCooldownMs`);
 *   none           – репозиторий виден токену, но не из его организаций;
 *   denied         – токен репозиторий не видит;
 *   token-rejected – SourceCraft отклонил токен;
 *   unknown        – проверить не удалось: не вердикт, запуск не ставится.
 */
export type LaunchRight = "own" | "member" | "none" | "denied" | "token-rejected" | "unknown";

/** Нужен ли список по токену: только виденному токену репозиторию, который не свой. */
export function needsMembership(a: NormalizedAccess): boolean {
  return a.repo === "granted" && !isOwnRepo(a);
}

/**
 * Право запуска из доступа и членства (`null` – список не спрашивали). Членство
 * проверяется раньше неопределенного «своего»: если CI или AppSec не ответили,
 * а репозиторий есть в списке, запуск идет с ограничением частоты, как у
 * участника без прав на CI/CD и Безопасность.
 */
export function launchRightOf(a: NormalizedAccess, member: TokenMembership | null): LaunchRight {
  if (isOwnRepo(a)) return "own";
  if (a.repo === "pat-expired") return "token-rejected";
  if (a.repo === "denied") return "denied";
  if (a.repo !== "granted") return "unknown";
  if (member === "yes") return "member";
  if (member !== "no" || ownUndecided(a)) return "unknown";
  return "none";
}

export function visibilityOf(raw: unknown): NormalizedAccess["visibility"] {
  // у SourceCraft три значения `Repository.Visibility`: public, internal, private;
  // internal видят все вошедшие в SourceCraft – это не публичный рейтинг
  return raw === "private" ? "private" : raw === "public" ? "public" : raw === "internal" ? "internal" : "unknown";
}

/** Исход живой проверки прав одного репозитория (repo-GET → cicd/runs → AppSec). */
export interface RepoProbe {
  access: NormalizedAccess;
  /** тело repo-GET — чтобы предпроверка запуска не делала его второй раз */
  repoRes: { status: number; json: unknown };
  /**
   * Спрошенный канал (CI или AppSec) не ответил – сбой или отклоненный токен.
   * Неспрошенный AppSec (тело repo-GET без `id`) сбоем не считается: это форма
   * ответа, а не отказ платформы.
   */
  channelsFailed: boolean;
}

/**
 * Живая проверка прав PAT зрителя на один репозиторий – общая для добавления
 * в избранное, фоновой перепроверки и предпроверки запуска: до 3 запросов
 * (repo-GET, cicd/runs, AppSec scans/latest) по тем же правилам, что у
 * карточки (`resolveAccess`). Если repo-GET не дал доступа, каналы закрыты той
 * же причиной без запросов.
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

/** Ввод-вывод живой проверки; в тестах подменяется фейками. */
export interface ProbeIo {
  restGet: (path: string) => Promise<{ status: number; json: unknown }>;
  appsecLatest: (gitRepo: string) => Promise<{ status: number }>;
}

export function probeIoOf(rest: ScClient, appsec: AppsecClient): ProbeIo {
  return {
    restGet: (path) => rest.get(path).then((r) => ({ status: r.status, json: r.json })),
    appsecLatest: (gitRepo) => appsec.get("/v1/scans/latest", { gitRepo }).then((r) => ({ status: r.status })),
  };
}

export async function resolveAccess(deps: AccessDeps, viewer: AccessViewer | null, repo: AccessRepo): Promise<AccessResult> {
  if (!viewer || !viewer.pat) return { ...NO_PAT_ACCESS };
  // одновременные показы одного репо одному зрителю делят одну проверку
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
    // сбой проверки доступа к репо не кэшируем: иначе владелец 60 с видел бы 404
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
      appsec = res.status === 404 ? appsecOn404(cicd, repo.visibility, repoAccess) : accessFromStatus(res.status);
    }
    store("appsec", appsec);
  }

  return { cicd, appsec, repo: repoAccess };
}
