// session.ts — сессии на подписанной httpOnly-cookie (В4/Б1, контракт
// плана): cookie несёт СЛУЧАЙНЫЙ токен + HMAC (APP_SECRET), таблица
// sessions хранит sha256(токен) → user_id, expires_at; отзываемо
// (не stateless — удаление строки убивает cookie). Имя/TTL/SameSite
// зафиксированы здесь: rh_session / 7 суток / Lax (OAuth-redirect с
// чужого домена обязан доезжать, Lax пропускает top-level navigation).
import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export const SESSION_COOKIE = "rh_session";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** отдельная короткая cookie для CSRF-state OAuth-потока */
export const OAUTH_STATE_COOKIE = "rh_oauth_state";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface SessionUser {
  userId: number;
  login: string;
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** cookie-значение: <token>.<hmac> — подпись не даёт подделать токен. */
export function signToken(secret: string, token: string): string {
  return `${token}.${hmac(secret, token)}`;
}

/** Обратная операция; null = форма неверна или подпись не сошлась. */
export function verifySigned(secret: string, cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = hmac(secret, token);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return token;
}

/** Новая сессия: случайный токен → строка sessions; возврат — cookie-значение. */
export function createSession(db: Database, secret: string, userId: number, now = new Date()): string {
  const token = randomBytes(24).toString("base64url");
  db.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  );
  return signToken(secret, token);
}

/** Пользователь по cookie-значению; истёкшие/отозванные = аноним. */
export function getSessionUser(db: Database, secret: string, cookieValue: string | undefined, now = new Date()): SessionUser | null {
  const token = verifySigned(secret, cookieValue);
  if (token === null) return null;
  const row = db
    .query(
      `SELECT s.user_id, s.expires_at, u.login FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as { user_id: number; expires_at: string; login: string } | null;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now.getTime()) {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  return { userId: row.user_id, login: row.login };
}

/** Отзыв сессии (logout): строка удаляется, cookie становится пустой. */
export function revokeSession(db: Database, secret: string, cookieValue: string | undefined): void {
  const token = verifySigned(secret, cookieValue);
  if (token !== null) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

/** upsert пользователя по ya_id; возвращает id. */
export function upsertUser(db: Database, yaId: string, login: string, now = new Date()): number {
  db.query(
    `INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ya_id) DO UPDATE SET login = excluded.login, last_login_at = excluded.last_login_at`,
  ).run(yaId, login, now.toISOString(), now.toISOString());
  return (db.query("SELECT id FROM users WHERE ya_id = ?").get(yaId) as { id: number }).id;
}

/** Cookie-заголовки в одном месте (Set-Cookie строки). */
export function sessionCookieHeader(secret: string, cookieValue: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** CSRF-state OAuth: случайная строка + короткая cookie того же значения. */
export function makeOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

export function oauthStateCookieHeader(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`;
}

export function oauthStateFromCookie(cookieValue: string | undefined): string | null {
  return typeof cookieValue === "string" && cookieValue.length > 8 ? cookieValue : null;
}

/** Cookie-строка запроса → словарь ( Bun Request.headers уже даёт строку). */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
