// pdf.ts — PDF-выгрузка отчёта по карточке (В4.7, контракт П1).
//
// Рендерер той же модели блоков, из которой `markdown.ts` сериализует MD:
// содержание PDF равно содержанию MD построением, отличается только
// визуальный стиль (типографика, отступы, рамки таблиц, колонтитул).
// MD-разметка внутри текста (`код`, _курсив_, **полужирный**) передаётся
// стилем, а не символами разметки.
//
// Механизм — решение владельца 21.09: серверный `pdfmake@0.3.11` (MIT), без
// Chrome. Модуль серверный: фронтенд его не импортирует, в бандл UI
// библиотека не попадает.
//
// Безопасность: `pdfmake` умеет тянуть ресурсы по URL и с диска по ссылке из
// описания документа. Картинок и внешних ресурсов в модели нет, а политики
// закрыты явно: сеть — никогда, файловая система — только каталог шрифта.
//
// Шрифт — Inter (SIL OFL 1.1, `fonts/LICENSE.txt`; решение 21.09 «Шрифт PDF —
// Inter»): встроенный Roboto не рисует «→», а генератор его печатает.
// Покрытие глифов закрыто тестом по cmap (tests/report-pdf.test.ts).
// Неизвестный глиф во внешних данных (название, язык) генерацию не роняет —
// fontkit рисует на его месте .notdef.
import pdfmake from "pdfmake";
import { join, resolve, sep } from "node:path";
import type { RepoCard } from "../api/repos";
import { buildReportModel } from "./markdown";
import { avatarInitials, avatarTone, type AvatarTone } from "../web/format";
import { cellPlain, type Block, type Inline, type InlineLine, type ReportModel } from "./model";

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

// ---------- модель → описание документа pdfmake ----------

type PdfText = { text: string; style?: string; bold?: boolean; italics?: boolean; link?: string };
type PdfNode = Record<string, unknown>;

const COLORS = {
  text: "#1f2328",
  secondary: "#59636e",
  rule: "#d1d9e0",
  headerFill: "#f3f5f7",
  codeFill: "#eef1f4",
  link: "#0969da",
};

/**
 * Тона аватара для PDF — светлая тема Gravity (фон `base-<tone>-light`, текст
 * `text-<tone>`), снятые в hex: печатный документ живёт на белом и CSS-токенов
 * не знает. Карточка берёт те же тона токенами (`RepoAvatar`).
 */
const AVATAR_COLORS: Record<AvatarTone, { bg: string; fg: string }> = {
  info: { bg: "#e5f0fc", fg: "#0b62c5" },
  utility: { bg: "#f1e8fc", fg: "#8f33d9" },
  positive: { bg: "#e5f5e9", fg: "#2e8540" },
  misc: { bg: "#eef0f2", fg: "#5c6570" },
};

const AVATAR_SIZE = 26;

/**
 * В4.7 круг 2 (Р2.5, вариант (а) владельца 21.09): аватар из букв рядом с
 * названием — рисуется локально, без сети (логотип платформы не качается).
 * Оформление, а не содержание: в MD его нет, сверка текста его не видит.
 */
function avatarNode(name: string): PdfNode {
  const { bg, fg } = AVATAR_COLORS[avatarTone(name)];
  return {
    width: AVATAR_SIZE,
    stack: [
      { canvas: [{ type: "rect", x: 0, y: 0, w: AVATAR_SIZE, h: AVATAR_SIZE, r: 5, color: bg }] },
      { text: avatarInitials(name), color: fg, bold: true, fontSize: 10, alignment: "center", relativePosition: { x: 0, y: -AVATAR_SIZE + 7 } },
    ],
  };
}

function inlineNode(fragment: Inline): PdfText {
  switch (fragment.kind) {
    case "code":
      return { text: fragment.text, style: "code" };
    case "em":
      return { text: fragment.text, italics: true };
    case "strong":
      return { text: fragment.text, bold: true };
    case "cell":
      return { text: cellPlain(fragment.value) };
    case "link":
      // В4.7 круг 2 (Р2.5): ссылка на оригинал в SourceCraft — синяя и кликабельная
      return { text: fragment.text, link: fragment.text, style: "link" };
    case "prepared":
      return { text: fragment.text };
    default:
      return { text: fragment.text };
  }
}

/** Невидимая точка переноса (U+200B, в Inter нулевой ширины). */
export const BREAK = "\u200B";
/** Длиннее этого значение без пробелов не остаётся — иначе ячейка вылезает за поле. */
export const MAX_UNBROKEN = 24;

/**
 * Приёмка HQ В4.7: значение факта — JSON без пробелов, переносить его негде,
 * и последняя колонка «Доказательной базы» уходила за правый край страницы —
 * PDF терял часть содержания, которое MD показывает целиком. Точки переноса
 * ставятся только в слова длиннее порога — после знаков структуры и, если
 * их не хватает, через каждые MAX_UNBROKEN символов; короткие значения
 * («12:00», «CI/CD») не трогаются, чтобы текстовый слой PDF не получал
 * лишних пробелов при копировании. Текст не меняется — U+200B нулевой
 * ширины, сверка с MD его выбрасывает.
 */
export function breakable(text: string): string {
  return text.replace(/\S+/g, (word) => {
    if (word.length <= MAX_UNBROKEN) return word;
    let out = "";
    let run = 0;
    for (const ch of word) {
      out += ch;
      run++;
      if (",:{[".includes(ch) || run >= MAX_UNBROKEN) {
        out += BREAK;
        run = 0;
      }
    }
    return out;
  });
}

const lineNodes = (line: InlineLine): PdfText[] => line.map(inlineNode);

function blockNode(block: Block): PdfNode {
  switch (block.kind) {
    case "heading":
      return { text: lineNodes(block.content), style: `h${block.level}` };
    case "paragraph":
      // строки абзаца — отдельными строками, как их пишет MD-сериализатор
      return { text: block.lines.flatMap((l, i) => (i === 0 ? lineNodes(l) : [{ text: "\n" }, ...lineNodes(l)])), style: "paragraph" };
    case "list":
      return { ul: block.items.map((item) => ({ text: lineNodes(item) })), style: "list" };
    case "table": {
      const last = block.columns.length - 1;
      return {
        style: "table",
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: block.columns.map((_, i) => (i === last ? "*" : "auto")),
          body: [
            block.columns.map((c) => ({ text: c.title, style: "tableHeader", alignment: c.align })),
            ...block.rows.map((row) => row.map((cellLine, i) => ({ text: lineNodes(cellLine).map((n) => ({ ...n, text: breakable(n.text) })), alignment: block.columns[i]?.align ?? "left" }))),
          ],
        },
        layout: {
          hLineWidth: (i: number) => (i === 0 ? 0 : 0.5),
          vLineWidth: () => 0,
          hLineColor: () => COLORS.rule,
          fillColor: (row: number) => (row === 0 ? COLORS.headerFill : null),
          paddingLeft: () => 4,
          paddingRight: () => 4,
          paddingTop: () => 3,
          paddingBottom: () => 3,
        },
      };
    }
  }
}

/**
 * Описание документа pdfmake по модели отчёта. Экспортируется для сверки
 * текста с MD (tests/report-pdf.test.ts): текст собирается из описания ДО
 * рендера, эталон — MD фикстурных карточек.
 */
export function buildPdfDocument(model: ReportModel, opts: { avatarName?: string } = {}): PdfNode {
  const content = model.blocks.map(blockNode);
  const first = model.blocks[0];
  // заголовок отчёта — рядом с аватаром из букв (Р2.5); текст заголовка тот же
  if (opts.avatarName && first?.kind === "heading" && first.level === 1) {
    content[0] = { columns: [avatarNode(opts.avatarName), { ...content[0], width: "*", margin: [10, 2, 0, 8] }], columnGap: 0, marginBottom: 4 };
  }
  return {
    info: { title: model.title, creator: "SourceCraft Repo Health" },
    pageSize: "A4",
    pageMargins: [40, 44, 40, 48],
    defaultStyle: { font: FONT_FAMILY, fontSize: 9.5, lineHeight: 1.25, color: COLORS.text },
    styles: {
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 8] },
      h2: { fontSize: 13.5, bold: true, margin: [0, 14, 0, 6] },
      h3: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      paragraph: { margin: [0, 0, 0, 6] },
      list: { margin: [0, 0, 0, 6] },
      table: { fontSize: 8, margin: [0, 2, 0, 8] },
      tableHeader: { bold: true, color: COLORS.secondary },
      code: { background: COLORS.codeFill },
      link: { color: COLORS.link },
      footer: { fontSize: 7.5, color: COLORS.secondary },
    },
    // колонтитул — оформление, а не содержание: имя отчёта и номер страницы
    footer: (current: number, count: number) => ({
      columns: [
        { text: model.title, style: "footer" },
        { text: `${current} / ${count}`, style: "footer", alignment: "right" },
      ],
      margin: [40, 16, 40, 0],
    }),
    content,
  };
}

/** PDF отчёта карточки — те же данные, что `renderRepoReport` (MD). */
export async function renderRepoPdf(card: RepoCard): Promise<Buffer> {
  return pdfmake.createPdf(buildPdfDocument(buildReportModel(card), { avatarName: card.repo.repo })).getBuffer();
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
