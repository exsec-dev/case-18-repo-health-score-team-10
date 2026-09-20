// format.ts — показ чисел и дат в одном месте. Правило tri-state (закон 2
// AGENTS.md) живёт здесь: отсутствие данных везде выглядит одинаково
// нейтрально — «нет данных», никогда не 0 и никогда не красным.

export const NO_DATA = "нет данных";
export const NO_SCORE = "Недостаточно данных";

/**
 * В4.4 (кластер M-9): RU-имена категорий из константы — фолбэк, когда
 * /api/meta не загрузился (раньше страница показывала сырые ключи).
 */
export const CATEGORY_TITLES_RU: Record<string, string> = {
  documentation: "Документация",
  cicd: "CI/CD",
  security: "Security",
  activity: "Активность",
  issues: "Issues",
  code: "Code health",
};

/** Балл категории 0..100 — целым: дробь тут ничего не объясняет. */
export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(Math.round(value));
}

/** Балл submetric приходит долей 0..1 — на экране это проценты (§2.2 плана). */
export function fmtSubmetric(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}`;
}

export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
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
 * 40–69 — есть над чем работать, <40 — плохо. Нет данных — нейтрально
 * (закон 2: отсутствие данных никогда не красное).
 */
export function scoreTheme(value: number | null | undefined): "success" | "warning" | "danger" | "misc" {
  if (value === null || value === undefined) return "misc";
  // уровень — по тому же округлённому числу, что видит зритель (69.6 показан как 70)
  const shown = Math.round(value);
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
  warning: "есть над чем работать",
  danger: "запущен",
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
export const SCORE_LEGEND_TITLE = "Как читать оценку";

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

/** Мера имени в `DefinitionList` — одна на все панели (У27: единый nameMaxWidth). */
export const DEFINITION_NAME_WIDTH = 140;

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
export function summaryLine(input: SummaryInput): string {
  const scored = input.categories.filter((c): c is { title: string; score: number } => c.score !== null);
  const parts: string[] = [];
  if (scored.length > 0) {
    const best = [...scored].sort((a, b) => b.score - a.score)[0]!;
    const worst = [...scored].sort((a, b) => a.score - b.score)[0]!;
    parts.push(`Сильнее всего – ${best.title} (${fmtScore(best.score)}), слабее всего – ${worst.title} (${fmtScore(worst.score)}).`);
  }
  parts.push(
    `Рекомендаций: ${input.recommendations}` +
      `${input.top ? `; наибольший измеримый прирост дает «${input.top.problem}» (${input.top.impact})` : ""}.`,
  );
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

/**
 * В4.4 (кластер E код-аудита): исход анализа для опросщиков (MePage/RepoPage).
 * Finished-скан со статусом bad — ОШИБКА (раньше любой доехавший скан
 * праздновался success-тостом «Анализ завершен»), ok/partial — успех,
 * running/нет скана — ещё не закончился. Тост рисует UI — здесь только исход.
 */
export function analysisOutcome(scan: { status: string; finishedAt: string | null } | null | undefined): "pending" | "ok" | "failed" {
  if (!scan || scan.finishedAt === null || scan.status === "running" || scan.status === "queued") return "pending";
  return scan.status === "bad" ? "failed" : "ok";
}

/** Прирост Score — одним знаком после точки, как в тексте эффекта рекомендации. */
export function fmtDelta(delta: number): string {
  return `+${(Math.round(delta * 10) / 10).toFixed(1)}`;
}

/**
 * Знаковая дельта (В4.3, К-Ф3.4): минус законен — плохие CI/Security
 * опускают Repo Health Score ниже HealthCraft Index (инверсия), знак
 * берётся из фактической разности. Одна копия для страницы и MD.
 */
export function fmtSigned(delta: number): string {
  const v = Math.round(delta * 10) / 10;
  return `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(1)}`;
}

/**
 * Единая копия про Security без данных (STOP §4 плана): категория
 * исключена с перенормировкой, а не занижена — доступ к AppSec даётся
 * правом, а не публичностью репозитория. Одна строка на странице и в MD.
 */
export const SECURITY_PUBLIC_NOTE =
  "Security считается только по данным AppSec SourceCraft, доступным по правам; " +
  "без них категория исключена с перенормировкой, а не занижена.";

/**
 * Заглушки закрытых зрителю каналов (К2 В4.1) по причине доступа. Ключи —
 * ChannelAccess без "granted". Строка — одна для страницы и MD-отчёта.
 */
export const ACCESS_LOCK_TEXT: Record<"no-pat" | "denied" | "pat-expired" | "check-failed", string> = {
  "no-pat": "Данные видны участникам репозитория: войдите и добавьте токен доступа SourceCraft в «Личном кабинете».",
  denied: "Ваш токен доступа не дает доступа к этим данным репозитория.",
  "pat-expired": "SourceCraft отклонил ваш токен доступа – обновите его в «Личном кабинете».",
  "check-failed": "Не удалось проверить доступ к этим данным – попробуйте открыть карточку позже.",
};

/** Размер человекочитаемо: ГБ с двумя знаками или МБ. */
export function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Math.round(gb * 100) / 100} ГБ`;
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

/** Длительность человекочитаемо: часы или минуты. */
export function fmtMinutes(ms: number): string {
  const min = ms / 60_000;
  return min >= 60 ? `${Math.round((min / 60) * 10) / 10} ч` : `${Math.round(min)} мин`;
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
    "Git-метрики (документация, активность, код) – нет данных; Score не занижен, их вес выброшен. Лимиты задает оператор сервиса."
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
export function authErrorText(raw: string): string {
  if (raw === "state") return "Не сошелся проверочный код входа (state) – начните вход заново. Так работает защита от подмены.";
  if (raw === "no_code") return "Провайдер входа не передал код подтверждения – попробуйте войти еще раз.";
  // В4.4 (кластер K/З4): отражаемый текст ограничен — обрезка 200 символов и
  // отсечение управляющих символов (фишинг авторитетностью официального Alert)
  const safe = raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  return `Вход не удался: ${safe}`;
}
