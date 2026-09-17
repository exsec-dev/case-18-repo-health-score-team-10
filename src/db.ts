// db.ts — SQLite (bun:sqlite) — единственный стор: кэш собранных
// данных + история сканов + очередь jobs + scores/recommendations +
// (v1.4, В4) пользователи Я ID/сессии/PAT/настройки. Tri-state в
// NULL-семантике: score NULL = «нет данных» (не «плохо»).
// Схема v1.2 (В2/Б1): repos += forks/reaction_counts; scores —
// immutable строки (scan_id+model_version PK, INSERT OR REPLACE);
// recommendations — PK (scan_id, model_version, rule_id). Старые
// формы scores/recommendations (v1.1) пересоздаются (производные
// данные, пересчёт восстанавливает); repos-колонки добавляются
// ALTER'ом (каталог не теряется).
// Схема v1.3 (В3/Б1): scores += derived (JSON DerivedMetrics) —
// аддитивный ALTER, чтобы страница репо показывала те же производные
// числа, из которых посчитан Score этой строки, не вызывая compute.
// Схема v1.4 (В4): users/sessions/user_tokens/user_settings; repos +=
// rating_active (эвикция — не удаление, закон 6) и visibility;
// jobs += mode/user_id (own-сканы с юзерским PAT); scores +=
// code_empty (Score 0 «проекта нет» — данные, не NULL).
// Схема v1.5 (В4.1, К1/К3): один анализ — одна строка оценки с двумя
// итогами (total_rating/coverage_rating — 4 категории; total_full/
// coverage_full — 6 категорий); колонок mode/total/coverage нет.
// scores/recommendations — производные таблицы: старая форма
// пересоздаётся, затем пересчёт scripts/rescore-m4.ts (прецедент
// v1.1→v1.2). recommendations += channel; scans += user_id (автор скана).
// В4.1-fix (К-Ф1.1, Ф1.11, Ф1.12): scans += rating_eligible (пригодность
// для рейтинга: рейтинг и публичная часть карточки — последний пригодный
// скан) и public_status (статус по фактам публичных категорий — без
// каналов CI/Security); обе колонки при добавлении заполняются одним
// UPDATE по фактам; индексы scans(repo_id, id) и jobs(status, claimed_at).
// Схема v1.6 (В4.1-fix, Ф1.9): таблица meta(key, value) — schema_version
// (пишется и проверяется: БД новее кода → отказ открыть, защита от старого
// процесса на мигрированной БД) и derived_version (src/score/rescore.ts);
// jobs.mode убран из DDL и миграций (Ф1.15; в старых БД колонка остаётся,
// не читается); jobs.status += refused.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { publicStatusSql, ratingEligibleSql } from "./score/compute";

/** Версия схемы этого кода (Ф1.9): meta.schema_version. */
export const SCHEMA_VERSION = "1.6";

const SCORES_DDL = `CREATE TABLE IF NOT EXISTS scores (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  model_version TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  total_rating INTEGER,           -- Score в рейтинге (4 категории); NULL = нет данных (tri-state)
  coverage_rating REAL NOT NULL,
  total_full INTEGER,             -- полный Score (6 категорий, кап 49); NULL = нет данных
  coverage_full REAL NOT NULL,
  categories TEXT NOT NULL,       -- JSON: все 6 категорий → {score|NULL, submetrics, stale}
  no_data TEXT NOT NULL,          -- JSON: список no-data причин
  stale TEXT NOT NULL,            -- JSON: список stale-фактов (bad-channel, §5.6)
  computed_at TEXT NOT NULL,
  derived TEXT,                   -- JSON DerivedMetrics (v1.3)
  code_empty INTEGER,             -- Score 0 «проекта нет» (v1.4)
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
  source TEXT NOT NULL DEFAULT 'rule', -- rule|llm
  channel TEXT,               -- cicd | appsec | NULL = публичное правило (фильтр по доступу зрителя, v1.5)
  PRIMARY KEY (scan_id, model_version, rule_id)
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
  trigger TEXT NOT NULL DEFAULT 'periodic', -- periodic|user|probe
  user_id INTEGER,              -- автор скана (users.id); NULL = периодика/серверный токен (v1.5, К3)
  rating_eligible INTEGER NOT NULL DEFAULT 0, -- 1 = скан пригоден для рейтинга (ratingEligible; пишет скор-хук)
  public_status TEXT            -- статус по фактам PUBLIC_KINDS (Ф1.11): показывается всем
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
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|refused (refused = отказанная предпроверка PAT, Ф1.6)
  claimed_at TEXT,
  lease_until TEXT,             -- механика claim-loop (В4): NULL-lease матчится
  user_id INTEGER,              -- автор заявки (users.id): его PAT; NULL = периодика
  trigger_kind TEXT NOT NULL DEFAULT 'periodic', -- periodic|user
  attempts INTEGER NOT NULL DEFAULT 0, -- +1 при claim; предел Config.queue.maxAttempts (v1.5, К4)
  created_at TEXT               -- время постановки: лимит частоты юзерских заявок (v1.5, К4)
);
${RECOMMENDATIONS_DDL}
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  ya_id TEXT NOT NULL UNIQUE,   -- Я ID (строка: платформа отдаёт число)
  login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,  -- sha256 случайного токена из cookie
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL      -- истёкшая сессия = аноним
);
CREATE TABLE IF NOT EXISTS user_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  pat_enc TEXT NOT NULL,        -- AES-256-GCM: iv|ciphertext|tag (base64)
  checked_at TEXT NOT NULL,     -- последняя живая проверка GET /user
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  scan TEXT NOT NULL,           -- JSON; бюджеты скана из GUI удалены (К5 В4.1), таблица оставлена под В5
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,         -- schema_version | derived_version (Ф1.9)
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_unclaimed ON jobs(claimed_at) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_repos_language ON repos(language);
CREATE INDEX IF NOT EXISTS idx_scores_repo ON scores(repo_id, model_version);
`;

// индексы колонок, которых у старых БД ещё нет в момент SCHEMA: создаются после миграций
const LATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repo_id, id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_claimed ON jobs(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_claimed ON jobs(user_id, claimed_at);
`;

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Добавить колонку, если таблица старой формы уже существует без неё; true = добавлена. */
function ensureColumn(db: Database, table: string, column: string, ddlType: string): boolean {
  if (!columnsOf(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
    return true;
  }
  return false;
}

/** "1.10" > "1.6": посегментное числовое сравнение версий схемы. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function getMetaValue(db: Database, key: string): string | null {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!exists) return null;
  return (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

export function setMetaValue(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function openDb(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "repo-health.db"), { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  // Ф1.9: БД мигрирована более новым кодом — этот процесс её не трогает
  // (сценарий «старый процесс на той же БД», инцидент 16.09)
  const stored = getMetaValue(db, "schema_version");
  if (stored !== null && compareVersions(stored, SCHEMA_VERSION) > 0) {
    db.close();
    throw new Error(
      `database schema v${stored} is newer than this code (v${SCHEMA_VERSION}): stop this process and run the current code (${config.dataDir})`,
    );
  }
  db.exec("PRAGMA journal_mode = WAL;");
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
  // v1.2 → v1.3: derived-метрики строки скоров (NULL у строк старых
  // прогонов — пересчёт scripts/score.ts заполняет последний скан)
  ensureColumn(db, "scores", "derived", "TEXT");
  // v1.4 → v1.5 (В4.1): scores с двумя итогами, recommendations с каналом —
  // производные таблицы пересоздаются (данные восстанавливает rescore-m4.ts)
  if (!columnsOf(db, "scores").has("total_rating") || !columnsOf(db, "recommendations").has("channel")) {
    db.exec("DROP TABLE IF EXISTS scores");
    db.exec("DROP TABLE IF EXISTS recommendations");
    db.exec(SCORES_DDL);
    db.exec(RECOMMENDATIONS_DDL);
    db.exec("CREATE INDEX IF NOT EXISTS idx_scores_repo ON scores(repo_id, model_version)");
  }
  ensureColumn(db, "scans", "user_id", "INTEGER");
  // В4.1-fix (К-Ф1.1): пригодность — тем же правилом, что скор-хук, одним UPDATE
  if (ensureColumn(db, "scans", "rating_eligible", "INTEGER NOT NULL DEFAULT 0")) {
    db.exec(`UPDATE scans SET rating_eligible = CASE WHEN ${ratingEligibleSql("scans")} THEN 1 ELSE 0 END`);
  }
  // В4.1-fix (Ф1.11): публичный статус по фактам
  if (ensureColumn(db, "scans", "public_status", "TEXT")) {
    db.exec(`UPDATE scans SET public_status = ${publicStatusSql("scans")}`);
  }
  // v1.3 → v1.4 (В4): изоляция own/public и эвикция
  ensureColumn(db, "repos", "rating_active", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "repos", "visibility", "TEXT NOT NULL DEFAULT 'public'");
  ensureColumn(db, "repos", "evict_reason", "TEXT");
  ensureColumn(db, "jobs", "user_id", "INTEGER");
  ensureColumn(db, "jobs", "trigger_kind", "TEXT NOT NULL DEFAULT 'periodic'");
  // v1.5 (В4.1, К4): попытки и время постановки
  ensureColumn(db, "jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "jobs", "created_at", "TEXT");
  ensureColumn(db, "scores", "code_empty", "INTEGER");
  // v1.4: jobs UNIQUE(repo_id) (В1) мешает очереди — свой и публичный
  // скан одного репо стоят одновременно; очередь пересоздаём без UNIQUE
  // (строки jobs транзитны, данные не теряются: scans/scores независимы)
  const jobsDdl = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string } | null)?.sql ?? "";
  if (jobsDdl.includes("UNIQUE")) {
    db.exec("ALTER TABLE jobs RENAME TO jobs_v1_rebuild");
    db.exec(SCHEMA); // создаёт новую jobs без UNIQUE + индексы
    db.exec("INSERT INTO jobs (repo_id, status, claimed_at, lease_until) SELECT repo_id, status, claimed_at, lease_until FROM jobs_v1_rebuild");
    db.exec("DROP TABLE jobs_v1_rebuild");
  }
  db.exec(LATE_INDEXES);
  setMetaValue(db, "schema_version", SCHEMA_VERSION);
  return db;
}
