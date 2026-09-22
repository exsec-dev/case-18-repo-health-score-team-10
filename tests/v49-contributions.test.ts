// v49-contributions.test.ts — «Вклад категорий в оценку» (В4.9, К9.1, К9.12):
// одна чистая функция для отчета и карточки. Поведенческий тест на данных
// (урок 21.09: число, названное суммой, — тестом на данных): сумма
// показанных вкладов = показанный показатель на фикстурах и на живых числах
// исследования (баллы категорий — reports/2026-09-22-m49-prompt-audit-raw/
// implementability.md, A1), «не набрано» = 100 − показатель.
import { describe, expect, test } from "bun:test";
import { totalsFromCategories } from "../src/score/compute";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, SECRETS_CRITICAL_TOTAL_CAP, type CategoryKey } from "../src/score/model";
import { SECRETS_CAP, categoryContributions, fmtBytes, fmtContribution, fmtDecimal, fmtDelta, fmtLoss, fmtNumber, fmtSigned, type ContributionInput } from "../src/web/format";
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

  test("категория с баллом 0 не получает десятых при распределении остатка (живой uikit с CI/CD 0)", () => {
    const cats: ContributionInput[] = [
      { key: "documentation", title: "d", score: 91.0528, weight: 15 },
      { key: "cicd", title: "c", score: 0, weight: 15 },
      { key: "activity", title: "a", score: 79.7676, weight: 15 },
      { key: "issues", title: "i", score: 51.1504, weight: 15 },
      { key: "code", title: "k", score: 60.6801, weight: 20 },
    ];
    const total = cats.reduce((s, c) => s + c.score! * c.weight, 0) / 80;
    const c = categoryContributions(cats, Math.round(total))!;
    expect(c.kind).toBe("bar");
    if (c.kind !== "bar") return;
    expect(c.segments.find((s) => s.key === "cicd")!.tenths).toBe(0);
    expect(c.segments.reduce((s, x) => s + x.tenths, 0)).toBe(Math.round(total) * 10);
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
        const bars = model.blocks.filter((b) => b.kind === "contributions");
        if (!hero || hero.kind !== "hero") throw new Error("нет первого экрана");
        // Круг 4 гейта: показателей в ряду бывает два, и полос столько же,
        // сколько показателей СО ЗНАЧЕНИЕМ, в том же порядке (публичный
        // первым). У зрителя с полным доступом и NULL-индексом слева стоит
        // «Оценки нет» без полосы, а полоса есть у второго показателя.
        const shown = [hero.value === null ? null : { label: hero.label, value: hero.value }, hero.secondary && hero.secondary.value !== null ? { label: hero.secondary.label, value: hero.secondary.value } : null].filter(
          (m): m is { label: string; value: number } => m !== null,
        );
        expect(bars).toHaveLength(shown.length);
        for (const [i, metric] of shown.entries()) {
          const bar = bars[i]!;
          if (bar.kind !== "contributions") throw new Error("не полоса вкладов");
          expect(bar.title).toContain(metric.label);
          if (bar.note !== null) continue;
          const tenths = bar.segments.reduce((s, x) => s + Math.round(Number(x.value.replace("+", "").replace(",", ".")) * 10), 0);
          expect(tenths).toBe(metric.value * 10);
          expect(Number(bar.rest!.value)).toBe(100 - metric.value);
        }
      } finally {
        close();
      }
    });
  }
});

describe("К9.11: русские числа в UI и отчете — одна копия форматтеров", () => {
  test("десятичная запятая и минус U+2212, а не точка и дефис", () => {
    expect([fmtSigned(1.25), fmtSigned(-12.14), fmtSigned(0), fmtSigned(-0.04)]).toEqual(["+1,3", "−12,1", "+0,0", "+0,0"]);
    expect([fmtDelta(3.45), fmtNumber(0.8723), fmtNumber(-2.5), fmtNumber(47), fmtNumber(null)]).toEqual(["+3,5", "0,87", "−2,5", "47", "—"]);
    expect([fmtDecimal(69.86, 1), fmtDecimal(0.5, 2, { trim: true }), fmtDecimal(-0.01, 1)]).toEqual(["69,9", "0,5", "0,0"]);
    expect(fmtBytes(1.5 * 1024 ** 3)).toBe("1,5 ГБ");
  });

  test("в UI и отчете нет своих копий: `toFixed` только внутри fmtDecimal", () => {
    const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const root = join(import.meta.dir, "..", "src");
    for (const dir of ["web", "report"]) {
      for (const file of readdirSync(join(root, dir)).filter((f: string) => /\.tsx?$/.test(f))) {
        const src = readFileSync(join(root, dir, file), "utf8");
        const uses = (src.match(/\.toFixed\(/g) ?? []).length;
        expect({ file, uses }).toEqual({ file, uses: file === "format.ts" ? 1 : 0 });
      }
    }
  });
});
