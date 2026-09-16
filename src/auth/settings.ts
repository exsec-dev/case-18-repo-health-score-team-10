// settings.ts — пользовательские настройки (В4/Б1): третий слой конфига
// (дефолты ← env ← DB-override из GUI, решение 15.09). Сейчас — только
// бюджеты скана (тогл-дефолт + значения + «снять лимит»); секция
// расширяема под per-repo LLM-оп-ин В5 — потому форма заведомо JSON, а
// не колонки. Чистые функции: чтение/валидация/слияние — тестируются
// без HTTP.
import type { Database } from "bun:sqlite";
import type { ScanCloneLimits, ScanConfig } from "../config";

export interface UserScanSettings {
  /** true → значения Config.scan (тогл-дефолт) */
  useDefaults: boolean;
  /** байты диск-бюджета клона; null = «снять лимит» (opt-in) */
  maxBytes: number | null;
  /** мс таймаута клона; null = «снять лимит» */
  timeoutMs: number | null;
}

export const DEFAULT_USER_SCAN: UserScanSettings = { useDefaults: true, maxBytes: null, timeoutMs: null };

/** Снятый лимит — не бесконечность, а недостижимый на практике потолок
 *  (watchdog и субпроцессы остаются конечными; владелец большой репы
 *  понимает цену — решение 15.09). */
export const UNLIMITED_BYTES = Number.MAX_SAFE_INTEGER;
export const UNLIMITED_TIMEOUT_MS = 6 * 3600_000;

export type SettingsParseResult = { ok: true; settings: UserScanSettings } | { ok: false; message: string };

/** Валидация PUT-тела: лишние/кривые поля — 400, тихий мусор не едет в БД. */
export function parseUserScanSettings(input: unknown): SettingsParseResult {
  if (input === null || typeof input !== "object") return { ok: false, message: "scan: ожидается объект" };
  const o = input as Record<string, unknown>;
  if (typeof o["useDefaults"] !== "boolean") return { ok: false, message: "scan.useDefaults: ожидается boolean" };
  for (const key of ["maxBytes", "timeoutMs"] as const) {
    const v = o[key];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      return { ok: false, message: `scan.${key}: ожидается число > 0 или null (снять лимит)` };
    }
  }
  return {
    ok: true,
    settings: {
      useDefaults: o["useDefaults"],
      maxBytes: typeof o["maxBytes"] === "number" ? Math.floor(o["maxBytes"]) : null,
      timeoutMs: typeof o["timeoutMs"] === "number" ? Math.floor(o["timeoutMs"]) : null,
    },
  };
}

export function readUserScanSettings(db: Database, userId: number): UserScanSettings {
  const row = db.query("SELECT scan FROM user_settings WHERE user_id = ?").get(userId) as { scan: string } | null;
  if (!row) return DEFAULT_USER_SCAN;
  let raw: unknown;
  try {
    raw = JSON.parse(row.scan);
  } catch {
    return DEFAULT_USER_SCAN; // мусор в БД = дефолт (fail-soft)
  }
  const parsed = parseUserScanSettings(raw);
  return parsed.ok ? parsed.settings : DEFAULT_USER_SCAN;
}

export function writeUserScanSettings(db: Database, userId: number, settings: UserScanSettings, now = new Date()): void {
  db.query(
    `INSERT INTO user_settings (user_id, scan, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET scan = excluded.scan, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(settings), now.toISOString());
}

/** Эффективные лимиты клона для own-скана юзера (настройки поверх Config.scan). */
export function effectiveCloneLimits(scan: ScanConfig, settings: UserScanSettings | null): ScanCloneLimits {
  const base: ScanCloneLimits = { ...scan.clone, degrade: { ...scan.degrade } };
  if (!settings || settings.useDefaults) return base;
  return {
    ...base,
    maxBytes: settings.maxBytes ?? UNLIMITED_BYTES,
    timeoutMs: settings.timeoutMs ?? UNLIMITED_TIMEOUT_MS,
  };
}
