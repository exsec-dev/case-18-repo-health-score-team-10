// db.ts — SQLite (bun:sqlite) — единственный стор: кэш собранных
// данных + история сканов + очередь jobs. Tri-state в NULL-семантике:
// score NULL = «нет данных» (не «плохо»). Схема v1 — миграций нет,
// дев-стенд: удалить data/repo-health.db = пересоздать.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  org_slug TEXT NOT NULL,
  repo_slug TEXT NOT NULL,
  title TEXT,
  language TEXT,
  likes INTEGER,
  last_activity_at TEXT,
  UNIQUE(org_slug, repo_slug)
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|no-data
  trigger TEXT NOT NULL DEFAULT 'periodic' -- periodic|user|probe
);
CREATE TABLE IF NOT EXISTS facts (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  category TEXT NOT NULL,     -- documentation|cicd|security|activity|issues|code|meta
  key TEXT NOT NULL,
  value TEXT NOT NULL,        -- JSON: число|строка|объект — весь доказательный слой
  PRIMARY KEY (scan_id, category, key)
);
CREATE TABLE IF NOT EXISTS scores (
  scan_id INTEGER PRIMARY KEY REFERENCES scans(id),
  total INTEGER,              -- NULL = нет данных (tri-state)
  breakdown TEXT NOT NULL,    -- JSON: категория → {score|NULL, why}
  formula_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  claimed_at TEXT
);
CREATE TABLE IF NOT EXISTS recommendations (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  priority INTEGER NOT NULL,  -- 1 высокий
  problem TEXT NOT NULL,
  action TEXT NOT NULL,
  fact_ref TEXT NOT NULL,     -- якорь: category.key из facts (валидатор требует)
  expected_impact TEXT,
  source TEXT NOT NULL DEFAULT 'rule' -- rule|llm
);
CREATE INDEX IF NOT EXISTS idx_jobs_unclaimed ON jobs(claimed_at) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_repos_language ON repos(language);
`;

export function openDb(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "repo-health.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
