// Кабинет «мой аккаунт»: «Избранное» – только то, что пользователь добавил сам;
// «Мои репозитории» – живой список SourceCraft по токену (`/me/repos`).
// Функции не зависят от HTTP-слоя сервера: клиент SourceCraft передается
// снаружи, тесты идут без сети. Чужие и недоступные репо не запрашиваются
// вовсе.
import type { Database } from "bun:sqlite";
import { ScClient } from "../collectors/http";
import { upsertRepo } from "../jobs/runner";
import { LAST_ELIGIBLE_SCAN_SQL, LAST_NOT_BAD_SCAN_SQL, flaggedRepos, getRepoCard, jobLeaseExpired, overviewRepoIds } from "./repos";
import { classifyScStatus, isOwnRepo, probeRepoAccess, type AccessResult, type ChannelAccess, type NormalizedAccess, type ProbeIo } from "../auth/access";
import { MODEL_VERSION } from "../score/model";
import { countActiveUserJobs, countRecentUserJobs, enqueueScan, findActiveUserJob, recordRefusedUserJob } from "../jobs/scheduler";
import { DEFAULT_REPO_COOLDOWN_MS, type QueueConfig } from "../config";

export interface MyRepoEntry {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  lastActivityAt: string | null;
  /** logo.url платформы из ответа namespace (дисплей) */
  logoUrl: string | null;
  languageColor: string | null;
  /** HealthCraft Index последнего пригодного скана (у приватного без такого – последнего не-bad); null – не оценивался */
  healthcraftIndex: number | null;
  /** индекс предыдущей оценки того же ряда (пригодные или не-bad) — для «что изменилось»; null – сравнивать не с чем */
  previousIndex: number | null;
  /** время последнего анализа репо ЛЮБЫМ автором (не own-скан зрителя – это `FavoriteCheckResponse.lastOwnScanAt`) */
  lastScanAt: string | null;
  /** статус ПОСЛЕДНЕГО скана репо (любого автора): кабинет отличает «анализ завершился
   *  ошибкой» от «данных не хватило». null – сканов нет или у зрителя нет прав */
  lastScanStatus: "ok" | "partial" | "bad" | "running" | null;
  /** два явных признака вместо догадки по `title === null` (у публичного репо title тоже
   *  бывает пустым): репо есть в каталоге и права зрителя подтверждены. По ним кабинет
   *  различает «нет в каталоге», «нет прав» и «еще не анализировали» */
  inCatalog: boolean;
  mayRead: boolean;
  /**
   * «Работа запланирована»: у зрителя есть живое задание (queued/running) по
   * репо и нет завершенного own-скана. Мету и Score этот признак не раскрывает;
   * источник – `jobs`, а не `scans`.
   */
  planned: boolean;
  /**
   * Сколько рекомендаций покажет карточка репозитория – без сети, тем же
   * сборщиком карточки (`getRepoCard`) с доступом из СОХРАНЕННОЙ проверки прав
   * (`favorites.last_access`). Канальные правила (CI/CD, Security) считаются,
   * только если последняя проверка сказала «доступ есть» по каналу. После смены
   * прав число расходится с карточкой до следующей «Проверки прав» – это
   * осознанная цена. Без прав – null, а не 0; права есть, скана нет – 0, как на карточке.
   */
  recommendationsCount: number | null;
  /**
   * Флаг накрутки последней генерации AI-описания: факторы для показа в
   * кабинете. Это подозрение для проверки человеком, Score не меняет; null –
   * флага нет (не генерировали или модель его не дала).
   */
  fraudFlag: { flag: boolean; factors: { key: string; note: string }[] } | null;
  /**
   * Есть AI-обзор – отметка строки, как у рейтинга. У открытого репо – только
   * публичный обзор (его видит любой посетитель); у закрытого с правами зрителя –
   * обзор любой аудитории.
   */
  aiOverview: boolean;
}

/** Отметки строк кабинета – одним запросом на весь список, а не карточкой на строку. */
interface RowMarks {
  overview: { pub: Set<number>; any: Set<number> };
  flags: ReturnType<typeof flaggedRepos>;
}

function rowMarks(db: Database): RowMarks {
  return { overview: overviewRepoIds(db), flags: flaggedRepos(db) };
}

function repoRowOf(db: Database, org: string, repo: string): { id: number; visibility: string } | null {
  return db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
}

function aiOverviewOf(marks: RowMarks, repo: { id: number; visibility: string } | null, mayRead: boolean): boolean {
  if (repo === null) return false;
  return marks.overview.pub.has(repo.id) || (mayRead && repo.visibility !== "public" && marks.overview.any.has(repo.id));
}

export interface MyReposResult {
  /** всегда null: поле оставлено ради формы ответа */
  username: string | null;
  entries: MyRepoEntry[];
}

/**
 * HealthCraft Index и время последнего анализа одного репо: индекс – из
 * последнего ПРИГОДНОГО скана (у приватного без такого – из последнего
 * не-bad), время и статус – из самого последнего скана.
 * Один хелпер на все записи `listMyRepos`: копия правила быстро разошлась бы.
 */
function ratingScoreOf(db: Database, org: string, repo: string): { healthcraftIndex: number | null; previousIndex: number | null; lastScanAt: string | null; lastScanStatus: MyRepoEntry["lastScanStatus"] } {
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string }
    | null;
  if (!row) return { healthcraftIndex: null, previousIndex: null, lastScanAt: null, lastScanStatus: null };
  const scoreOf = (pick: string) =>
    db
      .query(
        `SELECT sc.healthcraft_index AS total FROM scores sc
         JOIN repos r ON r.id = sc.repo_id
         WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.model_version = ? AND sc.scan_id = ${pick}`,
      )
      .get(org, repo, MODEL_VERSION, MODEL_VERSION) as { total: number | null } | null;
  const scored = scoreOf(LAST_ELIGIBLE_SCAN_SQL) ?? (row.visibility !== "public" ? scoreOf(LAST_NOT_BAD_SCAN_SQL) : null);
  const lastScan = db.query("SELECT status, finished_at, started_at FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
    | { status: string; finished_at: string | null; started_at: string }
    | null;
  // предыдущая оценка — из того же ряда, что текущая: пригодные сканы, а у
  // приватного без них — не-bad; обе с числом индекса текущей модели
  const series = (eligible: boolean) =>
    db
      .query(
        `SELECT sc.healthcraft_index AS total FROM scores sc JOIN scans s ON s.id = sc.scan_id
         WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.healthcraft_index IS NOT NULL AND ${eligible ? "s.rating_eligible = 1" : "s.status NOT IN ('bad', 'running', 'queued')"}
         ORDER BY sc.scan_id DESC LIMIT 2`,
      )
      .all(row.id, MODEL_VERSION) as { total: number }[];
  const fromEligible = series(true);
  const pair = fromEligible.length > 0 || row.visibility === "public" ? fromEligible : series(false);
  return {
    healthcraftIndex: scored?.total ?? null,
    previousIndex: scored && pair.length === 2 ? pair[1]!.total : null,
    lastScanAt: lastScan ? (lastScan.finished_at ?? lastScan.started_at) : null,
    lastScanStatus: lastScan ? (lastScan.status as MyRepoEntry["lastScanStatus"]) : null,
  };
}

/**
 * Права зрителя на запись кабинета: репо публичен и в рейтинге, ИЛИ в
 * сохраненной проверке `favorites.last_access` стоит `clone === true`, ИЛИ у
 * зрителя есть own-скан этого репо (own-скан – доказанные права).
 *
 * Публичность проверяется той же парой признаков, что у `cardVisible` и
 * рейтинга: `visibility = 'public' AND rating_active = 1`. `evictRepo` гасит
 * только `rating_active`, и по одной `visibility` посторонний со слагом в
 * избранном увидел бы данные репо, который карточка отдает 404.
 *
 * Из `FavoriteAccess` берется именно `clone` (у владельца публичного репо без
 * CI бывает `own: false` при `clone: true`), а видимость – из `repos`, а не из
 * того же JSON (там "unknown" против дефолта 'public'). Неизвестно → «нет прав».
 */
export function viewerMayReadRepo(db: Database, userId: number | null, org: string, repo: string, opts: SavedRightsOptions = {}): boolean {
  const row = db.query("SELECT id, visibility, rating_active FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string; rating_active: number }
    | null;
  if (row && row.visibility === "public" && row.rating_active === 1) return true;
  // выбывший из рейтинга публичный репозиторий карточка не покажет никому (404),
  // и строка кабинета его тоже не раскрывает, какие бы права ни были сохранены
  if (row && row.visibility === "public" && row.rating_active !== 1) return false;
  if (userId === null) return false;
  // репозиторий вернул живой список SourceCraft по токену зрителя – чтение доказано
  if (opts.readProven === true) return true;
  const fav = db.query("SELECT last_access FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) as
    | { last_access: string | null }
    | null;
  // сохраненная проверка действует только для того PAT, которым сделана;
  // нечитаемый PAT (сменился APP_SECRET) – проверка не в счет
  if (fav?.last_access && opts.savedRightsValid !== false) {
    try {
      if ((JSON.parse(fav.last_access) as FavoriteAccess).clone === true) return true;
    } catch {
      /* мусор в JSON – как «неизвестно», то есть прав нет */
    }
  }
  if (row && db.query("SELECT 1 FROM scans WHERE repo_id = ? AND user_id = ? LIMIT 1").get(row.id, userId) !== null) return true;
  return false;
}

/**
 * Доступ зрителя к каналам по СОХРАНЕННОЙ проверке прав: true → granted,
 * false → denied, неизвестно или проверки не было → check-failed. Канал открыт
 * только при явном «доступ есть», как у карточки. `repo` всегда granted:
 * функцию зовут лишь для записей с доказанными правами (`viewerMayReadRepo`).
 */
function savedAccessOf(db: Database, userId: number | null, org: string, repo: string, opts: SavedRightsOptions = {}): AccessResult {
  const channel = (v: boolean | null | undefined): ChannelAccess => (v === true ? "granted" : v === false ? "denied" : "check-failed");
  let saved: Partial<FavoriteAccess> | null = null;
  if (userId !== null && opts.savedRightsValid !== false) {
    const fav = db.query("SELECT last_access FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) as
      | { last_access: string | null }
      | null;
    try {
      saved = fav?.last_access ? (JSON.parse(fav.last_access) as Partial<FavoriteAccess>) : null;
    } catch {
      saved = null; // мусор в JSON – «неизвестно», каналы закрыты
    }
  }
  return { cicd: channel(saved?.ci), appsec: channel(saved?.appsec), repo: "granted" };
}

/**
 * Число рекомендаций карточки для записи кабинета (место в рейтинге не
 * считается). null – прав нет или репозитория нет в каталоге.
 */
function recommendationsCountOf(db: Database, userId: number | null, org: string, repo: string, mayRead: boolean, opts: SavedRightsOptions = {}): number | null {
  if (!mayRead) return null;
  const card = getRepoCard(db, org, repo, { access: savedAccessOf(db, userId, org, repo, opts), withRank: false });
  return card ? card.recommendations.length : null;
}

/**
 * Флаг накрутки для записи кабинета – из карточки (`card.ai.fraud`) с доступом
 * из сохраненной проверки прав. null – прав нет, карточки нет или флага нет.
 */
function fraudFlagOf(db: Database, userId: number | null, org: string, repo: string, mayRead: boolean, opts: SavedRightsOptions = {}): { flag: boolean; factors: { key: string; note: string }[] } | null {
  if (!mayRead) return null;
  const card = getRepoCard(db, org, repo, { access: savedAccessOf(db, userId, org, repo, opts), withRank: false });
  return card?.ai?.fraud ?? null;
}

/** См. `MyRepoEntry.planned`. */
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

// разбор ручного ввода живет в чистом модуле, общем с вебом
export { parseFavoriteInput } from "./slug-input";

/**
 * Добавление в избранное с пределом на пользователя. Повтор существующего
 * дает "exists" и лимит не расходует.
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

/** Репозиторий из /me/repos. */
export interface ScRepoLite {
  org: string;
  slug: string;
  name: string | null;
  visibility: string | null;
  isEmpty: boolean;
}

/**
 * Репозитории, ДОСТУПНЫЕ токену зрителя (/me/repos). Это не обязательно
 * «свои»: признака владения в ответе SourceCraft нет. Платформа не соблюдает
 * `page_size` и отдает по 1-2 записи на страницу, поэтому листаем по
 * `next_page_token` до конца с потолками по записям и страницам; сбой на
 * странице после первой – уже собранное с `partial`, а не ошибка.
 */
export async function listSourcecraftRepos(
  client: ScClient,
  opts: { maxPages?: number; maxItems?: number } = {},
): Promise<{ status: "ok" | "source_http"; partial: boolean; repos: ScRepoLite[]; interrupted?: boolean }> {
  const maxPages = opts.maxPages ?? 40;
  const maxItems = opts.maxItems ?? 200;
  let token: string | null = null;
  let pages = 0;
  const repos: ScRepoLite[] = [];
  while (pages < maxPages) {
    const path = `/me/repos?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    // сбой на странице после первой — собранное с `interrupted`: такой список не кэшируется
    if (res.status !== 200) return repos.length > 0 ? { status: "ok", partial: true, repos, interrupted: true } : { status: "source_http", partial: true, repos };
    pages++;
    const body = res.json as {
      repositories?: { organization?: { slug?: unknown }; slug?: unknown; name?: unknown; visibility?: unknown; is_empty?: unknown }[];
      next_page_token?: unknown;
    } | null;
    const list = Array.isArray(body?.repositories) ? body!.repositories! : [];
    for (const raw of list) {
      const org = typeof raw.organization?.slug === "string" ? raw.organization.slug : null;
      const slug = typeof raw.slug === "string" ? raw.slug : null;
      if (!org || !slug) continue;
      repos.push({
        org,
        slug,
        name: typeof raw.name === "string" ? raw.name : null,
        visibility: typeof raw.visibility === "string" ? raw.visibility : null,
        isEmpty: raw.is_empty === true,
      });
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) return { status: "ok", partial: false, repos };
    if (repos.length >= maxItems) return { status: "ok", partial: true, repos: repos.slice(0, maxItems) };
    token = next;
  }
  return { status: "ok", partial: true, repos };
}

/** Потолок запросов организаций за один обход списка. */
export const ORG_INFO_MAX = 20;

/** Организация из `GET /orgs/{slug}`: логотип и название (каждое – если есть). */
export interface OrgInfo {
  logoUrl?: string;
  displayName?: string;
}

/**
 * Логотипы и названия организаций из списка по токену: в `/me/repos` у
 * организации только слаг, остальное отдает `GET /orgs/{slug}`. Читаются первые
 * `ORG_INFO_MAX` в порядке экрана (своя первой, остальные по алфавиту – как
 * `orderOrgs` в UI), по `concurrency` разом и не дольше `deadlineMs`: это только
 * оформление, список не ждет зависшую платформу. Сбой или не успевшая к сроку
 * организация – без сведений (UI рисует инициалы и слаг).
 */
export async function orgInfoOf(
  client: ScClient,
  orgs: string[],
  opts: { owner?: string | null; concurrency?: number; deadlineMs?: number } = {},
): Promise<Record<string, OrgInfo>> {
  const own = opts.owner?.toLowerCase() ?? null;
  const queue = [...new Set(orgs)]
    .sort((a, b) => Number(b.toLowerCase() === own) - Number(a.toLowerCase() === own) || a.localeCompare(b))
    .slice(0, ORG_INFO_MAX);
  const out: Record<string, OrgInfo> = {};
  const readOne = async (org: string) => {
    const res = await client.get(`/orgs/${encodeURIComponent(org)}`).catch(() => null);
    if (res?.status !== 200) return;
    const body = res.json as { logo?: { url?: unknown } | null; display_name?: unknown } | null;
    const info: OrgInfo = {};
    if (typeof body?.logo?.url === "string" && body.logo.url !== "") info.logoUrl = body.logo.url;
    if (typeof body?.display_name === "string" && body.display_name.trim() !== "") info.displayName = body.display_name.trim();
    if (info.logoUrl || info.displayName) out[org] = info;
  };
  let next = 0;
  const worker = async () => {
    while (next < queue.length) await readOne(queue[next++]!);
  };
  const workers = Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, worker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.deadlineMs ?? 3000)));
  await Promise.race([workers, deadline]);
  clearTimeout(timer);
  // к сроку — то, что успели; опоздавшие ответы в отданный объект уже не попадают
  return { ...out };
}

/** Строка «Моих репозиториев»: репо из списка SourceCraft по токену и то, что о нем знает каталог. */
export interface TokenRepoEntry extends MyRepoEntry {
  /** видимость из ответа SourceCraft – она же решает «свой» для закрытых (`isOwnRepo`) */
  visibility: string | null;
  /** в репозитории нет ни одного коммита – анализировать нечего */
  isEmpty: boolean;
  /** уже в «Избранном» зрителя */
  favorite: boolean;
}

/**
 * «Мои репозитории»: каждый репо живого списка `/me/repos` с данными каталога.
 * Право чтения доказано самим списком (`readProven`), поэтому у закрытых видны
 * оценка и мета; публичный, выбывший из рейтинга, по-прежнему не раскрывается.
 * Без рекомендаций (их число собирает карточка целиком) – список бывает в сотни
 * строк; флаг накрутки и AI-обзор – одним запросом на весь список.
 */
export function tokenRepoEntries(db: Database, userId: number, repos: ScRepoLite[]): TokenRepoEntry[] {
  const marks = rowMarks(db);
  const favorites = new Set(
    (db.query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ?").all(userId) as { org_slug: string; repo_slug: string }[]).map((f) =>
      `${f.org_slug}/${f.repo_slug}`.toLowerCase(),
    ),
  );
  return repos.map((r) => {
    const mayRead = viewerMayReadRepo(db, userId, r.org, r.slug, { readProven: true });
    const inCatalog = db.query("SELECT 1 FROM repos WHERE org_slug = ? AND repo_slug = ?").get(r.org, r.slug) !== null;
    const row = mayRead
      ? (db.query("SELECT title, language, logo_url, language_color, last_activity_at FROM repos WHERE org_slug = ? AND repo_slug = ?").get(r.org, r.slug) as {
          title: string | null;
          language: string | null;
          logo_url: string | null;
          language_color: string | null;
          last_activity_at: string | null;
        } | null)
      : null;
    const known = mayRead ? ratingScoreOf(db, r.org, r.slug) : { healthcraftIndex: null, previousIndex: null, lastScanAt: null, lastScanStatus: null };
    const repoRow = inCatalog ? repoRowOf(db, r.org, r.slug) : null;
    const flag = mayRead && repoRow !== null ? marks.flags.get(repoRow.id) : undefined;
    return {
      org: r.org,
      repo: r.slug,
      title: row?.title ?? r.name,
      language: row?.language ?? null,
      lastActivityAt: row?.last_activity_at ?? null,
      logoUrl: row?.logo_url ?? null,
      languageColor: row?.language_color ?? null,
      healthcraftIndex: known.healthcraftIndex,
      previousIndex: known.previousIndex,
      lastScanAt: known.lastScanAt,
      lastScanStatus: known.lastScanStatus,
      inCatalog,
      mayRead,
      planned: plannedWork(db, userId, r.org, r.slug),
      recommendationsCount: null,
      fraudFlag: flag === undefined ? null : { flag: true, factors: flag.factors },
      aiOverview: aiOverviewOf(marks, repoRow, mayRead),
      visibility: r.visibility,
      isEmpty: r.isEmpty,
      favorite: favorites.has(`${r.org}/${r.slug}`.toLowerCase()),
    };
  });
}

/**
 * «Мои репозитории» – ровно строки `favorites` зрителя. Мету и Score получают
 * только записи с правами (`viewerMayReadRepo`).
 */
export async function listMyRepos(db: Database, userId: number | null, opts: SavedRightsOptions = {}): Promise<MyReposResult> {
  const favs = db
    .query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId ?? -1) as { org_slug: string; repo_slug: string }[];
  const marks = rowMarks(db);
  const entries: MyRepoEntry[] = favs.map((f) => myRepoEntryOf(db, userId, f.org_slug, f.repo_slug, opts, marks));
  return { username: null, entries };
}

/**
 * Одна запись «Моих репозиториев»: мутации избранного возвращают обновленную
 * строку, чтобы не перечитывать список. Сборка та же, что у `listMyRepos`.
 */
/**
 * Только HealthCraft Index записи избранного – по тем же правам, что
 * `myRepoEntryOf`, но без сборки строки кабинета (рекомендации и флаг накрутки
 * собирают карточку целиком, а избранное читают все страницы).
 */
export function favoriteScoreOf(db: Database, userId: number, org: string, repo: string, opts: SavedRightsOptions = {}): number | null {
  return viewerMayReadRepo(db, userId, org, repo, opts) ? ratingScoreOf(db, org, repo).healthcraftIndex : null;
}

export function myRepoEntryOf(db: Database, userId: number | null, org: string, repo: string, opts: SavedRightsOptions = {}, marks: RowMarks = rowMarks(db)): MyRepoEntry {
  const f = { org_slug: org, repo_slug: repo };
  const mayRead = viewerMayReadRepo(db, userId, f.org_slug, f.repo_slug, opts);
  const inCatalog = db.query("SELECT 1 FROM repos WHERE org_slug = ? AND repo_slug = ?").get(f.org_slug, f.repo_slug) !== null;
  // без прав мета (включая логотип и цвет языка) не раскрывается
  const row = mayRead
    ? (db
        .query("SELECT title, language, logo_url, language_color, last_activity_at FROM repos WHERE org_slug = ? AND repo_slug = ?")
        .get(f.org_slug, f.repo_slug) as {
        title: string | null;
        language: string | null;
        logo_url: string | null;
        language_color: string | null;
        last_activity_at: string | null;
      } | null)
    : null;
  const known = mayRead ? ratingScoreOf(db, f.org_slug, f.repo_slug) : { healthcraftIndex: null, previousIndex: null, lastScanAt: null, lastScanStatus: null };
  return {
    org: f.org_slug,
    repo: f.repo_slug,
    title: row?.title ?? null,
    language: row?.language ?? null,
    lastActivityAt: row?.last_activity_at ?? null,
    logoUrl: row?.logo_url ?? null,
    languageColor: row?.language_color ?? null,
    healthcraftIndex: known.healthcraftIndex,
    previousIndex: known.previousIndex,
    lastScanAt: known.lastScanAt,
    lastScanStatus: known.lastScanStatus,
    inCatalog,
    mayRead,
    planned: plannedWork(db, userId, f.org_slug, f.repo_slug),
    recommendationsCount: recommendationsCountOf(db, userId, f.org_slug, f.repo_slug, mayRead, opts),
    fraudFlag: fraudFlagOf(db, userId, f.org_slug, f.repo_slug, mayRead, opts),
    aiOverview: aiOverviewOf(marks, inCatalog ? repoRowOf(db, f.org_slug, f.repo_slug) : null, mayRead),
  };
}

/** Сохраненные права действуют только для того PAT, которым проверены. */
export interface SavedRightsOptions {
  /** false – PAT не читается текущим ключом (сменился APP_SECRET): сохраненные проверки не в счет */
  savedRightsValid?: boolean;
  /** true – репо пришел в живом списке `/me/repos` по токену зрителя: право чтения доказано */
  readProven?: boolean;
}

/**
 * Сброс сохраненных прав при удалении, замене или сохранении PAT: права
 * принадлежат тому токену, которым проверены. Обнуляется и `last_checked_at`,
 * чтобы фоновая перепроверка подхватила все записи при следующем чтении
 * списка (в том числе после рестарта, когда очередь в памяти потеряна).
 */
export function resetFavoriteRights(db: Database, userId: number): number {
  return db.query("UPDATE favorites SET last_access = NULL, last_checked_at = NULL WHERE user_id = ?").run(userId).changes;
}

/** Возраст сохраненной проверки, после которого запись перепроверяется в фоне. */
export const RECHECK_AFTER_MS = 24 * 60 * 60_000;

/** Записи избранного без проверки прав или с проверкой старше суток — кандидаты фоновой перепроверки. */
export function staleFavoriteSlugs(db: Database, userId: number, now = new Date(), maxAgeMs = RECHECK_AFTER_MS): { org: string; repo: string }[] {
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  return (
    db
      .query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ? AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY added_at DESC")
      .all(userId, cutoff) as { org_slug: string; repo_slug: string }[]
  ).map((r) => ({ org: r.org_slug, repo: r.repo_slug }));
}

// ---------- запуск анализа пользователем ----------

export interface UserScanResponse {
  status: number;
  body: Record<string, unknown>;
  /** у 429 – через сколько секунд повторить (заголовок Retry-After) */
  retryAfterSec?: number;
}

export interface UserScanOptions {
  /**
   * Запуск по членству в организации (`LaunchRight` member): репозиторий
   * анализируется не чаще `QueueConfig.repoCooldownMs` от последнего анализа
   * кем угодно, и не ставится, пока идет чужой анализ того же репозитория.
   */
  repoCooldown?: boolean;
}

/**
 * POST /api/me/repos/:org/:repo/scan без HTTP-слоя. Сначала дешевые проверки
 * без сети (`userScanCheapGate`), затем repo-GET с PAT пользователя:
 * 200 → строка repos и заявка → 202; 403/404 → 403 no_access; 401 → 401
 * pat_expired; 0/429/5xx → 503 check_failed. После сетевого ожидания дешевые
 * проверки повторяются в одной транзакции со вставкой – там же ограничение
 * частоты на репозиторий (`UserScanOptions.repoCooldown`).
 */
export async function requestUserScan(
  db: Database,
  client: ScClient,
  userId: number,
  org: string,
  repo: string,
  queue: QueueConfig,
  now = new Date(),
  // готовый ответ repo-GET от вызывающего (проверка прав избранного только что
  // его получила), чтобы не делать второй живой запрос
  prefetched?: { status: number; json: unknown },
  opts: UserScanOptions = {},
): Promise<UserScanResponse> {
  const cheap = userScanCheapGate(db, userId, org, repo, queue, now);
  if (cheap) return cheap;
  const res = prefetched ?? (await client.get(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`));
  // отказ предпроверки (403/404, 401) расходует лимит частоты, чтобы POST не
  // стал усилителем запросов; сбой платформы (0/429/5xx) – не вердикт о правах и не расходует
  if (res.status !== 200 && classifyScStatus(res.status) !== "unavailable") recordRefusedUserJob(db, userId, now, `${org}/${repo}`);
  if (res.status === 403 || res.status === 404) {
    return { status: 403, body: { error: { code: "no_access", message: `ваш токен не дает доступа к ${org}/${repo}` } } };
  }
  if (res.status === 401) {
    return { status: 401, body: { error: { code: "pat_expired", message: "SourceCraft отклонил ваш токен – обновите его в Настройках" } } };
  }
  if (res.status !== 200) {
    return { status: 503, body: { error: { code: "check_failed", message: `не удалось проверить доступ к ${org}/${repo}: SourceCraft сейчас не отвечает` } } };
  }
  const body = res.json as { visibility?: unknown; name?: unknown; is_empty?: unknown } | null;
  // ни одного коммита — анализировать нечего: отказ без заявки и без списания лимита
  if (body?.is_empty === true) return repoEmptyRefusal(org, repo);
  const visibility = typeof body?.visibility === "string" ? body.visibility : null;
  // параллельные запросы проходят дешевую проверку до await все сразу, поэтому
  // здесь проверки и вставка неделимы: одна синхронная транзакция
  return db.transaction((): UserScanResponse => {
    const row = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
    const dup = row ? findActiveUserJob(db, userId, row.id) : null;
    if (dup !== null) {
      return { status: 202, body: { queued: true, jobId: dup, slug: `${org}/${repo}`, deduplicated: true } };
    }
    if (opts.repoCooldown && row) {
      const refusal = repoCooldownRefusal(db, row.id, `${org}/${repo}`, queue.repoCooldownMs ?? DEFAULT_REPO_COOLDOWN_MS, now);
      if (refusal) return refusal;
    }
    if (countActiveUserJobs(db, userId) >= queue.userActiveMax) {
      return tooManyActive(queue);
    }
    if (countRecentUserJobs(db, userId, now) >= queue.userScansPerHour) {
      return rateLimited(db, userId, queue, now);
    }
    // заявка только вставляет НОВУЮ строку (видимость из ответа или 'private'
    // до подтверждения); существующую не трогает – мету репо обновляет только пригодный скан
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

/**
 * Дешевые отказы запуска без сети: активная заявка того же пользователя на
 * тот же репо → 202 deduplicated; активных сверх предела → 429
 * too_many_active; часовой лимит исчерпан → 429 rate_limited. null – можно
 * идти в сеть. Отдельная функция, чтобы маршрут запуска ходил в сеть только
 * после этих проверок.
 */
export function userScanCheapGate(db: Database, userId: number, org: string, repo: string, queue: QueueConfig, now = new Date()): UserScanResponse | null {
  const existing = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
  const active = existing ? findActiveUserJob(db, userId, existing.id) : null;
  if (active !== null) {
    return { status: 202, body: { queued: true, jobId: active, slug: `${org}/${repo}`, deduplicated: true } };
  }
  if (countActiveUserJobs(db, userId) >= queue.userActiveMax) return tooManyActive(queue);
  if (countRecentUserJobs(db, userId, now) >= queue.userScansPerHour) return rateLimited(db, userId, queue, now);
  return null;
}

/**
 * Ограничение частоты на репозиторий для запуска по членству в организации:
 * участников у организации бывают десятки, а один анализ – до ~1000 запросов к
 * SourceCraft и клон репозитория. Пока идет пользовательский анализ того же
 * репозитория или его скан – 409 repo_busy (итог появится в карточке). Если
 * последний удачный анализ (ok или partial, кем угодно, включая плановый) был
 * меньше `cooldownMs` назад – 429 repo_cooldown со временем анализа и временем,
 * когда запуск снова доступен. Плановая заявка в очереди запуск не блокирует:
 * очередь планового анализа бывает долгой.
 */
export function repoCooldownRefusal(db: Database, repoId: number, slug: string, cooldownMs: number, now = new Date()): UserScanResponse | null {
  if (cooldownMs <= 0) return null;
  const busy =
    db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = 'scan' AND trigger_kind = 'user' AND status IN ('queued', 'running') LIMIT 1").get(repoId) !== null ||
    db.query("SELECT 1 FROM scans WHERE repo_id = ? AND status = 'running' LIMIT 1").get(repoId) !== null;
  if (busy) {
    return { status: 409, body: { error: { code: "repo_busy", message: `анализ ${slug} уже идет – итог появится в карточке` } } };
  }
  const last = db
    .query("SELECT MAX(COALESCE(finished_at, started_at)) AS t FROM scans WHERE repo_id = ? AND status IN ('ok', 'partial')")
    .get(repoId) as { t: string | null };
  const lastAt = last.t === null ? Number.NaN : Date.parse(last.t);
  if (!Number.isFinite(lastAt)) return null;
  const untilMs = lastAt + cooldownMs;
  if (untilMs <= now.getTime()) return null;
  return {
    status: 429,
    body: {
      error: {
        code: "repo_cooldown",
        message: `${slug} недавно анализировали – следующий запуск будет доступен позже`,
        lastScanAt: new Date(lastAt).toISOString(),
        until: new Date(untilMs).toISOString(),
      },
    },
    retryAfterSec: Math.max(1, Math.ceil((untilMs - now.getTime()) / 1000)),
  };
}

/** Отказ запуска для репозитория без единого коммита: оценивать нечего, лимит не списывается. */
export function repoEmptyRefusal(org: string, repo: string): UserScanResponse {
  return { status: 409, body: { error: { code: "repo_empty", message: `в ${org}/${repo} нет ни одного коммита – анализировать нечего` } } };
}

function tooManyActive(queue: QueueConfig): UserScanResponse {
  return {
    status: 429,
    body: { error: { code: "too_many_active", message: `не больше ${queue.userActiveMax} анализов в очереди одновременно – дождитесь завершения` } },
    // место освободится, когда закончится анализ; точного времени нет, минута – разумный шаг опроса
    retryAfterSec: 60,
  };
}

function rateLimited(db: Database, userId: number, queue: QueueConfig, now: Date): UserScanResponse {
  const since = new Date(now.getTime() - 3600_000).toISOString();
  const oldest = db
    // время повтора – по тем же заявкам, что считает лимит (только сканы, как countRecentUserJobs)
    .query("SELECT MIN(created_at) AS t FROM jobs WHERE user_id = ? AND trigger_kind = 'user' AND kind = 'scan' AND created_at > ?")
    .get(userId, since) as { t: string | null };
  const retryAfterSec = oldest.t ? Math.max(1, Math.ceil((Date.parse(oldest.t) + 3600_000 - now.getTime()) / 1000)) : 60;
  return {
    status: 429,
    body: { error: { code: "rate_limited", message: `не больше ${queue.userScansPerHour} запусков анализа в час – попробуйте позже` } },
    retryAfterSec,
  };
}

// ========== панель заданий и избранное ==========

export interface MyJob {
  jobId: number;
  slug: string;
  status: string;
  /**
   * Род заявки: `scan` (анализ) или `summary` (описание AI) – панель их
   * различает. Необязательное только ради старых литералов MyJob в тестах:
   * myJobs задает его всегда, а отсутствие панель читает как анализ.
   */
  kind?: string;
  phase: "queued" | "running" | "done" | "failed" | "refused";
  /** позиция в пользовательской очереди (только у queued) */
  queueAhead: number | null;
  claimedAt: string | null;
  error: string | null;
  /**
   * Логотип репозитория (`repos.logo_url`). Входит в закрытую мету, поэтому
   * раскрывается под тем же признаком прав `viewerMayReadRepo`, что и в
   * `listMyRepos`: «задание свое» – не довод показывать его без прав. У
   * отказанной заявки без строки `repos` – null.
   */
  logoUrl: string | null;
  /**
   * «Затянулось»: задание `running` с истекшим лизом (его процесс умер или
   * цикл событий стоит дольше лиза). Тот же признак краснит /api/health; UI
   * сам его от `leaseMs` не считает.
   */
  stalled: boolean;
  /**
   * Скан этого задания (см. `scanOfJob`). null – скана еще нет (в очереди,
   * упало до скана, отказано).
   */
  scanId: number | null;
  /**
   * Исход скана задания: `ok`/`partial` – собран; `bad` – сбор не удался;
   * `interrupted` – прерван перезапуском сервера или закрыт как сирота
   * (для пользователя это не ошибка); null – скана нет или он идет.
   */
  outcome: "ok" | "partial" | "bad" | "interrupted" | null;
  /**
   * Изменилась ли публичная оценка: HealthCraft Index карточки после скана не
   * равен индексу до него (непригодный скан, например после таймаута клона,
   * оценку не меняет). null – скан не завершен.
   */
  scoreChanged: boolean | null;
}

/**
 * Первый скан задания: тот же репо и автор, начат не раньше взятия задания в
 * работу и раньше взятия СЛЕДУЮЩЕГО задания того же автора на том же репо –
 * иначе задание, упавшее до скана, получило бы скан следующего. Колонки
 * `finished_at` у заданий нет, поэтому граница – `claimed_at` следующего.
 */
function scanOfJob(
  db: Database,
  jobId: number,
  repoId: number,
  userId: number,
  claimedAt: string | null,
): { id: number; status: string; status_detail: string | null } | null {
  if (claimedAt === null || repoId <= 0) return null;
  const next = db
    .query("SELECT MIN(claimed_at) AS c FROM jobs WHERE repo_id = ? AND user_id = ? AND id > ? AND claimed_at IS NOT NULL")
    .get(repoId, userId, jobId) as { c: string | null } | null;
  const until = next?.c ?? null;
  return db
    .query(
      `SELECT id, status, status_detail FROM scans WHERE repo_id = ? AND user_id = ? AND started_at >= ?
       AND (? IS NULL OR started_at < ?) ORDER BY id LIMIT 1`,
    )
    .get(repoId, userId, claimedAt, until, until) as { id: number; status: string; status_detail: string | null } | null;
}

/**
 * HealthCraft Index карточки по состоянию «после скана `upTo`»: правило
 * карточки (последний пригодный скан; у приватного без него – последний
 * не-bad), ограниченное сканами с id ≤ `upTo`.
 */
function indexAsOf(db: Database, repoId: number, upTo: number): number | null {
  const eligible = db
    .query(
      `SELECT sc.healthcraft_index AS v FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ? AND s.rating_eligible = 1 AND s.id <= ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(repoId, MODEL_VERSION, upTo) as { v: number | null } | null;
  if (eligible) return eligible.v;
  const vis = db.query("SELECT visibility FROM repos WHERE id = ?").get(repoId) as { visibility: string } | null;
  if (!vis || vis.visibility === "public") return null;
  const notBad = db
    .query(
      `SELECT sc.healthcraft_index AS v FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ? AND s.status NOT IN ('bad', 'running', 'queued') AND s.id <= ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(repoId, MODEL_VERSION, upTo) as { v: number | null } | null;
  return notBad?.v ?? null;
}

/** Исход задания по его скану: скан, исход, изменилась ли публичная оценка. */
export function jobScanOutcome(
  db: Database,
  jobId: number,
  repoId: number,
  userId: number,
  claimedAt: string | null,
): { scanId: number | null; outcome: MyJob["outcome"]; scoreChanged: boolean | null } {
  const scan = scanOfJob(db, jobId, repoId, userId, claimedAt);
  if (!scan) return { scanId: null, outcome: null, scoreChanged: null };
  if (scan.status === "running" || scan.status === "queued") return { scanId: scan.id, outcome: null, scoreChanged: null };
  const interrupted = scan.status === "bad" && (scan.status_detail === "shutdown" || scan.status_detail === "orphaned");
  const outcome: MyJob["outcome"] = interrupted ? "interrupted" : scan.status === "ok" || scan.status === "partial" ? scan.status : "bad";
  const scoreChanged = outcome === "ok" || outcome === "partial" ? indexAsOf(db, repoId, scan.id) !== indexAsOf(db, repoId, scan.id - 1) : false;
  return { scanId: scan.id, outcome, scoreChanged };
}

/** Активные (queued/running) и последние завершенные заявки пользователя.
 *  Отказанные тоже видны: у них нет строки repos, слаг берется из error-payload,
 *  а если нет и его – «–». */
export function myJobs(db: import("bun:sqlite").Database, userId: number, doneLimit = 8): { active: MyJob[]; recent: MyJob[] } {
  const slugOf = (row: Record<string, unknown>): string => {
    if (typeof row.org_slug === "string") return `${row.org_slug}/${row.repo_slug}`;
    if (typeof row.error === "string" && row.error.startsWith("{")) {
      try {
        const slug = (JSON.parse(row.error) as { slug?: unknown }).slug;
        if (typeof slug === "string" && slug !== "") return slug;
      } catch {
        /* не JSON – прочерк */
      }
    }
    return "–";
  };
  const toJob = (row: Record<string, unknown>): MyJob => {
    const status = String(row.status);
    const phase = (["queued", "running", "done", "failed", "refused"] as const).includes(status as "queued")
      ? (status as MyJob["phase"])
      : "queued";
    return {
      jobId: Number(row.id),
      slug: slugOf(row),
      status,
      // старые строки без kind – сканы
      kind: typeof row.kind === "string" && row.kind !== "" ? row.kind : "scan",
      phase,
      queueAhead:
        phase === "queued"
          ? (db
              // у каждого рода свой цикл обработки – впереди только заявки того же рода
              .query("SELECT COUNT(*) AS n FROM jobs WHERE id < ? AND status = 'queued' AND trigger_kind = 'user' AND kind = ?")
              .get(Number(row.id), typeof row.kind === "string" && row.kind !== "" ? row.kind : "scan") as { n: number }).n
          : null,
      claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
      // у refused в error – машинный JSON со слагом; человеку слаг показывается в `slug`
      error: phase === "refused" ? null : typeof row.error === "string" ? row.error : null,
      logoUrl:
        typeof row.logo_url === "string" && row.logo_url !== "" && viewerMayReadRepo(db, userId, String(row.org_slug), String(row.repo_slug))
          ? row.logo_url
          : null,
      stalled: phase === "running" && jobLeaseExpired(typeof row.lease_until === "string" ? row.lease_until : null),
      ...(phase === "refused"
        ? { scanId: null, outcome: null, scoreChanged: null }
        : jobScanOutcome(db, Number(row.id), Number(row.repo_id), userId, typeof row.claimed_at === "string" ? row.claimed_at : null)),
    };
  };
    // LEFT JOIN: у refused нет строки repos (repo_id = 0)
  const base =
    "SELECT j.id, j.repo_id, j.status, j.kind, j.claimed_at, j.lease_until, j.error, r.org_slug, r.repo_slug, r.logo_url FROM jobs j LEFT JOIN repos r ON r.id = j.repo_id WHERE j.user_id = ?";
  const active = (db.query(base + " AND j.status IN ('queued','running') ORDER BY j.id").all(userId) as Record<string, unknown>[]).map(toJob);
  const recent = (db.query(base + " AND j.status IN ('done','failed','refused') ORDER BY j.id DESC LIMIT ?").all(userId, doneLimit) as Record<string, unknown>[]).map(toJob);
  return { active, recent };
}

export interface FavoriteAccess {
  clone: boolean;
  visibility: "public" | "internal" | "private" | "unknown";
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
  /** HealthCraft Index по правам зрителя (заполняет маршрут GET /api/me/favorites); null – оценки нет или прав нет */
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
      access = row.last_access ? savedAccessWithCurrentRule(JSON.parse(row.last_access) as FavoriteAccess) : null;
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

export interface AccessProbeDeps extends ProbeIo {
  /** Config.queue.favoriteOwnCooldownMs */
  cooldownMs: number;
  now?: Date;
}

/**
 * Исход автопостановки анализа по избранному. `code` у `refused` – код ошибки
 * `requestUserScan`, у `skipped` – почему не ставили, у `queued`/`deduplicated` – `null`.
 */
export type FavoriteEnqueueStatus = "queued" | "deduplicated" | "refused" | "skipped";
export type FavoriteEnqueueCode =
  | "too_many_active"
  | "rate_limited"
  | "no_access"
  | "pat_expired"
  | "check_failed"
  | "not_own"
  /** не свой, но из организаций зрителя: анализ сам не ставится, запуск — кнопкой */
  | "member"
  /** в репозитории нет ни одного коммита */
  | "repo_empty"
  | "cooldown"
  /** фоновая перепроверка анализ не ставит */
  | "background"
  | null;

export interface FavoriteEnqueue {
  status: FavoriteEnqueueStatus;
  code: FavoriteEnqueueCode;
}

/**
 * Итог проверки прав. `checked` – вердикт записан; `failed` – SourceCraft не
 * ответил (0/429/5xx), сохраненные права не тронуты; `token_rejected` –
 * SourceCraft отклонил токен (401): права перезаписаны отказом, человеку
 * нужно заменить токен.
 */
export type FavoriteCheckResult = "checked" | "failed" | "token_rejected";

/**
 * Ответ проверки прав избранного (приходит в ответе добавления в избранное).
 * Поле `lastOwnScanAt` названо не `lastScanAt` намеренно: у
 * `MyRepoEntry.lastScanAt` это последний скан репо ЛЮБОГО автора, а здесь –
 * последний own-скан именно этого зрителя, основание кулдауна.
 */
export interface FavoriteCheckResponse {
  /** при `failed` – прежние сохраненные права (или «неизвестно»), не результат этой проверки */
  access: FavoriteAccess;
  enqueue: FavoriteEnqueue;
  /** последний завершенный не-bad own-скан зрителя; основание кулдауна */
  lastOwnScanAt: string | null;
  result: FavoriteCheckResult;
}

/** `requestUserScan` → форма исхода для ответа проверки избранного. */
export function favoriteEnqueueOf(out: UserScanResponse): FavoriteEnqueue {
  if (out.status === 202) {
    return { status: out.body["deduplicated"] === true ? "deduplicated" : "queued", code: null };
  }
  const code = (out.body["error"] as { code?: unknown } | undefined)?.code;
  return { status: "refused", code: (typeof code === "string" ? code : "check_failed") as FavoriteEnqueueCode };
}

/** Нормализованный доступ живой проверки → сохраняемая форма прав (tri-state каналов). */
export function favoriteAccessOf(a: NormalizedAccess): FavoriteAccess {
  const tri = (c: ChannelAccess): boolean | null => (c === "granted" ? true : c === "denied" ? false : null);
  const clone = a.repo === "granted";
  return {
    clone,
    visibility: clone ? a.visibility : "unknown",
    ci: clone ? tri(a.cicd) : null,
    appsec: clone ? tri(a.appsec) : null,
    own: isOwnRepo(a),
  };
}

/**
 * «Свой» в сохраненных правах пересчитывается при чтении по ТЕКУЩЕМУ правилу
 * `isOwnRepo` из сохраненных каналов: иначе запись, проверенная до смены
 * правила, навсегда осталась бы «чужой». Каналы не пересчитываются – это факты
 * проверки, а правило – код.
 */
export function savedAccessWithCurrentRule(a: FavoriteAccess): FavoriteAccess {
  const ch = (v: boolean | null | undefined): ChannelAccess => (v === true ? "granted" : v === false ? "denied" : "check-failed");
  const own = isOwnRepo({ repo: a.clone ? "granted" : "denied", cicd: ch(a.ci), appsec: ch(a.appsec), visibility: a.visibility ?? "unknown" });
  return { ...a, own };
}

function savedFavoriteAccess(db: Database, userId: number, org: string, repo: string): FavoriteAccess | null {
  const row = db.query("SELECT last_access FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) as
    | { last_access: string | null }
    | null;
  if (!row?.last_access) return null;
  try {
    return savedAccessWithCurrentRule(JSON.parse(row.last_access) as FavoriteAccess);
  } catch {
    return null;
  }
}

const UNKNOWN_ACCESS: FavoriteAccess = { clone: false, visibility: "unknown", ci: null, appsec: null, own: false };

/**
 * Живая проверка прав (repo-GET → cicd/runs → AppSec scans/latest через общую
 * `probeRepoAccess`, те же правила, что у карточки) и, если репо свой и
 * кулдаун прошел, заявка на анализ.
 *
 * Вызывается при явном добавлении в избранное (с `enqueueUserScan`: первый
 * анализ своего ставится только здесь) и фоновым насосом перепроверки (без
 * него: права пишутся, анализ не ставится). Сбой SourceCraft (0/429/5xx) – не
 * вердикт: сохраненные права и время проверки не трогаются, заявка не ставится.
 *
 * За колбэком постановки стоит `requestUserScan` целиком; ему передается уже
 * полученный ответ repo-GET, чтобы не делать лишний живой запрос. Отказ по
 * лимиту не роняет проверку прав – ее результат зритель видит все равно.
 */
export async function checkFavoriteAccess(
  db: import("bun:sqlite").Database,
  userId: number,
  org: string,
  repo: string,
  deps: AccessProbeDeps,
  enqueueUserScan: ((repoRes: { status: number; json: unknown }) => Promise<FavoriteEnqueue>) | null,
): Promise<FavoriteCheckResponse> {
  const probe = await probeRepoAccess(deps, org, repo);
  const verdict = classifyScStatus(probe.repoRes.status);
  const now = deps.now ?? new Date();
  // кулдаун – по own-скану ЭТОГО зрителя (user_id = userId, а не IS NOT NULL:
  // иначе скан другого пользователя блокировал бы автопостановку). `bad`-скан
  // (shutdown, orphaned, сбой канала, score_failed) кулдаун не включает – анализа по сути не было
  const last = db
    .query(
      `SELECT MAX(s.finished_at) AS f FROM scans s JOIN repos r ON r.id = s.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND s.user_id = ? AND s.finished_at IS NOT NULL AND s.status != 'bad'`,
    )
    .get(org, repo, userId) as { f: string | null };
  const lastOwnScanAt = last?.f ?? null;
  // сбой платформы не затирает доказанные права. То же, когда репо видно, а CI
  // или AppSec не ответили (0/429/5xx) и без них «свой» не установить: прежние
  // права и время проверки не трогаются (запись остается кандидатом фоновой
  // перепроверки), и вывода «не свой» не делается
  if (verdict === "unavailable" || (verdict === "ok" && probe.channelsFailed && !isOwnRepo(probe.access))) {
    return {
      access: savedFavoriteAccess(db, userId, org, repo) ?? { ...UNKNOWN_ACCESS },
      enqueue: { status: "skipped", code: "check_failed" },
      lastOwnScanAt,
      result: "failed",
    };
  }
  const access = favoriteAccessOf(probe.access);
  const cooldownPassed = lastOwnScanAt === null || now.getTime() - Date.parse(lastOwnScanAt) >= deps.cooldownMs;
  const enqueue: FavoriteEnqueue =
    verdict === "token-rejected"
      ? { status: "skipped", code: "pat_expired" }
      : !access.own
        ? { status: "skipped", code: "not_own" }
        : enqueueUserScan === null
          ? { status: "skipped", code: "background" }
          : !cooldownPassed
            ? { status: "skipped", code: "cooldown" }
            : await enqueueUserScan(probe.repoRes);
  db.query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").run(
    JSON.stringify(access),
    now.toISOString(),
    userId,
    org,
    repo,
  );
  return { access, enqueue, lastOwnScanAt, result: verdict === "token-rejected" ? "token_rejected" : "checked" };
}
