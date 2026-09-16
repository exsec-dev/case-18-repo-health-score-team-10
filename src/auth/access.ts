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
// Config.access.cacheTtlMs; check-failed не кэшируется; смена/удаление
// PAT сбрасывает записи юзера. Значение PAT не логируется и не хранится.
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
  set(userId: number, repoId: number, channel: AccessChannel, value: ChannelAccess, now: number): void;
  /** сброс при смене/удалении PAT (PUT/DELETE /api/me/pat) */
  clearUser(userId: number): void;
}

export function makeAccessCache(ttlMs: number): AccessCache {
  const entries = new Map<string, { value: ChannelAccess; expiresAt: number }>();
  const key = (userId: number, repoId: number, channel: AccessChannel) => `${userId}:${repoId}:${channel}`;
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
    set(userId, repoId, channel, value, now) {
      // сбой проверки — не знание о правах: повторяем на следующем показе
      if (value === "check-failed") return;
      entries.set(key(userId, repoId, channel), { value, expiresAt: now + ttlMs });
    },
    clearUser(userId) {
      const prefix = `${userId}:`;
      for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
    },
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

/** HTTP-статус чтения → доступ к каналу (контракт К2). */
export function accessFromStatus(status: number): ChannelAccess {
  if (status === 200) return "granted";
  if (status === 403 || status === 404) return "denied";
  if (status === 401) return "pat-expired";
  return "check-failed";
}

export async function resolveAccess(deps: AccessDeps, viewer: AccessViewer | null, repo: AccessRepo): Promise<AccessResult> {
  if (!viewer || !viewer.pat) return { ...NO_PAT_ACCESS };
  const pat = viewer.pat;
  const now = deps.now ? deps.now() : Date.now();
  const cached = (channel: AccessChannel) => deps.cache.get(viewer.userId, repo.id, channel, now);
  const store = (channel: AccessChannel, value: ChannelAccess) => deps.cache.set(viewer.userId, repo.id, channel, value, now);
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
      appsec = accessFromStatus(res.status);
    }
    store("appsec", appsec);
  }

  return { cicd, appsec, repo: repoAccess };
}
