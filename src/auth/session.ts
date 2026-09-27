// session.ts — сессии на подписанной httpOnly-cookie (В4/Б1, контракт
// плана): cookie несёт СЛУЧАЙНЫЙ токен + HMAC (APP_SECRET), таблица
// sessions хранит sha256(токен) → user_id, expires_at; отзываемо
// (не stateless — удаление строки убивает cookie). Имя/TTL/SameSite
// зафиксированы здесь: rh_session / 7 суток / Lax (OAuth-redirect с
// чужого домена обязан доезжать, Lax пропускает top-level navigation).
// Ф2.7 (В4.2b): при YA_REDIRECT_URI на https имена переезжают на
// __Host-rh_* с атрибутом Secure (Path=/ уже есть, Domain не ставим) —
// требование `__Host-`; на http прежние имена, читается только актуальное.
import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual, createHash, hkdfSync } from "node:crypto";

export const SESSION_COOKIE = "rh_session";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** отдельная короткая cookie для CSRF-state OAuth-потока */
export const OAUTH_STATE_COOKIE = "rh_oauth_state";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Актуальные имена и атрибуты cookie (Ф2.7): зависят от схемы YA_REDIRECT_URI. */
export interface CookieNames {
  session: string;
  oauthState: string;
  /** true = добавить `Secure` (и имена `__Host-`); http-стендам не нужно */
  secure: boolean;
}

/**
 * Ф2.7: redirect на `https://` → `__Host-rh_session` / `__Host-rh_oauth_state`
 * (`Secure; Path=/`, без `Domain` — так требует префикс `__Host-`); иначе
 * прежние имена без Secure. Кривой redirect — прежние имена (fail-closed
 * к http-стенду разработки). Читается только актуальное имя.
 */
export function cookieNames(auth: { redirect: string }): CookieNames {
  let https = false;
  try {
    https = new URL(auth.redirect).protocol === "https:";
  } catch {
    /* не URL — прежние имена */
  }
  return https
    ? { session: "__Host-rh_session", oauthState: "__Host-rh_oauth_state", secure: true }
    : { session: SESSION_COOKIE, oauthState: OAUTH_STATE_COOKIE, secure: false };
}

export interface SessionUser {
  userId: number;
  login: string;
}

/**
 * Ф2.8: ключ HMAC сессий — HKDF от APP_SECRET с контекстом "session"
 * (PAT живёт на своём контексте "pat" в pat.ts). Смена APP_SECRET
 * инвалидирует все подписи — старые cookie становятся анонимными
 * (разлогинивает всех), это осознанное свойство, не дефект.
 */
function sessionHmacKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret, "repo-health", "session", 32));
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", sessionHmacKey(secret)).update(value).digest("base64url");
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

/** Дисплей-профиль пользователя: имя и id портрета Я ID (оба могут быть null). */
export function userProfile(db: Database, userId: number): { displayName: string | null; avatarId: string | null } {
  const row = db.query("SELECT display_name, avatar_id FROM users WHERE id = ?").get(userId) as
    | { display_name: string | null; avatar_id: string | null }
    | null;
  return { displayName: row?.display_name ?? null, avatarId: row?.avatar_id ?? null };
}

/** Отзыв сессии (logout): строка удаляется, cookie становится пустой. */
export function revokeSession(db: Database, secret: string, cookieValue: string | undefined): void {
  const token = verifySigned(secret, cookieValue);
  if (token !== null) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

/**
 * upsert пользователя по ya_id; возвращает id. Имя и портрет (дисплей) —
 * каждый вход перезаписывает: отозванное право Я ID обнуляет их честно.
 */
export function upsertUser(
  db: Database,
  yaId: string,
  login: string,
  now = new Date(),
  profile: { displayName?: string | null; avatarId?: string | null } = {},
): number {
  db.query(
    `INSERT INTO users (ya_id, login, created_at, last_login_at, display_name, avatar_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ya_id) DO UPDATE SET login = excluded.login, last_login_at = excluded.last_login_at,
       display_name = excluded.display_name, avatar_id = excluded.avatar_id`,
  ).run(yaId, login, now.toISOString(), now.toISOString(), profile.displayName ?? null, profile.avatarId ?? null);
  return (db.query("SELECT id FROM users WHERE ya_id = ?").get(yaId) as { id: number }).id;
}

/** Cookie-заголовки в одном месте (Set-Cookie строки); имена/Secure — по Ф2.7. */
export function sessionCookieHeader(names: CookieNames, cookieValue: string, maxAgeMs: number): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.session}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearSessionCookieHeader(names: CookieNames): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.session}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/** CSRF-state OAuth: случайная строка + короткая cookie того же значения. */
export function makeOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

export function oauthStateCookieHeader(names: CookieNames, state: string): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.oauthState}=${state}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`;
}

/** Гашение state-cookie — одинаковый исход у всех исходов callback (Ф2.7). */
export function clearOAuthStateCookieHeader(names: CookieNames): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.oauthState}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/**
 * Круг 5 тура 3 (находка 26 аудита, 27.09): куда вернуть после входа. Только путь
 * своего сайта — без схемы и хоста, не `//`, без `\` и управляющих символов, не
 * `/auth` и не `/api`; иначе null (вход ведет в кабинет, как раньше). Открытый
 * редирект на чужой домен невозможен: результат — всегда относительный путь.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^\/(auth|api)(\/|\?|$)/.test(raw)) return null;
  try {
    const base = "http://next.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** Путь возврата живет рядом со state-cookie (тот же срок, те же флаги) и гасится вместе с ней. */
export function oauthNextCookieHeader(names: CookieNames, next: string): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.oauthState}_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`;
}

export function clearOAuthNextCookieHeader(names: CookieNames): string {
  const secure = names.secure ? "; Secure" : "";
  return `${names.oauthState}_next=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

/** Путь возврата из cookie (повторная проверка — cookie мог подменить сам браузер). */
export function oauthNextFromCookie(cookieValue: string | undefined): string | null {
  if (typeof cookieValue !== "string" || cookieValue === "") return null;
  try {
    return safeNextPath(decodeURIComponent(cookieValue));
  } catch {
    return null;
  }
}

export function oauthStateFromCookie(cookieValue: string | undefined): string | null {
  return typeof cookieValue === "string" && cookieValue.length > 8 ? cookieValue : null;
}

/** Хосты-петля одного локального сервера; у каждого своя банка кук. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * Вход с петлевого алиаса redirect_uri (23.09, репорт Алексея): state-cookie
 * ставится на хост, откуда браузер пришёл на /auth/ya, а Яндекс возвращает
 * его на хост redirect_uri — банки кук разные, cookie не едет, первая попытка
 * входа падает с auth_error=state («вторая срабатывает»: после неудачи браузер
 * уже на нужном хосте). Переезд на канонический origin ДО старта OAuth держит
 * весь поток в одной банке. null — переезд не нужен или это не алиас (чужой
 * хост или другой порт: такое не перенаправляем).
 */
export function loopbackOriginRedirect(url: URL, canonicalOrigin: string): string | null {
  let canonical: URL;
  try {
    canonical = new URL(canonicalOrigin);
  } catch {
    return null;
  }
  if (canonical.host === url.host) return null;
  if (url.port !== canonical.port) return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname) || !LOOPBACK_HOSTNAMES.has(canonical.hostname)) return null;
  return canonical.origin + url.pathname + url.search;
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
