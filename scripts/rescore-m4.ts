// rescore-m4.ts — пересчёт всей БД моделью 3.0.0-m4 (В4/Б4):
// для каждого репо — последний скан → compute(public) + recommend,
// новые scores-строки (PK scan+model, история целится — immutable).
// Собственных сканов не трогаем (own-скор пишется своим сканом с PAT).
// Идемпотентно: повторный прогон заменяет те же строки. Сети нет.
// usage: bun scripts/rescore-m4.ts [--dry]
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { compute, writeScores } from "../src/score/compute";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { MODEL_VERSION } from "../src/score/model";

const dry = process.argv.includes("--dry");
const config = loadConfig();
const db = openDb(config);

const repos = db.query("SELECT id, org_slug, repo_slug FROM repos ORDER BY org_slug, repo_slug").all() as {
  id: number;
  org_slug: string;
  repo_slug: string;
}[];
console.log(`rescore ${MODEL_VERSION}: ${repos.length} repos${dry ? " (dry)" : ""}`);

let scored = 0;
let nulls = 0;
const order: { slug: string; total: number | null }[] = [];
for (const repo of repos) {
  const scan = db
    .query("SELECT id FROM scans WHERE repo_id = ? ORDER BY id DESC LIMIT 1")
    .get(repo.id) as { id: number } | null;
  if (!scan) {
    console.log(`  skip ${repo.org_slug}/${repo.repo_slug}: no scans`);
    continue;
  }
  const scores = compute(db, scan.id, "public");
  if (!dry) {
    writeScores(db, scores);
    const recs = recommend(db, scan.id, { mode: "public", scores });
    writeRecommendations(db, scan.id, scores.modelVersion, recs);
  }
  if (scores.total === null) nulls++;
  else scored++;
  order.push({ slug: `${repo.org_slug}/${repo.repo_slug}`, total: scores.total });
  console.log(
    `  ${`${repo.org_slug}/${repo.repo_slug}`.padEnd(44)} scan=${scan.id} total=${scores.total === null ? "NULL" : Math.round(scores.total)} cov=${scores.coverage.toFixed(2)}${scores.codeEmpty ? " code-empty" : ""}`,
  );
}

order.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
console.log(`\nnew public order (top 10):`);
for (const row of order.slice(0, 10)) {
  console.log(`  ${row.total === null ? "NULL" : String(Math.round(row.total)).padStart(3)}  ${row.slug}`);
}
console.log(`\nscored=${scored} null=${nulls} model=${MODEL_VERSION}`);
db.close();
