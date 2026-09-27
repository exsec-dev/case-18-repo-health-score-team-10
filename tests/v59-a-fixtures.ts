// Наборы фактов для лестницы и эталона «выдача recommend до/после выноса
// патчей» (tests/v59-a-recommend-golden.json снят кодом до рефакторинга).
// Не *.test.ts.
import { compute, ratingEligible, writeScores } from "../src/score/compute";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { seedRepo, seedScan, type ApiTestDb } from "./api-fixtures";
import { healthyFacts, NOW, withFacts, type FactSpec } from "./score-fixtures";

/** Репо + скан + оценка и рекомендации НАСТОЯЩИМ конвейером (как runner/rescore): карточка читает то, что записал движок. */
export function seedScored(t: ApiTestDb, org: string, repo: string, facts: FactSpec[], visibility = "public"): number {
  const repoId = seedRepo(t, { org, repo, title: repo });
  t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, repoId);
  const source = (key: string) => (key.startsWith("cicd.runs") ? "rest:cicd" : key.startsWith("issues.") || key === "activity.rest" ? "rest" : "git");
  const scanId = seedScan(t, repoId, { startedAt: NOW.toISOString(), facts: facts.map((f) => ({ key: f.key, value: f.value, status: f.status, source: source(f.key) })) });
  const scores = compute(t.db, scanId, { now: NOW });
  const recs = recommend(t.db, scanId, { scores });
  writeScores(t.db, scores);
  writeRecommendations(t.db, scanId, scores.modelVersion, recs);
  const rows = t.db.query("SELECT key, status, source, value FROM facts WHERE scan_id = ?").all(scanId) as { key: string; status: string; source: string; value: string }[];
  t.db.query("UPDATE scans SET rating_eligible = ? WHERE id = ?").run(ratingEligible(rows, { status: "ok", userId: null }) ? 1 : 0, scanId);
  return scanId;
}

const docsNone = { readme: true, license: false, contributing: false, codeowners: false, content_checked: true };
const readmeNoSections = { bytes: 8000, sections: 2, flags: { install: false, build: false, test: false } };
const issuesWeak = { open: 40, closed: 2, median_close_days: 200, stale_90d: 38, fetched_count: 42 };
const issuesMid = { open: 10, closed: 40, median_close_days: 60, stale_90d: 6, fetched_count: 50 };
const issuesNone = { open: 0, closed: 0, fetched_count: 0 };

/** Документация без лицензии, CONTRIBUTING, CODEOWNERS и разделов README; прочее — «здоровое репо». */
export function noDocsFacts(): FactSpec[] {
  return withFacts(healthyFacts(), { key: "docs.presence", value: docsNone }, { key: "docs.readme", value: readmeNoSections });
}

/** Лестница достигает 70 за 2 шага (старт ~63). */
export function reachesFacts(): FactSpec[] {
  return withFacts(noDocsFacts(), { key: "issues.stats", value: issuesMid });
}

/** Лестница не достигает 70: правила кончаются на ~68 (слабые задачи). */
export function unreachedFacts(): FactSpec[] {
  return withFacts(noDocsFacts(), { key: "issues.stats", value: issuesWeak });
}

/** Документация полная, трекер пуст, индекс < 70: шагов нет, есть активационное правило. */
export function onlyActivationFacts(): FactSpec[] {
  return withFacts(
    healthyFacts(),
    { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: true, content_checked: true } },
    { key: "issues.stats", value: issuesNone },
  );
}

/** Документация полная, задачи слабые, индекс < 70: предложить нечего. */
export function nothingFacts(): FactSpec[] {
  return withFacts(onlyActivationFacts(), { key: "issues.stats", value: issuesWeak });
}

/** Кода нет: индекс 0 как данные, а не «нет данных». */
export function codeEmptyFacts(): FactSpec[] {
  return withFacts(unreachedFacts(), { key: "tree.stats", value: { top_level: [], file_count: 0, bytes: 0, loc: 0 } });
}

/** Индекс NULL: покрытие < 0,4. */
export function nullIndexFacts(): FactSpec[] {
  return [
    { key: "docs.presence", value: { readme: false, license: false, contributing: false, codeowners: false, content_checked: true } },
    { key: "tree.stats", value: { top_level: [], file_count: 10, bytes: 1000, loc: 500 } },
  ];
}

/** Эталон рефакторинга: presence-, активационные, CI- и скор-правила во всех ветках. */
export function goldenCases(): { name: string; facts: FactSpec[] }[] {
  const ciNoYaml = { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } };
  return [
    { name: "healthy", facts: healthyFacts() },
    { name: "no-docs", facts: noDocsFacts() },
    { name: "reaches", facts: reachesFacts() },
    { name: "unreached", facts: unreachedFacts() },
    { name: "only-activation", facts: onlyActivationFacts() },
    { name: "code-empty", facts: codeEmptyFacts() },
    { name: "null-index", facts: nullIndexFacts() },
    {
      name: "readme-missing",
      facts: withFacts(unreachedFacts(), { key: "docs.presence", value: { ...docsNone, readme: false } }, { key: "docs.readme", value: { present: false } }),
    },
    {
      name: "add-tests",
      facts: withFacts(unreachedFacts(), { key: "tree.stats", value: { top_level: [{ name: "src", type: "tree" }], file_count: 300, bytes: 2_000_000, loc: 50_000, source_files: 120, test_files: 0 } }),
    },
    { name: "ci-missing-runs-visible", facts: withFacts(unreachedFacts(), ciNoYaml) },
    { name: "ci-missing-no-runs", facts: withFacts(unreachedFacts(), ciNoYaml).filter((f) => f.key !== "cicd.runs") },
    {
      name: "ci-no-steps-runs-pending",
      facts: withFacts(
        unreachedFacts(),
        { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false } },
        { key: "cicd.runs", value: { runs_count: 0, runs_total: 3 } },
      ),
    },
    {
      name: "red-ci-appsec",
      facts: withFacts(
        unreachedFacts(),
        { key: "cicd.runs", value: { last_status: "failed", success_rate: 0.5, duration_p50: 1200, runs_count: 10 } },
        { key: "appsec.findings", value: { severity_counts: { critical: 1, high: 2, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: false } },
        { key: "code.todo", value: { count: 10, fixme: 2, older_180d: 9, todo_files: 8, blamed_files: 8 } },
      ),
    },
    {
      name: "legacy-copying",
      facts: withFacts(unreachedFacts(), { key: "docs.presence", value: { readme: true, license: false, contributing: false, codeowners: false } }, {
        key: "tree.stats",
        value: { top_level: [{ name: "COPYING", type: "blob" }, { name: "src", type: "tree" }], file_count: 300, bytes: 2_000_000, loc: 50_000 },
      }),
    },
  ];
}
