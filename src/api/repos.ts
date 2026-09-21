// repos.ts — read-API В3: чистые функции чтения БД (рейтинг, карточка,
// мета). Сети нет и быть не может — UI живёт на том, что уже посчитал
// скан. Сортировка/фильтрация/пагинация/фасеты считаются здесь, а не на
// клиенте (решение канвы «г»): рейтинг сразу является контрактом данных.
// Tri-state (закон 2): Score = NULL не участвует в ранжировании вообще —
// такие репо уезжают в отдельный массив, иначе «нет данных» оказалось бы
// лучшим или худшим результатом в зависимости от направления сортировки.
import type { Database } from "bun:sqlite";
import { CHANNEL_KINDS, PUBLIC_KINDS, computeFromFacts, totalsFromCategories, type CategoryScore } from "../score/compute";
import { orderRecommendations, recommendFromFacts, round4, type DeltaEvaluator } from "../score/recommend";
import { categoryOf, parseFactValue } from "../collectors/facts";
import { NO_PAT_ACCESS, type AccessRepo, type AccessResult, type ChannelAccess } from "../auth/access";
import { DEFAULT_SCAN, defaultLeaseMs, type ScanConfig } from "../config";
import type { GitLimitsMarker } from "../web/format";
import type { DerivedMetrics } from "../score/derived";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, COVERAGE_NULL_BELOW, type CategoryKey, type IndexCategoryKey, MODEL_VERSION, SECRETS_CRITICAL_TOTAL_CAP } from "../score/model";

// ---------- общие формы ----------

export const CATEGORY_TITLES: Record<CategoryKey, string> = {
  documentation: "Документация",
  cicd: "CI/CD",
  security: "Security",
  activity: "Активность",
  issues: "Issues",
  code: "Code health",
};

/** Порядок категорий на всех поверхностях — вес модели, затем ключ. */
export const CATEGORY_ORDER: CategoryKey[] = ["documentation", "cicd", "security", "activity", "issues", "code"];

/** Путь к методике в репозитории (строка, не URL): футер и MD ссылаются сюда. */
export const METHODOLOGY_PATH = "reports/2026-09-15-m2-methodology-draft.md";

export interface ApiError {
  error: { code: "bad_query" | "not_found"; message: string };
}

export interface RatingItem {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  /** HealthCraft Index (4 категории, сохранённый healthcraft_index) */
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
  /** часть фактов взята из истории при сбое канала (§5.6) — НЕ «давность скана» */
  staleFacts: boolean;
  modelVersion: string;
}

export interface LanguageFacet {
  language: string | null;
  count: number;
}

export interface RatingResponse {
  items: RatingItem[];
  /** HealthCraft Index = NULL: вне ранжирования и вне пагинации (закон 2) */
  nullItems: RatingItem[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  nulls: number;
  facets: { languages: LanguageFacet[] };
  generatedAt: string;
}

export type SortKey = "index" | "likes" | "activity" | "coverage" | "name";
export type SortOrder = "desc" | "asc";

export interface ReposQuery {
  sort: SortKey;
  order: SortOrder;
  /** undefined = фильтра нет; null = «язык не определён» (lang= пустым) */
  lang?: string | null;
  q?: string;
  page: number;
  perPage: number;
}

const SORT_KEYS: SortKey[] = ["index", "likes", "activity", "coverage", "name"];

/**
 * В4.6 (У21, решение владельца 20.09): страница 20, а не 25. После
 * уплотнения строки до 46px при 1440 видно 17 строк — страница из 20
 * обозрима почти целиком, и пагинация перестаёт обещать то, чего не видно
 * (при 25 видно было 14 из 25). Список опций в UI обязан содержать 20.
 */
export const DEFAULT_QUERY: ReposQuery = { sort: "index", order: "desc", page: 1, perPage: 20 };

export type ParseResult = { ok: true; query: ReposQuery } | { ok: false; message: string };

/**
 * Неизвестный параметр игнорируется, неверное ЗНАЧЕНИЕ известного — 400:
 * тихо показать не то, что просили, хуже явной ошибки.
 */
export function parseReposQuery(params: URLSearchParams): ParseResult {
  const query: ReposQuery = { ...DEFAULT_QUERY };

  const sort = params.get("sort");
  if (sort !== null) {
    if (!SORT_KEYS.includes(sort as SortKey)) {
      return { ok: false, message: `sort: ожидается одно из ${SORT_KEYS.join("|")}, получено "${sort}"` };
    }
    query.sort = sort as SortKey;
  }

  const order = params.get("order");
  if (order !== null) {
    if (order !== "desc" && order !== "asc") {
      return { ok: false, message: `order: ожидается desc|asc, получено "${order}"` };
    }
    query.order = order;
  }

  if (params.has("lang")) {
    const lang = params.get("lang")!;
    query.lang = lang === "" ? null : lang;
  }

  if (params.has("q")) {
    const q = params.get("q")!;
    if (q !== "") query.q = q;
  }

  const page = params.get("page");
  if (page !== null) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) return { ok: false, message: `page: ожидается целое ≥ 1, получено "${page}"` };
    query.page = n;
  }

  const perPage = params.get("per_page");
  if (perPage !== null) {
    const n = Number(perPage);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return { ok: false, message: `per_page: ожидается целое 1…100, получено "${perPage}"` };
    }
    query.perPage = n;
  }

  return { ok: true, query };
}

// ---------- рейтинг ----------

interface RatingRow {
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
  categories: string;
  stale: string;
  model_version: string;
  scan_status: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * «Последний пригодный» скан (К-Ф1.1): последняя по scan_id строка оценки
 * текущей модели у скана с rating_eligible = 1. Один подзапрос на все
 * поверхности — рейтинг, фасеты, счётчики /api/meta, listMyRepos, публичная
 * часть карточки и MD. «Последний» — по scan_id, а не по датам: id монотонен.
 * Параметр — model_version.
 */
export const LAST_ELIGIBLE_SCAN_SQL = `(SELECT MAX(sc2.scan_id) FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
   WHERE sc2.repo_id = sc.repo_id AND sc2.model_version = ? AND s2.rating_eligible = 1)`;

/**
 * Приватный репо без пригодного скана (круг 2, С2): последний завершённый
 * не-bad скан с оценкой текущей модели. Параметр — model_version.
 */
export const LAST_NOT_BAD_SCAN_SQL = `(SELECT MAX(sc2.scan_id) FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
   WHERE sc2.repo_id = sc.repo_id AND sc2.model_version = ? AND s2.status NOT IN ('bad', 'running', 'queued'))`;

/** Последний скан репо (L): статус и время последнего анализа (ТЗ §3.4). Алиас репо — r. */
const LAST_SCAN_SQL = `(SELECT MAX(l2.id) FROM scans l2 WHERE l2.repo_id = r.id)`;

// В4.1 (К1/К2) + В4.1-fix (К-Ф1.1, Ф1.11) + В4.3 (Ф3.1/Ф3.2): одна строка на
// репозиторий — последний пригодный скан; рейтинг сортируется по сохранённому
// HealthCraft Index (healthcraft_index, 4 категории — CI и Security в рейтинг
// не входят); статус и время — последнего скана L (круг 2, LOW-2: как
// карточка), статус — public_status; только rating_active=1 AND
// visibility='public'. Проверок доступа нет.
const RATING_SQL = `
SELECT r.org_slug, r.repo_slug, r.title, r.language, r.likes, r.forks, r.last_activity_at, r.logo_url, r.language_color,
       sc.healthcraft_index AS total, sc.index_coverage AS coverage, sc.categories, sc.stale, sc.model_version,
       COALESCE(l.public_status, l.status) AS scan_status, l.started_at, l.finished_at
FROM scores sc
JOIN repos r ON r.id = sc.repo_id
JOIN scans l ON l.id = ${LAST_SCAN_SQL}
WHERE sc.model_version = ?
  AND r.rating_active = 1
  AND r.visibility = 'public'
  AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`;

/** Категории каналов с правами зрителя (К2): в рейтинге и без доступа — закрыты. */
export const CHANNEL_CATEGORIES: CategoryKey[] = ["cicd", "security"];

/**
 * Ключ дерева КАНАЛЬНОГО скана в доказательствах карточки (П13, круг 2
 * В4.2-port-fix; решение владельца (1) 18.09). Это НЕ kind: факта с таким
 * ключом в таблице `facts` не существует и появиться не может (ключи фактов
 * приходят из реестра `KINDS`, где «@» не встречается), в
 * PUBLIC_KINDS/CHANNEL_KINDS/READ_KINDS он не добавляется, Score по нему не
 * считается, валидатор фактов и фильтры пригодности скана его не видят.
 * Живёт только в `evidence` карточки и в MD-отчёте: под ним едет `tree.stats`
 * того скана, по которому посчитана плотность Security, — публичный
 * `tree.stats` скана P при этом остаётся на месте (он кормит `derived`).
 * Суффикс `@channel` выбран так, чтобы ключ нельзя было спутать с kind и
 * чтобы `categoryOf` (префикс до первой точки) по-прежнему давал «code».
 */
export const CHANNEL_TREE_KEY = "tree.stats@channel";

function toRatingItem(row: RatingRow): RatingItem {
  const cats = JSON.parse(row.categories) as Record<string, CategoryScore>;
  const categories = {} as Record<CategoryKey, number | null>;
  for (const key of CATEGORY_ORDER) {
    categories[key] = CHANNEL_CATEGORIES.includes(key) ? null : (cats[key]?.score ?? null);
  }
  // stale-маркер рейтинга — только по фактам, которые входят в рейтинг
  const stale = (JSON.parse(row.stale) as string[]).filter((k) => PUBLIC_KINDS.includes(k));
  return {
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
  // NULL не «маленькое» и не «большое» — оно вне шкалы, поэтому всегда
  // в хвосте: иначе смена order делала бы «нет данных» лидером рейтинга
  if (av === null && bv === null) return fullName(a).localeCompare(fullName(b));
  if (av === null) return 1;
  if (bv === null) return -1;
  let cmp: number;
  if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
  else cmp = (av as number) - (bv as number);
  if (order === "desc") cmp = -cmp;
  // равные значения — по org/repo: пагинация не «дышит» между страницами
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

export function listRepos(db: Database, query: ReposQuery, opts: { now?: Date } = {}): RatingResponse {
  const rows = db.query(RATING_SQL).all(MODEL_VERSION, MODEL_VERSION) as RatingRow[];
  const all = rows.map(toRatingItem);

  // фасеты считаются БЕЗ фильтра языка (иначе выбранный язык схлопывает
  // список выбора и из него некуда вернуться), но С учётом поиска
  const byQ = query.q === undefined ? all : all.filter((i) => matchesQ(i, query.q!));
  const counts = new Map<string | null, number>();
  for (const item of byQ) counts.set(item.language, (counts.get(item.language) ?? 0) + 1);
  const languages: LanguageFacet[] = [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || (a.language ?? "￿").localeCompare(b.language ?? "￿"));

  const filtered = query.lang === undefined ? byQ : byQ.filter((i) => i.language === query.lang);
  const scored = filtered.filter((i) => i.healthcraftIndex !== null);
  const nullItems = filtered
    .filter((i) => i.healthcraftIndex === null)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  scored.sort((a, b) => compareItems(a, b, query.sort, query.order));

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
    facets: { languages },
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
}

export interface CardMarkers {
  /** деградационный ярус: история видна только с этой даты (§5.7) */
  historyTruncatedSince: string | null;
  /** CI заявлен конфигом, прогоны недоступны — потолок категории 50 */
  ciConfigOnlyCap: boolean;
  /** часть фактов взята из истории при сбое канала */
  staleFacts: boolean;
  /** без-кодовое репо (Q&A №13): Score 0 как данные «проекта нет», не NULL */
  codeEmpty: boolean;
  /** git-канал упёрся в лимиты оператора (факт no-data(limits)) — лимиты для текста причины (К5); иначе null */
  gitLimits: GitLimitsMarker | null;
}

export interface CardScan {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
}

/**
 * Ф2.15: статус ЖИВОЙ job зрителя по этому репо (queued/running) — единственное
 * поле: ни queueAhead (round-robin не задаёт FIFO-позицию), ни id. null = у
 * зрителя нет живой заявки (или он анонимен). Читатель — статус-блок карточки
 * «в очереди/сканируем» с опросом 3 с.
 */
export interface CardJob {
  status: "queued" | "running";
}

export interface CardCategory extends CategoryScore {
  /** номинальный вес категории в Repo Health Score (SCORE_WEIGHTS): карточка объясняет перенормировку полного показателя; веса индекса — в /api/meta.categories[].indexWeight */
  weight: number;
  /** канал закрыт зрителю (К2): чисел и подметрик нет, причина — для заглушки */
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
   * позиция среди всех оценённых, а не среди отфильтрованных. Оба поля null,
   * когда индекса нет — места у неоценённого репозитория не существует, — и
   * когда сам репозиторий в этот набор не входит (приватный: он виден своим
   * участникам и имеет индекс, но в публичном рейтинге его нет).
   */
  rank: number | null;
  rankedTotal: number | null;
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
  /** канал правила (cicd | appsec | null): у какого показателя Δ — HealthCraft Index или Repo Health Score (В4.3) */
  channel: string | null;
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

/** Доступ зрителя к каналам — для плашек UI (К2). */
export interface CardAccess {
  cicd: ChannelAccess;
  appsec: ChannelAccess;
}

export interface RepoCard {
  repo: CardRepo;
  access: CardAccess;
  markers: CardMarkers;
  scan: CardScan | null;
  /** живая job зрителя (Ф2.15) — очередь без позиции; аноним/без заявки → null */
  job: CardJob | null;
  score: CardScore | null;
  derived: DerivedMetrics | null;
  recommendations: CardRecommendation[];
  evidence: CardEvidence[];
}

/** Факты каналов с правами (К2): не едут в ответ зрителю без доступа — производные CHANNEL_KINDS (К-Ф1.1). */
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

/** Сырьё коммитов в ответ не едет никогда (объём + закон 3 «код не храним»). */
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
 * Видимость карточки (К2): публичный активный — всем; эвиктированный
 * публичный — 404 всем; не публичный — только при repo = granted.
 */
function cardVisible(r: CardRepoRow, access: AccessResult): boolean {
  if (r.visibility === "public") return r.rating_active === 1;
  return access.repo === "granted";
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
  opts: { limits?: ScanConfig; viewerUserId?: number } = {},
): Promise<RepoCard | null> {
  const r = findRepoRow(db, org, repo);
  if (!r) return null;
  // эвиктированный публичный — 404 всем, проверять доступ незачем
  if (r.visibility === "public" && r.rating_active !== 1) return null;
  const access = await resolve({ id: r.id, org: r.org_slug, repo: r.repo_slug, visibility: r.visibility });
  return getRepoCard(db, org, repo, { access, limits: opts.limits, viewerUserId: opts.viewerUserId });
}

/**
 * Единая карточка (К2), собранная по доступу зрителя (дефолт — аноним).
 * null = репозитория нет или он не виден зрителю (404). Есть репо без
 * скана — это 200.
 */
export function getRepoCard(
  db: Database,
  org: string,
  repo: string,
  opts: { access?: AccessResult; limits?: ScanConfig; viewerUserId?: number } = {},
): RepoCard | null {
  const access = opts.access ?? NO_PAT_ACCESS;
  const r = findRepoRow(db, org, repo);
  if (!r) return null;
  if (!cardVisible(r, access)) return null;
  const ciOpen = access.cicd === "granted";
  const secOpen = access.appsec === "granted";
  const cardAccess: CardAccess = { cicd: access.cicd, appsec: access.appsec };

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
    // колонки в схеме нет — шаблон платформы, заводить колонку ради него незачем
    webUrl: `https://sourcecraft.dev/${r.org_slug}/${r.repo_slug}`,
  };

  // Правило карточки (круг 2, решение владельца 17.09; TASK.md §2 «Аудит
  // В4.1-fix → правило карточки»):
  //  - публичная часть (Score в рейтинге, 4 категории, публичные факты и
  //    правила) — из последнего пригодного скана P; приватный репо без P —
  //    из последнего не-bad скана (владелец видит оценку своего репо, ТЗ §5);
  //  - CI — из последнего скана, где cicd.configs и cicd.runs собраны ok
  //    (нет такого — последний с ok cicd.configs: потолок «только конфиг»);
  //    Security — из последнего скана, где ok appsec.findings и tree.stats;
  //    чужой сбойный скан их не трогает;
  //  - полный Score и Δ канальных правил — на показе из показанных данных;
  //  - блок scan — последний скан (статус без каналов и время анализа).
  const SCORE_COLS = `sc.scan_id, sc.model_version, sc.healthcraft_index, sc.index_coverage,
              sc.categories, sc.no_data, sc.stale, sc.computed_at, sc.derived, sc.code_empty`;
  let publicRow = db
    .query(`SELECT ${SCORE_COLS} FROM scores sc WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`)
    .get(r.id, MODEL_VERSION, MODEL_VERSION) as ScoreRow | null;
  if (!publicRow && r.visibility !== "public") {
    publicRow = db
      .query(`SELECT ${SCORE_COLS} FROM scores sc WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_NOT_BAD_SCAN_SQL}`)
      .get(r.id, MODEL_VERSION, MODEL_VERSION) as ScoreRow | null;
  }
  const scanRow = db
    .query("SELECT id, started_at, finished_at, status, public_status, trigger FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1")
    .get(r.id) as
    | { id: number; started_at: string; finished_at: string | null; status: string; public_status: string | null; trigger: string }
    | null;
  // статус без каналов (Ф1.11) — всем
  const scan: CardScan | null = scanRow
    ? {
        id: scanRow.id,
        startedAt: scanRow.started_at,
        finishedAt: scanRow.finished_at,
        status: scanRow.public_status ?? scanRow.status,
        trigger: scanRow.trigger,
      }
    : null;

  if (!publicRow) {
    // «в каталоге, ещё не оценивали» (нет пригодного скана) — штатное состояние, не ошибка
    return {
      repo: cardRepo,
      access: cardAccess,
      markers: { historyTruncatedSince: null, ciConfigOnlyCap: false, staleFacts: false, codeEmpty: false, gitLimits: null },
      scan,
      job: liveViewerJob(db, org, repo, opts.viewerUserId),
      score: null,
      derived: null,
      recommendations: [],
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
  const secretsOf = (facts: Map<string, unknown>) => (facts.get("appsec.findings") as { secrets_critical?: unknown } | undefined)?.secrets_critical === true;
  const codeEmpty = publicRow.code_empty === 1;
  const fullTotals = totalsFromCategories(shownCats, { codeEmpty, secretsCritical: secretsOf(channelFacts) });

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
  // К-Р15 (круг 2): «почему данных нет» для Security — деталь последнего
  // no-data факта appsec (корзина type=X недоступна после N попыток...);
  // существующий канал причин — факт. Только ОТКРЫТОМУ зрителю: причина
  // закрытого канала — тоже данные канала. Счёт скоринга не тронут.
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
        /* повреждённый JSON причины — показываем без неё */
      }
    }
  }
  // Место в рейтинге: сколько оценённых репозиториев стоит выше. Условия —
  // те же, что в RATING_SQL, поэтому «3-е из 13 323» совпадает с позицией
  // строки на первой странице рейтинга без фильтров.
  // Приёмка 21.09: место считается ТОЛЬКО репозиторию, который сам стоит в
  // этом наборе. Приватный репо виден своим участникам и имеет индекс (из
  // последнего не-bad скана), но в публичный рейтинг не входит — без этой
  // проверки его карточка печатала «#1 из 13 323», то есть место в выборке,
  // которой репозитория нет. Это тот же случай, что и оговорённый в CardScore
  // «места у неоценённого репозитория не существует».
  const inRating = r.visibility === "public" && r.rating_active === 1;
  const ranking =
    !inRating || publicRow.healthcraft_index === null
      ? null
      : (db
          .query(
            `SELECT
               (SELECT COUNT(*) FROM scores sc JOIN repos r ON r.id = sc.repo_id
                 WHERE sc.model_version = ? AND r.rating_active = 1 AND r.visibility = 'public'
                   AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}
                   AND sc.healthcraft_index > ?) AS above,
               (SELECT COUNT(*) FROM scores sc JOIN repos r ON r.id = sc.repo_id
                 WHERE sc.model_version = ? AND r.rating_active = 1 AND r.visibility = 'public'
                   AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}
                   AND sc.healthcraft_index IS NOT NULL) AS scored`,
          )
          .get(MODEL_VERSION, MODEL_VERSION, publicRow.healthcraft_index, MODEL_VERSION, MODEL_VERSION) as {
          above: number;
          scored: number;
        } | null);

  const score: CardScore = {
    healthcraftIndex: publicRow.healthcraft_index,
    indexCoverage: publicRow.index_coverage,
    // Repo Health Score складывается из показанных категорий (тот же totalsFromCategories, что compute)
    repoHealthScore: fullOpen ? roundTotal(fullTotals.repoHealthScore) : null,
    repoHealthCoverage: fullOpen ? Math.round(fullTotals.repoHealthCoverage * 1000) / 1000 : null,
    fullLocked: !fullOpen,
    rank: ranking === null ? null : ranking.above + 1,
    rankedTotal: ranking === null ? null : ranking.scored,
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

  // рекомендации: публичные — сохранённые правила P; канальные — движок на
  // показанных канальных фактах с Δ к полному Score из показанных категорий
  const recQuery = db.query(
    `SELECT rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source, channel
     FROM recommendations WHERE scan_id = ? AND model_version = ? AND channel IS NULL ORDER BY priority ASC`,
  );
  const publicRecs: CardRecommendation[] = (recQuery.all(publicRow.scan_id, MODEL_VERSION) as RecRow[]).map((rec) => ({
    ruleId: rec.rule_id,
    kind: ruleKind(rec),
    priority: rec.priority,
    problem: rec.problem,
    action: rec.action,
    factRefs: splitRefs(rec.fact_ref).map((key) => ({ key, missing: false })),
    expectedImpact: rec.expected_impact,
    deltaScore: rec.delta_score,
    opensCategory: rec.opens_category,
    source: rec.source,
    channel: rec.channel,
  }));
  const baseFull = fullTotals.repoHealthScore;
  const channelDelta: DeltaEvaluator = (ruleChannel, patch) => {
    if (ruleChannel === null) throw new Error("card: public rules come from the eligible scan");
    const facts = new Map(channelFacts);
    patch(facts);
    const after = totalsFromCategories(
      { ...shownCats, cicd: categoryOfFacts(facts, "cicd"), security: categoryOfFacts(facts, "security") },
      { codeEmpty, secretsCritical: secretsOf(facts) },
    ).repoHealthScore;
    if (codeEmpty) return { delta: 0, reason: "в репозитории нет кода" };
    if (baseFull === null || after === null) return { delta: 0, reason: "итог появится при большем покрытии" };
    const delta = round4(after - baseFull);
    if (delta === 0 && secretsOf(channelFacts) && baseFull >= SECRETS_CRITICAL_TOTAL_CAP) return { delta: 0, reason: "упирается в кап 49" };
    return { delta, reason: null };
  };
  const channelRecs: CardRecommendation[] = recommendFromFacts(channelFacts, {
    delta: channelDelta,
    issuesScore: shownCats.issues.score,
    only: "channel",
  })
    .filter((rec) => rec.channel !== null && !closedChannels.has(rec.channel))
    .map((rec) => {
      // С4: Δ канального правила — числом только при доступе к обоим каналам
      // (как полный Score): иначе число и причины (кап 49) раскрывали бы Security
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
      };
    });
  // LOW-3: объединённая выдача — порядком движка, номера 1..N после фильтра (Ф1.3)
  const recommendations = orderRecommendations(publicRecs, channelRecs);

  // В4.2-port-fix (П9, С1 r2): плотность Security считается по `tree.stats`
  // канального скана, а фильтр `f.key !== "tree.stats"` вырезал именно его —
  // зритель видел «плотность N на 10k LOC» и рядом «tree.stats — нет данных»
  // из другого (публичного) скана, то есть число без единого факта в
  // отданном JSON.
  //
  // Круг 2 (П13, Н-4; решение владельца (1) 18.09): вытеснять публичный факт
  // канальным нельзя. `tree.stats` лежит в PUBLIC_KINDS и кормит ДВЕ
  // поверхности сразу — плотность Security и публичные `derived`
  // (todoDensityPerKloc, rootEntries, маркер codeEmpty), которые считаются по
  // скану P. Подмена делала с публичными числами ровно то, за что чинили
  // Security (число из одного скана, доказательство из другого) и ставила
  // публичное доказательство в зависимость от прав зрителя вопреки К-Ф1.1.
  // Поэтому публичный `tree.stats` остаётся нетронутым, а дерево канального
  // скана едет СВОИМ ключом `tree.stats@channel`: он живёт только в evidence
  // карточки и в MD, в PUBLIC_KINDS / CHANNEL_KINDS / READ_KINDS не входит, в
  // расчёт Score не идёт (его считает channelFacts выше) и зрителю без прав
  // на Security не отдаётся вовсе, как любое канальное доказательство.
  const shownChannelFacts = [...(ciOpen ? channel.cicdFacts : []), ...(secOpen ? channel.securityFacts : [])].map((f) =>
    f.key === "tree.stats" ? { ...f, key: CHANNEL_TREE_KEY } : f,
  );
  const factRows = [...publicFacts, ...shownChannelFacts];
  const factByKey = new Map(factRows.map((f) => [f.key, f]));
  // missing = факта нет по построению (публичный appsec.findings) — UI объясняет причину
  for (const rec of recommendations) for (const ref of rec.factRefs) ref.missing = !factByKey.has(ref.key);

  // адресуемые факты: те, на которые ссылаются рекомендации, плюс те,
  // что читает compute — сырьё остальных в ответ не едет
  const refKeys = recommendations.flatMap((rec) => rec.factRefs.map((ref) => ref.key));
  const addressable = new Set<string>([...refKeys, ...PUBLIC_KINDS, ...CHANNEL_KINDS, CHANNEL_TREE_KEY]);
  const evidence: CardEvidence[] = factRows
    .filter((f) => addressable.has(f.key))
    .map((f) => {
      const parsed = parseFactValue(f.value) as unknown;
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
    ciConfigOnlyCap: ciOpen && cicdNoData.includes("config-only cap"),
    staleFacts: stale.length > 0,
    codeEmpty,
    gitLimits: gitLimitsHit(publicFacts) ? gitLimitsOf(opts.limits ?? DEFAULT_SCAN) : null,
  };

  return {
    repo: cardRepo,
    access: cardAccess,
    markers,
    scan,
    job: liveViewerJob(db, org, repo, opts.viewerUserId),
    score,
    derived: publicRow.derived === null ? null : (JSON.parse(publicRow.derived) as DerivedMetrics),
    recommendations,
    evidence,
  };
}

/** Ф2.15: статус живой job ИМЕННО зрителя (queued/running); queueAhead наружу не едет. */
function liveViewerJob(db: Database, org: string, repo: string, viewerUserId: number | undefined): CardJob | null {
  if (viewerUserId === undefined) return null;
  const row = db
    .query(
      `SELECT j.status FROM jobs j JOIN repos r ON r.id = j.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND j.user_id = ? AND j.status IN ('queued','running')
       ORDER BY j.id DESC LIMIT 1`,
    )
    .get(org, repo, viewerUserId) as { status: string } | null;
  return row ? { status: row.status === "running" ? "running" : "queued" } : null;
}

/** Текст канального presence-правила без числа (С4): Δ Repo Health Score виден только при доступе к CI и Security. */
export const CHANNEL_DELTA_HIDDEN_TEXT = "улучшит CI/CD – прирост Repo Health Score виден при доступе к CI и Security";

const roundTotal = (x: number | null): number | null => (x === null ? null : Math.round(x));
const splitRefs = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * Источники канальных данных карточки (круг 2): CI — последний скан с ok
 * cicd.configs и ok cicd.runs, иначе последний с ok cicd.configs (потолок
 * «только конфиг»); Security — последний скан с ok appsec.findings и ok
 * tree.stats. Возвращаются факты этих kinds выбранного скана (в расчёт идут
 * только ok; не-ok cicd.runs скана «только конфиг» — доказательство потолка).
 */
export function channelSources(db: Database, repoId: number): { cicdScanId: number | null; securityScanId: number | null; cicdFacts: FactRow[]; securityFacts: FactRow[] } {
  const okIn = (kind: string) => `EXISTS (SELECT 1 FROM facts f WHERE f.scan_id = s.id AND f.key = '${kind}' AND f.status = 'ok')`;
  const lastScan = (cond: string) =>
    (db.query(`SELECT s.id FROM scans s WHERE s.repo_id = ? AND ${cond} ORDER BY s.id DESC LIMIT 1`).get(repoId) as { id: number } | null)?.id ?? null;
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

/** Git-канал упёрся в лимиты: git-факт со статусом no-data и reason=limits.
 *  Круг 2 В4.4: через parseFactValue, а не сырой JSON.parse — легаси-строка
 *  круга 1 (сжатый no-data timeline) переваривается, карточка и MD не отдают
 *  500 (репро Ищейки 1а). */
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
  /** В4.3 (К-Ф3.5): веса категории в двух показателях — indexWeight (HealthCraft Index; у CI/Security null — их там нет) и scoreWeight (Repo Health Score) */
  categories: { key: CategoryKey; title: string; indexWeight: number | null; scoreWeight: number }[];
  /** имя публичного показателя (рейтинг сортирует по нему) */
  publicMetricTitle: "HealthCraft Index";
  /** имя полного показателя (карточка с правами, кап 49) */
  fullMetricTitle: "Repo Health Score";
  coverageNullBelow: number;
  /**
   * В4.6 (У15): охват каталога честными числами. `scored` и `nullScore` —
   * репозитории, по которым УЖЕ есть строка `scores` текущей модели;
   * `catalog` — сколько всего публичных репозиториев в рейтинговом каталоге.
   * Без `catalog` страница могла сказать только «оценено 4964 из 4969», то
   * есть отрапортовать почти полный охват при фактическом обходе первой
   * волны — ровно та неправда, которую контракт У15 закрывает. Поле
   * ЧИТАЕМОЕ и производное: схема БД, веса и MODEL_VERSION не тронуты,
   * новых маршрутов и коллекторов нет.
   */
  repos: { scored: number; nullScore: number; catalog: number };
  /** Ф2.9/Ф2.15: лиз job из конфига планировщика — UI опрашивает анализ до этого горизонта */
  queue: { leaseMs: number };
  methodology: string;
  generatedAt: string;
}

export function getMeta(db: Database, opts: { now?: Date; leaseMs?: number } = {}): MetaResponse {
  const rows = db.query(RATING_SQL).all(MODEL_VERSION, MODEL_VERSION) as RatingRow[];
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
      scored: rows.filter((r) => r.total !== null).length,
      nullScore: rows.filter((r) => r.total === null).length,
      // тот же фильтр, что у RATING_SQL (rating_active + public), но без
      // JOIN на scores: знаменатель охвата — каталог, а не оценённая часть
      catalog: (db.query("SELECT COUNT(*) AS c FROM repos WHERE rating_active = 1 AND visibility = 'public'").get() as { c: number }).c,
    },
    queue: { leaseMs: opts.leaseMs ?? defaultLeaseMs(DEFAULT_SCAN) },
    methodology: METHODOLOGY_PATH,
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}
