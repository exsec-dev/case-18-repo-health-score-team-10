// me.ts — read-поверхность «мой аккаунт» (В4/Б1). Ф2.20 (решение владельца
// 18.09): кабинет — ТОЛЬКО избранное (union namespace/own-сканов закрыт как
// «три избранных с разными механизмами»); namespace остаётся источником
// ОДНОХОДОВОГО посева избранного при сохранении PAT. Ручной ввод — слаг или
// URL через общий parseFavoriteInput (им пользуется и path-роут звезды).
// Функции чистые от HTTP-слоя сервера: клиент инъектится, тесты без сети.
// Чужие/недоступные репо не запрашиваются вовсе (ТЗ 5).
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
  /** logo.url платформы из ответа namespace (дисплей) */
  logoUrl: string | null;
  languageColor: string | null;
  /** HealthCraft Index последнего пригодного скана (приватный без него — последнего не-bad, круг 2); null = не оценивался (В4.3: читает healthcraft_index) */
  healthcraftIndex: number | null;
  /** время последнего анализа репо ЛЮБЫМ автором (не own-скан зрителя — см. `FavoriteCheckResponse.lastOwnScanAt`, М1) */
  lastScanAt: string | null;
  /**
   * Ф2.17 (решение владельца 18.09): у записи есть живая job ЗРИТЕЛЯ
   * (queued/running) и нет завершённого own-скана — «работа запланирована».
   * Мета и Score этим признаком НЕ раскрываются (fail-closed не ослабляется);
   * источник — `jobs`, не `scans`.
   */
  planned: boolean;
  /** ПОРТ 5: поле `sources` удалено (Ф2.20, решение 18.09 — кабинет favorites-only) */
}

export interface MyReposResult {
  /** namespace-заголовок ушёл вместе с union (Ф2.20) — всегда null, поле оставлено для формы ответа */
  username: string | null;
  entries: MyRepoEntry[];
}

/**
 * HealthCraft Index и время последнего анализа одного репо — правило круга 2
 * (решение С2 (кр.1)): последний ПРИГОДНЫЙ скан P; приватный репо без P —
 * последний не-bad; время — последний скан L.
 *
 * В4.2-port-fix (П4, MAJOR №1): один хелпер на все записи `listMyRepos`.
 * Копию правила заводить нельзя — расходились бы снова.
 * В4.3 (Б3-кабинет): сырой SQL переведён на дропаемую total_rating →
 * healthcraft_index.
 */
function ratingScoreOf(db: Database, org: string, repo: string): { healthcraftIndex: number | null; lastScanAt: string | null } {
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string }
    | null;
  if (!row) return { healthcraftIndex: null, lastScanAt: null };
  const scoreOf = (pick: string) =>
    db
      .query(
        `SELECT sc.healthcraft_index AS total FROM scores sc
         JOIN repos r ON r.id = sc.repo_id
         WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.model_version = ? AND sc.scan_id = ${pick}`,
      )
      .get(org, repo, MODEL_VERSION, MODEL_VERSION) as { total: number | null } | null;
  const scored = scoreOf(LAST_ELIGIBLE_SCAN_SQL) ?? (row.visibility !== "public" ? scoreOf(LAST_NOT_BAD_SCAN_SQL) : null);
  const lastScan = db.query("SELECT finished_at, started_at FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
    | { finished_at: string | null; started_at: string }
    | null;
  return { healthcraftIndex: scored?.total ?? null, lastScanAt: lastScan ? (lastScan.finished_at ?? lastScan.started_at) : null };
}

/**
 * Права зрителя на репо-запись (В4.2-port-fix, П6, находка С4; признак —
 * решение владельца (3) 18.09): `clone === true` из сохранённого JSON
 * `favorites.last_access` ИЛИ репо публичен и активен ИЛИ у зрителя есть
 * own-скан этого репо (`scans.user_id = зритель`).
 *
 * Круг 2 (П10, Н-1): публичный дизъюнкт читает ТУ ЖЕ ПАРУ признаков, что
 * `cardVisible` (`repos.ts`) и рейтинг: `visibility = 'public' AND
 * rating_active = 1`. `evictRepo` гасит `rating_active` и `visibility` не
 * трогает — по одной `visibility` посторонний с чужим слагом в избранном
 * видел название, язык, время анализа и Score репо, который карточке и
 * MD-отчёту отдаёт 404 всем.
 *
 * Берётся именно `clone` из пяти полей `FavoriteAccess` (владелец публичного
 * репо без CI даёт `own: false` при `clone: true`) и `repos.visibility`, а не
 * `access.visibility` из того же JSON (они расходятся: "unknown" против
 * дефолта 'public'). Неизвестно → «нет прав» (fail-closed, как Ф1.10).
 * Третье слагаемое снимает коллизию с П4: own-скан = доказанные права.
 */
function viewerMayReadRepo(db: Database, userId: number | null, org: string, repo: string): boolean {
  const row = db.query("SELECT id, visibility, rating_active FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string; rating_active: number }
    | null;
  if (row && row.visibility === "public" && row.rating_active === 1) return true;
  if (userId === null) return false;
  const fav = db.query("SELECT last_access FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) as
    | { last_access: string | null }
    | null;
  if (fav?.last_access) {
    try {
      if ((JSON.parse(fav.last_access) as FavoriteAccess).clone === true) return true;
    } catch {
      /* мусор в JSON — как «неизвестно» (fail-closed) */
    }
  }
  if (row && db.query("SELECT 1 FROM scans WHERE repo_id = ? AND user_id = ? LIMIT 1").get(row.id, userId) !== null) return true;
  return false;
}

/**
 * Ф2.17: «работа запланирована» — у зрителя есть job в статусе
 * queued/running по этому репо (user_id = зритель, источник `jobs`) И нет
 * завершённого own-скана. Мета/Score не трогаются.
 */
function plannedWork(db: Database, userId: number | null, org: string, repo: string): boolean {
  if (userId === null) return false;
  const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
  if (!row) return false;
  const live = db
    .query("SELECT 1 FROM jobs WHERE repo_id = ? AND user_id = ? AND status IN ('queued','running') LIMIT 1")
    .get(row.id, userId);
  if (!live) return false;
  const finishedOwn = db
    .query("SELECT 1 FROM scans WHERE repo_id = ? AND user_id = ? AND finished_at IS NOT NULL LIMIT 1")
    .get(row.id, userId);
  return finishedOwn === null;
}

/**
 * Форма ответа сохранения PAT (Ф2.20): после проверки живьём PAT сохраняется
 * ОБЯЗАТЕЛЬНО, затем fail-soft посев избранного из namespace — сбой страницы,
 * лимит или недочитанный каталог не откатывают сохранение.
 */
export interface PatSeed {
  status: "ok" | "partial";
  added: number;
  error?: { code: "source_http" | "favorite_limit" | "page_limit" };
}

/**
 * Ф2.20: строка ручного ввода → пара слагов. `org/repo` принимается как есть;
 * http(s)-URL — ПЕРВЫЕ ДВА сегмента пути (хвосты вида /tree/main, query и
 * fragment отбрасываются); домен НЕ валидируется — избранное может указывать
 * куда угодно, права резолвятся при проверке. Пустые/точечные сегменты и
 * мусорный charset → null (маршрут отдаёт 400 bad_query). Парсер общий:
 * им пользуются и PUT /api/me/favorites, и path-роут звезды.
 */
export function parseFavoriteInput(raw: string): { org: string; repo: string } | null {
  const value = raw.trim();
  if (value === "") return null;
  const segmentOk = (seg: string | undefined): seg is string =>
    typeof seg === "string" && seg !== "" && /^[a-z0-9_.-]+$/i.test(seg) && !/^[.]+$/.test(seg);
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const [org, repo] = url.pathname.split("/").filter((p) => p !== "");
      if (!segmentOk(org) || !segmentOk(repo)) return null;
      return { org, repo };
    } catch {
      return null;
    }
  }
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  if (!segmentOk(parts[0]) || !segmentOk(parts[1])) return null;
  return { org: parts[0]!, repo: parts[1]! };
}

/**
 * Ф2.21: добавление избранного с пределом на юзера. Повтор существующего
 * идемпотентен ("exists") и лимит не расходует; считает только НОВЫЕ строки.
 */
export type FavoriteAddResult = "added" | "exists" | "limit";

export function addFavoriteCapped(
  db: Database,
  userId: number,
  org: string,
  repo: string,
  favoritesMax: number,
  now = new Date(),
): FavoriteAddResult {
  if (isFavorite(db, userId, org, repo)) return "exists";
  const count = (db.query("SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?").get(userId) as { c: number }).c;
  if (count >= favoritesMax) return "limit";
  // вставка одной строки атомарна (INSERT .. ON CONFLICT DO NOTHING)
  addFavorite(db, userId, org, repo, now);
  return "added";
}

/**
 * Ф2.20: однопроходный посев избранного из namespace владельца PAT —
 * `GET /orgs/{username}/repos?page_size=100`, до 5 страниц; бюджет клиента
 * (6 запросов) держит вызывающий. Существующие строки не считаются ни в
 * added, ни в лимите; достигнутый кап останавливает посев с
 * favorite_limit; оставшийся next_page_token после пятой страницы —
 * partial/page_limit.
 */
export async function seedFavoritesFromNamespace(
  db: Database,
  client: ScClient,
  username: string,
  userId: number,
  favoritesMax: number,
  opts: { maxPages?: number } = {},
): Promise<PatSeed> {
  const maxPages = opts.maxPages ?? 5;
  let added = 0;
  let token: string | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const path = `/orgs/${encodeURIComponent(username)}/repos?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) return { status: "partial", added, error: { code: "source_http" } };
    pages++;
    const body = res.json as { repositories?: { organization?: { slug?: unknown }; slug?: unknown }[]; next_page_token?: unknown } | null;
    const list = Array.isArray(body?.repositories) ? body!.repositories! : [];
    for (const raw of list) {
      const org = typeof raw.organization?.slug === "string" ? raw.organization.slug : username;
      const repo = typeof raw.slug === "string" ? raw.slug : null;
      if (!repo) continue;
      const outcome = addFavoriteCapped(db, userId, org, repo, favoritesMax);
      if (outcome === "added") added++;
      if (outcome === "limit") return { status: "partial", added, error: { code: "favorite_limit" } };
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) return { status: "ok", added };
    token = next;
  }
  return { status: "partial", added, error: { code: "page_limit" } };
}

/**
 * «Мои репозитории» — ТОЛЬКО избранное (Ф2.20, решение 18.09): строка
 * `favorites` есть — запись есть; запись убрали — пропала из кабинета.
 * Namespace- и own-scan-объединение удалены. Мета и Score по-прежнему
 * только записям с правами (признак П6/П10 — viewerMayReadRepo не тронут).
 */
export async function listMyRepos(db: Database, userId: number | null): Promise<MyReposResult> {
  const favs = db
    .query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId ?? -1) as { org_slug: string; repo_slug: string }[];
  const entries: MyRepoEntry[] = favs.map((f) => {
    const mayRead = viewerMayReadRepo(db, userId, f.org_slug, f.repo_slug);
    const row = mayRead
      ? (db.query("SELECT title, language FROM repos WHERE org_slug = ? AND repo_slug = ?").get(f.org_slug, f.repo_slug) as
          | { title: string | null; language: string | null }
          | null)
      : null;
    const known = mayRead ? ratingScoreOf(db, f.org_slug, f.repo_slug) : { healthcraftIndex: null, lastScanAt: null };
    return {
      org: f.org_slug,
      repo: f.repo_slug,
      title: row?.title ?? null,
      language: row?.language ?? null,
      lastActivityAt: null,
      logoUrl: null,
      languageColor: null,
      healthcraftIndex: known.healthcraftIndex,
      lastScanAt: known.lastScanAt,
      planned: plannedWork(db, userId, f.org_slug, f.repo_slug),
    };
  });
  return { username: null, entries };
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
  // В4.2-port-fix (П2): готовое тело repo-GET от вызывающего (проверка прав
  // избранного только что его получила) — второй живой запрос не делается;
  // вторая половина Н1 ровно про усилитель запросов
  prefetched?: { status: number; json: unknown },
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
  const res = prefetched ?? (await client.get(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`));
  // Ф1.6 + круг 2 (LOW-6): любой неуспех предпроверки (403/404, 401,
  // 0/429/5xx) учитывается лимитом частоты — POST не усилитель запросов
  if (res.status !== 200) recordRefusedUserJob(db, userId, now);
  if (res.status === 403 || res.status === 404) {
    return { status: 403, body: { error: { code: "no_access", message: `ваш PAT не дает доступа к ${org}/${repo}` } } };
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

export interface AccessProbeDeps {
  restGet: (path: string) => Promise<{ status: number; json: unknown }>;
  appsecLatest: (gitRepo: string) => Promise<{ status: number }>;
  /** Config.queue.favoriteOwnCooldownMs (П2): модульной константы больше нет */
  cooldownMs: number;
  now?: Date;
}

/**
 * Исход автопостановки анализа по избранному (В4.2-port-fix, П2, решение
 * владельца (1) 18.09). `enqueued: boolean` убран: единственное поле исхода —
 * `enqueue: {status, code}`. `code` у `refused` — код ошибки `requestUserScan`,
 * у `skipped` — почему не ставили, у `queued`/`deduplicated` — `null`.
 */
export type FavoriteEnqueueStatus = "queued" | "deduplicated" | "refused" | "skipped";
export type FavoriteEnqueueCode =
  | "too_many_active"
  | "rate_limited"
  | "no_access"
  | "pat_expired"
  | "check_failed"
  | "not_own"
  | "cooldown"
  | null;

export interface FavoriteEnqueue {
  status: FavoriteEnqueueStatus;
  code: FavoriteEnqueueCode;
}

/**
 * Ответ POST /api/me/favorites/:org/:repo/check — читается MePage.tsx (П2-UI).
 *
 * М1 (круг 2): поле зовётся `lastOwnScanAt`, а не `lastScanAt`. Одно имя
 * несло два смысла: у `MyRepoEntry.lastScanAt` — последний скан репо ЛЮБОГО
 * автора, здесь — последний завершённый own-скан ИМЕННО этого зрителя
 * (основание кулдауна, К-П П2). Имена разведены.
 */
export interface FavoriteCheckResponse {
  access: FavoriteAccess;
  enqueue: FavoriteEnqueue;
  /** последний завершённый own-скан зрителя (`scans.user_id = зритель`); основание кулдауна */
  lastOwnScanAt: string | null;
}

/** `requestUserScan` → форма исхода для ответа проверки избранного (П2). */
export function favoriteEnqueueOf(out: UserScanResponse): FavoriteEnqueue {
  if (out.status === 202) {
    return { status: out.body["deduplicated"] === true ? "deduplicated" : "queued", code: null };
  }
  const code = (out.body["error"] as { code?: unknown } | undefined)?.code;
  return { status: "refused", code: (typeof code === "string" ? code : "check_failed") as FavoriteEnqueueCode };
}

/**
 * Живая проверка прав по факту (cache-then-revalidate): repo-GET →
 * cicd/runs (listCIFlux) → scans/latest (useAppSecScan). При собственных
 * правах и простывшем кулдауне — заявка на анализ (механика; LLM никогда).
 *
 * В4.2-port-fix (П2, Н1 HIGH): колбэк постановки АСИНХРОННЫЙ и отдаёт исход
 * `FavoriteEnqueue`, а не `number | null`, — за ним стоит `requestUserScan`
 * целиком (дешёвая предпроверка, дедуп, `too_many_active`, `rate_limited`,
 * транзакция Ф1.5, строки `refused`); ScClient связывает вызывающий, он же
 * прокидывает УЖЕ полученное тело repo-GET (4-го живого запроса нет).
 * Отказ по капу не роняет проверку прав — её результат зритель видит всё
 * равно. Кулдаун считается по последнему own-скану ИМЕННО этого зрителя.
 */
export async function checkFavoriteAccess(
  db: import("bun:sqlite").Database,
  userId: number,
  org: string,
  repo: string,
  deps: AccessProbeDeps,
  enqueueUserScan: (repoRes: { status: number; json: unknown }) => Promise<FavoriteEnqueue>,
): Promise<FavoriteCheckResponse> {
  const repoRes = await deps.restGet(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`);
  const access: FavoriteAccess = { clone: false, visibility: "unknown", ci: null, appsec: null, own: false };
  if (repoRes.status === 200) {
    access.clone = true;
    const body = repoRes.json as { visibility?: unknown; id?: unknown } | null;
    access.visibility = body?.visibility === "private" ? "private" : body?.visibility === "public" ? "public" : "unknown";
    const ci = await deps.restGet(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/cicd/runs?page_size=1`);
    access.ci = ci.status === 200 ? true : ci.status === 403 ? false : null;
    const uuid = typeof body?.id === "string" ? body.id : null;
    if (uuid) {
      const sec = await deps.appsecLatest(uuid);
      access.appsec = sec.status === 200 ? true : sec.status === 403 ? false : null;
    }
  }
  access.own = access.ci === true || access.appsec === true || access.visibility === "private";

  const now = deps.now ?? new Date();
  // К-П П2: own-скан ЭТОГО зрителя (scans.user_id = userId, не IS NOT NULL —
  // иначе скан другого юзера блокирует автопостановку на 6 часов)
  const last = db
    .query(
      `SELECT MAX(s.finished_at) AS f FROM scans s JOIN repos r ON r.id = s.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND s.user_id = ? AND s.finished_at IS NOT NULL`,
    )
    .get(org, repo, userId) as { f: string | null };
  const lastOwnScanAt = last?.f ?? null;
  const cooldownPassed = lastOwnScanAt === null || now.getTime() - Date.parse(lastOwnScanAt) >= deps.cooldownMs;
  const enqueue: FavoriteEnqueue = !access.own
    ? { status: "skipped", code: "not_own" }
    : !cooldownPassed
      ? { status: "skipped", code: "cooldown" }
      : await enqueueUserScan(repoRes);
  db.query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").run(
    JSON.stringify(access),
    now.toISOString(),
    userId,
    org,
    repo,
  );
  return { access, enqueue, lastOwnScanAt };
}
