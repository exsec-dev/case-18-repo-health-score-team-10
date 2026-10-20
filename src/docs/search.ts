// Поиск по документации – чистая логика без React: индекс разделов, основа слова,
// ранжирование. Интерфейс поиска – src/web/DocsSearch.tsx.
import type { DocBlock, DocLine, DocPage } from "./model";
import { linePlain } from "./model";

export interface SearchEntry {
  slug: string;
  /** id раздела; null – начало страницы */
  anchor: string | null;
  page: string;
  section: string | null;
  text: string;
}

function blocksText(blocks: DocBlock[]): string {
  const out: string[] = [];
  const line = (l: DocLine) => out.push(linePlain(l));
  const walk = (bs: DocBlock[]) => {
    for (const b of bs) {
      if (b.kind === "paragraph") line(b.content);
      else if (b.kind === "list") b.items.forEach(walk);
      else if (b.kind === "table") [...b.head, ...b.rows.flat()].forEach(line);
      else if (b.kind === "note") walk(b.blocks);
      else if (b.kind === "code") out.push(b.text);
    }
  };
  walk(blocks);
  return out.join(" ");
}

/** Разделы всех страниц: текст до первого заголовка и каждый раздел ## / ### отдельно. */
export function buildSearchIndex(pages: DocPage[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const p of pages) {
    let cur: SearchEntry = { slug: p.slug, anchor: null, page: p.title, section: null, text: "" };
    let buf: DocBlock[] = [];
    const flush = () => {
      cur.text = blocksText(buf);
      out.push(cur);
    };
    for (const b of p.blocks) {
      if (b.kind === "heading") {
        flush();
        cur = { slug: p.slug, anchor: b.id, page: p.title, section: linePlain(b.content), text: "" };
        buf = [];
      } else buf.push(b);
    }
    flush();
  }
  return out;
}

export const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Типичные окончания существительных и прилагательных – от длинных к коротким. */
const ENDINGS = ["ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ых", "их", "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ей", "ом", "ем", "ам", "ям", "ах", "ях", "ов", "ев", "ую", "юю", "а", "я", "о", "е", "и", "ы", "у", "ю", "ь", "й"];

/** Основа слова: у слов длиннее 4 букв срезается окончание, основа – не короче 4 букв («оценки» → «оценк»). */
export function stem(word: string): string {
  const w = norm(word);
  if (w.length <= 4) return w;
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 4) return w.slice(0, -e.length);
  return w;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
  /** фрагмент текста вокруг первого совпадения; null – совпало только в заголовке */
  snippet: string | null;
}

export function searchDocs(index: SearchEntry[], query: string, limit = 8): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const e of index) {
    const page = norm(e.page);
    const section = norm(e.section ?? "");
    const text = norm(e.text);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const s = (page.includes(t) ? 6 : 0) + (section.includes(t) ? 4 : 0) + (text.includes(t) ? 1 : 0);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    // начало страницы при совпадении в заголовке страницы – выше ее разделов
    if (e.anchor === null && terms.every((t) => page.includes(t))) score += 3;
    const at = terms.map((t) => text.indexOf(t)).filter((i) => i >= 0);
    const first = at.length > 0 ? Math.min(...at) : -1;
    const snippet = first >= 0 ? snippetAt(e.text, first) : null;
    hits.push({ entry: e, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Фрагмент вокруг совпадения — от границы слова: обрезка ровно за 50 знаков до
 * совпадения начинала фрагмент с середины слова («raft проверяет…»). Начало
 * сдвигается к началу предложения, если оно рядом, иначе — к ближайшему пробелу.
 */
function snippetAt(text: string, first: number): string {
  let from = Math.max(0, first - 50);
  if (from > 0) {
    const sentence = text.lastIndexOf(". ", first);
    if (sentence >= 0 && first - sentence <= 80) from = sentence + 2;
    else {
      const space = text.indexOf(" ", from);
      from = space >= 0 && space < first ? space + 1 : first;
    }
  }
  let to = Math.min(text.length, first + 110);
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > first) to = space;
  }
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

/** Основы слов запроса (слова короче 2 букв не ищутся). */
export function queryTerms(query: string): string[] {
  return norm(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .map(stem);
}
