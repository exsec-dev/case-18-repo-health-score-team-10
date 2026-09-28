// Разбор страниц документации: подмножество Markdown из стайлгайда документации
// (заголовки ##/###, абзацы, **жирный**, `код`, ссылки, списки с 1 уровнем вложенности,
// таблицы GFM, блоки кода, врезки {% note %} как у Diplodoc, HTML-комментарии).
// Все остальное – ошибка разбора: лучше упасть в тесте, чем молча показать сырой текст.
import type { DocBlock, DocHeading, DocInline, DocLine, DocPage, DocTarget, TocNode, UiIcon, UiVariant } from "./model";
import { UI_ICONS, UI_VARIANTS } from "./model";

export interface ParsedPage {
  page: DocPage;
  errors: string[];
}

/** `method/scores.md` → `method/scores`, `index.md` → ``, `guide/index.md` → `guide`. */
export function slugOfFile(file: string): string {
  const noExt = file.replace(/\\/g, "/").replace(/\.md$/, "");
  if (noExt === "index") return "";
  return noExt.endsWith("/index") ? noExt.slice(0, -"/index".length) : noExt;
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** id заголовка без явного `{#id}`: транслит, латиница, цифры и дефисы. */
export function headingId(text: string): string {
  const latin = [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  return latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

// ---------- инлайн ----------

/**
 * Ссылка из текста страницы: `https://…` – внешняя; `…md#якорь` или `#якорь` – внутренняя,
 * путь относительно файла страницы.
 */
function resolveLink(href: string, file: string, errors: string[]): { href: string; target: DocTarget | null } {
  if (/^https:\/\//.test(href)) return { href, target: null };
  const [path, anchor] = href.split("#", 2) as [string, string | undefined];
  if (path === "") return { href, target: { slug: slugOfFile(file), anchor: anchor ?? null } };
  if (!path.endsWith(".md")) {
    errors.push(`ссылка «${href}»: нужен https:// или путь к .md`);
    return { href, target: null };
  }
  const baseDir = file.replace(/\\/g, "/").split("/").slice(0, -1);
  const parts = [...baseDir];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) errors.push(`ссылка «${href}» ведет за пределы docs/guide`);
      parts.pop();
    } else parts.push(seg);
  }
  return { href, target: { slug: slugOfFile(parts.join("/")), anchor: anchor ?? null } };
}

const unescape = (s: string) => s.replace(/\\([\\`*_[\]()#|{}<>!-])/g, "$1");

export function parseInline(src: string, file: string, errors: string[]): DocLine {
  const out: DocInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // элемент интерфейса: [[Текст]] или [[иконка:Текст]]
    if (src.startsWith("[[", i)) {
      const end = src.indexOf("]]", i + 2);
      if (end > i + 2) {
        flush();
        const raw = src.slice(i + 2, end);
        const m = /^([a-z][a-z+-]*):(.+)$/.exec(raw);
        let icon: UiIcon | null = null;
        let variant: UiVariant | null = null;
        let text = raw;
        if (m) {
          for (const token of m[1]!.split("+")) {
            if ((UI_VARIANTS as readonly string[]).includes(token) && variant === null) variant = token as UiVariant;
            else if ((UI_ICONS as readonly string[]).includes(token) && icon === null) icon = token as UiIcon;
            else errors.push(`тег «[[${raw}]]»: «${token}» – ни вид (${UI_VARIANTS.join(", ")}), ни иконка (${UI_ICONS.join(", ")}), или повтор`);
          }
          text = m[2]!;
        }
        out.push({ kind: "ui", text: unescape(text.trim()), icon, variant });
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", text: unescape(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const close = src.indexOf("](", i + 1);
      const end = close > i ? src.indexOf(")", close + 2) : -1;
      if (close > i && end > close) {
        flush();
        const text = unescape(src.slice(i + 1, close).replace(/\*\*|`/g, ""));
        const link = resolveLink(src.slice(close + 2, end).trim(), file, errors);
        out.push({ kind: "link", text, ...link });
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- блоки ----------

const LIST_RE = /^([-*]|\d+\.)\s+/;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const FENCE_RE = /^```/;
const NOTE_RE = /^\{%\s*note\s+(info|warning|tip|alert)(?:\s+"([^"]*)")?\s*%\}\s*$/;
const ENDNOTE_RE = /^\{%\s*endnote\s*%\}\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function startsBlock(line: string): boolean {
  const t = line.trimStart();
  return IMAGE_RE.test(t) || FENCE_RE.test(t) || t.startsWith("#") || t.startsWith("|") || LIST_RE.test(t) || NOTE_RE.test(t) || ENDNOTE_RE.test(t) || t.startsWith("<!--");
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

interface Ctx {
  file: string;
  errors: string[];
  headings: DocHeading[];
  ids: Set<string>;
}

function parseBlocks(lines: string[], ctx: Ctx, depth: number): DocBlock[] {
  const blocks: DocBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (t.startsWith("<!--")) {
      while (i < lines.length && !lines[i]!.includes("-->")) i++;
      i++;
      continue;
    }
    const note = NOTE_RE.exec(t);
    if (note) {
      const start = ++i;
      while (i < lines.length && !ENDNOTE_RE.test(lines[i]!.trim())) i++;
      if (i >= lines.length) ctx.errors.push(`врезка без {% endnote %}: «${t}»`);
      const tone = note[1] === "warning" || note[1] === "alert" ? "warning" : "info";
      blocks.push({ kind: "note", tone, title: note[2] ?? null, blocks: parseBlocks(lines.slice(start, i), ctx, depth + 1) });
      i++;
      continue;
    }
    if (ENDNOTE_RE.test(t)) {
      ctx.errors.push("{% endnote %} без начала врезки");
      i++;
      continue;
    }
    if (FENCE_RE.test(t)) {
      const lang = t.slice(3).trim();
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!.trim())) {
        body.push(lines[i]!.slice(Math.min(indent, indentOf(lines[i]!))));
        i++;
      }
      if (i >= lines.length) ctx.errors.push("блок кода без закрывающих ```");
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      i++;
      continue;
    }
    if (t.startsWith("#")) {
      const m = /^(#{1,6})\s+(.*?)(?:\s+\{#([a-z0-9-]+)\})?\s*$/.exec(t);
      const level = m ? m[1]!.length : 0;
      if (!m || level < 2 || level > 3 || depth > 0) {
        ctx.errors.push(`заголовок «${t}»: допустимы ## и ### вне списков и врезок, # – только первой строкой`);
      } else {
        let id = m[3] ?? headingId(m[2]!);
        if (ctx.ids.has(id)) {
          if (m[3]) ctx.errors.push(`id заголовка «${id}» повторяется`);
          let n = 2;
          while (ctx.ids.has(`${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
        ctx.ids.add(id);
        const content = parseInline(m[2]!, ctx.file, ctx.errors);
        ctx.headings.push({ level: level as 2 | 3, id, text: content.map((f) => f.text).join("") });
        blocks.push({ kind: "heading", level: level as 2 | 3, id, content });
      }
      i++;
      continue;
    }
    const img = IMAGE_RE.exec(t);
    if (img) {
      // картинка – отдельной строкой; путь относительно файла страницы, только каталог images/
      const baseDir = ctx.file.replace(/\\/g, "/").split("/").slice(0, -1);
      const parts = [...baseDir];
      for (const seg of img[2]!.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      const src = parts.join("/");
      if (!src.startsWith("images/") || !IMAGE_EXT.test(src)) ctx.errors.push(`картинка «${img[2]}»: только файлы docs/guide/images/*.png|jpg|webp`);
      if (!img[1]!.trim()) ctx.errors.push(`картинка «${img[2]}» без подписи`);
      blocks.push({ kind: "image", src, alt: unescape(img[1]!.trim()) });
      i++;
      continue;
    }
    if (t.startsWith("|")) {
      const sep = lines[i + 1]?.trim() ?? "";
      if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(sep)) {
        ctx.errors.push(`таблица без строки-разделителя после «${t.slice(0, 40)}»`);
        i++;
        continue;
      }
      const head = splitRow(t);
      const align = splitRow(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left") as "left" | "right" | "center");
      const rows: DocLine[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = splitRow(lines[i]!);
        if (cells.length !== head.length) ctx.errors.push(`строка таблицы: ${cells.length} ячеек вместо ${head.length}: «${lines[i]!.trim().slice(0, 50)}»`);
        rows.push(head.map((_, c) => parseInline(cells[c] ?? "", ctx.file, ctx.errors)));
        i++;
      }
      blocks.push({ kind: "table", align, head: head.map((h) => parseInline(h, ctx.file, ctx.errors)), rows });
      continue;
    }
    const lm = LIST_RE.exec(t);
    if (lm && indentOf(line) === 0) {
      const ordered = /\d/.test(lm[1]!);
      const items: DocBlock[][] = [];
      if (depth > 1) ctx.errors.push("вложенность списков глубже 1 уровня");
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = LIST_RE.exec(cur);
        if (!m || indentOf(cur) !== 0 || /\d/.test(m[1]!) !== ordered) break;
        const width = m[0].length;
        const item: string[] = [cur.slice(width)];
        i++;
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === "") {
            // пустая строка внутри пункта – только если дальше идет отступ
            let j = i;
            while (j < lines.length && lines[j]!.trim() === "") j++;
            if (j < lines.length && indentOf(lines[j]!) > 0) {
              for (; i < j; i++) item.push("");
              continue;
            }
            break;
          }
          if (indentOf(next) > 0) {
            item.push(next.slice(Math.min(width, indentOf(next))));
            i++;
            continue;
          }
          // строка без отступа: продолжение абзаца пункта, если это не новый блок
          if (!startsBlock(next) && item[item.length - 1]!.trim() !== "") {
            item.push(next);
            i++;
            continue;
          }
          break;
        }
        items.push(parseBlocks(item, ctx, depth + 1));
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (indentOf(line) > 0 && depth === 0) ctx.errors.push(`строка с отступом вне списка: «${t.slice(0, 50)}»`);
    // абзац
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i]!.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", content: parseInline(para.join(" "), ctx.file, ctx.errors) });
  }
  return blocks;
}

/** Страница из файла `file` (путь относительно docs/guide). */
export function parsePage(source: string, file: string): ParsedPage {
  const errors: string[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const first = /^#\s+(.+?)\s*$/.exec(lines[i] ?? "");
  if (!first) errors.push("первая строка страницы – «# Заголовок»");
  const ctx: Ctx = { file, errors, headings: [], ids: new Set() };
  const blocks = parseBlocks(lines.slice(first ? i + 1 : i), ctx, 0);
  return {
    page: { slug: slugOfFile(file), title: first ? unescape(first[1]!) : file, blocks, headings: ctx.headings },
    errors: errors.map((e) => `${file}: ${e}`),
  };
}

/**
 * Оглавление из `toc.md`: вложенный список, пункт – ссылка на страницу или
 * подпись группы с вложенным списком.
 */
export function parseToc(source: string): { toc: TocNode[]; errors: string[] } {
  const parsed = parsePage(source, "toc.md");
  const errors = [...parsed.errors];
  const list = parsed.page.blocks.find((b) => b.kind === "list");
  const nodes = (block: DocBlock | undefined): TocNode[] => {
    if (!block || block.kind !== "list") return [];
    return block.items.flatMap((item): TocNode[] => {
      const para = item[0];
      if (!para || para.kind !== "paragraph") {
        errors.push("toc.md: пункт без подписи");
        return [];
      }
      const only = para.content.length === 1 ? para.content[0]! : null;
      if (only?.kind === "link" && only.target) return [{ kind: "page", title: only.text, slug: only.target.slug }];
      const children = nodes(item.find((b) => b.kind === "list"));
      if (children.length === 0) errors.push(`toc.md: «${para.content.map((f) => f.text).join("")}» – ни ссылка на страницу, ни группа`);
      return [{ kind: "group", title: para.content.map((f) => f.text).join(""), children }];
    });
  };
  return { toc: nodes(list), errors };
}
