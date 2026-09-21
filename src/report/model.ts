// model.ts — модель отчёта по карточке (В4.7, контракт П1): документ как
// последовательность блоков (заголовок, абзац, список, таблица) с инлайн-
// фрагментами. Из ОДНОЙ модели рендерятся обе выгрузки: MD-сериализатор
// (`markdown.ts`) и PDF-рендерер (`pdf.ts`). Одинаковость MD и PDF держится
// построением, а не аккуратностью: обратного разбора готовой MD-строки в
// продуктовом коде нет (экранирование `mdEscape` сделало бы его хрупким).
//
// Модуль чистый: ни БД, ни `pdfmake`, ни знания о формате вывода — только
// формы данных и «плоский текст» фрагмента, общий для PDF и сверки.

/**
 * Инлайн-фрагмент строки. Экранирование MD — забота сериализатора, здесь
 * лишь указано, КАК фрагмент в MD попадает:
 *  - `text`     — как есть (текст движка и шаблонов; в MD не экранировался и до В4.7);
 *  - `escaped`  — через `mdEscape` (данные извне: слаг, язык, проблема рекомендации);
 *  - `code`     — `` `код` `` (ключи фактов, id правил); в PDF — фоновой плашкой;
 *  - `em`       — `_курсив_` с `mdEscape` внутри (заголовок репозитория);
 *  - `strong`   — `**полужирный**`, содержимое как есть;
 *  - `cell`     — значение ячейки таблицы через `cell()` (JSON, сплющивание, кап 300);
 *  - `link`     — адрес (ссылка на репозиторий в SourceCraft): в MD — голый URL
 *                 как есть (MD не меняется, В4.7 круг 2), в PDF — синяя
 *                 кликабельная ссылка;
 *  - `prepared` — готовый MD-фрагмент и его же плоский текст, собранные
 *                 вызывающим раздельно (строка итога `summaryLine`: в MD ей
 *                 передаётся экранированная проблема, в текст — сырая).
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "escaped"; text: string }
  | { kind: "code"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "cell"; value: unknown }
  | { kind: "link"; text: string }
  | { kind: "prepared"; md: string; text: string };

/** Строка — последовательность фрагментов. */
export type InlineLine = Inline[];

export interface TableColumn {
  title: string;
  align: "left" | "right";
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; content: InlineLine }
  /** абзац; несколько строк — одна MD-группа без пустой строки между ними */
  | { kind: "paragraph"; lines: InlineLine[] }
  | { kind: "list"; items: InlineLine[] }
  | { kind: "table"; columns: TableColumn[]; rows: InlineLine[][] };

export interface ReportModel {
  /** заголовок документа плоским текстом («Repo Health: org/repo») — свойства и колонтитул PDF */
  title: string;
  /** имя файла выгрузки без расширения: `<org>-<repo>-health` */
  fileStem: string;
  blocks: Block[];
}

// ---------- конструкторы фрагментов (читаемость построителя) ----------

export const text = (value: string): Inline => ({ kind: "text", text: value });
export const escaped = (value: string): Inline => ({ kind: "escaped", text: value });
export const code = (value: string): Inline => ({ kind: "code", text: value });
export const em = (value: string): Inline => ({ kind: "em", text: value });
export const strong = (value: string): Inline => ({ kind: "strong", text: value });
export const cellValue = (value: unknown): Inline => ({ kind: "cell", value });
export const link = (url: string): Inline => ({ kind: "link", text: url });
export const prepared = (md: string, plain: string): Inline => ({ kind: "prepared", md, text: plain });

// ---------- плоский текст ----------

/** Кап ячейки таблицы (символов): длинный JSON факта в отчёте не разворачивается целиком. */
export const CELL_MAX_CHARS = 300;

/**
 * Значение ячейки плоским текстом: то же правило, что `cell()` MD-сериализатора
 * (пусто — «—», объект — JSON, переносы сплющены, кап 300 с «…»), но без
 * экранирования `|`. Расхождение возможно только у значения длиннее капа с
 * вертикальной чертой внутри: MD считает кап по экранированной строке.
 */
export function cellPlain(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const flat = raw.replace(/\s*\n\s*/g, " ");
  return flat.length > CELL_MAX_CHARS ? `${flat.slice(0, CELL_MAX_CHARS)}…` : flat;
}

/** Плоский текст фрагмента — то, что читатель видит в PDF (стиль отдельно). */
export function inlinePlain(fragment: Inline): string {
  switch (fragment.kind) {
    case "cell":
      return cellPlain(fragment.value);
    case "prepared":
      return fragment.text;
    default:
      return fragment.text;
  }
}

export function linePlain(line: InlineLine): string {
  return line.map(inlinePlain).join("");
}
