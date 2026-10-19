// Пересчет сканов текущей моделью — одна функция для скрипта scripts/rescore-m4.ts,
// старта сервера и фонового тика воркера. Каждый завершенный скан → compute на его
// собственную дату (now = finished_at ?? started_at) + recommend + rating_eligible
// (то же правило, что у скор-хука и миграции); running/queued пропускаются. Сети нет.
//
// Ошибка одного скана (битые данные) логируется и считается, пересчет идет дальше;
// ошибка схемы (SQLiteError: нет таблицы/колонки) фатальна: пересчет
// останавливается, derived_version не пишется.
//
// Стартовый пересчет идет АСИНХРОННО после поднятия порта, батчами по водяному
// знаку scan_id: прогресс сохраняется в meta после каждого батча (рестарт
// продолжает с курсора), running-флаг и ошибка — тоже в meta, чтобы web-роль
// показала их в /api/health. Пересчет исполняют только роли rating/all.
// SQLITE_BUSY не фатален: busy_timeout 15 c + до 3 повторов батча с бэкоффом.
// Схемная ошибка останавливает проход без derived_version, но процесс с поднятым
// портом не роняет — иначе деплой ушел бы в crash-loop.
// Во время прохода рейтинг фильтрует по model_version: непересчитанные сканы
// не участвуют, а не показываются мусором. Синхронный rescoreAll — для скриптов.
import type { Database } from "bun:sqlite";
import { SQLiteError } from "bun:sqlite";
import { compute, migrateEligibility, ratingEligible, writeScores, type Scores } from "./compute";
import { MODEL_VERSION } from "./model";
import { recommend, writeRecommendations } from "./recommend";
import { DB_BUSY_TIMEOUT_MS, getMetaValue, setMetaValue } from "../db";

/**
 * Версия производных данных (scores/recommendations/rating_eligible). Повышается,
 * когда меняется форма хранимых оценок при неизменной MODEL_VERSION: хранимое
 * значение в meta станет старее кода, и первый старт пересчитает все сканы.
 * 7 — тексты рекомендаций AppSec (потолок итога назван один раз).
 */
export const DERIVED_VERSION = 7;

/** Порция фонового пересчета истории за тик воркера (≈25 мс на скан). */
export const HISTORY_RESCORE_BATCH = 20;

const HISTORY_CURSOR = "history_rescore_cursor";

/** Порция асинхронного стартового прохода. */
export const RESCORE_BATCH = 50;

/** Watermark scan_id пройденного батчами (пишется после каждого батча). */
export const RESCORE_CURSOR = "derived_rescore_cursor";
/**
 * Под какую MODEL_VERSION пройден водяной знак. Без этой метки смена версии
 * незаметна пересчету: знак уже стоит на последнем скане, одна свежая строка
 * новой версии гасит проверку «строк модели нет» — и рейтинг текущей версии пуст.
 */
export const RESCORE_MODEL = "derived_rescore_model";

/**
 * Есть ли оценки прежней версии модели без пары в текущей. Метка RESCORE_MODEL —
 * быстрый путь: совпала с MODEL_VERSION — проверять нечего. Иначе решают данные,
 * а не метка (старые базы и тестовые БД метки не знают).
 */
export function modelStale(db: Database): boolean {
  if (getMetaValue(db, RESCORE_MODEL) === MODEL_VERSION) return false;
  return (
    db
      .query(
        `SELECT 1 FROM scores s WHERE s.model_version <> ?
           AND NOT EXISTS (SELECT 1 FROM scores c WHERE c.scan_id = s.scan_id AND c.model_version = ?) LIMIT 1`,
      )
      .get(MODEL_VERSION, MODEL_VERSION) !== null
  );
}

/**
 * Флаг «проход идет» (виден всем процессам): значение — ISO-метка последнего
 * сердцебиения, обновляется после каждого батча. Метка умершего процесса стареет,
 * и после RESCORE_HEARTBEAT_STALE_MS health перестает говорить «идет».
 */
export const RESCORE_RUNNING = "derived_rescore_running";
export const RESCORE_HEARTBEAT_STALE_MS = 10 * 60_000;

/** Последняя схемная ошибка прохода (пусто = проход не падал). */
export const RESCORE_ERROR = "derived_rescore_error";

/** BUSY по коду ошибки, а не по тексту сообщения; текст — только запасной путь без кода. */
export function isBusyError(e: unknown): boolean {
  if (!(e instanceof SQLiteError)) return false;
  const code = (e as { code?: string }).code ?? "";
  return code.startsWith("SQLITE_BUSY") || (!code && /database is locked/i.test(e.message));
}

export interface RescoreOptions {
  /** лог прогресса (сервер — console.log) */
  log?: (message: string) => void;
  /** шаг лога прогресса, сканов */
  progressEvery?: number;
  /** не писать в БД (скрипт --dry) */
  dry?: boolean;
  /** "all" — вся история (скрипт, дефолт); "startup" — у каждого репо последний пригодный для рейтинга,
   *  последний завершенный и последний не-bad приватного, остальная история — фоном */
  scope?: "all" | "startup";
  /** на каждый пересчитанный скан (скрипт печатает строку) */
  onScan?: (scan: { id: number; repoId: number; slug: string }, scores: Scores, eligible: boolean) => void;
}

export interface RescoreResult {
  scans: number;
  skipped: number;
  ratingScored: number;
  ratingNull: number;
  eligible: number;
  /** ошибки отдельных сканов (данные) — пересчёт продолжился */
  errors: number;
  /** ошибки схемы — пересчёт остановлен, derived_version не записан */
  fatal: number;
}

/**
 * Нужен ли пересчет при старте: derived_version БД старее кода, нет строк текущей
 * модели, есть следы старого процесса или водяной знак не догнал последний скан.
 */
export function needsRescore(db: Database): boolean {
  const stored = Number(getMetaValue(db, "derived_version") ?? "0");
  if (!Number.isFinite(stored) || stored < DERIVED_VERSION) return true;
  const scans = (db.query("SELECT COUNT(*) AS c FROM scans WHERE status NOT IN ('running', 'queued')").get() as { c: number }).c;
  if (scans === 0) return false;
  if (modelStale(db)) return true;
  const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
  if (rows === 0) return true;
  // следы старого процесса — завершенные сканы без public_status
  const legacy = db.query("SELECT 1 FROM scans WHERE public_status IS NULL AND status NOT IN ('running', 'queued') LIMIT 1").get();
  if (legacy !== null) return true;
  // курсор не догнал max(scan_id) — проход не закончен (рестарт посреди него).
  // Считаются только ЗАВЕРШЕННЫЕ сканы: running в MAX(id) заставлял бы рестарт при
  // непустой очереди мигать «rescore pending», а running оценит свой скор-хук.
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans WHERE status NOT IN ('running', 'queued')").get() as { m: number }).m;
  if (cursor < maxId) return true;
  // знак перешагнул идущий скан, а тот завершился без своей оценки — проход
  // обязан его досчитать
  return hasFinishedDeferred(db);
}

/** Прогресс асинхронного прохода для /api/health (из meta, виден всем процессам). */
export interface RescoreState {
  running: boolean;
  /** watermark scan_id пройденного */
  done: number;
  /** max(scan_id) — цель прохода */
  total: number;
  /** последняя схемная ошибка прохода; null = не падал */
  error: string | null;
}

export function rescoreState(db: Database): RescoreState {
  const total = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans").get() as { m: number }).m;
  const done = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  const heartbeat = getMetaValue(db, RESCORE_RUNNING);
  const stamp = heartbeat === null ? Number.NaN : Date.parse(heartbeat);
  const running = Number.isFinite(stamp) && Date.now() - stamp < RESCORE_HEARTBEAT_STALE_MS;
  return { running, done, total, error: getMetaValue(db, RESCORE_ERROR) };
}

/**
 * Скор-хук продвигает водяной знак: скан только что получил оценки, и если
 * под курсором не осталось непройденного, курсор можно поднять до него —
 * иначе needsRescore висел бы «недогнанным» до следующего старта. Между
 * курсором и сканом есть непройденные завершённые сканы — знак не двигается:
 * их посчитает проход (батч/старт), прыжок через них потерял бы их навсегда.
 */
export function bumpRescoreCursor(db: Database, scanId: number): void {
  // скан оценен своим хуком — из отложенных он уходит
  undeferScan(db, scanId);
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  if (scanId <= cursor) return;
  const unprocessed = db
    .query("SELECT 1 FROM scans WHERE id > ? AND id < ? AND status NOT IN ('running', 'queued') LIMIT 1")
    .get(cursor, scanId);
  if (unprocessed !== null) return;
  // идущие сканы, которые знак перешагивает, не теряются: они отложены до
  // завершения (их оценит либо свой хук, либо проход)
  deferScans(db, (db.query("SELECT id FROM scans WHERE id > ? AND id < ? AND status IN ('running', 'queued')").all(cursor, scanId) as { id: number }[]).map((r) => r.id));
  setMetaValue(db, RESCORE_CURSOR, String(scanId));
}

// ---------- отложенные идущие сканы ----------

/**
 * Водяной знак пересчета минует `running`-сканы в расчете на их собственный
 * скор-хук. Если хук не дошел (процесс умер, хук упал до записи), скан остался бы
 * без оценки навсегда: `needsRescore` уже ложен. Поэтому каждый `running`-скан,
 * который знак перешагнул, записывается сюда (meta, JSON-список id; без DDL):
 * завершенный без оценки пересчитывает проход, оцененный хуком снимает хук.
 */
export const RESCORE_DEFERRED = "derived_rescore_deferred";
const DEFERRED_MAX = 1000;

function readDeferred(db: Database): number[] {
  const raw = getMetaValue(db, RESCORE_DEFERRED);
  if (raw === null) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
}

function writeDeferred(db: Database, ids: number[]): void {
  if (ids.length === 0) db.query("DELETE FROM meta WHERE key = ?").run(RESCORE_DEFERRED);
  else setMetaValue(db, RESCORE_DEFERRED, JSON.stringify(ids.slice(-DEFERRED_MAX)));
}

export function deferScans(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const set = new Set(readDeferred(db));
  let changed = false;
  for (const id of ids) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (changed) writeDeferred(db, [...set].sort((a, b) => a - b));
}

function undeferScan(db: Database, scanId: number): void {
  const list = readDeferred(db);
  if (!list.includes(scanId)) return;
  writeDeferred(db, list.filter((id) => id !== scanId));
}

/** Есть отложенный скан, который уже завершился (его пора оценить). */
function hasFinishedDeferred(db: Database): boolean {
  const list = readDeferred(db);
  if (list.length === 0) return false;
  const row = db
    .query(`SELECT 1 FROM scans WHERE id IN (${list.map(() => "?").join(", ")}) AND status NOT IN ('running', 'queued') LIMIT 1`)
    .get(...list);
  return row !== null;
}

interface ScanRow {
  id: number;
  repo_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  user_id: number | null;
  org_slug: string;
  repo_slug: string;
}

const SCAN_COLS = `s.id, s.repo_id, s.started_at, s.finished_at, s.status, s.user_id, r.org_slug, r.repo_slug`;

const isFatal = (e: unknown): boolean => e instanceof SQLiteError;

/** Ошибка данных → счетчик errors, ошибка схемы → исключение наверх. */
function rescoreScan(db: Database, scan: ScanRow, result: RescoreResult, opts: RescoreOptions, log: (m: string) => void): void {
  if (scan.status === "running" || scan.status === "queued") {
    result.skipped++;
    return;
  }
  try {
    const now = new Date(scan.finished_at ?? scan.started_at);
    const scores = compute(db, scan.id, { now: Number.isNaN(now.getTime()) ? new Date() : now });
    const facts = db.query("SELECT key, status, source, value FROM facts WHERE scan_id = ?").all(scan.id) as {
      key: string;
      status: string;
      source: string;
      value: string;
    }[];
    const eligible = ratingEligible(facts, { status: scan.status, userId: scan.user_id });
    const recs = recommend(db, scan.id, { scores });
    if (!opts.dry) {
      db.transaction(() => {
        writeScores(db, scores);
        writeRecommendations(db, scan.id, scores.modelVersion, recs);
        db.query("UPDATE scans SET rating_eligible = ? WHERE id = ?").run(eligible ? 1 : 0, scan.id);
      })();
    }
    result.scans++;
    if (eligible) result.eligible++;
    if (scores.healthcraftIndex === null) result.ratingNull++;
    else result.ratingScored++;
    opts.onScan?.({ id: scan.id, repoId: scan.repo_id, slug: `${scan.org_slug}/${scan.repo_slug}` }, scores, eligible);
  } catch (e) {
    if (isFatal(e)) throw e;
    result.errors++;
    log(`rescore: scan ${scan.id} (${scan.org_slug}/${scan.repo_slug}) failed: ${String((e as Error).message).slice(0, 160)}`);
  }
}

export function rescoreAll(db: Database, opts: RescoreOptions = {}): RescoreResult {
  const log = opts.log ?? (() => {});
  const every = Math.max(1, opts.progressEvery ?? 200);
  const scope = opts.scope ?? "all";
  const result: RescoreResult = { scans: 0, skipped: 0, ratingScored: 0, ratingNull: 0, eligible: 0, errors: 0, fatal: 0 };
  try {
    // одно правило пригодности для всех сканов и public_status для следов
    // старого процесса — до выбора сканов
    if (!opts.dry) migrateEligibility(db);
    const scans =
      scope === "all"
        ? (db.query(`SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id ORDER BY s.id`).all() as ScanRow[])
        : (db
            .query(
              `SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id
               WHERE s.id IN (
                 SELECT MAX(id) FROM scans WHERE rating_eligible = 1 GROUP BY repo_id
                 UNION SELECT MAX(id) FROM scans WHERE status NOT IN ('running', 'queued') GROUP BY repo_id
                 UNION SELECT MAX(s3.id) FROM scans s3 JOIN repos r3 ON r3.id = s3.repo_id
                       WHERE r3.visibility <> 'public' AND s3.status NOT IN ('bad', 'running', 'queued') GROUP BY s3.repo_id
               )
               ORDER BY s.id`,
            )
            .all() as ScanRow[]);
    const total = scans.length;
    log(`rescore ${MODEL_VERSION} (derived v${DERIVED_VERSION}, ${scope}): ${total} scans${opts.dry ? " (dry)" : ""}`);
    for (const scan of scans) {
      rescoreScan(db, scan, result, opts, log);
      const done = result.scans + result.skipped + result.errors;
      if (done % every === 0) log(`rescore: ${done}/${total}`);
    }
  } catch (e) {
    if (!isFatal(e)) throw e;
    result.fatal++;
    log(`rescore stopped: schema error: ${String((e as Error).message).slice(0, 200)}`);
    return result;
  }
  if (!opts.dry) {
    setMetaValue(db, "derived_version", String(DERIVED_VERSION));
    // синхронный проход (скрипты) закрывает водяной знак целиком;
    // startup-подмножество закрывает читаемые сканы, история — своим курсором
    const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans").get() as { m: number }).m;
    // идущие сканы под знаком — в отложенные (их оценит хук или проход)
    deferScans(db, (db.query("SELECT id FROM scans WHERE status IN ('running', 'queued')").all() as { id: number }[]).map((r) => r.id));
    setMetaValue(db, RESCORE_CURSOR, String(maxId));
    setMetaValue(db, RESCORE_MODEL, MODEL_VERSION);
    // стартовый пересчёт покрыл только читаемые сканы — остальная история фоном
    if (scope === "startup") setMetaValue(db, HISTORY_CURSOR, "0");
    else db.query("DELETE FROM meta WHERE key = ?").run(HISTORY_CURSOR);
  }
  log(
    `rescore done: scans=${result.scans} skipped(running)=${result.skipped} errors=${result.errors} eligible=${result.eligible} rating_scored=${result.ratingScored} rating_null=${result.ratingNull}`,
  );
  return result;
}

/**
 * Фоновый пересчет истории после стартового: следующая
 * порция сканов после курсора; курсор исчерпан — ключ удаляется. Сканы,
 * уже пересчитанные при старте, пересчитываются повторно (идемпотентно).
 * Возвращает число обработанных сканов; 0 — работы нет.
 */
export function rescoreHistoryBatch(db: Database, opts: { limit?: number; log?: (m: string) => void } = {}): number {
  const cursorRaw = getMetaValue(db, HISTORY_CURSOR);
  if (cursorRaw === null) return 0;
  const log = opts.log ?? (() => {});
  const limit = Math.max(1, opts.limit ?? HISTORY_RESCORE_BATCH);
  const scans = db
    .query(`SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id > ? ORDER BY s.id LIMIT ?`)
    .all(Number(cursorRaw) || 0, limit) as ScanRow[];
  const result: RescoreResult = { scans: 0, skipped: 0, ratingScored: 0, ratingNull: 0, eligible: 0, errors: 0, fatal: 0 };
  for (const scan of scans) rescoreScan(db, scan, result, {}, log);
  if (scans.length < limit) {
    db.query("DELETE FROM meta WHERE key = ?").run(HISTORY_CURSOR);
    log("rescore history: done");
  } else {
    setMetaValue(db, HISTORY_CURSOR, String(scans[scans.length - 1]!.id));
  }
  return scans.length;
}

// ---------- асинхронный проход по водяному знаку ----------

export interface CursorBatchResult {
  /** строк пройдено (включая пропущенные running/queued — курсор минует их) */
  processed: number;
  /** true = за курсором сканов больше нет, проход завершён */
  done: boolean;
}

/**
 * Один батч асинхронного прохода: сканы с id > курсора, порцией `limit`,
 * курсор — на последнем пройденном (пишется ВСЕГДА, включая skipped —
 * running-скан посчитает свой скор-хук). Последний неполный батч
 * завершает проход: derived_version пишется здесь, running-флаг и ошибка
 * гасятся, курсор встаёт на max(scan_id). Идемпотентен: вызов при
 * догнанном курсоре — processed 0 без записей, кроме повторной фиксации
 * derived_version.
 */
export function rescoreBatchByCursor(db: Database, opts: { limit?: number; log?: (m: string) => void } = {}): CursorBatchResult {
  const log = opts.log ?? (() => {});
  const limit = Math.max(1, opts.limit ?? RESCORE_BATCH);
  // новая версия модели — знак с начала (кто бы ни вызвал: старт или воркер);
  // метка ставится сразу, чтобы рестарт посреди прохода продолжил с курсора,
  // а не начал заново
  if (getMetaValue(db, RESCORE_MODEL) !== MODEL_VERSION) {
    if (modelStale(db)) {
      setMetaValue(db, RESCORE_CURSOR, "0");
      log(`rescore: model ${MODEL_VERSION} — watermark reset, full history pass`);
    }
    setMetaValue(db, RESCORE_MODEL, MODEL_VERSION);
  }
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  const scans = db
    .query(`SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id > ? ORDER BY s.id LIMIT ?`)
    .all(cursor, limit) as ScanRow[];
  const result: RescoreResult = { scans: 0, skipped: 0, ratingScored: 0, ratingNull: 0, eligible: 0, errors: 0, fatal: 0 };
  // сперва — отложенные сканы, которые уже завершились: знак их перешагнул,
  // собственной оценки у них может не быть
  const healed = healDeferred(db, result, log);
  // схемная ошибка летит из rescoreScan как есть — ее ловит runStartupRescore
  for (const scan of scans) rescoreScan(db, scan, result, {}, log);
  // идущие сканы, которые знак сейчас минует, — в отложенные (не теряются)
  deferScans(db, scans.filter((s) => s.status === "running" || s.status === "queued").map((s) => s.id));
  const done = scans.length < limit;
  if (done) {
    const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans").get() as { m: number }).m;
    setMetaValue(db, RESCORE_CURSOR, String(maxId));
    setMetaValue(db, "derived_version", String(DERIVED_VERSION));
    db.query("DELETE FROM meta WHERE key = ?").run(HISTORY_CURSOR);
    log(
      `rescore pass complete: scans=${result.scans} skipped(running)=${result.skipped} errors=${result.errors} eligible=${result.eligible} rating_scored=${result.ratingScored} rating_null=${result.ratingNull}`,
    );
  } else {
    setMetaValue(db, RESCORE_CURSOR, String(scans[scans.length - 1]!.id));
  }
  void healed; // processed считает только строки за курсором; отложенные учтены в result
  return { processed: scans.length, done };
}

/**
 * Отложенные сканы, которые уже завершились, — оценить (если своей оценки текущей
 * модели нет) и снять с учета; идущие остаются, исчезнувшие снимаются.
 * Возвращает число обработанных завершенных.
 */
function healDeferred(db: Database, result: RescoreResult, log: (m: string) => void): number {
  const list = readDeferred(db);
  if (list.length === 0) return 0;
  const keep: number[] = [];
  let healed = 0;
  for (const id of list) {
    const scan = db.query(`SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id = ?`).get(id) as ScanRow | null;
    if (!scan) continue;
    if (scan.status === "running" || scan.status === "queued") {
      keep.push(id);
      continue;
    }
    const scored = db.query("SELECT 1 FROM scores WHERE scan_id = ? AND model_version = ?").get(id, MODEL_VERSION) !== null;
    if (!scored) {
      rescoreScan(db, scan, result, {}, log);
      log(`rescore: deferred scan ${id} finished without its own score — scored by the pass`);
    }
    healed++;
  }
  writeDeferred(db, keep);
  return healed;
}

/** Исход асинхронного прохода: чем он остановился. */
export type StartupRescoreStop = "done" | "busy" | "error";

export interface StartupRescoreOptions {
  log?: (message: string) => void;
  /** размер батча (тест — мелкие) */
  limit?: number;
  /** пауза между батчами: уступить event loop HTTP и воркеру */
  pauseMs?: number;
  /** окно ожидания блокировки (по умолчанию 15 с; тест — короче) */
  busyTimeoutMs?: number;
  /** шов теста BUSY-политики: подмена одного шага прохода */
  batch?: typeof rescoreBatchByCursor;
}

/**
 * Шаг прохода под BUSY-политикой (busy_timeout уже поднят): не-BUSY ошибка
 * летит наружу, BUSY — до 3 повторов с бэкоффом, дальше `onBusyStop()`.
 * `touch` обновляет сердцебиение ПЕРЕД каждой попыткой: медленный батч из
 * BUSY-ретраев не должен состарить метку за порог health, пока проход жив.
 */
async function busyGuarded<T>(fn: () => T, onBusyStop: () => T, log: (m: string) => void, label: string, touch?: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e)) throw e;
      if (attempt > 3) {
        log(`${label}: repeated SQLITE_BUSY — stopping (cursor/progress kept)`);
        return onBusyStop();
      }
      try {
        touch?.();
      } catch {
        /* свежая метка не важнее самой попытки */
      }
      log(`${label}: SQLITE_BUSY (attempt ${attempt}/3) — backing off`);
      await Bun.sleep(250 * 2 ** (attempt - 1));
    }
  }
}

/**
 * Асинхронный стартовый проход (роли rating/all, после поднятия порта): батчи
 * rescoreBatchByCursor с сердцебиением в meta. BUSY — busy_timeout 15 с + до
 * 3 повторов с бэкоффом (включая записи до цикла), затем стоп с сохраненным
 * курсором (рестарт или тик доберут). Схемная ошибка — стоп с meta
 * derived_rescore_error и БЕЗ derived_version; процесс при этом живет: порт уже
 * обслуживает запросы, и падение увело бы деплой в crash-loop.
 */
export async function runStartupRescore(db: Database, opts: StartupRescoreOptions = {}): Promise<{ stopped: StartupRescoreStop }> {
  const log = opts.log ?? (() => {});
  const batch = opts.batch ?? rescoreBatchByCursor;
  const limit = Math.max(1, opts.limit ?? RESCORE_BATCH);
  const pauseMs = Math.max(0, opts.pauseMs ?? 10);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 15_000))};`);
  } catch {
    /* не вышло — политика ретраев ниже все равно действует */
  }
  try {
    return await startupRescorePass(db, { log, batch, limit, pauseMs });
  } finally {
    // PRAGMA действует на все соединение: 15 с возвращаются к дефолту, иначе
    // остановка по SIGTERM («≤ 5 с») при BUSY могла бы ждать втрое дольше
    try {
      db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    } catch {
      /* соединение уже не живо — восстанавливать нечем */
    }
  }
}

/** Тело стартового прохода (запускается runStartupRescore под его busy_timeout-политикой). */
async function startupRescorePass(
  db: Database,
  pass: { log: (m: string) => void; batch: typeof rescoreBatchByCursor; limit: number; pauseMs: number },
): Promise<{ stopped: StartupRescoreStop }> {
  const { log, batch, limit, pauseMs } = pass;
  const t0 = Date.now();
  // свежее сердцебиение — и на каждой BUSY-попытке (см. busyGuarded)
  const touchHeartbeat = (): void => setMetaValue(db, RESCORE_RUNNING, new Date().toISOString());
  const prelude = await busyGuarded(
    () => {
      db.query("DELETE FROM meta WHERE key = ?").run(RESCORE_ERROR);
      setMetaValue(db, RESCORE_RUNNING, new Date().toISOString());
      return true;
    },
    () => false,
    log,
    "rescore prelude",
    touchHeartbeat,
  );
  if (!prelude) return { stopped: "busy" };
  log(`rescore ${MODEL_VERSION} (derived v${DERIVED_VERSION}): background pass by scan_id watermark, batches of ${limit}`);
  if (!needsRescore(db)) {
    db.query("DELETE FROM meta WHERE key = ?").run(RESCORE_RUNNING);
    log("rescore: nothing to do (cursor caught up)");
    return { stopped: "done" };
  }

  const migrated = await busyGuarded(
    () => {
      migrateEligibility(db);
      return true;
    },
    () => false,
    log,
    "rescore eligibility migration",
    touchHeartbeat,
  );
  if (!migrated) {
    db.query("DELETE FROM meta WHERE key = ?").run(RESCORE_RUNNING);
    return { stopped: "busy" };
  }
  let stopped: StartupRescoreStop = "done";
  try {
    for (;;) {
      const out = await busyGuarded(
        () => batch(db, { limit, log }),
        () => null,
        log,
        "rescore batch",
        touchHeartbeat,
      );
      if (out === null) {
        stopped = "busy";
        break;
      }
      setMetaValue(db, RESCORE_RUNNING, new Date().toISOString());
      if (out.done) break;
      await Bun.sleep(pauseMs);
    }
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 200);
    setMetaValue(db, RESCORE_ERROR, msg);
    log(`rescore stopped: schema error: ${msg}`);
    return { stopped: "error" };
  } finally {
    db.query("DELETE FROM meta WHERE key = ?").run(RESCORE_RUNNING);
  }
  if (stopped === "done") log(`rescore pass finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  return { stopped };
}
