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
import { renderRepoReport } from "../src/report/markdown";
import { getMeta, getRepoCard } from "../src/api/repos";
import { addFavoriteCapped, listMyRepos, parseFavoriteInput, seedFavoritesFromNamespace } from "../src/api/me";
import { enqueueScan } from "../src/jobs/scheduler";
import { DEFAULT_SCAN, defaultLeaseMs } from "../src/config";
import { authErrorText } from "../src/web/format";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";
import { readFileSync } from "node:fs";

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
let sessionCookie2 = "";

beforeAll(async () => {
  const base = loadConfig();
  const db = openDb({ ...base, dataDir: join(ROOT, "http") });
  sessionCookie = createSession(db, SECRET, upsertUser(db, "ya-http", "http"));
  sessionCookie2 = createSession(db, SECRET, upsertUser(db, "ya-http2", "http2"));
  db.close();
  server = await spawnServer({
    dataDir: join(ROOT, "http"),
    mock,
    appSecret: SECRET,
    env: { QUEUE_MY_REPOS_PER_MINUTE: "2", QUEUE_USER_SCANS_PER_HOUR: "100", QUEUE_FAVORITES_MAX: "3" },
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
const asSession2 = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie: `rh_session=${sessionCookie2}` },
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

// ---------------------------------------------------------------------------
// Блок Б3 (Ф2.9-остаток): маркер codeEmpty на карточке и в MD; текст
// auth_error для /me.
// ---------------------------------------------------------------------------

describe("Б3 (Ф2.9): маркер codeEmpty виден на карточке и в MD", () => {
  test("getRepoCard несёт markers.codeEmpty, MD объясняет «проекта нет»", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "m42b", repo: "empty" });
      const scanId = seedScan(t, repoId, { facts: cardFacts() });
      seedScore(t, repoId, scanId, { total: 0 });
      t.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(scanId);
      const card = getRepoCard(t.db, "m42b", "empty", {});
      expect(card?.markers.codeEmpty).toBe(true);
      const md = renderRepoReport(card!);
      expect(md).toContain("В репозитории нет кода");
      expect(md).toContain("не отсутствие оценки");
    } finally {
      t.close();
    }
  });

  test("MD: статус и триггер скана — словами (один язык), без EN-жаргона", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "m42b", repo: "words" });
      const scanId = seedScan(t, repoId, { facts: cardFacts(), trigger: "periodic" });
      seedScore(t, repoId, scanId, { total: 60 });
      const md = renderRepoReport(getRepoCard(t.db, "m42b", "words", {})!);
      expect(md).toContain("статус полный");
      expect(md).toMatch(/запуск (по расписанию|вручную|проба)/);
      expect(md).not.toContain("(stale)");
    } finally {
      t.close();
    }
  });
});

describe("Б3 (Ф2.9): текст auth_error для /me", () => {
  // ПЕРЕВОРОТ (В4.8.5, К8.5.4, С1-6): коды наружу не идут — «(state)» и
  // «Вход не удался: access_denied» были кодами в тексте; фразы остаются
  // человеческими, текст провайдера (не код) — по-прежнему в «Вход не удался: …»
  test("известные коды — человеческие фразы без кодов, прочий текст провайдера — как был", () => {
    expect(authErrorText("state")).not.toContain("state");
    expect(authErrorText("state")).toContain("начните вход заново");
    // Б5 В4.6 (У31): «ещё» → «еще» в текстах интерфейса
    expect(authErrorText("no_code")).toContain("еще раз");
    expect(authErrorText("access_denied")).toBe("Вход отменен на странице Яндекс ID – чтобы войти, подтвердите доступ.");
    expect(authErrorText("Яндекс ID не ответил – попробуйте войти еще раз")).toBe("Вход не удался: Яндекс ID не ответил – попробуйте войти еще раз");
  });
});

// ---------------------------------------------------------------------------
// Блок Б4: Ф2.15 (статус живой job зрителя в карточке, без позиции) +
// Ф2.17 (признак «работа запланирована» в кабинете) + queue.leaseMs в мете.
// ---------------------------------------------------------------------------

describe("Б4 (Ф2.15): карточка несёт только статус живой job зрителя", () => {
  test("queued-заявка → job {status:'queued'}; без зрителя → null; лишних полей нет", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "m42b", repo: "jobby" });
      seedScan(t, repoId, { facts: cardFacts() });
      seedScore(t, repoId, seedScan(t, repoId, { facts: cardFacts() }), { total: 60 });
      t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)").run("ya-jobby", "jobby", "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
      const uid = (t.db.query("SELECT id FROM users WHERE ya_id = 'ya-jobby'").get() as { id: number }).id;
      enqueueScan(t.db, repoId, { userId: uid, triggerKind: "user" });
      const withViewer = getRepoCard(t.db, "m42b", "jobby", { viewerUserId: uid });
      // ПЕРЕВОРОТ (В4.8.5, К8.5.2b): карточка несёт серверный признак «затянулось» — `stalled`;
      // инвариант Ф2.15 (ни позиции в очереди, ни id) прежний
      expect(withViewer?.job).toEqual({ status: "queued", stalled: false });
      expect(Object.keys(withViewer?.job ?? {})).toEqual(["status", "stalled"]);
      const anon = getRepoCard(t.db, "m42b", "jobby", {});
      expect(anon?.job).toBeNull();
    } finally {
      t.close();
    }
  });

  test("running-заявка тоже видна; репо без скана и с job — job в ранней ветке ответа", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "m42b", repo: "first-run" });
      t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)").run("ya-fr", "fr", "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
      const uid = (t.db.query("SELECT id FROM users WHERE ya_id = 'ya-fr'").get() as { id: number }).id;
      const jobId = enqueueScan(t.db, repoId, { userId: uid, triggerKind: "user" });
      t.db.query("UPDATE jobs SET status = 'running', claimed_at = ? WHERE id = ?").run("2026-09-19T00:00:00Z", jobId);
      const card = getRepoCard(t.db, "m42b", "first-run", { viewerUserId: uid });
      expect({ job: card?.job, score: card?.score, scan: card?.scan }).toEqual({ job: { status: "running", stalled: true }, score: null, scan: null }); // ПЕРЕВОРОТ (К8.5.2b): running без лиза не держит ни один живой воркер — «затянулось»
    } finally {
      t.close();
    }
  });

  test("UI-запрет: ни один текст панели/карточки не называет позицию («N-й», «перед вами»)", () => {
    for (const file of ["MePage.tsx", "RepoPage.tsx", "Rating.tsx"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
      expect({ file, hasPosition: src.includes("перед вами") || src.includes("-й)") }).toEqual({ file, hasPosition: false });
    }
  });
});

describe("Б4 (Ф2.17): кабинет показывает «работа запланирована» без раскрытия меты", () => {
  test("посторонний с заявкой на чужой приватный репо: planned=true, ни названия, ни языка, ни времени, ни Score", async () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "owner", repo: "secret", title: "Секретный проект", language: "Go" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
      t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)").run("ya-stranger2", "stranger2", "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
      const uid = (t.db.query("SELECT id FROM users WHERE ya_id = 'ya-stranger2'").get() as { id: number }).id;
      t.db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, ?, ?, ?)").run(uid, "owner", "secret", "2026-09-19T00:00:00Z");
      enqueueScan(t.db, repoId, { userId: uid, triggerKind: "user" });
      const out = await listMyRepos(t.db, uid);
      const entry = out.entries.find((e) => e.org === "owner" && e.repo === "secret");
      expect(entry?.planned).toBe(true);
      expect({ title: entry?.title, language: entry?.language, lastScanAt: entry?.lastScanAt, healthcraftIndex: entry?.healthcraftIndex }).toEqual({
        title: null,
        language: null,
        lastScanAt: null,
        healthcraftIndex: null,
      });
    } finally {
      t.close();
    }
  });

  test("после завершённого own-скана признак снимается; чужая job признак не ставит", async () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "owner", repo: "done" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
      t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)").run("ya-dl", "dl", "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
      t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, ?)").run("ya-other", "other", "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z");
      const uid = (t.db.query("SELECT id FROM users WHERE ya_id = 'ya-dl'").get() as { id: number }).id;
      const otherId = (t.db.query("SELECT id FROM users WHERE ya_id = 'ya-other'").get() as { id: number }).id;
      t.db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, ?, ?, ?)").run(uid, "owner", "done", "2026-09-19T00:00:00Z");
      // чужая живая job → признака нет
      enqueueScan(t.db, repoId, { userId: otherId, triggerKind: "user" });
      expect((await listMyRepos(t.db, uid)).entries.find((e) => e.repo === "done")?.planned).toBe(false);
      // свой завершённый own-скан → признака нет даже при живой job
      seedScan(t, repoId, { facts: cardFacts(), userId: uid, finishedAt: "2026-09-19T01:00:00Z", status: "ok" });
      enqueueScan(t.db, repoId, { userId: uid, triggerKind: "user" });
      expect((await listMyRepos(t.db, uid)).entries.find((e) => e.repo === "done")?.planned).toBe(false);
    } finally {
      t.close();
    }
  });
});

describe("Б4 (Ф2.9): /api/meta дополняется queue.leaseMs", () => {
  test("leaseMs из конфига планировщика; без аргумента — дефолт пола", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      expect(getMeta(t.db, { leaseMs: 12_345 }).queue.leaseMs).toBe(12_345);
      expect(getMeta(t.db).queue.leaseMs).toBe(defaultLeaseMs(DEFAULT_SCAN));
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Блок Б5: Ф2.20 (ручной ввод org/repo|URL, favorites-only список, посев
// избранного при сохранении PAT) и Ф2.21 (предел избранного, идемпотентный
// повтор).
// ---------------------------------------------------------------------------

describe("Б5 (Ф2.20): parseFavoriteInput", () => {
  test("org/repo принимается как есть; лишние сегменты — отказ", () => {
    expect(parseFavoriteInput("sourcecraft/repo-health")).toEqual({ org: "sourcecraft", repo: "repo-health" });
    expect(parseFavoriteInput("  sourcecraft/repo-health  ")).toEqual({ org: "sourcecraft", repo: "repo-health" });
    expect(parseFavoriteInput("a/b/c")).toBeNull();
    expect(parseFavoriteInput("onlyname")).toBeNull();
  });

  test("URL: первые два сегмента пути, хвосты/query/fragment отбрасываются, домен не валидируется", () => {
    expect(parseFavoriteInput("https://sourcecraft.dev/alpha/beta?rev=main")).toEqual({ org: "alpha", repo: "beta" });
    expect(parseFavoriteInput("http://git.example/alpha/beta/tree/main#readme")).toEqual({ org: "alpha", repo: "beta" });
    expect(parseFavoriteInput("https://whatever.host/alpha/beta")).toEqual({ org: "alpha", repo: "beta" });
    expect(parseFavoriteInput("https://sourcecraft.dev/alpha")).toBeNull();
  });

  test("пустые и точечные сегменты → отказ (400 на маршруте)", () => {
    expect(parseFavoriteInput("../..")).toBeNull();
    expect(parseFavoriteInput("https://x/../../secret")).toBeNull();
    expect(parseFavoriteInput("org/..")).toBeNull();
    expect(parseFavoriteInput("./repo")).toBeNull();
    expect(parseFavoriteInput("")).toBeNull();
    expect(parseFavoriteInput("bad slug/name")).toBeNull();
  });
});

describe("Б5 (Ф2.21): addFavoriteCapped — предел, идемпотентный повтор", () => {
  test("сверх предела → limit; существующий → exists и лимит не расходует", () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const userId = upsertUser(t.db, "ya-cap", "cap");
      for (let i = 1; i <= 3; i++) {
        expect(addFavoriteCapped(t.db, userId, "o", `r${i}`, 3)).toBe("added");
      }
      expect(addFavoriteCapped(t.db, userId, "o", "r4", 3)).toBe("limit");
      // повтор существующего: лимит не расходует
      expect(addFavoriteCapped(t.db, userId, "o", "r1", 3)).toBe("exists");
      const count = (t.db.query("SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?").get(userId) as { c: number }).c;
      expect(count).toBe(3);
    } finally {
      t.close();
    }
  });
});

/** Фейковый клиент посева: отдаёт заготовленные страницы, считает запросы. */
function seedClient(pages: { status: number; json: unknown }[], paths: string[]): ScClient {
  let i = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      paths.push(path);
      const p = pages[Math.min(i, pages.length - 1)]!;
      i++;
      return { status: p.status, json: p.json, bodyText: JSON.stringify(p.json) };
    },
    requestCount: () => i,
  };
}

const seedPage = (slugs: string[], next?: string): { status: number; json: unknown } => ({
  status: 200,
  json: {
    repositories: slugs.map((s) => ({ organization: { slug: "seeder" }, slug: s })),
    ...(next ? { next_page_token: next } : {}),
  },
});

describe("Б5 (Ф2.20): seedFavoritesFromNamespace", () => {
  test("две страницы → ok/3; существующие не считаются ни в added, ни в лимите", async () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const userId = upsertUser(t.db, "ya-seed", "seed");
      addFavoriteCapped(t.db, userId, "seeder", "already", 500);
      const paths: string[] = [];
      const out = await seedFavoritesFromNamespace(
        t.db,
        seedClient([seedPage(["already", "b"], "p2"), seedPage(["c"])], paths),
        "seeder",
        userId,
        500,
      );
      expect(out).toEqual({ status: "ok", added: 2 });
      expect(new URL(`http://x${paths[0]}`).searchParams.get("page_size")).toBe("100");
      expect(new URL(`http://x${paths[1]}`).searchParams.get("page_token")).toBe("p2");
    } finally {
      t.close();
    }
  });

  test("не-200 страницы → partial/source_http; хвост после 5-й страницы → partial/page_limit; кап → partial/favorite_limit", async () => {
    const t: ApiTestDb = makeApiDb();
    try {
      const userId = upsertUser(t.db, "ya-seed2", "seed2");
      const paths: string[] = [];
      const http = await seedFavoritesFromNamespace(t.db, seedClient([{ status: 503, json: {} }], paths), "seeder", userId, 500);
      expect(http).toEqual({ status: "partial", added: 0, error: { code: "source_http" } });
      const pages = Array.from({ length: 5 }, (_, i) => seedPage([`r${i}`], "more"));
      const tail = await seedFavoritesFromNamespace(t.db, seedClient(pages, paths), "seeder", userId, 500);
      expect(tail.status).toBe("partial");
      expect(tail.error?.code).toBe("page_limit");
      expect(tail.added).toBe(5);
      const capped = await seedFavoritesFromNamespace(t.db, seedClient([seedPage(["x1", "x2", "x3"])], paths), "seeder", userId, 6);
      expect(capped).toEqual({ status: "partial", added: 1, error: { code: "favorite_limit" } });
    } finally {
      t.close();
    }
  });
});

describe("Б5 (Ф2.21): HTTP-предел избранного и повтор (QUEUE_FAVORITES_MAX=3)", () => {
  test("4-е → 409 favorite_limit; повтор существующего → 200; в ошибке нет меты репо", async () => {
    for (const repo of ["lim-a", "lim-b", "lim-c"]) {
      const res = await fetch(at("/api/me/favorites"), asSession({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: `o/${repo}` }) }));
      expect(res.status).toBe(200);
    }
    const fourth = await fetch(at("/api/me/favorites"), asSession({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "o/lim-d" }) }));
    expect(fourth.status).toBe(409);
    const body = (await fourth.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("favorite_limit");
    expect(body.error.message).not.toContain("lim-d");
    const repeat = await fetch(at("/api/me/favorites"), asSession({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "o/lim-a" }) }));
    expect(repeat.status).toBe(200);
    const list = await fetch(at("/api/me/favorites"), asSession());
    expect(((await list.json()) as { entries: unknown[] }).entries.length).toBe(3);
  });

  test("ручной ввод URL: первые два сегмента пути, домен любой; мусор → 400", async () => {
    const url = await fetch(at("/api/me/favorites"), asSession2({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "https://git.host/alpha/beta/tree/main" }) }));
    expect(url.status).toBe(200);
    const list = await fetch(at("/api/me/favorites"), asSession2());
    const entries = (await list.json()) as { entries: { org: string; repo: string }[] };
    expect(entries.entries.map((e) => `${e.org}/${e.repo}`)).toEqual(["alpha/beta"]);
    const invalid = await fetch(at("/api/me/favorites"), asSession2({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "../etc" }) }));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("bad_query");
  });
});

// ---------- В4.6 круг 2, хвост приёмки: счётчик рекомендаций не дублируется ----------

describe("В4.6 (приёмка круга 2): строка итога и счётчик", () => {
  const src = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", name), "utf8");

  test("страница просит строку БЕЗ счётчика, MD-отчёт — со счётчиком", async () => {
    const { summaryLine } = (await import("../src/web/format")) as {
      summaryLine: (i: { categories: { title: string; score: number | null }[]; recommendations: number; top: { problem: string; impact: string } | null }, o?: { withCount?: boolean }) => string;
    };
    const input = {
      categories: [
        { title: "Code health", score: 98 },
        { title: "Issues", score: 70 },
        { title: "Security", score: null },
      ],
      recommendations: 3,
      top: { problem: "Нет CODEOWNERS", impact: "+3.5" },
    };
    const forReport = summaryLine(input);
    const forPage = summaryLine(input, { withCount: false });

    expect({
      reportNamesCount: forReport.includes("Рекомендаций: 3"),
      pageOmitsCount: !forPage.includes("Рекомендаций"),
      bothKeepBestWorst: forReport.includes("Сильнее всего – Code health (98)") && forPage.includes("слабее всего – Issues (70)"),
      pageKeepsTop: forPage.includes("Наибольший измеримый прирост дает «Нет CODEOWNERS» (+3.5)."),
      pageStartsCapitalized: /\. Н/.test(forPage),
    }).toEqual({ reportNamesCount: true, pageOmitsCount: true, bothKeepBestWorst: true, pageKeepsTop: true, pageStartsCapitalized: true });
  });

  test("карточка больше не печатает итоговую строку и ссылку; MD сохраняет общий генератор", () => {
    const card = src("RepoPage.tsx");
    const report = src("../report/markdown.ts");
    expect({
      asksWithoutCount: /summaryLine\(\{[\s\S]{0,600}?\}, \{ withCount: false \}\)/.test(card),
      linkStillThere: card.includes("Рекомендаций: {card.recommendations.length}"),
      reportStillUsesGenerator: report.includes("summaryLine"),
    }).toEqual({ asksWithoutCount: false, linkStillThere: false, reportStillUsesGenerator: true });
  });
});
