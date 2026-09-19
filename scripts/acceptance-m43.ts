// acceptance-m43.ts — приёмка В4.3 своим прогоном (19.09):
//   bun scripts/acceptance-m43.ts migration  — миграция 1.8→1.9 на временной БД
//                                             + восстановление строк rescoreAll
//   bun scripts/acceptance-m43.ts matrix     — матрица доступа: полный Repo
//                                             Health Score только при обоих
//                                             каналах; инверсия даёт минус
// Живых запросов нет; только временные каталоги.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { rescoreAll } from "../src/score/rescore";
import { getRepoCard, listRepos } from "../src/api/repos";
import { categoryOf } from "../src/collectors/facts";
import { cardFacts, makeApiDb, seedScore } from "../tests/api-fixtures";
import { healthyFacts } from "../tests/score-fixtures";

const mode = process.argv[2] ?? "migration";

if (mode === "migration") {
  const dir = mkdtempSync(join(tmpdir(), "rh-m43-mig-"));
  const config = { ...loadConfig(), dataDir: dir };
  const db = openDb(config);
  const r = db.query("INSERT INTO repos (org_slug, repo_slug, title, language, visibility, rating_active) VALUES ('mig', 'repo', 'Mig Repo', 'Go', 'public', 1)").run();
  const repoId = Number(r.lastInsertRowid);
  const s = db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible, public_status) VALUES (?, '2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z', 'ok', 'periodic', 1, 'ok')").run(repoId);
  const scanId = Number(s.lastInsertRowid);
  const stmt = db.query("INSERT INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, 'ok', ?, '2026-09-10T10:00:00Z')");
  for (const f of healthyFacts() as { key: string; value: unknown; source?: string }[]) stmt.run(scanId, categoryOf(f.key), f.key, JSON.stringify(f.value), f.source ?? "git");
  const oldIndex = 12; // «память» старой строки — источник ею быть не обязан
  db.exec("DROP TABLE scores");
  db.exec(`CREATE TABLE scores (
    scan_id INTEGER NOT NULL REFERENCES scans(id), model_version TEXT NOT NULL, repo_id INTEGER NOT NULL,
    total_rating INTEGER, coverage_rating REAL NOT NULL, total_full INTEGER, coverage_full REAL NOT NULL,
    categories TEXT NOT NULL, no_data TEXT NOT NULL, stale TEXT NOT NULL, computed_at TEXT NOT NULL,
    derived TEXT, code_empty INTEGER, PRIMARY KEY (scan_id, model_version))`);
  db.query("INSERT INTO scores (scan_id, model_version, repo_id, total_rating, coverage_rating, total_full, coverage_full, categories, no_data, stale, computed_at) VALUES (?, '3.0.0-m4', ?, ?, 1, ?, 0.8, '{}', '[]', '[]', '2026-09-10T10:05:00Z')").run(scanId, repoId, oldIndex, oldIndex + 3);
  db.query("UPDATE meta SET value = '1.8' WHERE key = 'schema_version'").run();
  db.close();

  const db2 = openDb(config); // повторное открытие = миграция 1.8 → 1.9
  const cols = (db2.query("PRAGMA table_info(scores)").all() as { name: string }[]).map((c) => c.name);
  console.log("schema:", (db2.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
  console.log("scores cols:", cols.join(","));
  console.log("scores rows after migration (ожидание 0):", (db2.query("SELECT COUNT(*) AS c FROM scores").get() as { c: number }).c);
  const result = rescoreAll(db2, { log: () => {} });
  console.log("rescoreAll:", JSON.stringify({ scans: result.scans, eligible: result.eligible, errors: result.errors, fatal: result.fatal, ratingScored: result.ratingScored }));
  const row = db2.query("SELECT model_version, healthcraft_index, index_coverage FROM scores WHERE scan_id = ?").get(scanId) as { model_version: string; healthcraft_index: number; index_coverage: number };
  console.log("restored row:", JSON.stringify(row), "| старая строка (total_rating", oldIndex + ") источником НЕ была");
  const rating = listRepos(db2, { sort: "index", order: "desc", page: 1, perPage: 25 });
  console.log("rating:", JSON.stringify(rating.items.map((i) => ({ repo: i.repo, healthcraftIndex: i.healthcraftIndex }))));
  db2.close();
  rmSync(dir, { recursive: true, force: true });
} else if (mode === "matrix") {
  const t = makeApiDb();
  const RUNS_RED = { last_status: "failed", success_rate: 0.5, duration_p50: 1500, runs_count: 41 };
  const APPSEC_BAD = { severity_counts: { critical: 1, high: 2, medium: 3, low: 4 }, resolved_share: 0.5, secrets_critical: false };
  const r = t.db.query("INSERT INTO repos (org_slug, repo_slug, visibility, rating_active) VALUES ('mx', 'pub', 'public', 1)").run();
  const rid = Number(r.lastInsertRowid);
  const facts = [
    ...cardFacts().map((f) => (f.key === "cicd.runs" ? { ...f, value: RUNS_RED } : f)),
    { key: "appsec.findings", source: "appsec:api", value: APPSEC_BAD },
  ];
  const s2 = t.db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible, public_status) VALUES (?, '2026-09-16T12:00:00Z', '2026-09-16T12:00:00Z', 'ok', 'periodic', 1, 'ok')").run(rid);
  const scanId = Number(s2.lastInsertRowid);
  const stmt = t.db.query("INSERT INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, 'ok', ?, '2026-09-16T12:00:00Z')");
  for (const f of facts) stmt.run(scanId, categoryOf(f.key), f.key, JSON.stringify(f.value), f.source ?? "git");
  seedScore(t, rid, scanId, { total: 61 });
  const show = (access: Record<string, string>) => {
    const card = getRepoCard(t.db, "mx", "pub", { access: access as never })!;
    const sc = card.score!;
    const delta = sc.repoHealthScore !== null && sc.healthcraftIndex !== null ? Math.round((sc.repoHealthScore - sc.healthcraftIndex) * 10) / 10 : null;
    return { index: sc.healthcraftIndex, full: sc.repoHealthScore, fullLocked: sc.fullLocked, delta, cicdShown: sc.categories.cicd.score !== null, secShown: sc.categories.security.score !== null };
  };
  console.log("анон:       ", JSON.stringify(show({ cicd: "no-pat", appsec: "no-pat", repo: "granted" })));
  console.log("только CI:  ", JSON.stringify(show({ cicd: "granted", appsec: "denied", repo: "granted" })));
  console.log("только Sec: ", JSON.stringify(show({ cicd: "denied", appsec: "granted", repo: "granted" })));
  console.log("оба канала: ", JSON.stringify(show({ cicd: "granted", appsec: "granted", repo: "granted" })));
  t.close();
} else {
  console.error("usage: bun scripts/acceptance-m43.ts migration|matrix");
  process.exit(2);
}
