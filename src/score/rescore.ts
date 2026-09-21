// rescore.ts — пересчёт сканов текущей моделью (В4.1-fix, Ф1.9; круг 2,
// LOW-7): одна функция для скрипта scripts/rescore-m4.ts, старта сервера и
// фонового тика воркера. Каждый завершённый скан → compute на его
// собственную дату (now = finished_at ?? started_at) + recommend +
// rating_eligible (то же правило, что скор-хук и миграция); running/queued
// пропускаются. Сети нет.
//
// Круг 2: ошибка одного скана (битые данные) логируется и считается, пересчёт
// идёт дальше; ошибка схемы (SQLiteError: нет таблицы/колонки) — фатальна:
// пересчёт останавливается, derived_version не пишется.
//
// В4.4 (кластер A код-аудита): стартовый рескор — АСИНХРОННО после поднятия
// порта, батчами по watermark scan_id: прогресс персистентен
// (meta.derived_rescore_cursor пишется после каждого батча, рестарт
// продолжает с курсора), running-флаг и ошибка — в meta (кросс-процессно,
// web-роль читает их для /api/health). Рескор исполняют только роли
// rating/all. BUSY-класс (SQLITE_BUSY*) больше не фатален: busy_timeout
// 15 c + до 3 повторов батча с бэкоффом; схемные ошибки по-прежнему
// останавливают проход без derived_version — но процесс с поднятым портом
// не роняют (деплой-гонка «рескор-kill-рескор» умирает вместе с ней).
// Во время прохода рейтинг читает частичное покрытие (фильтр
// model_version в SQL рейтинга): непересчитанные сканы не участвуют, а не
// показываются мусором. Синхронный rescoreAll остаётся для скриптов.
//
// meta.derived_version повышается, когда меняется форма/смысл хранимых
// оценок без смены MODEL_VERSION (1 — Ф1.2/Ф1.12; 2 — круг 2: одно правило
// пригодности со status и С5, повторная миграция); далее Ф2.3.
import type { Database } from "bun:sqlite";
import { SQLiteError } from "bun:sqlite";
import { compute, migrateEligibility, ratingEligible, writeScores, type Scores } from "./compute";
import { MODEL_VERSION } from "./model";
import { recommend, writeRecommendations } from "./recommend";
import { DB_BUSY_TIMEOUT_MS, getMetaValue, setMetaValue } from "../db";

/**
 * Версия производных данных (scores/recommendations/rating_eligible) при
 * неизменной MODEL_VERSION.
 * 3 (В4.2a, Ф2.3): `code_empty` больше не выводится из `loc === 0` — все
 * сохранённые оценки, занулённые ложным «проекта нет», обязаны пересчитаться
 * при первом старте нового кода.
 * 4 (круг 2 В4.2a, К-Р14): `todo_note = "incomplete"` (обрыв cat-file) даёт
 * `old_share` = no-data с причиной — оценки, посчитавшие долю старых
 * маркеров по частичной выборке, пересчитываются (прецедент Ф2.3).
 * 5 (В4.3, Ф3.2): схема 1.9 — scores пересоздан под healthcraft_index без
 * сохранённого полного итога; строки восстанавливаются этим пересчётом.
 */
export const DERIVED_VERSION = 5;

/** Порция фонового пересчёта истории за тик воркера (≈25 мс на скан). */
export const HISTORY_RESCORE_BATCH = 20;

const HISTORY_CURSOR = "history_rescore_cursor";

/** Порция асинхронного стартового прохода (В4.4, кластер A). */
export const RESCORE_BATCH = 50;

/** Watermark scan_id пройденного батчами (пишется после каждого батча). */
export const RESCORE_CURSOR = "derived_rescore_cursor";

/**
 * Флаг «проход идёт» (кросс-процессно): значение — ISO-метка последнего
 * сердцебиения (обновляется после каждого батча). Умерший процесс оставляет
 * метку стареть: RESCORE_HEARTBEAT_STALE_MS — порог, после которого running
 * считается ложным (health не врёт «идёт» про мёртвый проход).
 */
export const RESCORE_RUNNING = "derived_rescore_running";
export const RESCORE_HEARTBEAT_STALE_MS = 10 * 60_000;

/** Последняя схемная ошибка прохода (пусто = проход не падал). */
export const RESCORE_ERROR = "derived_rescore_error";

/** BUSY-класс по коду ошибки (аудит-пара 20.09: не по строке сообщения). */
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
  /** "all" — вся история (скрипт, дефолт); "startup" — P, L и приватный не-bad каждого репо, история — фоном */
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
 * Нужен ли пересчёт при старте: derived_version БД старее кода, нет строк текущей модели, следы старого процесса
 * или (В4.4) водяной знак батчевого прохода не догнал последний скан.
 */
export function needsRescore(db: Database): boolean {
  const stored = Number(getMetaValue(db, "derived_version") ?? "0");
  if (!Number.isFinite(stored) || stored < DERIVED_VERSION) return true;
  const scans = (db.query("SELECT COUNT(*) AS c FROM scans WHERE status NOT IN ('running', 'queued')").get() as { c: number }).c;
  if (scans === 0) return false;
  const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
  if (rows === 0) return true;
  // круг 2 (LOW-10): следы старого процесса — завершённые сканы без public_status
  const legacy = db.query("SELECT 1 FROM scans WHERE public_status IS NULL AND status NOT IN ('running', 'queued') LIMIT 1").get();
  if (legacy !== null) return true;
  // В4.4: курсор не догнал max(scan_id) — проход не закончен (рестарт посреди него).
  // И-4 (круг 2, сознательная семантика): водяной знак считает только
  // ЗАВЕРШЁННЫЕ сканы — в scans статуса queued не бывает (вставка сразу
  // running), источником шума были running-сканы в MAX(id): рестарт при
  // непустой очереди коротко мигал «rescore pending». Running посчитает
  // собственный скор-хук при завершении.
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans WHERE status NOT IN ('running', 'queued')").get() as { m: number }).m;
  if (cursor < maxId) return true;
  // В4.8.5 (К8.5.12, С10-1): знак перешагнул идущий скан, тот завершился без
  // своей оценки — проход обязан его досчитать
  return hasFinishedDeferred(db);
}

/** Прогресс асинхронного прохода для /api/health (кросс-процессно из meta). */
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
  // К8.5.12: этот скан оценён своим хуком — из отложенных он уходит
  undeferScan(db, scanId);
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  if (scanId <= cursor) return;
  const unprocessed = db
    .query("SELECT 1 FROM scans WHERE id > ? AND id < ? AND status NOT IN ('running', 'queued') LIMIT 1")
    .get(cursor, scanId);
  if (unprocessed !== null) return;
  // К8.5.12 (С10-1): идущие сканы, которые знак перешагивает, не теряются —
  // они отложены до завершения (их либо оценит свой хук, либо проход)
  deferScans(db, (db.query("SELECT id FROM scans WHERE id > ? AND id < ? AND status IN ('running', 'queued')").all(cursor, scanId) as { id: number }[]).map((r) => r.id));
  setMetaValue(db, RESCORE_CURSOR, String(scanId));
}

// ---------- В4.8.5 (К8.5.12, С10-1): отложенные идущие сканы ----------

/**
 * Водяной знак пересчёта минует `running`-сканы в расчёте на их собственный
 * скор-хук. Если хук не дошёл (процесс умер, хук упал до записи), скан
 * остаётся без оценки навсегда: `needsRescore` уже ложен. Поэтому каждый
 * `running`-скан, который знак перешагнул, записывается сюда (meta, JSON-список
 * id; без DDL) и остаётся до завершения: завершённый без оценки — пересчитывается
 * проходом, оценённый хуком — снимается хуком.
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

/** Пересчёт одного скана; ошибка данных → счётчик errors, ошибка схемы → исключение наверх. */
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
    // круг 2 (LOW-1/LOW-10): одно правило пригодности для всех сканов и
    // public_status следов старого процесса — до выбора P
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
    // В4.4: синхронный проход (скрипты) закрывает водяной знак целиком;
    // startup-подмножество закрывает читаемые сканы, история — своим курсором
    const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans").get() as { m: number }).m;
    // К8.5.12: идущие сканы под знаком — в отложенные (их оценит хук или проход)
    deferScans(db, (db.query("SELECT id FROM scans WHERE status IN ('running', 'queued')").all() as { id: number }[]).map((r) => r.id));
    setMetaValue(db, RESCORE_CURSOR, String(maxId));
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
 * Фоновый пересчёт истории после стартового (круг 2, LOW-7): следующая
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

// ---------- В4.4 (кластер A): асинхронный проход по водяному знаку ----------

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
  const cursor = Number(getMetaValue(db, RESCORE_CURSOR) ?? "0") || 0;
  const scans = db
    .query(`SELECT ${SCAN_COLS} FROM scans s JOIN repos r ON r.id = s.repo_id WHERE s.id > ? ORDER BY s.id LIMIT ?`)
    .all(cursor, limit) as ScanRow[];
  const result: RescoreResult = { scans: 0, skipped: 0, ratingScored: 0, ratingNull: 0, eligible: 0, errors: 0, fatal: 0 };
  // В4.8.5 (К8.5.12, С10-1): сперва — отложенные идущие сканы, которые уже
  // завершились: знак их перешагнул, собственной оценки у них может не быть
  const healed = healDeferred(db, result, log);
  // схемная ошибка летит из rescoreScan как есть — runStartupRescore ловит её
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
  void healed; // счётчик прохода — строки за курсором (контракт В4.4); отложенные учтены в result
  return { processed: scans.length, done };
}

/**
 * К8.5.12: отложенные сканы, которые уже завершились, — оценить (если своей
 * оценки текущей модели нет) и снять с учёта; идущие остаются; исчезнувшие
 * снимаются. Возвращает число обработанных завершённых.
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
  /** окно ожидания блокировки (дефолт — контракт кластера A: 15 с; тест — короче) */
  busyTimeoutMs?: number;
  /** шов теста BUSY-политики: подмена одного шага прохода */
  batch?: typeof rescoreBatchByCursor;
}

/**
 * Шаг прохода под BUSY-политикой (busy_timeout уже поднят): не-BUSY бросок
 * летит наружу, BUSY — до 3 повторов с бэкоффом, дальше `onBusyStop()`.
 * И-5 (круг 2): `touch` обновляет сердцебиение ПЕРЕД каждой попыткой —
 * патологически медленный батч из BUSY-ретраев не старит метку мимо порога
 * health (RESCORE_HEARTBEAT_STALE_MS), пока проход жив.
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
 * Асинхронный стартовый проход (исполняют роли rating/all после поднятия
 * порта): батчи rescoreBatchByCursor с сердцебиением в meta. BUSY —
 * busy_timeout 15 с + до 3 повторов с бэкоффом (включая предцикловые
 * записи), затем стоп с сохранённым курсором (рестарт/тик доберут);
 * схемная ошибка — стоп с meta derived_rescore_error и БЕЗ derived_version
 * (проход фатален, процесс — нет: порт уже обслуживает запросы,
 * crash-loop деплой-окна исключён).
 */
export async function runStartupRescore(db: Database, opts: StartupRescoreOptions = {}): Promise<{ stopped: StartupRescoreStop }> {
  const log = opts.log ?? (() => {});
  const batch = opts.batch ?? rescoreBatchByCursor;
  const limit = Math.max(1, opts.limit ?? RESCORE_BATCH);
  const pauseMs = Math.max(0, opts.pauseMs ?? 10);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 15_000))};`);
  } catch {
    /* выше пола не бывает — политика ретраев ниже всё равно стоит */
  }
  try {
    return await startupRescorePass(db, { log, batch, limit, pauseMs });
  } finally {
    // З5 (круг 2 В4.4): PRAGMA пер-коннектная — проход, поднявший 15 с, не оставляет
    // её навсегда: дефолт соединения восстанавливается, контракт SIGTERM «≤ 5 с»
    // держится (иначе returnOwnRunningJobs при BUSY мог ждать втрое дольше)
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
  // И-5 (круг 2): свежее сердцебиение — и на каждой BUSY-попытке (см. busyGuarded)
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
