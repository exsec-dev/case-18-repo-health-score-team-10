// Легкий статус AI-заявок (api/repos.ts getAiJobStatus): опрос страницы, который
// не списывает «открытия карточки» и не ходит в SourceCraft. Публичный репо –
// любые живые заявки; непубличный – только заявки самого зрителя; неизвестный
// репо неотличим от тихого.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getAiJobStatus } from "../src/api/repos";
import { seedRepo } from "./api-fixtures";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-ai-status-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}
const wrap = (db: Database) => ({ db, close: () => {} });
const user = (db: Database, n: number) => db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, '2026', '2026')").run(n, `y${n}`, `u${n}`);
const job = (db: Database, repoId: number, kind: "summary" | "check" | "scan", status: string, userId: number) =>
  db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, attempts, created_at, audience) VALUES (?, ?, ?, 'user', ?, 0, '2026-10-18T00:00:00Z', 'public')")
    .run(repoId, status, userId, kind);

describe("getAiJobStatus", () => {
  test("публичный репо: живые обзор и проверка видны всем, завершенные и сканы не считаются", () => {
    const db = freshDb();
    user(db, 1);
    user(db, 2);
    const repoId = seedRepo(wrap(db), { org: "s", repo: "pub" });
    db.query("UPDATE repos SET visibility = 'public' WHERE id = ?").run(repoId);
    expect(getAiJobStatus(db, "s", "pub", null)).toEqual({ summaryActive: false, checkActive: false });
    job(db, repoId, "summary", "done", 1);
    job(db, repoId, "scan", "running", 1);
    expect(getAiJobStatus(db, "s", "pub", 2)).toEqual({ summaryActive: false, checkActive: false });
    job(db, repoId, "summary", "queued", 1);
    expect(getAiJobStatus(db, "s", "pub", null)).toEqual({ summaryActive: true, checkActive: false });
    job(db, repoId, "check", "running", 2);
    expect(getAiJobStatus(db, "s", "pub", 1)).toEqual({ summaryActive: true, checkActive: true });
  });

  test("приватный репо: аноним и чужой зритель видят тишину, свои заявки видны", () => {
    const db = freshDb();
    user(db, 1);
    user(db, 2);
    const repoId = seedRepo(wrap(db), { org: "s", repo: "priv" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
    job(db, repoId, "summary", "running", 1);
    expect(getAiJobStatus(db, "s", "priv", null)).toEqual({ summaryActive: false, checkActive: false });
    expect(getAiJobStatus(db, "s", "priv", 2)).toEqual({ summaryActive: false, checkActive: false });
    expect(getAiJobStatus(db, "s", "priv", 1)).toEqual({ summaryActive: true, checkActive: false });
  });

  test("неизвестный репо – тишина, а не 404", () => {
    const db = freshDb();
    expect(getAiJobStatus(db, "no", "such", 1)).toEqual({ summaryActive: false, checkActive: false });
  });
});
