// me.ts — read-поверхность «мой аккаунт» (В4/Б1): список доступных репо
// по юзерскому PAT. Спискового юзерского эндпоинта в доках нет — план
// Б1: зонд (/user → /orgs/{username}/repos, подтверждён живьём 17.09:
// /user отдаёт username; orgs-список 200) + фолбэк — ручной ввод слага
// в UI. Функции чистые от HTTP-слоя сервера: клиент инъектится, тесты
// без сети. Чужие/недоступные репо не запрашиваются вовсе (ТЗ 5).
import type { Database } from "bun:sqlite";
import { ScClient } from "../collectors/http";
import { upsertRepo } from "../jobs/runner";
import { LAST_ELIGIBLE_SCAN_SQL } from "./repos";
import { MODEL_VERSION } from "../score/model";
import { countRecentUserJobs, enqueueScan, findActiveUserJob } from "../jobs/scheduler";
import type { QueueConfig } from "../config";

export interface MyRepoEntry {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  lastActivityAt: string | null;
  /** Score в рейтинге (total_rating) последнего пригодного скана репо в нашей БД (К-Ф1.1); null = не оценивался */
  score: number | null;
  lastScanAt: string | null;
}

export interface MyReposResult {
  ok: boolean;
  /** namespace владельца токена (для заголовка «репозитории X») */
  username: string | null;
  entries: MyRepoEntry[];
  error?: string;
}

interface RawRepoEntry {
  organization?: { slug?: unknown };
  slug?: unknown;
  name?: unknown;
  language?: { name?: unknown } | string | null;
  last_updated?: unknown;
}

/** GET /user по PAT: чей токен (username) — единственная живая проверка «мой». */
export async function fetchTokenUsername(client: ScClient): Promise<{ ok: true; username: string } | { ok: false; status: number }> {
  const res = await client.get("/user");
  if (res.status !== 200) return { ok: false, status: res.status };
  const body = res.json as { username?: unknown } | null;
  if (typeof body?.username !== "string" || body.username === "") return { ok: false, status: 0 };
  return { ok: true, username: body.username };
}

/**
 * Репо namespace'а владельца токена (≤5 страниц — personal-namespace
 * репо измеряются единицами; исчерпание видно по next_page_token и
// честно отражается записью truncated).
 */
export async function listMyRepos(db: Database, client: ScClient, opts: { maxPages?: number } = {}): Promise<MyReposResult> {
  const who = await fetchTokenUsername(client);
  if (!who.ok) {
    return { ok: false, username: null, entries: [], error: `токен отклонён (HTTP ${who.status})` };
  }
  const maxPages = opts.maxPages ?? 5;
  const entries: MyRepoEntry[] = [];
  let token: string | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const path = `/orgs/${encodeURIComponent(who.username)}/repos?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) break;
    pages++;
    const body = res.json as { repositories?: RawRepoEntry[]; next_page_token?: unknown } | null;
    const list = Array.isArray(body?.repositories) ? body!.repositories! : [];
    for (const raw of list) {
      const org = typeof raw.organization?.slug === "string" ? raw.organization.slug : who.username;
      const repo = typeof raw.slug === "string" ? raw.slug : null;
      if (!repo) continue;
      const language =
        typeof raw.language === "string" ? raw.language : typeof raw.language?.name === "string" ? raw.language.name : null;
      const known = db
        .query(
          `SELECT sc.total_rating AS total, s.finished_at FROM scores sc
           JOIN repos r ON r.id = sc.repo_id
           LEFT JOIN scans s ON s.id = sc.scan_id
           WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.model_version = ?
             AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`,
        )
        .get(org, repo, MODEL_VERSION, MODEL_VERSION) as { total: number | null; finished_at: string | null } | null;
      entries.push({
        org,
        repo,
        title: typeof raw.name === "string" ? raw.name : null,
        language,
        lastActivityAt: typeof raw.last_updated === "string" ? raw.last_updated : null,
        score: known ? known.total : null,
        lastScanAt: known ? known.finished_at : null,
      });
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) break;
    token = next;
  }
  return { ok: true, username: who.username, entries };
}

// ---------- запуск анализа юзером (В4.1, К3) ----------

export interface UserScanResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * POST /api/me/repos/:org/:repo/scan без HTTP-слоя. К4 (дёшево, без сети):
 * активная заявка того же (юзер, репо) → 202 deduplicated; лимит частоты
 * исчерпан → 429 rate_limited. К3: до постановки — repo-GET с PAT юзера.
 * 200 → upsert repos (visibility из ответа) → заявка → 202; 403/404 →
 * 403 no_access (строки repos нет); 401 → 401 pat_expired; 0/429/5xx →
 * 503 check_failed.
 */
export async function requestUserScan(
  db: Database,
  client: ScClient,
  userId: number,
  org: string,
  repo: string,
  queue: QueueConfig,
  now = new Date(),
): Promise<UserScanResponse> {
  const existing = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
  const active = existing ? findActiveUserJob(db, userId, existing.id) : null;
  if (active !== null) {
    return { status: 202, body: { queued: true, jobId: active, slug: `${org}/${repo}`, deduplicated: true } };
  }
  if (countRecentUserJobs(db, userId, now) >= queue.userScansPerHour) {
    return {
      status: 429,
      body: { error: { code: "rate_limited", message: `не больше ${queue.userScansPerHour} запусков анализа в час — попробуйте позже` } },
    };
  }
  const res = await client.get(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
  if (res.status === 403 || res.status === 404) {
    return { status: 403, body: { error: { code: "no_access", message: `ваш PAT не даёт доступа к ${org}/${repo}` } } };
  }
  if (res.status === 401) {
    return { status: 401, body: { error: { code: "pat_expired", message: "SourceCraft отклонил PAT — обновите токен в кабинете" } } };
  }
  if (res.status !== 200) {
    return { status: 503, body: { error: { code: "check_failed", message: `не удалось проверить доступ к ${org}/${repo} (HTTP ${res.status})` } } };
  }
  const body = res.json as { visibility?: unknown; name?: unknown } | null;
  const visibility = typeof body?.visibility === "string" ? body.visibility : null;
  // К-Ф1.1: заявка вставляет только НОВУЮ строку (видимость из тела repo-GET
  // или 'private' до подтверждения); существующую строку не обновляет —
  // мету репо двигает только пригодный скан
  const repoId =
    existing?.id ??
    upsertRepo(db, org, repo, {
      title: typeof body?.name === "string" ? body.name : null,
      visibility: visibility ?? "private",
    });
  const jobId = enqueueScan(db, repoId, { userId, triggerKind: "user", now });
  return { status: 202, body: { queued: true, jobId, slug: `${org}/${repo}`, deduplicated: false } };
}
