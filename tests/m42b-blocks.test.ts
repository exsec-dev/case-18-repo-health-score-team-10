// m42b-blocks.test.ts — блочные тесты В4.2b Б2 (Ф2.8): HKDF-ключи из
// APP_SECRET (контексты "pat"/"session"), шифротекст PAT с префиксом `v2:`,
// идемпотентная перешифровка в openDb на старом шифротексте, patReadable,
// разлогин сменой HMAC-ключа, сегменты слага из одних точек → 400,
// минутный лимит /api/me/repos, encodeURIComponent в исходящих путях
// REST/AppSec клиентов. Сети нет: серверы — временный DATA_DIR, адреса
// API на локальный мок; секреты ≥ 32 символов.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, getSessionUser, upsertUser } from "../src/auth/session";
import { decryptPat, encryptPat, getPat, patMeta, patReadable, reencryptPat, storePat } from "../src/auth/pat";
import { fetchResource } from "../src/collectors/rest";
import { collectAppsec } from "../src/collectors/appsec";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "m42b-blocks-test-secret-0123456789abcdef";
const ROOT = mkdtempSync(join(tmpdir(), "rh-m42b-blocks-"));

/** Шифрование по прежней схеме (голый sha256) — строит «старый шифротекст» для теста перешифровки. */
function legacyEncrypt(appSecret: string, pat: string): string {
  const key = createHash("sha256").update(appSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(pat, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

function tempConfig(dataDirName: string) {
  const base = loadConfig();
  return { ...base, dataDir: join(ROOT, dataDirName), auth: { ...base.auth, appSecret: SECRET } };
}

// ---------------------------------------------------------------------------
// Ключи Ф2.8: PAT на HKDF("…","pat"), префикс v2:, чтение старого формата.
// ---------------------------------------------------------------------------

describe("Ф2.8: ключи PAT (HKDF) и префикс v2:", () => {
  test("encryptPat даёт v2:-шифротекст; decryptPat — раундтрип", () => {
    const enc = encryptPat(SECRET, "sc-pat-roundtrip");
    expect(enc.startsWith("v2:")).toBe(true);
    expect(decryptPat(SECRET, enc)).toBe("sc-pat-roundtrip");
  });

  test("старый шифротекст (sha256, без префикса) читается прежним ключом", () => {
    const legacy = legacyEncrypt(SECRET, "sc-pat-legacy-value");
    expect(legacy.startsWith("v2:")).toBe(false);
    expect(decryptPat(SECRET, legacy)).toBe("sc-pat-legacy-value");
  });

  test("перешифровка: reencryptPat возвращает v2:-строку, чужой ключ → null", () => {
    const legacy = legacyEncrypt(SECRET, "sc-pat-reencrypt");
    const next = reencryptPat(SECRET, legacy);
    expect(next?.startsWith("v2:")).toBe(true);
    expect(decryptPat(SECRET, next!)).toBe("sc-pat-reencrypt");
    expect(reencryptPat("other-secret-0123456789abcdef000000", legacy)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Перешифровка в openDb: идемпотентно, на старом шифротексте; нечитаемое
// не трогается.
// ---------------------------------------------------------------------------

describe("Ф2.8: openDb перешифровывает legacy-PAT", () => {
  test("legacy-строка → v2: после открытия; повторное открытие ничего не меняет", () => {
    const cfg = tempConfig("reencrypt");
    const warm = openDb(cfg); // создаёт таблицы
    const userId = upsertUser(warm, "ya-re", "re");
    warm
      .query("INSERT INTO user_tokens (user_id, pat_enc, checked_at, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, legacyEncrypt(SECRET, "sc-pat-migrate-me"), "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
    warm.close();

    const db = openDb(cfg); // проход перешифровки
    const stored = db.query("SELECT pat_enc FROM user_tokens WHERE user_id = ?").get(userId) as { pat_enc: string };
    expect(stored.pat_enc.startsWith("v2:")).toBe(true);
    expect(getPat(db, SECRET, userId)).toBe("sc-pat-migrate-me");
    const afterFirst = stored.pat_enc;
    db.close();

    const again = openDb(cfg); // идемпотентность
    const storedAgain = again.query("SELECT pat_enc FROM user_tokens WHERE user_id = ?").get(userId) as { pat_enc: string };
    expect(storedAgain.pat_enc).toBe(afterFirst);
    expect(getPat(again, SECRET, userId)).toBe("sc-pat-migrate-me");
    again.close();
  });

  test("нечитаемая строка (секрет сменился) не трогается", () => {
    const cfg = tempConfig("unreadable");
    const warm = openDb(cfg);
    const userId = upsertUser(warm, "ya-un", "un");
    warm
      .query("INSERT INTO user_tokens (user_id, pat_enc, checked_at, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, legacyEncrypt("another-secret-0123456789abcdef000000", "sc-pat-lost"), "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
    warm.close();

    const db = openDb(cfg);
    const stored = db.query("SELECT pat_enc FROM user_tokens WHERE user_id = ?").get(userId) as { pat_enc: string };
    expect(stored.pat_enc.startsWith("v2:")).toBe(false);
    expect(getPat(db, SECRET, userId)).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// patReadable + смена HMAC-ключа (разлогин всех — свойство, не дефект).
// ---------------------------------------------------------------------------

describe("Ф2.8: patReadable и ротация APP_SECRET", () => {
  test("читаемый PAT → true; после ротации секрета строка есть, но читаемости нет", () => {
    const cfg = tempConfig("readable");
    const db = openDb(cfg);
    const userId = upsertUser(db, "ya-pr", "pr");
    storePat(db, SECRET, userId, "sc-pat-readable");
    expect(patMeta(db, userId)).toMatchObject({ hasPat: true });
    expect(patReadable(db, SECRET, userId)).toBe(true);
    expect(patReadable(db, "rotated-secret-0123456789abcdef0000", userId)).toBe(false);
    db.close();
  });

  test("смена секрета инвалидирует подписи сессий (разлогинивает всех)", () => {
    const cfg = tempConfig("rotate-session");
    const db = openDb(cfg);
    const userId = upsertUser(db, "ya-rot", "rot");
    const cookie = createSession(db, SECRET, userId);
    expect(getSessionUser(db, "rotated-secret-0123456789abcdef0000", cookie)).toBeNull();
    expect(getSessionUser(db, SECRET, cookie)?.userId).toBe(userId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP-контракт: сегменты из одних точек → 400; лимит /api/me/repos → 429.
// ---------------------------------------------------------------------------

const mock = startMockApi(() => null);

let server: SpawnedServer | null = null;
let sessionCookie = "";

beforeAll(async () => {
  const base = loadConfig();
  const db = openDb({ ...base, dataDir: join(ROOT, "http") });
  sessionCookie = createSession(db, SECRET, upsertUser(db, "ya-http", "http"));
  db.close();
  server = await spawnServer({
    dataDir: join(ROOT, "http"),
    mock,
    appSecret: SECRET,
    env: { QUEUE_MY_REPOS_PER_MINUTE: "2", QUEUE_USER_SCANS_PER_HOUR: "100" },
  });
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY: каталог подберёт ОС */
  }
});

const at = (path: string) => `${server!.base}${path}`;
const asSession = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: `rh_session=${sessionCookie}` },
});

describe("Ф2.8: сегменты слага из одних точек → 400", () => {
  test("карточка: /api/repos/.../... → 400 bad_query (charset пропускал)", async () => {
    const res = await fetch(at("/api/repos/.../..."), {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_query");
  });

  test("избранное: PUT /api/me/favorites/.../... → 400 bad_query", async () => {
    const res = await fetch(at("/api/me/favorites/.../..."), asSession({ method: "PUT" }));
    expect(res.status).toBe(400);
  });
});

describe("Ф2.8: лимит /api/me/repos (QUEUE_MY_REPOS_PER_MINUTE=2)", () => {
  test("третье чтение в минуту → 429 rate_limited", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(at("/api/me/repos"), asSession());
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const body = (await (await fetch(at("/api/me/repos"), asSession())).json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------
// Исходящие пути: сегменты слага кодируются у REST- и AppSec-клиентов.
// ---------------------------------------------------------------------------

function pathCapturingClient(response: ScResponse, paths: string[]): ScClient {
  return {
    async get(path: string): Promise<ScResponse> {
      paths.push(path);
      return response;
    },
    requestCount: () => paths.length,
  };
}

describe("Ф2.8: encodeURIComponent в исходящих путях", () => {
  test("fetchResource кодирует сегменты слага и issue", async () => {
    const paths: string[] = [];
    const json = { id: "gid-1", visibility: "public" };
    await fetchResource(pathCapturingClient({ status: 200, json, bodyText: JSON.stringify(json) }, paths), "or g/re.po", "repo");
    expect(paths[0]).toBe("/repos/or%20g/re.po");
    await fetchResource(
      pathCapturingClient({ status: 200, json: { comments: [] }, bodyText: "{}" }, paths),
      "o/r",
      "issue-comments",
      { issueSlug: "a b#c" },
    );
    expect(paths[1]).toBe("/repos/o/r/issues/a%20b%23c/comments?sort_by=created_at&page_size=50");
  });

  test("collectAppsec кодирует слаг в repo-GET (gitRepo — параметром)", async () => {
    const paths: string[] = [];
    const rest = pathCapturingClient({ status: 200, json: { id: "gid-9" }, bodyText: "" }, paths);
    const appsec = {
      async get(path: string, params: Record<string, string>) {
        void path;
        void params;
        return { status: 404, json: null };
      },
      requestCount: () => 0,
    };
    await collectAppsec(rest, appsec, "a b/c d", { now: new Date("2026-09-19T12:00:00Z") });
    expect(paths[0]).toBe("/repos/a%20b/c%20d");
  });
});
