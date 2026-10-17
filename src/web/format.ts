// Показ чисел, дат и пользовательских текстов для экранов и отчета MD/PDF.
// Правило tri-state живет здесь: отсутствие данных везде выглядит одинаково
// нейтрально — «нет данных» или «–», никогда не 0 и никогда не красным.

import { normalizeTypography } from "../summary/typography";

export const NO_DATA = "нет данных";
// одно название итога без оценки на всех экранах и в отчете
export const NO_SCORE = "Оценки нет";

/**
 * Имя файла отчета. Слаг бывает длиной 243 символа — с таким именем Chrome
 * на Windows молча отменяет загрузку, поэтому имя обрезается до 120 символов
 * без хвостовых дефисов. Одна функция для кнопки карточки и
 * `content-disposition` сервера.
 */
export function reportFileName(org: string, repo: string, ext: "md" | "pdf"): string {
  const base = `${org}-${repo}`.slice(0, 120).replace(/[-_.]+$/, "");
  return `${base}-health.${ext}`;
}

/** Русские имена категорий — запасной вариант, когда /api/meta не загрузился (иначе видны сырые ключи). */
export const CATEGORY_TITLES_RU: Record<string, string> = {
  documentation: "Документация",
  cicd: "CI/CD",
  security: "Безопасность",
  activity: "Активность",
  issues: "Задачи",
  code: "Состояние кода",
};

/**
 * Показанное целое балла — одно правило для карточки, рейтинга, отчета, значка
 * и хранимого индекса. Сначала снимается двоичный шум (39,5 в расчете бывает
 * 39.49999999999999 и без этого округлилось бы в 39 — «в зоне риска» вместо
 * «требует внимания»), затем обычное округление.
 */
export function roundScore(value: number): number {
  return Math.round(Math.round(value * 1e9) / 1e9);
}

export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : String(roundScore(value));
}

/** Балл подметрики приходит долей 0..1 — на экране это проценты. */
export function fmtSubmetric(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value * 100)}`;
}

/** Число для показа: целое как есть, дробное — до 2 знаков, запятая и минус «−». */
export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  // целые — с разрядами, как место в рейтинге («4 069»)
  if (Number.isInteger(value)) return fmtCount(value);
  return fmtDecimal(value, 1, { trim: true });
}

/**
 * Русские сокращения месяцев — своей таблицей, а не `Intl`: вывод `toLocale*`
 * зависит от браузера и его ICU (запятые, «г.», ведущие нули), а формат дат
 * должен быть одинаковым везде.
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

/** Дата без времени — поле, у которого времени по смыслу нет: «15 сент. 2026». Пусто — «–», мусор — как пришел. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // день без ведущего нуля, полный год, без запятой и «г.»; пояс — локальный браузера
  return `${d.getDate()} ${MONTHS_SHORT_RU[d.getMonth()]} ${d.getFullYear()}`;
}

/** Дата и время: время `HH:mm` (24 часа) первым — «12:00 18 янв. 2023». Пусто — «–», мусор — как пришел. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}

/** Только время «16:52» (локальное) — подписи оси за короткий период. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * UTC-форматтеры для отчетов: MD/PDF не должен зависеть от пояса машины,
 * на которой он собран. Интерфейс показывает локальное время (fmtDate/fmtDateTime),
 * поэтому время отчета подписано «UTC» явно – иначе оно расходилось бы с
 * карточкой без объяснения. Дата без времени – без подписи.
 */
export function fmtDateUtc(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS_SHORT_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtDateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = parseShown(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDateUtc(iso)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/**
 * «N рекомендаций» с согласованием числа: 1 рекомендация, 2-4 рекомендации,
 * 5-20 рекомендаций, 21 рекомендация… Число — цифрой, как везде в интерфейсе.
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
 * Дробные числа в значении факта округляются до 2 знаков, целые — как есть:
 * «0.8723404255319149» на экране — шум, а не факт. Применяется только к списку
 * подметрик на карточке и в MD-отчете; поповер «Основание» остается сырым JSON —
 * это доказательная база, ей нужна воспроизводимость, а не читаемость.
 *
 * Рекурсия нужна потому, что значение подметрики не всегда число: часть фактов
 * приходит объектом (`{"bytes":8000}`), и длинная дробь может лежать внутри.
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
  if (value === null || value === undefined) return "–";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 1);
}

/** Статус скана — человеческим словом, без жаргона таблицы. */
export function scanStatusText(status: string): string {
  switch (status) {
    case "ok":
      return "полностью";
    case "partial":
      return "частично";
    case "bad":
      return "со сбоем";
    case "queued":
      return "в очереди";
    case "running":
      return "идет";
    default:
      return status;
  }
}

/**
 * Уровень Score для цвета (показ, не методика): ≥70 — хорошо, 40–69 — требует
 * внимания, <40 — плохо. Нет данных — нейтрально: отсутствие данных никогда
 * не красное.
 */
export function scoreTheme(value: number | null | undefined): "success" | "warning" | "danger" | "misc" {
  if (value === null || value === undefined) return "misc";
  // уровень — по тому же округленному числу, что видит зритель (69.6 показан как 70),
  // устойчивому к двоичному шуму (39.49999999999999 → 40)
  const shown = roundScore(value);
  if (shown >= 70) return "success";
  if (shown >= 40) return "warning";
  return "danger";
}

/**
 * Уровни `scoreTheme()` словами — чтобы число читалось по шкале. Одна копия
 * для рейтинга, карточки и MD-отчета.
 */
export const SCORE_WORDS: Record<"success" | "warning" | "danger", string> = {
  success: "здоров",
  warning: "требует внимания",
  danger: "в зоне риска",
};

/** Слово шкалы для показанного числа; нет данных — не слово шкалы, а «нет данных». */
export function scoreWord(value: number | null | undefined): string {
  const theme = scoreTheme(value);
  return theme === "misc" ? NO_DATA : SCORE_WORDS[theme];
}

/**
 * Цвет числа по тем же порогам. `-heavy`-варианты дают контраст 5,9–8,5:1
 * в темной и 5,8–6,3:1 в светлой теме — число читается как текст уровня AA.
 * Хороший диапазон тоже окрашен. Для `null` цвета нет: «нет данных» — другой
 * тип ячейки (`Label theme="unknown"`), а не бледное значение.
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
 * Тема чипа `Label` для показанного числа. `scoreTheme()` отдает `misc` —
 * тему полосы; у чипа нейтральное состояние называется `unknown`, и именно
 * им во всем продукте нарисовано «нет данных».
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
 * Слаг репозитория текстом (тултипы, заголовки ошибок, крошки, отчет) — один
 * способ на все экраны. Визуальная форма с пробелами вокруг слеша, как у
 * платформы, — компонент `RepoSlug` в ui.tsx.
 */
export function slugOf(org: string, repo: string): string {
  return `${org}/${repo}`;
}

/** Ширина имени в `DefinitionList` — одна на все панели; при 150 «Версия методики» влезает в одну строку. */
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
 * Строка итога — «сильнее всего…, слабее всего…, рекомендаций N, наибольший
 * прирост дает…». Одна формулировка для страницы и отчета: `markdown.ts`
 * вызывает эту функцию. Живет здесь, а не в `src/report`, потому что импорт
 * `src/report` в клиент тянет серверный слой и ломает `Bun.build`.
 *
 * Вход — плоские структуры, а не `RepoCard`: `src/api/repos` тянет
 * `bun:sqlite`, и даже типовой импорт оттуда сломал бы бандл. Экранирование
 * markdown — забота вызывающего (`mdEscape(problem)`).
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
    // страница показывает счетчик ссылкой рядом со строкой, поэтому
    // внутри строки его не повторяем — иначе «Рекомендаций: N» читается дважды
    parts.push(`${top.charAt(0).toUpperCase()}${top.slice(1)}.`);
  }
  return parts.join(" ");
}

/**
 * Вклад категории без данных не печатается нулем: «вклад 0%» читался бы как
 * «дала ноль», тогда как ее вес исключен и перенормирован.
 */
export const NOT_COUNTED = "не учитывается";

export function contributionText(score: number | null | undefined, contribution: number): string {
  return score === null || score === undefined ? NOT_COUNTED : `${contribution}%`;
}

/** Знак минус (U+2212) — у отрицательных чисел в тексте, не дефис. */
export const MINUS = "\u2212";

/**
 * Русское число — десятичная запятая и минус «−». `digits` — знаков после
 * запятой; `trim` убирает хвостовые нули («0,5», а не «0,50»; целое — без запятой).
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
/** Потолок Repo Health Score при открытых критичных находках AppSec (`CRITICAL_FINDINGS_TOTAL_CAP`). */
export const CRITICAL_CAP = 69;

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
  /** итог ограничен потолком (утекшие секреты 49, критичные находки 69): вклады дали бы больше показателя */
  | { kind: "capped"; total: number; uncapped: number; segments: ContributionSegment[] }
  /** в репозитории нет кода: показатель 0 по правилу методики, вкладов нет; reason — причина «Состояния кода» */
  | { kind: "empty"; total: number; reason?: string | null };

/**
 * «Вклад категорий в оценку» для карточки и отчета. Вклад = балл × вес / Σ весов
 * категорий с данными (та же формула, что `totalsFromCategories`; веса —
 * аргументом: карточка берет их из `/api/meta`, отчет — из `INDEX_WEIGHTS`).
 * Показ — до десятых методом наибольшего остатка, чтобы сумма показанных
 * вкладов равнялась показанному целому показателю, а «не набрано» —
 * 100 − показатель. Округление каждого вклада отдельно этого не гарантирует
 * (20,9 + 18,3 + 11,8 + 18,8 = 69,8 при показателе 70). Потолок 49 и пустой
 * репозиторий — отдельные виды: у них вклады не складываются в показатель.
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
  if (Math.round(uncapped) > shown && shown <= CRITICAL_CAP) {
    // сумма вкладов больше показателя только у потолков полного итога
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

/** Заголовок полосы вкладов — один на карточке и в отчете. */
export const CONTRIBUTIONS_TITLE = "Вклад категорий в оценку";

/** Подпись остатка полосы: «не набрано 30». */
export const CONTRIBUTIONS_REST = "не набрано";

/** Причина потолка по его значению: 49 и ниже – утекшие секреты, иначе – открытые критичные находки. */
export function cappedReason(total: number): string {
  return total <= SECRETS_CAP ? "AppSec нашел утекшие секреты" : "в AppSec открыты критичные находки";
}

/** Строка вместо полосы, когда вклады не складываются в показатель (потолки 49 и 69, нет кода). */
export function contributionsNote(c: Contributions): string | null {
  if (c.kind === "empty") {
    // причина по виду: «нет ни одного файла» — только там, где файлов действительно нет
    // у категорий пустого репозитория — короткое «Нет коммитов», под показателем — полная фраза
    const why =
      c.reason === "no source code — repository empty"
        ? REPOSITORY_EMPTY_TEXT
        : c.reason && c.reason.startsWith("no source code — ")
          ? noDataReason("code", c.reason)
          : "В репозитории нет кода.";
    return `${why.replace(/ – оценивать нечего\.$/, ".")} Поэтому оценка – 0. Это не ошибка сервиса: оценивать нечего.`;
  }
  if (c.kind === "capped") return `Итог ограничен ${c.total} баллами: ${cappedReason(c.total)}. Без ограничения категории дали бы ${fmtDecimal(c.uncapped, 1)}.`;
  return null;
}

/** Показанный вклад: «+21,0». */
export function fmtContribution(tenths: number): string {
  return `+${fmtDecimal(tenths / 10, 1)}`;
}

/** Потеря с учетом веса: «−12,1». */
export function fmtLoss(loss: number): string {
  return `${MINUS}${fmtDecimal(loss, 1)}`;
}

// ---------- состояния категорий одними словами везде ----------

/** Опорная фраза «категории нет в оценке» — у одной категории (сравнение). */
export const NOT_IN_SCORE = "Категория в оценке не участвует и ее не снижает.";

/** Та же фраза один раз над списком категорий (карточка) и под таблицей (MD, PDF): у строк — только причина. */
export const NOT_IN_SCORE_LIST = "Категории без данных в оценке не участвуют и ее не снижают.";

/** Закрытая категория у зрителя без сессии (аноним, истекшая сессия). */
export const LOCKED_FOR_ANON = "Видна участникам репозитория.";

/**
 * Фраза закрытой зрителю категории — по причине доступа. Анониму —
 * «Видна участникам репозитория.»; вошедшему — причина (`accessLockText`:
 * нет токена, нет прав, токен отклонен).
 */
export function lockedCategoryText(access: string | undefined, auth: string | undefined): string {
  if (auth === undefined || auth === "no-session") return LOCKED_FOR_ANON;
  return accessLockText(access) ?? ACCESS_LOCK_TEXT["check-failed"];
}

/**
 * Причина «нет данных» категории — предложением для читателя. Расчет пишет
 * причины по-английски (`compute.ts`), здесь — их показ. Неизвестная причина
 * наружу не идет: сырой английский не показывается, печатается «Данных нет.».
 */
export function noDataReason(key: string, reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  // каждая причина «мало данных» — своей веткой
  if (r.startsWith("too little data — no finding density")) return "Находки AppSec есть, но размер кода неизвестен и доля закрытых не посчитана – категорию не оцениваем.";
  // «кода нет» — по виду: пустой репо, нет файлов, только не-код, пустые файлы
  if (r.startsWith("no source code — ")) return CODE_EMPTY_TEXT[r.slice("no source code — ".length)] ?? CODE_EMPTY_TEXT["only non-code files"]!;
  if (r === "repository empty") return NO_COMMITS_TEXT;
  if (r.startsWith("too little data — lines miscounted by an older collector")) return "Строки кода посчитаны прежней версией сборщика с ошибкой – категория оценится после повторного анализа репозитория.";
  if (r.startsWith("too little data — lines of code not read")) return "Строки кода прочитать не удалось: файлы больше лимита сервиса, не текстовые или чтение прервалось – категорию не оцениваем.";
  // причины прежних версий модели — для оценок, посчитанных ими
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

/** Репозиторий пуст — коммитов нет: это данные, а не сбой скачивания. Строка под показателем. */
export const REPOSITORY_EMPTY_TEXT = "В репозитории нет ни одного коммита – оценивать нечего.";

/** То же у категории: репозиторий уже назван строкой под показателем, здесь — коротко. */
export const NO_COMMITS_TEXT = "Нет коммитов – оценивать нечего.";

/** Репозиторий не прочитан (лимит, ошибка) — это незнание, а не факт о репозитории. */
export const GIT_UNREAD_TEXT = "Репозиторий не удалось прочитать – произошла ошибка или он больше лимита сервиса.";

/** Виды «кода нет» (`codeEmptyKind` расчета) — каждый своей фразой. */
const CODE_EMPTY_TEXT: Record<string, string> = {
  "repository empty": NO_COMMITS_TEXT,
  "no files": "В репозитории нет ни одного файла – оценивать нечего.",
  "only non-code files": "В репозитории нет файлов кода – только документы, лицензии или картинки.",
  "no lines of code": "Файлы кода в репозитории пустые – строк кода нет.",
};

/** Потолок CI без результатов запусков — одна фраза для «почему», маркера и приложения. */
export const CI_RUNS_CAP_TEXT = "Результаты запусков CI сервису не видны – категорию не оцениваем: честное отсутствие данных вместо догадок.";

/** Предупреждение «CI настроен, запусков не видно» — внизу плашки Repo Health Score и строкой под показателями в отчете. */
export const CI_CAP_TITLE = "CI настроен, но запусков не видно";
export const CI_CAP_TEXT =
  "В репозитории есть настройки CI, но результаты сборок нам не видны: доступ к ним закрыт или сборки еще не запускались. Поэтому автоматизацию не оцениваем – без данных оценка не снижается.";

/** Метка категории, часть данных которой взята из прошлого анализа. */
export const STALE_CATEGORY_MARK = "Данные из прошлого анализа";

/** Место без числа: публичный без индекса — «индекс не выставлен», прочие — «не в публичном рейтинге». */
export const NO_RANK_NO_INDEX = "без места – индекс не выставлен";
export const NO_RANK_NOT_PUBLIC = "не в публичном рейтинге";

/**
 * Место в рейтинге словами — одно правило для паспорта карточки, сравнения
 * и отчета. Есть место — «#N из M»; нет — причина по
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
 * строка `noData` оценки («documentation: git channel no-data»).
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
 * `appsec.findings` (no-data: access / no-scan / incomplete).
 */
export function securityNoDataReason(fact: { status: string; value: unknown } | undefined): string {
  const reason = fact && fact.status === "no-data" ? (fact.value as { reason?: unknown } | null)?.reason : undefined;
  if (reason === "access") return "У токена, с которым шел анализ, нет права на данные AppSec (src.repositories.useAppSecScan).";
  if (reason === "no-scan") return "AppSec еще не проверял этот репозиторий или проверка не закончилась.";
  if (reason === "incomplete") return "AppSec ответил не полностью, поэтому данных о безопасности нет. Это не значит, что уязвимостей нет.";
  // сюда приходит только зритель, которому категория видна (закрытую забирает
  // `lockedCategoryText`), поэтому «видны с правом доступа» противоречило бы
  // рекомендации «проверка не подключена» — причина та же, что в рекомендации
  return SECURITY_NO_SCAN;
}

/** Пустой репозиторий (ни одного коммита): почему нет запуска анализа — карточка и строка списка. */
export const EMPTY_REPO_TEXT = "В репозитории нет ни одного коммита – анализ станет доступен, когда появится код.";

/** Причина прочерка Безопасности зрителю с доступом — та же, что в рекомендации. */
export const SECURITY_NO_SCAN = "Данных AppSec по репозиторию нет: проверка не подключена или не завершена.";

/**
 * Пустое состояние без оценки — один текст для карточки и отчета, по статусу
 * скана: сбой не называется «анализ прошел»; скан был — «данных не хватило»;
 * скана не было — «еще не анализировался».
 */
export function noScoreText(scan: { status: string } | null): { title: string; description: string } {
  if (scan && scan.status === "bad") {
    return {
      title: "Оценки пока нет",
      description: "Последний анализ завершился сбоем: источники данных не ответили. Это не плохая оценка – при следующем анализе данные соберутся заново.",
    };
  }
  if (scan) {
    return {
      title: "Оценки пока нет",
      description: "Анализ прошел, но данных для оценки не хватило. Это не плохая оценка: при следующем анализе данные соберутся заново.",
    };
  }
  return { title: "Репозиторий есть в каталоге, но еще не анализировался", description: "Оценка появится после первого анализа." };
}

/**
 * Оговорка сборщика задач «дата закрытия подменена датой изменения»
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

/** Исход автопроверки прав при добавлении в избранное (ответ PUT). */
export interface FavoriteAddCheck {
  status: "checked" | "failed" | "token_rejected" | "deferred" | "no_pat";
  enqueue: { status: string; code: string | null } | null;
}

/**
 * Что случилось после добавления в избранное: права проверяются сами, первый
 * анализ своего репозитория ставится сам. Чужой репозиторий анализ не обещает.
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
    // ночной обход берет только публичные репозитории рейтинга — закрытому
    // чужому он не поможет, и обещать его нельзя
    if (e.code === "not_own") {
      // видимость неизвестна — не утверждаем, что репозиторий закрытый
      if (visibility === "public") return "Права проверены – оценку этого публичного репозитория обновит плановый анализ.";
      if (visibility === "internal" || visibility === "private")
        return "Права проверены. У вашего токена нет прав на CI/CD и Безопасность этого репозитория, а в рейтинг закрытые репозитории не входят – оценки у него не будет.";
      return "Права проверены. Анализ по кнопке запускается для репозиториев ваших организаций.";
    }
    if (e.code === "member") return "Права проверены – анализ можно запустить кнопкой в строке или на карточке.";
    if (e.code === "cooldown") return "Права проверены – анализ запускали недавно.";
    return "Права проверены.";
  }
  switch (e.code) {
    case "repo_empty":
      return "Права проверены. В репозитории пока нет коммитов – анализировать нечего.";
    case "too_many_active":
      return "Права проверены. Анализ не запущен: слишком много ваших анализов в очереди – дождитесь завершения.";
    case "rate_limited":
      return "Права проверены. Анализ не запущен: исчерпан часовой лимит запусков – попробуйте позже.";
    default:
      return "Права проверены. Анализ не запущен – попробуйте позже.";
  }
}

/**
 * Текст тоста о сбое выгрузки отчета — по коду. Совет «скачайте другой формат» —
 * только при сбое сборки PDF: при 429/404/сети другой формат упадет так же.
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

/** Ошибка запроса для словаря текстов: HTTP-статус (0 — сети нет), код и сообщение сервера. */
export interface ErrorInput {
  status: number;
  code: string | null;
  message: string | null;
  /** заголовок Retry-After ответа (секунды), если был */
  retryAfter?: string | null;
  /** отказ repo_cooldown: когда был последний анализ и когда запуск снова доступен (ISO) */
  lastScanAt?: string | null;
  until?: string | null;
}

/**
 * Словарь «код ошибки → русский текст» для кодов с одной формулировкой на любой
 * экран. Иначе показывается `message` сервера — он уже написан языком продукта;
 * без ответа сервера (сеть, прокси 502 при деплое, не-JSON) — текст по статусу.
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

/**
 * Отказ «репозиторий недавно анализировали» — ограничение частоты запуска по
 * членству в организации: когда был анализ и после какого времени можно снова.
 * Время сегодняшнего дня — без даты.
 */
export function repoCooldownText(lastScanAt: string, until: string, now = new Date()): string {
  const ago = Math.max(0, now.getTime() - Date.parse(lastScanAt));
  const agoText = ago < 60_000 ? "только что" : ago < 3600_000 ? `${Math.floor(ago / 60_000)} мин назад` : `${Math.floor(ago / 3600_000)} ч назад`;
  const today = parseShown(until).toDateString() === now.toDateString();
  return `Репозиторий анализировали ${agoText} – следующий запуск после ${today ? fmtTime(until) : fmtDateTime(until)}`;
}

/** Текст ошибки запроса для человека. */
export function errorText(e: ErrorInput): string {
  // время — в поясе браузера, поэтому текст собирается здесь, а не на сервере
  if (e.code === "repo_cooldown" && e.lastScanAt && e.until) return repoCooldownText(e.lastScanAt, e.until);
  const fixed = e.code !== null ? ERROR_TEXTS[e.code] : undefined;
  const base = fixed ?? (e.message ? capitalize(e.message) : statusText(e.status));
  return e.status === 429 ? `${base}${retryHint(e.retryAfter)}` : base;
}

/**
 * Исход анализа для опросщиков (MePage/RepoPage): завершенный скан со статусом
 * bad — ошибка, а не «Анализ завершен»; ok/partial — успех; running или нет
 * скана — еще идет. Тост рисует UI, здесь только исход.
 */
export function analysisOutcome(
  scan: { status: string; finishedAt: string | null; detail?: string | null } | null | undefined,
): "pending" | "ok" | "failed" | "interrupted" {
  if (!scan || scan.finishedAt === null || scan.status === "running" || scan.status === "queued") return "pending";
  // скан, прерванный перезапуском сервера или закрытый как сирота, — не провал
  // анализа: задание вернулось в очередь и повторится
  if (scan.status === "bad" && (scan.detail === "shutdown" || scan.detail === "orphaned")) return "interrupted";
  return scan.status === "bad" ? "failed" : "ok";
}

/** Прирост Score — один знак после запятой, как в тексте эффекта рекомендации: «+1,2». */
export function fmtDelta(delta: number): string {
  return `+${fmtDecimal(delta, 1)}`;
}

/**
 * Знаковая дельта: «+1,2», «−12,1». Минус законен — плохие CI/Security
 * опускают Repo Health Score ниже HealthCraft Index.
 */
export function fmtSigned(delta: number): string {
  const v = Math.round(delta * 10) / 10;
  return `${v < 0 ? MINUS : "+"}${fmtDecimal(Math.abs(v), 1)}`;
}

/**
 * Безопасность без данных исключена с перенормировкой, а не занижена: доступ
 * к AppSec дается правом, а не публичностью репозитория.
 */
export const SECURITY_PUBLIC_NOTE =
  "Безопасность считается по данным AppSec SourceCraft, а они видны только с правом доступа. " +
  "Данных нет – категория в оценке не участвует и ее не снижает.";

// ---------- путь к полной оценке и заглушки закрытых каналов ----------

/** Кусок строки пути: `settings` — слово «Настройках», на карточке ссылка на `/settings`, в отчете — текст. */
export interface PathPart {
  text: string;
  settings?: boolean;
}

const SETTINGS_WORD = "Настройках";

/** Вошедшему без токена: без «войдите» — он уже вошел. */
const PATH_NO_PAT: PathPart[] = [{ text: "Добавьте персональный токен доступа в " }, { text: SETTINGS_WORD, settings: true }, { text: "." }];

/** Не вошедшему (аноним, истекшая сессия). */
const PATH_SIGN_IN: PathPart[] = [{ text: "Войдите через Я ID и добавьте персональный токен доступа в " }, { text: SETTINGS_WORD, settings: true }, { text: "." }];

export const pathText = (parts: PathPart[]): string => parts.map((p) => p.text).join("");

/**
 * Строка пути к полной оценке (Repo Health Score) по типу зрителя: не вошел —
 * войти и добавить токен; вошел без токена — добавить токен; токен есть, прав
 * нет — причина без призыва (короткая форма по первому закрытому каналу: CI,
 * затем Безопасность).
 */
export function fullScorePath(auth: string | undefined, accesses: (string | undefined)[]): PathPart[] {
  if (auth === undefined || auth === "no-session") return PATH_SIGN_IN;
  // канал закрыт «нет токена» — зрителю нужен токен, как бы ни пришел признак входа
  const closed = accesses.find((a) => a !== undefined && a !== "granted");
  if (auth === "no-pat" || closed === "no-pat") return PATH_NO_PAT;
  return [{ text: lockReasonShort(accesses, auth) ?? ACCESS_LOCK_SHORT["check-failed"] }];
}

/** Заглушки закрытых зрителю каналов по причине доступа (ключи — ChannelAccess без "granted"). */
export const ACCESS_LOCK_TEXT: Record<"no-pat" | "denied" | "pat-expired" | "check-failed", string> = {
  // призыв — той же строкой пути, что у полной оценки
  "no-pat": `Данные видны участникам репозитория. ${pathText(PATH_NO_PAT)}`,
  denied: "У вашего токена нет прав на эти данные репозитория.",
  "pat-expired": "SourceCraft отклонил ваш токен доступа – обновите его в Настройках.",
  "check-failed": "Не удалось проверить доступ к этим данным – попробуйте открыть карточку позже.",
};

/**
 * Короткая форма тех же причин — для слота показателя на карточке, где рядом
 * уже стоят заголовок и ссылка на Настройки. Полные формулировки несут и условие
 * доступа, и призыв, потому что в MD-отчете стоят в одиночку; здесь — только
 * причина, действие называет ссылка.
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
 * Причина закрытия зрителю без сессии (аноним, истекшая сессия) — вход, а не
 * «токен не добавлен»: до входа токен добавить негде.
 */
export const SIGN_IN_LOCK_SHORT = "Нужно войти через Я ID и добавить персональный токен доступа SourceCraft.";

/**
 * Одно правило короткой причины замка для полного Score и строки закрытых
 * категорий на карточке. Первый закрытый канал из списка (порядок —
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
 * Подсказка строки «последний анализ завершился ошибкой». Призыв запустить —
 * только тому, у кого есть кнопка анализа
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

/** Лимиты клона на момент показа: задаются оператором через env, не пользователем. */
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
    // категории не называются: активность может быть оценена по данным SourceCraft
    "Показатели, которые считаются по коду и истории репозитория, не собраны – они в оценке не участвуют и ее не снижают."
  );
}

/** Текст заглушки по доступу; granted → null (заглушки нет). */
export function accessLockText(access: string | undefined): string | null {
  if (access === undefined || access === "granted") return null;
  return ACCESS_LOCK_TEXT[access as keyof typeof ACCESS_LOCK_TEXT] ?? ACCESS_LOCK_TEXT["check-failed"];
}

// сообщения сервера о сбое входа — общие с `src/auth/ya.ts`
export { AUTH_SERVER_MESSAGES } from "../auth/messages";
import { AUTH_SERVER_MESSAGES } from "../auth/messages";

/**
 * Причина неудачного входа человеческим словом: callback кладет `auth_error`
 * в query /me. Живет здесь, а не в MePage: компонент нельзя импортировать
 * в bun test из-за CSS-зависимостей.
 */
export function authErrorText(raw: string): string {
  // коды провайдера и наши — словами, сам код наружу не показывается
  if (raw === "state") return "Проверочный код входа не сошелся – начните вход заново. Так работает защита от подмены.";
  if (raw === "no_code") return "Я ID не передал код подтверждения – попробуйте войти еще раз.";
  if (raw === "access_denied") return "Вход отменен на странице Я ID – чтобы войти, подтвердите доступ.";
  // прочие коды провайдера OAuth (латиница с подчеркиванием) — общей фразой
  if (/^[a-z_]+$/.test(raw)) return "Я ID не подтвердил вход – попробуйте войти еще раз.";
  // произвольный текст из адреса не печатается: только известные сообщения сервера
  if (AUTH_SERVER_MESSAGES.includes(raw)) return `Вход не удался: ${raw}`;
  return "Вход не удался – попробуйте войти еще раз.";
}

/**
 * Буквы аватара репозитория без логотипа — как `getAvatarDisplayText` из
 * Gravity uikit 7.49.0: первые буквы двух первых слов, иначе первые два символа.
 */
export function avatarInitials(name: string): string {
  const words = name.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  if (words.length <= 1) return name.slice(0, 2).toUpperCase();
  return [words[0]![0], words[1]![0]].filter(Boolean).join("").toUpperCase();
}

/**
 * Официальное название модели AI-текста. В заметке хранится имя из конфига
 * (`MAIN_MODEL`/`SIDE_MODEL`), шлюз строит из него URI
 * `gpt://<каталог>/<имя>[/latest]` (`llm.ts`). По документации Yandex AI Studio
 * `yandexgpt/latest` и `yandexgpt/rc` — устаревшие псевдонимы YandexGPT Pro 5
 * и YandexGPT Pro 5.1. Неизвестное имя — как есть.
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

// ---------- AI-раздел и флаг фрода ----------

/** Заголовок AI-раздела карточки и отчета: что внутри и что это текст модели. */
export const AI_SECTION_TITLE = "AI-обзор репозитория";
/** Оговорка о модели и отказ проверки — одна копия для карточки и MD/PDF. */
export const AI_DISCLAIMER = "Модель пересказывает оценку и на расчет не влияет.";

/** Оговорка о модели на карточке — одна строка под заголовком AI-обзора. */
export const AI_NOTE_SHORT = "Пересказ модели, на оценку не влияет.";
export const AI_OVERVIEW_REJECTED = "Общий обзор не прошел проверку фактами – разбор по категориям ниже.";

export const FRAUD_TITLE = "Признаки искусственной активности";

/**
 * Текст ошибки задания для показа: сервер хранит прежние формулировки («AI-описание»,
 * «Проверка оценки») — по ним считаются лимиты (`AI_REJECTED_ERRORS`), менять их в
 * базе нельзя. На экране — словарь интерфейса: «AI-обзор», «проверка активности».
 */
/** Окончания «AI-описани-» → «AI-обзор-» по падежам: описание → обзор, описания → обзора… */
const AI_REVIEW_ENDINGS: Record<string, string> = { е: "", я: "а", ю: "у", ем: "ом", и: "е", й: "ов", ям: "ам", ями: "ами", ях: "ах" };

export function jobErrorText(error: string): string {
  return error
    .replace(/^AI-описание не сформировано/, "AI-обзор не сформирован")
    .replace(/^Проверка оценки не сформирована/, "Проверка активности не сформирована")
    .replace(/AI-описани(ями|ях|ям|ем|е|я|ю|и|й)(?![а-яё])/g, (_m, end: string) => `AI-обзор${AI_REVIEW_ENDINGS[end] ?? ""}`);
}
export const FRAUD_EXPLAIN =
  "Автоматическая проверка нашла признаки искусственной активности. Это повод проверить вручную, а не вывод: оценка от него не меняется.";

/**
 * Название факта-фактора фрода вместо сырого ключа. Флаггер видит только факты
 * «Активности» — у каждого своя ветка; неизвестный ключ показывается как есть,
 * чтобы его можно было найти в приложении.
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
 * Значение, по которому печатается фактор фрода. Признаки ритма
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
  // вход проверки из ее заметки — ровно те данные, что видела модель
  if (inputs !== undefined && key in inputs) return inputs[key];
  return evidence.find((e) => e.key === key)?.value;
}

/** Проверка на накрутку сделана по прошлому анализу — после нее был новый. */
export function fraudCheckStale(check: { scanId: number | null; latestScanId: number | null } | undefined): boolean {
  return check !== undefined && check.scanId !== null && check.latestScanId !== null && check.scanId < check.latestScanId;
}

/**
 * AI-текст сделан не по последнему анализу — цифры в нем могут не совпасть
 * с карточкой. Одно условие для метки «Устарел» на карточке и плашки в отчете.
 */
export function aiNotesStale(ai: { scanId: number; check: { latestScanId: number | null } } | null | undefined): boolean {
  return ai != null && ai.check.latestScanId !== null && ai.scanId < ai.check.latestScanId;
}

/** Плашка устаревшего AI-обзора в отчете MD/PDF. */
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
 * Текст фактора фрода — кодом из факта: числа берутся из данных, а не из
 * формулировки модели. Возвращает null, если факта нет или ключ неизвестен —
 * тогда показывается формулировка модели.
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
      // признаки ритма (rhythm.ts) — только ненулевые, без оценки их силы
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

/** Абзацы AI-текста по переводам строк — одна функция для карточки и отчета. */
export function aiParagraphs(text: string): string[] {
  // типографика применяется и при выводе — для текстов, сохраненных до ее появления
  return normalizeTypography(text).split(/\n+/).map((l) => l.trim()).filter((l) => l !== "");
}

/**
 * Почему чужой репозиторий из избранного не анализировался — по результату
 * проверки прав: права не проверены; публичный — появится после обхода;
 * закрытый — кода токен не видит.
 */
export function notOwnReason(access: { visibility: string; own: boolean } | null | undefined): string {
  const lead = "Репозиторий в вашем избранном, но сервис его не анализировал: анализ по кнопке запускается для репозиториев ваших организаций";
  if (!access) return `${lead}. Права вашего токена к нему еще не проверены – проверка идет в «Избранном».`;
  if (access.visibility === "public") return `${lead}. Публичный репозиторий появится в рейтинге после планового анализа.`;
  // закрытый или внутренний с доступом к коду считается «своим»; не свой — значит кода токен не видит
  return `${lead} – у вашего токена нет доступа к коду этого репозитория.`;
}

// ---------- лимиты AI у кнопок и в «Настройках» ----------

export interface QuotaWindowView {
  used: number;
  limit: number;
}

/** Ячейка таблицы «Лимиты AI»: остаток «N/M», как в тексте кнопок. */
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
 * Счетчик для текста кнопки («Сформировать обзор 2/3»): остаток и лимит самого
 * тесного окна — часа, суток или общего. С паролем числа нет (null).
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

/** Остаток словами для подсказки и `aria-label`: «Осталось 2 из 2 в этот час». */
export function counterText(counter: QuotaCounter): string {
  const when = counter.window === "hour" ? "в этот час" : counter.window === "day" ? "сегодня" : "на сервисе сегодня";
  return `Осталось ${counter.left} из ${counter.limit} ${when}`;
}

/**
 * Текст кнопки со счетчиком для подсказки и `aria-label`: «Сформировать обзор,
 * осталось 2 из 2 в этот час». На самой кнопке остаток — числом (`CountedLabel`).
 */
export function withCounter(label: string, counter: QuotaCounter | null): string {
  return counter === null ? label : `${label}, ${counterText(counter).toLowerCase()}`;
}

/** Видимая причина, почему кнопка неактивна: окно, которое держит, и время. */
export function quotaBlockedText(action: AiAction, q: ActionQuotaView, counter: QuotaCounter): string {
  const one = action === "overview" ? "Следующий обзор" : "Следующая проверка";
  const many = action === "overview" ? "обзоров" : "проверок";
  if (counter.window === "hour") {
    return `${one} – после ${q.hourResetAt ? fmtDateTime(q.hourResetAt) : "окончания часа"} (не больше ${counter.limit} в час)`;
  }
  if (counter.window === "day") return `Лимит ${many} на сегодня исчерпан (${counter.limit} в сутки) – откроется в 00:00 МСК`;
  return `Общий лимит ${many} сервиса на сегодня исчерпан – откроется в 00:00 МСК`;
}
