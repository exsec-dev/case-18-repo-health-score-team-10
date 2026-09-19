// pat.ts — хранение юзерского PAT SourceCraft (В4/Б1): AES-256-GCM.
// Ф2.8 (В4.2b): ключ = HKDF(APP_SECRET, "repo-health", "pat", 32), а не
// голый sha256 — у сессий и PAT разные ключи от одного секрета; шифротекст
// с префиксом `v2:` (расшифровка старого формата без префикса — по
// прежнему ключу sha256, чтобы перешифровка в openDb была возможна).
// Значение НИКОГДА: не в API-ответах, не в логах, не в ошибках.
// getPat → string | null; отсутствие PAT = own-режим недоступен, а не
// «пустой токен» — честная семантика для routes и раннера.
import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/** Префикс шифротекста на ключе HKDF (Ф2.8); без префикса — legacy sha256. */
export const PAT_V2_PREFIX = "v2:";

/** Ключ шифрования PAT из APP_SECRET: HKDF-вывод 32 байта (контекст "pat"). */
function deriveKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "repo-health", "pat", 32));
}

/** Прежний ключ (до Ф2.8): голый sha256(APP_SECRET) — только для чтения старых строк. */
function legacyKey(appSecret: string): Buffer {
  return createHash("sha256").update(appSecret).digest();
}

function encryptWith(key: Buffer, pat: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(pat, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

function decryptWith(key: Buffer, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length <= 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** PAT → "v2:<base64(iv|ciphertext|tag)>". Ошибка шифрования невозможна при валидном ключе. */
export function encryptPat(appSecret: string, pat: string): string {
  return PAT_V2_PREFIX + encryptWith(deriveKey(appSecret), pat);
}

/**
 * Обратная операция; null = нет записи, ключ сменился или данные повреждены.
 * Строки без `v2:` читаются прежним ключом sha256 — так openDb может
 * перешифровать их на HKDF (Ф2.8).
 */
export function decryptPat(appSecret: string, patEnc: string): string | null {
  if (patEnc.startsWith(PAT_V2_PREFIX)) return decryptWith(deriveKey(appSecret), patEnc.slice(PAT_V2_PREFIX.length));
  return decryptWith(legacyKey(appSecret), patEnc);
}

/**
 * Ф2.8: перешифровка одного сохранённого значения на актуальный ключ.
 * null = значение не расшифровалось (например, APP_SECRET сменился) —
 * вызывающий обязан такую строку НЕ трогать.
 */
export function reencryptPat(appSecret: string, patEnc: string): string | null {
  const plain = decryptPat(appSecret, patEnc);
  return plain === null ? null : encryptPat(appSecret, plain);
}

/** Сохранить/заменить PAT (PK user_id — замена, не накопление). */
export function storePat(db: Database, appSecret: string, userId: number, pat: string, now = new Date()): void {
  db.query(
    `INSERT INTO user_tokens (user_id, pat_enc, checked_at, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pat_enc = excluded.pat_enc, checked_at = excluded.checked_at`,
  ).run(userId, encryptPat(appSecret, pat), now.toISOString(), now.toISOString());
}

/** PAT юзера или null; расшифровка на каждом использовании — паттернов в памяти не держим. */
export function getPat(db: Database, appSecret: string, userId: number): string | null {
  const row = db.query("SELECT pat_enc FROM user_tokens WHERE user_id = ?").get(userId) as { pat_enc: string } | null;
  if (!row) return null;
  return decryptPat(appSecret, row.pat_enc);
}

/**
 * Ф2.8 (LOW-5): PAT на месте И реально читается текущим ключом. После
 * ротации APP_SECRET строка остаётся, но не расшифровывается — без этой
 * проверки `patMeta` отвечал `hasPat: true`, а own-сканы шли без PAT.
 */
export function patReadable(db: Database, appSecret: string, userId: number): boolean {
  return getPat(db, appSecret, userId) !== null;
}

/** Удалить PAT (окно github-style: «удаление/замена токена»). */
export function deletePat(db: Database, userId: number): void {
  db.query("DELETE FROM user_tokens WHERE user_id = ?").run(userId);
}

export function patMeta(db: Database, userId: number): { hasPat: true; checkedAt: string } | { hasPat: false } {
  const row = db.query("SELECT checked_at FROM user_tokens WHERE user_id = ?").get(userId) as { checked_at: string } | null;
  return row ? { hasPat: true, checkedAt: row.checked_at } : { hasPat: false };
}
