// score.ts — CLI пересчёта (В2/Б5): bun scripts/score.ts <org/repo> —
// последний скан слага → compute (оба итога, В4.1/К1) + recommend →
// запись (идемпотентно при том же model_version; смена модели = новые строки).
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { compute, writeScores } from "../src/score/compute";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { MODEL_VERSION } from "../src/score/model";

const slug = process.argv[2];
if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) {
  console.error("usage: bun scripts/score.ts <org/repo>");
  process.exit(2);
}
const [org, repo] = slug.split("/");

const config = loadConfig();
const db = openDb(config);
const scan = db
  .query(
    `SELECT s.id FROM scans s JOIN repos r ON r.id = s.repo_id
     WHERE r.org_slug = ? AND r.repo_slug = ? ORDER BY s.id DESC LIMIT 1`,
  )
  .get(org, repo) as { id: number } | null;
if (!scan) {
  console.error(`no scan found for ${slug}`);
  db.close();
  process.exit(1);
}

const scores = compute(db, scan.id);
writeScores(db, scores);
const recs = recommend(db, scan.id, { scores });
writeRecommendations(db, scan.id, scores.modelVersion, recs);

const fmt = (x: number | null) => (x === null ? "NULL" : String(Math.round(x)));
console.log(`scan_id=${scan.id} model=${scores.modelVersion}`);
console.log(`HealthCraft Index (4 cat)=${fmt(scores.healthcraftIndex)} coverage=${scores.indexCoverage.toFixed(2)}; Repo Health Score (6 cat)=${fmt(scores.repoHealthScore)} coverage=${scores.repoHealthCoverage.toFixed(2)} stale=[${scores.stale.join(",")}]`);
for (const [key, cat] of Object.entries(scores.categories)) {
  const val = cat.score === null ? "no-data" : cat.score.toFixed(1);
  const mark = cat.stale ? " (stale)" : "";
  console.log(`  ${key.padEnd(13)} ${val.padStart(5)}${mark}`);
}
if (scores.healthcraftIndex === null || scores.repoHealthScore === null) {
  console.log(`  NULL: ${scores.noData.join("; ")}`);
}
console.log(`recommendations: ${recs.length}`);
for (const r of recs.slice(0, 5)) {
  console.log(`  ${r.priority}. [${r.ruleId}] ${r.problem} → ${r.expectedImpact}`);
}
db.close();
