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
  createSession,
  getSessionUser,
  makeOAuthState,
  oauthStateCookieHeader,
  parseCookies,
  revokeSession,
  signToken,
  upsertUser,
  verifySigned,
} from "../src/auth/session";
import { decryptPat, deletePat, encryptPat, getPat, patMeta, storePat } from "../src/auth/pat";
import { effectiveCloneLimits, parseUserScanSettings, readUserScanSettings, writeUserScanSettings } from "../src/auth/settings";
import { DEFAULT_SCAN } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "rh-auth-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = "test-app-secret-0123456789";

describe("Я ID OAuth: URL и обмен кода", () => {
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
      expect(res.profile).toEqual({ yaId: "12345", login: "alice" });
      expect(JSON.stringify(res)).not.toContain("ya-token");
    }
  });

  test("exchangeCode: invalid_grant → ошибка текстом платформы", async () => {
    const res = await exchangeCode(creds, "bad", {
      postForm: async () => ({ status: 400, json: { error: "invalid_grant", error_description: "code expired" } }),
      getJson: async () => ({ status: 0, json: null }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("code expired");
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
    if (!res.ok) expect(res.error).toContain("не сконфигурировано");
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
    expect(oauthStateCookieHeader(state)).toContain(`${OAUTH_STATE_COOKIE}=${state}`);
    expect(oauthStateCookieHeader(state)).toContain("HttpOnly");
    const cookies = parseCookies(`a=1; ${SESSION_COOKIE}=abc.def; bad`);
    expect(cookies[SESSION_COOKIE]).toBe("abc.def");
    expect(parseCookies(null)).toEqual({});
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

describe("настройки: третий слой конфига", () => {
  test("parseUserScanSettings: валидация полей", () => {
    expect(parseUserScanSettings({ useDefaults: true, maxBytes: null, timeoutMs: null }).ok).toBe(true);
    expect(parseUserScanSettings({ useDefaults: false, maxBytes: 3_000_000_000, timeoutMs: 900_000 }).ok).toBe(true);
    expect(parseUserScanSettings(null).ok).toBe(false);
    expect(parseUserScanSettings({ useDefaults: "да", maxBytes: null, timeoutMs: null }).ok).toBe(false);
    expect(parseUserScanSettings({ useDefaults: true, maxBytes: -5, timeoutMs: null }).ok).toBe(false);
    expect(parseUserScanSettings({ useDefaults: true, maxBytes: "1ГБ", timeoutMs: null }).ok).toBe(false);
  });

  test("effectiveCloneLimits: тогл-дефолт / значения / «снять лимит»", () => {
    expect(effectiveCloneLimits(DEFAULT_SCAN, { useDefaults: true, maxBytes: 1, timeoutMs: 1 })).toEqual({
      ...DEFAULT_SCAN.clone,
      degrade: DEFAULT_SCAN.degrade,
    });
    const custom = effectiveCloneLimits(DEFAULT_SCAN, { useDefaults: false, maxBytes: 3_000_000_000, timeoutMs: 900_000 });
    expect(custom.maxBytes).toBe(3_000_000_000);
    expect(custom.timeoutMs).toBe(900_000);
    expect(custom.degrade).toEqual(DEFAULT_SCAN.degrade); // деградация — серверное, не юзерское
    const unlimited = effectiveCloneLimits(DEFAULT_SCAN, { useDefaults: false, maxBytes: null, timeoutMs: null });
    expect(unlimited.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(unlimited.timeoutMs).toBeGreaterThan(DEFAULT_SCAN.degrade.timeoutMs);
  });

  test("write/read roundtrip; мусор в БД → дефолт (fail-soft)", () => {
    const userId = upsertUser(db, "ya-4", "dave");
    expect(readUserScanSettings(db, userId)).toEqual({ useDefaults: true, maxBytes: null, timeoutMs: null });
    writeUserScanSettings(db, userId, { useDefaults: false, maxBytes: 1e10, timeoutMs: null });
    expect(readUserScanSettings(db, userId)).toEqual({ useDefaults: false, maxBytes: 1e10, timeoutMs: null });
    db.query("UPDATE user_settings SET scan = 'мусор' WHERE user_id = ?").run(userId);
    expect(readUserScanSettings(db, userId).useDefaults).toBe(true);
  });
});
