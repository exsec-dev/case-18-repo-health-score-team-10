// Документация с диска: docs/guide/toc.md задает порядок, остальные *.md – страницы.
// Сборка проверяет, что оглавление и файлы совпадают, а каждая внутренняя ссылка ведет
// на существующую страницу и заголовок. Ошибки не роняют сервер (раздел покажет то,
// что разобралось), но тест docs-content требует их отсутствия.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DocBlock, DocPage, DocsBundle, DocLine } from "./model";
import { tocPages } from "./model";
import { parsePage, parseToc, slugOfFile } from "./parse";

/** Ширина и высота PNG из заголовка IHDR; не PNG или файла нет — null. */
function pngSize(path: string): { width: number; height: number } | null {
  try {
    const head = readFileSync(path).subarray(0, 24);
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** Каталог страниц – от модуля, не от cwd (как шрифты отчета). */
export const DOCS_DIR = resolve(import.meta.dir, "../../docs/guide");
export const DOCS_PDF_URL = "/docs/healthcraft.pdf";

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** Картинка документации: только имя файла из docs/guide/images, без путей. */
export function docsImageResponse(name: string, dir: string = DOCS_DIR): Response {
  const m = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/i.exec(name);
  const path = m ? join(dir, "images", name) : null;
  if (!m || !path || !existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(path), { headers: { "content-type": IMAGE_TYPES[m[1]!.toLowerCase()]!, "cache-control": "public, max-age=3600" } });
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function linksOf(blocks: DocBlock[]): DocLine[] {
  const lines: DocLine[] = [];
  for (const b of blocks) {
    if (b.kind === "heading" || b.kind === "paragraph") lines.push(b.content);
    else if (b.kind === "list") for (const item of b.items) lines.push(...linksOf(item));
    else if (b.kind === "table") lines.push(...b.head, ...b.rows.flat());
    else if (b.kind === "note") lines.push(...linksOf(b.blocks));
  }
  return lines;
}

export interface LoadedDocs {
  bundle: DocsBundle;
  errors: string[];
}

export function loadDocs(dir: string = DOCS_DIR): LoadedDocs {
  const errors: string[] = [];
  let files: string[];
  try {
    files = listMarkdown(dir);
  } catch (e) {
    return { bundle: { toc: [], pages: [], pdfUrl: DOCS_PDF_URL }, errors: [`нет каталога ${dir}: ${(e as Error).message}`] };
  }
  const bySlug = new Map<string, DocPage>();
  let toc: DocsBundle["toc"] = [];
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    if (file === "toc.md") {
      const parsed = parseToc(source);
      toc = parsed.toc;
      errors.push(...parsed.errors);
      continue;
    }
    const parsed = parsePage(source, file);
    errors.push(...parsed.errors);
    bySlug.set(slugOfFile(file), parsed.page);
  }
  if (!files.includes("toc.md")) errors.push("нет docs/guide/toc.md");

  const order = tocPages(toc);
  const pages: DocPage[] = [];
  const seen = new Set<string>();
  for (const entry of order) {
    const page = bySlug.get(entry.slug);
    if (!page) errors.push(`toc.md: страницы «${entry.slug || "index"}» нет`);
    else if (seen.has(entry.slug)) errors.push(`toc.md: страница «${entry.slug}» указана дважды`);
    else {
      pages.push(page);
      seen.add(entry.slug);
    }
  }
  for (const slug of bySlug.keys()) if (!seen.has(slug)) errors.push(`страница «${slug || "index"}» не указана в toc.md`);

  // картинки: файл должен лежать в docs/guide/images
  const imagesOf = (blocks: DocBlock[]): string[] =>
    blocks.flatMap((b) => (b.kind === "image" ? [b.src] : b.kind === "list" ? b.items.flatMap(imagesOf) : b.kind === "note" ? imagesOf(b.blocks) : []));
  for (const page of pages) {
    for (const src of imagesOf(page.blocks)) if (!existsSync(join(dir, src))) errors.push(`${page.slug || "index"}: нет файла картинки docs/guide/${src}`);
  }
  // размер картинки — в блок: страница держит место под скриншот до его загрузки,
  // и текст ниже не прыгает (переход к якорю под картинкой попадает куда нужно)
  const sizeImages = (blocks: DocBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === "image") Object.assign(b, pngSize(join(dir, b.src)) ?? {});
      else if (b.kind === "list") b.items.forEach(sizeImages);
      else if (b.kind === "note") sizeImages(b.blocks);
    }
  };
  for (const page of pages) sizeImages(page.blocks);
  for (const page of pages) {
    for (const line of linksOf(page.blocks)) {
      for (const f of line) {
        if (f.kind !== "link" || !f.target) continue;
        const target = bySlug.get(f.target.slug);
        if (!target) errors.push(`${page.slug || "index"}: ссылка «${f.href}» – нет страницы «${f.target.slug}»`);
        else if (f.target.anchor && !target.headings.some((h) => h.id === f.target!.anchor)) {
          errors.push(`${page.slug || "index"}: ссылка «${f.href}» – на странице «${f.target.slug || "index"}» нет заголовка #${f.target.anchor}`);
        }
      }
    }
  }
  return { bundle: { toc, pages, pdfUrl: DOCS_PDF_URL }, errors };
}

const pdfCache = new Map<string, Promise<Buffer>>();

/** Дата «ДД.ММ.ГГГГ» по Москве – для обложки PDF. */
function mskDate(now: Date): string {
  const d = new Date(now.getTime() + 3 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

/**
 * PDF документации. Собирается один раз на содержимое (ключ – текст сборки): в
 * production – один раз за процесс, в разработке – после правки страниц.
 */
export async function docsPdfResponse(loaded: LoadedDocs, publicBaseUrl: string, now: Date = new Date()): Promise<Response> {
  const key = JSON.stringify(loaded.bundle);
  let pdf = pdfCache.get(key);
  if (!pdf) {
    pdfCache.clear();
    const { renderDocsPdf } = await import("./pdf");
    pdf = renderDocsPdf(loaded.bundle, { date: mskDate(now), siteUrl: `${publicBaseUrl}/docs` });
    pdfCache.set(key, pdf);
  }
  try {
    const body = await pdf;
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": "application/pdf",
        // открывается во вкладке браузера; имя – для «Сохранить как»
        "content-disposition": `inline; filename="HealthCraft-docs.pdf"; filename*=UTF-8''${encodeURIComponent("HealthCraft – документация.pdf")}`,
        "cache-control": "no-cache",
      },
    });
  } catch (error) {
    pdfCache.clear();
    console.error(`[docs.pdf] ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ error: { code: "pdf_failed", message: "Не удалось собрать PDF документации – попробуйте позже" } }, { status: 500 });
  }
}

/**
 * Кэш сборки. В разработке файлы перечитываются на каждом запросе – правка страницы
 * видна по F5; в production документация читается один раз.
 */
export function docsSource(opts: { reload: boolean; dir?: string; log?: (m: string) => void }): () => LoadedDocs {
  let cached: LoadedDocs | null = null;
  return () => {
    if (cached && !opts.reload) return cached;
    const next = loadDocs(opts.dir);
    if (next.errors.length > 0 && (!cached || JSON.stringify(cached.errors) !== JSON.stringify(next.errors))) {
      opts.log?.(`[docs] ${next.errors.length} ошибок разбора:\n  ${next.errors.slice(0, 20).join("\n  ")}`);
    }
    cached = next;
    return next;
  };
}
