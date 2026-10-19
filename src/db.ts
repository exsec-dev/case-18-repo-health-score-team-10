// SQLite (bun:sqlite) — единственное хранилище: собранные факты, история
// сканов, очередь заданий, оценки и рекомендации, пользователи Я ID, сессии,
// PAT и AI-тексты. Tri-state в NULL-семантике: оценка NULL = «нет данных», а не
// «плохо».
// Производные таблицы (scores, recommendations) при смене формы пересоздаются,
// строки восстанавливает пересчет из facts. Остальное мигрирует только
// аддитивно; ai_notes — единственная невосстановимая таблица (тексты LLM),
// ее бэкап так же важен, как бэкап facts.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { PAT_V2_PREFIX, reencryptPat } from "./auth/pat";
import { publicStatusSql, ratingEligibleSql } from "./score/compute";

/**
 * Версия схемы этого кода, хранится в meta.schema_version. Поднимается при
 * любом изменении схемы: по ней процесс со старым кодом отказывается открывать
 * БД, мигрированную более новым, а одноразовые миграции понимают, что переход
 * еще не выполнялся. ai_notes — append-история: строка на роль на скан, не
 * upsert, чтобы было видно, как менялись выводы.
 */
export const SCHEMA_VERSION = "2.4";

/** Аудитория AI-текста: public — из одних публичных фактов, видна всем; full — по всем фактам скана. */
export type AiAudience = "public" | "full";
export const AI_AUDIENCES: readonly AiAudience[] = ["public", "full"];

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
  head_sha TEXT,                -- git HEAD клона (v2.0): «на каком коммите измерено»
  collector_version INTEGER     -- версия сборщика фактов (v2.2, COLLECTOR_VERSION); NULL — до учета
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
-- v2.4 (В5.5 тур 1): снимок мест публичного рейтинга на UTC-дату — один снимок
-- на дату (идемпотентно), ранг = место в выдаче публичного рейтинга
-- (HealthCraft Index по убыванию, при равенстве org/repo); ретеншен 35 суток —
-- purgeOldRatingSnapshots в часовом обслуживании
CREATE TABLE IF NOT EXISTS rating_snapshots (
  id INTEGER PRIMARY KEY,
  taken_at TEXT NOT NULL,       -- UTC-дата снимка (YYYY-MM-DD)
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  rank INTEGER NOT NULL,        -- место в публичном рейтинге на момент снимка
  score_index REAL NOT NULL     -- HealthCraft Index на момент снимка
);
CREATE INDEX IF NOT EXISTS idx_rating_snapshots_taken ON rating_snapshots(taken_at, repo_id);
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

/** Дефолт ожидания блокировки на соединении. Проход рескора, поднимающий его
 *  до 15 с, обязан вернуть этот дефолт — иначе процесс не уложится в 5 с на
 *  завершение по SIGTERM. */
export const DB_BUSY_TIMEOUT_MS = 5_000;

export function openDb(config: Config): Database {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(join(config.dataDir, "repo-health.db"), { create: true });
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
  // БД мигрирована более новым кодом — этот процесс ее не трогает
  // (старый процесс, оставшийся работать на той же БД)
  const stored = getMetaValue(db, "schema_version");
  if (stored !== null && compareVersions(stored, SCHEMA_VERSION) > 0) {
    db.close();
    throw new Error(
      `database schema v${stored} is newer than this code (v${SCHEMA_VERSION}): stop this process and run the current code (${config.dataDir})`,
    );
  }
  db.exec("PRAGMA journal_mode = WAL;");
  // Только тесты в CI (scripts/ci-test.sh): без fsync на коммит. На медленном
  // диске раннера SourceCraft fsync делал тесты в 20-500 раз дольше, и набор не
  // укладывался в лимит куба. Сервер этот флаг не ставит.
  if (process.env.RH_SQLITE_SYNC_OFF === "1") db.exec("PRAGMA synchronous = OFF;");
  // Вся миграция — одна транзакция (DDL в SQLite транзакционен): параллельный
  // старт двух ролей не оставит базу полумигрированной — либо все DDL и
  // schema_version, либо ничего. PRAGMA journal_mode — снаружи (в транзакции это
  // no-op); вложенные db.transaction становятся сейвпоинтами.
  // Транзакция IMMEDIATE: блокировка записи берется на BEGIN и ждет busy_timeout.
  // С отложенной (deferred) запись schema_version после чужого коммита получала
  // SQLITE_BUSY без ожидания (устаревший снимок), и вторая роль падала на старте.
  const migrate = db.transaction(() => {
    db.exec(SCHEMA);
    ensureColumn(db, "repos", "forks", "INTEGER");
    ensureColumn(db, "repos", "reaction_counts", "TEXT");
    // Старые формы производных таблиц пересоздаются пустыми, строки
    // восстанавливает rescoreAll из facts; старые итоги источником не служат.
    if (!columnsOf(db, "scores").has("healthcraft_index")) {
      db.exec("DROP TABLE IF EXISTS scores");
      db.exec(SCORES_DDL);
    }
    if (!columnsOf(db, "recommendations").has("model_version")) {
      db.exec("DROP TABLE IF EXISTS recommendations");
      db.exec(RECOMMENDATIONS_DDL);
    }
    // derived у строк старых прогонов — NULL, пересчет заполняет последний скан
    ensureColumn(db, "scores", "derived", "TEXT");
    if (!columnsOf(db, "recommendations").has("channel")) {
      db.exec("DROP TABLE IF EXISTS recommendations");
      db.exec(RECOMMENDATIONS_DDL);
    }
    ensureColumn(db, "scans", "user_id", "INTEGER");
    // новые колонки сразу заполняются тем же правилом, что пишет скор-хук
    if (ensureColumn(db, "scans", "rating_eligible", "INTEGER NOT NULL DEFAULT 0")) {
      db.exec(`UPDATE scans SET rating_eligible = CASE WHEN ${ratingEligibleSql("scans")} THEN 1 ELSE 0 END`);
    }
    if (ensureColumn(db, "scans", "public_status", "TEXT")) {
      db.exec(`UPDATE scans SET public_status = ${publicStatusSql("scans")}`);
    }
    ensureColumn(db, "scans", "status_detail", "TEXT");
    ensureColumn(db, "scans", "head_sha", "TEXT");
    // у старых сканов версия сборщика неизвестна — NULL
    ensureColumn(db, "scans", "collector_version", "INTEGER");
    ensureColumn(db, "jobs", "kind", "TEXT NOT NULL DEFAULT 'scan'");
    // старые AI-тексты сгенерированы по всем фактам — отсюда дефолт 'full'
    ensureColumn(db, "ai_notes", "audience", "TEXT NOT NULL DEFAULT 'full'");
    ensureColumn(db, "ai_fails", "audience", "TEXT NOT NULL DEFAULT 'full'");
    ensureColumn(db, "users", "ai_unlock", "TEXT");
    ensureColumn(db, "repos", "rating_active", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "repos", "visibility", "TEXT NOT NULL DEFAULT 'public'");
    ensureColumn(db, "repos", "evict_reason", "TEXT");
    // аватары и подписи: старый код эти колонки не читает, поэтому версия схемы не менялась
    ensureColumn(db, "repos", "logo_url", "TEXT");
    ensureColumn(db, "repos", "language_color", "TEXT");
    // описание из каталога и тематики рейтинга (api/topics.ts, «,bot,web,»):
    // старый код колонки не читает, версия схемы не менялась
    ensureColumn(db, "repos", "description", "TEXT");
    ensureColumn(db, "repos", "topics", "TEXT");
    ensureColumn(db, "users", "display_name", "TEXT");
    ensureColumn(db, "users", "avatar_id", "TEXT");
    // логин SourceCraft владельца токена (из GET /user при сохранении): «Мои
    // репозитории» ставят его пространство первым. Старый код колонку не читает
    ensureColumn(db, "user_tokens", "owner_login", "TEXT");
    ensureColumn(db, "jobs", "user_id", "INTEGER");
    ensureColumn(db, "jobs", "trigger_kind", "TEXT NOT NULL DEFAULT 'periodic'");
    // Бэкфилл признака полосы: колонку добавили с DEFAULT 'periodic', и у старых
    // пользовательских заданий оказалось `trigger_kind = 'periodic'`. На этот
    // признак опираются гард ночного обхода и retry-failed — без бэкфилла такое
    // задание навсегда блокировало бы периодику своего репо. Выполняется один раз,
    // при переходе версии схемы: полный UPDATE очереди на каждом openDb дорог.
    if (stored === null || compareVersions(stored, SCHEMA_VERSION) < 0) {
      db.transaction(() => {
        db.exec("UPDATE jobs SET trigger_kind = 'user' WHERE user_id IS NOT NULL AND trigger_kind <> 'user'");
      })();
    }
    ensureColumn(db, "jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "jobs", "created_at", "TEXT");
    ensureColumn(db, "scores", "code_empty", "INTEGER");
    // Старая jobs с UNIQUE(repo_id) не дает поставить свой и публичный скан
    // одного репо одновременно — очередь пересобирается без UNIQUE (строки jobs
    // транзитны, scans/scores от них не зависят). Индексы старой таблицы сносятся
    // до RENAME: SQLite переносит их вместе с таблицей, CREATE INDEX IF NOT EXISTS
    // видит занятые имена и молча пропускает создание, а DROP старой таблицы уносит
    // индексы с собой. Транзакция — чтобы обрыв не оставил базу без очереди.
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
    // Колонки jobs, которых нет в SCHEMA, добавляются только после пересборки
    // очереди выше: иначе на очень старой базе пересборка из SCHEMA их бы потеряла.
    // Избранное хранит слаг строкой, права проверяются при обращении.
    ensureColumn(db, "jobs", "error", "TEXT");
    // заявка, поставленная с паролем, в общий лимит AI не входит
    ensureColumn(db, "jobs", "audience", "TEXT NOT NULL DEFAULT 'full'");
    ensureColumn(db, "jobs", "ai_unlocked", "INTEGER NOT NULL DEFAULT 0");
    // общий суточный счетчик лимита AI считает по (kind, created_at)
    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_kind_created ON jobs(kind, created_at)");
    db.exec(`CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id),
      org_slug TEXT NOT NULL,
      repo_slug TEXT NOT NULL,
      added_at TEXT NOT NULL,
      last_access TEXT,
      last_checked_at TEXT,
      UNIQUE(user_id, org_slug, repo_slug)
    )`);
    // Идемпотентная перешифровка PAT на ключ HKDF: строки без префикса `v2:`
    // расшифровываются прежним ключом sha256 и перезаписываются как `v2:`.
    // Нерасшифровываемые (секрет сменился, данные повреждены) не трогаются —
    // их объявит patReadable. Без appSecret проход не выполняется.
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
    // Версия схемы пишется последней, после всех DDL и ensureColumn, — тогда
    // записанная версия гарантирует, что все объекты этой версии в базе есть.
    setMetaValue(db, "schema_version", SCHEMA_VERSION);
  });
  migrate.immediate();
  return db;
}
