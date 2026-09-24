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
import { LAST_ELIGIBLE_SCAN_SQL, LAST_NOT_BAD_SCAN_SQL, getRepoCard, jobLeaseExpired } from "./repos";
import { classifyScStatus, isOwnRepo, probeRepoAccess, type AccessResult, type ChannelAccess, type NormalizedAccess, type ProbeIo } from "../auth/access";
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
  /** З4 (круг 2 В4.4): статус ПОСЛЕДНЕГО скана репо (любого автора) — строка кабинета
   *  различает «анализ завершился ошибкой» и «данных не хватило»; running — легальный
   *  транзитный статус. null = сканов нет или меты у зрителя нет (нет прав) */
  lastScanStatus: "ok" | "partial" | "bad" | "running" | null;
  /** UX-8 (круг 2 В4.4): ДВА явных признака вместо прокси `title === null`
   *  (публичное репо без title тоже без title): репо есть в каталоге (таблица
   *  repos по слагу) и подтверждены ли права зрителя. Ярлык кабинета честно
   *  различает «нет в каталоге» / «нет прав» / «еще не анализировали» */
  inCatalog: boolean;
  mayRead: boolean;
  /**
   * Ф2.17 (решение владельца 18.09): у записи есть живая job ЗРИТЕЛЯ
   * (queued/running) и нет завершённого own-скана — «работа запланирована».
   * Мета и Score этим признаком НЕ раскрываются (fail-closed не ослабляется);
   * источник — `jobs`, не `scans`.
   */
  planned: boolean;
  /**
   * В4.7 (П3.4, контракт У26; решение В2 21.09 — без сети): сколько
   * рекомендаций покажет карточка этого репозитория. Считается тем же
   * сборщиком карточки (`getRepoCard`) с доступом из СОХРАНЁННОЙ проверки
   * прав (`favorites.last_access`): публичные правила — по пригодному скану,
   * канальные (CI/CD, Security) — только если последняя проверка сказала
   * «доступ есть» по этому каналу. При актуальной проверке прав число равно
   * карточке; после смены прав расходится до следующей «Проверки прав»
   * (цена принята владельцем). Без прав (`mayRead === false`) — null, а не 0;
   * права есть, скана нет — 0, как на карточке.
   */
  recommendationsCount: number | null;
  /**
   * В5 (К5.10): флаг фрода последней генерации AI-описания этого репо —
   * факторы на показ в кабинете. Подозрение для проверки человеком, Score
   * не меняет; null — флага нет (не генерировали или модель не дала).
   */
  fraudFlag: { flag: boolean; factors: { key: string; note: string }[] } | null;
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
function ratingScoreOf(db: Database, org: string, repo: string): { healthcraftIndex: number | null; lastScanAt: string | null; lastScanStatus: MyRepoEntry["lastScanStatus"] } {
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string }
    | null;
  if (!row) return { healthcraftIndex: null, lastScanAt: null, lastScanStatus: null };
  const scoreOf = (pick: string) =>
    db
      .query(
        `SELECT sc.healthcraft_index AS total FROM scores sc
         JOIN repos r ON r.id = sc.repo_id
         WHERE r.org_slug = ? AND r.repo_slug = ? AND sc.model_version = ? AND sc.scan_id = ${pick}`,
      )
      .get(org, repo, MODEL_VERSION, MODEL_VERSION) as { total: number | null } | null;
  const scored = scoreOf(LAST_ELIGIBLE_SCAN_SQL) ?? (row.visibility !== "public" ? scoreOf(LAST_NOT_BAD_SCAN_SQL) : null);
  // З4 (круг 2): статус ДОБАВЛЯЕТСЯ в проекцию существующего SELECT'а последнего скана (DDL нет)
  const lastScan = db.query("SELECT status, finished_at, started_at FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as
    | { status: string; finished_at: string | null; started_at: string }
    | null;
  return {
    healthcraftIndex: scored?.total ?? null,
    lastScanAt: lastScan ? (lastScan.finished_at ?? lastScan.started_at) : null,
    lastScanStatus: lastScan ? (lastScan.status as MyRepoEntry["lastScanStatus"]) : null,
  };
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
export function viewerMayReadRepo(db: Database, userId: number | null, org: string, repo: string, opts: SavedRightsOptions = {}): boolean {
  const row = db.query("SELECT id, visibility, rating_active FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; visibility: string; rating_active: number }
    | null;
  if (row && row.visibility === "public" && row.rating_active === 1) return true;
  // В4.8.5 (К8.5.9, С6-2): выбывший из рейтинга публичный репозиторий карточка
  // не покажет никому (404) — строка его тоже не раскрывает, какие бы права ни
  // были сохранены
  if (row && row.visibility === "public" && row.rating_active !== 1) return false;
  if (userId === null) return false;
  const fav = db.query("SELECT last_access FROM favorites WHERE user_id = ? AND org_slug = ? AND repo_slug = ?").get(userId, org, repo) as
    | { last_access: string | null }
    | null;
  // К8.5.9: сохранённая проверка действует только для поколения PAT, которым
  // сделана; нечитаемый PAT (ротация APP_SECRET) — проверка не в счёт
  if (fav?.last_access && opts.savedRightsValid !== false) {
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
 * Доступ зрителя к каналам по СОХРАНЁННОЙ проверке прав (В4.7, решение В2):
 * true → granted, false → denied, неизвестно или проверки не было →
 * check-failed. Канал открыт только при явном «доступ есть» — fail-closed,
 * как у карточки. `repo` — granted: вызывается лишь для записей с
 * доказанными правами (`viewerMayReadRepo`).
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
      saved = null; // мусор в JSON — «неизвестно», каналы закрыты
    }
  }
  return { cicd: channel(saved?.ci), appsec: channel(saved?.appsec), repo: "granted" };
}

/**
 * В4.7 (П3.4, У26): число рекомендаций карточки для записи кабинета — без
 * сети, тем же сборщиком карточки (место в рейтинге не считается). null —
 * прав нет или карточки нет (репозитория нет в каталоге).
 */
function recommendationsCountOf(db: Database, userId: number | null, org: string, repo: string, mayRead: boolean, opts: SavedRightsOptions = {}): number | null {
  if (!mayRead) return null;
  const card = getRepoCard(db, org, repo, { access: savedAccessOf(db, userId, org, repo, opts), withRank: false });
  return card ? card.recommendations.length : null;
}

/**
 * В5 (К5.10): флаг фрода для записи кабинета — тем же сборщиком карточки
 * (card.ai.fraud, доступ из сохранённой проверки прав). null — прав нет,
 * карточки нет или флага нет.
 */
function fraudFlagOf(db: Database, userId: number | null, org: string, repo: string, mayRead: boolean, opts: SavedRightsOptions = {}): { flag: boolean; factors: { key: string; note: string }[] } | null {
  if (!mayRead) return null;
  const card = getRepoCard(db, org, repo, { access: savedAccessOf(db, userId, org, repo, opts), withRank: false });
  return card?.ai?.fraud ?? null;
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
  /** UX-9 (круг 2 В4.4): `no_username` — /user не вернул имя, namespace НЕ
   *  опрашивался (прежний дефолт source_http ложно обвинял его) */
  error?: { code: "source_http" | "favorite_limit" | "page_limit" | "no_username" };
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
/** Репозиторий пользователя из /me/repos (23.09, парковка: пикер «своих»). */
export interface ScRepoLite {
  org: string;
  slug: string;
  name: string | null;
  visibility: string | null;
  isEmpty: boolean;
}

/**
 * Репозитории, ДОСТУПНЫЕ токену зрителя (/me/repos): это не «свои» — в ответе
 * SourceCraft нет признака владения (аудит 25.09, reports/2026-09-25-m53-add-repo-audit.md).
 * В5.3 (25.09, О1 аудита): платформа не соблюдает `page_size` и отдает по 1-2
 * записи на страницу — прежний потолок в 3 страницы давал 5 строк при подписи
 * «первые 300». Теперь — по `next_page_token` до конца с потолками по записям и
 * страницам; сбой на странице N > 1 — собранное с `partial`, а не 502.
 */
export async function listSourcecraftRepos(
  client: ScClient,
  opts: { maxPages?: number; maxItems?: number } = {},
): Promise<{ status: "ok" | "source_http"; partial: boolean; repos: ScRepoLite[] }> {
  const maxPages = opts.maxPages ?? 40;
  const maxItems = opts.maxItems ?? 200;
  let token: string | null = null;
  let pages = 0;
  const repos: ScRepoLite[] = [];
  while (pages < maxPages) {
    const path = `/me/repos?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) return repos.length > 0 ? { status: "ok", partial: true, repos } : { status: "source_http", partial: true, repos };
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
export async function listMyRepos(db: Database, userId: number | null, opts: SavedRightsOptions = {}): Promise<MyReposResult> {
  const favs = db
    .query("SELECT org_slug, repo_slug FROM favorites WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId ?? -1) as { org_slug: string; repo_slug: string }[];
  const entries: MyRepoEntry[] = favs.map((f) => myRepoEntryOf(db, userId, f.org_slug, f.repo_slug, opts));
  return { username: null, entries };
}

/**
 * Одна запись «Моих репозиториев» (В4.8.5, К8.5.7: мутации избранного
 * возвращают обновлённую запись строки, список не перечитывается целиком).
 * Та же сборка, что у `listMyRepos` — число и поля строки равны списку.
 */
export function myRepoEntryOf(db: Database, userId: number | null, org: string, repo: string, opts: SavedRightsOptions = {}): MyRepoEntry {
  const f = { org_slug: org, repo_slug: repo };
  const mayRead = viewerMayReadRepo(db, userId, f.org_slug, f.repo_slug, opts);
  // UX-8: признак «в каталоге» — один дешёвый lookup (JOIN'а в listMyRepos
  // нет; строку repos поднимает viewerMayReadRepo и выбрасывает)
  const inCatalog = db.query("SELECT 1 FROM repos WHERE org_slug = ? AND repo_slug = ?").get(f.org_slug, f.repo_slug) !== null;
  // В4.8 (круг 2, замечание 4 Екатерины): логотип, цвет языка и дата
  // активности читаются из той же строки `repos`, что название и язык, —
  // до этого поля контракта стояли литералом null, и кабинет терял аватары
  // и цвета, которые рейтинг показывал для того же репозитория. Гейт прав
  // прежний: без прав мета не раскрывается (П6).
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
  const known = mayRead ? ratingScoreOf(db, f.org_slug, f.repo_slug) : { healthcraftIndex: null, lastScanAt: null, lastScanStatus: null };
  return {
    org: f.org_slug,
    repo: f.repo_slug,
    title: row?.title ?? null,
    language: row?.language ?? null,
    lastActivityAt: row?.last_activity_at ?? null,
    logoUrl: row?.logo_url ?? null,
    languageColor: row?.language_color ?? null,
    healthcraftIndex: known.healthcraftIndex,
    lastScanAt: known.lastScanAt,
    lastScanStatus: known.lastScanStatus,
    inCatalog,
    mayRead,
    planned: plannedWork(db, userId, f.org_slug, f.repo_slug),
    recommendationsCount: recommendationsCountOf(db, userId, f.org_slug, f.repo_slug, mayRead, opts),
    fraudFlag: fraudFlagOf(db, userId, f.org_slug, f.repo_slug, mayRead, opts),
  };
}

/** К8.5.9: сохранённые права действуют только для текущего поколения PAT. */
export interface SavedRightsOptions {
  /** false — PAT не читается текущим ключом (ротация APP_SECRET): сохранённые проверки не в счёт */
  savedRightsValid?: boolean;
}

/**
 * В4.8.5 (К8.5.9, К8.5.14; С2-3): гашение сохранённых прав при удалении,
 * замене или сохранении PAT — права принадлежат поколению токена, которым
 * проверены. Обнуляется и `last_checked_at`: правило фоновой перепроверки
 * «не проверено или старше суток» подхватит все записи при следующем чтении
 * списка (и после рестарта, когда очередь насоса в памяти потеряна).
 */
export function resetFavoriteRights(db: Database, userId: number): number {
  return db.query("UPDATE favorites SET last_access = NULL, last_checked_at = NULL WHERE user_id = ?").run(userId).changes;
}

/** В4.8.5 (К8.5.14 (д)): возраст сохранённой проверки, после которого запись перепроверяется в фоне. */
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

// ---------- запуск анализа юзером (В4.1, К3) ----------

export interface UserScanResponse {
  status: number;
  body: Record<string, unknown>;
  /** В4.8.5 (К8.5.7): у 429 — через сколько секунд повторить (заголовок Retry-After) */
  retryAfterSec?: number;
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
  const cheap = userScanCheapGate(db, userId, org, repo, queue, now);
  if (cheap) return cheap;
  const res = prefetched ?? (await client.get(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`));
  // Ф1.6 + круг 2 (LOW-6): отказ предпроверки (403/404, 401) учитывается
  // лимитом частоты — POST не усилитель запросов. В4.8.5 (К8.5.6, С4-13):
  // сбой платформы (0/429/5xx) — не вердикт о правах, лимит запусков не списывает
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
      return rateLimited(db, userId, queue, now);
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

/**
 * Дешёвые отказы запуска БЕЗ сети (К4, Ф1.7): активная заявка того же
 * (юзер, репо) → 202 deduplicated; активных сверх предела → 429
 * too_many_active; часовой лимит исчерпан → 429 rate_limited. null — можно
 * идти в сеть. В4.8.5: вынесено, чтобы маршрут запуска проверял «свой»
 * (сеть) только после них; внутри транзакции постановки проверки повторяются.
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

function tooManyActive(queue: QueueConfig): UserScanResponse {
  return {
    status: 429,
    body: { error: { code: "too_many_active", message: `не больше ${queue.userActiveMax} анализов в очереди одновременно – дождитесь завершения` } },
    // место освободится, когда закончится анализ — точного времени нет, минута — честный шаг опроса
    retryAfterSec: 60,
  };
}

function rateLimited(db: Database, userId: number, queue: QueueConfig, now: Date): UserScanResponse {
  const since = new Date(now.getTime() - 3600_000).toISOString();
  const oldest = db
    .query("SELECT MIN(created_at) AS t FROM jobs WHERE user_id = ? AND trigger_kind = 'user' AND created_at > ?")
    .get(userId, since) as { t: string | null };
  const retryAfterSec = oldest.t ? Math.max(1, Math.ceil((Date.parse(oldest.t) + 3600_000 - now.getTime()) / 1000)) : 60;
  return {
    status: 429,
    body: { error: { code: "rate_limited", message: `не больше ${queue.userScansPerHour} запусков анализа в час – попробуйте позже` } },
    retryAfterSec,
  };
}

// ========== ПОРТ 5 (hq-parallel): панель заданий + избранное ==========

export interface MyJob {
  jobId: number;
  slug: string;
  status: string;
  /**
   * В5.1 (Прод-С1): род заявки — `scan` (анализ) | `summary` (описание AI).
   * Панель различает их: прежде пользователь видел «задание» и не понимал,
   * что живая генерация молча перехватила его запуск анализа.
   * Optional ТОЛЬКО для старых литералов MyJob в замороженных аудит-тестах
   * (как summaryCooldownMs в QueueConfig); myJobs задаёт всегда, absence
   * трактуется панелью как анализ.
   */
  kind?: string;
  phase: "queued" | "running" | "done" | "failed" | "refused";
  /** позиция в user-очереди (только queued) — честное ожидание, не спиннер */
  queueAhead: number | null;
  claimedAt: string | null;
  error: string | null;
  /**
   * В4.8 (панель «Заданий», решение Екатерины 21.09): логотип репозитория из
   * `repos.logo_url` — тот же, что у строки «Моих репозиториев» и рейтинга.
   * Ревью закрытия: под тем же признаком прав `viewerMayReadRepo` (П6), что
   * мета `listMyRepos`, — логотип входит в закрытую мету, и «задание свое»
   * не довод раскрывать его без прав (fail-closed); у отказанной без строки
   * `repos` — null.
   */
  logoUrl: string | null;
  /**
   * В4.8.5 (К8.5.2b, §2-Р4): «затянулось» — признак сервера: задание `running`
   * с истекшим лизом (его воркер умер или цикл событий стоит дольше лиза). Тот
   * же признак краснит /api/health (К8.5.5c). UI не считает его от `leaseMs`.
   */
  stalled: boolean;
  /**
   * В4.8.5 (К8.5.1): скан этого задания — связь без DDL: первый скан того же
   * (репо, автор) со `started_at ≥ claimed_at` задания и раньше взятия
   * следующего задания того же автора на том же репо. null — скана ещё нет
   * (в очереди, упало до скана, отказано).
   */
  scanId: number | null;
  /**
   * Исход скана задания: `ok`/`partial` — собран; `bad` — сбор не удался;
   * `interrupted` — прерван перезапуском сервера или закрыт как сирота
   * (не ошибка для пользователя, К8.5.2a); null — скана нет или он идёт.
   */
  outcome: "ok" | "partial" | "bad" | "interrupted" | null;
  /**
   * К8.5.1 (С4-10): изменилась ли публичная оценка — HealthCraft Index
   * карточки после скана не равен индексу до него (скан, ставший непригодным
   * из-за таймаута клона, оценку не меняет). null — скан не завершён.
   */
  scoreChanged: boolean | null;
}

/**
 * Первый скан задания: тот же (репо, автор), начат не раньше взятия задания в
 * работу. Круг 2 (Н4): и раньше взятия СЛЕДУЮЩЕГО задания того же автора на
 * том же репо — иначе задание, упавшее до скана, получало скан следующего
 * (колонки `finished_at` у заданий нет; без DDL граница — `claimed_at`
 * следующего).
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
 * HealthCraft Index карточки по состоянию «после скана `upTo`» — правило
 * карточки (последний пригодный скан; приватный без него — последний не-bad),
 * ограниченное сканами с id ≤ `upTo`.
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

/** Исход задания по его скану (К8.5.1): скан, исход, изменилась ли публичная оценка. */
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

/** Активные (queued/running) + последние завершённые заявки юзера.
 *  Диагноз UX-аудита: «очереди не видно» — статус жил в useState компонента.
 *  В4.4 (кластер J): LEFT JOIN — refused-заявки (repo_id=0, строки repos по
 *  отказу нет) видны; слаг отказанной — из error-payload, нет и его — «—». */
export function myJobs(db: import("bun:sqlite").Database, userId: number, doneLimit = 8): { active: MyJob[]; recent: MyJob[] } {
  const slugOf = (row: Record<string, unknown>): string => {
    if (typeof row.org_slug === "string") return `${row.org_slug}/${row.repo_slug}`;
    // refused без репо-строки: слаг писался в error-payload при отказе
    if (typeof row.error === "string" && row.error.startsWith("{")) {
      try {
        const slug = (JSON.parse(row.error) as { slug?: unknown }).slug;
        if (typeof slug === "string" && slug !== "") return slug;
      } catch {
        /* не JSON — прочерк */
      }
    }
    return "—";
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
      // В5.1 (Прод-С1): род заявки в панели; legacy-строки без kind — сканы
      kind: typeof row.kind === "string" && row.kind !== "" ? row.kind : "scan",
      phase,
      queueAhead:
        phase === "queued"
          ? (db
              .query("SELECT COUNT(*) AS n FROM jobs WHERE id < ? AND status = 'queued' AND trigger_kind = 'user'")
              .get(Number(row.id)) as { n: number }).n
          : null,
      claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
      // refused: error — машинный JSON со слагом, человеку показывается слаг в `slug`
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
    // LEFT JOIN: refused живёт без строки repos (repo_id = 0)
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
  /** В4.8.5 (К8.5.14 (е), §2-Р1): фоновая перепроверка анализ не ставит */
  | "background"
  | null;

export interface FavoriteEnqueue {
  status: FavoriteEnqueueStatus;
  code: FavoriteEnqueueCode;
}

/**
 * В4.8.5 (К8.5.6): итог проверки прав. `checked` — вердикт записан;
 * `failed` — SourceCraft не ответил (0/429/5xx): сохранённые права НЕ
 * тронуты; `token_rejected` — SourceCraft отклонил токен (401): права
 * перезаписаны отказом (по сути верно), человеку — «замените токен».
 */
export type FavoriteCheckResult = "checked" | "failed" | "token_rejected";

/**
 * Ответ проверки прав избранного.
 *
 * М1 (круг 2): поле зовётся `lastOwnScanAt`, а не `lastScanAt`. Одно имя
 * несло два смысла: у `MyRepoEntry.lastScanAt` — последний скан репо ЛЮБОГО
 * автора, здесь — последний завершённый own-скан ИМЕННО этого зрителя
 * (основание кулдауна, К-П П2). Имена разведены.
 * В4.8.5: маршрута `/check` больше нет — проверка идёт сама при добавлении
 * в избранное (К8.5.14) и фоном; форма ответа живёт в ответе добавления.
 */
export interface FavoriteCheckResponse {
  /** при `failed` — прежние сохранённые права (или «неизвестно»), не результат этой проверки */
  access: FavoriteAccess;
  enqueue: FavoriteEnqueue;
  /** последний завершённый не-bad own-скан зрителя (`scans.user_id = зритель`); основание кулдауна */
  lastOwnScanAt: string | null;
  result: FavoriteCheckResult;
}

/** `requestUserScan` → форма исхода для ответа проверки избранного (П2). */
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
 * В5.3 (25.09, находка владельца): «свой» в сохраненных правах пересчитывается
 * при чтении по ТЕКУЩЕМУ правилу `isOwnRepo` из сохраненных каналов — иначе
 * запись, проверенная до смены правила (internal по коду стал «своим»), навсегда
 * оставалась «чужой» и кнопки анализа не было. Каналы не пересчитываются: это
 * факты проверки; правило — код.
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
 * Живая проверка прав по факту (repo-GET → cicd/runs → AppSec scans/latest —
 * общая `probeRepoAccess`, те же правила, что у карточки) и, при своих правах
 * и простывшем кулдауне, заявка на анализ (механика; LLM никогда).
 *
 * В4.8.5: вызывается автоматически — при явном добавлении в избранное (с
 * `enqueueUserScan`: первый анализ своего ставится только здесь, §2-Р1) и
 * фоновым насосом перепроверки (без него: права пишутся, анализ не ставится).
 * К8.5.6: сбой SourceCraft (0/429/5xx) — не вердикт: сохранённые права и
 * время проверки не трогаются, заявка не ставится.
 *
 * В4.2-port-fix (П2, Н1 HIGH): колбэк постановки АСИНХРОННЫЙ и отдаёт исход
 * `FavoriteEnqueue` — за ним стоит `requestUserScan` целиком (дешёвая
 * предпроверка, дедуп, `too_many_active`, `rate_limited`, транзакция Ф1.5,
 * строки `refused`); вызывающий прокидывает УЖЕ полученное тело repo-GET
 * (4-го живого запроса нет). Отказ по капу не роняет проверку прав — её
 * результат зритель видит всё равно. Кулдаун — по последнему не-bad own-скану
 * ИМЕННО этого зрителя.
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
  // К-П П2: own-скан ЭТОГО зрителя (scans.user_id = userId, не IS NOT NULL —
  // иначе скан другого юзера блокирует автопостановку на 6 часов).
  // В4.8.5 (К8.5.2a, С8-8): `bad`-скан (shutdown, orphaned, сбой канала,
  // score_failed) кулдаун не включает — анализа по сути не было
  const last = db
    .query(
      `SELECT MAX(s.finished_at) AS f FROM scans s JOIN repos r ON r.id = s.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND s.user_id = ? AND s.finished_at IS NOT NULL AND s.status != 'bad'`,
    )
    .get(org, repo, userId) as { f: string | null };
  const lastOwnScanAt = last?.f ?? null;
  // С3-1: сбой платформы не затирает доказанные права. Круг 2 (П1): то же,
  // когда репо видно, а CI или AppSec не ответили (0/429/5xx) и правило
  // «свой» без них не выполнено — «свой» неизвестен, как в предпроверке
  // `/scan`: прежние права и время проверки не трогаются (запись «не
  // проверена» остаётся кандидатом насоса), заявка не делает вывод «не свой»
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
