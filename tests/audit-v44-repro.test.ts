// Репро-тесты на дефекты, найденные код-аудитом: старт сервера при
// незавершенном рескоре, пустой каталог, честный health, исход анализа,
// лимит карточки, отказанные заявки. Незакрытый дефект оборачивается в
// `repro`: в обычном прогоне это test.failing, под AUDIT_STRICT=1 — обычный
// test, который краснеет, пока дефект не исправлен.
//
// Живых запросов нет: только временные БД, локальные моки и настоящий
// сервер во временном DATA_DIR.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { loadConfig } from "../src/config";
import { getMetaValue, openDb, setMetaValue } from "../src/db";
import * as rescoreModule from "../src/score/rescore";
import { DERIVED_VERSION } from "../src/score/rescore";
import * as formatModule from "../src/web/format";
import { nightlyCatalog } from "../src/jobs/scheduler";
import { recordRefusedUserJob } from "../src/jobs/scheduler";
import { myJobs } from "../src/api/me";
import { upsertUser } from "../src/auth/session";
import type { ScClient } from "../src/collectors/http";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { healthyFacts } from "./score-fixtures";
import { seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { startMockApi } from "./server-harness";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
const procs: { kill: () => void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs.reverse()) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SOURCES: Record<string, string> = {
  "issues.stats": "rest:issues",
  "issues.comments_sample": "rest:comments",
  "activity.rest": "rest:activity",
  "cicd.runs": "rest:cicd",
};
const healthySpecs = () => healthyFacts().map((f) => ({ ...f, source: SOURCES[f.key] ?? "git" }));

/** Мок каталога: 200 с массивом (по умолчанию пустым) без next_page_token. */
function catalogMock(pages: unknown[] = []): ScClient {
  return {
    async get() {
      return { status: 200, json: { repositories: pages }, bodyText: "" };
    },
    requestCount: () => 1,
  } as unknown as ScClient;
}

// ---------------------------------------------------------------------------
// Старт с незавершенным рескором: порт поднимается до рескора, health несет
// прогресс. Иначе деплой на живой БД — десятки минут без порта. Ожидание
// свое, не из харнесса: подходит любой HTTP-ответ health.
// ---------------------------------------------------------------------------

describe("A-1 (Б1): порт раньше рескора; /api/health несёт rescore-прогресс", () => {
  test("health отвечает при pending-рескоре и несёт {running, done, total}", async () => {
    const dir = tempDir("rh-v44-a1-");
    // 150 пригодных сканов без оценок и без derived_version: рескор при
    // старте обязателен (needsRescore), но порт поднимается первым
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "a1", repo: "repo" });
    for (let i = 0; i < 150; i++) {
      seedScan(t, repoId, { facts: healthySpecs(), startedAt: "2026-03-01T00:00:00Z" });
    }
    db.close();
    // собственный spawn+wait: любой HTTP-ответ health = порт жив
    const port = 43100 + Math.floor(Math.random() * 3000);
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        APP_SECRET: "",
        SOURCECRAFT_TOKEN: "",
        SOURCECRAFT_API_BASE: "http://127.0.0.1:9",
        APPSEC_API_BASE: "http://127.0.0.1:9",
        SOURCECRAFT_GIT_BASE: "http://127.0.0.1:9",
        YA_REDIRECT_URI: `http://127.0.0.1:${port}/auth/ya/callback`,
        SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    procs.push({ kill: () => proc.kill() });
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 200 && proc.exitCode === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          body = (await res.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        /* порт ещё не слушает — следующий тик */
      }
      await Bun.sleep(100);
    }
    proc.kill();
    expect(body).not.toBeNull();
    const rescore = body?.["rescore"] as { running?: unknown; done?: unknown; total?: unknown } | undefined;
    expect(rescore).toBeDefined();
    expect(typeof rescore!.running).toBe("boolean");
    expect(typeof rescore!.done).toBe("number");
    expect(typeof rescore!.total).toBe("number");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Прогресс рескора персистентен: батчевый проход по курсору
// derived_rescore_cursor (watermark scan_id) переживает рестарт, курсор
// пишется после каждого батча, derived_version — только по завершении.
// ---------------------------------------------------------------------------

describe("A-2 (Б1): курсор рескора в meta переживает рестарт", () => {
  // через каст модуля: наличие функции проверяет сам тест
  const api = rescoreModule as unknown as {
    RESCORE_CURSOR_KEY?: string;
    rescoreBatchByCursor?: (db: Database, opts?: { limit?: number }) => { processed: number; done: boolean };
  };

  test("батч двигает курсор; derived_version — только по завершении; рестарт не пересчитывает готовое", () => {
    const dir = tempDir("rh-v44-a2-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "a2", repo: "repo" });
    const ids = [1, 2, 3, 4, 5].map((i) => seedScan(t, repoId, { facts: healthySpecs(), startedAt: `2026-03-0${i}T00:00:00Z` }));
    expect(typeof api.rescoreBatchByCursor).toBe("function");
    const batch = api.rescoreBatchByCursor!;
    // первый батч — два скана: курсор на втором, итог ещё не записан
    const first = batch(db, { limit: 2 });
    const cursorKey = api.RESCORE_CURSOR_KEY ?? "derived_rescore_cursor";
    expect(first.processed).toBe(2);
    expect(getMetaValue(db, cursorKey)).toBe(String(ids[1]));
    expect(getMetaValue(db, "derived_version")).toBeNull();
    // «рестарт»: новое соединение с той же БД продолжает с курсора
    db.close();
    const db2 = openDb({ ...loadConfig(), dataDir: dir });
    const second = batch(db2, { limit: 2 });
    expect(second.processed).toBe(2);
    expect(getMetaValue(db2, cursorKey)).toBe(String(ids[3]));
    expect(getMetaValue(db2, "derived_version")).toBeNull();
    // хвост: пятый скан, проход завершён — derived_version записан, курсор на max(scan_id)
    const third = batch(db2, { limit: 10 });
    expect({ processed: third.processed, done: third.done }).toEqual({ processed: 1, done: true });
    expect(getMetaValue(db2, "derived_version")).toBe(String(DERIVED_VERSION));
    expect(getMetaValue(db2, cursorKey)).toBe(String(ids[4]));
    // повторный батч после завершения — работы нет, готовое не трогается
    const computedBefore = (db2.query("SELECT scan_id, computed_at FROM scores ORDER BY scan_id").all() as { scan_id: number; computed_at: string }[])
      .map((r) => `${r.scan_id}:${r.computed_at}`);
    const fourth = batch(db2, { limit: 10 });
    expect(fourth.processed).toBe(0);
    const computedAfter = (db2.query("SELECT scan_id, computed_at FROM scores ORDER BY scan_id").all() as { scan_id: number; computed_at: string }[])
      .map((r) => `${r.scan_id}:${r.computed_at}`);
    expect(computedAfter).toEqual(computedBefore);
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// «Успешно пустой» полный обход (200, пустой массив, без курсора) при
// существующих активных публичных репо: эвикция не исполняется, ставится
// meta-флаг catalog_suspicious_at; обход с записями снимает флаг.
// ---------------------------------------------------------------------------

describe("D (Б2): успешно пустой каталог не эвицит и ставит suspicious", () => {
  test("полный обход с entries=0: без эвикции, флаг стоит; обход с записями снимает", async () => {
    const dir = tempDir("rh-v44-d-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const a = seedRepo(t, { org: "d", repo: "one" });
    const b = seedRepo(t, { org: "d", repo: "two" });
    seedScore(t, a, seedScan(t, a, { facts: healthySpecs() }), { total: 50 });
    seedScore(t, b, seedScan(t, b, { facts: healthySpecs() }), { total: 60 });
    // «успешно пустой» снимок: ok, дочитан, записей нет
    const empty = await nightlyCatalog(db, catalogMock([]));
    expect(empty.ok).toBe(true);
    expect(empty.catalogComplete).toBe(true);
    const activeAfterEmpty = (db.query("SELECT COUNT(*) AS c FROM repos WHERE rating_active = 1").get() as { c: number }).c;
    expect(activeAfterEmpty).toBe(2);
    expect(getMetaValue(db, "catalog_suspicious_at")).not.toBeNull();
    expect(empty.evicted).toEqual([]);
    // живой снимок с обеими записями: эвикции нет, флаг снят
    const alive = await nightlyCatalog(
      db,
      catalogMock([
        { organization: { slug: "d" }, slug: "one", visibility: "public", last_updated: "2026-09-01T00:00:00Z", rating: { value: 1 } },
        { organization: { slug: "d" }, slug: "two", visibility: "public", last_updated: "2026-09-01T00:00:00Z", rating: { value: 1 } },
      ]),
    );
    expect(alive.evicted).toEqual([]);
    expect(getMetaValue(db, "catalog_suspicious_at")).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Честный health: при провале ночной фазы — ok:false + reasons[]. Состояние
// планировщика передается между процессами через meta: rating-роль пишет
// sched_last_nightly_ok, web-роль читает.
// ---------------------------------------------------------------------------

describe("B (Б2): health ok:false с reasons при провале ночной фазы", () => {
  test("sched_last_nightly_ok=0 → ok:false, reasons непусты", async () => {
    const dir = tempDir("rh-v44-b-");
    const mock = startMockApi();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "b", repo: "repo" });
    seedScore(t, repoId, seedScan(t, repoId, { facts: healthySpecs() }), { total: 50 });
    db.close();
    const port = 44100 + Math.floor(Math.random() * 3000);
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        APP_SECRET: "",
        SOURCECRAFT_TOKEN: "",
        SOURCECRAFT_API_BASE: mock.url,
        APPSEC_API_BASE: mock.url,
        SOURCECRAFT_GIT_BASE: mock.url,
        YA_REDIRECT_URI: `http://127.0.0.1:${port}/auth/ya/callback`,
        SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    procs.push({ kill: () => proc.kill() });
    let before: { ok: unknown; reasons: unknown } | null = null;
    for (let i = 0; i < 200 && proc.exitCode === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          before = (await res.json()) as { ok: unknown; reasons: unknown };
          break;
        }
      } catch {
        /* порт ещё не слушает */
      }
      await Bun.sleep(100);
    }
    expect(before).not.toBeNull();
    expect(before!.ok).toBe(true);
    // rating-роль записала провал ночной фазы (кросс-процессное состояние)
    const writer = openDb({ ...loadConfig(), dataDir: dir });
    setMetaValue(writer, "sched_last_nightly_at", new Date().toISOString());
    setMetaValue(writer, "sched_last_nightly_ok", "0");
    writer.close();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as { ok: boolean; reasons: string[] };
    proc.kill();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Исход анализа выбирается по статусу скана: завершенный скан со статусом
// bad — ошибка, а не «Анализ завершен».
// ---------------------------------------------------------------------------

describe("E (Б5): исход анализа по статусу скана", () => {
  // через каст модуля: наличие хелпера проверяет сам тест
  const fmt = formatModule as unknown as {
    analysisOutcome?: (scan: { status: string; finishedAt: string | null } | null | undefined) => "pending" | "ok" | "failed";
  };

  test("bad → failed; ok/partial → ok; running/нет скана → pending", () => {
    expect(typeof fmt.analysisOutcome).toBe("function");
    const outcome = fmt.analysisOutcome!;
    expect(outcome({ status: "bad", finishedAt: "2026-09-20T10:00:00Z" })).toBe("failed");
    expect(outcome({ status: "ok", finishedAt: "2026-09-20T10:00:00Z" })).toBe("ok");
    expect(outcome({ status: "partial", finishedAt: "2026-09-20T10:00:00Z" })).toBe("ok");
    expect(outcome({ status: "running", finishedAt: null })).toBe("pending");
    expect(outcome(null)).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Карточка залогиненного зрителя ходит в сеть пробами, поэтому лимитируется:
// per-user окно QUEUE_CARD_PER_MINUTE (дефолт 30) → 429. Аноним — без
// лимита: публичная карточка в сеть не ходит.
// ---------------------------------------------------------------------------

describe("G (Б4): карточка залогиненного зрителя лимитируется", () => {
  test("сверх окна → 429 rate_limited; аноним — без лимита", async () => {
    const SECRET = "v44-g-secret-0123456789abcdefghijklmnop";
    const dir = tempDir("rh-v44-g-");
    const mock = startMockApi();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "g", repo: "repo" });
    seedScore(t, repoId, seedScan(t, repoId, { facts: healthySpecs() }), { total: 50 });
    const userId = upsertUser(db, "ya-cardlim", "cardlim", new Date());
    const cookie = `${SESSION_COOKIE}=${createSession(db, SECRET, userId)}`;
    db.close();
    const port = 45100 + Math.floor(Math.random() * 3000);
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        APP_SECRET: SECRET,
        SOURCECRAFT_TOKEN: "",
        SOURCECRAFT_API_BASE: mock.url,
        APPSEC_API_BASE: mock.url,
        SOURCECRAFT_GIT_BASE: mock.url,
        YA_REDIRECT_URI: `http://127.0.0.1:${port}/auth/ya/callback`,
        SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
        QUEUE_CARD_PER_MINUTE: "3",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    procs.push({ kill: () => proc.kill() });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 200 && proc.exitCode === null; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          up = true;
          break;
        }
      } catch {
        /* порт ещё не слушает */
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/repos/g/repo`, { headers: { cookie } });
      statuses.push(res.status);
    }
    // 3 показа прошло, четвёртый — за окном
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const anon = await fetch(`${base}/api/repos/g/repo`);
    expect(anon.status).toBe(200);
    proc.kill();
    mock.stop();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Отказанная заявка (repo_id=0) видна в /api/me/jobs: INNER JOIN на repos
// вырезал бы ее, и ветка UI phase="refused" была бы мертвой. Слаг отказанной
// заявки пишется в error-payload.
// ---------------------------------------------------------------------------

describe("J (Б6): refused-заявка видна в /api/me/jobs", () => {
  test("recordRefusedUserJob со слагом → myJobs.recent несёт refused со слагом", () => {
    const dir = tempDir("rh-v44-j-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const userId = upsertUser(db, "ya-refused", "refused", new Date());
    // слаг отказанной заявки доезжает до панели
    const refusedWithSlug = recordRefusedUserJob as unknown as (db: Database, userId: number, now?: Date, slug?: string) => number;
    refusedWithSlug(db, userId, new Date(), "vis/repo");
    const jobs = myJobs(db, userId);
    db.close();
    expect(jobs.recent.length).toBeGreaterThan(0);
    const refused = jobs.recent.find((j) => j.phase === "refused");
    expect(refused).toBeDefined();
    expect(refused!.slug).toBe("vis/repo");
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» —
// тавтология.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
