// pat.ts — хранение юзерского PAT SourceCraft (В4/Б1): AES-256-GCM,
// ключ = sha256(APP_SECRET); рядом с шифротекстом iv и tag (контракт
// плана). Значение НИКОГДА: не в API-ответах, не в логах, не в ошибках.
// getPat → string | null; отсутствие PAT = own-режим недоступен, а не
// «пустой токен» — честная семантика для routes и раннера.
import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Ключ шифрования из APP_SECRET (32 байта для AES-256-GCM). */
function deriveKey(appSecret: string): Buffer {
  return createHash("sha256").update(appSecret).digest();
}

/** PAT → "base64(iv|ciphertext|tag)". Ошибка шифрования невозможна при валидном ключе. */
export function encryptPat(appSecret: string, pat: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(appSecret), iv);
  const enc = Buffer.concat([cipher.update(pat, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

/** Обратная операция; null = нет записи, ключ сменился или данные повреждены. */
export function decryptPat(appSecret: string, patEnc: string): string | null {
  try {
    const raw = Buffer.from(patEnc, "base64");
    if (raw.length <= 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(appSecret), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
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

/** Удалить PAT (окно github-style: «удаление/замена токена»). */
export function deletePat(db: Database, userId: number): void {
  db.query("DELETE FROM user_tokens WHERE user_id = ?").run(userId);
}

export function patMeta(db: Database, userId: number): { hasPat: true; checkedAt: string } | { hasPat: false } {
  const row = db.query("SELECT checked_at FROM user_tokens WHERE user_id = ?").get(userId) as { checked_at: string } | null;
  return row ? { hasPat: true, checkedAt: row.checked_at } : { hasPat: false };
}
