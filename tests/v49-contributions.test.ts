// v49-contributions.test.ts — «Вклад категорий в оценку» (В4.9, К9.1, К9.12):
// одна чистая функция для отчета и карточки. Поведенческий тест на данных
// (урок 21.09: число, названное суммой, — тестом на данных): сумма
// показанных вкладов = показанный показатель на фикстурах и на живых числах
// исследования (баллы категорий — reports/2026-09-22-m49-prompt-audit-raw/
// implementability.md, A1), «не набрано» = 100 − показатель.
import { describe, expect, test } from "bun:test";
import { totalsFromCategories } from "../src/score/compute";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, SECRETS_CRITICAL_TOTAL_CAP, type CategoryKey } from "../src/score/model";
import { SECRETS_CAP, categoryContributions, fmtContribution, fmtLoss, type ContributionInput } from "../src/web/format";
import { buildReportModel } from "../src/report/markdown";
import { REPORT_FIXTURES, fixtureCard } from "./report-fixtures";

const PUB: CategoryKey[] = ["documentation", "activity", "issues", "code"];
const indexInputs = (scores: Record<string, number | null>): ContributionInput[] =>
  PUB.map((key) => ({ key, title: key, score: scores[key] ?? null, weight: INDEX_WEIGHTS[key as keyof typeof INDEX_WEIGHTS] }));

/** Показатель тем же расчетом, что движок (totalsFromCategories), — не копией формулы. */
function engineIndex(scores: Record<string, number | null>): number | null {
  const cats = Object.fromEntries((["documentation", "cicd", "security", "activity", "issues", "code"] as CategoryKey[]).map((k) => [k, { score: scores[k] ?? null }])) as Record<CategoryKey, { score: number | null }>;
  return totalsFromCategories(cats, { codeEmpty: false, secretsCritical: false }).healthcraftIndex;
}

const LIVE: [string, Record<string, number>, number][] = [
  ["gravity-ui/uikit (#20)", { documentation: 91.0528, activity: 79.7676, issues: 51.1504, code: 60.6801 }, 70],
  ["bayselonarrend/openintegrations (#25090)", { documentation: 74.0406, activity: 84.681, issues: 69.8602, code: 98.1538 }, 83],
];

describe("К9.1: сумма показанных вкладов = показатель", () => {
  for (const [name, scores, shown] of LIVE) {
    test(`${name}: вклады до десятых дают ровно ${shown}, «не набрано» – ${100 - shown}`, () => {
      const total = engineIndex(scores)!;
      expect(Math.round(total)).toBe(shown);
      const c = categoryContributions(indexInputs(scores), Math.round(total))!;
      expect(c.kind).toBe("bar");
      if (c.kind !== "bar") return;
      expect(c.segments.reduce((s, x) => s + x.tenths, 0)).toBe(shown * 10);
      expect(c.missing).toBe(100 - shown);
      // каждый показанный вклад отличается от точного меньше чем на десятую
      for (const s of c.segments) expect(Math.abs(s.tenths / 10 - s.exact)).toBeLessThan(0.1 + 1e-9);
    });
  }

  test("uikit: простое округление до десятых дало бы 69,8 — наибольший остаток дает 70,0", () => {
    const scores = LIVE[0]![1];
    const naive = PUB.reduce((s, k) => s + Math.round(((scores[k]! * INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS]) / 100) * 10), 0);
    expect(naive).toBe(698);
    const c = categoryContributions(indexInputs(scores), 70)!;
    expect(c.kind === "bar" && c.segments.map((s) => fmtContribution(s.tenths))).toEqual(["+21,0", "+18,4", "+11,8", "+18,8"]);
  });

  test("«сильнее всего снижают» — по потере с учетом веса, не по баллу", () => {
    const c = categoryContributions(indexInputs(LIVE[0]![1]), 70)!;
    expect(c.kind === "bar" && c.losses.map((l) => [l.key, fmtLoss(l.loss)])).toEqual([
      ["code", "−12,2"],
      ["issues", "−11,2"],
    ]);
  });

  test("категория без данных в полосу не входит, ее вес делится между остальными", () => {
    const scores = { documentation: 80, activity: null, issues: 40, code: 60 };
    const total = engineIndex(scores)!;
    const c = categoryContributions(indexInputs(scores), Math.round(total))!;
    expect(c.kind === "bar" && c.segments.map((s) => s.key)).toEqual(["documentation", "issues", "code"]);
    expect(c.kind === "bar" && c.segments.reduce((s, x) => s + x.tenths, 0)).toBe(Math.round(total) * 10);
  });

  test("потолок 49 (утекшие секреты) — не полоса, а строка: вклады дали бы больше показателя", () => {
    expect(SECRETS_CAP).toBe(SECRETS_CRITICAL_TOTAL_CAP);
    const cats: ContributionInput[] = (Object.keys(SCORE_WEIGHTS) as CategoryKey[]).map((key) => ({ key, title: key, score: 80, weight: SCORE_WEIGHTS[key] }));
    const c = categoryContributions(cats, 49)!;
    expect(c.kind).toBe("capped");
    expect(c.kind === "capped" && Math.round(c.uncapped)).toBe(80);
  });

  test("пустой репозиторий — показатель 0 без полосы; нет показателя — нет вкладов", () => {
    expect(categoryContributions(indexInputs({ documentation: 50 }), 0, { codeEmpty: true })).toEqual({ kind: "empty", total: 0 });
    expect(categoryContributions(indexInputs({ documentation: 50 }), null)).toBeNull();
  });

  for (const name of REPORT_FIXTURES) {
    test(`фикстура ${name}: подписи полосы в отчете складываются в крупный показатель`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const model = buildReportModel(card);
        const hero = model.blocks.find((b) => b.kind === "hero");
        const bar = model.blocks.find((b) => b.kind === "contributions");
        if (!hero || hero.kind !== "hero" || hero.value === null) {
          expect(bar).toBeUndefined();
          return;
        }
        expect(bar?.kind).toBe("contributions");
        if (bar?.kind !== "contributions" || bar.note !== null) return;
        const tenths = bar.segments.reduce((s, x) => s + Math.round(Number(x.value.replace("+", "").replace(",", ".")) * 10), 0);
        expect(tenths).toBe(hero.value * 10);
        expect(Number(bar.rest!.value)).toBe(100 - hero.value);
      } finally {
        close();
      }
    });
  }
});
