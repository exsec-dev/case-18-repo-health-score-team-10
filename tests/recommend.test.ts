// recommend.test.ts — Б4: движок рекомендаций (§8): presence-Δ на
// замороженном весовом векторе (числа из model, не хардкод),
// активационная ветка без числа (0/0-issues, AppSec, CI-раны),
// порядок выдачи (Δ desc → активационные по весу категории desc),
// идемпотентность записи.
import { afterAll, describe, expect, test } from "bun:test";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { NOW, TestDb, healthyFacts, makeDb, seedScan, withFacts } from "./score-fixtures";

const t: TestDb = makeDb();
afterAll(() => t.close());

describe("presence-правила: числовой Δ на замороженных весах", () => {
  test("здоровое репо: presence-правил нет, только connect-appsec", () => {
    const scanId = seedScan(t, healthyFacts());
    const recs = recommend(t.db, scanId, { now: NOW });
    // фикстура: codeowners:false → одно presence-правило + активационная
    expect(recs.map((r) => r.ruleId)).toEqual(["codeowners-missing", "connect-appsec"]);
    expect(recs[0]!.kind).toBe("presence");
    expect(recs[1]!.kind).toBe("activation");
    expect(recs[1]!.deltaScore).toBeNull();
  });

  test("нет лицензии → Δ = 0.15·0.25·100 = 3.75 числом", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true } }));
    const rec = recommend(t.db, scanId, { now: NOW }).find((r) => r.ruleId === "license-missing")!;
    expect(rec.deltaScore).toBeCloseTo(3.75, 10);
    expect(rec.expectedImpact).toContain("+3.8 Score (по одному)");
    expect(rec.factRefs).toContain("docs.presence");
  });

  test("нет README → Δ = 0.15·0.45·0.37·100 ≈ 2.5 (минимальный README)", () => {
    const scanId = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "docs.presence", value: { readme: false, license: true, contributing: true, codeowners: true } },
        { key: "docs.readme", value: { present: false } },
      ),
    );
    const rec = recommend(t.db, scanId, { now: NOW }).find((r) => r.ruleId === "readme-missing")!;
    expect(rec.deltaScore!).toBeCloseTo(2.4975, 4);
  });

  test("README без 2 секций из 3 → Δ за долю секций (2/3)", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } }));
    const rec = recommend(t.db, scanId, { now: NOW }).find((r) => r.ruleId === "readme-sections-missing")!;
    // 0.15·0.45·0.7·0.5·(2/3)·100 = 1.575
    expect(rec.deltaScore!).toBeCloseTo(1.575, 4);
  });

  test("нет CI (own-режим, раны 403) → +7.5; публично CI-правил нет (В4)", () => {
    const noCi = seedScan(t, withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } }, { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const rec1 = recommend(t.db, noCi, { mode: "own", now: NOW }).find((r) => r.ruleId === "ci-missing")!;
    expect(rec1.deltaScore).toBeCloseTo(7.5, 10);
    expect(rec1.expectedImpact).toContain("50/100");
    // публично CI исключён — ни presence, ни активационных по CI
    expect(recommend(t.db, noCi, { now: NOW }).some((r) => ["ci-missing", "ci-no-steps", "grant-ci-runs"].includes(r.ruleId))).toBe(false);

    const noSteps = seedScan(t, withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false } }, { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const rec2 = recommend(t.db, noSteps, { mode: "own", now: NOW }).find((r) => r.ruleId === "ci-no-steps")!;
    expect(rec2.deltaScore).toBeCloseTo(7.5, 10);
    // активационная «дайте доступ к прогонам» не путается с presence
    const ids = recommend(t.db, noSteps, { mode: "own", now: NOW }).map((r) => r.ruleId);
    expect(ids).not.toContain("grant-ci-runs"); // шагов нет — активировать нечего
  });
});

describe("активационная ветка (без числа)", () => {
  test("0/0 issues → start-tracker, Δ нет, приоритет после числовых", () => {
    const scanId = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
        { key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true } },
      ),
    );
    const recs = recommend(t.db, scanId, { now: NOW });
    const tracker = recs.find((r) => r.ruleId === "start-tracker")!;
    expect(tracker.deltaScore).toBeNull();
    expect(tracker.opensCategory).toBe("issues");
    // числовые раньше активационных
    expect(recs.findIndex((r) => r.ruleId === "license-missing")).toBeLessThan(recs.indexOf(tracker));
  });

  test("connect-appsec (В4, парковка В3 закрыта): честный текст режима вместо пустого coverage", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const pub = recommend(t.db, scanId, { now: NOW });
    const appsec = pub.find((r) => r.ruleId === "connect-appsec")!;
    expect(appsec.expectedImpact).toContain("Security доступна в режиме своего репо");
    expect(appsec.expectedImpact).not.toMatch(/coverage 1\.00→1\.00/); // пустой текст В3 умер
    // grant-ci-runs — own-режим (публично CI исключён)
    expect(pub.some((r) => r.ruleId === "grant-ci-runs")).toBe(false);
    const own = recommend(t.db, scanId, { mode: "own", now: NOW });
    const grant = own.find((r) => r.ruleId === "grant-ci-runs")!;
    expect(grant.opensCategory).toBe("cicd");
    expect(grant.deltaScore).toBeNull();
    // порядок активационных по весу: security (20) раньше cicd (15)
    const ownAppsec = own.find((r) => r.ruleId === "connect-appsec")!;
    expect(ownAppsec.expectedImpact).toContain("права PAT");
    expect(own.indexOf(ownAppsec)).toBeLessThan(own.indexOf(grant));
  });

  test("AppSec-факт есть → connect-appsec не летит; критичные → скор-правило", () => {
    const scanId = seedScan(
      t,
      withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true } }),
    );
    const recs = recommend(t.db, scanId, { now: NOW });
    expect(recs.some((r) => r.ruleId === "connect-appsec")).toBe(false);
    expect(recs.some((r) => r.ruleId === "appsec-critical")).toBe(true);
  });
});

describe("скор-правила (по данным)", () => {
  test("красные прогоны + долгий пайплайн + stale issues + медленное закрытие + старые TODO", () => {
    const scanId = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "cicd.runs", value: { last_status: "failed", success_rate: 0.5, duration_p50: 20 * 60, runs_count: 10 } },
        { key: "issues.stats", value: { open: 10, closed: 40, median_close_days: 45, stale_90d: 8, fetched_count: 50 } },
        { key: "code.todo", value: { count: 14, fixme: 6, older_180d: 9, todo_files: 10, blamed_files: 10 } },
      ),
    );
    const ids = recommend(t.db, scanId, { mode: "own", now: NOW }).map((r) => r.ruleId);
    expect(ids).toContain("fix-red-runs");
    expect(ids).toContain("speed-up-pipeline");
    expect(ids).toContain("reduce-stale-issues");
    expect(ids).toContain("speed-up-issue-close");
    expect(ids).toContain("resolve-old-todos");
  });

  test("зелёные/быстрые/свежие данные → скор-правил нет", () => {
    const scanId = seedScan(t, healthyFacts());
    const recs = recommend(t.db, scanId, { now: NOW });
    expect(recs.every((r) => r.kind !== "score")).toBe(true);
  });
});

describe("порядок и запись", () => {
  test("всё отсутствует: Δ desc, tie по rule_id, затем активационные по весу", () => {
    const scanId = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "docs.presence", value: { readme: false, license: false, contributing: false, codeowners: false } },
        { key: "docs.readme", value: { present: false } },
        { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } },
        { key: "cicd.runs", value: { reason: "access" }, status: "no-data" },
        { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
      ),
    );
    const ids = recommend(t.db, scanId, { mode: "own", now: NOW }).map((r) => r.ruleId);
    expect(ids.slice(0, 6)).toEqual([
      "ci-missing", // 7.5
      "license-missing", // 3.75
      "readme-missing", // 2.4975
      "codeowners-missing", // 2.25, tie → alphabetical
      "contributing-missing", // 2.25
      "connect-appsec", // активационные: security 20
    ]);
    expect(ids[6]).toBe("start-tracker"); // issues 15
    // публично тот же скан: CI-строк нет, порядок сохранён
    const pubIds = recommend(t.db, scanId, { now: NOW }).map((r) => r.ruleId);
    expect(pubIds.slice(0, 4)).toEqual(["license-missing", "readme-missing", "codeowners-missing", "contributing-missing"]);
    expect(pubIds[4]).toBe("connect-appsec");
    // приоритеты последовательны
    const recs = recommend(t.db, scanId, { mode: "own", now: NOW });
    expect(recs.map((r) => r.priority)).toEqual(recs.map((_, i) => i + 1));
  });

  test("writeRecommendations идемпотентен (PK scan+version+rule)", () => {
    const scanId = seedScan(t, healthyFacts());
    const recs = recommend(t.db, scanId, { now: NOW });
    writeRecommendations(t.db, scanId, "2.0.0-m2", recs);
    writeRecommendations(t.db, scanId, "2.0.0-m2", recs);
    const c = (t.db.query("SELECT COUNT(*) AS c FROM recommendations WHERE scan_id = ?").get(scanId) as { c: number }).c;
    expect(c).toBe(recs.length);
  });
});
