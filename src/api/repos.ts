// repos.ts — read-API В3: чистые функции чтения БД (рейтинг, карточка,
// мета). Сети нет и быть не может — UI живёт на том, что уже посчитал
// скан. Сортировка/фильтрация/пагинация/фасеты считаются здесь, а не на
// клиенте (решение канвы «г»): рейтинг сразу является контрактом данных.
// Tri-state (закон 2): Score = NULL не участвует в ранжировании вообще —
// такие репо уезжают в отдельный массив, иначе «нет данных» оказалось бы
// лучшим или худшим результатом в зависимости от направления сортировки.
import type { Database } from "bun:sqlite";
import { CHANNEL_KINDS, PUBLIC_KINDS, computeFromFacts, effectiveFacts, totalsFromCategories, type CategoryScore } from "../score/compute";
import { orderRecommendations, recommendFromFacts, recommendationParams, recommendationText, round4, type DeltaEvaluator } from "../score/recommend";
import { categoryOf, parseFactValue, scrubDetail } from "../collectors/facts";
import { isOwnRepo, NO_PAT_ACCESS, visibilityOf, type AccessRepo, type AccessResult, type ChannelAccess } from "../auth/access";
import { DEFAULT_SCAN, defaultLeaseMs, type ScanConfig } from "../config";
import { roundScore, type GitLimitsMarker } from "../web/format";
import type { DerivedMetrics } from "../score/derived";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, COVERAGE_NULL_BELOW, type CategoryKey, type IndexCategoryKey, MODEL_VERSION, SECRETS_CRITICAL_TOTAL_CAP } from "../score/model";
import { getSummaryAuto } from "../summary/optin";

// ---------- общие формы ----------

// В4.9, часть 2 гейта: значения переехали в чистый модуль (их берет и бандл
// web через `src/report/sections.ts`); здесь — реэкспорт, формы API прежние.
import { CATEGORY_ORDER, CATEGORY_TITLES } from "../report/categories";
export { CATEGORY_ORDER, CATEGORY_TITLES };

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
  /**
   * Ступень 4 В4.9 (В-4, §2 23.09): место в публичном рейтинге по HealthCraft
   * Index — то же правило, что на карточке (индекс по убыванию, при равенстве
   * org/repo). Не зависит от поиска, фильтра и сортировки выдачи; null — без индекса.
   */
  rank: number | null;
  /** часть фактов взята из истории при сбое канала (§5.6) — НЕ «давность скана» */
  staleFacts: boolean;
  modelVersion: string;
}

export interface LanguageFacet {
  language: string | null;
  count: number;
  /**
   * В4.7 (П2, ревизия 4): цвет языка (`repos.language_color`, #rrggbb) — у
   * каждой опции мультивыбора свой кружок. Без поля цвет знали бы только
   * строки текущей страницы, и язык с чужой страницы остался бы без кружка.
   * null — у языка нет цвета платформы (или язык не определён).
   */
  color: string | null;
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
  /**
   * В4.7 (П2): множество языков из повторяемого `lang` (`?lang=Go&lang=Rust`).
   * undefined = параметра нет, фильтра нет (все языки); элемент null =
   * «язык не определён» (`lang=` пустым). Одиночный `lang=Go` — множество из
   * одного элемента: старые ссылки и закладки работают как раньше.
   */
  lang?: (string | null)[];
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
  /** баллы 4 категорий индекса (`json_extract`); NULL — нет данных или ключа нет */
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
// В5.3 (§2 25.09 «скорость рейтинга — вариант 1»): тот же набор тем же правилом,
// одним проходом. «Последний пригодный скан» (как LAST_ELIGIBLE_SCAN_SQL) и
// «последний скан» L (как LAST_SCAN_SQL) считаются по одному разу на репо
// (`GROUP BY`), а не коррелированным подзапросом на каждую строку; из JSON
// категорий SQLite достает только 4 балла индекса (`json_extract`) — строка
// категорий (~1,4 КБ) в JS не едет и не разбирается. Было ~1 с на запрос при
// 28 тыс. репо (650 мс SQL + 120 мс JSON), ответ не изменился (сверка построчно
// на копии БД — журнал плана В5.3).
const RATING_SQL = `
WITH last AS (
  SELECT sc2.repo_id, MAX(sc2.scan_id) AS scan_id FROM scores sc2 JOIN scans s2 ON s2.id = sc2.scan_id
  WHERE sc2.model_version = ? AND s2.rating_eligible = 1 GROUP BY sc2.repo_id),
lastscan AS (SELECT repo_id, MAX(id) AS id FROM scans GROUP BY repo_id)
SELECT r.org_slug, r.repo_slug, r.title, r.language, r.likes, r.forks, r.last_activity_at, r.logo_url, r.language_color,
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
  // stale-маркер рейтинга — только по фактам, которые входят в рейтинг
  const stale = (JSON.parse(row.stale) as string[]).filter((k) => PUBLIC_KINDS.includes(k));
  return {
    rank: null,
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
  // В-4: место — по всему рейтингу, до поиска и фильтров (правило карточки).
  // В5.3 (вариант 1): весь список сортируется по месту ОДИН раз — фильтры его
  // порядок сохраняют, и выдаче по умолчанию (индекс по убыванию) вторая
  // сортировка не нужна; NULL-индексы стоят в хвосте (compareItems)
  const all = rows.map(toRatingItem).sort((a, b) => compareItems(a, b, "index", "desc"));
  all.forEach((item, i) => {
    if (item.healthcraftIndex !== null) item.rank = i + 1;
  });

  // фасеты считаются БЕЗ фильтра языка (иначе выбранный язык схлопывает
  // список выбора и из него некуда вернуться), но С учётом поиска
  const byQ = query.q === undefined ? all : all.filter((i) => matchesQ(i, query.q!));
  // Мультивыбор (В4.7, П2) это решение не отменяет: выбранный набор не
  // схлопывает список, из которого его выбирали.
  const counts = new Map<string | null, number>();
  const colors = new Map<string | null, string | null>();
  // цвет — известный цвет строки этого языка с наименьшим org/repo (платформа отдает его на
  // язык, а не на репо); ревью 25.09: выбор не зависит от порядка списка (он теперь по месту)
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

  // фильтр — принадлежность множеству (В4.7, П2); сортировка от него не зависит
  const langs = query.lang;
  const filtered = langs === undefined ? byQ : byQ.filter((i) => langs.includes(i.language));
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
  /**
   * В4.9 ч.2 (блок Д, разрешение владельца 23.09): видимость SourceCraft —
   * плашка у имени на карточке. Все 3 значения `Repository.Visibility` и
   * явное «неизвестно» (мусор или NULL в строке) — `visibilityOf`.
   */
  visibility: "public" | "internal" | "private" | "unknown";
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
  /**
   * В4.8.5 (К8.5.2a): почему скан закрыт `bad` без сбоя сбора — прерван
   * штатной остановкой (`shutdown`), закрыт свипом/перехватом как сирота
   * (`orphaned`), не посчиталась оценка (`score_failed`); иначе null.
   * Прерванный скан — не «ошибка» для пользователя (`analysisOutcome`).
   */
  detail?: ScanDetail | null;
}

export type ScanDetail = "shutdown" | "orphaned" | "score_failed";

/** status_detail скана → закрытый список причин наружу (прочие строки — служебные, наружу не едут). */
export function scanDetailOf(raw: string | null | undefined): ScanDetail | null {
  return raw === "shutdown" || raw === "orphaned" || raw === "score_failed" ? raw : null;
}

/**
 * Ф2.15: статус ЖИВОЙ job зрителя по этому репо (queued/running) — единственное
 * поле: ни queueAhead (round-robin не задаёт FIFO-позицию), ни id. null = у
 * зрителя нет живой заявки (или он анонимен). Читатель — статус-блок карточки
 * «в очереди/сканируем» с опросом 3 с.
 */
export interface CardJob {
  status: "queued" | "running";
  /**
   * В4.8.5 (К8.5.2b, §2-Р4): «затянулось» — признак СЕРВЕРА: задание
   * `running`, а его лиз истёк (живой воркер продлевает лиз каждые leaseMs/3;
   * истёк — процесс умер или цикл событий стоит). UI не считает это сам от
   * `leaseMs`: при лизе 10 мин штатный 20-минутный клон выглядел бы зависшим.
   */
  stalled: boolean;
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

/**
 * В4.8.5: кто смотрит карточку — без новых запросов, из доступа, который
 * карточка и так резолвит при показе.
 * `own` (К8.5.14 (а), §2-Р2) — «свой» по общему правилу `isOwnRepo`: кнопка
 * анализа есть на любом своём репозитории, даже не в избранном; неизвестно
 * (сбой, нет токена, нет сессии) — не свой.
 * `auth` (К8.5.8) — отдельное поле, `ChannelAccess` не трогается (иначе
 * `src/report` без ключа писал бы «Не удалось проверить»): `no-session` —
 * зритель без сессии (аноним или сессия истекла), `no-pat` — сессия без
 * читаемого токена, `pat` — токен есть.
 */
export interface CardViewer {
  own: boolean;
  auth: "no-session" | "no-pat" | "pat";
}

/**
 * В5 (К5.4): AI-описание в карточке — ТОЛЬКО зрителю с правами на полный
 * Score (решение 22.09: текст никогда не публичен). Привязан к скану
 * последней генерации (ai_notes append — «взгляды» на каждый скан).
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

export interface CardAi {
  /** скан последней генерации */
  scanId: number;
  generatedAt: string | null;
  overview: CardAiNote | null;
  specialists: CardAiNote[];
  /** 23.09: роли, не прошедшие формирование, с честной причиной для карточки */
  failures: CardAiFailure[];
  /** зритель-владелец включил автозапуск (тумблер слота) */
  optIn: boolean;
  /** живая summary-заявка — кнопка показывает «формируется» */
  jobActive: boolean;
  /** до какого времени кулдаун кнопки (Config.queue.summaryCooldownMs) */
  cooldownUntil: string | null;
  /**
   * В5 (К5.10): флаг фрода — подозрение для проверки человеком; на показ
   * только зрителю с полным Score (там же, где текст). Score не меняет.
   */
  fraud: { flag: boolean; factors: { key: string; note: string }[] } | null;
}

export interface RepoCard {
  repo: CardRepo;
  access: CardAccess;
  /** В4.8.5: «свой» и причина доступа зрителя (optional — литералы карточек в тестах отчёта) */
  viewer?: CardViewer;
  markers: CardMarkers;
  scan: CardScan | null;
  /** живая job зрителя (Ф2.15) — очередь без позиции; аноним/без заявки → null */
  job: CardJob | null;
  score: CardScore | null;
  derived: DerivedMetrics | null;
  /** В5: AI-описание; отсутствует (undefined), когда зрителю закрыт полный Score */
  ai?: CardAi | null;
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
  opts: { limits?: ScanConfig; viewerUserId?: number; viewerAuth?: CardViewer["auth"] } = {},
): Promise<RepoCard | null> {
  const out = await resolveCardForViewer(db, org, repo, resolve, opts);
  return out.kind === "card" ? out.card : null;
}

/**
 * В4.8.5 (К8.5.6, С6-1): исход показа карточки. Приватный репозиторий, чью
 * проверку доступа SourceCraft не подтвердил из-за СБОЯ (0/429/5xx) или
 * отклонённого токена (401), — не «не найден» для владельца с ДОКАЗАННЫМИ
 * правами (сохранённая проверка текущего поколения PAT или свой скан):
 * ему — «проверка не удалась» / «токен отклонён». Всем прочим — прежний
 * нейтральный 404, неотличимый от несуществующего (чужой приватный не
 * раскрывается).
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
  // эвиктированный публичный — 404 всем, проверять доступ незачем
  if (r.visibility === "public" && r.rating_active !== 1) return { kind: "not_found" };
  const access = await resolve({ id: r.id, org: r.org_slug, repo: r.repo_slug, visibility: r.visibility });
  // 23.09: summaryCooldownMs обязана доехать до buildCardAi — раньше глохла
  // здесь, и карточка молча брала дефолт 60 мин, игнорируя .env (дебаг-куладаун
  // 1 мс работал у enqueue, но кнопка оставалась disabled)
  const card = getRepoCard(db, org, repo, { access, limits: opts.limits, viewerUserId: opts.viewerUserId, viewerAuth: opts.viewerAuth, summaryCooldownMs: opts.summaryCooldownMs });
  if (card) return { kind: "card", card };
  if (r.visibility !== "public" && (access.repo === "check-failed" || access.repo === "pat-expired") && opts.provenRights?.() === true) {
    return { kind: access.repo === "check-failed" ? "check_failed" : "token_rejected" };
  }
  return { kind: "not_found" };
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
  /**
   * `withRank: false` (В4.7, счётчик рекомендаций кабинета) — место в рейтинге
   * не считается (rank/rankedTotal = null): это два подсчёта по всему
   * каталогу, а кабинету из карточки нужны только рекомендации. Остальная
   * сборка — та же, поэтому число рекомендаций равно карточке построением.
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
  // В4.8.5 (К8.5.14 (а), §2-Р2): «свой» — из того же доступа, что уже
  // резолвлен для показа (без новых запросов); видимость — из БД
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
    // колонки в схеме нет — шаблон платформы, заводить колонку ради него незачем
    webUrl: `https://sourcecraft.dev/${r.org_slug}/${r.repo_slug}`,
    visibility: visibilityOf(r.visibility),
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
    .query("SELECT id, started_at, finished_at, status, public_status, trigger, status_detail FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1")
    .get(r.id) as
    | { id: number; started_at: string; finished_at: string | null; status: string; public_status: string | null; trigger: string; status_detail: string | null }
    | null;
  // статус без каналов (Ф1.11) — всем
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
    // «в каталоге, ещё не оценивали» (нет пригодного скана) — штатное состояние, не ошибка
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
  // В5.3 круг 4 (§2 25.09 «просмотр первого исполнения», п.1): место — ОДНИМ
  // проходом. Прежде три подсчета (выше, всего, равные) шли каждый по всем
  // оценкам с коррелированным LAST_ELIGIBLE_SCAN_SQL на строку — 1,2 с на
  // карточку на живой базе (28 тыс. репо), ×3 в сравнении. Здесь «последний
  // пригодный скан» считается один раз на репо (GROUP BY), выше/всего — одной
  // агрегацией, равные — списком слагов (их единицы). Набор и порядок те же,
  // что у RATING_SQL, поэтому место по-прежнему равно позиции строки рейтинга.
  const ranking =
    opts.withRank === false || !inRating || publicRow.healthcraft_index === null
      ? null
      : (db
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
          .get(MODEL_VERSION, publicRow.healthcraft_index, publicRow.healthcraft_index, MODEL_VERSION) as {
          above: number;
          scored: number;
          ties: string | null;
        } | null);

  // В4.8.5 (К8.5.10, С6-6): при РАВНЫХ индексах рейтинг упорядочивает строки
  // по org/repo (compareItems) — место на карточке считается тем же правилом,
  // иначе «#3» на карточке расходилось с позицией строки
  const tiesBefore =
    ranking === null || ranking.ties === null
      ? 0
      : ranking.ties.split("\n").filter((t) => t.localeCompare(`${r.org_slug}/${r.repo_slug}`) < 0).length;

  const score: CardScore = {
    healthcraftIndex: publicRow.healthcraft_index,
    indexCoverage: publicRow.index_coverage,
    // Repo Health Score складывается из показанных категорий (тот же totalsFromCategories, что compute)
    repoHealthScore: fullOpen ? roundTotal(fullTotals.repoHealthScore) : null,
    repoHealthCoverage: fullOpen ? Math.round(fullTotals.repoHealthCoverage * 1000) / 1000 : null,
    fullLocked: !fullOpen,
    rank: ranking === null ? null : ranking.above + tiesBefore + 1,
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
  // В4.9 (К9.10, вариант (а)): текст публичного правила — по ключу при чтении.
  // Параметры — из эффективных фактов ТОГО ЖЕ скана (как у движка при записи)
  // и сохраненных колонок (Δ); причина Δ = 0 восстанавливается по признакам
  // скана. Ключ неизвестен или параметр не восстановился — сохраненный текст.
  const scanFacts = effectiveFacts(db, publicRow.scan_id, r.id).ok;
  const publicRecs: CardRecommendation[] = (recQuery.all(publicRow.scan_id, MODEL_VERSION) as RecRow[]).map((rec) => {
    const reason = rec.delta_score === 0 ? (publicRow.code_empty === 1 ? "code-empty" : publicRow.healthcraft_index === null ? "no-total" : null) : null;
    const texts = recommendationText(
      rec.rule_id,
      recommendationParams(rec.rule_id, scanFacts, { delta: rec.delta_score ?? undefined, reason, channel: null, issuesScore: publicCats.issues?.score ?? null }),
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
    };
  });
  const baseFull = fullTotals.repoHealthScore;
  const channelDelta: DeltaEvaluator = (ruleChannel, patch) => {
    if (ruleChannel === null) throw new Error("card: public rules come from the eligible scan");
    const facts = new Map(channelFacts);
    patch(facts);
    const after = totalsFromCategories(
      { ...shownCats, cicd: categoryOfFacts(facts, "cicd"), security: categoryOfFacts(facts, "security") },
      { codeEmpty, secretsCritical: secretsOf(facts) },
    ).repoHealthScore;
    if (codeEmpty) return { delta: 0, reason: "code-empty" };
    if (baseFull === null || after === null) return { delta: 0, reason: "no-total" };
    const delta = round4(after - baseFull);
    if (delta === 0 && secretsOf(channelFacts) && baseFull >= SECRETS_CRITICAL_TOTAL_CAP) return { delta: 0, reason: "cap" };
    return { delta, reason: null };
  };
  const channelRecs: CardRecommendation[] = recommendFromFacts(channelFacts, {
    delta: channelDelta,
    issuesScore: shownCats.issues.score,
    only: "channel",
    codeEmpty,
    // В5.3-М (Н7): скор-правила каналов — только у показанной оцененной категории
    categoryScores: Object.fromEntries(CATEGORY_ORDER.map((k) => [k, shownCats[k].score])),
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
      const raw = parseFactValue(f.value) as unknown;
      // М2.7: у фактов до правки сборщика путь временного клона — в `detail`
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

  // В5 (К5.4): текст виден только зрителю с полным Score; сборка — не вызов,
  // если генерации не было (ai = null при fullOpen, undefined при закрытом)
  const ai = fullOpen ? buildCardAi(db, r.id, opts.viewerUserId, summaryCooldownMsOf(opts)) : undefined;

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
    evidence,
  };
}

const AI_DEFAULT_COOLDOWN_MS = 60 * 60_000;

function summaryCooldownMsOf(opts: { summaryCooldownMs?: number }): number {
  return opts.summaryCooldownMs ?? AI_DEFAULT_COOLDOWN_MS;
}

/** Последняя генерация репо (ai_notes append) + состояние кнопки для владельца. */
function buildCardAi(db: Database, repoId: number, viewerUserId: number | undefined, cooldownMs: number): CardAi {
  const last = db.query("SELECT MAX(scan_id) AS s FROM ai_notes WHERE repo_id = ?").get(repoId) as { s: number | null };
  const slugRow = db.query("SELECT org_slug, repo_slug FROM repos WHERE id = ?").get(repoId) as { org_slug: string; repo_slug: string };
  const slug = `${slugRow.org_slug}/${slugRow.repo_slug}`;
  const optIn = viewerUserId !== undefined ? getSummaryAuto(db, viewerUserId, slug) : false;
  // В5.1-smoke (23.09): bun:sqlite .get() возвращает null при пустом
  // результате — сравнение с undefined делало jobActive константным true
  const jobActive =
    (db.query("SELECT 1 AS x FROM jobs WHERE repo_id = ? AND kind = 'summary' AND status IN ('queued', 'running') LIMIT 1").get(repoId) as { x: number } | null) !== null;
  const lastJobAt = (db.query("SELECT MAX(created_at) AS t FROM jobs WHERE repo_id = ? AND kind = 'summary'").get(repoId) as { t: string | null }).t;
  const cooldownUntil = lastJobAt === null ? null : new Date(Date.parse(lastJobAt) + cooldownMs).toISOString();
  const fails = db
    .query("SELECT role, reason FROM ai_fails WHERE scan_id = ? ORDER BY id")
    .all(last.s) as { role: string; reason: string }[];
  if (last.s === null) {
    return { scanId: 0, generatedAt: null, overview: null, specialists: [], failures: [], optIn, jobActive, cooldownUntil, fraud: null };
  }
  const noteRows = db
    .query("SELECT role, text, fact_refs, charter_version, model, created_at FROM ai_notes WHERE repo_id = ? AND scan_id = ? ORDER BY id")
    .all(repoId, last.s) as { role: string; text: string; fact_refs: string; charter_version: string; model: string; created_at: string }[];
  const toNote = (r: (typeof noteRows)[number]): CardAiNote => ({
    role: r.role,
    text: r.text,
    refs: (JSON.parse(r.fact_refs) as string[]) ?? [],
    charterVersion: r.charter_version,
    model: r.model,
    createdAt: r.created_at,
  });
  const overview = noteRows.find((r) => r.role === "overview");
  const specialists = noteRows.filter((r) => r.role !== "overview" && r.role !== "flagger").map(toNote);
  // флаг фрода — структурный JSON из заметки flagger последней генерации
  const flagRow = noteRows.find((r) => r.role === "flagger");
  let fraud: CardAi["fraud"] = null;
  if (flagRow !== undefined) {
    try {
      const parsed = JSON.parse(flagRow.text) as { flag?: unknown; factors?: unknown };
      if (typeof parsed.flag === "boolean" && Array.isArray(parsed.factors)) {
        fraud = {
          flag: parsed.flag,
          factors: parsed.factors
            .filter((f): f is { key: string; note: string } => {
              const item = f as { key?: unknown; note?: unknown };
              return typeof item.key === "string" && typeof item.note === "string";
            })
            .slice(0, 8),
        };
      }
    } catch {
      fraud = null; // повреждённый JSON флага — флага нет, а не флаг есть
    }
  }
  const generatedAt = noteRows.reduce((acc, r) => (r.created_at > (acc ?? "") ? r.created_at : acc), null as string | null);
  return {
    scanId: last.s,
    generatedAt,
    overview: overview ? toNote(overview) : null,
    specialists,
    failures: fails,
    optIn,
    jobActive,
    cooldownUntil,
    fraud,
  };
}

/** Ф2.15: статус живой job ИМЕННО зрителя (queued/running); queueAhead наружу не едет. */
function liveViewerJob(db: Database, org: string, repo: string, viewerUserId: number | undefined): CardJob | null {
  if (viewerUserId === undefined) return null;
  const row = db
    .query(
      `SELECT j.status, j.lease_until FROM jobs j JOIN repos r ON r.id = j.repo_id
       WHERE r.org_slug = ? AND r.repo_slug = ? AND j.user_id = ? AND j.status IN ('queued','running')
       ORDER BY j.id DESC LIMIT 1`,
    )
    .get(org, repo, viewerUserId) as { status: string; lease_until: string | null } | null;
  if (!row) return null;
  const running = row.status === "running";
  return { status: running ? "running" : "queued", stalled: running && jobLeaseExpired(row.lease_until) };
}

/** К8.5.2b: лиз `running`-задания истёк (нет лиза у running — тоже истёк: живой воркер его держит). */
export function jobLeaseExpired(leaseUntil: string | null, now = Date.now()): boolean {
  if (leaseUntil === null) return true;
  const t = Date.parse(leaseUntil);
  return !Number.isFinite(t) || t < now;
}

/** Текст канального presence-правила без числа (С4): Δ Repo Health Score виден только при доступе к CI и Security. */
export const CHANNEL_DELTA_HIDDEN_TEXT = "повысит балл категории «CI/CD»; насколько вырастет Repo Health Score, видно при доступе к CI/CD и Безопасности";

// В5.3-М (Н13): одно правило округления с расчетом, отчетом и рейтингом
const roundTotal = (x: number | null): number | null => (x === null ? null : roundScore(x));
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
  // В4.8.5 (К8.5.12, С10-14): источник канала — только ЗАВЕРШЁННЫЙ не-bad скан:
  // `running` ещё пишет факты, `bad` (shutdown, orphaned, score_failed, сбой
  // сбора) — не доказательство
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
  /** В5.3 (О5): публичный адрес сервиса — абсолютный код бейджа для README */
  publicBaseUrl: string;
  generatedAt: string;
}

export function getMeta(db: Database, opts: { now?: Date; leaseMs?: number; publicBaseUrl?: string } = {}): MetaResponse {
  // В5.3 (§2 25.09, вариант 1): счетчики — легким запросом по тому же набору, без строк рейтинга
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
      // JOIN на scores: знаменатель охвата — каталог, а не оценённая часть
      catalog: (db.query("SELECT COUNT(*) AS c FROM repos WHERE rating_active = 1 AND visibility = 'public'").get() as { c: number }).c,
    },
    queue: { leaseMs: opts.leaseMs ?? defaultLeaseMs(DEFAULT_SCAN) },
    methodology: METHODOLOGY_PATH,
    publicBaseUrl: opts.publicBaseUrl ?? "http://localhost:8418",
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}
