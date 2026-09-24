// optin.ts — per-repo оп-ин AI-генерации (спека В5 §3.5, решение 15.09):
// кнопка включает генерацию сейчас И автозапуск на следующих сканах этого
// репо; хранится в user_settings (таблица «оставлена под В5»), JSON-поле
// scan. Отдельный ключ на пользователя: владелец управляет СВОИМ репо.
import type { Database } from "bun:sqlite";

interface SettingsShape {
  summary?: { repos?: Record<string, boolean> };
  // прежнее содержимое поля (бюджеты GUI удалены в К5 В4.1) сохраняется как есть
  [key: string]: unknown;
}

function readSettings(raw: string): SettingsShape {
  try {
    const parsed = JSON.parse(raw) as SettingsShape;
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setSummaryAuto(db: Database, userId: number, slug: string, auto: boolean): void {
  const row = db.query("SELECT scan FROM user_settings WHERE user_id = ?").get(userId) as { scan: string } | null;
  const settings = row === null ? {} : readSettings(row.scan);
  const repos = { ...(settings.summary?.repos ?? {}) };
  // В5.3 (25.09, Екатерина): выключение хранится явным false — кнопка
  // «Обновить обзор» больше не включает автообновление, которое выключил человек
  repos[slug] = auto;
  const next = { ...settings, summary: { ...(settings.summary ?? {}), repos } };
  db.query(
    "INSERT INTO user_settings (user_id, scan, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET scan = excluded.scan, updated_at = excluded.updated_at",
  ).run(userId, JSON.stringify(next), new Date().toISOString());
}

/**
 * Кнопка генерации = намерение (решение 15.09) — включает автообновление, но
 * только если человек его явно не выключал (В5.3, 25.09). Возвращает итог.
 */
export function enableSummaryAutoUnlessOptedOut(db: Database, userId: number, slug: string): boolean {
  const row = db.query("SELECT scan FROM user_settings WHERE user_id = ?").get(userId) as { scan: string } | null;
  const current = row === null ? undefined : readSettings(row.scan).summary?.repos?.[slug];
  if (current === false) return false;
  setSummaryAuto(db, userId, slug, true);
  return true;
}

export function getSummaryAuto(db: Database, userId: number, slug: string): boolean {
  const row = db.query("SELECT scan FROM user_settings WHERE user_id = ?").get(userId) as { scan: string } | null;
  if (row === null) return false;
  return readSettings(row.scan).summary?.repos?.[slug] === true;
}

/** Есть ли ХОТЬ у кого-то автозапуск на этом репо (для авто-генерации в окне скана). */
export function anySummaryAuto(db: Database, slug: string): boolean {
  const rows = db.query("SELECT scan FROM user_settings").all() as { scan: string }[];
  return rows.some((r) => readSettings(r.scan).summary?.repos?.[slug] === true);
}
