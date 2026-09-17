// format.ts — показ чисел и дат в одном месте. Правило tri-state (закон 2
// AGENTS.md) живёт здесь: отсутствие данных везде выглядит одинаково
// нейтрально — «нет данных», никогда не 0 и никогда не красным.

export const NO_DATA = "нет данных";
export const NO_SCORE = "Недостаточно данных";

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

export function fmtCoverage(coverage: number): string {
  return `${Math.round(coverage * 100)}%`;
}

/** Значение факта — читаемой строкой; объекты как JSON (доказательство, не проза). */
export function fmtFactValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 1);
}

/** Статус скана — человеческим словом, без жаргона таблицы. */
export function scanStatusText(status: string): string {
  switch (status) {
    case "ok":
      return "полный";
    case "partial":
      return "частичный";
    case "bad":
      return "сбойный";
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

/** Первая буква заглавная — для меток (Label): у платформы они в регистре предложения. */
export function sentence(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Кто запустил скан — словом, а не кодом очереди. */
export function scanTriggerText(trigger: string): string {
  switch (trigger) {
    case "periodic":
      return "по расписанию";
    case "user":
      return "вручную";
    default:
      return trigger;
  }
}

/** Прирост Score — одним знаком после точки, как в тексте эффекта рекомендации. */
export function fmtDelta(delta: number): string {
  return `+${(Math.round(delta * 10) / 10).toFixed(1)}`;
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
  "pat-expired": "SourceCraft отклонил ваш токен доступа — обновите его в «Личном кабинете».",
  "check-failed": "Не удалось проверить доступ к этим данным — попробуйте открыть карточку позже.",
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
    ? `, ${l.degradeSinceMonths} месяцев истории — больше ${fmtBytes(l.degradeMaxBytes)} или дольше ${fmtMinutes(l.degradeTimeoutMs)}`
    : "";
  return (
    `Репозиторий больше лимита сервиса: ${full}${degrade}. ` +
    "Git-метрики (документация, активность, код) — нет данных; Score не занижен, их вес выброшен. Лимиты задает оператор сервиса."
  );
}

/** Текст заглушки по доступу; granted → null (заглушки нет). */
export function accessLockText(access: string | undefined): string | null {
  if (access === undefined || access === "granted") return null;
  return ACCESS_LOCK_TEXT[access as keyof typeof ACCESS_LOCK_TEXT] ?? ACCESS_LOCK_TEXT["check-failed"];
}
