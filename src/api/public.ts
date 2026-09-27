// Публичный API и бейдж: только публичные репозитории из рейтинга; приватный
// или выведенный – 404, неотличимо от несуществующего. В ответе только
// публичные числа и мета: ни доказательств, ни текстов LLM, ни таймлайна.
import type { Database } from "bun:sqlite";
import { MODEL_VERSION, INDEX_WEIGHTS } from "../score/model";
import { LAST_ELIGIBLE_SCAN_SQL, publicApiVisible, ratingPlace } from "./repos";
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
 * Вариант бейджа – параметр `style` того же маршрута `badge.svg`, а не отдельный
 * адрес: гейт публичности, лимит и кэш общие, а README переключается правкой
 * адреса. Нет параметра – обычный бейдж, `style=rank` – со значком места, иное
 * значение – 400 еще до поиска репо, чтобы ответ не зависел от его видимости.
 */
export type BadgeStyle = "plain" | "rank";

export function parseBadgeStyle(params: URLSearchParams): BadgeStyle | null {
  const all = params.getAll("style");
  if (all.length === 0) return "plain";
  if (all.length > 1) return null;
  return all[0] === "rank" ? "rank" : null;
}

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
export function renderBadgeSvg(index: number | null, rank: RankBadge | null = null): string {
  const value = index === null ? "n/a" : String(index);
  const color = badgeColor(index);
  // левая половина – нейтральный серый, как у бейджей shields; ширина подписи – под Verdana 11
  const label = "HealthCraft Index";
  const labelWidth = 114;
  const valueWidth = 8 + value.length * 11;
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
