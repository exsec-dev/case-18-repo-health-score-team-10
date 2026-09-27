// format.ts — показ чисел и дат в одном месте. Правило tri-state (закон 2
// AGENTS.md) живёт здесь: отсутствие данных везде выглядит одинаково
// нейтрально — «нет данных», никогда не 0 и никогда не красным.

import { normalizeTypography } from "../summary/typography";

export const NO_DATA = "нет данных";
// Ступень 4 (В-2, §2 23.09): одно название итога без оценки на всех экранах и в отчете
export const NO_SCORE = "Оценки нет";

/**
 * Ступень 4 (Ф5): имя файла отчета. Слаг бывает длиной 243 символа — с ним
 * Chrome на Windows молча отменял загрузку (0 байт, без тоста). Имя
 * обрезается до 120 символов без хвостовых дефисов; одна функция для
 * кнопки карточки и `content-disposition` сервера.
 */
export function reportFileName(org: string, repo: string, ext: "md" | "pdf"): string {
  const base = `${org}-${repo}`.slice(0, 120).replace(/[-_.]+$/, "");
  return `${base}-health.${ext}`;
}

/**
 * В4.4 (кластер M-9): RU-имена категорий из константы — фолбэк, когда
 * /api/meta не загрузился (раньше страница показывала сырые ключи).
 */
export const CATEGORY_TITLES_RU: Record<string, string> = {
  documentation: "Документация",
  cicd: "CI/CD",
  security: "Безопасность",
  activity: "Активность",
  issues: "Задачи",
  code: "Состояние кода",
};

/** Балл категории 0..100 — целым: дробь тут ничего не объясняет. */
/**
 * В5.3-М (Н13, F20): показанное целое балла — одно правило для карточки,
 * рейтинга, отчета, значка и хранимого индекса. Сначала снимается двоичный шум
 * (39,5 в расчете бывает 39.49999999999999 и без правки округлялось в 39 —
 * «в зоне риска» вместо «требует внимания»), затем обычное округление.
 */
export function roundScore(value: number): number {
  return Math.round(Math.round(value * 1e9) / 1e9);
}

export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(roundScore(value));
}

/** Балл submetric приходит долей 0..1 — на экране это проценты (§2.2 плана). */
export function fmtSubmetric(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}`;
}

/** Число для показа (В4.9, К9.11): целое как есть, дробное — до 2 знаков, запятая и минус «−». */
export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  // Ступень 4 (Ф15): целые — с разрядами, как место в рейтинге («4 069»)
  if (Number.isInteger(value)) return fmtCount(value);
  return fmtDecimal(value, 2, { trim: true });
}

/**
 * В4.7 (П5, решения 21.09 «единый формат дат UI» и В4): русские сокращения
 * месяцев — ЗАКРЫТОЙ таблицей, а не `Intl`: вывод `toLocale*` зависит от
 * браузера и его ICU (запятые, «г.», ведущие нули), а формат обязан быть
 * одинаковым везде.
 */
export const MONTHS_SHORT_RU = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."] as const;

/**
 * Разбор даты для показа. Чистая дата `YYYY-MM-DD` (например, начало
 * усеченной истории) — полночь по ЛОКАЛЬНОМУ времени: как UTC-полночь она
 * показала бы западнее Гринвича предыдущий день. Остальное — как умеет `Date`.
 */
function parseShown(iso: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!day) return new Date(iso);
  const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  // «2026-13-45» не перекатывается в другой месяц: невалидная строка остается невалидной
  return d.getMonth() === Number(day[2]) - 1 && d.getDate() === Number(day[3]) ? d : new Date(Number.NaN);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Дата без времени — поле, у которого времени по смыслу нет: «15 сент. 2026». Пусто — «—», мусор — как пришел. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // день без ведущего нуля, полный год, без запятой и «г.»; пояс — локальный браузера
  return `${d.getDate()} ${MONTHS_SHORT_RU[d.getMonth()]} ${d.getFullYear()}`;
}

/** Дата и время: время `HH:mm` (24 часа) первым — «12:00 18 янв. 2023». Пусто — «—», мусор — как пришел. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${fmtDate(iso)}`;
}

/**
 * UTC-форматтеры для отчётов (решение 24.09, Алексей: «время должно быть
 * в utc» — артефакт MD/PDF не зависит от машины рендера). Локальные
 * fmtDate/fmtDateTime остаются для интерфейса.
 */
export function fmtDateUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS_SHORT_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtDateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} ${fmtDateUtc(iso)}`;
}

/**
 * «N рекомендаций» с русским согласованием числа (В4.7, П3.4, счётчик в
 * «Моих репозиториях»): 1 рекомендация, 2-4 рекомендации, 5-20 рекомендаций,
 * 21 рекомендация… Цифрой, а не словом (правило языка UI).
 */
export function recommendationsText(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? "рекомендация" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "рекомендации" : "рекомендаций";
  return `${fmtCount(count)} ${word}`;
}

/** Крупные счётчики — с разделителем разрядов: «27 621» читается, «27621» нет. */
export function fmtCount(value: number): string {
  return value.toLocaleString("ru-RU");
}

export function fmtCoverage(coverage: number): string {
  return `${Math.round(coverage * 100)}%`;
}

/**
 * В4.6 круг 2 (Р20, находка приёмки круга 1): доли ОКРУГЛЯЮТСЯ до 2 знаков,
 * целые остаются как есть. Причина конкретная: вариант А компоновки раскрывает
 * худшую категорию на первом экране карточки, и туда попало «значение:
 * 0.8723404255319149» — шум вместо факта.
 *
 * Где применяется — решение владельца 20.09: ТОЛЬКО список подметрик на
 * карточке и таблица подметрик в MD-отчёте. Поповер «Основание» остаётся
 * сырым JSON: это доказательная база, и её задача — воспроизводимость, а не
 * читаемость. Словарь единиц для 28 подметрик в этот круг НЕ входит
 * (кандидат в В4.7) — здесь только формат чисел.
 *
 * Рекурсия по объектам и массивам нужна потому, что значение подметрики —
 * не всегда число: часть фактов приходит объектом (`{"bytes":8000}`), и доля
 * с шестнадцатью знаками может лежать внутри него. Одна копия правила на
 * страницу и на отчёт: `markdown.ts` вызывает эту же функцию.
 */
export function roundFacts(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(roundFacts);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, roundFacts(v)]));
  }
  return value;
}

/** Значение факта — читаемой строкой; объекты как JSON (доказательство, не проза). */
export function fmtFactValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 1);
}

/** Статус скана — человеческим словом, без жаргона таблицы (queued/running — Ф2.9/Ф2.16). */
export function scanStatusText(status: string): string {
  switch (status) {
    case "ok":
      return "полный";
    case "partial":
      return "частичный";
    case "bad":
      return "сбойный";
    case "queued":
      return "в очереди";
    case "running":
      return "идет";
    default:
      return status;
  }
}

/**
 * Уровень Score для цвета полос (дисплей, не методика): ≥70 — хорошо,
 * 40–69 — требует внимания, <40 — плохо. Нет данных — нейтрально
 * (закон 2: отсутствие данных никогда не красное).
 */
export function scoreTheme(value: number | null | undefined): "success" | "warning" | "danger" | "misc" {
  if (value === null || value === undefined) return "misc";
  // уровень — по тому же округлённому числу, что видит зритель (69.6 показан как 70);
  // Н13: округление устойчиво к двоичному шуму (39.49999999999999 → 40)
  const shown = roundScore(value);
  if (shown >= 70) return "success";
  if (shown >= 40) return "warning";
  return "danger";
}

/**
 * В4.6 (У22, ДП3): те же полосы, что делит `scoreTheme()`, НАЗВАННЫЕ словом.
 * До этой вехи слова жили только в комментарии к `scoreTheme()`: на экране
 * стояло число без шкалы, и «83» нечем было отличить от «отлично» или
 * «терпимо». Формулировки — решение HQ 20.09 (право владельца отменить).
 * Одна копия на рейтинг, карточку и MD-отчёт: `markdown.ts` импортирует
 * отсюда (зависимость в дереве идёт web ← report).
 */
export const SCORE_WORDS: Record<"success" | "warning" | "danger", string> = {
  success: "здоров",
  warning: "требует внимания",
  danger: "в зоне риска",
};

/** Слово шкалы для показанного числа; нет данных — не слово шкалы, а «нет данных» (закон 2). */
export function scoreWord(value: number | null | undefined): string {
  const theme = scoreTheme(value);
  return theme === "misc" ? NO_DATA : SCORE_WORDS[theme];
}

/**
 * Цвет ЧИСЛА по тем же порогам (У20). `-heavy`-варианты выбраны не из вкуса:
 * после палитрового паса В4.6 они дают 5,9–8,5:1 в тёмной и 5,8–6,3:1 в
 * светлой теме, то есть число остаётся прозой уровня AA в обеих темах.
 * success-диапазон КРАСИМ — решение владельца 20.09 (перекрывает
 * рекомендацию дизайн-пары «хорошее оставить нейтральным»).
 * Для `null` цвета нет вовсе: «нет данных» — другой ТИП ячейки
 * (`Label theme="unknown"`), а не бледное значение (охранный пункт 1).
 */
export function scoreColor(value: number | null | undefined): "positive-heavy" | "warning-heavy" | "danger-heavy" | "secondary" {
  switch (scoreTheme(value)) {
    case "success":
      return "positive-heavy";
    case "warning":
      return "warning-heavy";
    case "danger":
      return "danger-heavy";
    default:
      return "secondary";
  }
}

/**
 * Тема чипа `Label` для показанного числа. `scoreTheme()` отдаёт `misc` —
 * тему ПОЛОСЫ; у чипа нейтральное состояние называется `unknown`, и именно
 * им во всём продукте нарисовано «нет данных» (охранный пункт 1).
 */
export function scoreLabelTheme(value: number | null | undefined): "success" | "warning" | "danger" | "unknown" {
  const theme = scoreTheme(value);
  return theme === "misc" ? "unknown" : theme;
}

/** Заголовок легенды шкалы — один на обе панели (рейтинг и методика карточки). */
export const SCORE_LEGEND_TITLE = "Шкала оценки";

/** Легенда шкалы: слово, диапазон, тема чипа. Порядок — сверху вниз от здорового. */
export const SCORE_SCALE: { theme: "success" | "warning" | "danger"; word: string; range: string }[] = [
  { theme: "success", word: SCORE_WORDS.success, range: "70-100" },
  { theme: "warning", word: SCORE_WORDS.warning, range: "40-69" },
  { theme: "danger", word: SCORE_WORDS.danger, range: "0-39" },
];

/** Короткая форма «нет данных» для узких колонок таблицы («Нет данных» не влезает в 59px). */
export const NO_DATA_SHORT = "н/д";

/**
 * В4.6 (У27, ДП8): ОДИН способ набрать слаг репозитория. Дизайн-пара нашла
 * четыре разных на трёх экранах — «org / repo», «org/repo», только `repo`,
 * ссылка с разным набором. Текстовая форма (тултипы, заголовки ошибок,
 * крошки, отчёт) — здесь; визуальная (с пробелами вокруг слеша, как у
 * платформы) — компонент `RepoSlug` в ui.tsx. Решает один модуль, а не
 * каждый экран по-своему.
 */
export function slugOf(org: string, repo: string): string {
  return `${org}/${repo}`;
}

/**
 * В5.3 круг 4 (дизайн сравнения §4.10): длинное имя — многоточие В СЕРЕДИНЕ с
 * сохранением хвоста. У команд хакатона общий org и общий префикс
 * (`case-13-…-team-112`), различие — в хвосте, и обрезка с конца спрятала бы
 * именно его. Короче порога — без изменений.
 */
export function middleEllipsis(text: string, max: number, tail = 10): string {
  if (text.length <= max) return text;
  const keepTail = Math.min(tail, max - 2);
  return `${text.slice(0, max - keepTail - 1)}…${text.slice(text.length - keepTail)}`;
}

/**
 * Мера имени в `DefinitionList` — одна на все панели (У27: единый nameMaxWidth).
 * Завершающие правки В4.9 (3): 140 → 150 — «Версия методики» в панели рейтинга
 * уходила на вторую строку; карточка уже жила на 150 своей константой.
 */
export const DEFINITION_NAME_WIDTH = 150;

/** Категория для строки итога: имя и балл (null — категория без данных, в итог не идёт). */
export interface SummaryCategory {
  title: string;
  score: number | null;
}

/** Рекомендация с наибольшим измеримым приростом; `problem` приходит УЖЕ экранированной вызывающим. */
export interface SummaryTop {
  problem: string;
  impact: string;
}

export interface SummaryInput {
  categories: SummaryCategory[];
  recommendations: number;
  top: SummaryTop | null;
}

/**
 * В4.6 (У26/У13, ДП7): строка итога — «сильнее всего…, слабее всего…,
 * рекомендаций N, наибольший прирост даёт…».
 *
 * Почему функция живёт ЗДЕСЬ, а не в `src/report/markdown.ts`, где родился
 * этот текст: аудит-пара промпта показала, что шов ровно один.
 * `summarySection()` приватна и возвращает массив markdown-строк, а импорт
 * `src/report` в клиент тянет серверный слой и валит `Bun.build` (живой тест
 * tests/web.test.ts). Зависимость в дереве идёт web ← report
 * (`markdown.ts` уже импортирует `../web/format`), поэтому генератор
 * переезжает сюда чистой функцией, а `markdown.ts` её вызывает: одна
 * формулировка на страницу и на отчёт, новых полей и маршрутов API нет.
 *
 * Вход — плоские структуры, а НЕ `RepoCard`: `src/api/repos` тянет
 * `bun:sqlite`, и типовой импорт из него в этот модуль сломал бы бандл.
 * Экранирование markdown остаётся заботой вызывающего (`markdown.ts`
 * передаёт `mdEscape(problem)`) — здесь нет знания о формате вывода.
 */
export function summaryLine(input: SummaryInput, opts: { withCount?: boolean } = {}): string {
  const scored = input.categories.filter((c): c is { title: string; score: number } => c.score !== null);
  const parts: string[] = [];
  if (scored.length > 0) {
    const best = [...scored].sort((a, b) => b.score - a.score)[0]!;
    const worst = [...scored].sort((a, b) => a.score - b.score)[0]!;
    parts.push(`Сильнее всего – ${best.title} (${fmtScore(best.score)}), слабее всего – ${worst.title} (${fmtScore(worst.score)}).`);
  }
  const top = input.top ? `наибольший измеримый прирост дает «${input.top.problem}» (${input.top.impact})` : "";
  if (opts.withCount !== false) {
    parts.push(`Рекомендаций: ${input.recommendations}${top ? `; ${top}` : ""}.`);
  } else if (top) {
    // страница показывает счётчик ссылкой рядом со строкой (Р13), поэтому
    // внутри строки его не повторяем — иначе «Рекомендаций: N» читается дважды
    parts.push(`${top.charAt(0).toUpperCase()}${top.slice(1)}.`);
  }
  return parts.join(" ");
}

/**
 * В4.6 (У25, ДП6): вклад категории БЕЗ данных не печатается нулём.
 * «вклад 0%» — единственное место, где продукт своими руками опровергал
 * собственный tri-state: категория читалась как «дала ноль», тогда как её
 * вес выброшен и перенормирован. Одна копия на карточку и на MD-таблицу.
 */
export const NOT_COUNTED = "не учитывается";

export function contributionText(score: number | null | undefined, contribution: number): string {
  return score === null || score === undefined ? NOT_COUNTED : `${contribution}%`;
}

/** Знак минус (U+2212) — у отрицательных чисел в тексте, не дефис (К9.11). */
export const MINUS = "\u2212";

/**
 * В4.9 (К9.11): русское число — десятичная запятая и минус «−». `digits` —
 * знаков после запятой; `trim` убирает хвостовые нули («0,5», а не «0,50»;
 * целое — без запятой). Одна копия для UI и отчета.
 */
export function fmtDecimal(value: number, digits = 1, opts: { trim?: boolean } = {}): string {
  const p = 10 ** digits;
  const rounded = Math.round(Math.abs(value) * p) / p;
  let body = rounded.toFixed(digits);
  if (opts.trim && body.includes(".")) body = body.replace(/\.?0+$/, "");
  const sign = value < 0 && rounded !== 0 ? MINUS : "";
  return `${sign}${body.replace(".", ",")}`;
}

/** Потолок Repo Health Score при утекших секретах (методика, `SECRETS_CRITICAL_TOTAL_CAP`; веб не импортирует `src/score`). */
export const SECRETS_CAP = 49;

/** Категория для расчета вкладов: балл (null — данных нет) и вес в показателе. */
export interface ContributionInput {
  key: string;
  title: string;
  score: number | null;
  weight: number;
}

/** Вклад категории в показатель: точный (приложение) и показанный (десятые, метод наибольшего остатка). */
export interface ContributionSegment {
  key: string;
  title: string;
  /** балл × вес / Σ весов категорий с данными — без округления */
  exact: number;
  /** показанный вклад в десятых балла (21,0 → 210); сумма показанных = показатель × 10 */
  tenths: number;
  /** сколько категория недобирает с учетом веса: вес / Σ весов × (100 − балл) */
  loss: number;
  /** доля веса категории среди категорий с данными (0..1) */
  share: number;
}

export type Contributions =
  /** обычный случай: сумма показанных вкладов = показатель */
  | { kind: "bar"; total: number; segments: ContributionSegment[]; missing: number; losses: ContributionSegment[] }
  /** итог ограничен потолком за утекшие секреты: вклады дали бы больше показателя */
  | { kind: "capped"; total: number; uncapped: number; segments: ContributionSegment[] }
  /** в репозитории нет кода: показатель 0 по правилу методики, вкладов нет; reason — причина «Состояния кода» (Н4) */
  | { kind: "empty"; total: number; reason?: string | null };

/**
 * В4.9 (К9.1, К9.12): «Вклад категорий в оценку» — ОДНА чистая функция для
 * отчета и карточки. Вклад категории = балл × вес / Σ весов категорий с
 * данными (та же формула, что `totalsFromCategories`; веса — аргументом:
 * карточка берет их из `/api/meta`, отчет — из карточки и `INDEX_WEIGHTS`).
 * Показ — до десятых МЕТОДОМ НАИБОЛЬШЕГО ОСТАТКА к показанному (целому)
 * показателю: сумма показанных вкладов равна показанному числу, «не набрано»
 * = 100 − показатель. Округление каждого вклада отдельно этого не
 * гарантирует (uikit: 20,9 + 18,3 + 11,8 + 18,8 = 69,8 при показателе 70).
 * Потолок 49 и пустой репозиторий — отдельные виды: у них вклады не
 * складываются в показатель, и полоса их не рисует.
 */
export function categoryContributions(cats: ContributionInput[], total: number | null, opts: { codeEmpty?: boolean; codeEmptyReason?: string | null } = {}): Contributions | null {
  if (total === null) return null;
  const shown = roundScore(total);
  if (opts.codeEmpty) return { kind: "empty", total: shown, reason: opts.codeEmptyReason ?? null };
  const withData = cats.filter((c): c is ContributionInput & { score: number } => c.score !== null && c.weight > 0);
  const weightSum = withData.reduce((s, c) => s + c.weight, 0);
  if (weightSum === 0) return null;
  const segments: ContributionSegment[] = withData.map((c) => ({
    key: c.key,
    title: c.title,
    exact: (c.score * c.weight) / weightSum,
    tenths: 0,
    loss: (c.weight / weightSum) * (100 - c.score),
    share: c.weight / weightSum,
  }));
  const uncapped = segments.reduce((s, c) => s + c.exact, 0);
  if (Math.round(uncapped) > shown && shown <= SECRETS_CAP) {
    // сумма вкладов больше показателя только у потолка за утекшие секреты
    for (const s of segments) s.tenths = Math.round(s.exact * 10);
    return { kind: "capped", total: shown, uncapped, segments };
  }
  largestRemainder(segments, shown * 10);
  const losses = [...segments].filter((s) => s.loss >= 0.05).sort((a, b) => b.loss - a.loss || a.key.localeCompare(b.key)).slice(0, 2);
  return { kind: "bar", total: shown, segments, missing: 100 - shown, losses };
}

/** Распределение целых десятых так, чтобы их сумма была ровно `target` (метод наибольшего остатка). */
function largestRemainder(segments: ContributionSegment[], target: number): void {
  // шум двоичной арифметики (20.999999) не должен решать, кому достанется десятая
  const scaled = segments.map((s) => Math.round(s.exact * 10 * 1e6) / 1e6);
  segments.forEach((s, i) => (s.tenths = Math.floor(scaled[i]!)));
  let diff = target - segments.reduce((sum, s) => sum + s.tenths, 0);
  const rest = (i: number) => scaled[i]! - Math.floor(scaled[i]!);
  // десятые получают только категории с ненулевым вкладом: у балла 0 вклад 0,
  // даже если округление итога требует раздать больше десятых, чем остатков
  const order = segments.map((_, i) => i).filter((i) => scaled[i]! > 0);
  if (order.length === 0) return;
  if (diff > 0) {
    order.sort((a, b) => rest(b) - rest(a) || a - b);
    for (let k = 0; diff > 0; k = (k + 1) % order.length, diff--) segments[order[k]!]!.tenths++;
  } else if (diff < 0) {
    order.sort((a, b) => rest(a) - rest(b) || a - b);
    for (let k = 0, guard = 0; diff < 0 && guard < 10_000; k = (k + 1) % order.length, guard++) {
      const s = segments[order[k]!]!;
      if (s.tenths > 0) {
        s.tenths--;
        diff++;
      }
    }
  }
}

/** Заголовок полосы вкладов — один на карточке и в отчете (эталон вида, круг 2). */
export const CONTRIBUTIONS_TITLE = "Вклад категорий в оценку";

/** Подпись остатка полосы: «не набрано 30». */
export const CONTRIBUTIONS_REST = "не набрано";

/** Строка вместо полосы, когда вклады не складываются в показатель (потолок 49, нет кода). */
export function contributionsNote(c: Contributions): string | null {
  if (c.kind === "empty") {
    // 4.3.0 (Н4, D4): причина по виду — «нет ни одного файла» только там, где файлов нет
    const why = c.reason && c.reason.startsWith("no source code — ") ? noDataReason("code", c.reason) : "В репозитории нет кода.";
    return `${why.replace(/ – оценивать нечего\.$/, ".")} Поэтому оценка – 0. Это не ошибка сервиса: оценивать нечего.`;
  }
  if (c.kind === "capped") return `Итог ограничен ${c.total} баллами: AppSec нашел утекшие секреты. Без ограничения категории дали бы ${fmtDecimal(c.uncapped, 1)}.`;
  return null;
}

// В4.9 ч.2 (А3, Г2.8): строки «Сильнее всего итог снижают…» нет ни в отчете,
// ни на карточке — `lossParts` удален вместе с последним вызовом.

/** Показанный вклад: «+21,0». */
export function fmtContribution(tenths: number): string {
  return `+${fmtDecimal(tenths / 10, 1)}`;
}

/** Потеря с учетом веса: «−12,1». */
export function fmtLoss(loss: number): string {
  return `${MINUS}${fmtDecimal(loss, 1)}`;
}

// ---------- В4.9 (К9.2, К9.13): состояния категорий одними словами везде ----------

/** Опорная фраза «категории нет в оценке» — одна на карточку, рейтинг, MD и PDF. */
export const NOT_IN_SCORE = "Категория в оценке не участвует и ее не снижает.";

/** Закрытая категория у зрителя без сессии (аноним, истекшая сессия). */
export const LOCKED_FOR_ANON = "Видна участникам репозитория.";

/**
 * К9.13: фраза закрытой зрителю категории — по причине доступа. Анониму —
 * «Видна участникам репозитория.»; вошедшему — причина (`accessLockText`:
 * нет токена, нет прав, токен отклонен). Одна функция для карточки и отчета.
 */
export function lockedCategoryText(access: string | undefined, auth: string | undefined): string {
  if (auth === undefined || auth === "no-session") return LOCKED_FOR_ANON;
  return accessLockText(access) ?? ACCESS_LOCK_TEXT["check-failed"];
}

/**
 * Причина «нет данных» категории — предложением для читателя (К9.2).
 * Причины расчет пишет по-английски (`compute.ts`, данные скана не
 * меняются); здесь — их показ. Неизвестная причина наружу не идет:
 * печатается нейтральное «Данных нет.» (К9.9 — сырой английский не
 * показывается никогда).
 */
export function noDataReason(key: string, reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  // 4.2.0 (М1.2, М2.1 аудита В5.3): причины «мало данных» — каждая своей веткой
  if (r.startsWith("too little data — no finding density")) return "Находки AppSec есть, но размер кода неизвестен и доля закрытых не посчитана – категорию не оцениваем.";
  // 4.3.0 (Н4): причины по виду — пустой репо, нет кода, не прочитан, строки не прочитаны.
  // Круг 2: причины «мало кода» (Р4б → сжатие В3) и «история из синков» (Н10 → К5)
  // сняты; 4.3.0 не выкатывалась — старых оценок с ними нет
  if (r.startsWith("no source code — ")) return CODE_EMPTY_TEXT[r.slice("no source code — ".length)] ?? CODE_EMPTY_TEXT["only non-code files"]!;
  if (r === "repository empty") return REPOSITORY_EMPTY_TEXT;
  // К3: файлы кода больше лимита сервиса или бинарные — строки не прочитаны
  if (r.startsWith("too little data — lines miscounted by an older collector")) return "Строки кода посчитаны прежней версией сборщика с ошибкой – категория оценится после повторного анализа репозитория.";
  if (r.startsWith("too little data — lines of code not read")) return "Строки кода прочитать не удалось: файлы больше лимита сервиса, не текстовые или чтение прервалось – категорию не оцениваем.";
  // прежние модели (4.2.0): строки старых оценок
  if (r.startsWith("too little data — no commit history")) return "Истории коммитов нет – без нее активность не оцениваем: одни счетчики запросов на слияние и релизов категорию не определяют.";
  if (r.startsWith("too little data — no lines of code")) return "В репозитории нет строк кода, по которым считается плотность TODO, – категорию не оцениваем.";
  if (r.startsWith("ci.yaml not parsed")) return "Файл .sourcecraft/ci.yaml не удалось разобрать – есть ли в нем шаги, неизвестно, поэтому категорию не оцениваем.";
  if (key === "security" || r.startsWith("AppSec data unavailable")) return SECURITY_NO_DATA;
  if (r.startsWith("ci runs pending")) return "Запуски CI идут, завершенных пока нет – категорию не оцениваем.";
  if (r.startsWith("ci runs no-data")) return CI_RUNS_CAP_TEXT;
  if (r === "git channel no-data") return GIT_UNREAD_TEXT;
  if (r === "git+rest channels no-data") return "Нет данных ни из репозитория, ни от SourceCraft.";
  if (r === "issues channel no-data") return "Список задач недоступен.";
  return "Данных нет.";
}

/** Н4: репозиторий пуст — коммитов нет (данные, а не сбой скачивания). */
export const REPOSITORY_EMPTY_TEXT = "В репозитории нет ни одного коммита – оценивать нечего.";

/** Н4: репозиторий не прочитан (лимит, ошибка) — незнание. */
export const GIT_UNREAD_TEXT = "Репозиторий не удалось прочитать – произошла ошибка или он больше лимита сервиса.";

/** Н4: виды «кода нет» (`codeEmptyKind` расчета) — каждый своей фразой. */
const CODE_EMPTY_TEXT: Record<string, string> = {
  "repository empty": REPOSITORY_EMPTY_TEXT,
  "no files": "В репозитории нет ни одного файла – оценивать нечего.",
  "only non-code files": "В репозитории нет файлов кода – только документы, лицензии или картинки.",
  "no lines of code": "Файлы кода в репозитории пустые – строк кода нет.",
};

/** Потолок CI без результатов запусков — одна фраза для «почему», маркера и приложения. */
export const CI_RUNS_CAP_TEXT = "Результаты запусков CI сервису не видны – категорию не оцениваем: честное отсутствие данных вместо догадок.";

/**
 * В5.5 закрытие (С19): предупреждение карточки «CI настроен, запусков не видно»
 * (низ плашки Repo Health Score, UX-проход В5.2 25.09) — одна копия для
 * карточки и отчета: отчет печатает его строкой под показателями.
 */
export const CI_CAP_TITLE = "CI настроен, но запусков не видно";
export const CI_CAP_TEXT =
  "В репозитории есть настройки CI, но результаты сборок нам не видны: доступ к ним закрыт или сборки еще не запускались. Поэтому автоматизацию не оцениваем – без данных оценка не снижается.";

/**
 * В5.5 закрытие (С13): метка категории, часть данных которой взята из прошлого
 * анализа, — одна копия для плашки карточки и строки категории отчета.
 */
export const STALE_CATEGORY_MARK = "Данные из прошлого анализа";

/** Место без числа: публичный без индекса — «индекс не выставлен», прочие — «не в публичном рейтинге». */
export const NO_RANK_NO_INDEX = "без места – индекс не выставлен";
export const NO_RANK_NOT_PUBLIC = "не в публичном рейтинге";

/**
 * В5.5 закрытие (С14): место в рейтинге словами — одно правило для паспорта
 * карточки, сравнения и отчета. Есть место — «#N из M»; нет — причина по
 * видимости и индексу, а не прочерк «нет данных»: у приватного репозитория
 * место не неизвестно, его в публичной выборке нет.
 */
export function rankText(visibility: string, score: { healthcraftIndex: number | null; rank: number | null; rankedTotal: number | null } | null): string {
  if (score && score.rank !== null && score.rankedTotal !== null) return `#${fmtCount(score.rank)} из ${fmtCount(score.rankedTotal)}`;
  return rankNoneText(visibility, score?.healthcraftIndex ?? null);
}

/** Причина «места нет» (сравнение, паспорт карточки, отчет). */
export function rankNoneText(visibility: string, healthcraftIndex: number | null): string {
  return visibility === "public" && healthcraftIndex === null ? NO_RANK_NO_INDEX : NO_RANK_NOT_PUBLIC;
}

/** Безопасность без данных: откуда берутся данные категории. */
export const SECURITY_NO_DATA = "Безопасность считается по данным AppSec SourceCraft, а они видны только с правом доступа.";

/** Пустая категория (данных нет): причина + опорная фраза. */
export function emptyCategoryText(key: string, reason: string | null | undefined): string {
  return `${noDataReason(key, reason)} ${NOT_IN_SCORE}`;
}

/**
 * «Каких данных не хватило» — строка списка: категория и причина. Вход —
 * строка `noData` оценки («documentation: git channel no-data»). ОДНА копия
 * (до В4.9 их было две: карточка и MD, совпадавшие только аккуратностью).
 */
export function humanNoData(raw: string): string {
  const [category = "", ...rest] = raw.split(":");
  const reason = rest.join(":").trim();
  const title = CATEGORY_TITLES_RU[category] ?? category;
  const sentenceText = noDataReason(category, reason);
  return category === "security" ? sentenceText : `${title}: ${sentenceText.charAt(0).toLowerCase()}${sentenceText.slice(1)}`;
}

/**
 * Причина «нет данных» Безопасности при открытом канале — по причине факта
 * `appsec.findings` (no-data: access / no-scan / incomplete). Одна копия для
 * карточки и отчета; прочее — общая фраза.
 */
export function securityNoDataReason(fact: { status: string; value: unknown } | undefined): string {
  const reason = fact && fact.status === "no-data" ? (fact.value as { reason?: unknown } | null)?.reason : undefined;
  if (reason === "access") return "У токена, с которым шел анализ, нет права на данные AppSec (src.repositories.useAppSecScan).";
  if (reason === "no-scan") return "AppSec еще не проверял этот репозиторий или проверка не закончилась.";
  if (reason === "incomplete") return "AppSec ответил не полностью, поэтому данных о безопасности нет. Это не значит, что уязвимостей нет.";
  // Г1.8 гейта: сюда приходит только зритель, которому категория ВИДНА
  // (закрытую забирает `lockedCategoryText`), поэтому причина «видны с правом
  // доступа» противоречила бы действию «проверка не подключена». Одна причина
  // на один прочерк — та же, что в рекомендации.
  return SECURITY_NO_SCAN;
}

/** Причина прочерка Безопасности зрителю с доступом (Г1.8): как в действии движка. */
export const SECURITY_NO_SCAN = "Данных AppSec по репозиторию нет: проверка не подключена или не завершена.";

/**
 * Д3 (В4.9, «как сейчас в UI»): пустое состояние без оценки — ОДИН текст
 * для карточки и отчета. Скан был, оценки нет — «данных не хватило»; скана
 * не было — «еще не сканировался».
 */
export function noScoreText(scan: { status: string } | null): { title: string; description: string } {
  // Ступень 4 (Ф6): текст по статусу — сбой не называется «анализ прошел»
  if (scan && scan.status === "bad") {
    return {
      title: "Оценки пока нет",
      description: "Последний анализ завершился сбоем: источники данных не ответили. Это не плохая оценка – при следующем анализе данные соберутся заново.",
    };
  }
  if (scan) {
    // В4.9 ч.2 (А10, Г2.3): без «скана» и «фактов» — словами читателя
    return {
      title: "Оценки пока нет",
      description: "Анализ прошел, но данных для оценки не хватило. Это не плохая оценка: при следующем анализе данные соберутся заново.",
    };
  }
  // Ступень 4 (В-3): «анализ», не «скан»
  return { title: "Репозиторий есть в каталоге, но еще не анализировался", description: "Оценка появится после первого анализа репозитория." };
}

/**
 * Д5: оговорка сборщика задач «дата закрытия подменена датой изменения»
 * (`issues.stats.close_date_note`, по-английски: «completed_at missing on
 * N/M closed — used updated_at fallback») — предложением для читателя.
 * Числа берутся из заметки; форма не узнана — общая фраза без чисел.
 */
export function closeDateText(note: unknown): string | null {
  if (typeof note !== "string" || note === "") return null;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(note);
  const counts = m ? `у ${m[1]} из ${m[2]} закрытых задач ` : "";
  return `Срок закрытия задач приблизительный: ${counts}дата закрытия не передается, использована дата последнего изменения.`;
}

/** Первая буква заглавная — для меток (Label): у платформы они в регистре предложения. */
export function sentence(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Кто запустил скан — словом, а не кодом очереди (значения scans.trigger: periodic|user|probe). */
export function scanTriggerText(trigger: string): string {
  switch (trigger) {
    case "periodic":
      return "по расписанию";
    case "user":
      return "вручную";
    case "probe":
      return "проба";
    default:
      return trigger;
  }
}

/** Исход автопроверки прав при добавлении в избранное (ответ PUT, К8.5.14). */
export interface FavoriteAddCheck {
  status: "checked" | "failed" | "token_rejected" | "deferred" | "no_pat";
  enqueue: { status: string; code: string | null } | null;
}

/**
 * В4.8.5 (К8.5.14 (д), (е)): что случилось после добавления в избранное —
 * права проверены сами, первый анализ своего поставлен сам. Ни одной фразы
 * «запустите анализ» про чужой репозиторий (К8.5.14 (ж)).
 */
export function favoriteAddedText(check: FavoriteAddCheck | undefined, visibility?: "public" | "internal" | "private" | "unknown"): string {
  if (!check) return "Добавлено в избранное.";
  switch (check.status) {
    case "no_pat":
      return "Добавьте токен в Настройках – сервис сам проверит права и откроет данные своих репозиториев.";
    case "deferred":
      return "Права проверим в фоне – итог появится в строке списка.";
    case "failed":
      return "Проверить права не удалось: SourceCraft сейчас не отвечает – проверим позже.";
    case "token_rejected":
      return "SourceCraft отклонил ваш токен – обновите его в Настройках.";
    default:
      break;
  }
  const e = check.enqueue;
  if (!e) return "Права проверены.";
  if (e.status === "queued") return "Права проверены – запущен анализ, итог придет уведомлением.";
  if (e.status === "deduplicated") return "Права проверены – анализ уже идет.";
  if (e.status === "skipped") {
    // В5.3 (25.09, находка владельца на internal-репо хакатона): ночной обход
    // берет только публичные репо рейтинга — закрытому чужому он не поможет,
    // и обещать его нельзя (правило 23.09: утверждение о данных — по статусу)
    if (e.code === "not_own") {
      // ревью В5.3 (25.09): видимость неизвестна — не утверждаем, что репозиторий закрытый
      if (visibility === "public") return "Права проверены. Анализ запускается только для своих репозиториев – этот обновит ночной обход.";
      if (visibility === "internal" || visibility === "private")
        return "Права проверены. У вашего токена нет прав на CI/CD и Безопасность этого репозитория, а в рейтинг закрытые репозитории не входят – оценки у него не будет.";
      return "Права проверены. Анализ запускается только для своих репозиториев.";
    }
    if (e.code === "cooldown") return "Права проверены – анализ запускали недавно.";
    return "Права проверены.";
  }
  switch (e.code) {
    case "too_many_active":
      return "Права проверены. Анализ не запущен: слишком много ваших анализов в очереди – дождитесь завершения.";
    case "rate_limited":
      return "Права проверены. Анализ не запущен: исчерпан часовой лимит запусков – попробуйте позже.";
    default:
      return "Права проверены. Анализ не запущен – попробуйте позже.";
  }
}

/**
 * В4.8.5 (К8.5.11, С7-2): текст тоста о сбое выгрузки отчёта — по коду.
 * Совет «скачайте другой формат» — только когда другой формат действительно
 * поможет (сбой сборки PDF); при 429/404/сети он упадёт так же.
 */
export function reportFailureText(kind: "md" | "pdf", status: number, code: string | null): string {
  if (status === 0) return "Нет связи с сервером – проверьте подключение и повторите.";
  if (status === 429) return "Слишком много запросов за минуту – повторите чуть позже.";
  if (status === 404) return "Репозиторий не найден или недоступен. Если вы входили, проверьте, не истекла ли сессия.";
  if (code === "check_failed" || status === 503) return "SourceCraft сейчас не отвечает – не удалось проверить доступ, попробуйте позже.";
  if (code === "pat_rejected") return "SourceCraft отклонил ваш токен – обновите его в Настройках.";
  if (kind === "pdf") return "Не удалось собрать PDF. Markdown-выгрузка – в этом же меню.";
  return "Не удалось собрать отчет – попробуйте позже.";
}

/** Ошибка запроса для словаря текстов (К8.5.4): HTTP-статус (0 — сети нет), код и сообщение сервера. */
export interface ErrorInput {
  status: number;
  code: string | null;
  message: string | null;
  /** заголовок Retry-After ответа (секунды), если был */
  retryAfter?: string | null;
}

/**
 * В4.8.5 (К8.5.4): клиентский словарь «код ошибки / HTTP-статус / сетевой
 * сбой → русский текст». Сервер отдаёт `message` уже языком продукта (без
 * длинного тире, «ё», кодов, «HTTP N», «PAT», имён переменных и регулярок) —
 * он и показывается, если в словаре кода нет своей формулировки. Коды с
 * одной формулировкой на любой экран — здесь; без ответа сервера (сеть,
 * прокси 502 при деплое, не-JSON) — текст по статусу.
 */
export const ERROR_TEXTS: Record<string, string> = {
  unauthorized: "Сессия закончилась – войдите через Я ID",
  forbidden: "Запрос отклонен",
  internal: "Внутренняя ошибка сервера – попробуйте позже",
  unconfigured: "Эта функция на сервере не настроена – обратитесь к администратору",
  sourcecraft_unavailable: "SourceCraft сейчас не отвечает – попробуйте позже",
  bad_body: "Сервер вернул неожиданный ответ – попробуйте позже",
  pdf_failed: "Не удалось собрать PDF",
};

/** Текст по статусу, когда ответа сервера с кодом нет. */
function statusText(status: number): string {
  if (status === 0) return "Нет связи с сервером – проверьте подключение и повторите";
  if (status === 401) return ERROR_TEXTS.unauthorized!;
  if (status === 403) return ERROR_TEXTS.forbidden!;
  if (status === 404) return "Не найдено";
  if (status === 429) return "Слишком много запросов – повторите чуть позже";
  if (status === 502 || status === 503 || status === 504) return "Сервис временно недоступен – повторите через минуту";
  if (status >= 500) return ERROR_TEXTS.internal!;
  return "Запрос не выполнен – повторите";
}

/** «через 45 с» / «через 3 мин» — из Retry-After (секунды). */
function retryHint(raw: string | null | undefined): string {
  const sec = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return sec < 90 ? ` Повторить можно через ${Math.ceil(sec)} с.` : ` Повторить можно через ${Math.ceil(sec / 60)} мин.`;
}

/** Первая буква заглавная — серверные сообщения строчные, в тостах и плашках они начинают фразу. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Текст ошибки запроса для человека (К8.5.4). */
export function errorText(e: ErrorInput): string {
  const fixed = e.code !== null ? ERROR_TEXTS[e.code] : undefined;
  const base = fixed ?? (e.message ? capitalize(e.message) : statusText(e.status));
  return e.status === 429 ? `${base}${retryHint(e.retryAfter)}` : base;
}

/**
 * В4.4 (кластер E код-аудита): исход анализа для опросщиков (MePage/RepoPage).
 * Finished-скан со статусом bad — ОШИБКА (раньше любой доехавший скан
 * праздновался success-тостом «Анализ завершен»), ok/partial — успех,
 * running/нет скана — ещё не закончился. Тост рисует UI — здесь только исход.
 */
export function analysisOutcome(
  scan: { status: string; finishedAt: string | null; detail?: string | null } | null | undefined,
): "pending" | "ok" | "failed" | "interrupted" {
  if (!scan || scan.finishedAt === null || scan.status === "running" || scan.status === "queued") return "pending";
  // В4.8.5 (К8.5.2a): скан, прерванный перезапуском сервера или закрытый как
  // сирота, — не провал анализа: задание вернулось в очередь и повторится.
  // Сигнатура прежняя — `detail` необязателен (audit-v44-repro.test.ts:318-324)
  if (scan.status === "bad" && (scan.detail === "shutdown" || scan.detail === "orphaned")) return "interrupted";
  return scan.status === "bad" ? "failed" : "ok";
}

/** Прирост Score — одним знаком после точки, как в тексте эффекта рекомендации. */
export function fmtDelta(delta: number): string {
  // В4.9 (К9.11): десятичная запятая — «+1,2»
  return `+${fmtDecimal(delta, 1)}`;
}

/**
 * Знаковая дельта (В4.3, К-Ф3.4): минус законен — плохие CI/Security
 * опускают Repo Health Score ниже HealthCraft Index (инверсия), знак
 * берётся из фактической разности. Одна копия для страницы и MD.
 */
export function fmtSigned(delta: number): string {
  // В4.9 (К9.11): русские числа — «+1,2», «−12,1» (минус U+2212, не дефис)
  const v = Math.round(delta * 10) / 10;
  return `${v < 0 ? MINUS : "+"}${fmtDecimal(Math.abs(v), 1)}`;
}

/**
 * Единая копия про Security без данных (STOP §4 плана): категория
 * исключена с перенормировкой, а не занижена — доступ к AppSec даётся
 * правом, а не публичностью репозитория. Одна строка на странице и в MD.
 */
export const SECURITY_PUBLIC_NOTE =
  "Безопасность считается по данным AppSec SourceCraft, а они видны только с правом доступа. " +
  "Данных нет – категория в оценке не участвует и ее не снижает.";

/**
 * Заглушки закрытых зрителю каналов (К2 В4.1) по причине доступа. Ключи —
 * ChannelAccess без "granted". Строка — одна для страницы и MD-отчёта.
 */
// ---------- В4.9, часть 2 гейта: путь к полной оценке (А2, Е2) ----------

/** Кусок строки пути: `settings` — слово «Настройках», на карточке ссылка на `/settings`, в отчете — текст. */
export interface PathPart {
  text: string;
  settings?: boolean;
}

const SETTINGS_WORD = "Настройках";

/** Вошедшему без токена (Г2.2): без «войдите» — он уже вошел. */
// круг 2 (Е5): без хвоста «– откроются CI/CD и Безопасность» — это уже сказано рядом
const PATH_NO_PAT: PathPart[] = [{ text: "Добавьте персональный токен доступа в " }, { text: SETTINGS_WORD, settings: true }, { text: "." }];

/** Не вошедшему (аноним, истекшая сессия). */
const PATH_SIGN_IN: PathPart[] = [{ text: "Войдите через Я ID и добавьте персональный токен доступа в " }, { text: SETTINGS_WORD, settings: true }, { text: "." }];

export const pathText = (parts: PathPart[]): string => parts.map((p) => p.text).join("");

/**
 * Строка пути к полной оценке (Repo Health Score) — ОДНА копия для карточки,
 * MD и PDF по типу зрителя (§2 23.09, ответ 1 на аудит-пару): не вошел —
 * войти и добавить токен; вошел без токена — добавить токен; токен есть, прав
 * нет — причина без призыва (короткая форма, первый закрытый канал: CI, затем
 * Безопасность).
 */
export function fullScorePath(auth: string | undefined, accesses: (string | undefined)[]): PathPart[] {
  if (auth === undefined || auth === "no-session") return PATH_SIGN_IN;
  // канал закрыт «нет токена» — зрителю нужен токен, как бы ни пришел признак входа
  const closed = accesses.find((a) => a !== undefined && a !== "granted");
  if (auth === "no-pat" || closed === "no-pat") return PATH_NO_PAT;
  return [{ text: lockReasonShort(accesses, auth) ?? ACCESS_LOCK_SHORT["check-failed"] }];
}

export const ACCESS_LOCK_TEXT: Record<"no-pat" | "denied" | "pat-expired" | "check-failed", string> = {
  // А2: призыв — той же строкой пути, что у полной оценки (без «войдите» вошедшему)
  "no-pat": `Данные видны участникам репозитория. ${pathText(PATH_NO_PAT)}`,
  denied: "У вашего токена нет прав на эти данные репозитория.",
  "pat-expired": "SourceCraft отклонил ваш токен доступа – обновите его в Настройках.",
  "check-failed": "Не удалось проверить доступ к этим данным – попробуйте открыть карточку позже.",
};

/**
 * КОРОТКАЯ форма тех же причин — для слота показателя на карточке, где рядом
 * уже стоят заголовок «Виден участникам репозитория» и ссылка на Настройки.
 * Полные формулировки выше самодостаточны: они несут и условие доступа, и
 * призыв, потому что в MD-отчёте стоят в одиночку. Под заголовком
 * со ссылкой тот же текст повторил бы оба соседних элемента, поэтому здесь
 * остаётся ТОЛЬКО причина, без призыва: действие называет ссылка.
 * Ключи и порядок те же — один источник, две длины.
 */
export const ACCESS_LOCK_SHORT: Record<"no-pat" | "denied" | "pat-expired" | "check-failed", string> = {
  "no-pat": "Персональный токен доступа SourceCraft не добавлен.",
  denied: "У вашего токена нет прав на эти данные репозитория.",
  "pat-expired": "SourceCraft отклонил ваш токен доступа.",
  "check-failed": "Не удалось проверить доступ к этим данным.",
};

/** Короткая причина по коду доступа; granted → null (причины нет). */
export function accessLockShort(access: string | undefined): string | null {
  if (access === undefined || access === "granted") return null;
  return ACCESS_LOCK_SHORT[access as keyof typeof ACCESS_LOCK_SHORT] ?? ACCESS_LOCK_SHORT["check-failed"];
}

/**
 * В4.8.5 (К8.5.8), круг 2 (П3): причина закрытия зрителю без сессии (аноним,
 * истекшая сессия) — вход, а не «токен не добавлен»: до входа токен добавить
 * негде. Короткая форма, как `ACCESS_LOCK_SHORT`.
 */
export const SIGN_IN_LOCK_SHORT = "Нужно войти через Я ID и добавить персональный токен доступа SourceCraft.";

/**
 * Круг 2 (П3): ОДНО правило короткой причины замка для полного Score и строки
 * закрытых категорий на карточке. Первый закрытый канал из списка (порядок —
 * у вызывающего: CI, затем Security); нет сессии — вход для любого закрытого
 * канала; все открыты — null.
 */
export function lockReasonShort(accesses: (string | undefined)[], auth: string | undefined): string | null {
  const closed = accesses.find((a) => a !== undefined && a !== "granted");
  if (closed === undefined) return null;
  if (auth === "no-session") return SIGN_IN_LOCK_SHORT;
  return accessLockShort(closed);
}

/**
 * Круг 2 (П2, К8.5.14 (ж)): подсказка строки «последний анализ завершился
 * ошибкой». Призыв запустить — только тому, у кого есть кнопка анализа
 * (свой репозиторий, есть токен); прочим — нейтрально, без призыва.
 */
export function failedAnalysisHint(canAnalyze: boolean): string {
  return canAnalyze ? "Анализ завершился ошибкой – запустите его еще раз" : "Последний анализ завершился ошибкой";
}

/** Размер человекочитаемо: ГБ с двумя знаками или МБ. */
export function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${fmtDecimal(gb, 2, { trim: true })} ГБ`;
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

/** Длительность человекочитаемо: часы или минуты. */
export function fmtMinutes(ms: number): string {
  const min = ms / 60_000;
  return min >= 60 ? `${fmtDecimal(min / 60, 1, { trim: true })} ч` : `${Math.round(min)} мин`;
}

/** Лимиты клона оператора на момент показа (К5): только код ← env, без пользовательских настроек. */
export interface GitLimitsMarker {
  cloneMaxBytes: number;
  cloneTimeoutMs: number;
  degradeEnabled: boolean;
  degradeSinceMonths: number;
  degradeMaxBytes: number;
  degradeTimeoutMs: number;
}

/** Причина пробоя лимитов клона человеческими словами (одна строка — страница и MD). */
export function gitLimitsText(l: GitLimitsMarker): string {
  const full = `полный клон больше ${fmtBytes(l.cloneMaxBytes)} или дольше ${fmtMinutes(l.cloneTimeoutMs)}`;
  const degrade = l.degradeEnabled
    ? `, ${l.degradeSinceMonths} месяцев истории – больше ${fmtBytes(l.degradeMaxBytes)} или дольше ${fmtMinutes(l.degradeTimeoutMs)}`
    : "";
  return (
    `Репозиторий больше лимита сервиса: ${full}${degrade}. ` +
    // Ступень 4 (Ф9): не называть категории — активность может быть оценена по данным SourceCraft
    "Показатели, которые считаются по коду и истории репозитория, не собраны – они в оценке не участвуют и ее не снижают. Лимиты задает оператор сервиса."
  );
}

/** Текст заглушки по доступу; granted → null (заглушки нет). */
export function accessLockText(access: string | undefined): string | null {
  if (access === undefined || access === "granted") return null;
  return ACCESS_LOCK_TEXT[access as keyof typeof ACCESS_LOCK_TEXT] ?? ACCESS_LOCK_TEXT["check-failed"];
}

/**
 * Причина неудачного входа человеческим словом (Ф2.9, LOW-9): callback
 * кладёт `auth_error` в query /me — коды `state`/`no_code` известны,
 * остальное — текст провайдера. Живёт здесь, среди текстов: MePage —
 * компонент, его нельзя импортировать в bun test (CJS-CSS зависимости).
 */
// Сообщения сервера о сбое входа — одна копия с `src/auth/ya.ts` (ревью кода R9)
export { AUTH_SERVER_MESSAGES } from "../auth/messages";
import { AUTH_SERVER_MESSAGES } from "../auth/messages";

export function authErrorText(raw: string): string {
  // В4.8.5 (К8.5.4, С1-6): коды провайдера и наши — словами, без «(state)» и «access_denied»
  if (raw === "state") return "Проверочный код входа не сошелся – начните вход заново. Так работает защита от подмены.";
  if (raw === "no_code") return "Я ID не передал код подтверждения – попробуйте войти еще раз.";
  if (raw === "access_denied") return "Вход отменен на странице Я ID – чтобы войти, подтвердите доступ.";
  // прочие коды провайдера OAuth (латиница с подчёркиванием) — общей фразой, код наружу не идёт
  if (/^[a-z_]+$/.test(raw)) return "Я ID не подтвердил вход – попробуйте войти еще раз.";
  // Ступень 4 (Ф17): текст из адреса НЕ печатается — только известные сообщения
  // сервера (src/auth/ya.ts), остальное — общей фразой
  if (AUTH_SERVER_MESSAGES.includes(raw)) return `Вход не удался: ${raw}`;
  return "Вход не удался – попробуйте войти еще раз.";
}

/**
 * Аватар репозитория без логотипа (В4.7 круг 2, Р2.5): тон и буквы — одно
 * правило для карточки (`RepoAvatar`) и PDF-отчёта. Тон — стабильный хэш
 * имени; буквы — алгоритм Gravity `getAvatarDisplayText` (uikit 7.49.0):
 * первые буквы двух первых слов, иначе первые два символа.
 */
export const AVATAR_TONES = ["info", "utility", "positive", "misc"] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

export function avatarTone(name: string): AvatarTone {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length]!;
}

export function avatarInitials(name: string): string {
  const words = name.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  if (words.length <= 1) return name.slice(0, 2).toUpperCase();
  return [words[0]![0], words[1]![0]].filter(Boolean).join("").toUpperCase();
}

/**
 * Официальное название модели AI-текста (К-7 В5.3, §2 24.09 «В5.3, круг 2»):
 * в заметке хранится имя из конфига (`MAIN_MODEL`/`SIDE_MODEL`), шлюз строит из
 * него URI `gpt://<каталог>/<имя>[/latest]` (`llm.ts`). По документации Yandex
 * AI Studio (24.09.2026) `yandexgpt/latest` и `yandexgpt/rc` — устаревшие
 * псевдонимы YandexGPT Pro 5 и YandexGPT Pro 5.1. Неизвестное имя — как есть.
 */
export function aiModelName(model: string): string {
  const id = model.replace(/^gpt:\/\/[^/]+\//, "");
  switch (id) {
    case "yandexgpt":
    case "yandexgpt/latest":
    case "yandexgpt-5-pro":
    case "yandexgpt-5-pro/latest":
      return "YandexGPT Pro 5";
    case "yandexgpt/rc":
    case "yandexgpt-5.1":
    case "yandexgpt-5.1/latest":
      return "YandexGPT Pro 5.1";
    case "yandexgpt-lite":
    case "yandexgpt-lite/latest":
    case "yandexgpt-5-lite":
    case "yandexgpt-5-lite/latest":
      return "YandexGPT Lite 5";
    default:
      return id;
  }
}

/** Названия ролей AI-заметок — одна копия для карточки и отчета. */
export const AI_ROLE_TITLES: Record<string, string> = {
  documentation: "Документация",
  code: "Код",
  activity: "Активность",
  issues: "Задачи",
  cicd: "CI/CD",
  security: "Безопасность",
  trajectory: "Динамика",
  overview: "Общий взгляд",
};

export function aiRoleTitle(role: string): string {
  return AI_ROLE_TITLES[role] ?? role;
}

// ---------- В5.3, круг 3: флаг фрода (К-3), заголовок AI-раздела ----------

/** Заголовок AI-раздела карточки и отчета (§2 24.09 «круг 3»): что внутри и что это текст модели. */
export const AI_SECTION_TITLE = "AI-обзор репозитория";
/** Ревью В5.3 (25.09): оговорка о модели и отказ проверки — одна копия для карточки и MD/PDF. */
export const AI_DISCLAIMER = "Модель пересказывает оценку и на расчет не влияет.";
export const AI_OVERVIEW_REJECTED = "Общий обзор не прошел проверку фактами – разбор по категориям ниже.";

export const FRAUD_TITLE = "Подозрение на искусственную активность";
export const FRAUD_EXPLAIN =
  "Автоматическая проверка нашла признаки накрутки. Это повод проверить вручную, а не вывод: оценка от него не меняется.";

/**
 * Название факта-фактора фрода вместо сырого ключа (К-5, §2 24.09): одна копия
 * для карточки, кабинета и отчета. Флаггер видит только факты «Активности» —
 * у каждого своя ветка; неизвестный ключ — явная ветка «прочее»: ключ как есть,
 * чтобы его можно было найти в приложении (правило AGENTS.md 22.09 об enum).
 */
export function fraudFactorTitle(key: string): string {
  switch (key) {
    case "activity.git.timeline":
      return "История коммитов";
    case "activity.git.summary":
      return "Сводка истории git";
    case "activity.rest":
      return "Участники, релизы и запросы на слияние";
    case "activity.rhythm":
      return "Ритм коммитов";
    default:
      return key;
  }
}

/**
 * В5.2 (Б1): значение, по которому печатается фактор фрода. Признаки ритма
 * (`activity.rhythm`) считает код при проверке и хранит в ее заметке — фактом
 * карточки они не являются; прочие ключи — факты карточки.
 */
export function fraudFactorValue(
  key: string,
  signals: Record<string, unknown> | null | undefined,
  evidence: readonly { key: string; value: unknown }[],
  inputs?: Record<string, unknown>,
): unknown {
  if (key === "activity.rhythm") return signals ?? undefined;
  // аудит надежности М3: вход проверки из ее заметки — те данные, что видела модель
  if (inputs !== undefined && key in inputs) return inputs[key];
  return evidence.find((e) => e.key === key)?.value;
}

/** Проверка на накрутку сделана по прошлому анализу — после нее был новый (аудит надежности М2). */
export function fraudCheckStale(check: { scanId: number | null; latestScanId: number | null } | undefined): boolean {
  return check !== undefined && check.scanId !== null && check.latestScanId !== null && check.scanId < check.latestScanId;
}

/**
 * Тур 3 В5.5 (круг 2, 26.09, Екатерина): AI-текст сделан по НЕпоследнему
 * анализу — после него был новый, цифры в тексте могут не совпасть с карточкой.
 * Условие то же, что у пункта «Обновить обзор» для не-владельца (аудит О1).
 * Одно условие для карточки (метка «Устарел») и отчета (плашка, 27.09).
 */
export function aiNotesStale(ai: { scanId: number; check: { latestScanId: number | null } } | null | undefined): boolean {
  return ai != null && ai.check.latestScanId !== null && ai.scanId < ai.check.latestScanId;
}

/** Плашка устаревшего AI-обзора в отчете MD/PDF (27.09, Екатерина — по оценке Алексея 27.09, дефект 2). */
export const AI_STALE_REPORT_TEXT = "сделан по прошлому анализу – после него был новый, цифры в тексте могут не совпадать с остальным отчетом. Обновить обзор можно на карточке репозитория.";

/** Доля 0..1 → «99%» (целые проценты, без пробела — как в таблице подметрик; ненулевая меньше 1% — «<1%»). */
function sharePercent(share: number): string {
  const pct = Math.round(share * 100);
  return pct === 0 && share > 0 ? "<1%" : `${pct}%`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * Текст фактора фрода — КОДОМ из факта (выбор владельца 24.09, способ (2);
 * закон 5: число — из факта, не из формулировки модели). Возвращает null, если
 * факта нет или ключ неизвестен — тогда показывается формулировка модели.
 */
export function fraudFactorFact(key: string, value: unknown, date: (iso: string) => string = fmtDate): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const num = (k: string): number | null => (typeof v[k] === "number" && Number.isFinite(v[k]) ? (v[k] as number) : null);
  switch (key) {
    case "activity.git.summary": {
      const commits = num("commits");
      const robots = num("robot_commits");
      const authors = num("authors");
      const committers = num("committers");
      const parts: string[] = [];
      if (commits !== null && commits > 0 && robots !== null) {
        parts.push(`${robots} из ${commits} ${plural(commits, "коммита", "коммитов", "коммитов")} – от роботов (${sharePercent(robots / commits)})`);
      }
      if (authors !== null && committers !== null) {
        parts.push(`${authors} ${plural(authors, "автор", "автора", "авторов")} при ${committers} ${plural(committers, "коммиттере", "коммиттерах", "коммиттерах")}`);
      }
      return parts.length > 0 ? parts.join("; ") : null;
    }
    case "activity.git.timeline": {
      const events = num("events");
      if (events === null) return null;
      const first = typeof v.first === "string" ? date(v.first) : null;
      const last = typeof v.last === "string" ? date(v.last) : null;
      const span = first && last ? ` с ${first} по ${last}` : "";
      return `${events} ${plural(events, "коммит", "коммита", "коммитов")}${span}`;
    }
    case "activity.rest": {
      const contributors = num("contributors");
      const releases = num("releases");
      const pulls = Array.isArray(v.pulls_created_at) ? v.pulls_created_at.length : null;
      const parts: string[] = [];
      if (contributors !== null) parts.push(`${contributors} ${plural(contributors, "участник", "участника", "участников")}`);
      if (releases !== null) parts.push(`${releases} ${plural(releases, "релиз", "релиза", "релизов")}`);
      if (pulls !== null) parts.push(`${pulls} ${plural(pulls, "запрос", "запроса", "запросов")} на слияние`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
    case "activity.rhythm": {
      // В5.2 (Б1): признаки ритма (rhythm.ts) — только ненулевые, без оценки их силы
      const commits = num("commits");
      const robots = num("robot_commits");
      const bursts = num("sync_bursts");
      const sync = num("sync_commits");
      const regular = num("regular_share");
      const interval = num("interval_median_minutes");
      const viaOne = num("authors_via_one_committer");
      const recent = num("recent_week_commits");
      const baseline = num("baseline_week_median");
      const parts: string[] = [];
      if (commits !== null && commits > 0 && robots !== null && robots > 0) {
        parts.push(`${robots} из ${commits} ${plural(commits, "коммита", "коммитов", "коммитов")} – от роботов (${sharePercent(robots / commits)})`);
      }
      if (bursts !== null && bursts > 0) {
        const tail = sync !== null && sync > 0 ? ` (${sync} ${plural(sync, "коммит", "коммита", "коммитов")})` : "";
        parts.push(`${bursts} ${plural(bursts, "всплеск", "всплеска", "всплесков")} синхронизации${tail}`);
      }
      if (regular !== null && regular > 0) {
        const every = interval !== null && interval > 0 ? `, обычно раз в ${fmtMinutes(interval * 60_000)}` : "";
        parts.push(`${sharePercent(regular)} коммитов людей идут с ровными интервалами${every}`);
      }
      if (viaOne !== null && viaOne >= 2) parts.push(`${viaOne} ${plural(viaOne, "автор", "автора", "авторов")} при одном коммиттере`);
      if (recent !== null && baseline !== null && recent > baseline) {
        parts.push(
          `${recent} ${plural(recent, "коммит", "коммита", "коммитов")} за последнюю неделю при обычных ${fmtDecimal(baseline, 1, { trim: true })} в неделю`,
        );
      }
      return parts.length > 0 ? parts.join("; ") : null;
    }
    default:
      return null;
  }
}

/** Абзацы AI-текста (О3): одна функция для карточки и отчета — по переводам строк. */
export function aiParagraphs(text: string): string[] {
  // аудит дизайна В5.2 (О7): правило языка и при выводе — для текстов, записанных до него
  return normalizeTypography(text).split(/\n+/).map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * Ревью В5.3 (25.09): почему чужой репозиторий из избранного не анализировался — по
 * результату проверки прав, а не одной фразой «нет доступа к коду» на все случаи
 * (права не проверены; публичный — появится после обхода; закрытый — кода токен не видит).
 */
export function notOwnReason(access: { visibility: string; own: boolean } | null | undefined): string {
  const lead = "Репозиторий в вашем избранном, но сервис его не анализировал: анализ запускается только для своих репозиториев";
  if (!access) return `${lead}. Права вашего токена к нему еще не проверены – проверка идет в «Избранном».`;
  if (access.visibility === "public") return `${lead}. Публичный репозиторий появится в рейтинге после ночного обхода каталога.`;
  // закрытый или внутренний с доступом к коду — «свой» (решение 25.09); не свой — значит кода токен не видит
  return `${lead} – у вашего токена нет доступа к коду этого репозитория.`;
}

// ---------- В5.2 (Б6): лимиты AI у кнопок и в «Настройках» ----------

export interface QuotaWindowView {
  used: number;
  limit: number;
}

/** Ячейка таблицы «Лимиты AI»: остаток «N/M», как в тексте кнопок (UX-проход В5.2 25.09, замечание 4). */
export function quotaCell(w: QuotaWindowView): string {
  return `${Math.max(0, w.limit - w.used)}/${w.limit}`;
}

/** Ответ `/api/me/ai-quota` по одному действию (jobs/ai-quota.ts, ActionQuota). */
export interface ActionQuotaView {
  unlocked: boolean;
  hour: QuotaWindowView | null;
  day: QuotaWindowView | null;
  global: QuotaWindowView | null;
  hourResetAt: string | null;
  dayResetAt: string;
}

export interface AiQuotaView {
  unlockAvailable: boolean;
  unlocked: boolean;
  overview: ActionQuotaView;
  check: ActionQuotaView;
}

export type AiAction = "overview" | "check";

export interface QuotaCounter {
  left: number;
  limit: number;
  window: "hour" | "day" | "global";
}

/**
 * Остаток для текста кнопки (выбор Екатерины 25.09: «Сформировать обзор 2/3»): остаток /
 * лимит самого тесного окна — часа, суток или общего. С паролем числа нет (null).
 */
export function quotaCounter(q: ActionQuotaView | null | undefined): QuotaCounter | null {
  if (!q || q.unlocked) return null;
  let best: QuotaCounter | null = null;
  for (const window of ["hour", "day", "global"] as const) {
    const w = q[window];
    if (w === null) continue;
    const left = Math.max(0, w.limit - w.used);
    if (best === null || left < best.left) best = { left, limit: w.limit, window };
  }
  return best;
}

/** Текст кнопки со счетчиком: «Сформировать обзор 2/3»; без счетчика — как есть. */
export function withCounter(label: string, counter: QuotaCounter | null): string {
  return counter === null ? label : `${label} ${counter.left}/${counter.limit}`;
}

/** Видимая причина, почему кнопка неактивна (аудит дизайна О2): окно, которое держит, и время. */
export function quotaBlockedText(action: AiAction, q: ActionQuotaView, counter: QuotaCounter): string {
  const one = action === "overview" ? "Следующий обзор" : "Следующая проверка";
  const many = action === "overview" ? "обзоров" : "проверок";
  if (counter.window === "hour") {
    return `${one} – после ${q.hourResetAt ? fmtDateTime(q.hourResetAt) : "окончания часа"} (не больше ${counter.limit} в час)`;
  }
  if (counter.window === "day") return `Лимит ${many} на сегодня исчерпан (${counter.limit} в сутки) – откроется в 00:00 МСК`;
  return `Общий лимит ${many} сервиса на сегодня исчерпан – откроется в 00:00 МСК`;
}
