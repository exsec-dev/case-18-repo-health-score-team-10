// UX 17.10, этап 3 — карточка репозитория: подсказки полосы вклада (только то, чего
// нет на экране), пустой репозиторий (вариант A), числа с одним знаком и разрядами.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contributionBar, restHint, segmentHint } from "../src/report/sections";
import { fmtKb, formatSubmetricValue, submetricContext } from "../src/report/submetrics";
import { recommendationCeiling } from "../src/web/cardView";
import { categoryContributions } from "../src/web/format";
import { fixtureCard } from "./report-fixtures";

const AT = submetricContext("2026-09-16T12:00:00Z");
const fmt = (key: string, value: unknown): string => {
  const [category, sub] = key.split(".") as [string, string];
  return formatSubmetricValue(category, sub, value, AT);
};
const src = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

describe("полоса вклада: подсказка без повторов", () => {
  // индекс 84 по весам 23/23/23/31: Документация 54, Активность 82, Задачи 96, Код 98
  const cats = [
    { key: "documentation", title: "Документация", score: 54, weight: 23 },
    { key: "activity", title: "Активность", score: 82, weight: 23 },
    { key: "issues", title: "Задачи", score: 96, weight: 23 },
    { key: "code", title: "Состояние кода", score: 98, weight: 31 },
  ];
  const c = categoryContributions(cats, 84);

  test("у категории — потолок и доля в оценке, без балла и вклада", () => {
    if (c?.kind !== "bar") throw new Error("bar expected");
    const doc = c.segments.find((s) => s.key === "documentation")!;
    expect(segmentHint(doc, c.total)).toBe("из 23,0 возможного · 15% оценки");
    // ни балла (54), ни вклада (12,4) — они уже в «Категориях» и легенде
    expect(segmentHint(doc, c.total)).not.toMatch(/54|12,4/);
  });

  test("у «не набрано» — где недобрано больше всего; без недобора подсказки нет", () => {
    if (c?.kind !== "bar") throw new Error("bar expected");
    expect(restHint(c.losses)).toBe("больше всего – Документация, 10,6");
    expect(restHint([])).toBeNull();
    // подсказки доходят до полосы карточки
    const bar = contributionBar(c, "HealthCraft Index");
    expect(bar.rest?.hint).toBe("больше всего – Документация, 10,6");
    expect(bar.segments.every((s) => s.hint.startsWith("из "))).toBe(true);
  });

  test("нулевой вклад категории остается сегментом, пустой остаток — нет", () => {
    expect(src("RepoPage.tsx")).toContain(".filter((p) => !p.rest || p.share > 0)");
  });
});

describe("пустой репозиторий — вариант A", () => {
  test("у рекомендаций нет потолка «до +N»: от кода прирост не посчитать", () => {
    const { card, close } = fixtureCard("full");
    try {
      const empty = { ...card, markers: { ...card.markers, codeEmpty: true } };
      expect(empty.recommendations.map((r) => recommendationCeiling(empty, r)).every((x) => x === null)).toBe(true);
    } finally {
      close();
    }
  });

  test("0 серым с меткой «нет кода»; ни проверки активности, ни AI-обзора, ни разборов в категориях", () => {
    const page = src("RepoPage.tsx");
    expect(page).toContain('<Text variant="display-2" color={codeEmpty ? "secondary" : undefined}>');
    expect(page).toMatch(/codeEmpty \? \(\s*<Label theme="unknown" size="s">\s*нет кода/);
    expect(page).toContain("footer={card.score.healthcraftIndex === null || card.markers.codeEmpty ? undefined : <FraudCheckFooter");
    expect(page).toContain("{card.score.healthcraftIndex !== null && !card.markers.codeEmpty && <AiOverviewSection");
    expect(src("RepoV5.tsx")).toContain("if (card.markers.codeEmpty) return null;");
  });
});

describe("числа показателей: один знак, разряды, КБ", () => {
  test("малое ненулевое значение не превращается в «0»", () => {
    expect(fmt("issues.first_resp", 0.03)).toBe("меньше 0,1 ч");
    expect(fmt("issues.close_days", 0.04)).toBe("меньше 0,1 дня");
    expect(fmt("code.density", 0.02)).toBe("меньше 0,1 на 1 тыс. строк");
    expect(fmt("code.density", 0)).toBe("0 на 1 тыс. строк");
  });

  test("большие числа — с разрядами, размер — в КБ с одним знаком", () => {
    expect(fmt("activity.commits_365d", 12480)).toBe("12 480");
    expect([fmtKb(13414), fmtKb(27648), fmtKb(1)]).toEqual(["13,1 КБ", "27,0 КБ", "меньше 0,1 КБ"]);
  });
});
