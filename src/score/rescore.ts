// rescore.ts — пересчёт всех сканов текущей моделью (В4.1-fix, Ф1.9):
// одна функция для скрипта scripts/rescore-m4.ts и для старта сервера.
// Каждый завершённый скан → compute на его собственную дату
// (now = finished_at ?? started_at — исторический скан не «стареет» на
// дату пересчёта) + recommend + rating_eligible (то же правило, что
// скор-хук); running/queued пропускаются. По завершении — meta.derived_version
// текущего кода. Сети нет.
//
// meta.derived_version повышается, когда меняется форма/смысл хранимых
// оценок без смены MODEL_VERSION (Ф1.2 реальный прирост, Ф1.12, далее Ф2.3):
// старт сервера видит устаревшую версию и пересчитывает синхронно до
// Bun.serve — рейтинг не бывает пуст или смешан после выкладки.
import type { Database } from "bun:sqlite";
import { compute, ratingEligible, writeScores, type Scores } from "./compute";
import { MODEL_VERSION } from "./model";
import { recommend, writeRecommendations } from "./recommend";
import { getMetaValue, setMetaValue } from "../db";

/** Версия производных данных (scores/recommendations/rating_eligible) при неизменной MODEL_VERSION. */
export const DERIVED_VERSION = 1;

export interface RescoreOptions {
  /** лог прогресса (сервер — console.log) */
  log?: (message: string) => void;
  /** шаг лога прогресса, сканов */
  progressEvery?: number;
  /** не писать в БД (скрипт --dry) */
  dry?: boolean;
  /** на каждый пересчитанный скан (скрипт печатает строку) */
  onScan?: (scan: { id: number; repoId: number; slug: string }, scores: Scores, eligible: boolean) => void;
}

export interface RescoreResult {
  scans: number;
  skipped: number;
  ratingScored: number;
  ratingNull: number;
  eligible: number;
}

/** Нужен ли пересчёт при старте: derived_version БД старее кода или строк текущей модели нет при непустых сканах. */
export function needsRescore(db: Database): boolean {
  const stored = Number(getMetaValue(db, "derived_version") ?? "0");
  if (!Number.isFinite(stored) || stored < DERIVED_VERSION) return true;
  const scans = (db.query("SELECT COUNT(*) AS c FROM scans WHERE status NOT IN ('running', 'queued')").get() as { c: number }).c;
  if (scans === 0) return false;
  const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
  return rows === 0;
}

export function rescoreAll(db: Database, opts: RescoreOptions = {}): RescoreResult {
  const log = opts.log ?? (() => {});
  const every = Math.max(1, opts.progressEvery ?? 200);
  const scans = db
    .query(
      `SELECT s.id, s.repo_id, s.started_at, s.finished_at, s.status, r.org_slug, r.repo_slug
       FROM scans s JOIN repos r ON r.id = s.repo_id
       ORDER BY s.id`,
    )
    .all() as { id: number; repo_id: number; started_at: string; finished_at: string | null; status: string; org_slug: string; repo_slug: string }[];
  const factsOf = db.query("SELECT key, status, value FROM facts WHERE scan_id = ?");
  const result: RescoreResult = { scans: 0, skipped: 0, ratingScored: 0, ratingNull: 0, eligible: 0 };
  const total = scans.length;
  log(`rescore ${MODEL_VERSION} (derived v${DERIVED_VERSION}): ${total} scans${opts.dry ? " (dry)" : ""}`);
  for (const scan of scans) {
    if (scan.status === "running" || scan.status === "queued") {
      result.skipped++;
      continue;
    }
    const now = new Date(scan.finished_at ?? scan.started_at);
    const scores = compute(db, scan.id, { now: Number.isNaN(now.getTime()) ? new Date() : now });
    const eligible = ratingEligible(factsOf.all(scan.id) as { key: string; status: string; value: string }[]);
    if (!opts.dry) {
      db.transaction(() => {
        writeScores(db, scores);
        writeRecommendations(db, scan.id, scores.modelVersion, recommend(db, scan.id, { scores }));
        db.query("UPDATE scans SET rating_eligible = ? WHERE id = ?").run(eligible ? 1 : 0, scan.id);
      })();
    }
    result.scans++;
    if (eligible) result.eligible++;
    if (scores.totalRating === null) result.ratingNull++;
    else result.ratingScored++;
    opts.onScan?.({ id: scan.id, repoId: scan.repo_id, slug: `${scan.org_slug}/${scan.repo_slug}` }, scores, eligible);
    const done = result.scans + result.skipped;
    if (done % every === 0) log(`rescore: ${done}/${total}`);
  }
  if (!opts.dry) setMetaValue(db, "derived_version", String(DERIVED_VERSION));
  log(
    `rescore done: scans=${result.scans} skipped(running)=${result.skipped} eligible=${result.eligible} rating_scored=${result.ratingScored} rating_null=${result.ratingNull}`,
  );
  return result;
}
