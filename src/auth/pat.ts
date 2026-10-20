// Хранение PAT SourceCraft пользователя: AES-256-GCM, ключ – HKDF от APP_SECRET
// с контекстом "pat" (у сессий свой контекст, ключи разные при одном секрете).
// Старый формат без префикса `v2:` шифровался голым sha256(APP_SECRET); его
// еще читаем, чтобы openDb мог перешифровать такие строки.
// Значение PAT никогда не попадает в ответы API, логи и тексты ошибок.
// Отсутствие PAT – null (own-режим недоступен), а не «пустой токен».
import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/** Префикс шифротекста на ключе HKDF; без префикса – старый ключ sha256. */
export const PAT_V2_PREFIX = "v2:";

const IV_BYTES = 12;
/** Длина тега GCM задана явно: укороченный тег ослабляет проверку подлинности. */
const GCM_TAG_BYTES = 16;

function deriveKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "repo-health", "pat", 32));
}

/** Старый ключ sha256(APP_SECRET) – только для чтения строк без префикса `v2:`. */
function legacyKey(appSecret: string): Buffer {
  return createHash("sha256").update(appSecret).digest();
}

function encryptWith(key: Buffer, pat: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  const enc = Buffer.concat([cipher.update(pat, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

function decryptWith(key: Buffer, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.length <= IV_BYTES + GCM_TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - GCM_TAG_BYTES);
    const enc = raw.subarray(IV_BYTES, raw.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** PAT → "v2:<base64(iv|ciphertext|tag)>". */
export function encryptPat(appSecret: string, pat: string): string {
  return PAT_V2_PREFIX + encryptWith(deriveKey(appSecret), pat);
}

/**
 * null – ключ сменился или данные повреждены. Строки без `v2:` читаются
 * старым ключом sha256, чтобы openDb мог перешифровать их на HKDF.
 */
export function decryptPat(appSecret: string, patEnc: string): string | null {
  if (patEnc.startsWith(PAT_V2_PREFIX)) return decryptWith(deriveKey(appSecret), patEnc.slice(PAT_V2_PREFIX.length));
  return decryptWith(legacyKey(appSecret), patEnc);
}

/**
 * Перешифровка сохраненного значения на актуальный ключ. null – значение не
 * расшифровалось (например, сменился APP_SECRET), такую строку трогать нельзя.
 */
export function reencryptPat(appSecret: string, patEnc: string): string | null {
  const plain = decryptPat(appSecret, patEnc);
  return plain === null ? null : encryptPat(appSecret, plain);
}

/** Сохранить или заменить PAT: у пользователя одна строка. */
export function storePat(db: Database, appSecret: string, userId: number, pat: string, now = new Date(), ownerLogin: string | null = null): void {
  db.query(
    `INSERT INTO user_tokens (user_id, pat_enc, checked_at, created_at, owner_login) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pat_enc = excluded.pat_enc, checked_at = excluded.checked_at, owner_login = excluded.owner_login`,
  ).run(userId, encryptPat(appSecret, pat), now.toISOString(), now.toISOString(), ownerLogin);
}

/** Логин SourceCraft владельца сохраненного токена (из проверки GET /user); null — неизвестен. */
export function patOwnerLogin(db: Database, userId: number): string | null {
  return (db.query("SELECT owner_login FROM user_tokens WHERE user_id = ?").get(userId) as { owner_login: string | null } | null)?.owner_login ?? null;
}

/** Расшифровка на каждом использовании – открытый PAT в памяти не держим. */
export function getPat(db: Database, appSecret: string, userId: number): string | null {
  const row = db.query("SELECT pat_enc FROM user_tokens WHERE user_id = ?").get(userId) as { pat_enc: string } | null;
  if (!row) return null;
  return decryptPat(appSecret, row.pat_enc);
}

/**
 * PAT есть и читается текущим ключом. После смены APP_SECRET строка остается,
 * но не расшифровывается – одного `patMeta().hasPat` тут недостаточно.
 */
export function patReadable(db: Database, appSecret: string, userId: number): boolean {
  return getPat(db, appSecret, userId) !== null;
}

export function deletePat(db: Database, userId: number): void {
  db.query("DELETE FROM user_tokens WHERE user_id = ?").run(userId);
}

export function patMeta(db: Database, userId: number): { hasPat: true; checkedAt: string } | { hasPat: false } {
  const row = db.query("SELECT checked_at FROM user_tokens WHERE user_id = ?").get(userId) as { checked_at: string } | null;
  return row ? { hasPat: true, checkedAt: row.checked_at } : { hasPat: false };
}
