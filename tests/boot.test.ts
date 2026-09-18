// boot.test.ts — слой L0 (test-scaffold): сервер и БД поднимаются,
// health отвечает, tri-state NULL-семантика схемы жива.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config";
import { getMetaValue, openDb, SCHEMA_VERSION } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "rh-boot-"));
const config = { ...loadConfig(), port: 0, dataDir: dir };
const db = openDb(config);

afterAll(() => db.close());

describe("boot", () => {
  test("db: схема создаётся, repos пусто", () => {
    const c = db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number };
    expect(c.c).toBe(0);
  });

  test("db: scores.total_rating/total_full допускают NULL (tri-state: нет данных ≠ плохо)", () => {
    db.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('org', 'repo')");
    db.exec("INSERT INTO scans (repo_id, started_at) VALUES (1, '2026-09-15')");
    db.exec(
      "INSERT INTO scores (scan_id, model_version, repo_id, total_rating, coverage_rating, total_full, coverage_full, categories, no_data, stale, computed_at) VALUES (1, 'test', 1, NULL, 0, NULL, 0, '{}', '[]', '[]', '2026-09-15T00:00:00Z')",
    );
    const row = db.query("SELECT total_rating, total_full FROM scores WHERE scan_id = 1 AND model_version = 'test'").get() as { total_rating: number | null; total_full: number | null };
    expect(row.total_rating).toBeNull();
    expect(row.total_full).toBeNull();
  });

  test("jobs: индекс незаклейменных работает", () => {
    db.exec("INSERT INTO jobs (repo_id) VALUES (1)");
    const n = db.query("SELECT COUNT(*) AS c FROM jobs WHERE claimed_at IS NULL").get() as { c: number };
    expect(n.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ф2.11 (LOW-1). Миграция очереди со схемы v1 (UNIQUE(repo_id)): индексы
// старой таблицы сносятся ДО RENAME, вся пересборка — в одной транзакции.
// ---------------------------------------------------------------------------

describe("Ф2.11: пересборка jobs со старой схемы не теряет индексы", () => {
  /** БД образца v1: jobs с UNIQUE(repo_id) и индексами того времени. */
  function legacyDb(): { dir: string; path: string } {
    const legacyDir = mkdtempSync(join(tmpdir(), "rh-jobs-v1-"));
    const raw = new Database(join(legacyDir, "repo-health.db"), { create: true });
    raw.exec(`CREATE TABLE repos (id INTEGER PRIMARY KEY, org_slug TEXT NOT NULL, repo_slug TEXT NOT NULL, title TEXT, language TEXT, likes INTEGER, last_activity_at TEXT, UNIQUE(org_slug, repo_slug));`);
    raw.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL UNIQUE REFERENCES repos(id),
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_at TEXT,
      lease_until TEXT
    );`);
    raw.exec("CREATE INDEX IF NOT EXISTS idx_jobs_unclaimed ON jobs(claimed_at) WHERE claimed_at IS NULL");
    raw.exec("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, id)");
    raw.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('legacy', 'one')");
    raw.exec("INSERT INTO jobs (repo_id, status) VALUES (1, 'queued')");
    raw.close();
    return { dir: legacyDir, path: join(legacyDir, "repo-health.db") };
  }

  test("после миграции индексы очереди принадлежат новой jobs, строки сохранены", () => {
    const legacy = legacyDb();
    try {
      const migrated = openDb({ ...loadConfig(), dataDir: legacy.dir });
      const indexes = (migrated.query("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL").all() as {
        name: string;
        tbl_name: string;
      }[]).map((r) => r.name);
      const ddl = (migrated.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string }).sql;
      const rows = (migrated.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
      // старая таблица-черновик не осталась в базе
      const leftover = migrated.query("SELECT 1 FROM sqlite_master WHERE name = 'jobs_v1_rebuild'").get();
      expect({
        unclaimed: indexes.includes("idx_jobs_unclaimed"),
        claim: indexes.includes("idx_jobs_claim"),
        statusClaimed: indexes.includes("idx_jobs_status_claimed"),
        repoStatus: indexes.includes("idx_jobs_repo_status"),
        unique: ddl.includes("UNIQUE"),
        rows,
        leftover,
      }).toEqual({
        unclaimed: true,
        claim: true,
        statusClaimed: true,
        repoStatus: true,
        unique: false,
        rows: 1,
        leftover: null,
      });
      // индекс действительно используется планировщиком запроса, а не просто существует
      const plan = (migrated.query("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE status = 'queued' ORDER BY id").all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" ");
      expect(plan).toContain("idx_jobs_claim");
      migrated.close();
    } finally {
      try {
        rmSync(legacy.dir, { recursive: true, force: true });
      } catch {
        /* Windows EBUSY */
      }
    }
  });

  test("повторное открытие уже мигрированной БД пересборку не запускает", () => {
    const legacy = legacyDb();
    try {
      const first = openDb({ ...loadConfig(), dataDir: legacy.dir });
      first.query("INSERT INTO jobs (repo_id, status) VALUES (1, 'queued')").run();
      first.close();
      const second = openDb({ ...loadConfig(), dataDir: legacy.dir });
      // пересборка перенесла бы только четыре колонки и снесла бы attempts/created_at,
      // а строки, добавленные после миграции, пережили бы её лишь частично
      expect((second.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c).toBe(2);
      second.close();
    } finally {
      try {
        rmSync(legacy.dir, { recursive: true, force: true });
      } catch {
        /* Windows EBUSY */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ф2.18. Бэкфилл признака полосы (П11) — ОДНОРАЗОВАЯ миграция при переходе
// версии схемы, а не полный UPDATE очереди на каждом openDb.
// ---------------------------------------------------------------------------

describe("Ф2.18: бэкфилл trigger_kind выполняется один раз, при переходе версии", () => {
  /** БД версии 1.7 с юзерской job, помеченной как периодика (legacy-DEFAULT). */
  function db17(): string {
    const d = mkdtempSync(join(tmpdir(), "rh-v17-"));
    const raw = new Database(join(d, "repo-health.db"), { create: true });
    raw.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, org_slug TEXT NOT NULL, repo_slug TEXT NOT NULL, title TEXT, language TEXT, likes INTEGER, last_activity_at TEXT, UNIQUE(org_slug, repo_slug))");
    raw.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', claimed_at TEXT, lease_until TEXT, user_id INTEGER, trigger_kind TEXT NOT NULL DEFAULT 'periodic', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT, error TEXT)");
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1.7')");
    raw.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('o', 'r')");
    raw.exec("INSERT INTO jobs (repo_id, status, user_id, trigger_kind) VALUES (1, 'queued', 7, 'periodic')");
    raw.close();
    return d;
  }

  test("переход 1.7 → текущая чинит признак полосы; ПОВТОРНОЕ открытие очередь не трогает", () => {
    const d = db17();
    try {
      const first = openDb({ ...loadConfig(), dataDir: d });
      expect((first.query("SELECT trigger_kind FROM jobs WHERE id = 1").get() as { trigger_kind: string }).trigger_kind).toBe("user");
      expect(getMetaValue(first, "schema_version")).toBe(SCHEMA_VERSION);
      // «отравленная» строка: если бэкфилл крутится на каждом старте, второй
      // openDb её починит — а он не должен: схема уже текущая
      first.query("UPDATE jobs SET trigger_kind = 'periodic' WHERE id = 1").run();
      first.close();
      const second = openDb({ ...loadConfig(), dataDir: d });
      expect((second.query("SELECT trigger_kind FROM jobs WHERE id = 1").get() as { trigger_kind: string }).trigger_kind).toBe("periodic");
      second.close();
    } finally {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* Windows EBUSY */
      }
    }
  });

  test("legacy-БД без meta считается доверсионной: бэкфилл выполняется", () => {
    const d = mkdtempSync(join(tmpdir(), "rh-nometa-"));
    try {
      const raw = new Database(join(d, "repo-health.db"), { create: true });
      raw.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, org_slug TEXT NOT NULL, repo_slug TEXT NOT NULL, title TEXT, language TEXT, likes INTEGER, last_activity_at TEXT, UNIQUE(org_slug, repo_slug))");
      raw.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', claimed_at TEXT, lease_until TEXT, user_id INTEGER, trigger_kind TEXT NOT NULL DEFAULT 'periodic')");
      raw.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('o', 'r')");
      raw.exec("INSERT INTO jobs (repo_id, status, user_id, trigger_kind) VALUES (1, 'queued', 9, 'periodic')");
      raw.close();
      const migrated = openDb({ ...loadConfig(), dataDir: d });
      expect((migrated.query("SELECT trigger_kind FROM jobs WHERE id = 1").get() as { trigger_kind: string }).trigger_kind).toBe("user");
      migrated.close();
    } finally {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* Windows EBUSY */
      }
    }
  });
});
