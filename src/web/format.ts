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
 * Единая копия про Security в публичном режиме (STOP §4 плана): категория
 * исключена с перенормировкой, а не занижена — доступ к AppSec даётся
 * правом, а не публичностью репозитория.
 */
export const SECURITY_PUBLIC_NOTE =
  "Security считается только для репозиториев с доступом к их AppSec; " +
  "в публичном режиме категория исключена с перенормировкой, а не занижена.";
