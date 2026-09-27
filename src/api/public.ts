// public.ts — публичный API и badge (В5, К5.8): только rating_active
// публичные репозитории; приватный/эвицтированный — 404 неотличимо от
// несуществующего. В проекции — ничего, кроме публичных чисел и меты:
// ни доказательств, ни текстов LLM, ни таймлайна. В SVG — только число,
// подпись и цвет.
import type { Database } from "bun:sqlite";
import { MODEL_VERSION, INDEX_WEIGHTS } from "../score/model";
import { LAST_ELIGIBLE_SCAN_SQL, publicApiVisible } from "./repos";

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
  // гейт публичности: не публичный ИЛИ выведенный — не существует для API
  // В5.5 закрытие (П-2): та же проверка задает поле карточки `repo.badge`
  if (!publicApiVisible(r)) return null;
  const scan = db
    .query(
      `SELECT sc.scan_id, sc.healthcraft_index, sc.index_coverage, sc.categories, s.finished_at, s.head_sha
       FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ? AND sc.scan_id = ${LAST_ELIGIBLE_SCAN_SQL}`,
    )
    // подзапрос LAST_ELIGIBLE_SCAN_SQL несёт свой ? на model_version —
    // параметров три (как в getRepoCard)
    .get(r.id, MODEL_VERSION, MODEL_VERSION) as
    | { scan_id: number; healthcraft_index: number | null; index_coverage: number; categories: string; finished_at: string | null; head_sha: string | null }
    | null;
  if (scan === null) {
    // репо в рейтинге, но ещё не оценён: честная пустая проекция
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
 * SVG badge: ТОЛЬКО число, подпись и цвет (К5.8) — никаких ссылок, шрифтов
 * с внешних хостов или метаданных. Без данных — «n/a» серым (tri-state).
 */
export function renderBadgeSvg(index: number | null): string {
  const value = index === null ? "n/a" : String(index);
  const color = badgeColor(index);
  // В5.3 (круг 3, §2 24.09): подпись — имя показателя «HealthCraft Index»,
  // левая половина — нейтральный серый, как у бейджей shields (прежний фон
  // #2d2c33 — тема сервиса до 17.09). Ширина подписи — под Verdana 11
  const label = "HealthCraft Index";
  const labelWidth = 114;
  const valueWidth = 8 + value.length * 11;
  const width = labelWidth + valueWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" font-weight="bold">${value}</text>
  </g>
</svg>`;
}
