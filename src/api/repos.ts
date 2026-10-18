// Read-API: чистые функции чтения БД (рейтинг, карточка, мета). Сети здесь
// нет – UI живет на том, что уже посчитал скан. Сортировка, фильтры, пагинация
// и фасеты считаются на сервере, а не на клиенте: рейтинг сразу является
// контрактом данных. Репо без оценки в ранжировании не участвуют и уходят в
// отдельный массив, иначе «нет данных» оказалось бы лучшим или худшим
// результатом в зависимости от направления сортировки.
import type { Database } from "bun:sqlite";
import { CHANNEL_KINDS, DISPLAY_KINDS, PUBLIC_KINDS, computeFromFacts, effectiveFacts, totalCapFlags, totalsFromCategories, type CategoryScore } from "../score/compute";
import { authorsOf, orderRecommendations, recommendFromFacts, recommendationParams, recommendationText, round4, type DeltaEvaluator } from "../score/recommend";
import { categoryOf, parseFactValue, scrubDetail } from "../collectors/facts";
import { isOwnRepo, NO_PAT_ACCESS, visibilityOf, type AccessRepo, type AccessResult, type ChannelAccess } from "../auth/access";
import { DEFAULT_SCAN, defaultLeaseMs, type ScanConfig } from "../config";
import { roundScore, type GitLimitsMarker } from "../web/format";
import type { DerivedMetrics } from "../score/derived";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, COVERAGE_NULL_BELOW, type CategoryKey, type IndexCategoryKey, MODEL_VERSION, SECRETS_CRITICAL_TOTAL_CAP, CRITICAL_FINDINGS_TOTAL_CAP } from "../score/model";
import type { AiAudience } from "../db";
import { NO_RHYTHM_REASON } from "../summary/pipeline";
import { CI_VALUES, SIZE_BUCKETS, sizeBucketOf, type CiFilter, type SizeBucket } from "./rating-filters";
import { ladderFromFacts, type Ladder } from "../score/ladder";
import { fixTemplateOf, templateFor, type FixFile, type FixRuleId, type FixTemplateMeta, type LicenseId } from "../fix/templates";
import { rankBadge, type RankBadge } from "./rank-badge";
import { COHORT_CATEGORIES, buildCohort, type CohortMember, type RepoCohort } from "./cohort";

// ---------- общие формы ----------

// значения живут в чистом модуле (их берет и бандл web), здесь – реэкспорт
import { CATEGORY_ORDER, CATEGORY_TITLES } from "../report/categories";
export { CATEGORY_ORDER, CATEGORY_TITLES };

/** Путь к методике в репозитории (строка, не URL): футер и MD ссылаются сюда. */
export const METHODOLOGY_PATH = "docs/methodology.md";

export interface ApiError {
  error: { code: "bad_query" | "not_found"; message: string };
}

export interface RatingItem {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  /** HealthCraft Index (4 категории, сохраненный healthcraft_index) */
  healthcraftIndex: number | null;
  /** index_coverage */
  coverage: number;
  /** CI/Security в рейтинг не входят — всегда null (данные каналов с правами не публикуются) */
  categories: Record<CategoryKey, number | null>;
  likes: number | null;
  forks: number | null;
  lastActivityAt: string | null;
  /** logo.url платформы (дисплей); null — UI рисует инициалы */
  logoUrl: string | null;
  /** language.color платформы (#rrggbb) — точка языка; null — без точки */
  languageColor: string | null;
  scannedAt: string | null;
  scanStatus: string;
  /**
   * Место в публичном рейтинге по HealthCraft Index – то же правило, что на
   * карточке (индекс по убыванию, при равенстве – org/repo). Не зависит от
   * поиска, фильтров и сортировки выдачи; null – без индекса.
   */
  rank: number | null;
  /**
   * Динамика позиции: место в последнем снимке до текущих UTC-суток
   * (`rating_snapshots`) минус текущее место; положительное – вырос. null –
   * снимка нет или репо в нем отсутствует.
   */
  rankDelta: number | null;
  /**
   * Значок места «ТОП-N» по индексу в той же выборке, что `rank` (фильтры его
   * не меняют, у равных индексов он одинаков); null – места нет или уровень не подходит
   */
  rankBadge: RankBadge | null;
  /**
   * Последняя проверка на накрутку (заметка flagger) поставила flag:true; битый
   * JSON – флага нет, как на карточке. Это подозрение, а не приговор: на место,
   * сортировку и фильтры флаг не влияет.
   */
  fraud: boolean;
  /** страница репо на SourceCraft – для внешней ссылки в строке */
  webUrl: string;
  /** у репо есть ПУБЛИЧНЫЙ AI-обзор (тот, что видят все) – искра у имени и фильтр «С AI-обзором» */
  aiOverview: boolean;
  /** часть фактов взята из истории при сбое канала – это НЕ «давность скана» */
  staleFacts: boolean;
  /** репозиторий без кода (`scores.code_empty`): у индекса 0 метка «нет кода», как в «Сравнении» */
  codeEmpty: boolean;
  modelVersion: string;
}

export interface LanguageFacet {
  language: string | null;
  count: number;
  /**
   * Цвет языка (`repos.language_color`, #rrggbb) для кружка в мультивыборе.
   * Без поля цвет знали бы только строки текущей страницы. null – у языка нет
   * цвета платформы (или язык не определен).
   */
  color: string | null;
}

/** Счетчик значения фильтра размера (см. `RatingResponse.facets`). */
export interface SizeFacet {
  bucket: SizeBucket;
  count: number;
}

/** Счетчик значения фильтра CI (см. `RatingResponse.facets`). */
export interface CiFacet {
  value: CiFilter;
  count: number;
}

export interface RatingResponse {
  items: RatingItem[];
  /** HealthCraft Index = NULL: вне ранжирования и вне пагинации */
  nullItems: RatingItem[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  nulls: number;
  /**
   * Оцененных репо с публичным AI-обзором с учетом поиска, языка, размера и
   * CI, но до фильтра `ai`: сколько даст кнопка
   */
  aiCount: number;
  /**
   * Фасеты считаются по выборке с учетом ТОЛЬКО поиска: выбранные фильтры не
   * схлопывают списки, из которых их выбирали. Счетчик – все репо выборки
   * (оцененные и без оценки). У размера – все 5 корзин в порядке SIZE_BUCKETS
   * (0 тоже число); репо без данных о размере или CI не входит ни в один
   * счетчик своего фильтра.
   */
  facets: { languages: LanguageFacet[]; size: SizeFacet[]; ci: CiFacet[] };
  generatedAt: string;
}

export type SortKey = "index" | "likes" | "activity" | "coverage" | "name";
export type SortOrder = "desc" | "asc";

export interface ReposQuery {
  sort: SortKey;
  order: SortOrder;
  /**
   * Множество языков из повторяемого `lang` (`?lang=Go&lang=Rust`).
   * undefined – фильтра нет (все языки); элемент null – «язык не определен»
   * (`lang=` пустым).
   */
  lang?: (string | null)[];
  q?: string;
  /** только репо с публичным AI-обзором (`ai=1`) */
  ai?: boolean;
  /**
   * Множество корзин размера из повторяемого `size` (`?size=small&size=none`);
   * undefined – фильтра нет. Репо без данных о размере при фильтре не
   * попадает ни в одну корзину.
   */
  size?: SizeBucket[];
  /** `ci=yes` – есть `.sourcecraft/ci.yaml`, `ci=no` – подтвержденно нет */
  ci?: CiFilter;
  page: number;
  perPage: number;
}

const SORT_KEYS: SortKey[] = ["index", "likes", "activity", "coverage", "name"];

/**
 * Страница 20: при строке 46px на экране 1440 видно 17 строк, и страница
 * обозрима почти целиком. Список размеров страницы в UI обязан содержать 20.
 */
export const DEFAULT_QUERY: ReposQuery = { sort: "index", order: "desc", page: 1, perPage: 20 };

export type ParseResult = { ok: true; query: ReposQuery } | { ok: false; message: string };

/**
 * Неизвестный параметр игнорируется, неверное ЗНАЧЕНИЕ известного – 400:
 * тихо показать не то, что просили, хуже явной ошибки.
 */
export function parseReposQuery(params: URLSearchParams): ParseResult {
  const query: ReposQuery = { ...DEFAULT_QUERY };

  const sort = params.get("sort");
  if (sort !== null) {
    if (!SORT_KEYS.includes(sort as SortKey)) {
      return { ok: false, message: "в адресе рейтинга неизвестный порядок сортировки" };
    }
    query.sort = sort as SortKey;
  }

  const order = params.get("order");
  if (order !== null) {
    if (order !== "desc" && order !== "asc") {
      return { ok: false, message: "в адресе рейтинга неизвестное направление сортировки" };
    }
    query.order = order;
  }

  if (params.has("lang")) {
    const langs: (string | null)[] = [];
    for (const raw of params.getAll("lang")) {
      const lang = raw === "" ? null : raw;
      if (!langs.includes(lang)) langs.push(lang);
    }
    query.lang = langs;
  }

  if (params.has("q")) {
    const q = params.get("q")!;
    if (q !== "") query.q = q;
  }

  const page = params.get("page");
  if (page !== null) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) return { ok: false, message: "в адресе рейтинга неверный номер страницы" };
    query.page = n;
  }

  const ai = params.get("ai");
  if (ai !== null) {
    if (ai !== "1") return { ok: false, message: "в адресе рейтинга неизвестный фильтр AI-обзора" };
    query.ai = true;
  }

  if (params.has("size")) {
    const sizes: SizeBucket[] = [];
    for (const raw of params.getAll("size")) {
      if (!SIZE_BUCKETS.includes(raw as SizeBucket)) return { ok: false, message: "в адресе рейтинга неизвестный размер репозитория" };
      if (!sizes.includes(raw as SizeBucket)) sizes.push(raw as SizeBucket);
    }
    query.size = sizes;
  }

  const ci = params.get("ci");
  if (ci !== null) {
    if (params.getAll("ci").length > 1 || !CI_VALUES.includes(ci as CiFilter)) {
      return { ok: false, message: "в адресе рейтинга неизвестный фильтр CI" };
    }
    query.ci = ci as CiFilter;
  }

  const perPage = params.get("per_page");
  if (perPage !== null) {
    const n = Number(perPage);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { ok: false, message: "в адресе рейтинга неверный размер страницы: от 1 до 100" };
    }
    query.perPage = n;
  }

  return { ok: true, query };
}

// ---------- рейтинг ----------

interface RatingRow {
  /** внутренний ключ стыковки со снимком мест и заметками flagger (в ответ не едет) */
  repo_id: number;
  /** ключ фактов размера и CI (в ответ не едет) */
  scan_id: number;
  /** scores.code_empty: 1 – репозиторий без кода */
  code_empty: number | null;
  org_slug: string;
  repo_slug: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  forks: number | null;
  last_activity_at: string | null;
  logo_url: string | null;
  language_color: string | null;
  total: number | null;
  coverage: number;
  /** баллы 4 категорий индекса (`json_extract`); NULL – нет данных или ключа нет */
  c_documentation: number | null;
  c_activity: number | null;
  c_issues: number | null;
  c_code: number | null;
  stale: string;
  model_version: string;
  scan_status: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * «Последний пригодный» скан: последняя по scan_id строка оценки текущей
 * модели у скана с rating_eligible = 1. Один подзапрос на все поверхности –
 * рейтинг, фасеты, счетчики /api/meta, listMyRepos, карточку и MD.
 * «Последний» – по scan_id, а не по датам: id монотонен. Параметр – model_version.
 */
export const LAST_ELIGIBLE_SCAN_SQL = `(SELECT MAX(sc2.scan_id) FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
   WHERE sc2.repo_id = sc.repo_id AND sc2.model_version = ? AND s2.rating_eligible = 1)`;

/**
 * Для приватного репо без пригодного скана: последний завершенный не-bad скан
 * с оценкой текущей модели. Параметр – model_version.
 */
export const LAST_NOT_BAD_SCAN_SQL = `(SELECT MAX(sc2.scan_id) FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
   WHERE sc2.repo_id = sc.repo_id AND sc2.model_version = ? AND s2.status NOT IN ('bad', 'running', 'queued'))`;

/** Последний скан репо: статус и время последнего анализа. Алиас репо – r. */
const LAST_SCAN_SQL = `(SELECT MAX(l2.id) FROM scans l2 WHERE l2.repo_id = r.id)`;

// Одна строка на репозиторий: оценка последнего пригодного скана (сохраненный
// HealthCraft Index, 4 категории – CI и Security в рейтинг не входят), статус
// (public_status) и время – последнего скана, как на карточке. Только
// rating_active=1 AND visibility='public', проверок доступа нет.
// Ради скорости «последний пригодный» (как LAST_ELIGIBLE_SCAN_SQL) и
// «последний» (как LAST_SCAN_SQL) считаются через `GROUP BY` один раз на репо,
// а не коррелированным подзапросом на строку, а из JSON категорий SQLite
// достает только 4 балла индекса – строка категорий (~1,4 КБ) в JS не едет.
// На 28 тыс. репо это экономит порядка секунды на запрос.
const RATING_SQL = `
WITH last AS (
  SELECT sc2.repo_id, MAX(sc2.scan_id) AS scan_id FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
  WHERE sc2.model_version = ? AND s2.rating_eligible = 1 GROUP BY sc2.repo_id),
lastscan AS (SELECT repo_id, MAX(id) AS id FROM scans GROUP BY repo_id)
SELECT r.id AS repo_id, last.scan_id AS scan_id, sc.code_empty, r.org_slug, r.repo_slug, r.title, r.language, r.likes, r.forks, r.last_activity_at, r.logo_url, r.language_color,
       sc.healthcraft_index AS total, sc.index_coverage AS coverage,
       json_extract(sc.categories, '$.documentation.score') AS c_documentation,
       json_extract(sc.categories, '$.activity.score') AS c_activity,
       json_extract(sc.categories, '$.issues.score') AS c_issues,
       json_extract(sc.categories, '$.code.score') AS c_code,
       sc.stale, sc.model_version,
       COALESCE(l.public_status, l.status) AS scan_status, l.started_at, l.finished_at
FROM last
JOIN scores sc ON sc.scan_id = last.scan_id AND sc.model_version = ?
JOIN repos r ON r.id = last.repo_id
JOIN lastscan ls ON ls.repo_id = r.id
JOIN scans l ON l.id = ls.id
WHERE r.rating_active = 1
  AND r.visibility = 'public'`;

/** Категории каналов с правами зрителя: в рейтинге и без доступа они закрыты. */
export const CHANNEL_CATEGORIES: CategoryKey[] = ["cicd", "security"];

/**
 * Ключ дерева КАНАЛЬНОГО скана в доказательствах карточки. Это НЕ kind: факта
 * с таким ключом в `facts` нет и быть не может (в реестре `KINDS` нет «@»), в
 * списки kinds он не входит, Score по нему не считается, валидатор и фильтры
 * пригодности его не видят. Живет только в `evidence` карточки и в MD-отчете:
 * под ним едет `tree.stats` того скана, по которому посчитана плотность
 * Security, а публичный `tree.stats` остается на месте (он кормит `derived`).
 * Суффикс `@channel` не спутать с kind, а `categoryOf` (префикс до первой
 * точки) по-прежнему дает «code».
 */
export const CHANNEL_TREE_KEY = "tree.stats@channel";

/**
 * Страница репо на SourceCraft (шаблон платформы, колонки в схеме нет) –
 * один литерал для карточки и строки рейтинга.
 */
export function repoWebUrl(org: string, repo: string): string {
  return `https://sourcecraft.dev/${org}/${repo}`;
}

function toRatingItem(row: RatingRow): RatingItem {
  const indexScores: Partial<Record<CategoryKey, number | null>> = {
    documentation: row.c_documentation,
    activity: row.c_activity,
    issues: row.c_issues,
    code: row.c_code,
  };
  const categories = {} as Record<CategoryKey, number | null>;
  for (const key of CATEGORY_ORDER) {
    categories[key] = CHANNEL_CATEGORIES.includes(key) ? null : (indexScores[key] ?? null);
  }
  // stale-маркер рейтинга – только по фактам, которые входят в рейтинг
  const stale = (JSON.parse(row.stale) as string[]).filter((k) => PUBLIC_KINDS.includes(k));
  return {
    rank: null,
    rankDelta: null,
    rankBadge: null,
    fraud: false,
    webUrl: repoWebUrl(row.org_slug, row.repo_slug),
    aiOverview: false,
    org: row.org_slug,
    repo: row.repo_slug,
    title: row.title,
    language: row.language,
    healthcraftIndex: row.total,
    coverage: row.coverage,
    categories,
    likes: row.likes,
    forks: row.forks,
    lastActivityAt: row.last_activity_at,
    logoUrl: row.logo_url,
    languageColor: row.language_color,
    scannedAt: row.finished_at ?? row.started_at,
    scanStatus: row.scan_status,
    staleFacts: Array.isArray(stale) && stale.length > 0,
    codeEmpty: row.code_empty === 1,
    modelVersion: row.model_version,
  };
}

const fullName = (i: RatingItem): string => `${i.org}/${i.repo}`;

/** Ключ сортировки; null = значения нет (всегда в хвосте, при любом order). */
function sortValue(item: RatingItem, sort: SortKey): number | string | null {
  switch (sort) {
    case "index":
      return item.healthcraftIndex;
    case "likes":
      return item.likes;
    case "activity":
      return item.lastActivityAt;
    case "coverage":
      return item.coverage;
    case "name":
      return fullName(item);
  }
}

function compareItems(a: RatingItem, b: RatingItem, sort: SortKey, order: SortOrder): number {
  const av = sortValue(a, sort);
  const bv = sortValue(b, sort);
  // NULL не «маленькое» и не «большое» – оно вне шкалы, поэтому всегда
  // в хвосте: иначе смена order делала бы «нет данных» лидером рейтинга
  if (av === null && bv === null) return fullName(a).localeCompare(fullName(b));
  if (av === null) return 1;
  if (bv === null) return -1;
  let cmp: number;
  if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
  else cmp = (av as number) - (bv as number);
  if (order === "desc") cmp = -cmp;
  // равные значения – по org/repo, чтобы пагинация не «дышала» между страницами
  return cmp !== 0 ? cmp : fullName(a).localeCompare(fullName(b));
}

function matchesQ(item: RatingItem, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    item.org.toLowerCase().includes(needle) ||
    item.repo.toLowerCase().includes(needle) ||
    (item.title ?? "").toLowerCase().includes(needle)
  );
}

// ---------- факты фильтров размера и CI ----------

/** Что фильтрам нужно из фактов скана: строки кода (null – незнание) и наличие ci.yaml (null – факта нет). */
export interface ScanFilterFacts {
  loc: number | null;
  hasCi: boolean | null;
}

/**
 * Память фактов фильтров по scan_id, отдельная на каждое соединение БД (у
 * тестов свои базы с пересекающимися id). Факты скана пишутся один раз, до
 * оценки, и больше не меняются, поэтому запомненное не устаревает; новый скан
 * приходит с новым scan_id и дочитывается. Чтение `tree.stats` и
 * `cicd.configs` на каждом запросе добавляло ~250 мс к рейтингу на 28 тыс.
 * строк. Производная колонка в `scores` потребовала бы правки конвейера оценки
 * и дала бы «нет данных» у всех строк до пересчета.
 */
const filterFactsMemo = new WeakMap<Database, Map<number, ScanFilterFacts>>();

/** Сколько scan_id в одном IN (ниже лимита переменных SQLite). */
const FILTER_FACTS_CHUNK = 500;

interface FilterFactRow {
  scan_id: number;
  key: string;
  sl_type: string | null;
  sl: number | null;
  loc_type: string | null;
  loc: number | null;
  unread: number | null;
  ci: number | null;
  ci_type: string | null;
}

// json_valid – страж: битое значение одного факта не роняет рейтинг (факт = незнание);
// у этих kinds сжатия нет (z:-префикс только у timeline)
const FILTER_FACTS_SQL = (n: number) => `
SELECT scan_id, key,
  CASE WHEN ok THEN json_type(value, '$.source_loc') END AS sl_type,
  CASE WHEN ok THEN json_extract(value, '$.source_loc') END AS sl,
  CASE WHEN ok THEN json_type(value, '$.loc') END AS loc_type,
  CASE WHEN ok THEN json_extract(value, '$.loc') END AS loc,
  CASE WHEN ok THEN json_extract(value, '$.source_unread') END AS unread,
  CASE WHEN ok THEN json_type(value, '$.has_ci_yaml') END AS ci_type,
  CASE WHEN ok THEN json_extract(value, '$.has_ci_yaml') END AS ci
FROM (SELECT scan_id, key, value, status = 'ok' AND json_valid(value) AS ok FROM facts
      WHERE category = ? AND key = ? AND scan_id IN (${Array(n).fill("?").join(",")}))`;

/**
 * Строки кода из `tree.stats`: `source_loc`, у старых фактов без этого поля –
 * `loc`. `source_loc = null` – чтение оборвалось (незнание, как в
 * codeEmptyKind); 0 строк при непрочитанных файлах кода – тоже незнание. При
 * `source_unread > 0` число – лишь нижняя граница.
 */
function locOf(r: FilterFactRow): number | null {
  const isNum = (t: string | null) => t === "integer" || t === "real";
  if (isNum(r.sl_type)) {
    if (r.sl === 0 && typeof r.unread === "number" && r.unread > 0) return null;
    return r.sl;
  }
  if (r.sl_type === null && isNum(r.loc_type)) return r.loc;
  return null;
}

/** Факты фильтров для набора сканов: из памяти, новые scan_id дочитываются пачками. */
export function scanFilterFacts(db: Database, scanIds: number[], opts: { prune?: boolean } = {}): Map<number, ScanFilterFacts> {
  let memo = filterFactsMemo.get(db);
  if (memo === undefined) {
    memo = new Map();
    filterFactsMemo.set(db, memo);
  }
  const missing = scanIds.filter((id) => !memo.has(id));
  for (let i = 0; i < missing.length; i += FILTER_FACTS_CHUNK) {
    const chunk = missing.slice(i, i + FILTER_FACTS_CHUNK);
    const got = new Map<number, ScanFilterFacts>(chunk.map((id) => [id, { loc: null, hasCi: null }]));
    for (const r of db.query(FILTER_FACTS_SQL(chunk.length)).all("code", "tree.stats", ...chunk) as FilterFactRow[]) {
      got.get(r.scan_id)!.loc = locOf(r);
    }
    for (const r of db.query(FILTER_FACTS_SQL(chunk.length)).all("cicd", "cicd.configs", ...chunk) as FilterFactRow[]) {
      // has_ci_yaml – булево; иное значение (нет поля, мусор) – незнание
      if (r.ci_type === "true" || r.ci_type === "false") got.get(r.scan_id)!.hasCi = r.ci === 1;
    }
    for (const [id, v] of got) memo.set(id, v);
  }
  // сканы, ушедшие из рейтинга, выбрасываются, чтобы память не росла. Для
  // частичного набора (когорта карточки) – `prune: false`: иначе карточка
  // выбросила бы весь рейтинг, и он дочитывал бы факты заново
  if (opts.prune !== false && memo.size > scanIds.length * 2 + 1000) {
    const keep = new Set(scanIds);
    for (const id of memo.keys()) if (!keep.has(id)) memo.delete(id);
  }
  return memo;
}

export function listRepos(db: Database, query: ReposQuery, opts: { now?: Date } = {}): RatingResponse {
  const rows = db.query(RATING_SQL).all(MODEL_VERSION, MODEL_VERSION) as RatingRow[];
  // Место считается по всему рейтингу, до поиска и фильтров (как на карточке).
  // Список сортируется по месту один раз: фильтры порядок сохраняют, и выдаче
  // по умолчанию вторая сортировка не нужна; NULL-индексы – в хвосте.
  // Размер и CI берутся из фактов скана строки, «без кода» – из строки оценки;
  // они лежат во внутренних Map и в ответ не едут
  const factsByScan = scanFilterFacts(db, rows.map((r) => r.scan_id));
  const sizeOf = new Map<RatingItem, SizeBucket | null>();
  const ciOf = new Map<RatingItem, boolean | null>();
  const all = rows
    .map((row) => {
      const item = toRatingItem(row);
      const f = factsByScan.get(row.scan_id);
      sizeOf.set(item, sizeBucketOf(row.code_empty === 1, f?.loc ?? null));
      ciOf.set(item, f?.hasCi ?? null);
      return item;
    })
    .sort((a, b) => compareItems(a, b, "index", "desc"));
  // публичный AI-обзор – одним запросом на всю выдачу (заметки overview аудитории public)
  const withAi = new Set(
    (
      db
        .query("SELECT DISTINCT r.org_slug || '/' || r.repo_slug AS slug FROM ai_notes n JOIN repos r ON r.id = n.repo_id WHERE n.role = 'overview' AND n.audience = 'public'")
        .all() as { slug: string }[]
    ).map((r) => r.slug),
  );
  for (const item of all) item.aiOverview = withAi.has(`${item.org}/${item.repo}`);
  all.forEach((item, i) => {
    if (item.healthcraftIndex !== null) item.rank = i + 1;
  });
  // значок места – от индекса (как `ratingPlace` карточки): список уже отсортирован
  // по индексу, поэтому «выше» – начало группы равных, «не ниже» – ее конец
  const rankedTotal = all.filter((i) => i.healthcraftIndex !== null).length;
  for (let from = 0; from < rankedTotal; ) {
    let to = from;
    while (to < rankedTotal && all[to]!.healthcraftIndex === all[from]!.healthcraftIndex) to++;
    const badge = rankBadge({ above: from, atOrAbove: to, rankedTotal });
    for (let i = from; i < to; i++) all[i]!.rankBadge = badge;
    from = to;
  }
  // repo_id в ответ не едет – это ключ стыковки строки со снимком мест и заметкой flagger
  const idBySlug = new Map(rows.map((r) => [`${r.org_slug}/${r.repo_slug}`, r.repo_id]));

  // Динамика позиции: базовый снимок читается один раз в Map, без запроса на
  // строку. delta = место в снимке − место сейчас (положительное = вырос).
  // База – последний снимок ДО текущих UTC-суток: сегодняшний пишется сразу
  // после ночной волны и совпадает с текущим порядком, сравнение с ним весь
  // день показывало бы «без изменений».
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const snapDay = (db.query("SELECT MAX(taken_at) AS d FROM rating_snapshots WHERE taken_at < ?").get(today) as { d: string | null }).d;
  if (snapDay !== null) {
    const snapRank = new Map(
      (db.query("SELECT repo_id, rank FROM rating_snapshots WHERE taken_at = ?").all(snapDay) as { repo_id: number; rank: number }[]).map((r) => [
        r.repo_id,
        r.rank,
      ]),
    );
    for (const item of all) {
      if (item.rank === null) continue;
      const prev = snapRank.get(idBySlug.get(`${item.org}/${item.repo}`)!);
      item.rankDelta = prev === undefined ? null : prev - item.rank;
    }
  }

  // Плашка накрутки – по последней заметке flagger репо, тем же правилом, что
  // fraudOf карточки (scan_id DESC, id DESC), но окном по всем репо одним
  // запросом. Битый JSON – флага нет. На место и сортировку флаг не влияет.
  const flagged = new Set<number>();
  for (const row of db
    .query(
      `SELECT repo_id, text FROM (
         SELECT repo_id, text, ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY scan_id DESC, id DESC) AS rn
         FROM ai_notes WHERE role = 'flagger') WHERE rn = 1`,
    )
    .all() as { repo_id: number; text: string }[]) {
    if (parseFlaggerNote(row.text)?.flag === true) flagged.add(row.repo_id);
  }
  if (flagged.size > 0) {
    for (const item of all) {
      if (flagged.has(idBySlug.get(`${item.org}/${item.repo}`)!)) item.fraud = true;
    }
  }

  // фасеты считаются БЕЗ фильтров (иначе выбранный язык схлопнул бы список
  // выбора и из него некуда было бы вернуться), но С учетом поиска
  const byQ = query.q === undefined ? all : all.filter((i) => matchesQ(i, query.q!));
  const counts = new Map<string | null, number>();
  const colors = new Map<string | null, string | null>();
  // цвет у платформы один на язык; берем известный цвет строки с наименьшим
  // org/repo, чтобы выбор не зависел от порядка списка
  const colorFrom = new Map<string | null, string>();
  for (const item of byQ) {
    counts.set(item.language, (counts.get(item.language) ?? 0) + 1);
    if (item.language === null || !item.languageColor) continue;
    const name = fullName(item);
    const seen = colorFrom.get(item.language);
    if (seen === undefined || name.localeCompare(seen) < 0) {
      colorFrom.set(item.language, name);
      colors.set(item.language, item.languageColor);
    }
  }
  const languages: LanguageFacet[] = [...counts.entries()]
    .map(([language, count]) => ({ language, count, color: colors.get(language) ?? null }))
    .sort((a, b) => b.count - a.count || (a.language ?? "￿").localeCompare(b.language ?? "￿"));

  // счетчики размера и CI – по той же выборке, что языки
  const sizeCounts = new Map<SizeBucket, number>();
  const ciCounts = new Map<CiFilter, number>();
  for (const item of byQ) {
    const size = sizeOf.get(item);
    if (size) sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    const ci = ciOf.get(item);
    if (ci !== null && ci !== undefined) ciCounts.set(ci ? "yes" : "no", (ciCounts.get(ci ? "yes" : "no") ?? 0) + 1);
  }

  const langs = query.lang;
  const byLang = langs === undefined ? byQ : byQ.filter((i) => langs.includes(i.language));
  // нет данных о размере или CI – ни в одну корзину: это незнание
  const sizes = query.size;
  const inSizes = (i: RatingItem): boolean => {
    const size = sizeOf.get(i);
    return size !== null && size !== undefined && sizes!.includes(size);
  };
  const bySize = sizes === undefined ? byLang : byLang.filter(inSizes);
  const ciWant = query.ci === undefined ? undefined : query.ci === "yes";
  const byCi = ciWant === undefined ? bySize : bySize.filter((i) => ciOf.get(i) === ciWant);
  const aiCount = byCi.filter((i) => i.healthcraftIndex !== null && i.aiOverview).length;
  const filtered = query.ai === true ? byCi.filter((i) => i.aiOverview) : byCi;
  const scored = filtered.filter((i) => i.healthcraftIndex !== null);
  const nullItems = filtered
    .filter((i) => i.healthcraftIndex === null)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  if (query.sort !== "index" || query.order !== "desc") scored.sort((a, b) => compareItems(a, b, query.sort, query.order));

  const total = scored.length;
  const totalPages = Math.max(1, Math.ceil(total / query.perPage));
  const from = (query.page - 1) * query.perPage;
  return {
    items: scored.slice(from, from + query.perPage),
    nullItems,
    page: query.page,
    perPage: query.perPage,
    total,
    totalPages,
    nulls: nullItems.length,
    aiCount,
    facets: {
      languages,
      size: SIZE_BUCKETS.map((bucket) => ({ bucket, count: sizeCounts.get(bucket) ?? 0 })),
      ci: CI_VALUES.map((value) => ({ value, count: ciCounts.get(value) ?? 0 })),
    },
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

// ---------- карточка репозитория ----------

export interface CardRepo {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  forks: number | null;
  lastActivityAt: string | null;
  /** logo.url платформы (дисплей); null — UI рисует инициалы */
  logoUrl: string | null;
  languageColor: string | null;
  webUrl: string;
  /**
   * Видимость в SourceCraft для плашки у имени: все 3 значения
   * `Repository.Visibility` и явное «неизвестно» (мусор или NULL в строке).
   */
  visibility: "public" | "internal" | "private" | "unknown";
  /**
   * Бейдж и публичный API отвечают этому репозиторию (`publicApiVisible` – та
   * же проверка, что у маршрута `badge.svg`); false – маршрут ответил бы 404,
   * кнопки бейджа нет.
   */
  badge: boolean;
}

export interface CardMarkers {
  /** деградационный ярус: история видна только с этой даты */
  historyTruncatedSince: string | null;
  /** CI заявлен конфигом, прогоны недоступны — потолок категории 50 */
  ciConfigOnlyCap: boolean;
  /** часть фактов взята из истории при сбое канала */
  staleFacts: boolean;
  /** репозиторий без кода: по правилу методики Score 0 – это данные («проекта нет»), а не NULL */
  codeEmpty: boolean;
  /** git-канал уперся в лимиты оператора (факт no-data(limits)) – лимиты для текста причины; иначе null */
  gitLimits: GitLimitsMarker | null;
}

export interface CardScan {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  /**
   * Почему скан закрыт `bad` без сбоя сбора: прерван штатной остановкой
   * (`shutdown`), закрыт как сирота (`orphaned`), не посчиталась оценка
   * (`score_failed`); иначе null. Прерванный скан для пользователя не
   * «ошибка» (`analysisOutcome`).
   */
  detail?: ScanDetail | null;
}

export type ScanDetail = "shutdown" | "orphaned" | "score_failed";

/** status_detail скана → закрытый список причин наружу (прочие строки — служебные, наружу не едут). */
export function scanDetailOf(raw: string | null | undefined): ScanDetail | null {
  return raw === "shutdown" || raw === "orphaned" || raw === "score_failed" ? raw : null;
}

/**
 * Статус живой заявки зрителя по этому репо (queued/running) для статус-блока
 * карточки. Позиции в очереди нет: round-robin не задает FIFO-порядок. null –
 * живой заявки нет (или зритель анонимен).
 */
export interface CardJob {
  status: "queued" | "running";
  /**
   * «Затянулось» – признак сервера: задание `running`, а его лиз истек (живой
   * воркер продлевает лиз каждые leaseMs/3). UI не считает это сам от
   * `leaseMs`: при лизе 10 мин штатный 20-минутный клон выглядел бы зависшим.
   */
  stalled: boolean;
}

export interface CardCategory extends CategoryScore {
  /** номинальный вес категории в Repo Health Score (SCORE_WEIGHTS): карточка объясняет перенормировку полного показателя; веса индекса — в /api/meta.categories[].indexWeight */
  weight: number;
  /** канал закрыт зрителю: чисел и подметрик нет, причина – для заглушки */
  locked?: ChannelAccess;
}

export interface CardScore {
  /** HealthCraft Index (4 категории) — всем */
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** Repo Health Score (6 категорий, кап 49) — только при доступе к CI и Security, иначе null; считается на чтении из показанных категорий */
  repoHealthScore: number | null;
  repoHealthCoverage: number | null;
  /** true = зрителю закрыт хотя бы один из каналов CI/Security — полный показатель не показывается */
  fullLocked: boolean;
  /**
   * Место в публичном рейтинге по HealthCraft Index и размер выборки.
   * Считается по тому же набору, что сам рейтинг (rating_active, public,
   * последний пригодный скан текущей модели) и БЕЗ фильтров зрителя: это
   * позиция среди всех оцененных, а не среди отфильтрованных. Оба поля null,
   * когда индекса нет, и когда сам репозиторий в этот набор не входит
   * (приватный: у него есть индекс, но в публичном рейтинге его нет).
   */
  rank: number | null;
  rankedTotal: number | null;
  /** значок места «ТОП-N», равен значку строки рейтинга; null – места нет */
  rankBadge: RankBadge | null;
  /**
   * «Индекс лучше, чем у X% похожих» (см. `cohort.ts`). null – тогда же, когда
   * `rank` null: процента в выборке, которой репо не принадлежит, нет.
   */
  cohort: RepoCohort | null;
  modelVersion: string;
  computedAt: string;
  noData: string[];
  stale: string[];
  categories: Record<CategoryKey, CardCategory>;
}

/** Чип рекомендации: `missing` = факта нет по построению (см. объяснение в UI). */
export interface CardFactRef {
  key: string;
  missing: boolean;
}

export interface CardRecommendation {
  ruleId: string;
  kind: string;
  priority: number;
  problem: string;
  action: string;
  factRefs: CardFactRef[];
  expectedImpact: string | null;
  deltaScore: number | null;
  opensCategory: string | null;
  source: string;
  /** канал правила (cicd | appsec | null): к какому показателю относится Δ – HealthCraft Index или Repo Health Score */
  channel: string | null;
  /**
   * У правила есть файл-заготовка: `GET /api/repos/:org/:repo/fix/:ruleId`
   * отдает 200 (лицензия – с любым `?license=` из `licenses`); null – заготовки
   * нет. Необязательное ради литералов карточек в тестах; сборщик ставит всегда.
   */
  fixTemplate?: FixTemplateMeta | null;
}

export interface TruncatedValue {
  truncated: true;
  bytes: number;
  preview: string;
}

export interface TimelineAggregate {
  events: number;
  first: string | null;
  last: string | null;
  truncated: true;
}

export interface CardEvidence {
  key: string;
  category: string;
  status: string;
  source: string;
  collectedAt: string;
  value: unknown;
}

/** Доступ зрителя к каналам – для плашек UI. */
export interface CardAccess {
  cicd: ChannelAccess;
  appsec: ChannelAccess;
}

/**
 * Кто смотрит карточку – без новых запросов, из доступа, который карточка и
 * так выясняет при показе.
 * `own` – «свой» по общему правилу `isOwnRepo`: кнопка анализа есть на любом
 * своем репозитории, даже не в избранном; неизвестно (сбой, нет токена, нет
 * сессии) – не свой.
 * `auth` – отдельное поле, чтобы не трогать `ChannelAccess` (иначе `src/report`
 * без ключа писал бы «Не удалось проверить»): `no-session` – зритель без
 * сессии (аноним или сессия истекла), `no-pat` – сессия без читаемого токена,
 * `pat` – токен есть.
 */
export interface CardViewer {
  own: boolean;
  auth: "no-session" | "no-pat" | "pat";
}

/**
 * Заметка AI-описания в карточке. Привязана к скану последней генерации
 * (ai_notes пополняется на каждый скан).
 */
export interface CardAiNote {
  role: string;
  text: string;
  refs: string[];
  charterVersion: string;
  model: string;
  createdAt: string;
}

export interface CardAiFailure {
  role: string;
  reason: string;
}

export interface CardAiCheck {
  /** живая заявка проверки по репо */
  active: boolean;
  /** скан последней проверки (с флагом или отказом); null — проверок не было */
  scanId: number | null;
  /** когда проверка записана */
  checkedAt: string | null;
  /** причина языком продукта, если последняя проверка не сформировалась (ленты нет, модель, валидатор) */
  failure: string | null;
  /** проверку этого анализа можно повторить: отказ модели или валидатора (ленты нет — повторять нечего) */
  retryable: boolean;
  /** последний завершенный скан репо — проверка устарела, если он новее */
  latestScanId: number | null;
}

export interface CardAi {
  /** скан последней генерации */
  scanId: number;
  /** какая версия текста отдана – публичная (4 открытые категории) или полная */
  audience: AiAudience;
  generatedAt: string | null;
  overview: CardAiNote | null;
  specialists: CardAiNote[];
  /** роли, не прошедшие формирование, с причиной для карточки */
  failures: CardAiFailure[];
  /** живая summary-заявка – кнопка показывает «формируется» */
  jobActive: boolean;
  /** до какого времени кулдаун кнопки (Config.queue.summaryCooldownMs) */
  cooldownUntil: string | null;
  /**
   * Состояние проверки на накрутку – для кнопки «Проверить оценку» и трех
   * состояний метки: fraud = null – «не проверялось» (или отказ, failure),
   * flag false – «признаков нет», flag true – «есть признаки»
   */
  check: CardAiCheck;
  /** Флаг накрутки – подозрение для проверки человеком, Score не меняет. */
  fraud: {
    flag: boolean;
    factors: { key: string; note: string }[];
    /**
     * признаки ритма, по которым шла проверка (`activity.rhythm`, считает код),
     * из той же заметки; null у старых проверок
     */
    signals?: Record<string, unknown> | null;
    /** прочие факты входа проверки (activity.rest) из ее заметки */
    inputs?: Record<string, unknown>;
  } | null;
}

export interface RepoCard {
  repo: CardRepo;
  access: CardAccess;
  /** «свой» и причина доступа зрителя (необязательное ради литералов карточек в тестах) */
  viewer?: CardViewer;
  markers: CardMarkers;
  scan: CardScan | null;
  /** живая заявка зрителя; аноним или без заявки → null */
  job: CardJob | null;
  score: CardScore | null;
  derived: DerivedMetrics | null;
  /** AI-описание; нет (undefined), когда зрителю закрыт полный Score */
  ai?: CardAi | null;
  recommendations: CardRecommendation[];
  /**
   * «Лестница к зеленой зоне» – накопительный пересчет публичных правил «файла
   * нет» (`score/ladder.ts`) на тех же фактах, что рекомендации. Числа
   * гипотетические: считаются при чтении, не хранятся, в /api/v1 не идут.
   * null – лестницы нет (уже в зоне, нет кода, нет индекса, нечего предложить).
   * Необязательное ради литералов карточек в тестах; сборщик ставит всегда.
   */
  ladder?: Ladder | null;
  evidence: CardEvidence[];
}

/** Факты каналов с правами: не едут в ответ зрителю без доступа. */
export const CICD_KINDS = CHANNEL_KINDS.filter((k) => categoryOf(k) === "cicd");
export const APPSEC_KINDS = CHANNEL_KINDS.filter((k) => categoryOf(k) === "security");

/** Кап значения факта в ответе: форма усечения одна для всех фактов. */
const VALUE_CAP_BYTES = 4096;
const PREVIEW_CHARS = 512;

function capValue(value: unknown): unknown | TruncatedValue {
  const json = JSON.stringify(value) ?? "null";
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= VALUE_CAP_BYTES) return value;
  return { truncated: true, bytes, preview: json.slice(0, PREVIEW_CHARS) };
}

/** Сырые коммиты в ответ не едут никогда: это объем, а код и его историю мы не храним. */
function timelineAggregate(value: unknown): TimelineAggregate {
  const events = (value as { events?: { author?: { date?: string } }[] } | null)?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return { events: 0, first: null, last: null, truncated: true };
  }
  let first: string | null = null;
  let last: string | null = null;
  for (const e of events) {
    const d = e.author?.date;
    if (typeof d !== "string" || d === "") continue;
    if (first === null || d < first) first = d;
    if (last === null || d > last) last = d;
  }
  return { events: events.length, first, last, truncated: true };
}

interface RepoRow {
  id: number;
  org_slug: string;
  repo_slug: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  forks: number | null;
  last_activity_at: string | null;
  logo_url: string | null;
  language_color: string | null;
}

interface ScoreRow {
  scan_id: number;
  model_version: string;
  healthcraft_index: number | null;
  index_coverage: number;
  categories: string;
  no_data: string;
  stale: string;
  computed_at: string;
  derived: string | null;
  code_empty: number | null;
}

interface FactRow {
  key: string;
  category: string;
  value: string;
  status: string;
  source: string;
  collected_at: string;
}

interface RecRow {
  channel: string | null;
  rule_id: string;
  priority: number;
  problem: string;
  action: string;
  fact_ref: string;
  expected_impact: string | null;
  delta_score: number | null;
  opens_category: string | null;
  source: string;
}

type CardRepoRow = RepoRow & { rating_active: number; visibility: string };

function findRepoRow(db: Database, org: string, repo: string): CardRepoRow | null {
  return db
    .query(
      "SELECT id, org_slug, repo_slug, title, language, likes, forks, last_activity_at, logo_url, language_color, rating_active, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?",
    )
    .get(org, repo) as CardRepoRow | null;
}

/**
 * Публичный API и бейдж отвечают только публичному репозиторию из рейтинга.
 * Одна проверка для маршрутов `/api/v1/...` и поля карточки `repo.badge`:
 * кнопка бейджа знает ответ маршрута без пробного запроса.
 */
export function publicApiVisible(r: { visibility: string; rating_active: number }): boolean {
  return r.visibility === "public" && r.rating_active === 1;
}

/**
 * Видимость карточки: публичный из рейтинга – всем; выведенный публичный –
 * 404 всем; не публичный – только при repo = granted.
 */
function cardVisible(r: CardRepoRow, access: AccessResult): boolean {
  if (r.visibility === "public") return r.rating_active === 1;
  return access.repo === "granted";
}

/**
 * Строка оценки публичной части карточки: последний пригодный скан текущей
 * модели; у приватного репо без такого – последний не-bad (владелец видит
 * оценку своего репо). Общая для карточки и файла-заготовки
 * (`fixFileFor`), чтобы заготовка строилась на тех же фактах, что и правило.
 */
function publicScoreRow(db: Database, r: CardRepoRow): ScoreRow | null {
  const SCORE_COLS = `sc.scan_id, sc.model_version, sc.healthcraft_index, sc.index_coverage,
              sc.categories, sc.no_data, sc.stale, sc.computed_at, sc.derived, sc.code_empty`;
  const row = db
    .query(`SELECT ${SCORE_COLS} FROM scores sc WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`)
    .get(r.id, MODEL_VERSION, MODEL_VERSION) as ScoreRow | null;
  if (row || r.visibility === "public") return row;
  return db
    .query(`SELECT ${SCORE_COLS} FROM scores sc WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_NOT_BAD_SCAN_SQL}`)
    .get(r.id, MODEL_VERSION, MODEL_VERSION) as ScoreRow | null;
}

/**
 * Карточка для зрителя: проверка доступа (сеть — только у зрителя с PAT,
 * и только когда карточка вообще может быть показана) → сборка. null = 404.
 */
export async function getRepoCardForViewer(
  db: Database,
  org: string,
  repo: string,
  resolve: (repo: AccessRepo) => Promise<AccessResult>,
  opts: { limits?: ScanConfig; viewerUserId?: number; viewerAuth?: CardViewer["auth"] } = {},
): Promise<RepoCard | null> {
  const out = await resolveCardForViewer(db, org, repo, resolve, opts);
  return out.kind === "card" ? out.card : null;
}

/**
 * Исход показа карточки. Если доступ к приватному репозиторию не подтвержден
 * из-за СБОЯ SourceCraft (0/429/5xx) или отклоненного токена (401), владелец
 * с ДОКАЗАННЫМИ правами (сохраненная проверка текущего PAT или свой скан)
 * получает «проверка не удалась» / «токен отклонен». Всем прочим –
 * нейтральный 404, неотличимый от несуществующего репо.
 */
export type CardOutcome = { kind: "card"; card: RepoCard } | { kind: "not_found" } | { kind: "check_failed" } | { kind: "token_rejected" };

export async function resolveCardForViewer(
  db: Database,
  org: string,
  repo: string,
  resolve: (repo: AccessRepo) => Promise<AccessResult>,
  opts: { limits?: ScanConfig; viewerUserId?: number; viewerAuth?: CardViewer["auth"]; summaryCooldownMs?: number; provenRights?: () => boolean } = {},
): Promise<CardOutcome> {
  const r = findRepoRow(db, org, repo);
  if (!r) return { kind: "not_found" };
  // выведенный публичный – 404 всем, проверять доступ незачем
  if (r.visibility === "public" && r.rating_active !== 1) return { kind: "not_found" };
  const access = await resolve({ id: r.id, org: r.org_slug, repo: r.repo_slug, visibility: r.visibility });
  // summaryCooldownMs обязан доехать до buildCardAi, иначе карточка молча
  // возьмет дефолт и разойдется с настройкой из .env
  const card = getRepoCard(db, org, repo, { access, limits: opts.limits, viewerUserId: opts.viewerUserId, viewerAuth: opts.viewerAuth, summaryCooldownMs: opts.summaryCooldownMs });
  if (card) return { kind: "card", card };
  if (r.visibility !== "public" && (access.repo === "check-failed" || access.repo === "pat-expired") && opts.provenRights?.() === true) {
    return { kind: access.repo === "check-failed" ? "check_failed" : "token_rejected" };
  }
  return { kind: "not_found" };
}

/**
 * Карточка, собранная по доступу зрителя (по умолчанию – аноним). null –
 * репозитория нет или он не виден зрителю (404). Репо без скана – это 200.
 */
export function getRepoCard(
  db: Database,
  org: string,
  repo: string,
  /**
   * `withRank: false` – место в рейтинге не считается (rank/rankedTotal = null):
   * это два подсчета по всему каталогу, а кабинету нужны только рекомендации.
   * Остальная сборка та же, поэтому число рекомендаций равно карточке.
   */
  opts: { access?: AccessResult; limits?: ScanConfig; viewerUserId?: number; withRank?: boolean; viewerAuth?: CardViewer["auth"]; summaryCooldownMs?: number } = {},
): RepoCard | null {
  const access = opts.access ?? NO_PAT_ACCESS;
  const r = findRepoRow(db, org, repo);
  if (!r) return null;
  if (!cardVisible(r, access)) return null;
  const ciOpen = access.cicd === "granted";
  const secOpen = access.appsec === "granted";
  const cardAccess: CardAccess = { cicd: access.cicd, appsec: access.appsec };
  // «свой» – из того же доступа, что уже выяснен для показа (без новых
  // запросов); видимость – из БД
  const viewer: CardViewer = {
    own: isOwnRepo({ repo: access.repo, cicd: access.cicd, appsec: access.appsec, visibility: visibilityOf(r.visibility) }),
    auth: opts.viewerAuth ?? (opts.access ? "pat" : "no-session"),
  };

  const cardRepo: CardRepo = {
    org: r.org_slug,
    repo: r.repo_slug,
    title: r.title,
    language: r.language,
    likes: r.likes,
    forks: r.forks,
    lastActivityAt: r.last_activity_at,
    logoUrl: r.logo_url,
    languageColor: r.language_color,
    webUrl: repoWebUrl(r.org_slug, r.repo_slug),
    visibility: visibilityOf(r.visibility),
    badge: publicApiVisible(r),
  };

  // Откуда берутся данные карточки:
  //  - публичная часть (индекс, 4 категории, публичные факты и правила) – из
  //    последнего пригодного скана; у приватного репо без такого – из
  //    последнего не-bad скана (владелец видит оценку своего репо);
  //  - CI — из последнего скана, где cicd.configs и cicd.runs собраны ok
  //    (нет такого — последний с ok cicd.configs: потолок «только конфиг»);
  //    Security — из последнего скана, где ok appsec.findings и tree.stats;
  //    чужой сбойный скан их не трогает;
  //  - полный Score и Δ канальных правил — на показе из показанных данных;
  //  - блок scan — последний скан (статус без каналов и время анализа).
  const publicRow = publicScoreRow(db, r);
  const scanRow = db
    .query("SELECT id, started_at, finished_at, status, public_status, trigger, status_detail FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1")
    .get(r.id) as
    | { id: number; started_at: string; finished_at: string | null; status: string; public_status: string | null; trigger: string; status_detail: string | null }
    | null;
  // статус без учета каналов – всем
  const scan: CardScan | null = scanRow
    ? {
        id: scanRow.id,
        startedAt: scanRow.started_at,
        finishedAt: scanRow.finished_at,
        status: scanRow.public_status ?? scanRow.status,
        trigger: scanRow.trigger,
        detail: scanDetailOf(scanRow.status_detail),
      }
    : null;

  if (!publicRow) {
    // «в каталоге, еще не оценивали» – штатное состояние, не ошибка
    return {
      repo: cardRepo,
      access: cardAccess,
      viewer,
      markers: { historyTruncatedSince: null, ciConfigOnlyCap: false, staleFacts: false, codeEmpty: false, gitLimits: null },
      scan,
      job: liveViewerJob(db, org, repo, opts.viewerUserId),
      score: null,
      derived: null,
      recommendations: [],
      ladder: null,
      evidence: [],
    };
  }

  const factQuery = db.query("SELECT key, category, value, status, source, collected_at FROM facts WHERE scan_id = ?");
  const publicFacts = (factQuery.all(publicRow.scan_id) as FactRow[]).filter((f) => !CHANNEL_KINDS.includes(f.key));

  // канальные данные: каждый канал — из своего скана (см. правило выше)
  const channel = channelSources(db, r.id);
  const channelFacts = new Map<string, unknown>();
  for (const f of [...channel.cicdFacts, ...channel.securityFacts]) if (f.status === "ok") channelFacts.set(f.key, JSON.parse(f.value));
  const categoryOfFacts = (facts: Map<string, unknown>, key: "cicd" | "security"): CategoryScore =>
    computeFromFacts(facts, { scanId: 0, repoId: r.id }, new Date(publicRow.computed_at)).categories[key];
  const publicCats = JSON.parse(publicRow.categories) as Record<string, CategoryScore>;
  const shownCats = {} as Record<CategoryKey, CategoryScore>;
  for (const key of CATEGORY_ORDER) shownCats[key] = publicCats[key] ?? { score: null, submetrics: {} };
  shownCats.cicd = categoryOfFacts(channelFacts, "cicd");
  shownCats.security = categoryOfFacts(channelFacts, "security");
  // капы полного итога (секреты 49, критичные находки 69) – из фактов канала AppSec
  const capsOf = (facts: Map<string, unknown>) => totalCapFlags(facts.get("appsec.findings"));
  const codeEmpty = publicRow.code_empty === 1;
  const fullTotals = totalsFromCategories(shownCats, { codeEmpty, ...capsOf(channelFacts) });

  // закрытые зрителю каналы: ни чисел, ни подметрик, ни фактов, ни правил
  const lockOf: Partial<Record<CategoryKey, ChannelAccess>> = {};
  if (!ciOpen) lockOf.cicd = access.cicd;
  if (!secOpen) lockOf.security = access.appsec;
  const closedChannels = new Set<string>([...(ciOpen ? [] : ["cicd"]), ...(secOpen ? [] : ["appsec"])]);
  const fullOpen = ciOpen && secOpen;

  const categories = {} as Record<CategoryKey, CardCategory>;
  for (const key of CATEGORY_ORDER) {
    const locked = lockOf[key];
    categories[key] =
      locked !== undefined
        ? { score: null, submetrics: {}, locked, weight: SCORE_WEIGHTS[key] }
        : { ...shownCats[key], weight: SCORE_WEIGHTS[key] };
  }
  const stale = (JSON.parse(publicRow.stale) as string[]).filter((k) => PUBLIC_KINDS.includes(k));
  const isChannelCategory = (key: string) => CHANNEL_CATEGORIES.includes(key as CategoryKey);
  // «почему данных нет» для Security – деталь последнего no-data факта appsec
  // (например, корзина type=X недоступна после N попыток). Только ОТКРЫТОМУ
  // зрителю: причина закрытого канала – тоже данные канала.
  let securityNoDataDetail: string | null = null;
  if (secOpen && shownCats.security.score === null) {
    const lastNoData = db
      .query(
        `SELECT f.value FROM facts f JOIN scans s ON s.id = f.scan_id
         WHERE f.key = 'appsec.findings' AND f.status = 'no-data' AND s.repo_id = ?
         ORDER BY f.scan_id DESC LIMIT 1`,
      )
      .get(r.id) as { value: string } | null;
    if (lastNoData) {
      try {
        const v = JSON.parse(lastNoData.value) as { detail?: unknown };
        if (typeof v.detail === "string" && v.detail !== "") securityNoDataDetail = v.detail;
      } catch {
        /* поврежденный JSON причины – показываем без нее */
      }
    }
  }
  // Место считается ТОЛЬКО репозиторию, который сам стоит в публичном
  // рейтинге. Приватный репо имеет индекс, но в рейтинг не входит – без этой
  // проверки карточка печатала бы ему место в выборке, где его нет.
  // `ratingPlace` – общий источник места для карточки и бейджа.
  const inRating = r.visibility === "public" && r.rating_active === 1;
  const place =
    opts.withRank === false || !inRating || publicRow.healthcraft_index === null
      ? null
      : ratingPlace(db, r.org_slug, r.repo_slug, publicRow.healthcraft_index);
  // когорта – только у репо с местом (тот же набор, что у rank)
  const cohort =
    place === null
      ? null
      : repoCohort(db, { repoId: r.id, language: r.language, scanId: publicRow.scan_id, codeEmpty, index: publicRow.healthcraft_index!, categories: publicCats });

  const score: CardScore = {
    healthcraftIndex: publicRow.healthcraft_index,
    indexCoverage: publicRow.index_coverage,
    // Repo Health Score складывается из показанных категорий (тот же totalsFromCategories, что compute)
    repoHealthScore: fullOpen ? roundTotal(fullTotals.repoHealthScore) : null,
    repoHealthCoverage: fullOpen ? Math.round(fullTotals.repoHealthCoverage * 1000) / 1000 : null,
    fullLocked: !fullOpen,
    rank: place === null ? null : place.rank,
    rankedTotal: place === null ? null : place.rankedTotal,
    rankBadge: rankBadge(place),
    cohort,
    modelVersion: publicRow.model_version,
    computedAt: publicRow.computed_at,
    // причины no-data закрытых категорий — тоже данные канала (напр. «config-only cap»)
    noData: [
      ...(JSON.parse(publicRow.no_data) as string[]).filter((raw) => !isChannelCategory(raw.split(":")[0]!)),
      ...CHANNEL_CATEGORIES.filter((key) => lockOf[key] === undefined && shownCats[key].score === null).map((key) =>
        key === "security" && securityNoDataDetail !== null
          ? `security: ${shownCats.security.no_data ?? "no data"} — ${securityNoDataDetail}`
          : `${key}: ${shownCats[key].no_data ?? "no data"}`,
      ),
    ],
    stale,
    categories,
  };

  // рекомендации: публичные – сохраненные правила пригодного скана; канальные –
  // движок на показанных канальных фактах с Δ к полному Score из показанных категорий
  const recQuery = db.query(
    `SELECT rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source, channel
     FROM recommendations WHERE scan_id = ? AND model_version = ? AND channel IS NULL ORDER BY priority ASC`,
  );
  // Текст публичного правила строится по ключу при чтении: параметры – из
  // эффективных фактов ТОГО ЖЕ скана (как у движка при записи) и сохраненной
  // Δ; причина Δ = 0 восстанавливается по признакам скана. Ключ неизвестен или
  // параметр не восстановился – берется сохраненный текст.
  const scanEff = effectiveFacts(db, publicRow.scan_id, r.id);
  const scanFacts = scanEff.ok;
  const publicRecs: CardRecommendation[] = (recQuery.all(publicRow.scan_id, MODEL_VERSION) as RecRow[]).map((rec) => {
    const reason = rec.delta_score === 0 ? (publicRow.code_empty === 1 ? "code-empty" : publicRow.healthcraft_index === null ? "no-total" : null) : null;
    const texts = recommendationText(
      rec.rule_id,
      recommendationParams(rec.rule_id, scanFacts, { delta: rec.delta_score ?? undefined, reason, channel: null, issuesScore: publicCats.issues?.score ?? null, authors: authorsOf(publicCats.activity) }),
    );
    return {
      ruleId: rec.rule_id,
      kind: ruleKind(rec),
      priority: rec.priority,
      problem: texts?.problem ?? rec.problem,
      action: texts?.action ?? rec.action,
      factRefs: splitRefs(rec.fact_ref).map((key) => ({ key, missing: false })),
      expectedImpact: texts ? texts.expectedImpact : rec.expected_impact,
      deltaScore: rec.delta_score,
      opensCategory: rec.opens_category,
      source: rec.source,
      channel: rec.channel,
      // та же функция и те же факты, что у маршрута `fix`
      fixTemplate: fixTemplateOf(rec.rule_id, scanFacts),
    };
  });
  // лестница – на тех же эффективных фактах и дате (computedAt), с которыми движок
  // записал рекомендации этого скана, поэтому первый шаг равен Δ рекомендации
  const ladder = ladderFromFacts(
    scanFacts,
    { scanId: publicRow.scan_id, repoId: r.id, stale: scanEff.stale, staleCats: scanEff.staleCats, emptyRepo: scanEff.emptyRepo },
    new Date(publicRow.computed_at),
  );
  const baseFull = fullTotals.repoHealthScore;
  const channelDelta: DeltaEvaluator = (ruleChannel, patch) => {
    if (ruleChannel === null) throw new Error("card: public rules come from the eligible scan");
    const facts = new Map(channelFacts);
    patch(facts);
    const after = totalsFromCategories(
      { ...shownCats, cicd: categoryOfFacts(facts, "cicd"), security: categoryOfFacts(facts, "security") },
      { codeEmpty, ...capsOf(facts) },
    ).repoHealthScore;
    if (codeEmpty) return { delta: 0, reason: "code-empty" };
    if (baseFull === null || after === null) return { delta: 0, reason: "no-total" };
    const delta = round4(after - baseFull);
    if (delta === 0) {
      const caps = capsOf(channelFacts);
      if (caps.secretsCritical && baseFull >= SECRETS_CRITICAL_TOTAL_CAP) return { delta: 0, reason: "cap" };
      if (caps.criticalOpen && baseFull >= CRITICAL_FINDINGS_TOTAL_CAP) return { delta: 0, reason: "cap-critical" };
    }
    return { delta, reason: null };
  };
  const channelRecs: CardRecommendation[] = recommendFromFacts(channelFacts, {
    delta: channelDelta,
    issuesScore: shownCats.issues.score,
    only: "channel",
    codeEmpty,
    // скор-правила каналов – только у показанной оцененной категории
    categoryScores: Object.fromEntries(CATEGORY_ORDER.map((k) => [k, shownCats[k].score])),
  })
    .filter((rec) => rec.channel !== null && !closedChannels.has(rec.channel))
    .map((rec) => {
      // Δ канального правила – числом только при доступе к обоим каналам (как
      // полный Score): иначе число и причины (кап 49) раскрывали бы Security
      const hidden = rec.kind === "presence" && !fullOpen;
      return {
        ruleId: rec.ruleId,
        kind: rec.kind,
        priority: rec.priority,
        problem: rec.problem,
        action: rec.action,
        factRefs: rec.factRefs.map((key) => ({ key, missing: false })),
        expectedImpact: hidden ? CHANNEL_DELTA_HIDDEN_TEXT : rec.expectedImpact,
        deltaScore: hidden ? null : rec.deltaScore,
        opensCategory: rec.opensCategory,
        source: "rule",
        channel: rec.channel,
        fixTemplate: null,
      };
    });
  // общая выдача – в порядке движка, номера 1..N после фильтра
  const recommendations = orderRecommendations(publicRecs, channelRecs);

  // Плотность Security считается по `tree.stats` канального скана, и этот факт
  // должен быть в доказательствах. Но заменять им публичный `tree.stats`
  // нельзя: тот кормит публичные `derived` пригодного скана, и подмена дала бы
  // число из одного скана с доказательством из другого, да еще в зависимости
  // от прав зрителя. Поэтому дерево канального скана едет СВОИМ ключом
  // `tree.stats@channel` (см. CHANNEL_TREE_KEY) и зрителю без прав на Security
  // не отдается, как любое канальное доказательство.
  const shownChannelFacts = [...(ciOpen ? channel.cicdFacts : []), ...(secOpen ? channel.securityFacts : [])].map((f) =>
    f.key === "tree.stats" ? { ...f, key: CHANNEL_TREE_KEY } : f,
  );
  const factRows = [...publicFacts, ...shownChannelFacts];
  const factByKey = new Map(factRows.map((f) => [f.key, f]));
  // missing = факта нет по построению (публичный appsec.findings) – UI объясняет причину
  for (const rec of recommendations) for (const ref of rec.factRefs) ref.missing = !factByKey.has(ref.key);

  // адресуемые факты: те, на которые ссылаются рекомендации, те, что читает
  // compute, и справочные (DISPLAY_KINDS); сырье остальных в ответ не едет
  const refKeys = recommendations.flatMap((rec) => rec.factRefs.map((ref) => ref.key));
  const addressable = new Set<string>([...refKeys, ...PUBLIC_KINDS, ...CHANNEL_KINDS, ...DISPLAY_KINDS, CHANNEL_TREE_KEY]);
  const evidence: CardEvidence[] = factRows
    .filter((f) => addressable.has(f.key))
    .map((f) => {
      const raw = parseFactValue(f.value) as unknown;
      // у старых фактов в `detail` бывает путь временного клона
      const detail = (raw as { detail?: unknown } | null)?.detail;
      const parsed = typeof detail === "string" ? { ...(raw as object), detail: scrubDetail(detail) } : raw;
      const value = f.key === "activity.git.timeline" ? timelineAggregate(parsed) : capValue(parsed);
      return { key: f.key, category: f.category, status: f.status, source: f.source, collectedAt: f.collected_at, value };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const summary = factByKey.get("activity.git.summary");
  const summaryValue = summary && summary.status === "ok" ? (parseFactValue(summary.value) as { history_truncated_since?: unknown }) : null;
  const cicdNoData = categories.cicd.no_data ?? "";
  const markers: CardMarkers = {
    historyTruncatedSince: typeof summaryValue?.history_truncated_since === "string" ? summaryValue.history_truncated_since : null,
    // маркер показанной CI-категории
    ciConfigOnlyCap: ciOpen && cicdNoData.includes("прогоны не видны"),
    staleFacts: stale.length > 0,
    codeEmpty,
    gitLimits: gitLimitsHit(publicFacts) ? gitLimitsOf(opts.limits ?? DEFAULT_SCAN) : null,
  };

  // Зритель с полным Score видит полный AI-текст; зритель без него у
  // публичного репо – публичную версию (только открытые категории); у
  // закрытого репо без полных прав AI нет (undefined)
  const aiAudiences: AiAudience[] = fullOpen ? (r.visibility === "public" ? ["full", "public"] : ["full"]) : r.visibility === "public" ? ["public"] : [];
  // кнопка «Сформировать/Обновить» показывает состояние той версии, которую
  // поставит сервер (POST /summary): свой с полными правами – полная, иначе публичная
  const runAudience: AiAudience = viewer.own && fullOpen ? "full" : "public";
  const ai = aiAudiences.length > 0 ? buildCardAi(db, r.id, opts.viewerUserId, summaryCooldownMsOf(opts), aiAudiences, runAudience) : undefined;

  return {
    repo: cardRepo,
    access: cardAccess,
    viewer,
    markers,
    scan,
    job: liveViewerJob(db, org, repo, opts.viewerUserId),
    score,
    derived: publicRow.derived === null ? null : (JSON.parse(publicRow.derived) as DerivedMetrics),
    ai,
    recommendations,
    ladder,
    evidence,
  };
}

/**
 * Файл-заготовка правила для зрителя карточки. Вход – карточка, уже собранная
 * для этого зрителя, так что приватный репо без прав сюда не доходит. null –
 * правило у репозитория сейчас не срабатывает или заготовки у него нет:
 * шаблон «на всякий случай» не отдается. Содержимое – на эффективных фактах
 * того же скана, что и карточка.
 */
export function fixFileFor(db: Database, card: RepoCard, ruleId: FixRuleId, opts: { license?: LicenseId; now?: Date } = {}): FixFile | null {
  if (!card.recommendations.some((rec) => rec.ruleId === ruleId && rec.fixTemplate != null)) return null;
  const r = findRepoRow(db, card.repo.org, card.repo.repo);
  const row = r ? publicScoreRow(db, r) : null;
  if (!r || !row) return null;
  return templateFor(ruleId, effectiveFacts(db, row.scan_id, r.id).ok, { org: r.org_slug, repo: r.repo_slug, title: r.title }, opts);
}

const AI_DEFAULT_COOLDOWN_MS = 60 * 60_000;

function summaryCooldownMsOf(opts: { summaryCooldownMs?: number }): number {
  return opts.summaryCooldownMs ?? AI_DEFAULT_COOLDOWN_MS;
}

/**
 * Последняя генерация AI-текста репо и состояние кнопки. `audiences` – какие
 * версии текста зрителю открыты, в порядке предпочтения: зрителю с полным
 * Score – полная, если ее нет – публичная (у публичного репо); остальным –
 * только публичная. Обзор и проверка на накрутку – разные заявки, у каждой
 * свой последний скан.
 */
function buildCardAi(
  db: Database,
  repoId: number,
  viewerUserId: number | undefined,
  cooldownMs: number,
  audiences: readonly AiAudience[],
  runAudience: AiAudience,
): CardAi {
  const lastOf = (a: AiAudience): number | null =>
    (db.query("SELECT MAX(scan_id) AS s FROM ai_notes WHERE repo_id = ? AND role != 'flagger' AND audience = ?").get(repoId, a) as { s: number | null }).s;
  const audience = audiences.find((a) => lastOf(a) !== null) ?? audiences[0]!;
  const lastScan = lastOf(audience);
  // bun:sqlite .get() при пустом результате возвращает null, а не undefined
  const jobActive =
    (db.query("SELECT 1 AS x FROM jobs WHERE repo_id = ? AND kind = 'summary' AND audience = ? AND status IN ('queued', 'running') LIMIT 1").get(repoId, runAudience) as { x: number } | null) !== null;
  const lastJobAt = (db.query("SELECT MAX(created_at) AS t FROM jobs WHERE repo_id = ? AND kind = 'summary' AND audience = ?").get(repoId, runAudience) as { t: string | null }).t;
  const cooldownUntil = lastJobAt === null ? null : new Date(Date.parse(lastJobAt) + cooldownMs).toISOString();
  const fraud = fraudOf(db, repoId);
  const check = checkOf(db, repoId);
  if (lastScan === null) {
    return { scanId: 0, audience, generatedAt: null, overview: null, specialists: [], failures: [], jobActive, cooldownUntil, check, fraud };
  }
  // отказ проверки на накрутку (отдельная заявка) – не отказ обзора. Наружу –
  // причина языком продукта; технический текст (тело ответа провайдера,
  // фрагменты валидатора) остается в ai_fails для оператора
  const fails = (
    db
      .query("SELECT role, reason FROM ai_fails WHERE scan_id = ? AND role != 'flagger' AND audience = ? ORDER BY id")
      .all(lastScan, audience) as { role: string; reason: string }[]
  ).map((f) => ({ role: f.role, reason: aiFailureText(f.reason) }));
  const noteRows = db
    .query("SELECT role, text, fact_refs, charter_version, model, created_at FROM ai_notes WHERE repo_id = ? AND scan_id = ? AND role != 'flagger' AND audience = ? ORDER BY id")
    .all(repoId, lastScan, audience) as { role: string; text: string; fact_refs: string; charter_version: string; model: string; created_at: string }[];
  const toNote = (r: (typeof noteRows)[number]): CardAiNote => ({
    role: r.role,
    text: r.text,
    refs: (JSON.parse(r.fact_refs) as string[]) ?? [],
    charterVersion: r.charter_version,
    model: r.model,
    createdAt: r.created_at,
  });
  const overview = noteRows.find((r) => r.role === "overview");
  const specialists = noteRows.filter((r) => r.role !== "overview").map(toNote);
  const generatedAt = noteRows.reduce((acc, r) => (r.created_at > (acc ?? "") ? r.created_at : acc), null as string | null);
  return {
    scanId: lastScan,
    audience,
    generatedAt,
    overview: overview ? toNote(overview) : null,
    specialists,
    failures: fails,
    jobActive,
    cooldownUntil,
    check,
    fraud,
  };
}

// ---------- место в рейтинге и когорта похожих ----------

/**
 * Место и положение индекса в выборке рейтинга: `rank` – позиция строки
 * (равные – по org/repo), `above`/`atOrAbove` – репо со строго большим и с не
 * меньшим индексом (для значка места, `rank-badge.ts`).
 */
export interface RatingPlace {
  rank: number;
  rankedTotal: number;
  above: number;
  atOrAbove: number;
}

/**
 * Место репо в публичном рейтинге по HealthCraft Index и размер выборки –
 * один источник для карточки (`score.rank`) и бейджа со значком места.
 * Вызывающий гарантирует, что репо сам стоит в наборе рейтинга (публичный,
 * rating_active, `index` – индекс его последнего пригодного скана).
 *
 * Считается одним проходом: «последний пригодный скан» – один раз на репо
 * (GROUP BY), выше/всего – одной агрегацией, равные – списком слагов (их
 * единицы). Коррелированный подзапрос на строку стоил ~1 с на карточку при
 * 28 тыс. репо. Набор и порядок те же, что у RATING_SQL, поэтому место равно
 * позиции строки рейтинга.
 */
export function ratingPlace(db: Database, org: string, repo: string, index: number): RatingPlace | null {
  const ranking = db
    .query(
      `WITH last AS (
         SELECT sc2.repo_id, MAX(sc2.scan_id) AS scan_id FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
         WHERE sc2.model_version = ? AND s2.rating_eligible = 1 GROUP BY sc2.repo_id)
       SELECT COALESCE(SUM(sc.healthcraft_index > ?), 0) AS above,
              COUNT(sc.healthcraft_index) AS scored,
              GROUP_CONCAT(CASE WHEN sc.healthcraft_index = ? THEN r.org_slug || '/' || r.repo_slug END, char(10)) AS ties
       FROM last
       JOIN scores sc ON sc.scan_id = last.scan_id AND sc.model_version = ?
       JOIN repos r ON r.id = last.repo_id
       WHERE r.rating_active = 1 AND r.visibility = 'public'`,
    )
    .get(MODEL_VERSION, index, index, MODEL_VERSION) as { above: number; scored: number; ties: string | null } | null;
  if (ranking === null) return null;
  // при РАВНЫХ индексах рейтинг упорядочивает строки по org/repo (compareItems);
  // место на карточке считается тем же правилом, иначе разошлось бы с позицией строки
  const ties = ranking.ties === null ? [] : ranking.ties.split("\n");
  const tiesBefore = ties.filter((t) => t.localeCompare(`${org}/${repo}`) < 0).length;
  return {
    rank: ranking.above + tiesBefore + 1,
    rankedTotal: ranking.scored,
    above: ranking.above,
    // равные – включая сам репо (он в наборе по условию вызова)
    atOrAbove: ranking.above + Math.max(ties.length, 1),
  };
}

/**
 * Память баллов 4 категорий по scan_id, на соединение БД, как у фактов
 * фильтров. Строка `scores` неизменна по (scan_id, MODEL_VERSION), поэтому
 * запомненное не устаревает, а новый скан приходит с новым scan_id.
 * `json_extract` из категорий – около половины цены запроса когорты; с
 * памятью его платит только первая карточка когорты.
 */
const cohortCatsMemo = new WeakMap<Database, Map<number, (number | null)[]>>();
/** Сброс памяти при разрастании (каталог ~28 тыс. сканов в рейтинге). */
const COHORT_CATS_MEMO_CAP = 200_000;

interface CohortRow {
  scan_id: number;
  idx: number;
  code_empty: number | null;
}

/**
 * Когорта похожих (определение – `cohort.ts`): публичные репо с местом в
 * рейтинге (тот же набор, что RATING_SQL и `ratingPlace`) того же языка и той
 * же корзины размера, без самого репо. Считается на чтении: SQL по языку
 * (индекс `idx_repos_language`), корзина – из фактов `tree.stats` через
 * память `scanFilterFacts` (общую с рейтингом), а баллы категорий достаются
 * вторым шагом только у отобранных по корзине.
 * Производной таблицы нет: ее пришлось бы заполнять конвейером оценки, и до
 * заполнения у всех карточек была бы «нет когорты».
 */
export function repoCohort(
  db: Database,
  self: { repoId: number; language: string | null; scanId: number; codeEmpty: boolean; index: number; categories: Record<string, { score: number | null } | undefined> },
): RepoCohort {
  const selfCats = {} as Record<IndexCategoryKey, number | null>;
  for (const key of COHORT_CATEGORIES) selfCats[key] = self.categories[key]?.score ?? null;
  const loc = scanFilterFacts(db, [self.scanId], { prune: false }).get(self.scanId)?.loc ?? null;
  const sizeBucket = sizeBucketOf(self.codeEmpty, loc);
  const cohortSelf = { language: self.language, sizeBucket, codeEmpty: self.codeEmpty, index: self.index, categories: selfCats };
  // без кода, без языка или размера — когорта не строится (buildCohort назовет причину)
  if (self.codeEmpty || self.language === null || sizeBucket === null) return buildCohort(cohortSelf, []);
  const rows = db
    .query(
      `WITH last AS (
         SELECT sc2.repo_id, MAX(sc2.scan_id) AS scan_id FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
         WHERE sc2.model_version = ? AND s2.rating_eligible = 1
           AND sc2.repo_id IN (SELECT id FROM repos WHERE language = ? AND rating_active = 1 AND visibility = 'public' AND id <> ?)
         GROUP BY sc2.repo_id)
       SELECT last.scan_id, sc.healthcraft_index AS idx, sc.code_empty
       FROM last JOIN scores sc ON sc.scan_id = last.scan_id AND sc.model_version = ?
       WHERE sc.healthcraft_index IS NOT NULL`,
    )
    .all(MODEL_VERSION, self.language, self.repoId, MODEL_VERSION) as CohortRow[];
  const facts = scanFilterFacts(db, rows.map((row) => row.scan_id), { prune: false });
  const inBucket = rows.filter((row) => sizeBucketOf(row.code_empty === 1, facts.get(row.scan_id)?.loc ?? null) === sizeBucket);
  let cats = cohortCatsMemo.get(db);
  if (cats === undefined || cats.size > COHORT_CATS_MEMO_CAP) {
    cats = new Map();
    cohortCatsMemo.set(db, cats);
  }
  const missing = inBucket.filter((row) => !cats!.has(row.scan_id));
  for (let i = 0; i < missing.length; i += FILTER_FACTS_CHUNK) {
    const chunk = missing.slice(i, i + FILTER_FACTS_CHUNK).map((row) => row.scan_id);
    for (const id of chunk) cats.set(id, [null, null, null, null]);
    const got = db
      .query(
        `SELECT scan_id, CASE WHEN json_valid(categories)
                  THEN json_extract(categories, '$.documentation.score', '$.activity.score', '$.issues.score', '$.code.score') END AS j
         FROM scores WHERE model_version = ? AND scan_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(MODEL_VERSION, ...chunk) as { scan_id: number; j: string | null }[];
    for (const row of got) {
      let parsed: unknown = null;
      try {
        parsed = row.j === null ? null : JSON.parse(row.j);
      } catch {
        /* битый JSON категорий — баллов нет (незнание), индекс остается */
      }
      if (Array.isArray(parsed)) cats.set(row.scan_id, parsed.map((v) => (typeof v === "number" ? v : null)));
    }
  }
  const members: CohortMember[] = inBucket.map((row) => {
    const c = cats.get(row.scan_id) ?? [null, null, null, null];
    return { index: row.idx, categories: { documentation: c[0] ?? null, activity: c[1] ?? null, issues: c[2] ?? null, code: c[3] ?? null } };
  });
  return buildCohort(cohortSelf, members);
}

/** Состояние проверки на накрутку: живая заявка, последняя проверка или ее отказ. */
function checkOf(db: Database, repoId: number): CardAiCheck {
  const active = db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = 'check' AND status IN ('queued', 'running') LIMIT 1").get(repoId) !== null;
  const note = db
    .query("SELECT scan_id, created_at FROM ai_notes WHERE repo_id = ? AND role = 'flagger' ORDER BY scan_id DESC, id DESC LIMIT 1")
    .get(repoId) as { scan_id: number; created_at: string } | null;
  const fail = db
    .query("SELECT scan_id, reason, created_at FROM ai_fails WHERE repo_id = ? AND role = 'flagger' ORDER BY scan_id DESC, id DESC LIMIT 1")
    .get(repoId) as { scan_id: number; reason: string; created_at: string } | null;
  const latest = db.query("SELECT id FROM scans WHERE repo_id = ? AND status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1").get(repoId) as { id: number } | null;
  // отказ показывается, только если он новее последней записанной проверки
  const failNewer = fail !== null && (note === null || fail.scan_id > note.scan_id || (fail.scan_id === note.scan_id && fail.created_at > note.created_at));
  return {
    active,
    scanId: failNewer ? fail!.scan_id : (note?.scan_id ?? null),
    checkedAt: failNewer ? fail!.created_at : (note?.created_at ?? null),
    failure: failNewer ? checkFailureText(fail!.reason) : null,
    retryable: failNewer && fail!.reason !== NO_RHYTHM_REASON,
    latestScanId: latest?.id ?? null,
  };
}

/**
 * Причина несформированного блока AI-обзора языком продукта. Пропуски из-за
 * данных («нет фактов…», «нет точек…») отдаются как есть – по ним карточка
 * отличает «не было данных» от отказа.
 */
export function aiFailureText(reason: string): string {
  if (reason.startsWith("нет ")) return reason;
  if (reason.startsWith("модель:")) return "AI-провайдер не ответил";
  if (reason.startsWith("отказ модели")) return "AI-провайдер отказался писать об этом репозитории (фильтр безопасности модели)";
  if (reason.startsWith("валидатор:")) return "текст не прошел проверку фактами";
  return "блок не сформирован";
}

/**
 * Причина отказа проверки языком продукта: ai_fails хранит технический текст
 * («модель: сеть: …», «валидатор: …») — на карточку он не выводится.
 */
export function checkFailureText(reason: string): string {
  if (reason === NO_RHYTHM_REASON) return "в анализе нет истории коммитов – проверять нечего";
  if (reason.startsWith("модель:")) return "AI-провайдер не ответил – попробуйте позже";
  return "ответ модели не прошел проверку фактами – можно повторить";
}

/**
 * Разбор заметки flagger – общий для карточки (fraudOf) и строки рейтинга.
 * Невалидная форма (битый JSON, flag не boolean, factors не массив) – флага
 * нет, а не флаг есть.
 */
function parseFlaggerNote(text: string): { flag: boolean; factors: unknown[]; signals: unknown; inputs: unknown } | null {
  try {
    const parsed = JSON.parse(text) as { flag?: unknown; factors?: unknown; signals?: unknown; inputs?: unknown };
    if (typeof parsed.flag !== "boolean" || !Array.isArray(parsed.factors)) return null;
    return { flag: parsed.flag, factors: parsed.factors, signals: parsed.signals, inputs: parsed.inputs };
  } catch {
    return null;
  }
}

/**
 * Флаг накрутки – последняя проверка по репо (заметка flagger). Вход
 * проверки – публичные данные активности, поэтому метку видят все, кому видна
 * карточка.
 */
function fraudOf(db: Database, repoId: number): CardAi["fraud"] {
  const row = db
    .query("SELECT text FROM ai_notes WHERE repo_id = ? AND role = 'flagger' ORDER BY scan_id DESC, id DESC LIMIT 1")
    .get(repoId) as { text: string } | null;
  if (row === null) return null;
  const parsed = parseFlaggerNote(row.text);
  if (parsed === null) return null;
  return {
    flag: parsed.flag,
    signals: parsed.signals !== null && typeof parsed.signals === "object" ? (parsed.signals as Record<string, unknown>) : null,
    inputs: parsed.inputs !== null && typeof parsed.inputs === "object" ? (parsed.inputs as Record<string, unknown>) : {},
    factors: parsed.factors
      .filter((f): f is { key: string; note: string } => {
        const item = f as { key?: unknown; note?: unknown };
        return typeof item.key === "string" && typeof item.note === "string";
      })
      .slice(0, 8),
  };
}

/** Живая заявка на СКАН именно этого зрителя (queued/running): AI-заявки (обзор,
 *  проверка) анализом не являются. */
function liveViewerJob(db: Database, org: string, repo: string, viewerUserId: number | undefined): CardJob | null {
  if (viewerUserId === undefined) return null;
  const row = db
    .query(
      `SELECT j.status, j.lease_until FROM jobs j JOIN repos r ON r.id = j.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND j.user_id = ? AND j.kind = 'scan' AND j.status IN ('queued','running')
       ORDER BY j.id DESC LIMIT 1`,
    )
    .get(org, repo, viewerUserId) as { status: string; lease_until: string | null } | null;
  if (!row) return null;
  const running = row.status === "running";
  return { status: running ? "running" : "queued", stalled: running && jobLeaseExpired(row.lease_until) };
}

/** Лиз `running`-задания истек. Нет лиза у running – тоже истек: живой воркер его держит. */
export function jobLeaseExpired(leaseUntil: string | null, now = Date.now()): boolean {
  if (leaseUntil === null) return true;
  const t = Date.parse(leaseUntil);
  return !Number.isFinite(t) || t < now;
}

/** Текст канального presence-правила без числа: Δ Repo Health Score виден только при доступе к CI и Security. */
export const CHANNEL_DELTA_HIDDEN_TEXT = "повысит балл категории «CI/CD»; насколько вырастет Repo Health Score, видно при доступе к CI/CD и Безопасности";

// то же правило округления, что у расчета, отчета и рейтинга
const roundTotal = (x: number | null): number | null => (x === null ? null : roundScore(x));
const splitRefs = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * Источники канальных данных карточки: CI – последний скан с ok cicd.configs
 * и ok cicd.runs, иначе последний с ok cicd.configs (потолок «только конфиг»);
 * Security – последний скан с ok appsec.findings и ok tree.stats.
 * Возвращаются факты этих kinds выбранного скана (в расчет идут только ok;
 * не-ok cicd.runs скана «только конфиг» – доказательство потолка).
 */
export function channelSources(db: Database, repoId: number): { cicdScanId: number | null; securityScanId: number | null; cicdFacts: FactRow[]; securityFacts: FactRow[] } {
  const okIn = (kind: string) => `EXISTS (SELECT 1 FROM facts f WHERE f.scan_id = s.id AND f.key = '${kind}' AND f.status = 'ok')`;
  // источник канала – только ЗАВЕРШЕННЫЙ не-bad скан: `running` еще пишет
  // факты, а `bad` (shutdown, orphaned, score_failed, сбой сбора) – не доказательство
  const lastScan = (cond: string) =>
    (db.query(`SELECT s.id FROM scans s WHERE s.repo_id = ? AND s.status NOT IN ('running', 'queued', 'bad') AND ${cond} ORDER BY s.id DESC LIMIT 1`).get(repoId) as { id: number } | null)?.id ?? null;
  const cicdScanId = lastScan(`${okIn("cicd.configs")} AND ${okIn("cicd.runs")}`) ?? lastScan(okIn("cicd.configs"));
  const securityScanId = lastScan(`${okIn("appsec.findings")} AND ${okIn("tree.stats")}`);
  const okFacts = (scanId: number | null, kinds: string[]) =>
    scanId === null
      ? []
      : (db
          .query(`SELECT key, category, value, status, source, collected_at FROM facts WHERE scan_id = ? AND key IN (${kinds.map(() => "?").join(", ")})`)
          .all(scanId, ...kinds) as FactRow[]);
  return {
    cicdScanId,
    securityScanId,
    cicdFacts: okFacts(cicdScanId, CICD_KINDS),
    securityFacts: okFacts(securityScanId, [...APPSEC_KINDS, "tree.stats"]),
  };
}

/** Git-канал уперся в лимиты: git-факт со статусом no-data и reason=limits.
 *  Через parseFactValue, а не сырой JSON.parse: старые сжатые значения
 *  (no-data timeline) иначе роняли бы карточку и MD в 500. */
function gitLimitsHit(facts: FactRow[]): boolean {
  return facts.some((f) => f.source === "git" && f.status === "no-data" && (parseFactValue(f.value) as { reason?: unknown }).reason === "limits");
}

function gitLimitsOf(scan: ScanConfig): GitLimitsMarker {
  return {
    cloneMaxBytes: scan.clone.maxBytes,
    cloneTimeoutMs: scan.clone.timeoutMs,
    degradeEnabled: scan.degrade.enabled,
    degradeSinceMonths: scan.degrade.sinceMonths,
    degradeMaxBytes: scan.degrade.maxBytes,
    degradeTimeoutMs: scan.degrade.timeoutMs,
  };
}

/** Вид правила в БД не хранится — он однозначно восстановим по полям. */
function ruleKind(rec: RecRow): CardRecommendation["kind"] {
  if (rec.delta_score !== null) return "presence";
  if (rec.opens_category !== null) return "activation";
  return "score";
}

// ---------- мета ----------

export interface MetaResponse {
  modelVersion: string;
  /** веса категории в двух показателях: indexWeight (HealthCraft Index; у CI/Security null – их там нет) и scoreWeight (Repo Health Score) */
  categories: { key: CategoryKey; title: string; indexWeight: number | null; scoreWeight: number }[];
  /** имя публичного показателя (рейтинг сортирует по нему) */
  publicMetricTitle: "HealthCraft Index";
  /** имя полного показателя (карточка с правами, кап 49) */
  fullMetricTitle: "Repo Health Score";
  coverageNullBelow: number;
  /**
   * Охват каталога. `scored` и `nullScore` – репозитории, по которым УЖЕ есть
   * строка `scores` текущей модели; `catalog` – сколько всего публичных
   * репозиториев в рейтинговом каталоге. Без `catalog` страница, пока идет
   * первый обход, показывала бы почти полный охват («оценено 4964 из 4969»).
   */
  repos: { scored: number; nullScore: number; catalog: number };
  /** лиз задания из конфига – UI опрашивает анализ до этого горизонта */
  queue: { leaseMs: number };
  methodology: string;
  /** публичный адрес сервиса – для абсолютного кода бейджа в README */
  publicBaseUrl: string;
  generatedAt: string;
}

export function getMeta(db: Database, opts: { now?: Date; leaseMs?: number; publicBaseUrl?: string } = {}): MetaResponse {
  // счетчики – легким запросом по тому же набору, что рейтинг, без его строк
  const counts = db
    .query(
      `WITH last AS (
         SELECT sc2.repo_id, MAX(sc2.scan_id) AS scan_id FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
         WHERE sc2.model_version = ? AND s2.rating_eligible = 1 GROUP BY sc2.repo_id)
       SELECT COUNT(sc.healthcraft_index) AS scored, COALESCE(SUM(sc.healthcraft_index IS NULL), 0) AS nullScore
       FROM last
       JOIN scores sc ON sc.scan_id = last.scan_id AND sc.model_version = ?
       JOIN repos r ON r.id = last.repo_id
       WHERE r.rating_active = 1 AND r.visibility = 'public'`,
    )
    .get(MODEL_VERSION, MODEL_VERSION) as { scored: number; nullScore: number };
  return {
    modelVersion: MODEL_VERSION,
    categories: CATEGORY_ORDER.map((key) => ({
      key,
      title: CATEGORY_TITLES[key],
      indexWeight: INDEX_WEIGHTS[key as IndexCategoryKey] ?? null,
      scoreWeight: SCORE_WEIGHTS[key],
    })),
    publicMetricTitle: "HealthCraft Index",
    fullMetricTitle: "Repo Health Score",
    coverageNullBelow: COVERAGE_NULL_BELOW,
    repos: {
      scored: counts.scored,
      nullScore: counts.nullScore,
      // тот же фильтр, что у RATING_SQL (rating_active + public), но без
      // JOIN на scores: знаменатель охвата – каталог, а не оцененная часть
      catalog: (db.query("SELECT COUNT(*) AS c FROM repos WHERE rating_active = 1 AND visibility = 'public'").get() as { c: number }).c,
    },
    queue: { leaseMs: opts.leaseMs ?? defaultLeaseMs(DEFAULT_SCAN) },
    methodology: METHODOLOGY_PATH,
    publicBaseUrl: opts.publicBaseUrl ?? "http://localhost:8418",
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

// ---------- статус AI-заявок для опроса страницы ----------

/** Ответ `GET /api/repos/:org/:repo/ai-status` – живые AI-заявки репозитория. */
export interface AiJobStatus {
  /** идет формирование обзора (любая аудитория) */
  summaryActive: boolean;
  /** идет проверка на накрутку */
  checkActive: boolean;
}

/**
 * Легкий статус без проверки прав и без списания «открытий карточки»: страница
 * опрашивает его, пока заявка идет, и перечитывает карточку один раз, когда
 * заявка закончилась. Два индексных запроса к `jobs`, ни одного обращения к
 * SourceCraft. Чтобы не выдавать чужие приватные репозитории, для непубличного
 * репо видны только заявки самого зрителя; неизвестный репо неотличим от тихого.
 */
export function getAiJobStatus(db: Database, org: string, repo: string, viewerUserId: number | null): AiJobStatus {
  const quiet: AiJobStatus = { summaryActive: false, checkActive: false };
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
  if (row === null) return quiet;
  const own = row.visibility !== "public";
  if (own && viewerUserId === null) return quiet;
  const active = (kind: "summary" | "check"): boolean =>
    (own
      ? db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = ? AND user_id = ? AND status IN ('queued', 'running') LIMIT 1").get(row.id, kind, viewerUserId)
      : db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = ? AND status IN ('queued', 'running') LIMIT 1").get(row.id, kind)) !== null;
  return { summaryActive: active("summary"), checkActive: active("check") };
}
