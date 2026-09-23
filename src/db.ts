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
// Схема v1.7 (В4.2-port-fix, П8): портовые объекты — favorites и jobs.error —
// получили свою версию схемы (порты меняли схему под версией 1.6), а
// setMetaValue(schema_version) переехал ПОСЛЕ всех DDL и ensureColumn.
// Схема v1.9 (В4.3): scores — производная таблица публичного индекса
// (healthcraft_index/index_coverage); полный итог не хранится.
// Схема v2.0 (В5, Б1): ai_notes — ЕДИНСТВЕННАЯ невосстановимая таблица
// (тексты LLM, append на скан — исходная, не производная; входит в
// бэкап-дисциплину наравне с facts); scans.head_sha (git-коллектор знает HEAD —
// честная привязка «на каком коммите измерено»); jobs.kind ('scan' | 'summary',
// дефолт 'scan' — старые строки не тронуты). Миграция аддитивная, процедура 1.3.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { PAT_V2_PREFIX, reencryptPat } from "./auth/pat";
import { publicStatusSql, ratingEligibleSql } from "./score/compute";

/**
 * Версия схемы этого кода (Ф1.9): meta.schema_version.
 * 1.7 (В4.2-port-fix, П8/LOW-2): порты изменили схему, не подняв версию —
 * `favorites` и `jobs.error` появились при версии 1.6, и страж «БД новее
 * кода» к портовой миграции был слеп.
 * 1.8 (В4.2a): `scans.status_detail` (Ф2.2 — причина закрытия осиротевшего
 * скана) и пересборка индексов `jobs` в транзакции (Ф2.11).
 * 1.9 (В4.3, Ф3.2/Ф3.3): `scores` хранит ТОЛЬКО публичный показатель —
 * `healthcraft_index`/`index_coverage` (HealthCraft Index, 4 категории);
 * сохранённого полного итога (total_full/coverage_full) и JSON markers нет —
 * полный Repo Health Score — дериватив показанных категорий, считается на
 * чтении. Таблица производная: миграция пересоздаёт её пустой, строки
 * восстанавливает rescoreAll из facts; старые totals не копируются как
 * источник.
 * 2.0 (В5, Б1): `ai_notes` (append-история LLM-текстов: строка на роль на
 * скан, не upsert — пользователь видит эволюцию взглядов; единственная
 * исходная невосстановимая таблица проекта), `scans.head_sha`,
 * `jobs.kind`. Всё аддитивно, данных не теряет.
 * 2.1 (23.09, Алексей): `ai_fails` — честный отказ роли: причина
 * несформирования показывается пользователю, а не молчит в логах.
 */
export const SCHEMA_VERSION = "2.1";

const AI_NOTES_DDL = `CREATE TABLE IF NOT EXISTS ai_notes (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  role TEXT NOT NULL,             -- хартия-роль В5 (documentation..flagger)
  text TEXT NOT NULL,             -- валидированный текст; флаг фрода — мини-JSON
  fact_refs TEXT NOT NULL,        -- JSON: ключи фактов, к которым привязаны утверждения
  charter_version TEXT NOT NULL,  -- версия хартии, по которой сгенерировано
  model TEXT NOT NULL,            -- модель (main/side производная роли)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_notes_scan ON ai_notes(scan_id);
CREATE INDEX IF NOT EXISTS idx_ai_notes_repo ON ai_notes(repo_id, id);

-- 2.1 (23.09, Алексей): честный отказ роли — причина видна пользователю
CREATE TABLE IF NOT EXISTS ai_fails (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  role TEXT NOT NULL,             -- хартия-роль, которая не сформировалась
  reason TEXT NOT NULL,           -- причина (валидатор/модель/нет фактов)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_fails_scan ON ai_fails(scan_id);`;

const AI_FAILS_DDL = `CREATE TABLE IF NOT EXISTS ai_fails (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  role TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_fails_scan ON ai_fails(scan_id);`;

const SCORES_DDL = `CREATE TABLE IF NOT EXISTS scores (
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  model_version TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  healthcraft_index INTEGER,      -- HealthCraft Index (4 категории); NULL = нет данных (tri-state)
  index_coverage REAL NOT NULL,
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
  public_status TEXT,           -- статус по фактам PUBLIC_KINDS (Ф1.11): показывается всем
  status_detail TEXT,           -- 'orphaned' — скан закрыт свипом сирот (v1.8, Ф2.2)
  head_sha TEXT                 -- git HEAD клона (v2.0): «на каком коммите измерено»
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
${AI_NOTES_DDL}
${AI_FAILS_DDL}
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|refused (refused = отказанная предпроверка PAT, Ф1.6)
  claimed_at TEXT,
  lease_until TEXT,             -- механика claim-loop (В4): NULL-lease матчится
  user_id INTEGER,              -- автор заявки (users.id): его PAT; NULL = периодика
  trigger_kind TEXT NOT NULL DEFAULT 'periodic', -- periodic|user
  kind TEXT NOT NULL DEFAULT 'scan', -- scan | summary (v2.0): summary = AI-генерация по последнему скану
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
-- П12 (Н-3, круг 2 В4.2-port-fix): гард ночного обхода спрашивает про ЖИВУЮ
-- job каждого репо каталога. Без своего индекса SQLite брал
-- idx_jobs_status_claimed и просматривал все queued/running строки на каждый
-- репо: ~2,0 мс на вызов, на масштабе каталога ≈ 55 с синхронного блока за
-- обход (event loop не отпускается — тиков таймера ноль). Индекс дополняет
-- idx_jobs_status_claimed, а не заменяет его.
CREATE INDEX IF NOT EXISTS idx_jobs_repo_status ON jobs(repo_id, status);
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

/** Дефолт ожидания блокировки на соединении (был литералом здесь). З5 круга 2
 *  В4.4: поднявший 15 с проход рескора обязан восстанавливать этот дефолт —
 *  контракт SIGTERM «≤ 5 с» иначе нарушаем. */
export const DB_BUSY_TIMEOUT_MS = 5_000;

export function openDb(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "repo-health.db"), { create: true });
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
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
  // В4.4 (кластер A, Прод-С3 код-аудита): вся миграция — ОДНА транзакция
  // (DDL в SQLite транзакционен). Параллельный старт двух ролей на переходе
  // версии больше не может оставить базу полумигрированной: либо все DDL и
  // schema_version, либо ничего. PRAGMA journal_mode — снаружи (в транзакции
  // no-op); вложенные db.transaction (П11, Ф2.11) становятся сейвпоинтами.
  db.transaction(() => {
    db.exec(SCHEMA);
    // v1.1 → v1.2: repos-колонки В2 (forks/reaction_counts)
    ensureColumn(db, "repos", "forks", "INTEGER");
    ensureColumn(db, "repos", "reaction_counts", "TEXT");
    // старые формы производных таблиц пересоздаются: v1.1 scores был
    // PK(scan_id) + formula_version; v1.1 recommendations — без model_version.
    // v1.9 (В4.3, Ф3.2): scores без healthcraft_index (включая формы с
    // сохранённым total_rating/total_full вплоть до 1.8) пересоздаётся —
    // производная таблица, строки восстанавливает rescoreAll из facts;
    // старые totals источником не служат (полный итог — дериватив показа).
    if (!columnsOf(db, "scores").has("healthcraft_index")) {
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
    // v1.4 → v1.5 (В4.1): recommendations с каналом — производная таблица,
    // пересоздаётся (данные восстанавливает rescore-m4.ts)
    if (!columnsOf(db, "recommendations").has("channel")) {
      db.exec("DROP TABLE IF EXISTS recommendations");
      db.exec(RECOMMENDATIONS_DDL);
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
    // v1.8 (В4.2a, Ф2.2): чем закрыт скан, если закрыт не собой — 'orphaned'
    ensureColumn(db, "scans", "status_detail", "TEXT");
    // v2.0 (В5, Б1): привязка скана к коммиту; kind заявки (старые строки — 'scan')
    ensureColumn(db, "scans", "head_sha", "TEXT");
    ensureColumn(db, "jobs", "kind", "TEXT NOT NULL DEFAULT 'scan'");
    // v1.3 → v1.4 (В4): изоляция own/public и эвикция
    ensureColumn(db, "repos", "rating_active", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "repos", "visibility", "TEXT NOT NULL DEFAULT 'public'");
    ensureColumn(db, "repos", "evict_reason", "TEXT");
    // В4.5 (17.09): аватары — logo.url репозитория и портрет Я ID пользователя;
    // колонки аддитивные (старый код их не читает), версия схемы не меняется
    ensureColumn(db, "repos", "logo_url", "TEXT");
    ensureColumn(db, "repos", "language_color", "TEXT");
    ensureColumn(db, "users", "display_name", "TEXT");
    ensureColumn(db, "users", "avatar_id", "TEXT");
    ensureColumn(db, "jobs", "user_id", "INTEGER");
    ensureColumn(db, "jobs", "trigger_kind", "TEXT NOT NULL DEFAULT 'periodic'");
    // П11 (Н-2, круг 2 В4.2-port-fix): бэкфилл признака полосы. Колонку добавили
    // с DEFAULT 'periodic', и у строк, созданных ДО неё, `user_id IS NOT NULL`
    // соседствует с `trigger_kind = 'periodic'`. На «единый признак полосы»
    // (П8) опираются гард ночного обхода и retry-failed: без бэкфилла живая
    // legacy-юзерская job навсегда блокировала бы периодику по своему репо и
    // читалась бы как последняя периодическая. Согласованность обеспечивает
    // миграция, а не только вставка `enqueueScan`.
    // Ф2.18 (хвост приёмки В4.2-port-fix): бэкфилл — ОДНОРАЗОВАЯ миграция, а не
    // работа каждого `openDb`. Полный UPDATE по всей очереди выполнялся при
    // каждом открытии БД (на живой базе это десятки тысяч строк на старте
    // каждого процесса и каждого теста). Условие — переход версии схемы:
    // legacy-БД без версии или версия МЛАДШЕ текущей (переход < 1.8).
    // Транзакция своя, до записи версии (её пишет `setMetaValue`
    // последней строкой функции).
    if (stored === null || compareVersions(stored, SCHEMA_VERSION) < 0) {
      db.transaction(() => {
        db.exec("UPDATE jobs SET trigger_kind = 'user' WHERE user_id IS NOT NULL AND trigger_kind <> 'user'");
      })();
    }
    // v1.5 (В4.1, К4): попытки и время постановки
    ensureColumn(db, "jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "jobs", "created_at", "TEXT");
    ensureColumn(db, "scores", "code_empty", "INTEGER");
    // v1.4: jobs UNIQUE(repo_id) (В1) мешает очереди — свой и публичный
    // скан одного репо стоят одновременно; очередь пересоздаём без UNIQUE
    // (строки jobs транзитны, данные не теряются: scans/scores независимы)
    // Ф2.11 (LOW-1): пересборка ЦЕЛИКОМ в транзакции, а индексы старой таблицы
    // сносятся ДО `RENAME`. SQLite переносит индексы вместе с переименованной
    // таблицей: `CREATE INDEX IF NOT EXISTS` из SCHEMA видел занятые имена и
    // молча пропускал создание, а `DROP TABLE jobs_v1_rebuild` уносил индексы
    // с собой — новая `jobs` оставалась без idx_jobs_unclaimed и idx_jobs_claim.
    // Без транзакции обрыв посреди пересборки оставлял базу без очереди вовсе.
    const jobsDdl = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string } | null)?.sql ?? "";
    if (jobsDdl.includes("UNIQUE")) {
      db.transaction(() => {
        for (const idx of db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL").all() as { name: string }[]) {
          db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        }
        db.exec("ALTER TABLE jobs RENAME TO jobs_v1_rebuild");
        db.exec(SCHEMA); // создаёт новую jobs без UNIQUE + индексы
        db.exec("INSERT INTO jobs (repo_id, status, claimed_at, lease_until) SELECT repo_id, status, claimed_at, lease_until FROM jobs_v1_rebuild");
        db.exec("DROP TABLE jobs_v1_rebuild");
      })();
    }
    db.exec(LATE_INDEXES);
    // ПОРТ 5 (hq-parallel): панель заданий (jobs.error — причина падения)
    // и избранное (сейвить что угодно строкой слага; права-ряд по факту)
    ensureColumn(db, "jobs", "error", "TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id),
      org_slug TEXT NOT NULL,
      repo_slug TEXT NOT NULL,
      added_at TEXT NOT NULL,
      last_access TEXT,
      last_checked_at TEXT,
      UNIQUE(user_id, org_slug, repo_slug)
    )`);
    // Ф2.8 (В4.2b): перешифровка PAT на ключ HKDF — ИДЕМПОТЕНТНО. Строки
    // без префикса `v2:` расшифровываются прежним ключом sha256 и
    // перезаписываются на `v2:` (HKDF); нерасшифровываемые (секрет сменился,
    // данные повреждены) НЕ трогаются — их честно объявит patReadable. Без
    // appSecret (сессии выключены) проход не выполняется вовсе.
    if (config.auth.appSecret) {
      const legacyRows = db
        .query("SELECT user_id, pat_enc FROM user_tokens WHERE pat_enc IS NOT NULL")
        .all() as { user_id: number; pat_enc: string }[];
      for (const row of legacyRows) {
        if (row.pat_enc.startsWith(PAT_V2_PREFIX)) continue;
        const next = reencryptPat(config.auth.appSecret, row.pat_enc);
        if (next !== null) db.query("UPDATE user_tokens SET pat_enc = ? WHERE user_id = ?").run(next, row.user_id);
      }
    }
    // П8 (LOW-2): версия схемы пишется ПОСЛЕДНЕЙ — после всех DDL, миграций и
    // ensureColumn. Порты оставили её перед портовыми объектами, и обрыв между
    // ними помечал БД версией без этих объектов; теперь «версия = 1.7» означает,
    // что favorites и jobs.error в базе действительно есть. В4.4: внутри общей
    // транзакции — атомарно с самими DDL.
    setMetaValue(db, "schema_version", SCHEMA_VERSION);
  })();
  return db;
}
