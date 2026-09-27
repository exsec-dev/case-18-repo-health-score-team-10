// model.ts — модель отчёта по карточке (В4.7, контракт П1; В4.9, К9.1-К9.8):
// документ как последовательность блоков с инлайн-фрагментами. Из ОДНОЙ
// модели рендерятся обе выгрузки: MD-сериализатор (`markdown.ts`) и
// PDF-рендерер (`pdf.ts`). Одинаковость MD и PDF держится построением:
// обратного разбора готовой MD-строки в продуктовом коде нет.
//
// В4.9: к общим блокам (заголовок, абзац, список, таблица) добавлены блоки
// первого экрана и разбора — шапка, показатель с плашкой, полоса вкладов,
// полоса покрытия, строки категорий, карточки действий, блок категории в
// разборе и заголовок приложения. У каждого визуального элемента (полоса,
// плашка, шкала) есть текстовый эквивалент в самом блоке: MD печатает его
// словами, PDF рисует и подписывает теми же словами (тест «текст PDF = текст
// MD» обходит всё дерево описания pdfmake).
//
// Модуль чистый: ни БД, ни `pdfmake`, ни знания о формате вывода.

/**
 * Инлайн-фрагмент строки. Экранирование MD — забота сериализатора, здесь
 * лишь указано, КАК фрагмент в MD попадает:
 *  - `text`     — как есть (тексты шаблонов отчёта);
 *  - `escaped`  — через `mdEscape` (данные извне: слаг, язык, сохраненный текст рекомендации);
 *  - `code`     — `` `код` `` (ключи фактов в приложении); в PDF — мелким серым;
 *  - `em`       — `_курсив_` с `mdEscape` внутри (заголовок репозитория);
 *  - `strong`   — `**полужирный**`, содержимое как есть;
 *  - `link`     — ссылка: в MD `[текст](адрес)`, в PDF — синяя кликабельная.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "escaped"; text: string }
  | { kind: "code"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; url: string };

/** Строка — последовательность фрагментов. */
export type InlineLine = Inline[];

export interface TableColumn {
  title: string;
  align: "left" | "right";
  /** ширина колонки в PDF (pt, без полей ячейки); нет — по содержимому, последняя — остаток */
  width?: number;
}

/** Тема плашки — как `Label` UI (`scoreLabelTheme`). */
export type ChipTheme = "success" | "warning" | "danger" | "unknown";

/** Плашка: тема и слово в регистре предложения («Здоров», «Нет данных»). */
export interface Chip {
  theme: ChipTheme;
  text: string;
}

/** Сегмент полосы вкладов и его подпись («Документация», «+21,0»). */
export interface Segment {
  title: string;
  value: string;
  /** доля ширины полосы 0..1 */
  share: number;
}

export interface CategoryRow {
  name: string;
  /** балл для полосы (0..100); null — категории нет в оценке, полосы нет */
  score: number | null;
  /** балл словами — целое или «—» */
  scoreText: string;
  chip: Chip;
  /** «почему» — шаблон из фактов, фраза закрытой или пустой категории */
  why: string;
  /**
   * В5.5 закрытие (С13): метка у строки, как плашка у категории на карточке
   * (часть данных из прошлого анализа); null — метки нет. В PDF — плашкой над
   * «почему», в MD — первыми словами ячейки «Основание».
   */
  mark: Chip | null;
}

/**
 * Строка пояснения под показателем. `info` — перед строкой рисуется иконка
 * информации (В4 гейта): в PDF это рисунок, в MD у него текста нет, поэтому
 * сверка «текст PDF = текст MD» иконку не видит.
 */
export interface HeroNote {
  line: InlineLine;
  info?: boolean;
}

/** Второй показатель первого экрана — справа, тем же стилем (В6 гейта). */
export interface HeroSecondary {
  label: string;
  value: number | null;
  noneText: string;
  chip: Chip | null;
  /** подпись мелким под числом («по открытым данным, по нему строится рейтинг») */
  note: string | null;
}

export interface ActionItem {
  n: number;
  /** заголовок — глагол (`action` правила) */
  title: InlineLine;
  /** пояснение — причина (`problem` правила) */
  why: InlineLine;
  /** эффект (`expectedImpact`): «+1,2 к HealthCraft Index» или «повысит балл категории «Задачи»» */
  effect: string;
  /** подпись под числовым эффектом («ожидаемый эффект»); null — у эффекта без числа */
  effectNote: string | null;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; content: InlineLine }
  /** абзац; несколько строк — одна MD-группа без пустой строки между ними */
  /**
   * `tone`: muted — вводная; fine — мелкая сноска; subhead — подзаголовок
   * таблицы; caption — подпись таблицы; note — примечание на подложке (п.9
   * круга 2: в PDF светло-серый фон, в MD — обычный абзац).
   */
  | { kind: "paragraph"; lines: InlineLine[]; tone?: "muted" | "fine" | "subhead" | "caption" | "note" }
  | { kind: "list"; items: InlineLine[] }
  /** таблица; `total` — последняя строка итоговая; `small` — мелкий кегль приложения */
  | { kind: "table"; columns: TableColumn[]; rows: InlineLine[][]; total?: boolean; small?: boolean }
  /** шапка: репозиторий, ссылка, название документа, плашка доступа и дата анализа */
  | { kind: "header"; slug: string; title: InlineLine | null; link: { text: string; url: string }; doc: string; docChip: Chip | null; date: string | null }
  /**
   * Крупный показатель с плашкой; `value` null — «Оценки нет». `secondary` —
   * второй показатель справа в том же ряду (В6 гейта). `verdict` — строка под
   * числом; у отчёта с оценкой её нет (В3 гейта), у отчётов без оценки она
   * несёт факт («Скан был…», «Собрано 23% данных…»).
   */
  | { kind: "hero"; label: string; value: number | null; noneText: string; chip: Chip | null; secondary: HeroSecondary | null; verdict: string | null; notes: HeroNote[] }
  /** полоса «Вклад категорий в оценку» со шкалой 3 зон; `note` — строка вместо полосы (потолок, нет кода) */
  | {
      kind: "contributions";
      title: string;
      segments: Segment[];
      rest: Segment | null;
      zones: { theme: "danger" | "warning" | "success"; text: string; share: number }[];
      note: string | null;
    }
  /** полоса покрытия данными с отметкой порога (страница без оценки) */
  | { kind: "coverage"; title: string; share: number; threshold: number; collected: string; thresholdText: string }
  /** строки категорий первого экрана; `columns` — подписи колонок (текст шапки MD-таблицы) */
  | { kind: "categories"; columns: [string, string, string, string]; rows: CategoryRow[] }
  /** карточки действий; `compact` — список раздела «Рекомендации» */
  | { kind: "actions"; compact: boolean; items: ActionItem[] }
  /** категория в разборе: заголовок с баллом и плашкой, таблица показателей, примечания */
  | { kind: "detail"; title: string; scoreText: string; chip: Chip; table: { columns: TableColumn[]; rows: InlineLine[][] } | null; notes: InlineLine[] }
  /** заголовок приложения — в PDF с новой страницы */
  | { kind: "appendix"; title: string; intro: string };

export interface ReportModel {
  /** заголовок документа плоским текстом («Repo Health: org/repo») — свойства PDF */
  title: string;
  /** имя файла выгрузки без расширения: `<org>-<repo>-health` */
  fileStem: string;
  /** колонтитул PDF: «org/repo – отчет HealthCraft от дата» */
  footer: string;
  /** шапка страниц PDF со 2-й: [репозиторий, «Отчет HealthCraft, дата»] */
  runningHead: [string, string];
  /**
   * К9.8: слот AI-summary В5 в первом экране — пустой до В5 и не печатается
   * ни в MD, ни в PDF (содержание и валидатор — В5).
   */
  aiSummary: string | null;
  blocks: Block[];
}

// ---------- конструкторы фрагментов (читаемость построителя) ----------

export const text = (value: string): Inline => ({ kind: "text", text: value });
export const escaped = (value: string): Inline => ({ kind: "escaped", text: value });
export const code = (value: string): Inline => ({ kind: "code", text: value });
export const em = (value: string): Inline => ({ kind: "em", text: value });
export const strong = (value: string): Inline => ({ kind: "strong", text: value });
export const link = (value: string, url: string): Inline => ({ kind: "link", text: value, url });

// ---------- плоский текст ----------

/** Плоский текст фрагмента — то, что читатель видит в PDF (стиль отдельно). */
export function inlinePlain(fragment: Inline): string {
  return fragment.text;
}

export function linePlain(line: InlineLine): string {
  return line.map(inlinePlain).join("");
}
