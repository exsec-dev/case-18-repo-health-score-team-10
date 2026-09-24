// rescore.test.ts — В4.1-fix Б5: пересчёт при старте и защита от старого
// процесса (Ф1.9), видимость fail-closed (Ф1.10), jobs.mode убран (Ф1.15).
// rescoreAll считает каждый скан на его дату, пропускает running, пишет
// rating_eligible и meta.derived_version; openDb пишет и проверяет
// meta.schema_version; сервер пересчитывает до Bun.serve. Сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { getMetaValue, openDb, SCHEMA_VERSION, setMetaValue } from "../src/db";
import { okFact } from "../src/collectors/facts";
import { repoMetaToUpsert, upsertRepo } from "../src/jobs/runner";
import { MODEL_VERSION } from "../src/score/model";
import {
  bumpRescoreCursor,
  DERIVED_VERSION,
  isBusyError,
  needsRescore,
  RESCORE_CURSOR,
  RESCORE_MODEL,
  RESCORE_ERROR,
  RESCORE_RUNNING,
  rescoreAll,
  rescoreBatchByCursor,
  rescoreState,
  runStartupRescore,
} from "../src/score/rescore";
import { healthyFacts } from "./score-fixtures";
import { seedRepo, seedScan } from "./api-fixtures";
import { spawnServer, startMockApi } from "./server-harness";

const ROOT = join(import.meta.dir, "..");
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-rescore-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SOURCES: Record<string, string> = {
  "issues.stats": "rest:issues",
  "issues.comments_sample": "rest:comments",
  "activity.rest": "rest:activity",
  "cicd.runs": "rest:cicd",
};
const healthySpecs = () => healthyFacts().map((f) => ({ ...f, source: SOURCES[f.key] ?? "git" }));

/** БД с двумя завершёнными сканами (пригодный и нет) и одним running — без оценок. */
function seededDir(): { dir: string; ids: { eligible: number; ineligible: number; running: number } } {
  const dir = tempDir();
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t = { db, close: () => db.close() };
  const repoId = seedRepo(t, { org: "rs", repo: "repo" });
  const eligible = seedScan(t, repoId, { startedAt: "2026-03-01T10:00:00Z", finishedAt: "2026-03-01T10:05:00Z", facts: healthySpecs(), ratingEligible: false });
  const ineligible = seedScan(t, repoId, {
    startedAt: "2026-04-01T10:00:00Z",
    finishedAt: "2026-04-01T10:05:00Z",
    facts: healthySpecs().filter((f) => f.key !== "issues.stats"),
    ratingEligible: true,
  });
  const running = seedScan(t, repoId, { startedAt: "2026-05-01T10:00:00Z", finishedAt: null, status: "running", facts: [], ratingEligible: false });
  db.close();
  return { dir, ids: { eligible, ineligible, running } };
}

describe("rescoreAll (Ф1.9)", () => {
  test("дата скана вместо сегодняшней; running пропускается; rating_eligible по фактам; derived_version", () => {
    const { dir, ids } = seededDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    expect(needsRescore(db)).toBe(true);
    const out = rescoreAll(db);
    const rows = db.query("SELECT scan_id, computed_at FROM scores WHERE model_version = ? ORDER BY scan_id").all(MODEL_VERSION);
    const flags = db.query("SELECT id, rating_eligible FROM scans ORDER BY id").all();
    const derived = getMetaValue(db, "derived_version");
    const after = needsRescore(db);
    db.close();
    expect(out).toMatchObject({ scans: 2, skipped: 1, eligible: 1 });
    expect(rows).toEqual([
      { scan_id: ids.eligible, computed_at: "2026-03-01T10:05:00.000Z" },
      { scan_id: ids.ineligible, computed_at: "2026-04-01T10:05:00.000Z" },
    ]);
    expect(flags).toEqual([
      { id: ids.eligible, rating_eligible: 1 },
      { id: ids.ineligible, rating_eligible: 0 },
      { id: ids.running, rating_eligible: 0 },
    ]);
    expect({ derived, after }).toEqual({ derived: String(DERIVED_VERSION), after: false });
  });

  test("needsRescore: устаревший derived_version или нет строк модели при непустых сканах", () => {
    const { dir } = seededDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    setMetaValue(db, "derived_version", String(DERIVED_VERSION));
    expect(needsRescore(db)).toBe(true); // версия свежая, но оценок нет
    rescoreAll(db);
    expect(needsRescore(db)).toBe(false);
    setMetaValue(db, "derived_version", String(DERIVED_VERSION - 1));
    expect(needsRescore(db)).toBe(true);
    // круг 2 (LOW-10): версия свежая, но есть завершённые сканы без public_status (старый процесс)
    rescoreAll(db);
    expect(needsRescore(db)).toBe(false);
    db.exec("UPDATE scans SET public_status = NULL WHERE status = 'ok'");
    expect(needsRescore(db)).toBe(true);
    rescoreAll(db);
    expect(needsRescore(db)).toBe(false);
    db.close();
  });
});

describe("schema_version: запись и защита от старого процесса (Ф1.9, сценарий 5)", () => {
  test("openDb пишет schema_version; БД новее кода — отказ открыть, данные не трогаются", () => {
    const dir = tempDir();
    const cfg = { ...loadConfig(), dataDir: dir };
    const db = openDb(cfg);
    expect(getMetaValue(db, "schema_version")).toBe(SCHEMA_VERSION);
    setMetaValue(db, "schema_version", "9.0");
    db.close();
    expect(() => openDb(cfg)).toThrow(/schema v9\.0 is newer than this code/);
  });

  // версия — из константы кода (дисциплина схемы В4.2a: хардкода версии в
  // tests/ нет); проверяется не число, а что она пишется ПОСЛЕ всех объектов
  test("версия пишется ПОСЛЕ объектов схемы: favorites, jobs.error (П8) и scans.status_detail (Ф2.2) уже есть", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const jobsCols = (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name);
    const scansCols = (db.query("PRAGMA table_info(scans)").all() as { name: string }[]).map((r) => r.name);
    expect({
      stored: getMetaValue(db, "schema_version"),
      favorites: db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites'").get() !== null,
      jobsError: jobsCols.includes("error"),
      statusDetail: scansCols.includes("status_detail"),
    }).toEqual({ stored: SCHEMA_VERSION, favorites: true, jobsError: true, statusDetail: true });
    db.close();
  });

  test("сервер на БД новее кода не стартует (процесс завершается с ошибкой)", async () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    setMetaValue(db, "schema_version", "99.0");
    db.close();
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(43000 + Math.floor(Math.random() * 5000)),
        DATA_DIR: dir,
        SOURCECRAFT_TOKEN: "",
        SOURCECRAFT_API_BASE: "http://127.0.0.1:9",
        APPSEC_API_BASE: "http://127.0.0.1:9",
        SOURCECRAFT_GIT_BASE: "http://127.0.0.1:9",
        YA_REDIRECT_URI: "http://127.0.0.1:9/auth/ya/callback",
        APP_SECRET: "",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("is newer than this code");
  }, 30_000);

  test("роль web не ведёт рескор: порт поднят, derived_version остаётся незаписанным (В4.4)", async () => {
    const { dir } = seededDir();
    const mock = startMockApi();
    const server = await spawnServer({ dataDir: dir, mock, seedMeta: false, env: { PROCESS_ROLE: "web" } });
    try {
      const health = (await (await fetch(`${server.base}/api/health`)).json()) as { rescore: { total: number } };
      expect(health.rescore.total).toBeGreaterThan(0);
      // web-роль не пишет оценки: проход ведёт rating-процесс, здесь его нет
      await Bun.sleep(1500);
      const poll = openDb({ ...loadConfig(), dataDir: dir });
      const derived = getMetaValue(poll, "derived_version");
      poll.close();
      expect(derived).toBeNull();
    } finally {
      await server.stop();
      mock.stop();
    }
  }, 30_000);

  test("старт сервера без актуальных оценок (В4.4): порт ДО рескора, оценки доезжают фоном", async () => {
    const { dir } = seededDir();
    const mock = startMockApi();
    const server = await spawnServer({ dataDir: dir, mock, seedMeta: false });
    try {
      // порт уже отвечает: рескор асинхронен (прежде порт ждал пересчёта)
      const health = (await (await fetch(`${server.base}/api/health`)).json()) as { rescore: { running: boolean; done: number; total: number } };
      expect(typeof health.rescore.total).toBe("number");
      expect(typeof health.rescore.done).toBe("number");
      // фоновый проход доезжает: derived_version записан по завершении
      const deadline = Date.now() + 30_000;
      let derived: string | null = null;
      while (Date.now() < deadline) {
        const poll = openDb({ ...loadConfig(), dataDir: dir });
        derived = getMetaValue(poll, "derived_version");
        poll.close();
        if (derived === String(DERIVED_VERSION)) break;
        await Bun.sleep(200);
      }
      expect(derived).toBe(String(DERIVED_VERSION));
      const body = (await (await fetch(`${server.base}/api/repos`)).json()) as { items: { repo: string; score: number | null }[] };
      expect(body.items.map((i) => i.repo)).toEqual(["repo"]);
      expect(body.items[0]!.score).not.toBeNull();
      expect(mock.requests).toHaveLength(0);
    } finally {
      await server.stop();
      mock.stop();
    }
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const derived = getMetaValue(db, "derived_version");
    db.close();
    expect(derived).toBe(String(DERIVED_VERSION));
  }, 40_000);
});

describe("В4.4 (кластер A): батчевый проход по водяному знаку", () => {
  test("rescoreBatchByCursor: курсор после каждого батча, derived_version и cursor=max по завершении, идемпотентность", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "cur", repo: "r" });
    const ids = [1, 2, 3, 4, 5].map((i) => seedScan(t, repoId, { facts: healthySpecs(), startedAt: `2026-03-0${i}T00:00:00Z` }));
    const first = rescoreBatchByCursor(db, { limit: 2 });
    expect(first).toEqual({ processed: 2, done: false });
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(ids[1]));
    expect(getMetaValue(db, "derived_version")).toBeNull();
    rescoreBatchByCursor(db, { limit: 2 });
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(ids[3]));
    const third = rescoreBatchByCursor(db, { limit: 10 });
    expect(third).toEqual({ processed: 1, done: true });
    expect(getMetaValue(db, "derived_version")).toBe(String(DERIVED_VERSION));
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(ids[4]));
    expect(needsRescore(db)).toBe(false);
    // повторный вызов при догнанном курсоре — работы нет, готовое не трогается
    const stamps = (db.query("SELECT scan_id, computed_at FROM scores ORDER BY scan_id").all() as { scan_id: number; computed_at: string }[]).map((r) => `${r.scan_id}:${r.computed_at}`);
    const again = rescoreBatchByCursor(db, { limit: 10 });
    expect(again.processed).toBe(0);
    const stampsAfter = (db.query("SELECT scan_id, computed_at FROM scores ORDER BY scan_id").all() as { scan_id: number; computed_at: string }[]).map((r) => `${r.scan_id}:${r.computed_at}`);
    expect(stampsAfter).toEqual(stamps);
    db.close();
  });

  test("needsRescore/bumpRescoreCursor: running — не «недогон» (И-4, круг 2), прыжок через непройденное запрещён", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "bump", repo: "r" });
    const a = seedScan(t, repoId, { facts: healthySpecs() });
    const b = seedScan(t, repoId, { facts: healthySpecs() });
    rescoreAll(db);
    expect(needsRescore(db)).toBe(false);
    // И-4 (круг 2, СОЗНАТЕЛЬНАЯ семантическая правка теста круга 1 — контракт
    // Б5 workers/V4.4-round2-oneshot.md): водяной знак считает только
    // ЗАВЕРШЁННЫЕ сканы — running-скан не «недогон», рестарт при непустой
    // очереди больше не мигает «rescore pending»; свой скор running получит
    // от собственного скор-хука при завершении
    const running = seedScan(t, repoId, { facts: [], status: "running", finishedAt: null });
    expect(running).toBeGreaterThan(b);
    expect(needsRescore(db)).toBe(false);
    const walked = rescoreBatchByCursor(db, { limit: 10 });
    expect({ walked: walked.processed, done: walked.done }).toEqual({ walked: 1, done: true });
    expect(needsRescore(db)).toBe(false); // курсор миновал running (скор даст его хук)
    // прерванный проход: под курсором непройденное завершённое — знак не прыгает
    const c = seedScan(t, repoId, { facts: healthySpecs() });
    const d = seedScan(t, repoId, { facts: healthySpecs() });
    setMetaValue(db, RESCORE_CURSOR, String(running));
    bumpRescoreCursor(db, d); // хук d: между знаком и d есть непройденный c
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(running));
    bumpRescoreCursor(db, c); // хук c: ниже чисто — знак на c
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(c));
    bumpRescoreCursor(db, d); // теперь чисто — знак на d
    expect(getMetaValue(db, RESCORE_CURSOR)).toBe(String(d));
    db.close();
  });

  test("rescoreState: running по свежему сердцебиению, staleness и ошибка честны", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "st", repo: "r" });
    seedScan(t, repoId, { facts: healthySpecs() });
    expect(rescoreState(db).running).toBe(false);
    setMetaValue(db, RESCORE_RUNNING, new Date().toISOString());
    expect(rescoreState(db).running).toBe(true);
    setMetaValue(db, RESCORE_RUNNING, new Date(Date.now() - 11 * 60_000).toISOString());
    expect(rescoreState(db).running).toBe(false);
    setMetaValue(db, RESCORE_ERROR, "boom");
    expect(rescoreState(db)).toMatchObject({ running: false, error: "boom" });
    db.close();
  });

  test("runStartupRescore: полный проход до done", async () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "run", repo: "r" });
    for (let i = 0; i < 3; i++) seedScan(t, repoId, { facts: healthySpecs(), startedAt: `2026-03-0${i + 1}T00:00:00Z` });
    const done = await runStartupRescore(db, { limit: 2, pauseMs: 0 });
    expect(done).toEqual({ stopped: "done" });
    expect(getMetaValue(db, "derived_version")).toBe(String(DERIVED_VERSION));
    expect(getMetaValue(db, RESCORE_RUNNING)).toBeNull();
    db.close();
  });

  test("runStartupRescore: BUSY — ретраи с бэкоффом излечивают проход; повторные (>3) — стоп с курсором", async () => {
    // настоящий SQLITE_BUSY: второй коннект держит write-транзакцию, BEGIN
    // IMMEDIATE на первом падает честным кодом (SQLiteError нельзя сконструировать)
    const { Database } = await import("bun:sqlite");
    const dir = tempDir();
    const path = join(dir, "repo-health.db");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "busy", repo: "r" });
    for (let i = 0; i < 2; i++) seedScan(t, repoId, { facts: healthySpecs(), startedAt: `2026-03-0${i + 1}T00:00:00Z` });
    db.exec("PRAGMA busy_timeout = 10;");
    let busyErr: Error;
    {
      const blocker = new Database(path);
      blocker.exec("BEGIN IMMEDIATE");
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        throw new Error("expected SQLITE_BUSY here");
      } catch (e) {
        if (!isBusyError(e)) throw e;
        busyErr = e as Error;
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
    }
    expect(isBusyError(busyErr!)).toBe(true);
    expect(isBusyError(new Error("not sqlite"))).toBe(false);
    // два броска BUSY переживаются (бэкофф), третий батч проходит по чистой базе
    let throws = 0;
    const flaky = (() => {
      if (throws < 2) {
        throws++;
        throw busyErr!;
      }
      return rescoreBatchByCursor(db, { limit: 10 });
    }) as unknown as typeof rescoreBatchByCursor;
    const healed = await runStartupRescore(db, { limit: 10, pauseMs: 0, busyTimeoutMs: 10, batch: flaky });
    expect(healed).toEqual({ stopped: "done" });
    expect(throws).toBe(2);
    expect(getMetaValue(db, "derived_version")).toBe(String(DERIVED_VERSION));
    db.close();

    // блокер не отпускают: 4 попытки (1 + 3 повтора) — стоп «busy», курсор цел
    const dir2 = tempDir();
    const path2 = join(dir2, "repo-health.db");
    const db2 = openDb({ ...loadConfig(), dataDir: dir2 });
    const t2 = { db: db2, close: () => db2.close() };
    const repo2 = seedRepo(t2, { org: "busy2", repo: "r" });
    seedScan(t2, repo2, { facts: healthySpecs() });
    db2.exec("PRAGMA busy_timeout = 10;");
    const blocker2 = new Database(path2);
    blocker2.exec("BEGIN IMMEDIATE");
    const out = await runStartupRescore(db2, { limit: 2, pauseMs: 0, busyTimeoutMs: 10 });
    blocker2.exec("ROLLBACK");
    blocker2.close();
    expect(out).toEqual({ stopped: "busy" });
    expect(getMetaValue(db2, "derived_version")).toBeNull();
    expect(getMetaValue(db2, RESCORE_RUNNING)).toBeNull();
    db2.close();
  }, 20_000);

  test("runStartupRescore: схемная ошибка — стоп с derived_rescore_error, derived_version не пишется", async () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "schema", repo: "r" });
    seedScan(t, repoId, { facts: healthySpecs() });
    db.exec("DROP TABLE recommendations"); // схемная дыра: rescoreScan бросит
    const out = await runStartupRescore(db, { limit: 2, pauseMs: 0 });
    expect(out).toEqual({ stopped: "error" });
    expect(getMetaValue(db, "derived_version")).toBeNull();
    expect(getMetaValue(db, RESCORE_ERROR)).toContain("recommendations");
    expect(getMetaValue(db, RESCORE_RUNNING)).toBeNull();
    db.close();
  });
});

describe("видимость fail-closed (Ф1.10) и jobs.mode (Ф1.15)", () => {
  test("новая строка без видимости — private; мета без visibility не перезаписывает существующую", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    upsertRepo(db, "vis", "fresh");
    upsertRepo(db, "vis", "known", { visibility: "public" });
    upsertRepo(db, "vis", "known", repoMetaToUpsert({ org: "vis", repo: "known", title: "K", language: null, likes: null, lastActivityAt: null, forks: null, reactionCounts: null, visibility: null as unknown as string }));
    upsertRepo(db, "vis", "known", { visibility: null });
    const rows = db.query("SELECT repo_slug, visibility, title FROM repos WHERE org_slug = 'vis' ORDER BY repo_slug").all();
    const meta = repoMetaToUpsert({ org: "vis", repo: "x", title: null, language: null, likes: null, lastActivityAt: null, forks: null, reactionCounts: null, visibility: null as unknown as string });
    db.close();
    expect(rows).toEqual([
      { repo_slug: "fresh", visibility: "private", title: null },
      { repo_slug: "known", visibility: "public", title: "K" },
    ]);
    expect("visibility" in meta).toBe(false);
  });

  test("новая БД: у jobs нет колонки mode", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const cols = (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(cols).not.toContain("mode");
    expect(okFact("x.y", 1, "git").status).toBe("ok");
  });
});

describe("круг 2 (LOW-7): стартовый пересчёт только читаемых сканов, история — фоном; ошибки", () => {
  test("scope startup: P, L и приватный не-bad; остальное — rescoreHistoryBatch по курсору", async () => {
    const { rescoreHistoryBatch } = await import("../src/score/rescore");
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const pub = seedRepo(t, { org: "st", repo: "pub" });
    const old = seedScan(t, pub, { facts: healthySpecs(), startedAt: "2026-01-01T00:00:00Z" });
    const p = seedScan(t, pub, { facts: healthySpecs(), startedAt: "2026-02-01T00:00:00Z" });
    const l = seedScan(t, pub, { facts: healthySpecs().filter((f) => f.key !== "issues.stats"), startedAt: "2026-03-01T00:00:00Z" });
    const priv = seedRepo(t, { org: "st", repo: "priv" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    const privOld = seedScan(t, priv, { facts: [], status: "partial", startedAt: "2026-01-01T00:00:00Z" });
    const privNotBad = seedScan(t, priv, { facts: [], status: "partial", startedAt: "2026-02-01T00:00:00Z" });
    const privBad = seedScan(t, priv, { facts: [], status: "bad", startedAt: "2026-03-01T00:00:00Z" });
    const out = rescoreAll(db, { scope: "startup" });
    const rowsOf = () => (db.query("SELECT scan_id FROM scores ORDER BY scan_id").all() as { scan_id: number }[]).map((r) => r.scan_id);
    expect(out.fatal).toBe(0);
    expect(rowsOf()).toEqual([p, l, privNotBad, privBad]);
    expect(getMetaValue(db, "derived_version")).toBe(String(DERIVED_VERSION));
    expect(getMetaValue(db, "history_rescore_cursor")).toBe("0");
    let batches = 0;
    while (rescoreHistoryBatch(db, { limit: 2 }) > 0) batches++;
    expect(rowsOf()).toEqual([old, p, l, privOld, privNotBad, privBad].sort((a, b) => a - b));
    expect(getMetaValue(db, "history_rescore_cursor")).toBeNull();
    expect(batches).toBe(3);
    db.close();
  });

  test("ошибка данных одного скана не валит пересчёт (derived_version пишется); ошибка схемы — стоп без derived_version", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "err", repo: "r" });
    seedScan(t, repoId, { facts: healthySpecs() });
    const broken = seedScan(t, repoId, { facts: healthySpecs() });
    db.query("UPDATE facts SET value = 'not json' WHERE scan_id = ? AND key = 'docs.presence'").run(broken);
    const logs: string[] = [];
    const out = rescoreAll(db, { log: (m) => logs.push(m) });
    expect({ scans: out.scans, errors: out.errors, fatal: out.fatal }).toEqual({ scans: 1, errors: 1, fatal: 0 });
    expect(logs.some((m) => m.includes(`scan ${broken}`))).toBe(true);
    expect(getMetaValue(db, "derived_version")).toBe(String(DERIVED_VERSION));

    db.query("DELETE FROM meta WHERE key = 'derived_version'").run();
    db.exec("DROP TABLE recommendations");
    const fatal = rescoreAll(db);
    expect(fatal.fatal).toBe(1);
    expect(getMetaValue(db, "derived_version")).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Круг 2 В4.4 (З5): проход рескора поднимал busy_timeout до 15 с навсегда —
// контракт SIGTERM «≤ 5 с» нарушался. После прохода дефолт соединения
// (DB_BUSY_TIMEOUT_MS, db.ts) обязан вернуться.
// ---------------------------------------------------------------------------

describe("З5 (круг 2 В4.4): busy_timeout восстанавливается после прохода", () => {
  test("runStartupRescore: после done PRAGMA busy_timeout снова 5000", async () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "busyto", repo: "r" });
    seedScan(t, repoId, { facts: healthySpecs() });
    const done = await runStartupRescore(db, { limit: 5, pauseMs: 0 });
    expect(done).toEqual({ stopped: "done" });
    const bt = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(bt).toBe(5000);
    db.close();
  });
});

describe("В5.3: смена MODEL_VERSION сбрасывает водяной знак", () => {
  test("знак на последнем скане, одна свежая строка новой версии, метка старой модели — проход пересчитывает всю историю", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "mv", repo: "r" });
    const ids = [1, 2, 3].map((i) => seedScan(t, repoId, { facts: healthySpecs(), startedAt: `2026-03-0${i}T00:00:00Z` }));
    rescoreBatchByCursor(db, { limit: 10 });
    // состояние живой БД 24.09: знак догнал max(scan_id), проход прежней версии
    db.query("DELETE FROM scores WHERE scan_id <> ?").run(ids[2]!);
    setMetaValue(db, RESCORE_MODEL, "4.1.0-hci");
    setMetaValue(db, RESCORE_CURSOR, String(ids[2]));
    expect(needsRescore(db)).toBe(true);
    const out = rescoreBatchByCursor(db, { limit: 10 });
    expect(out).toEqual({ processed: 3, done: true });
    expect(getMetaValue(db, RESCORE_MODEL)).toBe(MODEL_VERSION);
    const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
    expect(rows).toBe(3);
    expect(needsRescore(db)).toBe(false);
    db.close();
  });
});
