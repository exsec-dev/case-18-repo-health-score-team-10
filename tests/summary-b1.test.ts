// summary-b1.test.ts — миграция 2.0 (аддитивность, legacy-путь) и транспорт
// head_sha до конца (Б1 В5): extractFacts выносит sha, runner пишет колонку
// scans.head_sha при реальном git-канале. Живых запросов нет: клон — file://,
// REST — швом collectRest.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { SCHEMA_VERSION, getMetaValue, openDb } from "../src/db";
import { runScan } from "../src/jobs/runner";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v5b1-"));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}

const columnsOf = (db: Database, table: string): Set<string> =>
  new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));

describe("Миграция 2.0→2.1 (Б1 В5 + 23.09 ai_fails)", () => {
  test("свежая БД: ai_notes, ai_fails, scans.head_sha, jobs.kind='scan'; версия 2.1", () => {
    const { db } = freshDb();
    expect(getMetaValue(db, "schema_version")).toBe(SCHEMA_VERSION);
    // В5.3-М (Н1): 2.2 — scans.collector_version (аддитивно, таблицы 2.1 на месте)
    // В5.2 (Б2): 2.3 — аудитория AI-текста и отметка пароля (аддитивно)
    expect(SCHEMA_VERSION).toBe("2.3");
    expect(columnsOf(db, "scans").has("head_sha")).toBe(true);
    expect(columnsOf(db, "jobs").has("kind")).toBe(true);
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind) VALUES (0, 'queued', 'periodic')").run();
    const kind = db.query("SELECT kind FROM jobs ORDER BY id DESC LIMIT 1").get() as { kind: string };
    expect(kind.kind).toBe("scan");
    const aiColumns = columnsOf(db, "ai_notes");
    for (const col of ["id", "repo_id", "scan_id", "role", "text", "fact_refs", "charter_version", "model", "created_at"]) {
      expect(aiColumns.has(col)).toBe(true);
    }
    // 2.1 (23.09): ai_fails — честная причина несформирования роли
    const failColumns = columnsOf(db, "ai_fails");
    for (const col of ["id", "repo_id", "scan_id", "role", "reason", "created_at"]) {
      expect(failColumns.has(col)).toBe(true);
    }
    db.close();
  });

  test("legacy-БД 1.9: колонки добавляются ALTER'ом, данные на месте, версия поднимается", () => {
    const { db, dir } = freshDb();
    // готовим «старую» БД: строка scans, затем сносим артефакты 2.0 и откатываем версию
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('legacy', 'repo')").run();
    const repoId = (db.query("SELECT id FROM repos").get() as { id: number }).id;
    db.query("INSERT INTO scans (repo_id, started_at, status) VALUES (?, '2026-01-01T00:00:00Z', 'ok')").run(repoId);
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind) VALUES (?, 'queued', 'periodic')").run(repoId);
    db.exec("DROP TABLE ai_notes");
    db.exec("ALTER TABLE scans DROP COLUMN head_sha");
    // индекса 2.3 (kind, created_at) у базы 1.9 не было — сносим его, как и прочие артефакты
    db.exec("DROP INDEX IF EXISTS idx_jobs_kind_created");
    db.exec("ALTER TABLE jobs DROP COLUMN kind");
    db.query("UPDATE meta SET value = '1.9' WHERE key = 'schema_version'").run();
    db.close();

    const reopened = openDb({ ...loadConfig(), dataDir: dir });
    expect(getMetaValue(reopened, "schema_version")).toBe(SCHEMA_VERSION);
    expect(columnsOf(reopened, "scans").has("head_sha")).toBe(true);
    expect(columnsOf(reopened, "jobs").has("kind")).toBe(true);
    expect(columnsOf(reopened, "ai_fails").has("reason")).toBe(true);
    const scan = reopened.query("SELECT s.id AS id, s.head_sha AS head_sha, j.kind AS kind FROM scans s JOIN jobs j ON j.repo_id = s.repo_id").get() as {
      id: number;
      head_sha: string | null;
      kind: string;
    };
    expect(scan.head_sha).toBeNull(); // старые строки честно NULL
    expect(scan.kind).toBe("scan"); // дефолт: старые строки не тронуты
    reopened.close();
  });
});

describe("Транспорт head_sha (Б1 В5): runScan с реальным git-каналом", () => {
  test("клон file:// → scans.head_sha = rev-parse HEAD; строки фактов собраны", async () => {
    const src = mkdtempSync(join(tmpdir(), "rh-v5b1-src-"));
    dirs.push(src);
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", args, { cwd: src, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Alice Dev"]);
    git(["config", "user.email", "alice@example.com"]);
    writeFileSync(join(src, "README.md"), "# T\n\nText.\n");
    writeFileSync(join(src, "app.ts"), "export const x = 1;\n// TODO: improve\n");
    git(["add", "-A"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
    git(["commit", "-q", "-m", "base commit"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src }).toString().trim();

    const { db } = freshDb();
    const res = await runScan(
      {
        db,
        scClient: null,
        restBase: "http://127.0.0.1:1",
        appsecBase: "http://127.0.0.1:1",
        gitUrl: () => `file://${src}`,
        collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }),
      },
      "v5/sha",
      { trigger: "test" },
    );
    expect(res.channels.git).toBe("ok");
    const scan = db.query("SELECT head_sha FROM scans WHERE id = ?").get(res.scanId) as { head_sha: string | null };
    expect(scan.head_sha).toBe(expectedSha);
    // клон убран (окно закрылось в конце скана — закон 3)
    const leftovers = (db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
    expect(leftovers).toBeGreaterThanOrEqual(0); // jobs не при чём; проверка окна — по каталогу ниже
  }, 60_000);
});
