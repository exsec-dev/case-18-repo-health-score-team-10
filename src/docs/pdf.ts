// PDF документации – из той же модели, что раздел /docs (src/docs/model.ts): обложка,
// содержание, страницы в порядке оглавления, каждая с новой страницы листа. Шрифт,
// цвета и поля – как у PDF-отчета карточки (src/report/pdf.ts).
import pdfmake from "pdfmake";
import { breakable, COLORS, LABEL_COLORS } from "../report/pdf";
import type { DocBlock, DocLine, DocsBundle, TocNode, UiVariant } from "./model";
import { linePlain } from "./model";

type PdfNode = Record<string, unknown>;

const SIDE = 56;
const TOP = 48;
const BOTTOM = 52;
const PAGE_H = 841.89;

const SIZE = { body: 10, h1: 20, h2: 14, h3: 11.5, small: 8.5, code: 8.5 } as const;
const NOTE_COLORS = { info: { bg: "#eef3fd", bar: "#4768c2" }, warning: { bg: "#fff4ca", bar: "#a07c00" } } as const;
const CODE_BG = "#f5f5f5";
const UI_BG = "#ececec";

/**
 * Цвета тега по виду: Label – как в PDF-отчете (LABEL_COLORS, светлая тема uikit), лиги –
 * сплошной тон градиента `--rh-league-*` из theme.css (pdfmake не рисует градиент в тексте).
 */
function uiColors(variant: UiVariant | null): { bg: string; fg: string } {
  switch (variant) {
    case "label-success":
    case "label-warning":
    case "label-danger":
    case "label-unknown":
      return LABEL_COLORS[variant.slice("label-".length) as "success" | "warning" | "danger" | "unknown"];
    case "label-info":
      return { bg: "#dcebfb", fg: "#1f5fa8" };
    case "label-utility":
      return { bg: "#ece3f7", fg: "#6a3fb0" };
    case "league-gold":
      return { bg: "#ecd9a0", fg: "#5c4600" };
    case "league-silver":
      return { bg: "#d9dee4", fg: "#3e464f" };
    case "league-bronze":
      return { bg: "#ebc9ac", fg: "#673912" };
    default:
      return { bg: UI_BG, fg: COLORS.ink };
  }
}

/** Якорь PDF: страница или заголовок на ней. */
const dest = (slug: string, anchor?: string | null) => (anchor ? `p:${slug}#${anchor}` : `p:${slug}`);

function inlines(line: DocLine, breakLong = false): PdfNode[] {
  return line.map((f) => {
    const text = breakLong ? breakable(f.text) : f.text;
    switch (f.kind) {
      case "strong":
        return { text, bold: true };
      case "code":
        return { text, background: CODE_BG, fontSize: SIZE.code, color: COLORS.ink };
      // тег элемента интерфейса – подложка цвета элемента UI; иконки есть только на сайте
      case "ui": {
        const c = uiColors(f.variant);
        return { text: ` ${text} `, background: c.bg, color: c.fg };
      }
      case "link":
        return f.target ? { text, color: COLORS.link, linkToDestination: dest(f.target.slug, f.target.anchor) } : { text, color: COLORS.link, link: f.href };
      default:
        return { text };
    }
  });
}

/** Ширины колонок: короткие колонки – по содержимому, остальные делят остаток. */
function tableWidths(head: DocLine[], rows: DocLine[][]): (string | number)[] {
  return head.map((h, c) => {
    const longest = Math.max(linePlain(h).length, ...rows.map((r) => linePlain(r[c] ?? []).length));
    return longest <= 14 ? "auto" : "*";
  });
}

function blockNodes(blocks: DocBlock[], slug: string): PdfNode[] {
  return blocks.map((b) => blockNode(b, slug));
}

function blockNode(block: DocBlock, slug: string): PdfNode {
  switch (block.kind) {
    case "heading":
      return {
        text: inlines(block.content),
        id: dest(slug, block.id),
        fontSize: block.level === 2 ? SIZE.h2 : SIZE.h3,
        bold: true,
        margin: block.level === 2 ? [0, 14, 0, 6] : [0, 10, 0, 4],
        headlineLevel: block.level,
      };
    case "paragraph":
      return { text: inlines(block.content), margin: [0, 0, 0, 7] };
    case "list": {
      const items = block.items.map((item) => ({ stack: blockNodes(item, slug).map((n) => ({ ...n, margin: [0, 0, 0, 3] })) }));
      return block.ordered ? { ol: items, margin: [0, 0, 0, 7] } : { ul: items, margin: [0, 0, 0, 7] };
    }
    case "table":
      return {
        table: {
          headerRows: 1,
          widths: tableWidths(block.head, block.rows),
          body: [
            block.head.map((h, c) => ({ text: inlines(h, true), bold: true, fillColor: "#f7f7f7", alignment: block.align[c] ?? "left" })),
            ...block.rows.map((r) => r.map((cell, c) => ({ text: inlines(cell, true), alignment: block.align[c] ?? "left" }))),
          ],
        },
        layout: {
          hLineWidth: () => 0.75,
          vLineWidth: () => 0.75,
          hLineColor: () => COLORS.rule,
          vLineColor: () => COLORS.rule,
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
        fontSize: 9,
        margin: [0, 2, 0, 10],
      };
    case "code":
      return {
        table: { widths: ["*"], body: [[{ text: breakable(block.text), fontSize: SIZE.code, preserveLeadingSpaces: true, color: COLORS.ink }]] },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => CODE_BG, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
        margin: [0, 0, 0, 9],
      };
    case "note": {
      const c = NOTE_COLORS[block.tone];
      const title = block.title ?? (block.tone === "warning" ? "Важно" : "Примечание");
      return {
        table: { widths: ["*"], body: [[{ stack: [{ text: title, bold: true, margin: [0, 0, 0, 3] }, ...blockNodes(block.blocks, slug)] }]] },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: (i: number) => (i === 0 ? 3 : 0),
          vLineColor: () => c.bar,
          fillColor: () => c.bg,
          paddingLeft: () => 10,
          paddingRight: () => 10,
          paddingTop: () => 7,
          paddingBottom: () => 1,
        },
        margin: [0, 2, 0, 10],
      };
    }
  }
}

/** Группа оглавления, в которую входит страница (для надзаголовка). */
function groupOf(toc: TocNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: TocNode[], group: string | null) => {
    for (const n of nodes) {
      if (n.kind === "page") {
        if (group) out.set(n.slug, group);
      } else walk(n.children, n.title);
    }
  };
  walk(toc, null);
  return out;
}

export interface DocsPdfMeta {
  /** дата сборки для обложки: «28.09.2026» */
  date: string;
  /** адрес раздела на стенде для обложки */
  siteUrl: string;
}

export function buildDocsPdf(bundle: DocsBundle, meta: DocsPdfMeta): PdfNode {
  const groups = groupOf(bundle.toc);
  const content: PdfNode[] = [
    // обложка
    { text: "HealthCraft", fontSize: 34, bold: true, margin: [0, 200, 0, 8] },
    { text: "Документация", fontSize: 20, color: COLORS.ink2, margin: [0, 0, 0, 24] },
    { text: "Оценка здоровья открытых репозиториев SourceCraft", fontSize: 12, color: COLORS.ink2, margin: [0, 0, 0, 4] },
    { text: [{ text: meta.siteUrl, link: meta.siteUrl, color: COLORS.link }], fontSize: 11, margin: [0, 0, 0, 4] },
    { text: `Версия от ${meta.date}`, fontSize: 10, color: COLORS.muted },
    // содержание
    { toc: { title: { text: "Содержание", fontSize: SIZE.h1, bold: true, margin: [0, 0, 0, 14] }, numberStyle: { color: COLORS.muted } }, pageBreak: "before" },
  ];
  let lastGroup: string | null = null;
  for (const page of bundle.pages) {
    const group = groups.get(page.slug) ?? null;
    const head: PdfNode[] = [];
    if (group && group !== lastGroup) {
      head.push({ text: group, fontSize: 9, color: COLORS.muted, bold: true, tocItem: true, tocStyle: { bold: true }, tocMargin: [0, 8, 0, 2], margin: [0, 0, 0, 4] });
    }
    // с нового листа – страница вне группы и первая страница группы; внутри группы
    // страницы идут подряд (иначе короткие страницы оставляли полупустые листы)
    const newSheet = group === null || group !== lastGroup;
    lastGroup = group;
    head.push({
      text: page.title,
      id: dest(page.slug),
      fontSize: SIZE.h1,
      bold: true,
      tocItem: true,
      tocMargin: [group ? 14 : 0, 2, 0, 2],
      margin: [0, 0, 0, 12],
    });
    content.push(
      newSheet ? { stack: head, pageBreak: "before" } : { stack: head, margin: [0, 28, 0, 0], headlineLevel: 1 },
      ...blockNodes(page.blocks, page.slug),
    );
  }
  return {
    info: { title: "HealthCraft – документация", creator: "HealthCraft" },
    pageSize: "A4",
    pageMargins: [SIDE, TOP, SIDE, BOTTOM],
    defaultStyle: { font: "Inter", fontSize: SIZE.body, lineHeight: 1.3, color: COLORS.ink },
    footer: (current: number, count: number) =>
      current === 1
        ? null
        : {
            columns: [
              { text: "HealthCraft – документация", fontSize: SIZE.small, color: COLORS.muted },
              { text: `${current}/${count}`, fontSize: SIZE.small, color: COLORS.muted, alignment: "right" },
            ],
            margin: [SIDE, 20, SIDE, 0],
          },
    // заголовок не остается последним на листе
    pageBreakBefore: (node: { headlineLevel?: number; startPosition?: { top: number } }, following: unknown[]) =>
      node.headlineLevel !== undefined && (following.length === 0 || (node.startPosition?.top ?? 0) > PAGE_H - BOTTOM - 90),
    content,
  };
}

export async function renderDocsPdf(bundle: DocsBundle, meta: DocsPdfMeta): Promise<Buffer> {
  return pdfmake.createPdf(buildDocsPdf(bundle, meta)).getBuffer();
}
