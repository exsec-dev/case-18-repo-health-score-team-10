// Обход каталога публичных репозиториев через GET /repos
// (DiscoverRepositories, docs/api-spec/sourcecraft.swagger.json).
// `sort_by=created_at`, потому что порядок по умолчанию `-rating` нестабилен
// при пагинации: по спеке репо могут пропускаться или повторяться.
// `page_size=100` – максимум спеки; дефолтные 20 записей дают впятеро больше
// запросов. Потолок страниц – только предохранитель.
// Эндпоинт и так отдает только публичные репо (параметра `visibility` в спеке
// нет), но клиентский фильтр по полю видимости оставлен на всякий случай.
import { ScClient } from "./http";

export interface CatalogEntry {
  org: string;
  repo: string;
  name: string | null;
  language: string | null;
  visibility: string | null;
  description: string | null;
  is_empty: boolean;
  last_updated: string | null;
  /** округленный rating.value каталога (производная от лайков, а не их число) */
  likes: number | null;
  rating_percentile: number | null;
  default_branch: string | null;
  clone_url_https: string | null;
  web_url: string | null;
  /** logo.url репозитория; null – UI рисует инициалы */
  logo_url: string | null;
  /** language.color платформы (#rrggbb) для точки языка в UI */
  language_color: string | null;
}

export interface CatalogResult {
  ok: boolean;
  entries: CatalogEntry[];
  pages: number;
  /** true – каталог не дочитан (потолок страниц или сбой) */
  truncated: boolean;
  /** записей отброшено из-за некорректного слага или формы */
  skippedBadEntries: number;
  /** первая ошибка канала, если ok=false */
  error?: { status: number; detail: string };
}

export interface CatalogOptions {
  maxPages?: number;
  /** оставить только public (по умолчанию true) */
  publicOnly?: boolean;
}

interface RawEntry {
  organization?: { slug?: unknown };
  slug?: unknown;
  name?: unknown;
  language?: { name?: unknown; color?: unknown } | string | null;
  visibility?: unknown;
  description?: unknown;
  is_empty?: unknown;
  last_updated?: unknown;
  rating?: { value?: unknown; percentile?: unknown };
  default_branch?: unknown;
  clone_url?: { https?: unknown };
  web_url?: unknown;
  logo?: { url?: unknown } | null;
}

/** Цвет из API попадает в style, поэтому пропускаем только #rgb/#rrggbb. */
export function hexColor(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v : null;
}

/** Слаг каталога проверяется по набору символов: иначе подделанная запись
 *  уводит URL клона на чужой путь git-хоста. */
const SLUG_OK = /^[a-z0-9_.-]+$/i;
const slugOk = (v: string): boolean => SLUG_OK.test(v) && !/^[.]+$/.test(v);

function parseEntry(e: RawEntry): CatalogEntry | null {
  const org = typeof e.organization?.slug === "string" ? e.organization.slug : null;
  const repo = typeof e.slug === "string" ? e.slug : null;
  if (!org || !repo) return null;
  if (!slugOk(org) || !slugOk(repo)) return null;
  const ratingValue = typeof e.rating?.value === "number" ? e.rating.value : null;
  // живой API отдает language объектом {name, color}, а не строкой
  const language = typeof e.language === "string" ? e.language : typeof e.language?.name === "string" ? e.language.name : null;
  return {
    org,
    repo,
    name: typeof e.name === "string" ? e.name : null,
    language,
    visibility: typeof e.visibility === "string" ? e.visibility : null,
    description: typeof e.description === "string" ? e.description : null,
    is_empty: e.is_empty === true,
    last_updated: typeof e.last_updated === "string" ? e.last_updated : null,
    likes: ratingValue !== null ? Math.round(ratingValue) : null,
    rating_percentile: typeof e.rating?.percentile === "number" ? e.rating.percentile : null,
    default_branch: typeof e.default_branch === "string" ? e.default_branch : null,
    clone_url_https: typeof e.clone_url?.https === "string" ? e.clone_url.https : null,
    web_url: typeof e.web_url === "string" ? e.web_url : null,
    logo_url: typeof e.logo?.url === "string" && e.logo.url !== "" ? e.logo.url : null,
    language_color: typeof e.language === "object" && e.language !== null ? hexColor(e.language.color) : null,
  };
}

/**
 * Форма ответа проверена живым зондом (scripts/probe-catalog.ts): список в
 * `repositories`, курсор в `next_page_token`, пустой или отсутствующий
 * курсор – конец.
 */
export const CATALOG_PAGE_SIZE = 100;
export const CATALOG_SORT_BY = "created_at";

export async function enumerateCatalog(client: ScClient, opts: CatalogOptions = {}): Promise<CatalogResult> {
  const maxPages = opts.maxPages ?? 1000;
  const publicOnly = opts.publicOnly ?? true;
  const entries: CatalogEntry[] = [];
  let token: string | null = null;
  let pages = 0;
  let skippedBadEntries = 0;
  while (pages < maxPages) {
    const path = `/repos?page_size=${CATALOG_PAGE_SIZE}&sort_by=${CATALOG_SORT_BY}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) {
      return {
        ok: false,
        entries,
        pages,
        truncated: true,
        skippedBadEntries,
        error: { status: res.status, detail: res.error ?? res.bodyText.slice(0, 200) },
      };
    }
    pages++;
    const body = res.json as { repositories?: RawEntry[]; next_page_token?: unknown } | null;
    // 200 без массива `repositories` – сбой формы, а не пустой каталог: иначе
    // «в каталоге никого» вытеснило бы из рейтинга все репозитории
    if (!Array.isArray(body?.repositories)) {
      return {
        ok: false,
        entries,
        pages,
        truncated: true,
        skippedBadEntries,
        error: { status: res.status, detail: `page ${pages}: 200 without a "repositories" array` },
      };
    }
    const list = body!.repositories!;
    for (const raw of list) {
      const e = parseEntry(raw);
      if (e === null) {
        skippedBadEntries++;
        continue;
      }
      if (!publicOnly || e.visibility === "public") entries.push(e);
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) {
      return { ok: true, entries, pages, truncated: false, skippedBadEntries };
    }
    token = next;
  }
  return { ok: true, entries, pages, truncated: true, skippedBadEntries };
}
