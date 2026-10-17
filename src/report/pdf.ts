// PDF-выгрузка отчета по карточке. Рендерер той же модели блоков, из которой
// `markdown.ts` собирает MD: содержание PDF равно содержанию MD по построению,
// отличается только вид.
// Вид: Inter в двух весах, цвета — hex-снимки токенов светлой темы UI, плашки как
// `Label` (скругленный прямоугольник canvas под текстом), полосы одним серым
// тоном, шкала 3 зон, карточки действий, приложение с новой страницы.
//
// Движок — серверный `pdfmake@0.3.11` (MIT), без Chrome. Модуль серверный:
// фронтенд его не импортирует.
//
// Безопасность: `pdfmake` умеет тянуть ресурсы по URL и с диска по ссылке из
// описания документа. Картинок и внешних ресурсов в модели нет, а политики
// закрыты явно: сеть — никогда, файловая система — только каталог шрифта.
//
// Шрифт — Inter (SIL OFL 1.1, `fonts/LICENSE.txt`): 4 файла (Regular,
// SemiBold и 2 курсива). Покрытие глифов закрыто тестом по cmap
// (tests/report-pdf.test.ts). Неизвестный глиф во внешних данных генерацию
// не роняет — fontkit рисует на его месте .notdef.
import { reportFileName } from "../web/format";
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
// сеть — никогда: в модели отчета нет ни картинок, ни ссылок на ресурсы
pdfmake.setUrlAccessPolicy(() => false);
// диск — только файлы шрифта
pdfmake.setLocalAccessPolicy(insideFontDir);

// ---------- токены вида (светлая тема UI, hex на белом) ----------

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
  /** дорожка Progress (theme.css) */
  track: "#f2f2f2",
  /** text-link */
  link: "#4768c2",
  /**
   * Все шкалы (полоса вклада, полосы баллов, покрытие) — один серый тон. С
   * дорожкой `#f2f2f2` контраст 2,7:1 — ниже порога WCAG 1.4.11 (3:1) для
   * нетекстовых элементов; это осознанный выбор ради светлого вида.
   */
  bar: "#949494",
  /** подложка примечаний под таблицами разбора */
  noteBg: "#f7f7f7",
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
/** Рабочая ширина набора (pt) — для тестов верстки. */
export const CONTENT_W = W;
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

/**
 * Обрезка по ширине с многоточием для колонтитулов: у длинного имени репозитория
 * строка иначе переносится, теряет дату, а шапка страницы наезжает на номер.
 * Колонтитулы в сверку с MD не входят, так что текст здесь можно резать.
 */
function fitOneLine(s: string, size: number, max: number): string {
  if (width(s, size) <= max) return s;
  let out = s;
  while (out.length > 1 && width(`${out}…`, size) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
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
/** Длиннее этого значение без пробелов не остается — иначе ячейка вылезает за поле. */
export const MAX_UNBROKEN = 24;

/**
 * Длинное значение без пробелов переносить негде, и ячейка ушла бы за правый край
 * страницы. Точки переноса ставятся только в слова длиннее порога — после знаков
 * структуры и, если их не хватает, через каждые MAX_UNBROKEN символов. Видимый
 * текст не меняется: U+200B нулевой ширины, сверка с MD его выбрасывает.
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

const LABEL_SIZES = { xxs: { h: 12, pad: 4.5, r: 2 }, xs: { h: 15, pad: 6, r: 2.25 }, s: { h: 18, pad: 7.5, r: 3.75 } } as const;
const LABEL_FONT = 9.5;
/** Кегль плашки доступа в шапке — мельче остальных. */
const LABEL_FONT_XXS = 8;
/** высота строки Inter 9.5 pt при lineHeight 1 (ascender − descender ≈ 1.21 em) */
const LABEL_LINE = LABEL_FONT * 1.21;

/** Плашка как `Label` UI: скругленный прямоугольник canvas и текст поверх него. */
export function labelNode(chip: Chip, size: "xxs" | "xs" | "s" = "xs"): PdfNode {
  const { h, pad, r } = LABEL_SIZES[size];
  const { bg, fg } = LABEL_COLORS[chip.theme];
  const font = size === "xxs" ? LABEL_FONT_XXS : LABEL_FONT;
  const w = Math.ceil(width(chip.text, font) + 2 * pad + 1);
  const inset = (h - font * 1.21) / 2;
  return {
    width: w,
    stack: [
      { canvas: [{ type: "rect", x: 0, y: 0, w, h, r, color: bg }] },
      { text: chip.text, color: fg, fontSize: font, lineHeight: 1, noWrap: true, margin: [pad, -h + inset, 0, inset] },
    ],
  };
}

/**
 * Иконка информации — `circle-info` из `@gravity-ui/icons` (MIT), тот же
 * рисунок, что в UI; путь скопирован в код дословно, чтобы сборка PDF не
 * читала файлы вне каталога шрифта.
 */
const INFO_PATH =
  "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14m1-9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0m-.25 3a.75.75 0 0 0-1.5 0V11a.75.75 0 0 0 1.5 0z";
const INFO_SIZE = 9.5;

const infoIcon = (): PdfNode => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16"><path fill="${COLORS.muted}" fill-rule="evenodd" d="${INFO_PATH}" clip-rule="evenodd"/></svg>`,
  width: INFO_SIZE,
  height: INFO_SIZE,
});

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
  // длинный слаг и ссылка без пробелов переносятся, а не уходят за поле
  const left: PdfNode[] = [{ text: breakable(block.slug), fontSize: 16, bold: true, lineHeight: 1 }];
  if (block.title) left.push({ text: lineNodes(block.title), fontSize: 8, color: COLORS.muted, margin: [0, 2, 0, 0] });
  left.push({ text: breakable(block.link.text), link: block.link.url, color: COLORS.link, fontSize: 8, margin: [0, 2, 0, 0] });
  // название документа первой строкой, дата и плашка доступа — второй
  const right: PdfNode[] = [{ text: block.doc, bold: true, fontSize: 9, alignment: "right", noWrap: true }];
  const dateNode: PdfNode | null = block.date ? { width: "auto", text: block.date, fontSize: 8, color: COLORS.muted, noWrap: true, margin: [0, 2, 0, 0] } : null;
  if (block.docChip) {
    const chipNode = labelNode(block.docChip, "xxs");
    right.push({
      columns: [{ width: "*", text: "" }, ...(dateNode ? [dateNode] : []), { ...chipNode, width: (chipNode.width as number) + 6, margin: [6, 1, 0, 0] }],
      columnGap: 0,
      margin: [0, 1, 0, 0],
    });
  } else if (dateNode) {
    right.push({ text: block.date, fontSize: 8, color: COLORS.muted, alignment: "right", margin: [0, 1, 0, 0] });
  }
  return {
    stack: [
      { columns: [{ width: "*", stack: left }, { width: "auto", stack: right, margin: [10, 6, 0, 0] }] },
      rule(COLORS.rule, 0.75, [0, 12, 0, 0]),
    ],
  };
}

/** Отступ плашки от «из 100» в ряду показателя. */
const CHIP_INDENT = 12;

/** Столбец показателя: подпись, крупное число, «из 100» и плашка. */
function metricColumn(label: string, value: number | null, noneText: string, chip: Chip | null, align: "left" | "right"): PdfNode {
  const head: PdfNode = { text: label, fontSize: 9, color: COLORS.muted, alignment: align, margin: [0, 0, 0, 1] };
  if (value === null) {
    return { stack: [head, { text: noneText, fontSize: 26, bold: true, color: COLORS.ink2, lineHeight: 1, alignment: align, margin: [0, 6, 0, 4] }] };
  }
  // отступ слева входит в ширину колонки: иначе у прижатого вправо показателя
  // распорка «*» съедает его и плашка уезжает за правое поле
  const chipNode = chip ? labelNode(chip, "s") : null;
  const cells: PdfNode[] = [
    { width: "auto", text: String(value), fontSize: 40, bold: true, characterSpacing: -0.8, lineHeight: 1, fontFeatures: ["tnum"] },
    { width: "auto", text: "из 100", fontSize: 10, color: COLORS.muted, margin: [6, 30, 0, 0] },
    ...(chipNode ? [{ ...chipNode, width: (chipNode.width as number) + CHIP_INDENT, margin: [CHIP_INDENT, 25, 0, 0] }] : []),
  ];
  // строка чисел прижимается вправо распоркой: alignment столбцы не наследуют
  return { stack: [head, { columns: align === "right" ? [{ width: "*", text: "" }, ...cells] : cells, columnGap: 0 }] };
}

/** Ширина столбца показателя в ряду из двух: половина полосы набора. */
const HERO_GAP = 16;
const HERO_COL = (W - HERO_GAP) / 2;

function heroNode(block: Extract<Block, { kind: "hero" }>): PdfNode {
  const main = metricColumn(block.label, block.value, block.noneText, block.chip, "left");
  // второй показатель — справа в том же ряду, тем же стилем; его пояснение —
  // мелкой строкой под числом
  const row: PdfNode = block.secondary
    ? {
        columns: [
          { width: HERO_COL, ...main },
          {
            width: HERO_COL,
            stack: [
              metricColumn(block.secondary.label, block.secondary.value, block.secondary.noneText, block.secondary.chip, "left"),
              ...(block.secondary.note ? [{ text: block.secondary.note, fontSize: 8, color: COLORS.muted, lineHeight: 1.15, margin: [0, 4, 0, 0] }] : []),
            ],
          },
        ],
        columnGap: HERO_GAP,
      }
    : main;
  return {
    stack: [
      { ...row, margin: [0, 12, 0, 0] },
      ...(block.verdict ? [{ text: block.verdict, fontSize: 12, lineHeight: 1.1, margin: [0, 8, 0, 0] }] : []),
      ...block.notes.map((n) => {
        const body: PdfNode = { text: lineNodes(n.line), fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.2 };
        // строка с иконкой и строка без нее держат один отступ сверху;
        // текст с иконкой выровнен по ее левому краю переносом строки
        return n.info
          ? { columns: [{ width: INFO_SIZE, ...infoIcon(), margin: [0, 2, 0, 0] }, { width: "*", ...body }], columnGap: 6, margin: [0, 10, 0, 0] }
          : { ...body, margin: [0, 10, 0, 0] };
      }),
    ],
  };
}

/** Высота полосы и цветной полоски зон под ней. */
const BAR_H = 12;
const ZONE_H = 3;
const ZONE_TOP = BAR_H + 2;
/**
 * Засечка у начала сегмента: черная, пересекает шкалу насквозь и тянется к своей
 * подписи. Есть и у первого сегмента; у остатка «не набрано» ее нет — там граница
 * видна сменой тона. Рисуется поверх полосы и полоски зон.
 */
const TICK_UP = 5;
const TICK_WIDTH = 1.25;
/** Отступ ряда подписей под полосой от полоски зон. */
const BELOW_GAP = 6;
/** Кегли и межстрочные подписи сегмента: название и вклад. */
const SEG_TITLE = { size: 7.5, lineHeight: 1.05 } as const;
const SEG_VALUE = { size: 8, lineHeight: 1.12 } as const;
/** Высота ряда подписей — две строки (название и вклад), высота строки Inter. */
export const SEG_LABEL_H = SEG_TITLE.size * 1.21 * SEG_TITLE.lineHeight + SEG_VALUE.size * 1.21 * SEG_VALUE.lineHeight;
/** Зазор между подписями одного ряда. */
export const SEG_LABEL_GAP = 6;
/** Рядов подписей с каждой стороны полосы; не хватило — подписи уходят в легенду. */
export const SEG_LANES = 2;

/** Сегмент для раскладки подписей: начало и ширина на полосе, ширина подписи. */
export interface SegmentSlot {
  x0: number;
  w: number;
  /** ширина подписи (шире из двух строк) */
  lw: number;
  /** засечка у начала сегмента (у остатка «не набрано» ее нет) */
  tick: boolean;
  /** подпись прижата к правому краю полосы (остаток «не набрано») */
  right: boolean;
}

/** Место подписи: сторона, ряд (0 — ближний к полосе), отрезок по горизонтали и засечка. */
export interface LabelPlace {
  side: "above" | "below";
  lane: number;
  a: number;
  b: number;
  tick: number | null;
}

/**
 * Раскладка подписей полосы вклада. Простое чередование «над, под, над» не
 * годится: у малых соседних сегментов подпись первого наезжает на подпись
 * третьего. Поэтому каждая подпись занимает отрезок по своей настоящей ширине
 * (метрики Inter) и ставится в первый свободный ряд: своя сторона по очереди,
 * другая сторона, затем второй ряд. Ряд свободен, если подпись не задевает
 * соседей этого ряда (с зазором), а засечки дальнего ряда не проходят сквозь
 * подписи ближнего и наоборот. Подпись у правого края сдвигается влево и не
 * выходит за полосу. Не нашлось места хоть одной подписи — `null`: все подписи
 * уходят в легенду под полосой, поверх соседей ни одна не ставится.
 */
export function placeSegmentLabels(slots: readonly SegmentSlot[], width: number, lanes = SEG_LANES): LabelPlace[] | null {
  // сначала первая подпись над полосой; не вышло — та же раскладка с первой под полосой
  return placeFrom(slots, width, lanes, "above") ?? placeFrom(slots, width, lanes, "below");
}

function placeFrom(slots: readonly SegmentSlot[], width: number, lanes: number, first: "above" | "below"): LabelPlace[] | null {
  const placed: LabelPlace[] = [];
  const crosses = (x: number, p: { a: number; b: number }): boolean => x >= p.a - 1 && x <= p.b + 1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const lw = Math.min(s.lw, width);
    const a = s.right ? width - lw : Math.max(0, Math.min(s.x0, width - lw));
    const b = a + lw;
    const tick = s.tick ? s.x0 : null;
    const other0: "above" | "below" = first === "above" ? "below" : "above";
    const pref: "above" | "below" = i % 2 === 0 ? first : other0;
    const other: "above" | "below" = pref === "above" ? "below" : "above";
    let spot: LabelPlace | null = null;
    for (let lane = 0; lane < lanes && spot === null; lane++) {
      for (const side of [pref, other]) {
        const same = placed.filter((p) => p.side === side);
        const free =
          same.every((p) => p.lane !== lane || b + SEG_LABEL_GAP <= p.a || p.b + SEG_LABEL_GAP <= a) &&
          // засечка этой подписи идет сквозь ближние ряды — там ее не закрывают подписи
          (tick === null || same.every((p) => p.lane >= lane || !crosses(tick, p))) &&
          // засечки дальних рядов идут сквозь этот ряд — подпись их не закрывает
          same.every((p) => p.lane <= lane || p.tick === null || !crosses(p.tick, { a, b }));
        if (free) {
          spot = { side, lane, a, b, tick };
          break;
        }
      }
    }
    if (spot === null) return null;
    placed.push(spot);
  }
  return placed;
}

/** Подпись сегмента: название и вклад двумя строками. */
function segmentText(s: { title: string; value: string }, muted: boolean, align: "left" | "right"): PdfNode[] {
  return [
    { text: s.title, fontSize: SEG_TITLE.size, lineHeight: SEG_TITLE.lineHeight, color: muted ? COLORS.muted : COLORS.ink2, noWrap: true, alignment: align },
    { text: s.value, fontSize: SEG_VALUE.size, lineHeight: SEG_VALUE.lineHeight, bold: true, noWrap: true, alignment: align, color: muted ? COLORS.muted : COLORS.ink, fontFeatures: ["tnum"] },
  ];
}

/**
 * Полоса вкладов. Подписи — отдельными
 * узлами с `relativePosition` до рисунка полосы: в дереве описания они стоят в
 * порядке сегментов, и сверка «текст PDF = текст MD» видит те же слова подряд,
 * а место на странице задает раскладка `placeSegmentLabels`. Рисунок (полоса,
 * полоска зон, засечки до своих подписей) — один canvas, его высота задает
 * высоту блока. Раскладки нет — легенда строкой под полосой, тем же порядком.
 */
function contributionsNode(block: Extract<Block, { kind: "contributions" }>): PdfNode {
  const title = { text: block.title, fontSize: 10, bold: true, margin: [0, BLOCK_GAP, 0, 6] };
  if (block.note !== null) {
    return {
      stack: [title, { text: block.note, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 0, 0, 4] }, zoneStrip(block, 0, W)],
      unbreakable: true,
    };
  }
  const items = [
    ...block.segments.map((s) => ({ s, fill: COLORS.bar, muted: false })),
    ...(block.rest ? [{ s: block.rest, fill: COLORS.track, muted: true }] : []),
  ];
  let x = 0;
  const slots: SegmentSlot[] = items.map((it, i) => {
    const last = i === items.length - 1;
    const w = last ? Math.max(0.5, W - x) : Math.max(0.5, it.s.share * W);
    const x0 = x;
    x += w;
    const lw = Math.max(width(it.s.title, SEG_TITLE.size), width(it.s.value, SEG_VALUE.size, true)) + 1;
    return { x0, w, lw, tick: !last, right: it.muted };
  });
  const places = placeSegmentLabels(slots, W);
  const above = places ? Math.max(1, ...places.filter((p) => p.side === "above").map((p) => p.lane + 1)) : 0;
  const below = places ? Math.max(1, ...places.filter((p) => p.side === "below").map((p) => p.lane + 1)) : 0;
  const barTop = above * SEG_LABEL_H + TICK_UP;
  const belowTop = (lane: number): number => barTop + ZONE_TOP + ZONE_H + BELOW_GAP + lane * SEG_LABEL_H;
  const height = below > 0 ? belowTop(below - 1) + SEG_LABEL_H : barTop + ZONE_TOP + ZONE_H;
  const shapes: PdfNode[] = [
    ...slots.map((s, i) => ({ type: "rect", x: s.x0, y: barTop, w: s.w + (i === slots.length - 1 ? 0 : 0.6), h: BAR_H, color: items[i]!.fill })),
    ...zoneRects(block, 0, W).map((r) => ({ ...(r as Record<string, unknown>), y: barTop + ZONE_TOP })),
    // засечки — последними: лежат поверх полосы и полоски зон; тянутся до своей подписи
    ...slots.flatMap((s, i) => {
      if (!s.tick) return [];
      const p = places?.[i];
      const [y1, y2] = !p
        ? [barTop - TICK_UP, barTop + BAR_H]
        : p.side === "above"
          ? [(above - p.lane) * SEG_LABEL_H, barTop + BAR_H]
          : [barTop, belowTop(p.lane) - 1];
      return [{ type: "line", x1: s.x0, y1, x2: s.x0, y2, lineWidth: TICK_WIDTH, lineColor: COLORS.ink }];
    }),
    // высота блока — до нижнего ряда подписей (невидимая точка на белом)
    { type: "line", x1: 0, y1: height, x2: 0, y2: height, lineWidth: 0.01, lineColor: COLORS.white },
  ];
  const canvas: PdfNode = { canvas: shapes };
  if (places === null) {
    // легенда: все подписи строкой под полосой, порядок сегментов слева направо
    const legend: PdfText[] = items.flatMap((it, i) => [
      ...(i > 0 ? [{ text: "  ·  ", color: COLORS.muted }] : []),
      { text: `${it.s.title} `, color: it.muted ? COLORS.muted : COLORS.ink2 },
      { text: it.s.value, bold: true, color: it.muted ? COLORS.muted : COLORS.ink },
    ]);
    return { stack: [title, canvas, { text: legend, fontSize: 7.5, lineHeight: 1.15, margin: [0, BELOW_GAP, 0, 0] }], unbreakable: true };
  }
  const labels: PdfNode[] = items.map((it, i) => {
    const p = places[i]!;
    const y = p.side === "above" ? (above - 1 - p.lane) * SEG_LABEL_H : belowTop(p.lane);
    // остаток прижат вправо: обе строки выровнены по правому краю полосы
    return slots[i]!.right
      ? { relativePosition: { x: 0, y }, stack: segmentText(it.s, it.muted, "right") }
      : { relativePosition: { x: p.a, y }, stack: segmentText(it.s, it.muted, "left") };
  });
  return { stack: [title, { stack: [...labels, canvas] }], unbreakable: true };
}

/** Куски цветной полоски зон, попадающие в отрезок [x0, x1] полосы. */
function zoneRects(block: Extract<Block, { kind: "contributions" }>, x0: number, x1: number): PdfNode[] {
  const out: PdfNode[] = [];
  let zx = 0;
  for (const z of block.zones) {
    const zw = z.share * W;
    const from = Math.max(x0, zx);
    const to = Math.min(x1, zx + zw);
    zx += zw;
    if (to - from <= 0.01) continue;
    const gap = zx < W - 0.5 && to >= zx - 0.01 ? 1.5 : 0;
    out.push({ type: "rect", x: from - x0, y: ZONE_TOP, w: Math.max(0, to - from - gap), h: ZONE_H, color: ZONE_COLORS[z.theme] });
  }
  return out;
}

/** Полоска зон во всю ширину — для случая, когда полосы вкладов нет. */
function zoneStrip(block: Extract<Block, { kind: "contributions" }>, x0: number, x1: number): PdfNode {
  return { canvas: zoneRects(block, x0, x1).map((r) => ({ ...(r as Record<string, unknown>), y: 0 })), margin: [0, 6, 0, 0] };
}

function coverageNode(block: Extract<Block, { kind: "coverage" }>): PdfNode {
  const fill = Math.max(0, Math.min(1, block.share)) * W;
  const tx = block.threshold * W;
  return {
    unbreakable: true,
    stack: [
      { text: block.title, fontSize: 10, bold: true, margin: [0, BLOCK_GAP, 0, 6] },
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

/**
 * Колонки строки категории: имя 84, полоса 60, балл 24, плашка 98, «почему» —
 * остаток; зазор 8. Под балл нужно 24 pt, иначе трехзначное «100» уходит в
 * перенос строки.
 */
const CAT_COLS = [84, 60, 24, 98] as const;
const GAP = 8;
const WHY_W = W - CAT_COLS.reduce((a, b) => a + b, 0) - GAP * 4;

/**
 * Высота строки текста в Inter: кегль × 1,21 (ascender − descender) × межстрочный.
 * Центрирование в строке таблицы считается по той же высоте, что и у pdfmake,
 * иначе содержимое встает ниже середины.
 */
const textH = (size: number, lineHeight: number): number => size * 1.21 * lineHeight;
const NAME_H = textH(9.5, 1.05);
const WHY_H = textH(8, 1.12);

/** Зазор между меткой строки и «почему» под ней. */
const MARK_GAP = 3;

function categoryCells(row: CategoryRow): PdfNode[] {
  const off = row.score === null;
  const whyLines = linesOf(row.why, 8, WHY_W);
  const markH = row.mark ? LABEL_SIZES.xxs.h + MARK_GAP : 0;
  const whyH = markH + whyLines * WHY_H;
  const h = Math.max(whyH, LABEL_SIZES.xs.h, NAME_H);
  const mid = (elem: number) => Math.max(0, (h - elem) / 2);
  const why: PdfNode = { text: row.why, fontSize: 8, color: COLORS.ink2, lineHeight: 1.12 };
  return [
    { text: row.name, color: off ? COLORS.ink2 : COLORS.ink, margin: [0, mid(NAME_H), 0, 0], lineHeight: 1.05 },
    { ...scoreBar(row.score, CAT_COLS[1]), margin: [0, mid(6), 0, 0] },
    { text: row.scoreText, color: off ? COLORS.muted : COLORS.ink, alignment: "right", noWrap: true, margin: [0, mid(NAME_H), 0, 0], fontFeatures: ["tnum"], lineHeight: 1.05 },
    { columns: [labelNode(row.chip, "xs")], margin: [0, mid(LABEL_SIZES.xs.h), 0, 0] },
    // метка строки — плашкой над «почему», как у категории на карточке
    row.mark
      ? { stack: [{ columns: [labelNode(row.mark, "xxs")] }, { ...why, margin: [0, MARK_GAP, 0, 0] }], margin: [0, mid(whyH), 0, 0] }
      : { ...why, margin: [0, mid(whyH), 0, 0] },
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
      paddingTop: (i: number) => (i === 0 ? 0 : 7),
      paddingBottom: (i: number) => (i === 0 ? 3 : 7),
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
      // подпись «ожидаемый эффект» — строкой над числом
      stack: [
        ...(a.effectNote && !compact ? [{ text: a.effectNote, fontSize: 8.5, color: COLORS.ink2, alignment: "right", lineHeight: 1.15 }] : []),
        ...(a.effectNote && compact ? [{ text: a.effectNote, fontSize: 7.5, color: COLORS.muted, alignment: "right" }] : []),
        { text: effectText(a.effect, compact), fontSize: 8.5, color: COLORS.ink2, alignment: "right", lineHeight: 1.15 },
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

/** Примечание под таблицей разбора: текст на подложке во всю ширину набора. */
const NOTE_PAD = 7;

function noteBox(note: InlineLine, top = 5): PdfNode {
  return {
    table: { widths: [W], body: [[{ text: lineNodes(note, true), fontSize: 8, color: COLORS.ink2, lineHeight: 1.12, fillColor: COLORS.noteBg }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => NOTE_PAD, paddingRight: () => NOTE_PAD, paddingTop: () => 5, paddingBottom: () => 5 },
    margin: [-NOTE_PAD, top, -NOTE_PAD, 0],
  };
}

function detailNode(block: Extract<Block, { kind: "detail" }>): PdfNode {
  const head: PdfNode = {
    columns: [
      { width: "auto", text: block.title, fontSize: 10.5, bold: true, lineHeight: 1 },
      { width: "auto", text: block.scoreText, fontSize: 10.5, bold: true, lineHeight: 1, margin: [7, 0, 0, 0], color: block.scoreText === "–" ? COLORS.muted : COLORS.ink },
      { ...labelNode(block.chip, "xs"), margin: [7, -2, 0, 0] },
    ],
    columnGap: 0,
    margin: [0, 0, 0, 5],
  };
  const parts: PdfNode[] = [head];
  if (block.table) parts.push(tableNode(block.table.columns, block.table.rows));
  for (const note of block.notes) parts.push(noteBox(note));
  const small = (block.table?.rows.length ?? 0) <= 6;
  return { stack: parts, margin: [0, 20, 0, 0], unbreakable: small };
}

function paragraphNode(block: Extract<Block, { kind: "paragraph" }>): PdfNode {
  const lines = block.lines.flatMap((l, i) => (i === 0 ? lineNodes(l, true) : [{ text: "\n" }, ...lineNodes(l, true)]));
  // примечания во всех разделах — на одной подложке
  if (block.tone === "note") return noteBox(block.lines.flat(), 6);
  if (block.tone === "subhead") return { text: lines, fontSize: 10, bold: true, color: COLORS.ink, margin: [0, 12, 0, 5], headlineLevel: 4 };
  if (block.tone === "caption") return { text: lines, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 10, 0, 3], headlineLevel: 4 };
  if (block.tone === "fine") return { text: lines, fontSize: 7.5, color: COLORS.muted, lineHeight: 1.15, margin: [0, 5, 0, 0] };
  if (block.tone === "muted") return { text: lines, fontSize: 8.5, color: COLORS.muted, lineHeight: 1.15, margin: [0, 5, 0, 0] };
  return { text: lines, fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.15, margin: [0, 0, 0, 3] };
}

/** Один шаг отступа между крупными смысловыми блоками. */
const BLOCK_GAP = 30;

const HEADING_STYLE: Record<1 | 2 | 3, PdfNode> = {
  1: { fontSize: 16, bold: true, margin: [0, 0, 0, 8] },
  2: { fontSize: 12, bold: true, margin: [0, BLOCK_GAP, 0, 6] },
  3: { fontSize: 10.5, bold: true, margin: [0, 20, 0, 5] },
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
 * Описание документа pdfmake по модели отчета. Экспортируется для сверки
 * текста с MD (tests/report-pdf.test.ts): текст собирается из всего дерева
 * описания до рендера.
 */
export function buildPdfDocument(model: ReportModel): PdfNode {
  // колонки колонтитулов заданы шириной: у длинного имени репозитория строка
  // иначе съела бы номер страницы
  const FOOT_NUM = Math.ceil(width("000/000", 7.5)) + 4;
  const RUN_RIGHT = Math.ceil(width(model.runningHead[1], 7.5)) + 4;
  const content: PdfNode[] = [];
  const blocks = model.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    // мелкая сноска сразу под таблицей — на подложке примечания
    if (block.kind === "paragraph" && block.tone === "fine" && blocks[i - 1]?.kind === "table") {
      content.push(noteBox(block.lines.flat(), 5));
      continue;
    }
    // заголовок + короткий первый блок — неразрывно; перед длинным блоком заголовок
    // не остается сиротой благодаря pageBreakBefore
    if (block.kind === "heading" && next && smallFollower(next) && !(next.kind === "actions" && next.items.length > 3)) {
      // внутри неразрывного стека заголовок без headlineLevel: pageBreakBefore
      // на вложенном узле неразрывного блока pdfmake обрабатывает неверно
      // (пустые страницы и потерянный текст)
      const head = blockNode(block);
      delete head.headlineLevel;
      content.push({ stack: [head, blockNode(next)], unbreakable: true });
      i++;
      continue;
    }
    // обычный абзац сразу под плашкой примечания (например, «Обзор устарел» над
    // AI-текстом) — с отступом, иначе текст прилипает к подложке
    const prev = blocks[i - 1];
    if (block.kind === "paragraph" && block.tone === undefined && prev?.kind === "paragraph" && prev.tone === "note") {
      content.push({ ...blockNode(block), margin: [0, 6, 0, 3] });
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
                  { width: W - RUN_RIGHT, text: fitOneLine(model.runningHead[0], 7.5, W - RUN_RIGHT - 4), fontSize: 7.5, color: COLORS.muted, noWrap: true },
                  { width: RUN_RIGHT, text: model.runningHead[1], fontSize: 7.5, color: COLORS.muted, alignment: "right", noWrap: true },
                ],
              },
              { canvas: [{ type: "line", x1: 0, y1: 4, x2: W, y2: 4, lineWidth: 0.75, lineColor: COLORS.rule }] },
            ],
          },
    footer: (current: number, count: number) => ({
      columns: [
        { width: W - FOOT_NUM, text: fitOneLine(model.footer, 7.5, W - FOOT_NUM - 4), fontSize: 7.5, color: COLORS.muted, noWrap: true },
        { width: FOOT_NUM, text: `${current}/${count}`, fontSize: 7.5, color: COLORS.muted, alignment: "right" },
      ],
      margin: [SIDE, 16, SIDE, 0],
    }),
    // заголовок не остается последним на странице: у нижнего края — перенос на следующую
    pageBreakBefore: (node: { headlineLevel?: number; startPosition?: { top: number } }, following: unknown[]) =>
      node.headlineLevel !== undefined && (following.length === 0 || (node.startPosition?.top ?? 0) > PAGE_H - BOTTOM - 110),
    content,
  };
}

/** PDF отчета карточки — те же данные, что `renderRepoReport` (MD). */
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
        // отчет открывают как файл, а не читают в браузере
        "content-disposition": `attachment; filename="${reportFileName(card.repo.org, card.repo.repo, "pdf")}"`,
      },
    });
  } catch (error) {
    console.error(`[report.pdf] ${card.repo.org}/${card.repo.repo}: ${error instanceof Error ? error.message : String(error)}`);
    return Response.json({ error: { code: "pdf_failed", message: PDF_FAILED_MESSAGE } }, { status: 500 });
  }
}
