// submetrics.ts — словарь 28 подметрик: название и форма показа значения
// (В4.7, контракт П4.2; вопрос 28 канвы закрыт 21.09 — «оба в В4.7»).
//
// Одно правило на страницу карточки, MD и PDF: строка подметрики на
// карточке и таблица подметрик отчёта берут отсюда и название (первая
// колонка MD — русское название вместо ключа, решение В3), и значение.
// Составное значение собирается в короткую строку и НЕ обрезается
// многоточием. Поповер «Основание» и раздел фактов остаются сырыми — это
// доказательство, а не показ.
//
// Модуль импортирует фронтенд, поэтому здесь нет ни серверного кода, ни
// `pdfmake`, ни `Intl`/локали (одинаковый вывод на сервере и в браузере).
// Формы значений сняты с кода скоринга (`src/score/compute.ts`,
// `derived.ts`, реестр фактов `collectors/facts.ts`), сам скоринг не тронут:
//   documentation.readme      — факт docs.readme: {bytes, sections, flags} | {present:false};
//   cicd.config               — факт cicd.configs: {paths, has_ci_yaml, has_steps};
//   cicd.duration             — секунды (duration_p50);
//   issues.first_resp         — часы; issues.close_days — дни;
//   security.density          — находок (с весами severity) на 10 тыс. строк;
//   code.density              — маркеров TODO/FIXME на 1 тыс. строк;
//   activity.fresh            — отметка времени (мс) последнего коммита
//                               человека → «N дней» на момент скана (решение В3);
//   activity.mirror_likeness  — {sync_share, authors, committers};
//   issues.tracker_unused     — {open, closed};
//   доли — 0..1 (показ в процентах); без значения — «—».

/** Глиф «нет данных» (tri-state, закон 2): тот же, что у `fmtScore` и ячеек MD. */
export const NO_VALUE = "—";

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
  /** значение → короткая строка; null — значения нет (показывается «—») */
  format: Formatter;
}

// ---------- мелкие форматтеры ----------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Число без локали: целое как есть, дробное — до `digits` знаков (точка, как во всем отчете). */
function num(value: number, digits = 2): string {
  if (Number.isInteger(value)) return String(value);
  const p = 10 ** digits;
  return String(Math.round(value * p) / p);
}

/** Русское согласование с числом: 1 день, 2 дня, 5 дней (дробное — родительный ед.: 2.5 дня). */
function plural(value: number, one: string, few: string, many: string): string {
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
    isNum(v) ? `${num(v, 1)} ${plural(Math.round(v * 10) / 10, one, few, many)}` : null;

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

/** README: «8000 байт, 5 разделов, есть: установка»; нет файла — «нет файла». */
const readme: Formatter = (v) => {
  const r = obj(v);
  if (!r) return null;
  if (r.present === false) return "нет файла";
  const parts: string[] = [];
  if (isNum(r.bytes)) parts.push(`${num(r.bytes)} ${plural(r.bytes, "байт", "байта", "байт")}`);
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

/** Конфигурация CI (булевы признаки ci.yaml): «ci.yaml со шагами» / «ci.yaml без шагов» / «нет ci.yaml». */
const ciConfig: Formatter = (v) => {
  const c = obj(v);
  if (!c) return null;
  if (c.has_ci_yaml !== true) return "нет ci.yaml";
  return c.has_steps === true ? "ci.yaml со шагами" : "ci.yaml без шагов";
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

// ---------- словарь ----------

/** Ключ — `<категория>.<подметрика>`, как в `categories[*].submetrics` оценки. */
export const SUBMETRICS: Record<string, SubmetricSpec> = {
  "documentation.readme": { title: "README (наличие и качество)", unit: "байты, разделы, описанные шаги", format: readme },
  "documentation.license": { title: "Лицензия", unit: "есть/нет", format: presence },
  "documentation.contributing": { title: "CONTRIBUTING", unit: "есть/нет", format: presence },
  "documentation.codeowners": { title: "CODEOWNERS", unit: "есть/нет", format: presence },
  "cicd.config": { title: "Конфигурация CI со шагами", unit: "признаки ci.yaml", format: ciConfig },
  "cicd.pass_rate": { title: "Доля успешных прогонов", unit: "доля, %", format: share },
  "cicd.duration": { title: "Медианная длительность пайплайна", unit: "секунды → с/мин/ч", format: duration },
  "security.density": { title: "Плотность находок на 10К строк", unit: "на 10 тыс. строк", format: perLines("10 тыс.") },
  "security.resolved": { title: "Доля закрытых находок", unit: "доля, %", format: share },
  "security.secrets": { title: "Отсутствие критичных утечек", unit: "найдены/нет", format: (v) => (typeof v === "boolean" ? (v ? "найдены" : "нет") : null) },
  "activity.fresh": { title: "Свежесть последнего коммита человека", unit: "дни на момент скана", format: daysSince },
  "activity.freq": { title: "Частота коммитов", unit: "коммитов в месяц", format: (v) => (isNum(v) ? `${num(v, 1)} в месяц` : null) },
  "activity.contributors": { title: "Число авторов", unit: "авторы", format: count("автор", "автора", "авторов") },
  "activity.pulls_90d": { title: "Merge-request'ы за 90 дней", unit: "штуки", format: plain },
  "activity.releases_12m": { title: "Релизы за 12 месяцев", unit: "штуки", format: plain },
  "activity.mirror_likeness": { title: "Похожесть на зеркало", unit: "доля синхронизаций, авторы, коммитеры", format: mirror },
  "activity.commits_90d": { title: "Коммиты за 90 дней", unit: "штуки", format: plain },
  "activity.commits_365d": { title: "Коммиты за год", unit: "штуки", format: plain },
  "activity.sync_bursts": { title: "Всплески синхронизации", unit: "штуки", format: plain },
  "issues.stale": { title: "Доля зависших issues", unit: "доля, %", format: share },
  "issues.close_days": { title: "Медиана времени закрытия", unit: "дни", format: count("день", "дня", "дней") },
  "issues.resolution": { title: "Доля решенных", unit: "доля, %", format: share },
  "issues.first_resp": { title: "Время до первого ответа", unit: "часы", format: (v) => (isNum(v) ? `${num(v, 1)} ч` : null) },
  "issues.tracker_unused": { title: "Трекер не ведется", unit: "открытые и закрытые issues", format: tracker },
  "code.density": { title: "Плотность TODO/FIXME", unit: "на 1 тыс. строк", format: perLines("1 тыс.") },
  "code.old_share": { title: "Доля старых TODO", unit: "доля, %", format: share },
  "code.root": { title: "Порядок в корне репозитория", unit: "элементы корня", format: count("элемент", "элемента", "элементов") },
  "code.todo_total": { title: "Всего маркеров TODO/FIXME", unit: "штуки", format: plain },
};

/** Название подметрики; незнакомый ключ — как есть (показ не падает). */
export function submetricTitle(category: string, sub: string): string {
  return SUBMETRICS[`${category}.${sub}`]?.title ?? sub;
}

/**
 * Значение подметрики короткой строкой по словарю; нет значения — «—».
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
