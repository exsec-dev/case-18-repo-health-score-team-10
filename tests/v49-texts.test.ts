// v49-texts.test.ts — К9.10 (В4.9): тексты рекомендаций по ключу правила.
//
// 1. Текст при чтении = текст движка на тех же фактах — для КАЖДОГО из 16
//    ключей правил: движок пишет выдачу (`recommend` → `writeRecommendations`),
//    карточка (`getRepoCard`) подставляет текст `recommendationText` с
//    параметрами из фактов того же скана. Поведенческий тест на временной БД.
// 2. Старый текст в БД (скан до В4.9) карточка показывает новыми словами;
//    неизвестный ключ и невосстановимый параметр — запасной путь: сохраненный текст.
// 3. Д1: `appsec-critical` обещает снять потолок 49 только при утекших секретах.
//    Д2: медиана закрытия в тексте — целым числом дней.
// Условия срабатывания, Δ и порядок — tests/recommend.test.ts (без правок).
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { recommend, recommendationText } from "../src/score/recommend";
import { makeApiDb, seedRecommendation, seedRepo, type ApiTestDb, type FactSpec } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";
import { healthyFacts, withFacts } from "./score-fixtures";

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());
const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;

const APPSEC_SECRETS: FactSpec = { key: "appsec.findings", value: { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0.5, secrets_critical: true } };
const APPSEC_CRITICAL: FactSpec = { key: "appsec.findings", value: { severity_counts: { critical: 2, high: 1, medium: 0, low: 0 }, resolved_share: 0.5, secrets_critical: false } };

/** Сценарии, которые вместе включают все 16 правил движка. */
const SCENARIOS: [string, FactSpec[]][] = [
  [
    "нет файлов, CI и трекера",
    withFacts(
      healthyFacts(),
      { key: "docs.presence", value: { readme: false, license: false, contributing: false, codeowners: false } },
      { key: "docs.readme", value: { present: false } },
      { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } },
      { key: "cicd.runs", value: { reason: "access" }, status: "no-data" },
      { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
    ),
  ],
  [
    "README без разделов, CI без шагов",
    withFacts(
      healthyFacts(),
      { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } },
      { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false } },
      { key: "cicd.runs", value: { reason: "access" }, status: "no-data" },
      APPSEC_CRITICAL,
    ),
  ],
  ["CI без результатов запусков", withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }, APPSEC_CRITICAL)],
  [
    "красный и долгий CI, утекшие секреты, старые TODO, зависшие задачи",
    withFacts(
      healthyFacts(),
      { key: "cicd.runs", value: { last_status: "failed", success_rate: 0.5, duration_p50: 20 * 60 + 30, runs_count: 10 } },
      { key: "issues.stats", value: { open: 10, closed: 40, median_close_days: 48.849999999999994, stale_90d: 8, fetched_count: 50 } },
      { key: "code.todo", value: { count: 14, fixme: 6, older_180d: 9, todo_files: 10, blamed_files: 10 } },
      APPSEC_SECRETS,
    ),
  ],
  // В5.3-М круг 2 (К2, К6): новые правила add-tests и appsec-high — тем же контрактом чтения
  [
    "код без тестов с пометками, открытые high без critical",
    withFacts(
      healthyFacts(),
      { key: "tree.stats", value: { top_level: Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, type: "tree" })), file_count: 300, bytes: 2_000_000, loc: 50_000, source_files: 200, source_loc: 40_000, test_files: 0 } },
      { key: "code.todo", value: { count: 400, fixme: 0, older_180d: 200, todo_files: 50, blamed_files: 50 } },
      { key: "appsec.findings", value: { severity_counts: { critical: 0, high: 2, medium: 0, low: 0 }, resolved_share: 0.5, secrets_critical: false } },
    ),
  ],
];

const ALL_RULES = [
  "license-missing",
  "contributing-missing",
  "codeowners-missing",
  "readme-missing",
  "readme-sections-missing",
  "ci-missing",
  "ci-no-steps",
  "start-tracker",
  "connect-appsec",
  "grant-ci-runs",
  "fix-red-runs",
  "speed-up-pipeline",
  "appsec-critical",
  "appsec-high",
  "add-tests",
  "resolve-old-todos",
  "reduce-stale-issues",
  "speed-up-issue-close",
];

describe("К9.10: текст при чтении = текст движка на тех же фактах", () => {
  const seen = new Set<string>();
  SCENARIOS.forEach(([name, facts], i) => {
    test(`${name}: каждое правило на карточке — теми же словами, что пишет движок`, () => {
      const repoId = seedRepo(t, { org: "texts", repo: `s${i}` });
      const scanId = scoredScan(t, repoId, { facts: facts.map((f) => ({ ...f, source: f.key.startsWith("appsec") ? "appsec:api" : "git" })) });
      const engine = recommend(t.db, scanId);
      const card = getRepoCard(t.db, "texts", `s${i}`, { access: GRANTED })!;
      expect(engine.length).toBeGreaterThan(0);
      for (const rec of engine) {
        seen.add(rec.ruleId);
        const shown = card.recommendations.find((r) => r.ruleId === rec.ruleId);
        expect({ rule: rec.ruleId, shown: shown ? { action: shown.action, problem: shown.problem, impact: shown.expectedImpact } : null }).toEqual({
          rule: rec.ruleId,
          shown: { action: rec.action, problem: rec.problem, impact: rec.expectedImpact },
        });
      }
    });
  });
  test("сценарии покрывают все 18 правил движка (круг 2 В5.3-М: + add-tests, appsec-high)", () => {
    expect([...seen].sort()).toEqual([...ALL_RULES].sort());
  });
});

describe("К9.10: чтение по ключу и запасной путь", () => {
  test("старый текст скана до В4.9 карточка показывает новыми словами (параметры — из фактов скана)", () => {
    const repoId = seedRepo(t, { org: "texts", repo: "old" });
    const facts = withFacts(healthyFacts(), { key: "issues.stats", value: { open: 10, closed: 40, median_close_days: 48.849999999999994, stale_90d: 8, fetched_count: 50 } });
    const scanId = scoredScan(t, repoId, { facts });
    t.db.query("UPDATE recommendations SET problem = ?, action = ?, expected_impact = ? WHERE scan_id = ? AND rule_id = 'speed-up-issue-close'").run(
      "Медленное закрытие issues: медиана 48.849999999999994 дн.",
      "Ускорьте обработку: шаблоны, приоритеты, ответственный за триаж",
      "повысит категорию Issues",
      scanId,
    );
    const rec = getRepoCard(t.db, "texts", "old")!.recommendations.find((r) => r.ruleId === "speed-up-issue-close")!;
    expect(rec).toEqual(expect.objectContaining({ action: "Ускорьте обработку новых задач", expectedImpact: "повысит балл категории «Задачи»" }));
    // А13 аудита (круг 4 гейта): медиана называлась двумя числами — «49 дней» в
    // действии против «48,8 дня» в таблице показателей и приложении. Д2
    // («медиана целым числом дней») ПЕРЕВЕРНУТО с заменой: число одно и то же,
    // в тех же десятых, что и везде в документе.
    expect(rec.problem).toStartWith("Типичный срок закрытия задачи – 48,8 дня.");
  });

  test("неизвестный ключ правила — сохраненный текст как есть", () => {
    const repoId = seedRepo(t, { org: "texts", repo: "unknown" });
    const scanId = scoredScan(t, repoId, { facts: healthyFacts() });
    seedRecommendation(t, scanId, { ruleId: "future-rule", priority: 9, problem: "сохраненная проблема", action: "сохраненное действие", factRef: "docs.presence", expectedImpact: "сохраненный эффект" });
    const rec = getRepoCard(t.db, "texts", "unknown")!.recommendations.find((r) => r.ruleId === "future-rule")!;
    expect({ problem: rec.problem, action: rec.action, impact: rec.expectedImpact }).toEqual({ problem: "сохраненная проблема", action: "сохраненное действие", impact: "сохраненный эффект" });
  });

  test("параметр не восстановился (нет факта) — сохраненный текст", () => {
    const repoId = seedRepo(t, { org: "texts", repo: "nofact" });
    const scanId = scoredScan(t, repoId, { facts: healthyFacts().filter((f) => f.key !== "code.todo") });
    seedRecommendation(t, scanId, { ruleId: "resolve-old-todos", priority: 9, problem: "старые TODO по записи", action: "действие по записи", factRef: "code.todo", expectedImpact: "эффект по записи" });
    const rec = getRepoCard(t.db, "texts", "nofact")!.recommendations.find((r) => r.ruleId === "resolve-old-todos")!;
    expect(rec.problem).toBe("старые TODO по записи");
  });
});

describe("Д1, роли текста", () => {
  // круг 2 (К6): текст critical без секретов — по факту (потолок 40 / рост по пересчету)
  test("appsec-critical: потолок 49 — только при утекших секретах", () => {
    const secrets = recommendationText("appsec-critical", { secrets: true })!;
    const critical = recommendationText("appsec-critical", { secrets: false, capLimit: null, gain: true })!;
    expect(`${secrets.problem} ${secrets.expectedImpact}`).toContain("49");
    expect(`${critical.action} ${critical.problem} ${critical.expectedImpact}`).not.toMatch(/49|потол|ограничен/);
  });

  test("заголовок — глагол в повелительном наклонении без точки; эффект без «≈»", () => {
    const params = { delta: 1.25, reason: null, channel: null, missing: ["build" as const], issuesScore: 6, minutes: 20.5, secrets: false, capLimit: null, gain: true, older: 9, total: 20, percent: 80, days: 48.85 };
    for (const rule of ALL_RULES) {
      const text = recommendationText(rule, params)!;
      expect({ rule, verb: /^(Добавьте|Настройте|Ведите|Подключите|Откройте|Почините|Ускорьте|Устраните|Разберите)\s/.test(text.action), dot: text.action.endsWith("."), approx: text.expectedImpact.includes("≈") }).toEqual({
        rule,
        verb: true,
        dot: false,
        approx: false,
      });
    }
  });
});
