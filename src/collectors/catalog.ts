// catalog.ts — каталог-энумерация (Б2): недокументированный
// GET /repos?page_token=<next_page_token> (20/стр, курсор; зонд
// 15.09 + scripts/probe-catalog.ts). Обход ≤100 страниц, фильтр
// public (запрос + клиентская гарантия), результат — записи каталога.
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
}

export interface CatalogResult {
  ok: boolean;
  /** записи public-репо (клиентский фильтр поверх серверного) */
  entries: CatalogEntry[];
  /** сколько страниц фактически прочитано */
  pages: number;
  /** true = упёрлись в потолок страниц, каталог не дочитан */
  truncated: boolean;
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
  language?: { name?: unknown } | string | null;
  visibility?: unknown;
  description?: unknown;
  is_empty?: unknown;
  last_updated?: unknown;
  rating?: { value?: unknown; percentile?: unknown };
  default_branch?: unknown;
  clone_url?: { https?: unknown };
  web_url?: unknown;
}

function parseEntry(e: RawEntry): CatalogEntry | null {
  const org = typeof e.organization?.slug === "string" ? e.organization.slug : null;
  const repo = typeof e.slug === "string" ? e.slug : null;
  if (!org || !repo) return null;
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
  };
}

/**
 * Полный обход каталога. Механизм заземлён живым зондом 15.09
 * (scripts/probe-catalog.ts): список в `repositories`, курсор в
 * `next_page_token`, пустой/отсутствующий курсор = конец.
 */
export async function enumerateCatalog(client: ScClient, opts: CatalogOptions = {}): Promise<CatalogResult> {
  const maxPages = opts.maxPages ?? 100;
  const publicOnly = opts.publicOnly ?? true;
  const entries: CatalogEntry[] = [];
  let token: string | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const path = `/repos?visibility=public${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await client.get(path);
    if (res.status !== 200) {
      return {
        ok: false,
        entries,
        pages,
        truncated: true,
        error: { status: res.status, detail: res.error ?? res.bodyText.slice(0, 200) },
      };
    }
    pages++;
    const body = res.json as { repositories?: RawEntry[]; next_page_token?: unknown } | null;
    const list = Array.isArray(body?.repositories) ? body!.repositories! : [];
    for (const raw of list) {
      const e = parseEntry(raw);
      if (e && (!publicOnly || e.visibility === "public")) entries.push(e);
    }
    const next = body?.next_page_token;
    if (typeof next !== "string" || next.length === 0) {
      return { ok: true, entries, pages, truncated: false };
    }
    token = next;
  }
  return { ok: true, entries, pages, truncated: true };
}
