// rescore-m4.ts — пересчёт всей БД текущей моделью (В4.1/К1 → В4.3 —
// 4.0.0-hci, оба показателя: HealthCraft Index и полный Repo Health
// Score). КАЖДЫЙ скан → compute + recommend (одна выдача с метками
// каналов). Одна строка scores на (scan_id, model_version). После
// миграции схемы v1.9 (scores пересоздан под healthcraft_index) именно
// этот прогон восстанавливает производные данные. Идемпотентно:
// повторный прогон заменяет те же строки. Сети нет. В4.1-fix (Ф1.9):
// тело — rescoreAll (src/score/rescore.ts): now = дата скана, running
// пропускаются, пишется rating_eligible и meta.derived_version; тот же
// пересчёт сервер делает сам при старте.
// usage: bun scripts/rescore-m4.ts [--dry]
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { MODEL_VERSION } from "../src/score/model";
import { rescoreAll } from "../src/score/rescore";

const dry = process.argv.includes("--dry");
const config = loadConfig();
const db = openDb(config);

// последний ПРИГОДНЫЙ скан репо → строка «новый порядок рейтинга» (К-Ф1.1)
const latest = new Map<number, { slug: string; healthcraftIndex: number | null }>();
const fmt = (x: number | null) => (x === null ? "NULL" : String(Math.round(x)));
const result = rescoreAll(db, {
  dry,
  log: (m) => console.log(m),
  onScan: (scan, scores, eligible) => {
    if (eligible) latest.set(scan.repoId, { slug: scan.slug, healthcraftIndex: scores.healthcraftIndex });
    console.log(
      `  ${scan.slug.padEnd(44)} scan=${scan.id} index=${fmt(scores.healthcraftIndex)} (cov ${scores.indexCoverage.toFixed(2)}) full=${fmt(scores.repoHealthScore)} (cov ${scores.repoHealthCoverage.toFixed(2)})${scores.codeEmpty ? " code-empty" : ""}${eligible ? "" : " not-eligible"}`,
    );
  },
});

const order = [...latest.values()].sort((a, b) => (b.healthcraftIndex ?? -1) - (a.healthcraftIndex ?? -1));
console.log(`\nrating order by latest eligible scan (top 10):`);
for (const row of order.slice(0, 10)) {
  console.log(`  ${row.healthcraftIndex === null ? "NULL" : String(Math.round(row.healthcraftIndex)).padStart(3)}  ${row.slug}`);
}
const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
console.log(`\nscans=${result.scans} skipped_running=${result.skipped} scores_rows(${MODEL_VERSION})=${rows} eligible=${result.eligible} rating_scored=${result.ratingScored} rating_null=${result.ratingNull}`);
db.close();
