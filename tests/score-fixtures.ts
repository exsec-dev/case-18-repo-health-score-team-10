// score-fixtures.ts — общие фикстуры фактов для score-тестов (Б3 compute
// + Б5 мутационные инварианты §9): детерминированное «здоровое репо»
// без сети и клонов. Не *.test.ts — bun test не подхватывает.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { categoryOf } from "../src/collectors/facts";

export const NOW = new Date("2026-09-15T12:00:00Z");

export interface FactSpec {
  key: string;
  value: unknown;
  status?: "ok" | "no-data" | "bad";
}

const DAY = 24 * 3600_000;
const iso = (ts: number): string => new Date(ts).toISOString();

/** 3 авторa: 13 недельных коммитов до 2026-09-13 (все human, не burst). */
export function healthyTimeline(): { events: unknown[] } {
  const events: unknown[] = [];
  const push = (name: string, email: string, ts: number) => {
    events.push({
      sha: `${name}-${ts}`,
      author: { name, email, date: iso(ts) },
      committer: { name, email, date: iso(ts) },
      robot: false,
      robot_reasons: [],
    });
  };
  for (let i = 0; i <= 12; i++) push("alice", "alice@example.com", NOW.getTime() - (2 + (12 - i) * 7) * DAY);
  for (let i = 0; i < 5; i++) push("bob", "bob@example.com", NOW.getTime() - (150 + i * 30) * DAY);
  push("carol", "carol@example.com", NOW.getTime() - 320 * DAY);
  return { events };
}

/** Полный набор ok-фактов «здорового репо» (git ok + REST ok). */
export function healthyFacts(): FactSpec[] {
  const pulls = Array.from({ length: 6 }, (_, i) => iso(NOW.getTime() - (10 + i * 12) * DAY));
  const releases = Array.from({ length: 4 }, (_, i) => iso(NOW.getTime() - (20 + i * 90) * DAY));
  return [
    { key: "activity.git.timeline", value: healthyTimeline() },
    { key: "activity.git.summary", value: { commits: 19, authors: 3, committers: 3, robot_commits: 0, robot_ratio: 0, first_committed_at: iso(NOW.getTime() - 320 * DAY), last_committed_at: iso(NOW.getTime() - 2 * DAY) } },
    {
      key: "docs.presence",
      value: { readme: true, license: true, contributing: true, codeowners: false },
    },
    { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: true, test: true } } },
    { key: "tree.stats", value: { top_level: Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, type: "tree" })), file_count: 300, bytes: 2_000_000, loc: 50_000 } },
    { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
    { key: "cicd.runs", value: { last_status: "success", success_rate: 1.0, duration_p50: 120, runs_count: 10 } },
    { key: "code.todo", value: { count: 10, fixme: 2, older_180d: 3, todo_files: 8, blamed_files: 8 } },
    { key: "issues.stats", value: { open: 10, closed: 40, median_close_days: 5, stale_90d: 1, fetched_count: 50 } },
    { key: "issues.comments_sample", value: { issues: 10, with_comments: 6, median_first_comment_delay_hours: 30, delays_hours: [30] } },
    { key: "activity.rest", value: { contributors: 3, releases: 4, pulls_open: 6, latest_release_at: releases[0], pulls_created_at: pulls, releases_released_at: releases } },
  ];
}

export interface TestDb {
  db: Database;
  repoId: number;
  close: () => void;
}

export function makeDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "rh-score-"));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  db.exec("INSERT INTO repos (org_slug, repo_slug) VALUES ('t', 'repo')");
  const repoId = (db.query("SELECT id FROM repos").get() as { id: number }).id;
  return { db, repoId, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let isolatedRepoSeq = 0;

/**
 * Скан с фактами (по умолчанию ok; status/bad — мутациями). В4.1 (К1):
 * каналы cicd.runs/appsec.findings замещаются историей репо при любом
 * не-ok, поэтому по умолчанию каждый скан живёт в СВОЁМ репо (мутации
 * независимы); историю одного репо тесты задают явно через repoId.
 */
export function seedScan(t: TestDb, facts: FactSpec[], startedDaysAgo = 0, repoId?: number): number {
  const started = iso(NOW.getTime() - startedDaysAgo * DAY - 3600_000);
  let targetRepo = repoId;
  if (targetRepo === undefined) {
    const repo = t.db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('t', ?)").run(`isolated-${++isolatedRepoSeq}`);
    targetRepo = Number(repo.lastInsertRowid);
  }
  const r = t.db.query("INSERT INTO scans (repo_id, started_at, status, finished_at, trigger) VALUES (?, ?, 'ok', ?, 'test')").run(targetRepo, started, started);
  const scanId = Number(r.lastInsertRowid);
  const stmt = t.db.query(
    "INSERT OR REPLACE INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const f of facts) {
    stmt.run(scanId, categoryOf(f.key), f.key, JSON.stringify(f.value), f.status ?? "ok", "test", started);
  }
  return scanId;
}

/** Заменить/добавить факты набора (мутация фикстуры). */
export function withFacts(base: FactSpec[], ...patch: FactSpec[]): FactSpec[] {
  const map = new Map(base.map((f) => [f.key, f]));
  for (const p of patch) map.set(p.key, p);
  return [...map.values()];
}
