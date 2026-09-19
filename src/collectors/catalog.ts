// catalog.ts — каталог-энумерация (Б2 В1; Ф2.5 В4.2a): документированный
// GET /repos (DiscoverRepositories, docs/api-spec/sourcecraft.swagger.json).
// В4.2a: `page_size=100` (максимум спеки) и `sort_by=created_at` —
// порядок по умолчанию `-rating` НЕ стабилен при пагинации (спека: «rating
// changes can cause repositories to be skipped or returned more than once»),
// а 20 записей на страницу превращали 27 446 репо в 1373 запроса вместо 275
// (живой замер 17.09). Потолок страниц — предохранитель, не бюджет приёмки.
// Эндпоинт по построению отдаёт только публичные репо; параметра
// `visibility` в спеке нет, клиентский фильтр по явному полю остаётся
// (видимость — свойство репо, решение Екатерины 17.09).
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
  /** rating.value из каталога (лайки-производная, не целые «лайки» API) */
  likes: number | null;
  rating_percentile: number | null;
  default_branch: string | null;
  clone_url_https: string | null;
  web_url: string | null;
  /** logo.url репозитория (картинка платформы; нет — null, UI рисует инициалы) */
  logo_url: string | null;
  /** language.color платформы (#rrggbb; дисплей — точка языка) */
  language_color: string | null;
}

export interface CatalogResult {
  ok: boolean;
  /** записи public-репо (клиентский фильтр поверх серверного) */
  entries: CatalogEntry[];
  /** сколько страниц фактически прочитано */
  pages: number;
  /** true = упёрлись в потолок страниц, каталог не дочитан */
  truncated: boolean;
  /** В4.4 (кластер K/З5): записей отброшено гардом слагов/формы за обход */
  skippedBadEntries: number;
  /** первая ошибка канала, если ok=false */
  error?: { status: number; detail: string };
}

export interface CatalogOptions {
  maxPages?: number;
  /** только public (default true; серверу шлём параметр, плюс клиентский фильтр) */
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

/** Цвет из API идёт в style — только #rgb/#rrggbb, иначе null. */
export function hexColor(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v : null;
}

/** В4.4 (кластер K/З5): слаг каталога обязан пройти charset-гард — иначе
 *  сконструированная запись уводит клон-URL на чужой путь git-хоста. */
const SLUG_OK = /^[a-z0-9_.-]+$/i;
const slugOk = (v: string): boolean => SLUG_OK.test(v) && !/^[.]+$/.test(v);

function parseEntry(e: RawEntry): CatalogEntry | null {
  const org = typeof e.organization?.slug === "string" ? e.organization.slug : null;
  const repo = typeof e.slug === "string" ? e.slug : null;
  if (!org || !repo) return null;
  if (!slugOk(org) || !slugOk(repo)) return null;
  const ratingValue = typeof e.rating?.value === "number" ? e.rating.value : null;
  // live 15.09: language — объект {name, color}, не строка
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
 * Полный обход каталога. Механизм заземлён живым зондом 15.09
 * (scripts/probe-catalog.ts): список в `repositories`, курсор в
 * `next_page_token`, пустой/отсутствующий курсор = конец.
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
    // M7, обратный край: 200 без массива `repositories` — это СБОЙ формы, а не
    // дочитанный пустой каталог. Прежний код читал его как «в каталоге никого»
    // и уносил в эвикцию весь рейтинг
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
