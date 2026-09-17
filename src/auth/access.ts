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

/** HTTP-статус чтения → доступ к каналу (контракт К2; AppSec 404 — отдельно, Ф1.4). */
export function accessFromStatus(status: number): ChannelAccess {
  if (status === 200) return "granted";
  if (status === 403 || status === 404) return "denied";
  if (status === 401) return "pat-expired";
  return "check-failed";
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
      // repo granted; иначе 404 — отказ (живой зонд чужим PAT — Ф2.6)
      const corroborated = cicd === "granted" || (!isPublic && repoAccess === "granted");
      appsec = res.status === 404 ? (corroborated ? "granted" : "denied") : accessFromStatus(res.status);
    }
    store("appsec", appsec);
  }

  return { cicd, appsec, repo: repoAccess };
}
