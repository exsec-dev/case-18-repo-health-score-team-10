// rating-snapshot.ts — В5.5 тур 1 (W2, Р1): суточный снимок мест публичного
// рейтинга — основа динамики позиции (rankDelta в строке рейтинга).
// Снимок — таблица ЧИСЕЛ repo_id → место (решение §2 «В5.5 — тур 1» п.3);
// код репозиториев не участвует, закон «код не храним» не задет.
// Идемпотентно: один снимок на UTC-дату; ранг считается тем же listRepos,
// что обслуживает выдачу, — «тот же порядок и выборка» держится построением,
// а не параллельным SQL.
// Точка снимка (В5.5 тур 2, Т2-А) — ночная фаза `catalogTick` (scheduler.ts),
// ДО обхода каталога: снимок «итог суток» = места до эвикции и новой волны.
// Прежняя ленивая точка тура 1 (пустая очередь рейтинга после ночной фазы)
// убрана: на стенде очередь не пустеет сутками (доочередь старых сканов), и
// снимок не писался бы вовсе; idle слота «только легкие» наступал до конца волны.
import type { Database } from "bun:sqlite";
import { listRepos } from "../api/repos";

/** Ретеншен снимков (сутки): месяц динамики + запас на пропуск дня. */
export const RATING_SNAPSHOT_RETENTION_DAYS = 35;

/** UTC-дата момента (YYYY-MM-DD) — ключ идемпотентности снимка. */
export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface SnapshotResult {
  /** снимок за дату записан этим вызовом */
  taken: boolean;
  /** строк в снимке (0, если не taken) */
  rows: number;
  day: string;
}

/**
 * Записать снимок мест рейтинга за UTC-дату `now`. Снимок за эту дату уже
 * есть — пропуск (taken=false, строк не добавляется). Ранг — место в выдаче
 * публичного рейтинга (rating_active публичные, HealthCraft Index по убыванию,
 * при равенстве org/repo); репо без индекса (rank=null) в снимок не входят —
 * отсутствие в снимке и есть сигнал «новый/вышел из ранжирования» для rankDelta.
 */
export function takeRatingSnapshot(db: Database, opts: { now?: Date } = {}): SnapshotResult {
  const now = opts.now ?? new Date();
  const day = utcDayOf(now);
  const exists = db.query("SELECT 1 FROM rating_snapshots WHERE taken_at = ? LIMIT 1").get(day) !== null;
  if (exists) return { taken: false, rows: 0, day };
  // вся выборка одной выдачей: пагинация listRepos режет items, поэтому perPage
  // заведомо больше каталога; rank присвоен до пагинации и не зависит от неё
  const rating = listRepos(db, { sort: "index", order: "desc", page: 1, perPage: Number.MAX_SAFE_INTEGER });
  const idBySlug = new Map(
    (db.query("SELECT id, org_slug, repo_slug FROM repos").all() as { id: number; org_slug: string; repo_slug: string }[]).map((r) => [
      `${r.org_slug}/${r.repo_slug}`,
      r.id,
    ]),
  );
  const insert = db.query("INSERT INTO rating_snapshots (taken_at, repo_id, rank, score_index) VALUES (?, ?, ?, ?)");
  let rows = 0;
  db.transaction(() => {
    for (const item of rating.items) {
      if (item.rank === null || item.healthcraftIndex === null) continue;
      const repoId = idBySlug.get(`${item.org}/${item.repo}`);
      if (repoId === undefined) continue;
      insert.run(day, repoId, item.rank, item.healthcraftIndex);
      rows++;
    }
  })();
  return { taken: true, rows, day };
}

/**
 * Ретеншен: снимки старше `days` суток удаляются (вызывается часовым
 * обслуживанием рядом с purgeOldJobs). taken_at — ISO-дата, строковое
 * сравнение корректно.
 */
export function purgeOldRatingSnapshots(db: Database, opts: { now?: Date; days?: number } = {}): number {
  const now = opts.now ?? new Date();
  const days = opts.days ?? RATING_SNAPSHOT_RETENTION_DAYS;
  const cutoff = utcDayOf(new Date(now.getTime() - days * 24 * 60 * 60_000));
  const r = db.query("DELETE FROM rating_snapshots WHERE taken_at < ?").run(cutoff);
  if (r.changes > 0) console.log(`[sweep] удалено снимков рейтинга старше ${days} суток: ${r.changes}`);
  return r.changes;
}
