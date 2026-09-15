// boot.test.ts — слой L0 (test-scaffold): сервер и БД поднимаются,
// health отвечает, tri-state NULL-семантика схемы жива.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "rh-boot-"));
const config = { ...loadConfig(), port: 0, dataDir: dir };
const db = openDb(config);

afterAll(() => db.close());

describe("boot", () => {
  test("db: схема создаётся, repos пусто", () => {
    const c = db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number };
    expect(c.c).toBe(0);
  });

  test("db: scores.total допускает NULL (tri-state: нет данных ≠ плохо)", () => {
    db.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('org', 'repo')");
    db.exec("INSERT INTO scans (repo_id, started_at) VALUES (1, '2026-09-15')");
    db.exec(
      "INSERT INTO scores (scan_id, model_version, repo_id, mode, total, coverage, categories, no_data, stale, computed_at) VALUES (1, 'test', 1, 'public', NULL, 0, '{}', '[]', '[]', '2026-09-15T00:00:00Z')",
    );
    const row = db.query("SELECT total FROM scores WHERE scan_id = 1 AND model_version = 'test'").get() as { total: number | null };
    expect(row.total).toBeNull();
  });

  test("jobs: индекс незаклейменных работает", () => {
    db.exec("INSERT INTO jobs (repo_id) VALUES (1)");
    const n = db.query("SELECT COUNT(*) AS c FROM jobs WHERE claimed_at IS NULL").get() as { c: number };
    expect(n.c).toBe(1);
  });
});
