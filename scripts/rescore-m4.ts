// rescore-m4.ts — пересчёт всей БД моделью 3.0.0-m4 (В4.1/К1): КАЖДЫЙ
// скан → compute (оба итога: в рейтинге и полный) + recommend (одна
// выдача с метками каналов). Одна строка scores на (scan_id,
// model_version) — режима больше нет, пересчёт ничего не «переводит» из
// одного режима в другой. После миграции схемы v1.5 (scores/
// recommendations пересозданы) именно этот прогон восстанавливает
// производные данные. Идемпотентно: повторный прогон заменяет те же
// строки. Сети нет.
// usage: bun scripts/rescore-m4.ts [--dry]
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { compute, writeScores } from "../src/score/compute";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { MODEL_VERSION } from "../src/score/model";

const dry = process.argv.includes("--dry");
const config = loadConfig();
const db = openDb(config);

const scans = db
  .query(
    `SELECT s.id, s.repo_id, r.org_slug, r.repo_slug FROM scans s JOIN repos r ON r.id = s.repo_id
     ORDER BY s.id`,
  )
  .all() as { id: number; repo_id: number; org_slug: string; repo_slug: string }[];
console.log(`rescore ${MODEL_VERSION}: ${scans.length} scans${dry ? " (dry)" : ""}`);

let scored = 0;
let nulls = 0;
// последний скан репо → строка «новый порядок рейтинга»
const latest = new Map<number, { slug: string; totalRating: number | null; totalFull: number | null }>();
for (const scan of scans) {
  const scores = compute(db, scan.id);
  if (!dry) {
    db.transaction(() => {
      writeScores(db, scores);
      writeRecommendations(db, scan.id, scores.modelVersion, recommend(db, scan.id, { scores }));
    })();
  }
  if (scores.totalRating === null) nulls++;
  else scored++;
  const slug = `${scan.org_slug}/${scan.repo_slug}`;
  latest.set(scan.repo_id, { slug, totalRating: scores.totalRating, totalFull: scores.totalFull });
  const fmt = (x: number | null) => (x === null ? "NULL" : String(Math.round(x)));
  console.log(
    `  ${slug.padEnd(44)} scan=${scan.id} rating=${fmt(scores.totalRating)} (cov ${scores.coverageRating.toFixed(2)}) full=${fmt(scores.totalFull)} (cov ${scores.coverageFull.toFixed(2)})${scores.codeEmpty ? " code-empty" : ""}`,
  );
}

const order = [...latest.values()].sort((a, b) => (b.totalRating ?? -1) - (a.totalRating ?? -1));
console.log(`\nrating order by latest scan (top 10):`);
for (const row of order.slice(0, 10)) {
  console.log(`  ${row.totalRating === null ? "NULL" : String(Math.round(row.totalRating)).padStart(3)}  ${row.slug}`);
}
const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
console.log(`\nscans=${scans.length} scores_rows(${MODEL_VERSION})=${rows} rating_scored=${scored} rating_null=${nulls}`);
db.close();
