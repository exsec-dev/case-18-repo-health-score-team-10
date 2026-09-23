// auth.test.ts — В4/Б1: Я ID OAuth (buildAuthUrl/exchangeCode на фейк
// HTTP), сессии (подпись, TTL, отзыв, upsert users), PAT (AES-256-GCM
// раундтрип, чужой ключ, повреждение, store/get/delete), настройки
// (валидация, третий слой конфига). Сети нет: все шовы инъектятся.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { buildAuthUrl, exchangeCode, type YaHttp } from "../src/auth/ya";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  cookieNames,
  createSession,
  getSessionUser,
  loopbackOriginRedirect,
  makeOAuthState,
  oauthStateCookieHeader,
  parseCookies,
  revokeSession,
  signToken,
  upsertUser,
  verifySigned,
} from "../src/auth/session";
import { decryptPat, deletePat, encryptPat, getPat, patMeta, storePat } from "../src/auth/pat";

const dir = mkdtempSync(join(tmpdir(), "rh-auth-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = "test-app-secret-0123456789abcdef";

describe("Я ID OAuth: URL и обмен кода", () => {
  test("петлевой алиас redirect_uri (23.09): переезд на канонический origin; чужой хост и другой порт — не алиас", () => {
    expect(loopbackOriginRedirect(new URL("http://127.0.0.1:8418/me?auth_error=state"), "http://localhost:8418")).toBe(
      "http://localhost:8418/me?auth_error=state",
    );
    expect(loopbackOriginRedirect(new URL("http://localhost:8418/auth/ya"), "http://127.0.0.1:8418")).toBe(
      "http://127.0.0.1:8418/auth/ya",
    );
    // канонический хост уже открыт — переезда нет
    expect(loopbackOriginRedirect(new URL("http://localhost:8418/auth/ya"), "http://localhost:8418")).toBeNull();
    // чужой хост (LAN, стенд) и другой порт сервером не канонизируются
    expect(loopbackOriginRedirect(new URL("http://192.168.1.5:8418/auth/ya"), "http://localhost:8418")).toBeNull();
    expect(loopbackOriginRedirect(new URL("http://127.0.0.1:9999/auth/ya"), "http://localhost:8418")).toBeNull();
    // мусор в конфиге — null, а не исключение
    expect(loopbackOriginRedirect(new URL("http://127.0.0.1:8418/auth/ya"), "не URL")).toBeNull();
  });
  const creds = { clientId: "ya-client", clientSecret: "ya-secret", redirect: "http://localhost:8418/auth/ya/callback" };

  test("buildAuthUrl: authorize + обязательные параметры + state", () => {
    const url = new URL(buildAuthUrl(creds, "st4te"));
    expect(url.origin + url.pathname).toBe("https://oauth.yandex.ru/authorize");
    expect(url.searchParams.get("client_id")).toBe("ya-client");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(creds.redirect);
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  test("buildAuthUrl без clientId — честная ошибка (fail-soft конфига)", () => {
    expect(() => buildAuthUrl({ ...creds, clientId: null }, "s")).toThrow(/YA_CLIENT_ID/);
  });

  const httpOk: YaHttp = {
    postForm: async () => ({ status: 200, json: { access_token: "ya-token" } }),
    getJson: async () => ({ status: 200, json: { id: 12345, login: "alice" } }),
  };

  test("exchangeCode: успех → {yaId, login}, токен наружу не едет", async () => {
    const res = await exchangeCode(creds, "code", httpOk);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile).toEqual({ yaId: "12345", login: "alice", displayName: null, avatarId: null });
      expect(JSON.stringify(res)).not.toContain("ya-token");
    }
  });

  test("exchangeCode: имя и портрет из /info (права login:info, login:avatar); пустой портрет — null", async () => {
    const withProfile = (json: Record<string, unknown>): YaHttp => ({ ...httpOk, getJson: async () => ({ status: 200, json }) });
    const full = await exchangeCode(creds, "code", withProfile({ id: 1, login: "kate", display_name: "kate", real_name: "Екатерина Прожирко", default_avatar_id: "123/abc", is_avatar_empty: false }));
    expect(full.ok && full.profile).toEqual({ yaId: "1", login: "kate", displayName: "Екатерина Прожирко", avatarId: "123/abc" });
    const parts = await exchangeCode(creds, "code", withProfile({ id: 1, login: "kate", display_name: "kate", first_name: "Екатерина", last_name: "Прожирко" }));
    expect(parts.ok && parts.profile.displayName).toBe("Екатерина Прожирко");
    const empty = await exchangeCode(creds, "code", withProfile({ id: 1, login: "kate", real_name: "Екатерина", default_avatar_id: "0/0-0", is_avatar_empty: true }));
    expect(empty.ok && empty.profile).toEqual({ yaId: "1", login: "kate", displayName: "Екатерина", avatarId: null });
  });

  // ПЕРЕВОРОТ (В4.8.5, К8.5.4, С1-6): английский текст провайдера наружу не идет — фраза языком продукта
  test("exchangeCode: invalid_grant → ошибка языком продукта, без текста провайдера", async () => {
    const res = await exchangeCode(creds, "bad", {
      postForm: async () => ({ status: 400, json: { error: "invalid_grant", error_description: "code expired" } }),
      getJson: async () => ({ status: 0, json: null }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect({ text: res.error, provider: res.error.includes("code expired") }).toEqual({ text: "Я ID не подтвердил вход – попробуйте войти еще раз", provider: false }); // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): В-11 «Я ID»
  });

  test("exchangeCode: /info неожиданной формы → ошибка, не падение", async () => {
    const res = await exchangeCode(creds, "code", {
      postForm: async () => ({ status: 200, json: { access_token: "t" } }),
      getJson: async () => ({ status: 200, json: { unexpected: true } }),
    });
    expect(res.ok).toBe(false);
  });

  test("exchangeCode без секретов в конфиге — честный отказ", async () => {
    const res = await exchangeCode({ ...creds, clientSecret: null }, "c", httpOk);
    expect(res.ok).toBe(false);
    // ПЕРЕВОРОТ (В4.8.5, К8.5.4): текст языком продукта, без имен переменных окружения — было «не сконфигурировано (YA_CLIENT_ID/SECRET)»
    if (!res.ok) expect(res.error).toBe("вход через Я ID на сервере не настроен");
  });
});

describe("сессии: подпись, TTL, отзыв", () => {
  test("signToken/verifySigned: раундтрип, тампер, форма", () => {
    const signed = signToken(SECRET, "tok-en");
    expect(verifySigned(SECRET, signed)).toBe("tok-en");
    expect(verifySigned(SECRET, signed.slice(0, -2) + "xx")).toBeNull();
    expect(verifySigned(SECRET, "no-dot")).toBeNull();
    expect(verifySigned("другой-секрет", signed)).toBeNull();
  });

  test("upsertUser + createSession + getSessionUser; logout убивает", () => {
    const userId = upsertUser(db, "ya-1", "alice");
    expect(upsertUser(db, "ya-1", "alice-new")).toBe(userId); // idempotent
    const cookie = createSession(db, SECRET, userId);
    expect(getSessionUser(db, SECRET, cookie)?.login).toBe("alice-new");
    expect(getSessionUser(db, "не-тот-секрет", cookie)).toBeNull();
    revokeSession(db, SECRET, cookie);
    expect(getSessionUser(db, SECRET, cookie)).toBeNull();
  });

  test("истёкшая сессия = аноним (и строка чистится)", () => {
    const userId = upsertUser(db, "ya-2", "bob");
    const past = new Date(Date.now() - 8 * 24 * 3600_000);
    const cookie = createSession(db, SECRET, userId, past);
    expect(getSessionUser(db, SECRET, cookie)).toBeNull();
    expect((db.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c).toBe(0);
  });

  test("cookie-хелперы: parseCookies, имена, state", () => {
    const state = makeOAuthState();
    const names = cookieNames({ redirect: "http://localhost:8418/auth/ya/callback" });
    expect(oauthStateCookieHeader(names, state)).toContain(`${OAUTH_STATE_COOKIE}=${state}`);
    expect(oauthStateCookieHeader(names, state)).toContain("HttpOnly");
    const cookies = parseCookies(`a=1; ${SESSION_COOKIE}=abc.def; bad`);
    expect(cookies[SESSION_COOKIE]).toBe("abc.def");
    expect(parseCookies(null)).toEqual({});
  });

  test("Ф2.7: cookieNames — http-redirect прежние имена без Secure, https — __Host- и Secure", () => {
    const http = cookieNames({ redirect: "http://localhost:8418/auth/ya/callback" });
    expect(http).toEqual({ session: SESSION_COOKIE, oauthState: OAUTH_STATE_COOKIE, secure: false });
    const https = cookieNames({ redirect: "https://rh-stand.example/auth/ya/callback" });
    expect(https).toEqual({ session: "__Host-rh_session", oauthState: "__Host-rh_oauth_state", secure: true });
    // __Host- требует Secure, Path=/ и отсутствие Domain — заголовок обязан это держать
    const header = oauthStateCookieHeader(https, "s");
    expect(header.startsWith("__Host-rh_oauth_state=s;")).toBe(true);
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain=");
  });
});

describe("PAT: AES-256-GCM хранение", () => {
  test("раундтрип; чужой ключ и повреждение → null (не исключение)", () => {
    const enc = encryptPat(SECRET, "sc-pat-value");
    expect(enc).not.toContain("sc-pat-value");
    expect(decryptPat(SECRET, enc)).toBe("sc-pat-value");
    expect(decryptPat("другой-секрет", enc)).toBeNull();
    expect(decryptPat(SECRET, enc.slice(0, -4) + "AAAA")).toBeNull();
    expect(decryptPat(SECRET, "короткий-мусор")).toBeNull();
  });

  test("storePat/getPat/deletePat/patMeta (замена токена не накапливает)", () => {
    const userId = upsertUser(db, "ya-3", "carol");
    expect(getPat(db, SECRET, userId)).toBeNull();
    expect(patMeta(db, userId)).toEqual({ hasPat: false });
    storePat(db, SECRET, userId, "first-pat");
    expect(getPat(db, SECRET, userId)).toBe("first-pat");
    storePat(db, SECRET, userId, "second-pat");
    expect(getPat(db, SECRET, userId)).toBe("second-pat");
    expect((db.query("SELECT COUNT(*) AS c FROM user_tokens").get() as { c: number }).c).toBe(1);
    expect(patMeta(db, userId).hasPat).toBe(true);
    deletePat(db, userId);
    expect(getPat(db, SECRET, userId)).toBeNull();
    // БД не хранит PAT открытым текстом
    expect(JSON.stringify(db.query("SELECT pat_enc FROM user_tokens").all())).not.toContain("second-pat");
  });
});

