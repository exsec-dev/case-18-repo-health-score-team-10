// me.ts — read-поверхность «мой аккаунт» (В4/Б1): список доступных репо
// по юзерскому PAT. Спискового юзерского эндпоинта в доках нет — план
// Б1: зонд (/user → /orgs/{username}/repos, подтверждён живьём 17.09:
// /user отдаёт username; orgs-список 200) + фолбэк — ручной ввод слага
// в UI. Функции чистые от HTTP-слоя сервера: клиент инъектится, тесты
// без сети. Чужие/недоступные репо не запрашиваются вовсе (ТЗ 5).
import type { Database } from "bun:sqlite";
import { ScClient } from "../collectors/http";
import { upsertRepo } from "../jobs/runner";
import { LAST_ELIGIBLE_SCAN_SQL, LAST_NOT_BAD_SCAN_SQL } from "./repos";
import { MODEL_VERSION } from "../score/model";
import { countActiveUserJobs, countRecentUserJobs, enqueueScan, findActiveUserJob, recordRefusedUserJob } from "../jobs/scheduler";
import type { QueueConfig } from "../config";

export interface MyRepoEntry {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  lastActivityAt: string | null;
  /** Score в рейтинге (total_rating) последнего пригодного скана (приватный без него — последнего не-bad, круг 2); null = не оценивался */
  score: number | null;
  lastScanAt: string | null;
  /** ПОРТ 5 (hq-parallel): откуда репо в списке — ручной слаг после скана
   *  и избранное больше не пропадают (диагноз UX-аудита №2) */
  sources: MyRepoSource[];
}

export type MyRepoSource = "namespace" | "own-scan" | "favorite";

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
export async function listMyRepos(db: Database, client: ScClient | null, userId: number | null, opts: { maxPages?: number } = {}): Promise<MyReposResult> {
  const entries: MyRepoEntry[] = [];
  let username: string | null = null;
  if (client) {
    const who = await fetchTokenUsername(client);
    if (!who.ok) {
      return { ok: false, username: null, entries: [], error: `токен отклонён (HTTP ${who.status})` };
    }
    username = who.username;
    const maxPages = opts.maxPages ?? 5;
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
      // Score — последний пригодный скан; приватный без него — последний не-bad
      // (круг 2, С2, как карточка); время — последнего анализа L (LOW-2)
      const scoreOf = (pick: string) =>
        db
          .query(
            `SELECT sc.total_rating AS total FROM scores sc
             JOIN repos r ON r.id = sc.repo_id
             WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.model_version = ? AND sc.scan_id = ${pick}`,
          )
          .get(org, repo, MODEL_VERSION, MODEL_VERSION) as { total: number | null } | null;
      const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
        | { id: number; visibility: string }
        | null;
      const scored = row ? (scoreOf(LAST_ELIGIBLE_SCAN_SQL) ?? (row.visibility !== "public" ? scoreOf(LAST_NOT_BAD_SCAN_SQL) : null)) : null;
      const lastScan = row
        ? (db.query("SELECT finished_at, started_at FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
            | { finished_at: string | null; started_at: string }
            | null)
        : null;
      const known = scored || lastScan ? { total: scored?.total ?? null, finished_at: lastScan ? (lastScan.finished_at ?? lastScan.started_at) : null } : null;
      entries.push({
        org,
        repo,
        title: typeof raw.name === "string" ? raw.name : null,
        language,
        lastActivityAt: typeof raw.last_updated === "string" ? raw.last_updated : null,
        score: known ? known.total : null,
        lastScanAt: known ? known.finished_at : null,
        sources: ["namespace"], // ПОРТ 5: union-источники (диагноз UX-2)
      });
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) break;
    token = next;
  }
  } // конец if (client)
  // ПОРТ 5: union — заявки юзера (руками добавленный слаг не пропадает)
  // и избранное; score для них — по тем же правилам пригодности

  const merge = (org: string, repo: string, source: "own-scan" | "favorite") => {
    const key = `${org}/${repo}`;
    const existing = entries.find((e) => e.org === org && e.repo === repo);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const row = db.query("SELECT id, title, language, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
      | { id: number; title: string | null; language: string | null; visibility: string }
      | null;
    const lastScan = row
      ? (db.query("SELECT finished_at, started_at FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
          | { finished_at: string | null; started_at: string }
          | null)
      : null;
    entries.push({
      org,
      repo,
      title: row?.title ?? null,
      language: row?.language ?? null,
      lastActivityAt: null,
      score: null,
      lastScanAt: lastScan ? (lastScan.finished_at ?? lastScan.started_at) : null,
      sources: [source],
    });
  };
  const jobs = db
    .query("SELECT DISTINCT r.org_slug, r.repo_slug FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.user_id = ?")
    .all(userId ?? -1) as { org_slug: string; repo_slug: string }[];
  for (const j of jobs) merge(j.org_slug, j.repo_slug, "own-scan");
  const favs = db
    .query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId ?? -1) as { org_slug: string; repo_slug: string }[];
  for (const f of favs) merge(f.org_slug, f.repo_slug, "favorite");
  return { ok: true, username, entries };
}

// ---------- запуск анализа юзером (В4.1, К3) ----------

export interface UserScanResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * POST /api/me/repos/:org/:repo/scan без HTTP-слоя. В4.1-fix (Ф1.5): дешёвые
 * проверки до сети остаются, после repo-GET те же проверки повторяются в
 * одной синхронной транзакции со вставкой (+ too_many_active, Ф1.7);
 * deduplicated: true — только если заявка уже была. К4 (дёшево, без сети):
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
  if (countActiveUserJobs(db, userId) >= queue.userActiveMax) {
    return tooManyActive(queue);
  }
  if (countRecentUserJobs(db, userId, now) >= queue.userScansPerHour) {
    return rateLimited(queue);
  }
  const res = await client.get(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
  // Ф1.6 + круг 2 (LOW-6): любой неуспех предпроверки (403/404, 401,
  // 0/429/5xx) учитывается лимитом частоты — POST не усилитель запросов
  if (res.status !== 200) recordRefusedUserJob(db, userId, now);
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
  // Ф1.5: после сетевого await — одна синхронная транзакция: параллельные
  // запросы проходили дешёвую проверку до await все сразу; здесь проверки
  // и вставка неделимы (дедуп → too_many_active → rate_limited → строка → job)
  return db.transaction((): UserScanResponse => {
    const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
    const dup = row ? findActiveUserJob(db, userId, row.id) : null;
    if (dup !== null) {
      return { status: 202, body: { queued: true, jobId: dup, slug: `${org}/${repo}`, deduplicated: true } };
    }
    if (countActiveUserJobs(db, userId) >= queue.userActiveMax) {
      return tooManyActive(queue);
    }
    if (countRecentUserJobs(db, userId, now) >= queue.userScansPerHour) {
      return rateLimited(queue);
    }
    // К-Ф1.1: заявка вставляет только НОВУЮ строку (видимость из тела repo-GET
    // или 'private' до подтверждения); существующую строку не обновляет —
    // мету репо двигает только пригодный скан
    const repoId =
      row?.id ??
      upsertRepo(db, org, repo, {
        title: typeof body?.name === "string" ? body.name : null,
        visibility: visibility ?? "private",
      });
    const jobId = enqueueScan(db, repoId, { userId, triggerKind: "user", now });
    return { status: 202, body: { queued: true, jobId, slug: `${org}/${repo}`, deduplicated: false } };
  })();
}

function tooManyActive(queue: QueueConfig): UserScanResponse {
  return {
    status: 429,
    body: { error: { code: "too_many_active", message: `не больше ${queue.userActiveMax} анализов в очереди одновременно — дождитесь завершения` } },
  };
}

function rateLimited(queue: QueueConfig): UserScanResponse {
  return {
    status: 429,
    body: { error: { code: "rate_limited", message: `не больше ${queue.userScansPerHour} запусков анализа в час — попробуйте позже` } },
  };
}

// ========== ПОРТ 5 (hq-parallel): панель заданий + избранное ==========

export interface MyJob {
  jobId: number;
  slug: string;
  status: string;
  phase: "queued" | "running" | "done" | "failed" | "refused";
  /** позиция в user-очереди (только queued) — честное ожидание, не спиннер */
  queueAhead: number | null;
  claimedAt: string | null;
  error: string | null;
}

/** Активные (queued/running) + последние завершённые заявки юзера.
 *  Диагноз UX-аудита: «очереди не видно» — статус жил в useState компонента. */
export function myJobs(db: import("bun:sqlite").Database, userId: number, doneLimit = 8): { active: MyJob[]; recent: MyJob[] } {
  const toJob = (row: Record<string, unknown>): MyJob => {
    const status = String(row.status);
    const phase = (["queued", "running", "done", "failed", "refused"] as const).includes(status as "queued")
      ? (status as MyJob["phase"])
      : "queued";
    return {
      jobId: Number(row.id),
      slug: `${row.org_slug}/${row.repo_slug}`,
      status,
      phase,
      queueAhead:
        phase === "queued"
          ? (db
              .query("SELECT COUNT(*) AS n FROM jobs WHERE id < ? AND status = 'queued' AND trigger_kind = 'user'")
              .get(Number(row.id)) as { n: number }).n
          : null,
      claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
      error: typeof row.error === "string" ? row.error : null,
    };
  };
  const base = "SELECT j.id, j.status, j.claimed_at, j.error, r.org_slug, r.repo_slug FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.user_id = ?";
  const active = (db.query(base + " AND j.status IN ('queued','running') ORDER BY j.id").all(userId) as Record<string, unknown>[]).map(toJob);
  const recent = (db.query(base + " AND j.status IN ('done','failed','refused') ORDER BY j.id DESC LIMIT ?").all(userId, doneLimit) as Record<string, unknown>[]).map(toJob);
  return { active, recent };
}

export interface FavoriteAccess {
  clone: boolean;
  visibility: "public" | "private" | "unknown";
  ci: boolean | null;
  appsec: boolean | null;
  own: boolean;
}

export interface FavoriteEntry {
  org: string;
  repo: string;
  addedAt: string;
  access: FavoriteAccess | null;
  lastCheckedAt: string | null;
  score: number | null;
}

export function addFavorite(db: import("bun:sqlite").Database, userId: number, org: string, repo: string, now = new Date()): void {
  db.query(
    "INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, org_slug, repo_slug) DO NOTHING",
  ).run(userId, org, repo, now.toISOString());
}

export function removeFavorite(db: import("bun:sqlite").Database, userId: number, org: string, repo: string): void {
  db.query("DELETE FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").run(userId, org, repo);
}

export function isFavorite(db: import("bun:sqlite").Database, userId: number, org: string, repo: string): boolean {
  return db.query("SELECT 1 FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) !== null;
}

export function listFavorites(db: import("bun:sqlite").Database, userId: number): FavoriteEntry[] {
  const rows = db
    .query("SELECT org_slug, repo_slug, added_at, last_access, last_checked_at FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId) as { org_slug: string; repo_slug: string; added_at: string; last_access: string | null; last_checked_at: string | null }[];
  return rows.map((row) => {
    let access: FavoriteAccess | null = null;
    try {
      access = row.last_access ? (JSON.parse(row.last_access) as FavoriteAccess) : null;
    } catch {
      access = null;
    }
    return {
      org: row.org_slug,
      repo: row.repo_slug,
      addedAt: row.added_at,
      access,
      lastCheckedAt: row.last_checked_at,
      score: null,
    };
  });
}

/** Кулдаун автозапуска заявки избранного (решение 17.09: 6ч от последнего скана репо). */
export const FAVORITE_OWN_COOLDOWN_MS = 6 * 60 * 60_000;

export interface AccessProbeDeps {
  restGet: (path: string) => Promise<{ status: number; json: unknown }>;
  appsecLatest: (gitRepo: string) => Promise<{ status: number }>;
  now?: Date;
}

/** Живая проверка прав по факту (cache-then-revalidate): repo-GET →
 *  cicd/runs (listCIFlux) → scans/latest (useAppSecScan). При собственных
 *  правах и простывшем кулдауне — заявка на анализ (механика; LLM никогда). */
export async function checkFavoriteAccess(
  db: import("bun:sqlite").Database,
  userId: number,
  org: string,
  repo: string,
  deps: AccessProbeDeps,
  enqueueUserScan: (db2: import("bun:sqlite").Database, userId2: number, org2: string, repo2: string) => number | null,
): Promise<{ access: FavoriteAccess; enqueued: boolean; lastScanAt: string | null }> {
  const repoRes = await deps.restGet(`/repos/${org}/${repo}`);
  const access: FavoriteAccess = { clone: false, visibility: "unknown", ci: null, appsec: null, own: false };
  if (repoRes.status === 200) {
    access.clone = true;
    const body = repoRes.json as { visibility?: unknown; id?: unknown } | null;
    access.visibility = body?.visibility === "private" ? "private" : body?.visibility === "public" ? "public" : "unknown";
    const ci = await deps.restGet(`/repos/${org}/${repo}/cicd/runs?page_size=1`);
    access.ci = ci.status === 200 ? true : ci.status === 403 ? false : null;
    const uuid = typeof body?.id === "string" ? body.id : null;
    if (uuid) {
      const sec = await deps.appsecLatest(uuid);
      access.appsec = sec.status === 200 ? true : sec.status === 403 ? false : null;
    }
  }
  access.own = access.ci === true || access.appsec === true || access.visibility === "private";

  const now = deps.now ?? new Date();
  const last = db
    .query(
      "SELECT MAX(s.finished_at) AS f FROM scans s JOIN repos r ON r.id = s.repo_id WHERE r.org_slug = ? AND r.repo_slug = ? AND s.finished_at IS NOT NULL",
    )
    .get(org, repo) as { f: string | null };
  const lastScanAt = last?.f ?? null;
  const cooldownPassed = lastScanAt === null || now.getTime() - Date.parse(lastScanAt) >= FAVORITE_OWN_COOLDOWN_MS;
  let enqueued = false;
  if (access.own && cooldownPassed) {
    enqueued = enqueueUserScan(db, userId, org, repo) !== null;
  }
  db.query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").run(
    JSON.stringify(access),
    now.toISOString(),
    userId,
    org,
    repo,
  );
  return { access, enqueued, lastScanAt };
}
