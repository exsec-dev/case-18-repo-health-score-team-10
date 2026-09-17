// recommend.test.ts — Б4: движок рекомендаций (§8): presence-Δ — реальный
// прирост итога (В4.1-fix, К-Ф1.2: разность compute на подменённых фактах),
// активационная ветка без числа (0/0-issues, AppSec, CI-раны),
// порядок выдачи (Δ desc → активационные по весу категории desc),
// идемпотентность записи.
import { afterAll, describe, expect, test } from "bun:test";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { compute } from "../src/score/compute";
import { FactSpec, NOW, TestDb, healthyFacts, makeDb, seedScan, withFacts } from "./score-fixtures";

const t: TestDb = makeDb();
afterAll(() => t.close());

/** Реальный прирост: итог скана с подменёнными фактами − итог исходного (оба — compute, каждый в своём репо). */
function realGain(before: FactSpec[], after: FactSpec[], scope: "rating" | "full"): number {
  const pick = (id: number) => {
    const s = compute(t.db, id, { now: NOW });
    return scope === "rating" ? s.totalRating! : s.totalFull!;
  };
  return Math.round((pick(seedScan(t, after)) - pick(seedScan(t, before))) * 10000) / 10000;
}

const NO_RUNS: FactSpec = { key: "cicd.runs", value: { reason: "access" }, status: "no-data" };

describe("presence-правила: реальный прирост итога (К-Ф1.2)", () => {
  test("здоровое репо: presence-правил нет, только connect-appsec", () => {
    const scanId = seedScan(t, healthyFacts());
    const recs = recommend(t.db, scanId, { now: NOW });
    // фикстура: codeowners:false → одно presence-правило + активационная
    expect(recs.map((r) => r.ruleId)).toEqual(["codeowners-missing", "connect-appsec"]);
    expect(recs[0]!.kind).toBe("presence");
    expect(recs[1]!.kind).toBe("activation");
    expect(recs[1]!.deltaScore).toBeNull();
    // В4.1 (К1): публичные правила без канала, AppSec-активация — канал appsec
    expect(recs[0]!.channel).toBeNull();
    expect(recs[1]!.channel).toBe("appsec");
  });

  test("нет лицензии → Δ к Score в рейтинге = реальный прирост (перенормировка 0.65, не номинальные 3.75)", () => {
    const base = withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true } });
    const fixed = withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: true } });
    const rec = recommend(t.db, seedScan(t, base), { now: NOW }).find((r) => r.ruleId === "license-missing")!;
    const gain = realGain(base, fixed, "rating");
    expect(rec.deltaScore).toBe(gain);
    expect(gain).toBeCloseTo(3.75 / 0.65, 3); // 4 публичные категории с полным покрытием
    expect(rec.expectedImpact).toBe(`+${gain.toFixed(1)} к Score в рейтинге`);
    expect(rec.factRefs).toContain("docs.presence");
  });

  test("нет README → подмена «README есть, 0 байт, без секций»", () => {
    const base = withFacts(
      healthyFacts(),
      { key: "docs.presence", value: { readme: false, license: true, contributing: true, codeowners: true } },
      { key: "docs.readme", value: { present: false } },
    );
    const fixed = withFacts(
      healthyFacts(),
      { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: true } },
      { key: "docs.readme", value: { present: true, bytes: 0, flags: {} } },
    );
    const rec = recommend(t.db, seedScan(t, base), { now: NOW }).find((r) => r.ruleId === "readme-missing")!;
    expect(rec.deltaScore).toBe(realGain(base, fixed, "rating"));
    expect(rec.deltaScore!).toBeGreaterThan(0);
  });

  test("README без 2 секций из 3 → подмена недостающих флагов", () => {
    const base = withFacts(healthyFacts(), { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } });
    const fixed = withFacts(healthyFacts(), { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: true, test: true } } });
    const rec = recommend(t.db, seedScan(t, base), { now: NOW }).find((r) => r.ruleId === "readme-sections-missing")!;
    expect(rec.deltaScore).toBe(realGain(base, fixed, "rating"));
    expect(rec.deltaScore!).toBeGreaterThan(0);
  });

  test("нет CI / ci.yaml без шагов → Δ к полному Score; CI-правила помечены каналом cicd", () => {
    const noCiFacts = withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } }, NO_RUNS);
    const noCi = seedScan(t, noCiFacts);
    const rec1 = recommend(t.db, noCi, { now: NOW }).find((r) => r.ruleId === "ci-missing")!;
    expect(rec1.deltaScore).toBe(realGain(noCiFacts, withFacts(noCiFacts, { key: "cicd.configs", value: { has_ci_yaml: true, has_steps: true } }), "full"));
    expect(rec1.deltaScore!).toBeGreaterThan(0);
    expect(rec1.expectedImpact).toBe(`+${rec1.deltaScore!.toFixed(1)} к полному Score`);
    // CI-правила существуют в одной выдаче, но только с каналом cicd —
    // карточка скрывает их от зрителя без доступа к CI (К2)
    const ciRules = recommend(t.db, noCi, { now: NOW }).filter((r) => ["ci-missing", "ci-no-steps", "grant-ci-runs"].includes(r.ruleId));
    expect(ciRules.length).toBeGreaterThan(0);
    expect(ciRules.every((r) => r.channel === "cicd")).toBe(true);

    const noStepsFacts = withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false } }, NO_RUNS);
    const noSteps = seedScan(t, noStepsFacts);
    const rec2 = recommend(t.db, noSteps, { now: NOW }).find((r) => r.ruleId === "ci-no-steps")!;
    const fixedSteps = withFacts(noStepsFacts, { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } });
    expect(rec2.deltaScore).toBe(realGain(noStepsFacts, fixedSteps, "full"));
    // активационная «дайте доступ к прогонам» не путается с presence
    const ids = recommend(t.db, noSteps, { now: NOW }).map((r) => r.ruleId);
    expect(ids).not.toContain("grant-ci-runs"); // шагов нет — активировать нечего
  });

  test("Δ = 0 с причиной: кап 49 (только полный), нет кода, итог NULL", () => {
    const capped = withFacts(
      healthyFacts(),
      { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } },
      { key: "appsec.findings", value: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 1, secrets_critical: true } },
    );
    const ci = recommend(t.db, seedScan(t, capped), { now: NOW }).find((r) => r.ruleId === "ci-missing")!;
    expect({ delta: ci.deltaScore, impact: ci.expectedImpact }).toEqual({ delta: 0, impact: "+0.0 к полному Score — упирается в кап 49" });

    const empty = withFacts(
      healthyFacts(),
      { key: "tree.stats", value: { top_level: [], file_count: 0, bytes: 0, loc: 0 } },
      { key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true } },
    );
    const lic = recommend(t.db, seedScan(t, empty), { now: NOW }).find((r) => r.ruleId === "license-missing")!;
    expect({ delta: lic.deltaScore, impact: lic.expectedImpact }).toEqual({ delta: 0, impact: "+0.0 к Score в рейтинге — в репозитории нет кода" });

    // только git-документация: покрытие рейтинга < 0.4 → итог NULL
    const sparse: FactSpec[] = [{ key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: true } }];
    const nul = recommend(t.db, seedScan(t, sparse), { now: NOW }).find((r) => r.ruleId === "license-missing")!;
    expect({ delta: nul.deltaScore, impact: nul.expectedImpact }).toEqual({ delta: 0, impact: "+0.0 к Score в рейтинге — итог появится при большем покрытии" });
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

  test("connect-appsec (В4.1): нейтральный текст без «публичного режима», канал appsec", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const recs = recommend(t.db, scanId, { now: NOW });
    const appsec = recs.find((r) => r.ruleId === "connect-appsec")!;
    expect(appsec.channel).toBe("appsec");
    expect(appsec.expectedImpact).toContain("src.repositories.useAppSecScan");
    expect(appsec.expectedImpact).not.toMatch(/coverage 1\.00→1\.00/); // пустой текст В3 умер
    expect(`${appsec.problem} ${appsec.action} ${appsec.expectedImpact}`).not.toMatch(/публичн|своего репо/i);
    const grant = recs.find((r) => r.ruleId === "grant-ci-runs")!;
    expect(grant.channel).toBe("cicd");
    expect(grant.opensCategory).toBe("cicd");
    expect(grant.deltaScore).toBeNull();
    // порядок активационных по весу: security (20) раньше cicd (15)
    expect(recs.indexOf(appsec)).toBeLessThan(recs.indexOf(grant));
  });

  test("AppSec-факт есть → connect-appsec не летит; критичные → скор-правило", () => {
    const scanId = seedScan(
      t,
      withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true } }),
    );
    const recs = recommend(t.db, scanId, { now: NOW });
    expect(recs.some((r) => r.ruleId === "connect-appsec")).toBe(false);
    expect(recs.find((r) => r.ruleId === "appsec-critical")!.channel).toBe("appsec");
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
    const ids = recommend(t.db, scanId, { now: NOW }).map((r) => r.ruleId);
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
    const all = recommend(t.db, scanId, { now: NOW });
    const ids = all.map((r) => r.ruleId);
    const presence = all.filter((r) => r.kind === "presence");
    // К-Ф1.2: presence — по реальному Δ убыв., затем rule_id
    const expected = [...presence].sort((a, b) => b.deltaScore! - a.deltaScore! || a.ruleId.localeCompare(b.ruleId)).map((r) => r.ruleId);
    expect(presence.map((r) => r.ruleId)).toEqual(expected);
    expect(new Set(expected)).toEqual(new Set(["ci-missing", "license-missing", "readme-missing", "codeowners-missing", "contributing-missing"]));
    // равные Δ (codeowners и contributing — один подвес) идут по rule_id
    expect(ids.indexOf("codeowners-missing")).toBe(ids.indexOf("contributing-missing") - 1);
    expect(ids[5]).toBe("connect-appsec"); // активационные: security 20
    expect(ids[6]).toBe("start-tracker"); // issues 15
    // приоритеты последовательны
    const recs = recommend(t.db, scanId, { now: NOW });
    expect(recs.map((r) => r.priority)).toEqual(recs.map((_, i) => i + 1));
  });

  test("writeRecommendations идемпотентен и заменяет выдачу скана целиком; channel пишется", () => {
    const scanId = seedScan(t, healthyFacts());
    const recs = recommend(t.db, scanId, { now: NOW });
    writeRecommendations(t.db, scanId, "2.0.0-m2", recs);
    writeRecommendations(t.db, scanId, "2.0.0-m2", recs);
    const c = (t.db.query("SELECT COUNT(*) AS c FROM recommendations WHERE scan_id = ?").get(scanId) as { c: number }).c;
    expect(c).toBe(recs.length);
    const ch = t.db.query("SELECT channel FROM recommendations WHERE scan_id = ? AND rule_id = 'connect-appsec'").get(scanId) as { channel: string };
    expect(ch.channel).toBe("appsec");
    writeRecommendations(t.db, scanId, "2.0.0-m2", recs.slice(0, 1));
    const c2 = (t.db.query("SELECT COUNT(*) AS c FROM recommendations WHERE scan_id = ?").get(scanId) as { c: number }).c;
    expect(c2).toBe(1);
  });
});
