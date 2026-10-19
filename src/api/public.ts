// Публичный API и бейдж: только публичные репозитории из рейтинга; приватный
// или выведенный – 404, неотличимо от несуществующего. В ответе только
// публичные числа и мета: ни доказательств, ни текстов LLM, ни таймлайна.
// Исключение – бейдж закрытого репозитория по ключу из ссылки (`badgeKey`):
// ключ выдает только карточка участнику, и бейдж несет те же числа, что у открытого.
import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { MODEL_VERSION, INDEX_WEIGHTS, type IndexCategoryKey } from "../score/model";
import { CATEGORY_TITLES } from "../report/categories";
import { MINUS, SCORE_WORDS, roundScore, scoreTheme } from "../web/format";
import { LAST_ELIGIBLE_SCAN_SQL, LAST_NOT_BAD_SCAN_SQL, publicApiVisible, ratingPlace } from "./repos";
import { rankBadge, type RankBadge, type RankLeague } from "./rank-badge";

export interface PublicRepoResponse {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** публичные 4 категории (основы индекса); NULL = нет данных (tri-state) */
  categories: Partial<Record<"documentation" | "activity" | "issues" | "code", number | null>>;
  modelVersion: string;
  scannedAt: string | null;
  headSha: string | null;
}

/** null = репо не существует, приватен или выведен из рейтинга (везде 404). */
export function getPublicRepo(db: Database, org: string, repo: string): PublicRepoResponse | null {
  const r = db
    .query("SELECT id, org_slug, repo_slug, title, language, likes, rating_active, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?")
    .get(org, repo) as { id: number; org_slug: string; repo_slug: string; title: string | null; language: string | null; likes: number | null; rating_active: number; visibility: string } | null;
  if (!r) return null;
  // та же проверка задает поле карточки `repo.badge`
  if (!publicApiVisible(r)) return null;
  const scan = db
    .query(
      `SELECT sc.scan_id, sc.healthcraft_index, sc.index_coverage, sc.categories, s.finished_at, s.head_sha
       FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`,
    )
    // у подзапроса LAST_ELIGIBLE_SCAN_SQL свой ? на model_version, поэтому параметров три
    .get(r.id, MODEL_VERSION, MODEL_VERSION) as
    | { scan_id: number; healthcraft_index: number | null; index_coverage: number; categories: string; finished_at: string | null; head_sha: string | null }
    | null;
  if (scan === null) {
    // репо в рейтинге, но еще не оценен
    return {
      org: r.org_slug,
      repo: r.repo_slug,
      title: r.title,
      language: r.language,
      likes: r.likes,
      healthcraftIndex: null,
      indexCoverage: 0,
      categories: {},
      modelVersion: MODEL_VERSION,
      scannedAt: null,
      headSha: null,
    };
  }
  const cats = JSON.parse(scan.categories) as Record<string, { score: number | null }>;
  const categories: PublicRepoResponse["categories"] = {};
  for (const key of Object.keys(INDEX_WEIGHTS) as Array<keyof typeof INDEX_WEIGHTS>) {
    categories[key as "documentation"] = cats[key]?.score ?? null;
  }
  return {
    org: r.org_slug,
    repo: r.repo_slug,
    title: r.title,
    language: r.language,
    likes: r.likes,
    healthcraftIndex: scan.healthcraft_index,
    indexCoverage: scan.index_coverage,
    categories,
    modelVersion: MODEL_VERSION,
    scannedAt: scan.finished_at,
    headSha: scan.head_sha,
  };
}

/** Цвет индекса для badge: те же пороги словесной шкалы, без слов. */
export function badgeColor(index: number | null): string {
  if (index === null) return "#8b8b8b";
  if (index >= 70) return "#2da44e";
  if (index >= 40) return "#bf8700";
  return "#cf222e";
}

export const BADGE_CACHE_SECONDS = 300;


/**
 * Значок места для бейджа; место считает `ratingPlace`, как и на карточке.
 * Без индекса нет ни места, ни значка.
 */
export function publicRankBadge(db: Database, proj: PublicRepoResponse): RankBadge | null {
  if (proj.healthcraftIndex === null) return null;
  return rankBadge(ratingPlace(db, proj.org, proj.repo, proj.healthcraftIndex));
}

/**
 * «Металл» лиги значка места: фон – яркий край градиента плашки лиги на карточке
 * (theme.css `--rh-league-<лига>-bg`), текст – темный оттенок того же металла.
 * Белый текст на этих фонах не дает контраста WCAG 4,5:1, темный дает (проверено тестом).
 */
export const RANK_BADGE_COLORS: Record<RankLeague, { bg: string; fg: string }> = {
  gold: { bg: "#dcc26a", fg: "#5c4600" },
  silver: { bg: "#bcc4cc", fg: "#3e464f" },
  bronze: { bg: "#deb08b", fg: "#673912" },
};

/**
 * SVG-бейдж: только число, подпись и цвет – никаких ссылок, внешних шрифтов и
 * метаданных. Без данных – «n/a» серым. `rank` добавляет третий сегмент со
 * значком места цвета лиги; при null бейдж байт в байт обычный.
 */
export function renderBadgeSvg(index: number | null, rank: RankBadge | null = null, extras: BadgeExtras = {}): string {
  // изменение и слово шкалы – в сегменте числа через «·»; без них бейдж байт в байт прежний
  const parts = [index === null ? "n/a" : String(index)];
  if (index !== null && extras.delta !== undefined && extras.delta !== null) parts.push(deltaText(extras.delta));
  if (index !== null && extras.word === true) parts.push(SCORE_WORDS[scoreTheme(index) as keyof typeof SCORE_WORDS]);
  const value = parts.join(" · ");
  const color = badgeColor(index);
  // левая половина – нейтральный серый, как у бейджей shields; ширина подписи – под Verdana 11
  const label = "HealthCraft Index";
  const labelWidth = 114;
  const valueWidth = parts.length === 1 ? 8 + value.length * 11 : 10 + textWidth(value, true);
  // ширина сегмента места – под Verdana 11 (кириллица и цифры жирным ~8 px на знак)
  const rankWidth = rank === null ? 0 : 10 + rank.label.length * 8;
  const width = labelWidth + valueWidth + rankWidth;
  const title = rank === null ? `${label}: ${value}` : `${label}: ${value}, ${rank.label} рейтинга`;
  const metal = rank === null ? null : RANK_BADGE_COLORS[rank.tier];
  const rankRect = metal === null ? "" : `
    <rect x="${labelWidth + valueWidth}" width="${rankWidth}" height="20" fill="${metal.bg}"/>`;
  const rankText = metal === null ? "" : `
    <text x="${labelWidth + valueWidth + rankWidth / 2}" y="14" font-weight="bold" fill="${metal.fg}">${rank!.label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">
  <title>${title}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>${rankRect}
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" font-weight="bold">${value}</text>${rankText}
  </g>
</svg>`;
}

/** Что добавить в сегмент числа: изменение с прошлого анализа и слово шкалы. */
export interface BadgeExtras {
  /** разница с прошлым анализом; null – сравнивать не с чем (части нет) */
  delta?: number | null;
  word?: boolean;
}

function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `${MINUS}${-delta}` : "±0";
}

/**
 * Ширина текста Verdana 11 в px – по классам знаков, без шрифта на сервере.
 * С запасом: узкий бейдж обрезал бы текст, широкий только чуть просторнее.
 */
export function textWidth(text: string, bold = false): number {
  let w = 0;
  for (const ch of text) {
    if (ch === " ") w += 3.9;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (/[·.,:]/.test(ch)) w += 4.4;
    else if (/[+±−]/.test(ch)) w += 9.2;
    else if (/[A-ZА-Я]/.test(ch)) w += 7.6;
    else w += 6.6;
  }
  return Math.ceil(w * (bold ? 1.1 : 1));
}

/** Бейдж балла категории: подпись – название категории, число – по шкале индекса. */
export function renderCategoryBadgeSvg(category: IndexCategoryKey, score: number | null): string {
  const label = CATEGORY_TITLES[category];
  const shown = score === null ? null : roundScore(score);
  const value = shown === null ? "n/a" : String(shown);
  const labelWidth = 12 + textWidth(label);
  const valueWidth = 8 + value.length * 11;
  const width = labelWidth + valueWidth;
  const title = `${label}: ${value}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">
  <title>${title}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${badgeColor(shown)}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" font-weight="bold">${value}</text>
  </g>
</svg>`;
}

// ---------- параметры бейджа ----------

/** Части основного бейджа, которые выбирают в окне «Бейдж для README». */
export type BadgePart = "rank" | "word" | "delta";
export const BADGE_PARTS: readonly BadgePart[] = ["rank", "word", "delta"];
export const BADGE_CATEGORIES = Object.keys(INDEX_WEIGHTS) as IndexCategoryKey[];

export interface BadgeOptions {
  parts: ReadonlySet<BadgePart>;
  /** бейдж одной категории вместо основного; null – основной */
  category: IndexCategoryKey | null;
}

/**
 * Вид бейджа – параметры того же маршрута `badge.svg`, а не отдельные адреса:
 * гейт публичности, лимит и кэш общие, а README переключается правкой адреса.
 * Неверное значение – 400 еще до поиска репо, чтобы ответ не зависел от его
 * видимости. Параметры маршрута `badge.svg`:
 * - `show=rank,word,delta` – части основного бейджа в любом наборе без повторов;
 * - `style=rank` – прежний вид, то же, что `show=rank` (ссылки в README не ломаются);
 * - `category=<ключ>` – бейдж балла категории, без других частей.
 * Каждый параметр не больше одного раза; иное – null (400 еще до поиска репо).
 * `key` разбирает маршрут.
 */
export function parseBadgeOptions(params: URLSearchParams): BadgeOptions | null {
  const one = (name: string): string | null | undefined => {
    const all = params.getAll(name);
    return all.length === 0 ? null : all.length === 1 ? all[0] : undefined;
  };
  const style = one("style");
  const show = one("show");
  const category = one("category");
  if (style === undefined || show === undefined || category === undefined) return null;
  if (style !== null && style !== "rank") return null;
  const parts = new Set<BadgePart>(style === "rank" ? ["rank"] : []);
  if (show !== null) {
    const list = show.split(",");
    if (list.some((p) => !(BADGE_PARTS as readonly string[]).includes(p))) return null;
    if (new Set(list).size !== list.length) return null;
    for (const p of list) parts.add(p as BadgePart);
  }
  if (category !== null) {
    if (!(BADGE_CATEGORIES as string[]).includes(category) || parts.size > 0) return null;
    return { parts, category: category as IndexCategoryKey };
  }
  return { parts, category: null };
}

// ---------- бейдж закрытого репозитория ----------

/**
 * Ключ бейджа закрытого репозитория: HMAC от APP_SECRET и слага, 22 знака
 * base64url. Ключ открывает только бейдж (числа индекса и категорий), не JSON;
 * смена APP_SECRET гасит все ключи сразу.
 */
export function badgeKey(appSecret: string, org: string, repo: string): string {
  return createHmac("sha256", appSecret).update(`badge:v1:${org}/${repo}`).digest("base64url").slice(0, 22);
}

function badgeKeyValid(appSecret: string, org: string, repo: string, key: string): boolean {
  const want = Buffer.from(badgeKey(appSecret, org, repo));
  const got = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Числа бейджа: индекс, прошлый индекс того же ряда, баллы категорий, значок места. */
export interface BadgeSubject {
  index: number | null;
  previousIndex: number | null;
  categories: Partial<Record<IndexCategoryKey, number | null>>;
  rank: RankBadge | null;
}

/**
 * Данные бейджа или null (404). Открытый репозиторий из рейтинга – по
 * пригодным сканам, как публичный API; закрытый (private/internal) – только
 * с верным ключом и по тому же правилу, что карточка: последний пригодный
 * скан, без него – последний не-bad. Выбывший открытый – 404 и с ключом.
 */
export function badgeSubject(db: Database, org: string, repo: string, opts: { key?: string | null; appSecret?: string | null; withRank?: boolean } = {}): BadgeSubject | null {
  const r = db.query("SELECT id, org_slug, repo_slug, visibility, rating_active FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as
    | { id: number; org_slug: string; repo_slug: string; visibility: string; rating_active: number }
    | null;
  if (!r) return null;
  const open = publicApiVisible(r);
  const closed = r.visibility === "private" || r.visibility === "internal";
  if (!open) {
    if (!closed || !opts.key || !opts.appSecret || !badgeKeyValid(opts.appSecret, r.org_slug, r.repo_slug, opts.key)) return null;
  }
  const pick = (sql: string) =>
    db
      .query(`SELECT sc.scan_id, sc.healthcraft_index, sc.categories FROM scores sc WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${sql}`)
      .get(r.id, MODEL_VERSION, MODEL_VERSION) as { scan_id: number; healthcraft_index: number | null; categories: string } | null;
  const row = pick(LAST_ELIGIBLE_SCAN_SQL) ?? (closed ? pick(LAST_NOT_BAD_SCAN_SQL) : null);
  // прошлый индекс – из того же ряда, что текущий (то же правило, что у списка
  // «Мои репозитории»): пригодные сканы, у закрытого без них – не-bad
  const series = (eligible: boolean) =>
    db
      .query(
        `SELECT sc.healthcraft_index AS total FROM scores sc JOIN scans s ON s.id = sc.scan_id
         WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.healthcraft_index IS NOT NULL AND ${eligible ? "s.rating_eligible = 1" : "s.status NOT IN ('bad', 'running', 'queued')"}
         ORDER BY sc.scan_id DESC LIMIT 2`,
      )
      .all(r.id, MODEL_VERSION) as { total: number }[];
  const eligiblePair = series(true);
  const pair = eligiblePair.length > 0 || !closed ? eligiblePair : series(false);
  const index = row?.healthcraft_index ?? null;
  const cats = row ? (JSON.parse(row.categories) as Record<string, { score: number | null }>) : {};
  const categories: BadgeSubject["categories"] = {};
  for (const key of BADGE_CATEGORIES) categories[key] = cats[key]?.score ?? null;
  return {
    index,
    previousIndex: index !== null && pair.length === 2 ? pair[1]!.total : null,
    categories,
    // место есть только у открытого репозитория из рейтинга
    rank: open && opts.withRank === true && index !== null ? rankBadge(ratingPlace(db, r.org_slug, r.repo_slug, index)) : null,
  };
}

/** SVG бейджа по разобранным параметрам. */
export function renderBadgeFor(subject: BadgeSubject, options: BadgeOptions): string {
  if (options.category !== null) return renderCategoryBadgeSvg(options.category, subject.categories[options.category] ?? null);
  const delta = options.parts.has("delta") && subject.index !== null && subject.previousIndex !== null ? subject.index - subject.previousIndex : null;
  return renderBadgeSvg(subject.index, options.parts.has("rank") ? subject.rank : null, { delta, word: options.parts.has("word") });
}
