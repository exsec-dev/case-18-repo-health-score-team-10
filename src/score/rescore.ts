// rescore.ts — пересчёт сканов текущей моделью (В4.1-fix, Ф1.9; круг 2,
// LOW-7): одна функция для скрипта scripts/rescore-m4.ts, старта сервера и
// фонового тика воркера. Каждый завершённый скан → compute на его
// собственную дату (now = finished_at ?? started_at) + recommend +
// rating_eligible (то же правило, что скор-хук и миграция); running/queued
// пропускаются. Сети нет.
//
// Круг 2: ошибка одного скана (битые данные) логируется и считается, пересчёт
// идёт дальше; ошибка схемы (SQLiteError: нет таблицы/колонки) — фатальна:
// пересчёт останавливается, derived_version не пишется. Старт сервера
// пересчитывает только то, что читается сейчас: для каждого репо последний
// пригодный скан P, последний завершённый L и для приватного — последний
// не-bad; остальная история — фоновым тиком воркера по курсору
// meta.history_rescore_cursor (порциями, когда очередь пуста).
//
// meta.derived_version повышается, когда меняется форма/смысл хранимых
// оценок без смены MODEL_VERSION (1 — Ф1.2/Ф1.12; 2 — круг 2: одно правило
// пригодности со status и С5, повторная миграция); далее Ф2.3.
import type { Database } from "bun:sqlite";
import { SQLiteError } from "bun:sqlite";
import { compute, migrateEligibility, ratingEligible, writeScores, type Scores } from "./compute";
import { MODEL_VERSION } from "./model";
import { recommend, writeRecommendations } from "./recommend";
import { getMetaValue, setMetaValue } from "../db";

/**
 * Версия производных данных (scores/recommendations/rating_eligible) при
 * неизменной MODEL_VERSION.
 * 3 (В4.2a, Ф2.3): `code_empty` больше не выводится из `loc === 0` — все
 * сохранённые оценки, занулённые ложным «проекта нет», обязаны пересчитаться
 * при первом старте нового кода.
 * 4 (круг 2 В4.2a, К-Р14): `todo_note = "incomplete"` (обрыв cat-file) даёт
 * `old_share` = no-data с причиной — оценки, посчитавшие долю старых
 * маркеров по частичной выборке, пересчитываются (прецедент Ф2.3).
 */
export const DERIVED_VERSION = 4;

/** Порция фонового пересчёта истории за тик воркера (≈25 мс на скан). */
export const HISTORY_RESCORE_BATCH = 20;

const HISTORY_CURSOR = "history_rescore_cursor";

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

/** Нужен ли пересчёт при старте: derived_version БД старее кода, нет строк текущей модели или следы старого процесса. */
export function needsRescore(db: Database): boolean {
  const stored = Number(getMetaValue(db, "derived_version") ?? "0");
  if (!Number.isFinite(stored) || stored < DERIVED_VERSION) return true;
  const scans = (db.query("SELECT COUNT(*) AS c FROM scans WHERE status NOT IN ('running', 'queued')").get() as { c: number }).c;
  if (scans === 0) return false;
  const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
  if (rows === 0) return true;
  // круг 2 (LOW-10): следы старого процесса — завершённые сканы без public_status
  const legacy = db.query("SELECT 1 FROM scans WHERE public_status IS NULL AND status NOT IN ('running', 'queued') LIMIT 1").get();
  return legacy !== null;
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
    if (scores.totalRating === null) result.ratingNull++;
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
