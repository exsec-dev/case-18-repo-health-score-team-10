// Факт анализа словами для поповера основания рекомендации: несколько строк
// по-русски о том, что показал факт; сырое значение остается под «Исходные данные».
// Словами описаны факты, на которые ссылаются правила рекомендаций (`recommend.ts`),
// прочие — парами «поле – значение», как в приложении В отчета.
// Тексты следуют правилам языка UI (среднее тире, без «ё», цифры);
// «—» — только глиф «нет данных».

import { fmtKb } from "./submetrics";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const n = (v: unknown, digits = 0): string =>
  isNum(v) ? v.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).replace(/ /g, " ") : "—";
const yesNo = (v: unknown): string => (v === true ? "есть" : v === false ? "нет" : "—");
const pct = (share: unknown): string => (isNum(share) ? `${Math.round(share * 100)}%` : "—");

function plural(value: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(value) % 10;
  const m100 = Math.abs(value) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «день/дня/дней» к числу, показанному с 1 знаком: дробное — «дня» (0,5 дня, 1,5 дня). */
function dayWord(value: number): string {
  const shown = Math.round(value * 10) / 10;
  return Number.isInteger(shown) ? plural(shown, "день", "дня", "дней") : "дня";
}

/** Длительность в секундах → «N с» / «N мин». */
function duration(sec: unknown): string {
  if (!isNum(sec)) return "—";
  return sec < 120 ? `${n(sec)} с` : `${n(sec / 60, 1)} мин`;
}

const RUN_WORD: Record<string, string> = {
  success: "успешно",
  failure: "с ошибкой",
  failed: "с ошибкой",
  cancelled: "отменен",
  canceled: "отменен",
  running: "идет",
  pending: "в очереди",
  unknown: "неизвестен",
};

type Words = (v: Obj) => string[];

const WORDS: Record<string, Words> = {
  "docs.presence": (v) => [
    `README – ${yesNo(v.readme)}, LICENSE – ${yesNo(v.license)}`,
    `CONTRIBUTING – ${yesNo(v.contributing)}, CODEOWNERS – ${yesNo(v.codeowners)}`,
    ...(v.content_checked === true ? ["Файл засчитывается, если в нем не меньше 16 значимых символов"] : []),
  ],
  "docs.readme": (v) => {
    if (v.present === false) return ["README в репозитории нет"];
    const flags = obj(v.flags) ?? {};
    return [
      `README – ${isNum(v.bytes) ? fmtKb(v.bytes) : "—"}, разделов с заголовками – ${n(v.sections)}`,
      `Разделы о запуске: установка – ${yesNo(flags.install)}, сборка – ${yesNo(flags.build)}, тесты – ${yesNo(flags.test)}`,
    ];
  },
  "cicd.configs": (v) => [
    `Файл .sourcecraft/ci.yaml – ${yesNo(v.has_ci_yaml)}`,
    ...(v.has_ci_yaml === true ? [`Шаги с командами – ${yesNo(v.has_steps)}`] : []),
    ...(typeof v.steps_note === "string" ? ["Конфигурацию CI разобрать не удалось"] : []),
  ],
  "cicd.runs": (v) => {
    const count = isNum(v.runs_count) ? v.runs_count : null;
    if (count === 0) return ["Запусков CI нет"];
    return [
      `Последний запуск – ${typeof v.last_status === "string" ? (RUN_WORD[v.last_status] ?? v.last_status) : "—"}`,
      `Успешных – ${pct(v.success_rate)}${count !== null ? ` из ${n(count)} ${plural(count, "запуска", "запусков", "запусков")}` : ""}`,
      `Типичная длительность – ${duration(v.duration_p50)}, успешных подряд – ${n(v.green_streak)}`,
    ];
  },
  "issues.stats": (v) => {
    const open = isNum(v.open) ? v.open : null;
    const closed = isNum(v.closed) ? v.closed : null;
    if (open === 0 && closed === 0) return ["Задач нет"];
    return [
      `Открыто – ${n(open)}${isNum(v.in_progress) && v.in_progress > 0 ? ` (в работе ${n(v.in_progress)})` : ""}, закрыто – ${n(closed)}${isNum(v.closed_instant) && v.closed_instant > 0 ? ` (быстрее часа – ${n(v.closed_instant)}, в расчет не входят)` : ""}`,
      `Типичное время закрытия – ${isNum(v.median_close_days) ? `${n(v.median_close_days, 1)} ${dayWord(v.median_close_days)}` : "—"}`,
      `Открытых без обновлений дольше 90 дней – ${n(v.stale_90d)}`,
    ];
  },
  "tree.stats": (v) => [
    `Файлов – ${n(v.file_count)}${isNum(v.source_files) ? `, из них с кодом – ${n(v.source_files)}` : ""}${isNum(v.test_files) ? `, тестов – ${n(v.test_files)}` : ""}`,
    `Строк кода – ${n(isNum(v.source_loc) ? v.source_loc : v.loc)}`,
  ],
  "code.todo": (v) => [
    `Пометок TODO – ${n(v.count)}, FIXME – ${n(v.fixme)}${isNum(v.todo_files) ? ` (файлов кода с пометками – ${n(v.todo_files)})` : ""}`,
    `Старше 180 дней – ${n(v.older_180d)}`,
    ...(isNum(v.test_markers) && v.test_markers > 0 ? [`В файлах тестов еще ${n(v.test_markers)} – в счет не входят`] : []),
  ],
  "appsec.findings": (v) => {
    const sev = obj(v.severity_counts) ?? {};
    const engines = obj(obj(v.backlog)?.engines);
    return [
      `Открытых находок: критичных – ${n(sev.critical)}, высоких – ${n(sev.high)}, средних – ${n(sev.medium)}, низких – ${n(sev.low)}`,
      `Закрыто находок – ${pct(v.resolved_share)}, утекшие критичные секреты – ${yesNo(v.secrets_critical)}`,
      ...(engines && Object.keys(engines).length > 0
        ? [`Анализаторы: ${Object.entries(engines).map(([k, c]) => `${k} – ${n(c)}`).join(", ")}`]
        : []),
    ];
  },
};

/** Значение → пары «поле – значение» (запасной путь для фактов без описания словами). */
function pairs(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix || "значение"} – нет`];
    const scalars = value.every((x) => x === null || typeof x !== "object");
    return [`${prefix || "значение"} – ${scalars && value.length <= 5 ? value.join(", ") : `${value.length} ${plural(value.length, "значение", "значения", "значений")}`}`];
  }
  const o = obj(value);
  if (o) return Object.entries(o).flatMap(([k, x]) => pairs(x, prefix ? `${prefix}.${k}` : k));
  const s = value === true ? "да" : value === false ? "нет" : value === null || value === undefined ? "—" : String(value);
  return [`${prefix || "значение"} – ${s}`];
}

/**
 * Факт словами: строки для показа над сырыми данными. Статус не «ok» — пусто
 * (статус и причину показывает сам поповер). Незнакомый ключ — пары
 * «поле – значение», не больше 8 строк.
 */
export function factWords(key: string, status: string, value: unknown): string[] {
  if (status !== "ok") return [];
  const words = WORDS[key];
  const o = obj(value);
  if (words && o) return words(o);
  const all = pairs(value);
  return all.length > 8 ? [...all.slice(0, 8), `и еще ${all.length - 8} – в исходных данных`] : all;
}
