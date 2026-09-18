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
import { DERIVED_VERSION, needsRescore, rescoreAll } from "../src/score/rescore";
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

  test("В4.2-port-fix (П8): версия 1.7 и пишется ПОСЛЕ портовых объектов — favorites и jobs.error уже есть", () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const jobsCols = (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((r) => r.name);
    expect({
      version: SCHEMA_VERSION,
      stored: getMetaValue(db, "schema_version"),
      favorites: db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites'").get() !== null,
      jobsError: jobsCols.includes("error"),
    }).toEqual({ version: "1.7", stored: "1.7", favorites: true, jobsError: true });
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

  test("старт сервера без актуальных оценок: синхронный пересчёт до ответа рейтинга", async () => {
    const { dir } = seededDir();
    const mock = startMockApi();
    const server = await spawnServer({ dataDir: dir, mock, seedMeta: false });
    try {
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
  }, 30_000);
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
