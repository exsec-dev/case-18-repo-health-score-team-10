// Словарь подметрик: название и форма показа значения. Одно правило для
// карточки, MD и PDF — строка подметрики на карточке и таблица подметрик
// отчета берут отсюда и русское название, и значение. Составное значение
// собирается в короткую строку и не обрезается многоточием. Поповер «Основание»
// и раздел фактов остаются сырыми — это доказательство, а не показ.
//
// Модуль импортирует фронтенд, поэтому здесь нет ни серверного кода, ни
// `pdfmake`, ни `Intl`/локали (одинаковый вывод на сервере и в браузере).
// Формы значений соответствуют коду скоринга (`src/score/compute.ts`,
// `derived.ts`, реестр фактов `collectors/facts.ts`):
//   documentation.readme      — факт docs.readme: {bytes, sections, flags} | {present:false};
//   cicd.config               — факт cicd.configs: {paths, has_ci_yaml, has_steps};
//   cicd.duration             — секунды (duration_p50);
//   issues.first_resp         — часы; issues.close_days — дни;
//   security.density          — находок (с весами severity) на 10 тыс. строк;
//   code.density              — маркеров TODO/FIXME на 1 тыс. строк;
//   activity.fresh            — отметка времени (мс) последнего коммита
//                               человека → «N дней» на момент скана;
//   activity.mirror_likeness  — {sync_share, authors, committers};
//   issues.tracker_unused     — {open, closed};
//   cicd.stability            — {trend, recent_share, previous_share, window} |
//                               {trend: null, few_runs, completed, needed};
//   issues.backlog_trend      — {created, closed, balance, direction};
//   issues.monthly_flow       — [{from, created, closed}] от старых окон к новым;
//   доли — 0..1 (показ в процентах); без значения — «–».

import { MINUS } from "../web/format";

/** «Уязвимые зависимости»: «нет» или «N: прямых A, транзитивных B[, не найдено в lock C]». */
function vulnerableDeps(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { vulnerable?: unknown; direct?: unknown; transitive?: unknown; unmatched?: unknown; outside?: unknown };
  if (!isNum(v.vulnerable)) return null;
  if (v.vulnerable === 0) return "нет";
  const parts = [`${num(isNum(v.direct) ? v.direct : 0)} прямых`, `${num(isNum(v.transitive) ? v.transitive : 0)} транзитивных`];
  if (isNum(v.unmatched) && v.unmatched > 0) parts.push(`${num(v.unmatched)} не найдено в lock-файле`);
  if (isNum(v.outside) && v.outside > 0) parts.push(`${num(v.outside)} вне графа (другая экосистема, без веса)`);
  return `${num(v.vulnerable)}: ${parts.join(", ")}`;
}

/** Глиф «нет данных» (tri-state): той же, что у `fmtScore` и ячеек MD. */
export const NO_VALUE = "–";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Контекст показа: момент скана (мс) — от него «N дней» у `activity.fresh`. */
export interface SubmetricContext {
  /** время расчета оценки скана (мс с эпохи); null — момента нет, «N дней» не считается */
  at: number | null;
}

type Formatter = (value: unknown, ctx: SubmetricContext) => string | null;

export interface SubmetricSpec {
  /** название на карточке и в первой колонке таблицы подметрик MD/PDF */
  title: string;
  /** единица/форма словами — для документации словаря и тестов */
  unit: string;
  /** значение → короткая строка; null — значения нет (показывается «–») */
  format: Formatter;
}

// ---------- мелкие форматтеры ----------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Число показателя: целое — с разрядами («12 480»), дробное — до одного знака
 * после запятой, десятичная запятая и минус «−» (как у `fmtDecimal`).
 */
function num(value: number): string {
  // ненулевое значение меньше 0,05 при одном знаке стало бы «0»
  if (value > 0 && value < 0.05) return "меньше 0,1";
  const body = Math.abs(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return value < 0 && body !== "0" ? `${MINUS}${body}` : body;
}

/** Размер файла в килобайтах — всегда с одним знаком и разрядами: «13,1 КБ», «1 204,0 КБ». */
export function fmtKb(bytes: number): string {
  // непустой файл меньше 0,05 КБ при одном знаке стал бы «0,0 КБ»
  if (bytes > 0 && bytes < 51.2) return "меньше 0,1 КБ";
  return `${(bytes / 1024).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} КБ`;
}

/** Русское согласование с числом: 1 день, 2 дня, 5 дней (дробное — родительный ед.: 2.5 дня). */
export function plural(value: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(value)) return few;
  const n = Math.abs(value);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const count =
  (one: string, few: string, many: string): Formatter =>
  (v) =>
    // «меньше 0,1 дня»: согласование как у дробного
    isNum(v) ? `${num(v)} ${plural(v > 0 && v < 0.05 ? 0.1 : Math.round(v * 10) / 10, one, few, many)}` : null;

const plain: Formatter = (v) => (isNum(v) ? num(v) : null);

const share: Formatter = (v) => (isNum(v) ? `${Math.round(v * 100)}%` : null);

const perLines =
  (per: string): Formatter =>
  (v) =>
    isNum(v) ? `${num(v)} на ${per} строк` : null;

const presence: Formatter = (v) => (typeof v === "boolean" ? (v ? "есть" : "нет") : null);

/** Длительность в секундах: «45 с», «7 мин», «1 ч 5 мин». */
const duration: Formatter = (v) => {
  if (!isNum(v)) return null;
  const s = Math.round(v);
  if (s < 60) return `${s} с`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`;
};

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** README: «7,8 КБ, 5 разделов, есть: установка»; нет файла — «нет файла». */
const readme: Formatter = (v) => {
  const r = obj(v);
  if (!r) return null;
  if (r.present === false) return "нет файла";
  const parts: string[] = [];
  if (isNum(r.bytes)) parts.push(fmtKb(r.bytes));
  if (isNum(r.sections)) parts.push(`${num(r.sections)} ${plural(r.sections, "раздел", "раздела", "разделов")}`);
  const flags = obj(r.flags) ?? {};
  const described = [
    ["install", "установка"],
    ["build", "сборка"],
    ["test", "тесты"],
  ]
    .filter(([key]) => flags[key!] === true)
    .map(([, word]) => word);
  if (described.length > 0) parts.push(`есть: ${described.join(", ")}`);
  return parts.length > 0 ? parts.join(", ") : null;
};

/** Конфигурация CI (булевы признаки ci.yaml): «ci.yaml с командами» / «ci.yaml без команд» / «нет ci.yaml». */
const ciConfig: Formatter = (v) => {
  const c = obj(v);
  if (!c) return null;
  if (c.has_ci_yaml !== true) return "нет ci.yaml";
  return c.has_steps === true ? "ci.yaml с командами" : "ci.yaml без команд";
};

/** «N дней» на момент скана: сколько полных дней прошло от коммита до расчета оценки. */
const daysSince: Formatter = (v, ctx) => {
  if (!isNum(v)) return null;
  // без момента скана «N дней» не посчитать — сырая отметка времени не показ
  if (ctx.at === null) return NO_VALUE;
  const days = Math.max(0, Math.floor((ctx.at - v) / DAY_MS));
  return `${days} ${plural(days, "день", "дня", "дней")}`;
};

/** Похожесть на зеркало: доля синхронизаций и соотношение авторов и коммитеров. */
const mirror: Formatter = (v) => {
  const m = obj(v);
  if (!m) return null;
  const parts: string[] = [];
  if (isNum(m.sync_share)) parts.push(`синхронизаций ${Math.round(m.sync_share * 100)}%`);
  if (isNum(m.authors)) parts.push(`авторов ${num(m.authors)}`);
  if (isNum(m.committers)) parts.push(`коммитеров ${num(m.committers)}`);
  return parts.length > 0 ? parts.join(", ") : null;
};

/** Трекер не ведется: {open, closed} → «открытых 0, закрытых 0». */
const tracker: Formatter = (v) => {
  const t = obj(v);
  if (!t || !isNum(t.open) || !isNum(t.closed)) return null;
  return `открытых ${num(t.open)}, закрытых ${num(t.closed)}`;
};

/**
 * «стабильнее, 90% успешных у последних 10 запусков против 60% у 10 до них».
 * Без двоеточий и тире внутри: строка встает после «Название – » и «Название: »
 * (справочная строка раздела и приложение Б отчета).
 */
const ciStability: Formatter = (v) => {
  const c = obj(v);
  if (!c) return null;
  if (c.few_runs === true && isNum(c.completed) && isNum(c.needed)) {
    return `нет данных, мало запусков (${num(c.completed)} ${plural(c.completed, "завершенный", "завершенных", "завершенных")}, нужно от ${num(c.needed)})`;
  }
  const word = c.trend === "better" ? "стабильнее" : c.trend === "worse" ? "хуже" : c.trend === "same" ? "без изменений" : null;
  if (word === null || !isNum(c.recent_share) || !isNum(c.previous_share) || !isNum(c.window)) return null;
  const n = num(c.window);
  return `${word}, ${Math.round(c.recent_share * 100)}% успешных у последних ${n} ${plural(c.window, "запуска", "запусков", "запусков")} против ${Math.round(c.previous_share * 100)}% у ${n} до них`;
};

/** Знак баланса: «+5», «−4», «0» (минус — «−», как у `fmtDecimal`). */
const signed = (n: number): string => (n > 0 ? `+${num(n)}` : n < 0 ? num(Math.round(n)) : "0");

/** «бэклог растет, +5 за 90 дней (создано 12, закрыто 7)». */
const backlogTrend: Formatter = (v) => {
  const b = obj(v);
  if (!b || !isNum(b.created) || !isNum(b.closed) || !isNum(b.balance)) return null;
  if (b.created === 0 && b.closed === 0) return "без движения, за 90 дней задачи не создавались и не закрывались";
  const word = b.direction === "growing" ? "бэклог растет" : b.direction === "shrinking" ? "бэклог разбирается" : b.direction === "stable" ? "бэклог стабилен" : null;
  if (word === null) return null;
  return `${word}, ${signed(b.balance)} за 90 дней (создано ${num(b.created)}, закрыто ${num(b.closed)})`;
};

/** Пояснения в скобках после значения: сайт показывает их один раз подсказкой (`submetricShownParts`). */
const ASIDE_OLD_SHARE = "доля от не менее 5 пометок";
const ASIDE_TESTS = "в балл не входит: доля тестов учитывается, только когда повышает балл";
const SHOWN_ASIDES = [ASIDE_OLD_SHARE, ASIDE_TESTS];

/**
 * Поток задач сводкой словами (выбор 19.10.2026 вместо «0/0, …, 16/16»): всего за
 * покрытые окна и отдельно за последние 30 дней. Окна — по 30 дней, от старых к
 * новым; окна без данных (список задач обрезан) в счет не входят и сокращают период.
 */
const monthlyFlow: Formatter = (v) => {
  if (!Array.isArray(v) || v.length === 0) return null;
  const windows = v.map((w) => {
    const o = obj(w);
    return o && isNum(o.created) && isNum(o.closed) ? { created: o.created, closed: o.closed } : null;
  });
  const covered = windows.filter((w): w is { created: number; closed: number } => w !== null);
  const last = windows[windows.length - 1] ?? null;
  if (covered.length === 0 || last === null) return null;
  const pair = (c: number, z: number) => `создано ${num(c)}, закрыто ${num(z)}`;
  const moved = (w: { created: number; closed: number }) => w.created > 0 || w.closed > 0;
  const months = (n: number) => `${n} ${plural(n, "месяц", "месяца", "месяцев")}`;
  const earlier = covered.slice(0, -1);
  if (earlier.length === 0) return moved(last) ? `за последние 30 дней ${pair(last.created, last.closed)}` : "за последние 30 дней движения не было";
  const sum = (k: "created" | "closed") => covered.reduce((a, w) => a + w[k], 0);
  if (!covered.some(moved)) return `за ${months(covered.length)} движения не было: задачи не создавались и не закрывались`;
  if (!earlier.some(moved)) return `за последние 30 дней ${pair(last.created, last.closed)}; в предыдущие ${months(earlier.length)} движения не было`;
  const tail = moved(last) ? `за последние 30 дней – ${pair(last.created, last.closed)}` : "за последние 30 дней движения не было";
  return `за ${months(covered.length)} ${pair(sum("created"), sum("closed"))}; ${tail}`;
};

// ---------- ревью PR и карта владельцев ----------

/** Часы: до 48 ч — «N ч», дольше — «N дней» (сутки из 24 ч). */
const hoursOrDays: Formatter = (v) => {
  if (!isNum(v)) return null;
  if (v < 48) return `${num(v)} ч`;
  const days = Math.round((v / 24) * 10) / 10;
  return `${num(days)} ${plural(days, "день", "дня", "дней")}`;
};

/** Ревью PR без выборки: PR нет — «PR не используются» (данные); только черновики — числом. */
const prReview: Formatter = (v) => {
  const r = obj(v);
  if (!r || !isNum(r.pulls)) return null;
  if (r.pulls === 0) return "предложения изменений не используются";
  return `только черновики: ${num(r.pulls)}`;
};

/** Bottleneck: {waiting, open} → «1 из 3 открытых»; открытых нет — словами. */
const prWaiting: Formatter = (v) => {
  const w = obj(v);
  if (!w || !isNum(w.waiting) || !isNum(w.open)) return null;
  if (w.open === 0) return "открытых предложений нет";
  return `${num(w.waiting)} из ${num(w.open)} ${plural(w.open, "открытого", "открытых", "открытых")}`;
};

/** Карта владельцев: доля изменений у единственного владельца; изменений нет — словами. */
const ownership: Formatter = (v) => {
  const o = obj(v);
  if (!o) return null;
  if (o.changes === 0) return "изменений кода за год нет";
  if (!isNum(o.single_owner_share)) return null;
  return `${Math.round(o.single_owner_share * 100)}% изменений за год`;
};

// ---------- словарь ----------

/** Ключ — `<категория>.<подметрика>`, как в `categories[*].submetrics` оценки. */
export const SUBMETRICS: Record<string, SubmetricSpec> = {
  "documentation.readme": { title: "README (наличие и качество)", unit: "КБ, разделы, описанные шаги", format: readme },
  "documentation.license": { title: "Лицензия", unit: "есть/нет", format: presence },
  "documentation.contributing": { title: "CONTRIBUTING", unit: "есть/нет", format: presence },
  "documentation.codeowners": { title: "CODEOWNERS", unit: "есть/нет", format: presence },
  "cicd.config": { title: "Конфигурация CI со шагами", unit: "признаки ci.yaml", format: ciConfig },
  "cicd.pass_rate": { title: "Доля успешных запусков CI", unit: "доля, %", format: share },
  "cicd.duration": { title: "Медианная длительность запуска CI", unit: "секунды → с/мин/ч", format: duration },
  "cicd.stability": { title: "Стабильность CI в динамике", unit: "доля успешных: последние запуски против предыдущих (справочно, без веса)", format: ciStability },
  // мера — в значении, в названии ее повторять незачем
  "security.density": { title: "Плотность находок", unit: "на 10 тыс. строк", format: perLines("10 тыс.") },
  "security.resolved": { title: "Доля закрытых находок", unit: "доля, %", format: share },
  // без двойного отрицания: «Отсутствие критичных утечек – нет» читалось бы наоборот
  "security.secrets": { title: "Критичные утечки секретов", unit: "найдены/не найдены", format: (v) => (typeof v === "boolean" ? (v ? "найдены" : "не найдены") : null) },
  // значение — DepsSubmetricValue (compute.ts): уязвимые пакеты SCA против графа lock-файлов
  "security.deps": { title: "Уязвимые зависимости", unit: "пакеты: прямые и транзитивные", format: vulnerableDeps },
  "activity.fresh": { title: "Свежесть последнего коммита человека", unit: "дни на момент скана", format: daysSince },
  "activity.freq": { title: "Частота коммитов", unit: "коммитов в месяц", format: (v) => (isNum(v) ? `${num(v)} в месяц` : null) },
  "activity.contributors": { title: "Число авторов", unit: "авторы", format: count("автор", "автора", "авторов") },
  "activity.pulls_90d": { title: "Предложения изменений за 90 дней", unit: "штуки", format: plain },
  "activity.releases_12m": { title: "Релизы за 12 месяцев", unit: "штуки", format: plain },
  "activity.mirror_likeness": { title: "Похожесть на зеркало", unit: "доля синхронизаций, авторы, коммитеры", format: mirror },
  "activity.bus_factor": { title: "Bus factor", unit: "авторы половины коммитов за 90 дней (справочно, без веса)", format: plain },
  "activity.commits_90d": { title: "Коммиты за 90 дней", unit: "штуки", format: plain },
  "activity.commits_365d": { title: "Коммиты за год", unit: "штуки", format: plain },
  "activity.sync_bursts": { title: "Всплески синхронизации", unit: "штуки", format: plain },
  "issues.stale": { title: "Доля зависших задач", unit: "доля, %", format: share },
  "issues.close_days": { title: "Медиана времени закрытия", unit: "дни", format: count("день", "дня", "дней") },
  "issues.resolution": { title: "Доля решенных", unit: "доля, %", format: share },
  "issues.first_resp": { title: "Время до первого ответа", unit: "часы", format: (v) => (isNum(v) ? `${num(v)} ч` : null) },
  "issues.tracker_unused": { title: "Задачи не ведутся", unit: "открытые и закрытые задачи", format: tracker },
  "issues.backlog_trend": { title: "Динамика бэклога за 90 дней", unit: "создано минус закрыто (справочно, без веса)", format: backlogTrend },
  "issues.monthly_flow": { title: "Поток задач", unit: "создано и закрыто за 6 окон по 30 дней (справочно, без веса)", format: monthlyFlow },
  // пометки считаются только в коде — файлы тестов исключены
  "code.density": { title: "Плотность TODO/FIXME в коде", unit: "на 1 тыс. строк", format: perLines("1 тыс.") },
  "code.old_share": { title: "Доля старых TODO", unit: "доля, %", format: share },
  "code.tests": { title: "Файлы тестов", unit: "доля файлов кода, %", format: share },
  "code.root": { title: "Порядок в корне репозитория", unit: "элементы корня", format: count("элемент", "элемента", "элементов") },
  "code.todo_total": { title: "Маркеров TODO/FIXME в коде", unit: "штуки", format: plain },
  // справочные, без веса (DISPLAY_ONLY)
  "activity.pr_review": { title: "Ревью предложений изменений", unit: "предложений нет / только черновики (справочно, без веса)", format: prReview },
  "activity.pr_first_response": { title: "Время до первого ответа на предложение изменений", unit: "медиана, часы → ч/дни (справочно, без веса)", format: hoursOrDays },
  "activity.pr_waiting": { title: "Предложения изменений без ответа дольше 3 дней", unit: "открытые предложения выборки (справочно, без веса)", format: prWaiting },
  "activity.pr_review_comments": { title: "Комментариев ревью на предложение изменений", unit: "медиана по выборке (справочно, без веса)", format: plain },
  "activity.pr_merge_time": { title: "Время до слияния предложения изменений", unit: "медиана, часы → ч/дни (справочно, без веса)", format: hoursOrDays },
  "code.ownership": { title: "Изменения у единственного владельца", unit: "доля изменений кода за год (справочно, без веса)", format: ownership },
};

/**
 * Справочные подметрики без веса (см. docs/methodology.md): число объясняет
 * картину, но в балл категории не идет. Одна копия для карточки, MD и PDF.
 */
export const DISPLAY_ONLY = new Set([
  "activity.mirror_likeness",
  "activity.commits_90d",
  "activity.commits_365d",
  "activity.sync_bursts",
  "activity.bus_factor",
  "code.todo_total",
  "cicd.stability",
  "issues.backlog_trend",
  "issues.monthly_flow",
  "activity.pr_review",
  "activity.pr_first_response",
  "activity.pr_waiting",
  "activity.pr_review_comments",
  "activity.pr_merge_time",
  "code.ownership",
]);

export function displayOnly(category: string, sub: string): boolean {
  return DISPLAY_ONLY.has(`${category}.${sub}`);
}

/**
 * Ключ веса подметрики в `SUBWEIGHTS` методики: у двух подметрик ключ веса
 * короче ключа значения (`pulls_90d` → `pulls`, `releases_12m` → `releases`).
 */
export function subweightKey(sub: string): string {
  return sub === "pulls_90d" ? "pulls" : sub === "releases_12m" ? "releases" : sub;
}

/**
 * Служебные заметки расчета (`submetrics[*].note`, по-английски, из `compute.ts` /
 * `derived.ts`) в виде для читателя. Сопоставление — по ключу подметрики и
 * началу заметки, а не по точной строке: в БД лежат оценки прошлых версий кода.
 * `value` — что печатается вместо «–» в колонке значения; `remark` — примечание
 * под таблицей. Неизвестная заметка не показывается (null): сырой `note`
 * читателю не печатается никогда.
 */
export interface NoteText {
  value?: string;
  remark?: string;
}

export function submetricNote(category: string, sub: string, note: string | null | undefined): NoteText | null {
  if (typeof note !== "string" || note === "") return null;
  const key = `${category}.${sub}`;
  if (key === "issues.tracker_unused") return { remark: "Задач нет – категория получает минимальный балл." };
  // справочные показатели динамики — причина «нет данных» словами
  if (key === "cicd.stability" || key === "issues.backlog_trend" || key === "issues.monthly_flow") {
    // факты собраны старым сборщиком — без упоминания внутренних версий
    if (note.startsWith("older collector")) return { value: "появится после следующего анализа" };
    if (key !== "cicd.stability" && note.startsWith("tracker not maintained")) return { value: "задачи не ведутся" };
    if (key === "issues.backlog_trend" && note.startsWith("issue list truncated")) return { value: "нет данных, список задач обрезан и 90 дней не покрыты" };
    if (key === "cicd.stability" && note.startsWith("no declared CI")) return { value: "CI не настроен" };
    if (key === "cicd.stability" && note.startsWith("runs no-data")) return { value: "запуски недоступны" };
    return null;
  }
  if (key === "cicd.pass_rate" || key === "cicd.duration") {
    if (note.startsWith("no declared CI")) return { value: "CI не настроен" };
    if (note.startsWith("runs no-data")) return { value: "запуски недоступны" };
    // «не запускался» — словами: «0%» читалось бы как «все запуски упали»
    if (note.startsWith("runs pending")) return { value: "запуски идут" };
    if (note === "no runs") return { value: "CI не запускался" };
    if (note.startsWith("no runs within a year")) return { value: "за год не запускался" };
    if (note.startsWith("no recent runs")) return { value: "нет запусков за год" };
    return null;
  }
  // открытые задачи есть, закрытых нет — худший балл, словами
  if (key === "issues.close_days" && note.startsWith("no issue closed")) return { value: "ни одна задача не закрыта" };
  // «Тесты» — бонус: нет непустых тестов — в балл не входит
  if (key === "code.tests" && note.startsWith("no tests")) return { value: "тестов нет – в балл не входит" };
  if (key === "code.tests" && note.startsWith("tests bonus not applied")) return null;
  // оговорка «доля от не менее 5 пометок» — в показе значения (submetricShownValue)
  if (key === "code.old_share" && note.startsWith("share of at least")) return null;
  if (key === "code.old_share") return { value: "не посчитано: прочитаны не все файлы" };
  // справочные показатели ревью PR и владения кодом
  if (key === "activity.pr_review" && note.startsWith("pr review no-data")) return { value: note.endsWith(": access") ? "нет данных: нет доступа" : "нет данных: источник не ответил" };
  if (key === "activity.pr_first_response" && note.startsWith("no reviewer response")) return { value: "ответов ревьюеров нет" };
  if (key === "activity.pr_review_comments" && note.startsWith("comments page capped")) {
    return { remark: "У части предложений изменений комментариев больше одной страницы ответа – число комментариев ревью не меньше показанного." };
  }
  if (key === "activity.pr_merge_time" && note.startsWith("no merged pulls")) return { value: "слитых предложений изменений нет" };
  if (key === "activity.pr_merge_time" && note.startsWith("merge time approximated")) {
    return { remark: "Время до слияния предложения изменений приблизительное: даты слияния SourceCraft не передает, использована дата последнего изменения предложения." };
  }
  if (key === "code.ownership" && note.startsWith("ownership no-data")) return { value: "нет данных: история не прочитана" };
  return null;
}

/** Подметрики «есть/нет», у которых расчет хранит только балл (значения нет): показ — по баллу. */
const PRESENCE_BY_SCORE = new Set(["documentation.license", "documentation.contributing", "documentation.codeowners"]);

/**
 * Значение подметрики для показа с учетом заметки: «–» заменяется словами
 * заметки; у файлов «есть/нет» без значения — слово по баллу
 * (лицензия с баллом 100 — «есть», а не «–»).
 */
export function submetricShownValue(
  category: string,
  sub: string,
  entry: { score?: number | null; value?: unknown; note?: string | null },
  ctx: SubmetricContext,
  /** соседние подметрики категории (карточка и отчет передают, но показ их сейчас не читает) */
  _peers?: Record<string, { value?: unknown }>,
): string {
  const shown = formatSubmetricValue(category, sub, entry.value, ctx);
  // при 1-4 пометках доля старых считается от 5: «1 старая из 1» показывается
  // как 20%, и без оговорки число читалось бы ошибкой
  if (shown !== NO_VALUE && `${category}.${sub}` === "code.old_share" && typeof entry.note === "string" && entry.note.startsWith("share of at least")) {
    return `${shown} (${ASIDE_OLD_SHARE})`;
  }
  // доля тестов ниже прочих показателей — бонус не применен, число справочное
  if (shown !== NO_VALUE && `${category}.${sub}` === "code.tests" && typeof entry.note === "string" && entry.note.startsWith("tests bonus not applied")) {
    return `${shown} (${ASIDE_TESTS})`;
  }
  if (shown !== NO_VALUE) return shown;
  const n = submetricNote(category, sub, entry.note);
  if (n?.value) return n.value;
  if (PRESENCE_BY_SCORE.has(`${category}.${sub}`) && typeof entry.score === "number") return entry.score >= 1 ? "есть" : "нет";
  return shown;
}

/**
 * Значение и пояснение порознь: в таблицах сайта скобка, общая для строки,
 * повторялась в каждой ячейке и в каждом столбце сравнения — сайт дает ее
 * один раз подсказкой. Отчет показывает значение целиком (`submetricShownValue`).
 */
export function submetricShownParts(
  category: string,
  sub: string,
  entry: { score?: number | null; value?: unknown; note?: string | null },
  ctx: SubmetricContext,
): { value: string; aside: string | null } {
  const full = submetricShownValue(category, sub, entry, ctx);
  for (const aside of SHOWN_ASIDES) if (full.endsWith(` (${aside})`)) return { value: full.slice(0, -(aside.length + 3)), aside };
  return { value: full, aside: null };
}

/** Название подметрики; незнакомый ключ — как есть (показ не падает). */
export function submetricTitle(category: string, sub: string): string {
  return SUBMETRICS[`${category}.${sub}`]?.title ?? sub;
}

/**
 * Значение подметрики короткой строкой по словарю; нет значения — «–».
 * Незнакомый ключ или форма, которую словарь не узнал, — честный запасной
 * вид (число без хвоста, объект — компактным JSON), не пустота и не ошибка.
 */
export function formatSubmetricValue(category: string, sub: string, value: unknown, ctx: SubmetricContext): string {
  if (value === undefined || value === null) return NO_VALUE;
  const spec = SUBMETRICS[`${category}.${sub}`];
  const shown = spec?.format(value, ctx) ?? null;
  if (shown !== null) return shown;
  if (isNum(value)) return num(value);
  if (typeof value === "string") return value === "" ? NO_VALUE : value;
  if (typeof value === "boolean") return value ? "да" : "нет";
  return JSON.stringify(value);
}

/** Контекст показа по времени расчета оценки (`score.computedAt` карточки). */
export function submetricContext(computedAt: string | null | undefined): SubmetricContext {
  const at = computedAt ? Date.parse(computedAt) : Number.NaN;
  return { at: Number.isNaN(at) ? null : at };
}
