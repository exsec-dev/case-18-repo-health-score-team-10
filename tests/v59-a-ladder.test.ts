// «Лестница к зеленой зоне» и вынос патчей presence-правил. Числа и утверждения
// пустого состояния проверяются на данных; то, что рефакторинг не сменил
// поведение, – эталоном, снятым кодом до рефакторинга.
import { describe, expect, test } from "bun:test";
import { compute, computeFromFacts, effectiveFacts } from "../src/score/compute";
import { LADDER_TARGET, ladderFromFacts, type Ladder } from "../src/score/ladder";
import { factsDeltaEvaluator, presencePatches, recommend, recommendFromFacts } from "../src/score/recommend";
import { roundScore } from "../src/web/format";
import { makeDb, NOW, seedScan, type FactSpec } from "./score-fixtures";
import {
  codeEmptyFacts,
  goldenCases,
  nothingFacts,
  nullIndexFacts,
  onlyActivationFacts,
  reachesFacts,
  unreachedFacts,
} from "./v59-a-fixtures";
import golden from "./v59-a-recommend-golden.json";
import { healthyFacts, withFacts } from "./score-fixtures";

const INPUT = { scanId: 1, repoId: 1 };
const factsOf = (specs: FactSpec[]) => new Map<string, unknown>(specs.filter((f) => (f.status ?? "ok") === "ok").map((f) => [f.key, f.value]));
const ladderOf = (specs: FactSpec[]): Ladder | null => ladderFromFacts(factsOf(specs), INPUT, NOW);
const indexOf = (ok: Map<string, unknown>) => computeFromFacts(ok, INPUT, NOW).healthcraftIndex;

/** Публичные presence-рекомендации движка на тех же фактах (реальный Δ). */
function publicPresence(ok: Map<string, unknown>) {
  const base = computeFromFacts(ok, INPUT, NOW);
  const categoryScores = Object.fromEntries(Object.entries(base.categories).map(([k, c]) => [k, c.score]));
  return recommendFromFacts(ok, { delta: factsDeltaEvaluator(ok, INPUT, NOW, base), issuesScore: base.categories.issues.score, codeEmpty: base.codeEmpty, categoryScores }).filter(
    (r) => r.kind === "presence" && r.channel === null,
  );
}

describe("В5.9: вынос патчей presence-правил не меняет выдачу (эталон 7ba3b31)", () => {
  test("recommend() и recommendFromFacts() на 14 наборах — байт в байт как до рефакторинга", () => {
    const t = makeDb();
    try {
      const cases = goldenCases();
      expect(cases.length).toBe(Object.keys(golden).length);
      for (const c of cases) {
        const scanId = seedScan(t, c.facts);
        const scores = compute(t.db, scanId, { now: NOW });
        const real = recommend(t.db, scanId, { scores });
        const ok = effectiveFacts(t.db, scanId, scores.repoId).ok;
        const categoryScores = Object.fromEntries(Object.entries(scores.categories).map(([k, v]) => [k, v.score]));
        const constant = recommendFromFacts(ok, { delta: () => ({ delta: 1.5, reason: null }), issuesScore: 40, categoryScores, codeEmpty: scores.codeEmpty, authors: 2 });
        const channel = recommendFromFacts(ok, { delta: () => ({ delta: 2.25, reason: null }), issuesScore: 40, only: "channel", categoryScores, codeEmpty: scores.codeEmpty });
        expect(JSON.parse(JSON.stringify({ real, constant, channel }))).toEqual((golden as Record<string, unknown>)[c.name] as object);
      }
    } finally {
      t.close();
    }
  });

  test("таблица presencePatches: публичные правила только при pub, add-tests только при оцененном «Коде»", () => {
    const ok = factsOf(
      withFacts(unreachedFacts(), { key: "tree.stats", value: { top_level: [], file_count: 300, bytes: 1, loc: 50_000, source_files: 120, test_files: 0 } }, {
        key: "cicd.configs",
        value: { paths: [], has_ci_yaml: false, has_steps: false },
      }),
    );
    const ids = (pub: boolean, codeScored: boolean) => presencePatches(ok, { pub, codeScored }).map((p) => p.ruleId);
    expect(ids(true, true)).toEqual(["license-missing", "contributing-missing", "codeowners-missing", "readme-sections-missing", "add-tests", "ci-missing"]);
    expect(ids(true, false)).not.toContain("add-tests");
    expect(ids(false, true)).toEqual(["ci-missing"]);
    expect(presencePatches(ok, { pub: true, codeScored: true }).filter((p) => p.channel !== null).map((p) => p.ruleId)).toEqual(["ci-missing"]);
  });
});

describe("В5.9: лестница — накопительный пересчет до зоны «здоров»", () => {
  test("достигает 70: шаги жадно по наибольшему Δ, итог — округленный индекс ≥ 70", () => {
    const ok = factsOf(reachesFacts());
    const ladder = ladderFromFacts(ok, INPUT, NOW)!;
    expect(ladder).not.toBeNull();
    expect(roundScore(ladder.start)).toBeLessThan(LADDER_TARGET);
    expect(ladder.target).toBe(70);
    expect(ladder.reached).toBe(true);
    expect(ladder.unreachedReason).toBeNull();
    expect(ladder.steps.length).toBeGreaterThan(0);
    const last = ladder.steps.at(-1)!;
    expect(roundScore(last.indexAfter)).toBeGreaterThanOrEqual(LADDER_TARGET);
    // до последнего шага цель не достигнута: лишних шагов нет
    for (const s of ladder.steps.slice(0, -1)) expect(roundScore(s.indexAfter)).toBeLessThan(LADDER_TARGET);
  });

  test("не достигает 70: правила с Δ > 0 кончились — причина названа, шаги все положительные", () => {
    const ladder = ladderOf(unreachedFacts())!;
    expect(ladder.reached).toBe(false);
    expect(ladder.unreachedReason).toBe("no-positive-rules");
    expect(ladder.steps.map((s) => s.ruleId)).toEqual(["license-missing", "readme-sections-missing", "codeowners-missing", "contributing-missing"]);
    for (const s of ladder.steps) expect(s.delta).toBeGreaterThan(0);
    expect(roundScore(ladder.steps.at(-1)!.indexAfter)).toBeLessThan(LADDER_TARGET);
  });

  test("накопительность: indexAfter каждого шага = пересчет модели на фактах после всех предыдущих шагов", () => {
    for (const specs of [reachesFacts(), unreachedFacts()]) {
      const ok = factsOf(specs);
      const ladder = ladderFromFacts(ok, INPUT, NOW)!;
      let facts = new Map(ok);
      let prev = indexOf(facts)!;
      expect(ladder.start).toBeCloseTo(prev, 4);
      for (const step of ladder.steps) {
        const patch = presencePatches(facts, { pub: true, codeScored: true }).find((p) => p.ruleId === step.ruleId)!;
        expect(patch).toBeDefined();
        facts = new Map(facts);
        patch.patch(facts);
        const after = indexOf(facts)!;
        expect(step.indexAfter).toBeCloseTo(after, 4);
        expect(step.delta).toBeCloseTo(after - prev, 4);
        prev = after;
      }
      // сумма Δ шагов = indexAfter последнего − start (с точностью округления round4 на шаг)
      const sum = ladder.steps.reduce((s, x) => s + x.delta, 0);
      expect(Math.abs(sum - (ladder.steps.at(-1)!.indexAfter - ladder.start))).toBeLessThanOrEqual(ladder.steps.length * 1e-4 + 1e-9);
    }
  });

  test("жадность: каждый шаг — наибольший Δ среди публичных presence-правил на текущих фактах", () => {
    const ok = factsOf(unreachedFacts());
    const ladder = ladderFromFacts(ok, INPUT, NOW)!;
    let facts = new Map(ok);
    for (const step of ladder.steps) {
      const recs = publicPresence(facts);
      const max = Math.max(...recs.map((r) => r.deltaScore!));
      expect(step.delta).toBe(max);
      // равные Δ — по ruleId (порядок orderRecommendations): первая из равных в выдаче
      expect(step.ruleId).toBe(recs.find((r) => r.deltaScore === max)!.ruleId);
      const patch = presencePatches(facts, { pub: true, codeScored: true }).find((p) => p.ruleId === step.ruleId)!;
      facts = new Map(facts);
      patch.patch(facts);
    }
  });

  test("первый шаг = Δ соответствующей рекомендации (та же таблица подмен и та же формула)", () => {
    for (const specs of [reachesFacts(), unreachedFacts(), onlyActivationFacts()]) {
      const ok = factsOf(specs);
      const ladder = ladderFromFacts(ok, INPUT, NOW);
      if (ladder === null || ladder.steps.length === 0) continue;
      const rec = publicPresence(ok).find((r) => r.ruleId === ladder.steps[0]!.ruleId)!;
      expect(rec).toBeDefined();
      expect(ladder.steps[0]!.delta).toBe(rec.deltaScore!);
    }
  });

  test("канальные правила (CI) в лестницу не входят, даже с наибольшим Δ", () => {
    const specs = withFacts(unreachedFacts(), { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } });
    const ok = factsOf(specs);
    // CI-правило срабатывает и у полного Score дает прирост
    expect(presencePatches(ok, { pub: true, codeScored: true }).some((p) => p.ruleId === "ci-missing")).toBe(true);
    const ladder = ladderFromFacts(ok, INPUT, NOW)!;
    expect(ladder.steps.map((s) => s.ruleId)).not.toContain("ci-missing");
    expect(ladder.steps.every((s) => !s.ruleId.startsWith("ci-"))).toBe(true);
  });

  test("только активационные: шагов с числом нет, правило открытия категории — словами", () => {
    const ladder = ladderOf(onlyActivationFacts())!;
    expect(ladder).not.toBeNull();
    expect(ladder.steps).toEqual([]);
    expect(ladder.reached).toBe(false);
    expect(ladder.unreachedReason).toBe("no-positive-rules");
    expect(ladder.withoutNumber).toEqual(["start-tracker"]);
    expect(roundScore(ladder.start)).toBeLessThan(LADDER_TARGET);
  });
});

describe("В5.9: когда лестницы нет (null) — утверждение пустого состояния на данных", () => {
  test("уже в зоне: округленный индекс ≥ 70", () => {
    const ok = factsOf(healthyFacts());
    expect(roundScore(indexOf(ok)!)).toBeGreaterThanOrEqual(LADDER_TARGET);
    // у такого репо есть presence-правило с Δ > 0, но лестница не нужна
    expect(publicPresence(ok).length).toBeGreaterThan(0);
    expect(ladderFromFacts(ok, INPUT, NOW)).toBeNull();
  });

  test("граница зоны — по ОКРУГЛЕННОМУ числу: индекс 69,5+ уже в зоне", () => {
    // noDocs: индекс ~70,2 — без лицензии, CONTRIBUTING и CODEOWNERS, но уже «здоров»
    const ok = factsOf(withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: false, contributing: false, codeowners: false, content_checked: true } }, {
      key: "docs.readme",
      value: { bytes: 8000, sections: 2, flags: { install: false, build: false, test: false } },
    }));
    const idx = indexOf(ok)!;
    expect(idx).toBeLessThan(71);
    expect(roundScore(idx)).toBeGreaterThanOrEqual(LADDER_TARGET);
    expect(ladderFromFacts(ok, INPUT, NOW)).toBeNull();
  });

  test("без кода: индекс 0 как данные, лестницы нет", () => {
    const ok = factsOf(codeEmptyFacts());
    const s = computeFromFacts(ok, INPUT, NOW);
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
    expect(ladderFromFacts(ok, INPUT, NOW)).toBeNull();
  });

  test("индекс NULL (покрытие < 0,4): лестницы нет", () => {
    const ok = factsOf(nullIndexFacts());
    expect(indexOf(ok)).toBeNull();
    expect(ladderFromFacts(ok, INPUT, NOW)).toBeNull();
  });

  test("нет ни шага с числом, ни активационного правила: лестницы нет", () => {
    const ok = factsOf(nothingFacts());
    expect(roundScore(indexOf(ok)!)).toBeLessThan(LADDER_TARGET);
    expect(publicPresence(ok)).toEqual([]);
    expect(ladderFromFacts(ok, INPUT, NOW)).toBeNull();
  });
});
