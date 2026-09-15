// db.ts — SQLite (bun:sqlite) — единственный стор: кэш собранных
// данных + история сканов + очередь jobs + scores/recommendations.
// Tri-state в NULL-семантике: score NULL = «нет данных» (не «плохо»).
// Схема v1.2 (В2/Б1): repos += forks/reaction_counts; scores —
// immutable строки (scan_id+model_version PK, INSERT OR REPLACE);
// recommendations — PK (scan_id, model_version, rule_id). Старые
// формы scores/recommendations (v1.1) пересоздаются (производные
// данные, пересчёт восстанавливает); repos-колонки добавляются
// ALTER'ом (каталог не теряется).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

const SCORES_DDL = `CREATE TABLE IF NOT EXISTS scores (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  model_version TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  mode TEXT NOT NULL,             -- public | own
  total INTEGER,                  -- NULL = нет данных (tri-state)
  coverage REAL NOT NULL,
  categories TEXT NOT NULL,       -- JSON: категория → {score|NULL, submetrics, stale}
  no_data TEXT NOT NULL,          -- JSON: список no-data причин
  stale TEXT NOT NULL,            -- JSON: список stale-фактов (bad-channel, §5.6)
  computed_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, model_version)
);`;

const RECOMMENDATIONS_DDL = `CREATE TABLE IF NOT EXISTS recommendations (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  model_version TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  priority INTEGER NOT NULL,      -- 1 высокий (порядок выдачи движка)
  problem TEXT NOT NULL,
  action TEXT NOT NULL,
  fact_ref TEXT NOT NULL,     -- якорь: kind из facts (валидатор требует)
  expected_impact TEXT,       -- "+3.8 Score (по одному)" | "Score появится (coverage X→Y)" | текст
  delta_score REAL,           -- числовой Δ только у presence-правил (§8)
  opens_category TEXT,        -- категория активационной рекомендации
  source TEXT NOT NULL DEFAULT 'rule' -- rule|llm
);`;

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
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|ok|partial|bad
  trigger TEXT NOT NULL DEFAULT 'periodic' -- periodic|user|probe
);
CREATE TABLE IF NOT EXISTS facts (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  category TEXT NOT NULL,     -- documentation|cicd|security|activity|issues|code|meta
  key TEXT NOT NULL,          -- kind целиком: docs.presence, cicd.runs, ...
  value TEXT NOT NULL,        -- JSON: число|строка|объект — весь доказательный слой
  status TEXT NOT NULL DEFAULT 'ok', -- ok|no-data|bad (no-data reason — внутри value)
  source TEXT NOT NULL,       -- git | rest:issues | rest:comments | ...
  collected_at TEXT NOT NULL, -- UTC ISO 8601
  PRIMARY KEY (scan_id, category, key)
);
${SCORES_DDL}
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL UNIQUE REFERENCES repos(id),
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  claimed_at TEXT,
  lease_until TEXT            -- механика claim-loop — В4
);
${RECOMMENDATIONS_DDL}
CREATE INDEX IF NOT EXISTS idx_jobs_unclaimed ON jobs(claimed_at) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_repos_language ON repos(language);
CREATE INDEX IF NOT EXISTS idx_scores_repo ON scores(repo_id, model_version);
`;

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Добавить колонку, если таблица старой формы уже существует без неё. */
function ensureColumn(db: Database, table: string, column: string, ddlType: string): void {
  if (!columnsOf(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

export function openDb(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "repo-health.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // v1.1 → v1.2: repos-колонки В2 (forks/reaction_counts)
  ensureColumn(db, "repos", "forks", "INTEGER");
  ensureColumn(db, "repos", "reaction_counts", "TEXT");
  // старые формы производных таблиц пересоздаются: v1.1 scores был
  // PK(scan_id) + formula_version; v1.1 recommendations — без model_version
  if (!columnsOf(db, "scores").has("model_version")) {
    db.exec("DROP TABLE IF EXISTS scores");
    db.exec(SCORES_DDL);
  }
  if (!columnsOf(db, "recommendations").has("model_version")) {
    db.exec("DROP TABLE IF EXISTS recommendations");
    db.exec(RECOMMENDATIONS_DDL);
  }
  return db;
}
