// pdf.ts — PDF-выгрузка отчёта по карточке (В4.7, контракт П1; В4.9, К9.5).
//
// Рендерер той же модели блоков, из которой `markdown.ts` сериализует MD:
// содержание PDF равно содержанию MD построением, отличается только вид.
// Вид — эталон вида В4.9 (круг 4, `reports/2026-09-22-m49-design/`):
// Inter в двух весах, цвета — hex-снимки токенов светлой темы UI, плашки как
// `Label` (скругленный прямоугольник canvas под текстом), полосы одним
// темно-серым тоном `#6b6b6b`, шкала 3 зон, карточки действий, приложение с
// новой страницы. Аватара в шапке нет (снят как «ИИ-маркер» в круге 3).
//
// Механизм — решение владельца 21.09: серверный `pdfmake@0.3.11` (MIT), без
// Chrome. Модуль серверный: фронтенд его не импортирует.
//
// Безопасность: `pdfmake` умеет тянуть ресурсы по URL и с диска по ссылке из
// описания документа. Картинок и внешних ресурсов в модели нет, а политики
// закрыты явно: сеть — никогда, файловая система — только каталог шрифта.
//
// Шрифт — Inter (SIL OFL 1.1, `fonts/LICENSE.txt`): 4 файла (Regular,
// SemiBold и 2 курсива). Покрытие глифов закрыто тестом по cmap
// (tests/report-pdf.test.ts). Неизвестный глиф во внешних данных генерацию
// не роняет — fontkit рисует на его месте .notdef.
import pdfmake from "pdfmake";
import { join, resolve, sep } from "node:path";
import type { RepoCard } from "../api/repos";
import { buildReportModel } from "./build";
import { textWidth } from "./metrics";
import type { ActionItem, Block, CategoryRow, Chip, ChipTheme, Inline, InlineLine, ReportModel, TableColumn } from "./model";

/** Каталог шрифта — от модуля, не от cwd: сервер запускают из разных мест. */
export const FONT_DIR = join(import.meta.dir, "fonts");

/** Начертания Inter по слотам pdfmake: bold — SemiBold (вес 600, как заголовки Gravity UI). */
export const FONT_FILES = {
  normal: "Inter-Regular.ttf",
  bold: "Inter-SemiBold.ttf",
  italics: "Inter-Italic.ttf",
  bolditalics: "Inter-SemiBoldItalic.ttf",
} as const;

const FONT_FAMILY = "Inter";

function insideFontDir(path: string): boolean {
  const root = resolve(FONT_DIR);
  const target = resolve(path);
  return target.startsWith(root + sep);
}

pdfmake.setFonts({
  [FONT_FAMILY]: {
    normal: join(FONT_DIR, FONT_FILES.normal),
    bold: join(FONT_DIR, FONT_FILES.bold),
    italics: join(FONT_DIR, FONT_FILES.italics),
    bolditalics: join(FONT_DIR, FONT_FILES.bolditalics),
  },
});
// сеть — никогда: в модели отчёта нет ни картинок, ни ссылок на ресурсы
pdfmake.setUrlAccessPolicy(() => false);
// диск — только файлы шрифта
pdfmake.setLocalAccessPolicy(insideFontDir);

// ---------- токены вида (светлая тема UI, hex на белом — README эталона) ----------

type PdfNode = Record<string, unknown>;

export const COLORS = {
  /** text-primary rgba(0,0,0,.85) */
  ink: "#262626",
  /** text-complementary rgba(0,0,0,.7) */
  ink2: "#4d4d4d",
  /** text-secondary rgba(0,0,0,.58) */
  muted: "#6b6b6b",
  /** line-generic-solid */
  rule: "#e5e5e5",
  /** дорожка Progress (theme.css, В4.6) */
  track: "#f2f2f2",
  /** text-link */
  link: "#4768c2",
  /** все шкалы (полоса вклада, полосы баллов, покрытие) — один темно-серый тон (круг 4) */
  bar: "#6b6b6b",
  white: "#ffffff",
} as const;

/** Плашки `Label` (uikit 7.49.0): фон base-*-light, текст по теме. */
export const LABEL_COLORS: Record<ChipTheme, { bg: string; fg: string }> = {
  success: { bg: "#e2f7e1", fg: "#2a7227" },
  warning: { bg: "#fff4ca", fg: "#7d6200" },
  danger: { bg: "#ffd9d9", fg: "#c0100f" },
  unknown: { bg: "#f2f2f2", fg: "#4d4d4d" },
};

/** Лента зон шкалы — base-*-medium. */
export const ZONE_COLORS = { danger: "#ea0805", warning: "#a07c00", success: "#2f9f2b" } as const;

/** A4 = 595.28 × 841.89 pt; поля 48 слева и справа — рабочая ширина 499 pt. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const SIDE = 48;
const W = Math.floor(PAGE_W - 2 * SIDE);
const TOP = 40;
const BOTTOM = 44;

const width = (s: string, size: number, bold = false, spacing = 0): number => textWidth(FONT_DIR, bold ? FONT_FILES.bold : FONT_FILES.normal, s, size, spacing);

/** Сколько строк займет текст в колонке (жадный перенос по словам; для центрирования в строке таблицы). */
function linesOf(s: string, size: number, colWidth: number, bold = false): number {
  let lines = 1;
  let x = 0;
  const space = width(" ", size, bold);
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const w = width(word, size, bold);
    if (x > 0 && x + space + w > colWidth) {
      lines++;
      x = w;
    } else {
      x += (x > 0 ? space : 0) + w;
    }
  }
  return lines;
}

// ---------- инлайн ----------

type PdfText = { text: string; bold?: boolean; italics?: boolean; link?: string; color?: string; fontSize?: number };

function inlineNode(fragment: Inline): PdfText {
  switch (fragment.kind) {
    case "code":
      return { text: fragment.text, color: COLORS.muted, fontSize: 7 };
    case "em":
      return { text: fragment.text, italics: true };
    case "strong":
      return { text: fragment.text, bold: true, color: COLORS.ink };
    case "link":
      return { text: fragment.text, link: fragment.url, color: COLORS.link };
    default:
      return { text: fragment.text };
  }
}

/** Невидимая точка переноса (U+200B, в Inter нулевой ширины). */
export const BREAK = "\u200B";
/** Длиннее этого значение без пробелов не остаётся — иначе ячейка вылезает за поле. */
export const MAX_UNBROKEN = 24;

/**
 * Приёмка HQ В4.7: длинное значение без пробелов переносить негде, и ячейка
 * уходила за правый край страницы. Точки переноса ставятся только в слова
 * длиннее порога — после знаков структуры и, если их не хватает, через
 * каждые MAX_UNBROKEN символов; короткие значения не трогаются. Текст не
 * меняется — U+200B нулевой ширины, сверка с MD его выбрасывает.
 */
export function breakable(text: string): string {
  return text.replace(/\S+/g, (word) => {
    if (word.length <= MAX_UNBROKEN) return word;
    let out = "";
    let run = 0;
    for (const ch of word) {
      out += ch;
      run++;
      if (",:{[/._".includes(ch) || run >= MAX_UNBROKEN) {
        out += BREAK;
        run = 0;
      }
    }
    return out;
  });
}

const lineNodes = (line: InlineLine, breakLong = false): PdfText[] => line.map((f) => (breakLong ? { ...inlineNode(f), text: breakable(f.text) } : inlineNode(f)));

// ---------- элементы ----------

const LABEL_SIZES = { xs: { h: 15, pad: 6, r: 2.25 }, s: { h: 18, pad: 7.5, r: 3.75 } } as const;
const LABEL_FONT = 9.5;
/** высота строки Inter 9.5 pt при lineHeight 1 (ascender − descender ≈ 1.21 em) */
const LABEL_LINE = LABEL_FONT * 1.21;

/** Плашка как `Label` UI: скругленный прямоугольник canvas и текст поверх него. */
export function labelNode(chip: Chip, size: "xs" | "s" = "xs"): PdfNode {
  const { h, pad, r } = LABEL_SIZES[size];
  const { bg, fg } = LABEL_COLORS[chip.theme];
  const w = Math.ceil(width(chip.text, LABEL_FONT) + 2 * pad + 1);
  const inset = (h - LABEL_LINE) / 2;
  return {
    width: w,
    stack: [
      { canvas: [{ type: "rect", x: 0, y: 0, w, h, r, color: bg }] },
      { text: chip.text, color: fg, fontSize: LABEL_FONT, lineHeight: 1, noWrap: true, margin: [pad, -h + inset, 0, inset] },
    ],
  };
}

/** Горизонтальная линейка на всю ширину. */
const rule = (color: string = COLORS.rule, lineWidth = 0.75, margin: number[] = [0, 0, 0, 0]): PdfNode => ({
  canvas: [{ type: "line", x1: 0, y1: 0, x2: W, y2: 0, lineWidth, lineColor: color }],
  margin,
});

/** Полоса балла категории: дорожка и заливка одним темно-серым тоном (без цвета состояния). */
function scoreBar(score: number | null, w: number): PdfNode {
  if (score === null) return { text: "" };
  const fill = Math.max(0, Math.min(1, score / 100)) * w;
  return {
    canvas: [
      { type: "rect", x: 0, y: 0, w, h: 6, r: 3, color: COLORS.track },
      ...(fill > 0 ? [{ type: "rect", x: 0, y: 0, w: Math.max(fill, 6), h: 6, r: 3, color: COLORS.bar }] : []),
    ],
  };
}

// ---------- блоки ----------

function headerNode(block: Extract<Block, { kind: "header" }>): PdfNode {
  const left: PdfNode[] = [{ text: block.slug.replace("/", " / "), fontSize: 16, bold: true, lineHeight: 1 }];
  if (block.title) left.push({ text: lineNodes(block.title), fontSize: 8, color: COLORS.muted, margin: [0, 2, 0, 0] });
  left.push({ text: block.link.text, link: block.link.url, color: COLORS.link, fontSize: 8, margin: [0, 2, 0, 0] });
  const right: PdfNode[] = [{ text: block.doc, bold: true, fontSize: 9, alignment: "right" }];
  if (block.date) right.push({ text: block.date, fontSize: 8, color: COLORS.muted, alignment: "right", margin: [0, 1, 0, 0] });
  return {
    stack: [
      { columns: [{ width: "*", stack: left }, { width: "auto", stack: right, margin: [10, 6, 0, 0] }] },
      rule(COLORS.rule, 0.75, [0, 12, 0, 0]),
    ],
  };
}

function heroNode(block: Extract<Block, { kind: "hero" }>): PdfNode {
  const row: PdfNode =
    block.value === null
      ? { text: block.noneText, fontSize: 26, bold: true, color: COLORS.ink2, lineHeight: 1, margin: [0, 6, 0, 4] }
      : {
          columns: [
            { width: "auto", text: String(block.value), fontSize: 40, bold: true, characterSpacing: -0.8, lineHeight: 1, fontFeatures: ["tnum"] },
            { width: "auto", text: "из 100", fontSize: 10, color: COLORS.muted, margin: [6, 30, 0, 0] },
            ...(block.chip ? [{ ...labelNode(block.chip, "s"), margin: [12, 25, 0, 0] }] : []),
          ],
          columnGap: 0,
        };
  return {
    stack: [
      { text: block.label, fontSize: 9, color: COLORS.muted, margin: [0, 12, 0, 1] },
      row,
      { text: block.verdict, fontSize: 12, lineHeight: 1.1, margin: [0, 6, 0, 0] },
      ...block.notes.map((n) => ({ text: lineNodes(n), fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 4, 0, 0] })),
    ],
  };
}

function zonesNodes(block: Extract<Block, { kind: "contributions" }>): PdfNode[] {
  let x = 0;
  const strip = block.zones.map((z) => {
    const w = z.share * W;
    const rect = { type: "rect", x, y: 0, w: Math.max(0, w - (x + w < W - 0.5 ? 1.5 : 0)), h: 3, color: ZONE_COLORS[z.theme] };
    x += w;
    return rect;
  });
  return [
    { canvas: strip, margin: [0, 2, 0, 0] },
    {
      columns: block.zones.map((z, i) => ({ width: z.share * W, text: z.text, fontSize: 7.5, color: COLORS.ink2, margin: [i === 0 ? 0 : 3, 3, 0, 0] })),
      columnGap: 0,
    },
  ];
}

function contributionsNode(block: Extract<Block, { kind: "contributions" }>): PdfNode {
  const title = { text: block.title, fontSize: 10, bold: true, margin: [0, 14, 0, 6], headlineLevel: 2 };
  const body: PdfNode[] = [];
  if (block.note !== null) {
    body.push({ text: block.note, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 0, 0, 4] });
  } else {
    // подписи над сегментами: влезают — по сегменту; нет — одной строкой под полосой (тот же текст)
    const labelW = (s: { title: string; value: string }) => Math.max(width(s.title, 7.5), width(s.value, 8, true)) + 4;
    const fits = block.segments.every((s) => labelW(s) <= s.share * W) && (!block.rest || labelW(block.rest) <= Math.max(block.rest.share * W, 40));
    if (fits) {
      body.push({
        columns: [
          ...block.segments.map((s) => ({
            width: s.share * W,
            stack: [
              { text: s.title, fontSize: 7.5, color: COLORS.ink2, noWrap: true, lineHeight: 1.05 },
              { text: s.value, fontSize: 8, bold: true, noWrap: true, fontFeatures: ["tnum"] },
            ],
          })),
          ...(block.rest
            ? [
                {
                  width: "*",
                  stack: [
                    { text: block.rest.title, fontSize: 7.5, color: COLORS.muted, alignment: "right", noWrap: true, lineHeight: 1.05 },
                    { text: block.rest.value, fontSize: 8, bold: true, color: COLORS.muted, alignment: "right", noWrap: true },
                  ],
                },
              ]
            : []),
        ],
        columnGap: 0,
      });
    }
    let x = 0;
    const segs: PdfNode[] = [{ type: "rect", x: 0, y: 0, w: W, h: 12, color: COLORS.track }];
    for (const s of block.segments) {
      const w = s.share * W;
      segs.push({ type: "rect", x, y: 0, w: Math.max(0, w), h: 12, color: COLORS.bar });
      x += w;
      segs.push({ type: "line", x1: x, y1: 0, x2: x, y2: 12, lineWidth: 1.5, lineColor: COLORS.white });
    }
    body.push({ canvas: segs, margin: [0, 3, 0, 0] });
    if (!fits) {
      const parts = block.segments.map((s) => `${s.title} ${s.value}`);
      if (block.rest) parts.push(`${block.rest.title} ${block.rest.value}`);
      body.push({ text: parts.join(" · "), fontSize: 7.5, color: COLORS.ink2, margin: [0, 3, 0, 0] });
    }
  }
  body.push(...zonesNodes(block));
  if (block.loss) body.push({ text: lineNodes(block.loss), fontSize: 8.5, color: COLORS.ink2, margin: [0, 8, 0, 0] });
  return { stack: [title, ...body], unbreakable: true };
}

function coverageNode(block: Extract<Block, { kind: "coverage" }>): PdfNode {
  const fill = Math.max(0, Math.min(1, block.share)) * W;
  const tx = block.threshold * W;
  return {
    unbreakable: true,
    stack: [
      { text: block.title, fontSize: 10, bold: true, margin: [0, 16, 0, 6], headlineLevel: 2 },
      {
        canvas: [
          { type: "rect", x: 0, y: 0, w: W, h: 10, color: COLORS.track },
          ...(fill > 0 ? [{ type: "rect", x: 0, y: 0, w: fill, h: 10, color: COLORS.bar }] : []),
          { type: "line", x1: tx, y1: -3, x2: tx, y2: 13, lineWidth: 1.25, lineColor: COLORS.ink },
        ],
        margin: [0, 3, 0, 0],
      },
      {
        columns: [
          { width: tx + 4, text: block.collected, fontSize: 7.5, color: COLORS.ink2 },
          { width: "*", text: block.thresholdText, fontSize: 7.5, color: COLORS.ink2 },
        ],
        columnGap: 0,
        margin: [0, 5, 0, 0],
      },
    ],
  };
}

/** Колонки строки категории (эталон, круг 3): имя 84, полоса 60, балл 18, плашка 98, «почему» — остаток; зазор 8. */
const CAT_COLS = [84, 60, 18, 98] as const;
const GAP = 8;
const WHY_W = W - CAT_COLS.reduce((a, b) => a + b, 0) - GAP * 4;

function categoryCells(row: CategoryRow): PdfNode[] {
  const off = row.score === null;
  const whyLines = linesOf(row.why, 8, WHY_W);
  const h = Math.max(30, whyLines * 11 + 2);
  const mid = (elem: number) => Math.max(0, (h - elem) / 2);
  return [
    { text: row.name, bold: !off, color: off ? COLORS.ink2 : COLORS.ink, margin: [0, mid(12), 0, 0], lineHeight: 1.05 },
    { ...scoreBar(row.score, CAT_COLS[1]), margin: [0, mid(6), 0, 0] },
    { text: row.scoreText, bold: !off, color: off ? COLORS.muted : COLORS.ink, alignment: "right", margin: [0, mid(12), 0, 0], fontFeatures: ["tnum"], lineHeight: 1.05 },
    { columns: [labelNode(row.chip, "xs")], margin: [0, mid(15), 0, 0] },
    { text: row.why, fontSize: 8, color: COLORS.ink2, lineHeight: 1.12, margin: [0, mid(whyLines * 11), 0, 0] },
  ];
}

function categoriesNode(block: Extract<Block, { kind: "categories" }>): PdfNode {
  const head = (t: string, align: "left" | "right" = "left") => ({ text: t, fontSize: 7.5, color: COLORS.muted, alignment: align });
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: [...CAT_COLS, "*"],
      body: [
        [head(block.columns[0]), { text: "" }, head(block.columns[1], "right"), head(block.columns[2]), head(block.columns[3])],
        ...block.rows.map(categoryCells),
      ],
    },
    layout: {
      hLineWidth: (i: number) => (i === 0 ? 0 : 0.75),
      vLineWidth: () => 0,
      hLineColor: () => COLORS.rule,
      paddingLeft: (i: number) => (i === 0 ? 0 : GAP),
      paddingRight: () => 0,
      paddingTop: (i: number) => (i === 0 ? 0 : 3),
      paddingBottom: (i: number) => (i === 0 ? 3 : 3),
    },
  };
}

/** Эффект: число — полужирным, остальное — обычным («+1,2» + « к HealthCraft Index»). */
function effectText(effect: string, compact: boolean): PdfText[] {
  const m = /^([+−-]\d+(?:,\d+)?)(.*)$/.exec(effect);
  if (!m) return [{ text: effect }];
  return [{ text: m[1]!, bold: true, color: COLORS.ink, fontSize: compact ? 8.5 : 9.5 }, { text: m[2]! }];
}

function actionRow(a: ActionItem, compact: boolean): PdfNode[] {
  return [
    { text: String(a.n), bold: true, fontFeatures: ["tnum"] },
    {
      stack: [
        { text: lineNodes(a.title), bold: true, lineHeight: 1.1 },
        { text: lineNodes(a.why, true), fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 1, 0, 0] },
      ],
    },
    {
      stack: [
        { text: effectText(a.effect, compact), fontSize: 8.5, color: COLORS.ink2, alignment: "right", lineHeight: 1.15 },
        ...(a.effectNote && !compact ? [{ text: a.effectNote, fontSize: 8.5, color: COLORS.ink2, alignment: "right", lineHeight: 1.15 }] : []),
        ...(a.effectNote && compact ? [{ text: a.effectNote, fontSize: 7.5, color: COLORS.muted, alignment: "right" }] : []),
      ],
    },
  ];
}

function actionsNode(block: Extract<Block, { kind: "actions" }>): PdfNode {
  return {
    table: {
      dontBreakRows: true,
      widths: [14, "*", block.compact ? 150 : 124],
      body: block.items.map((a) => actionRow(a, block.compact)),
    },
    layout: {
      hLineWidth: () => 0.75,
      vLineWidth: () => 0,
      hLineColor: () => COLORS.rule,
      paddingLeft: (i: number) => (i === 0 ? 0 : GAP),
      paddingRight: () => 0,
      paddingTop: () => (block.compact ? 3 : 5),
      paddingBottom: () => (block.compact ? 3 : 5),
    },
  };
}

function tableNode(columns: TableColumn[], rows: InlineLine[][], opts: { total?: boolean; small?: boolean } = {}): PdfNode {
  const size = opts.small ? 7.5 : 8.5;
  const last = columns.length - 1;
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: columns.map((c, i) => c.width ?? (i === last ? "*" : "auto")),
      body: [
        columns.map((c) => ({ text: c.title, fontSize: opts.small ? 7 : 7.5, color: COLORS.muted, alignment: c.align })),
        ...rows.map((row, r) =>
          row.map((cellLine, i) => ({
            text: lineNodes(cellLine, true),
            fontSize: size,
            lineHeight: 1.12,
            alignment: columns[i]?.align ?? "left",
            bold: opts.total && r === rows.length - 1 ? true : undefined,
            fontFeatures: columns[i]?.align === "right" ? ["tnum"] : undefined,
          })),
        ),
      ],
    },
    layout: {
      hLineWidth: (i: number) => (i === 0 ? 0 : 0.75),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 || (opts.total && i === rows.length) ? COLORS.ink : COLORS.rule),
      paddingLeft: () => 0,
      paddingRight: (i: number) => (i === last ? 0 : 6),
      paddingTop: (i: number) => (i === 0 ? 0 : 2.5),
      paddingBottom: (i: number) => (i === 0 ? 3 : 2.5),
    },
  };
}

function detailNode(block: Extract<Block, { kind: "detail" }>): PdfNode {
  const head: PdfNode = {
    columns: [
      { width: "auto", text: block.title, fontSize: 10.5, bold: true, lineHeight: 1 },
      { width: "auto", text: block.scoreText, fontSize: 10.5, bold: true, lineHeight: 1, margin: [7, 0, 0, 0], color: block.scoreText === "—" ? COLORS.muted : COLORS.ink },
      { ...labelNode(block.chip, "xs"), margin: [7, -2, 0, 0] },
    ],
    columnGap: 0,
    margin: [0, 0, 0, 5],
  };
  const parts: PdfNode[] = [head];
  if (block.table) parts.push(tableNode(block.table.columns, block.table.rows));
  for (const note of block.notes) parts.push({ text: lineNodes(note, true), fontSize: 8, color: COLORS.ink2, lineHeight: 1.12, margin: [0, 4, 0, 0] });
  const small = (block.table?.rows.length ?? 0) <= 6;
  return { stack: parts, margin: [0, 9, 0, 0], unbreakable: small };
}

function paragraphNode(block: Extract<Block, { kind: "paragraph" }>): PdfNode {
  const lines = block.lines.flatMap((l, i) => (i === 0 ? lineNodes(l, true) : [{ text: "\n" }, ...lineNodes(l, true)]));
  if (block.tone === "subhead") return { text: lines, fontSize: 10, bold: true, color: COLORS.ink, margin: [0, 12, 0, 5], headlineLevel: 4 };
  if (block.tone === "caption") return { text: lines, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 10, 0, 3], headlineLevel: 4 };
  if (block.tone === "fine") return { text: lines, fontSize: 7.5, color: COLORS.muted, lineHeight: 1.15, margin: [0, 5, 0, 0] };
  if (block.tone === "muted") return { text: lines, fontSize: 8.5, color: COLORS.muted, lineHeight: 1.15, margin: [0, 5, 0, 0] };
  return { text: lines, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 0, 0, 3] };
}

const HEADING_STYLE: Record<1 | 2 | 3, PdfNode> = {
  1: { fontSize: 16, bold: true, margin: [0, 0, 0, 8] },
  2: { fontSize: 12, bold: true, margin: [0, 15, 0, 4] },
  3: { fontSize: 10.5, bold: true, margin: [0, 12, 0, 5] },
};

function blockNode(block: Block): PdfNode {
  switch (block.kind) {
    case "heading":
      return { text: lineNodes(block.content), ...HEADING_STYLE[block.level], headlineLevel: block.level };
    case "paragraph":
      return paragraphNode(block);
    case "list":
      return { ul: block.items.map((item) => ({ text: lineNodes(item), margin: [0, 0, 0, 2] })), fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, markerColor: COLORS.muted };
    case "table":
      return { ...tableNode(block.columns, block.rows, { total: block.total, small: block.small }), margin: [0, 2, 0, 4] };
    case "header":
      return headerNode(block);
    case "hero":
      return heroNode(block);
    case "contributions":
      return contributionsNode(block);
    case "coverage":
      return coverageNode(block);
    case "categories":
      return categoriesNode(block);
    case "actions":
      return actionsNode(block);
    case "detail":
      return detailNode(block);
    case "appendix":
      return {
        stack: [
          { text: block.title, fontSize: 14, bold: true },
          { text: block.intro, fontSize: 8.5, color: COLORS.ink2, margin: [0, 4, 0, 0] },
        ],
        pageBreak: "before",
      };
  }
}

/** Короткий блок после заголовка — вместе с ним (не остается последним на странице). */
function smallFollower(block: Block | undefined): boolean {
  if (!block) return false;
  if (block.kind === "table") return block.rows.length <= 3;
  return block.kind === "paragraph" || block.kind === "list" || block.kind === "actions" || block.kind === "categories" || block.kind === "detail" || block.kind === "coverage";
}

/**
 * Описание документа pdfmake по модели отчёта. Экспортируется для сверки
 * текста с MD (tests/report-pdf.test.ts): текст собирается из всего дерева
 * описания ДО рендера.
 */
export function buildPdfDocument(model: ReportModel): PdfNode {
  const content: PdfNode[] = [];
  const blocks = model.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    // заголовок + первый блок — неразрывно (К9.5); длинный блок — заголовок не сирота (pageBreakBefore)
    if (block.kind === "heading" && next && smallFollower(next) && !(next.kind === "actions" && next.items.length > 3)) {
      content.push({ stack: [blockNode(block), blockNode(next)], unbreakable: true });
      i++;
      continue;
    }
    content.push(blockNode(block));
  }
  return {
    info: { title: model.title, creator: "SourceCraft Repo Health" },
    pageSize: "A4",
    pageMargins: [SIDE, TOP, SIDE, BOTTOM],
    defaultStyle: { font: FONT_FAMILY, fontSize: 9.5, lineHeight: 1.12, color: COLORS.ink },
    // шапка страницы — со 2-й страницы; колонтитул — на всех (оформление, не содержание)
    header: (current: number) =>
      current === 1
        ? null
        : {
            margin: [SIDE, 16, SIDE, 0],
            stack: [
              {
                columns: [
                  { text: model.runningHead[0], fontSize: 7.5, color: COLORS.muted },
                  { text: model.runningHead[1], fontSize: 7.5, color: COLORS.muted, alignment: "right" },
                ],
              },
              { canvas: [{ type: "line", x1: 0, y1: 4, x2: W, y2: 4, lineWidth: 0.75, lineColor: COLORS.rule }] },
            ],
          },
    footer: (current: number, count: number) => ({
      columns: [
        { text: model.footer, fontSize: 7.5, color: COLORS.muted },
        { text: `${current} из ${count}`, fontSize: 7.5, color: COLORS.muted, alignment: "right" },
      ],
      margin: [SIDE, 16, SIDE, 0],
    }),
    // заголовок не остается последним на странице: у нижнего края — перенос на следующую
    pageBreakBefore: (node: { headlineLevel?: number; startPosition?: { top: number } }, following: unknown[]) =>
      node.headlineLevel !== undefined && (following.length === 0 || (node.startPosition?.top ?? 0) > PAGE_H - BOTTOM - 110),
    content,
  };
}

/** PDF отчёта карточки — те же данные, что `renderRepoReport` (MD). */
export async function renderRepoPdf(card: RepoCard): Promise<Buffer> {
  return pdfmake.createPdf(buildPdfDocument(buildReportModel(card))).getBuffer();
}

/** Текст честной ошибки PDF — пользователю (кнопка показывает его как есть). */
export const PDF_FAILED_MESSAGE = "Не удалось собрать PDF – попробуйте позже или скачайте отчет в Markdown.";

/**
 * HTTP-ответ PDF-выгрузки: файл с именем от слага или честная ошибка 500
 * (JSON без стека), а не пустой и не битый файл. Слаг сюда приходит уже
 * проверенным charset-гардом маршрута (как у `.md`). `render` — шов теста
 * сбойного пути.
 */
export async function pdfResponse(card: RepoCard, render: (card: RepoCard) => Promise<Buffer> = renderRepoPdf): Promise<Response> {
  try {
    const pdf = await render(card);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        // отчёт открывают как файл, а не читают в браузере
        "content-disposition": `attachment; filename="${card.repo.org}-${card.repo.repo}-health.pdf"`,
      },
    });
  } catch (error) {
    console.error(`[report.pdf] ${card.repo.org}/${card.repo.repo}: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ error: { code: "pdf_failed", message: PDF_FAILED_MESSAGE } }, { status: 500 });
  }
}
