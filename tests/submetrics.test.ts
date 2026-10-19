// Словарь подметрик. Полнота — на данных: набор ключей, который РЕАЛЬНО выдает
// скоринг (`computeFromFacts` на полном наборе фактов и на ветке «трекер не
// ведется»), совпадает со словарем. Формы значений — по одной на подметрику,
// составные не обрезаются, пустое — «—», «N дней» — на момент скана.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeFromFacts } from "../src/score/compute";
import { NO_VALUE, SUBMETRICS, formatSubmetricValue, submetricContext, submetricTitle } from "../src/report/submetrics";
import { cardFacts, NOW } from "./api-fixtures";

const AT = submetricContext("2026-09-16T12:00:00Z");
const fmt = (key: string, value: unknown, ctx = AT): string => {
  const [category, sub] = key.split(".") as [string, string];
  return formatSubmetricValue(category, sub, value, ctx);
};

/** Ключи подметрик, которые выдаёт скоринг на фактах (все категории). */
function computedKeys(facts: { key: string; value: unknown }[]): string[] {
  const map = new Map(facts.map((f) => [f.key, f.value]));
  const cats = computeFromFacts(map, { scanId: 0, repoId: 0 }, NOW).categories as Record<string, { submetrics: Record<string, unknown> }>;
  return Object.entries(cats).flatMap(([cat, c]) => Object.keys(c.submetrics).map((sub) => `${cat}.${sub}`));
}

describe("П4.2: полнота словаря", () => {
  test("у всех 33 подметрик скоринга есть название и форма показа", () => {
    const full = cardFacts()
      .filter((f) => f.status !== "no-data")
      .concat([
        { key: "cicd.runs", value: { last_status: "success", success_rate: 0.9, duration_p50: 300, runs_count: 5 } },
        { key: "appsec.findings", value: { severity_counts: { critical: 0, high: 1, medium: 0, low: 0 }, resolved_share: 0.5, secrets_critical: false } },
        // справочные review PR и карта владельцев
        { key: "activity.pr_review", value: { pulls: 3, sampled: 2, answered: 1, median_first_response_hours: 5, open_sampled: 1, waiting_over_threshold: 0, threshold_hours: 72, median_review_comments: 1, comments_capped: 0, merged: 1, median_merge_hours: 30 } },
        { key: "code.ownership", value: { changes: 4, single_owner_share: 1, dirs: [{ dir: "src", changes: 4, authors: 1, owner: "Dev", owner_share: 1 }], dirs_total: 1, threshold: 0.8 } },
      ]);
    const tracker = cardFacts().map((f) => (f.key === "issues.stats" ? { key: "issues.stats", value: { open: 0, closed: 0 } } : f));
    // PR нет — одна строка «PR не используются» (своя ветка ключа)
    const noPulls = [...cardFacts(), { key: "activity.pr_review", value: { pulls: 0, sampled: 0 } }];
    const produced = [...new Set([...computedKeys(full), ...computedKeys(tracker), ...computedKeys(noPulls)])].sort();
    // среди них справочные (без веса): bus factor, стабильность CI, динамика
    // бэклога, поток задач, 5 строк review PR и карта владельцев
    expect(produced.length).toBe(39);
    expect(Object.keys(SUBMETRICS).sort()).toEqual(produced);
    for (const key of produced) {
      const spec = SUBMETRICS[key]!;
      expect({ key, title: spec.title.length > 0, unit: spec.unit.length > 0 }).toEqual({ key, title: true, unit: true });
    }
  });

  test("названия на карточке — только из словаря (иконки подметрик сняты 18.10.2026: вместо них сектор балла)", () => {
    const page = readFileSync(join(import.meta.dir, "..", "src", "web", "RepoPage.tsx"), "utf8");
    const breakdown = readFileSync(join(import.meta.dir, "..", "src", "web", "categoryBreakdown.ts"), "utf8");
    expect(breakdown).toContain("submetricTitle(key, sub)");
    // названий в компоненте больше нет — один источник
    expect(page.includes("const SUBMETRIC_TITLES")).toBe(false);
  });

  test("название — из словаря; незнакомый ключ — как есть, показ не падает", () => {
    expect(submetricTitle("activity", "fresh")).toBe("Свежесть последнего коммита человека");
    expect(submetricTitle("code", "brand_new")).toBe("brand_new");
    expect(fmt("code.brand_new", { a: 1 })).toBe('{"a":1}');
    expect(fmt("code.brand_new", 0.8723404255319149)).toBe("0,9");
  });
});

describe("П4.2: форма значений — единица, масштаб, составные", () => {
  test("документация: README составным значением, отсутствие файла, флаги присутствия", () => {
    expect(fmt("documentation.readme", { bytes: 8000, sections: 5, flags: { install: true, build: false, test: true } })).toBe("7,8 КБ, 5 разделов, есть: установка, тесты");
    expect(fmt("documentation.readme", { bytes: 1, sections: 1, flags: {} })).toBe("меньше 0,1 КБ, 1 раздел");
    expect(fmt("documentation.readme", { present: false })).toBe("нет файла");
    expect(fmt("documentation.license", true)).toBe("есть");
    expect(fmt("documentation.license", undefined)).toBe(NO_VALUE);
  });

  test("CI: конфиг булевыми признаками, доля — процентом, длительность — из секунд", () => {
    expect(fmt("cicd.config", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true })).toBe("ci.yaml со шагами");
    expect(fmt("cicd.config", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false })).toBe("ci.yaml без шагов");
    expect(fmt("cicd.config", { paths: [], has_ci_yaml: false, has_steps: false })).toBe("нет ci.yaml");
    expect(fmt("cicd.pass_rate", 0.95)).toBe("95%");
    expect([45, 420, 3600, 3900].map((s) => fmt("cicd.duration", s))).toEqual(["45 с", "7 мин", "1 ч", "1 ч 5 мин"]);
  });

  test("Security: плотность на 10 тыс. строк, доля закрытых, утечки словом", () => {
    expect(fmt("security.density", 38)).toBe("38 на 10 тыс. строк");
    expect(fmt("security.density", 3.456)).toBe("3,5 на 10 тыс. строк");
    expect(fmt("security.resolved", 0.8)).toBe("80%");
    // без двойного отрицания — название «Критичные утечки секретов»
    expect([fmt("security.secrets", true), fmt("security.secrets", false)]).toEqual(["найдены", "не найдены"]);
  });

  test("активность: «N дней» на момент скана, частота, авторы, зеркало составным значением", () => {
    const at = Date.parse("2026-09-16T12:00:00Z");
    const daysAgo = (d: number) => at - d * 86_400_000 - 3_600_000;
    expect([0, 1, 2, 5, 21, 22, 111].map((d) => fmt("activity.fresh", daysAgo(d)))).toEqual([
      "0 дней",
      "1 день",
      "2 дня",
      "5 дней",
      "21 день",
      "22 дня",
      "111 дней",
    ]);
    // момент показа не участвует: тот же скан через год показывает то же число
    expect(fmt("activity.fresh", daysAgo(5), submetricContext("2026-09-16T12:00:00Z"))).toBe("5 дней");
    // момента скана нет — «—», а не сырая отметка времени
    expect(fmt("activity.fresh", daysAgo(5), { at: null })).toBe(NO_VALUE);
    expect(fmt("activity.freq", 4.333333)).toBe("4,3 в месяц");
    expect([fmt("activity.contributors", 1), fmt("activity.contributors", 3), fmt("activity.contributors", 12)]).toEqual(["1 автор", "3 автора", "12 авторов"]);
    expect(fmt("activity.mirror_likeness", { sync_share: 0.125, authors: 2, committers: 3 })).toBe("синхронизаций 13%, авторов 2, коммитеров 3");
    expect([fmt("activity.pulls_90d", 3), fmt("activity.releases_12m", 0), fmt("activity.commits_90d", 13), fmt("activity.commits_365d", 40), fmt("activity.sync_bursts", 0)]).toEqual([
      "3",
      "0",
      "13",
      "40",
      "0",
    ]);
  });

  test("issues: доли процентом, дни и часы, трекер составным значением", () => {
    expect([fmt("issues.stale", 0.5), fmt("issues.resolution", 0.7142857142857143)]).toEqual(["50%", "71%"]);
    expect([fmt("issues.close_days", 1), fmt("issues.close_days", 5), fmt("issues.close_days", 2.5)]).toEqual(["1 день", "5 дней", "2,5 дня"]);
    expect(fmt("issues.first_resp", 30)).toBe("30 ч");
    expect(fmt("issues.tracker_unused", { open: 0, closed: 0 })).toBe("открытых 0, закрытых 0");
  });

  test("код: плотность на 1 тыс. строк (доля округлена), доля старых, корень, счетчик", () => {
    expect(fmt("code.density", 0.8723404255319149)).toBe("0,9 на 1 тыс. строк");
    expect(fmt("code.old_share", 0.5)).toBe("50%");
    expect([fmt("code.root", 1), fmt("code.root", 4), fmt("code.root", 11)]).toEqual(["1 элемент", "4 элемента", "11 элементов"]);
    expect(fmt("code.todo_total", 5)).toBe("5");
  });

  test("без значения — «—» (tri-state), составные никогда не обрезаются многоточием", () => {
    for (const key of Object.keys(SUBMETRICS)) {
      expect({ key, empty: fmt(key, null), missing: fmt(key, undefined) }).toEqual({ key, empty: NO_VALUE, missing: NO_VALUE });
    }
    const long = fmt("documentation.readme", { bytes: 123456789, sections: 987654, flags: { install: true, build: true, test: true } });
    expect(long).toBe("120 563,3 КБ, 987 654 раздела, есть: установка, сборка, тесты");
    expect(long.includes("…")).toBe(false);
  });
});

describe("П4.2: одно правило на страницу, MD и PDF", () => {
  test("страница и MD берут название и значение из словаря; сырые значения — только в доказательствах", () => {
    const root = join(import.meta.dir, "..", "src");
    const page = readFileSync(join(root, "web", "RepoPage.tsx"), "utf8");
    const breakdown = readFileSync(join(root, "web", "categoryBreakdown.ts"), "utf8");
    // модель отчета строит build.ts; значение — `submetricShownValue` (словарь + заметка)
    const md = readFileSync(join(root, "report", "build.ts"), "utf8");
    expect({
      // страница берет значение через `submetricShownValue` — тот же словарь, что отчет
      // 18.10.2026: строки раскрытия строит categoryBreakdown.ts тем же словарем
      // 19.10.2026: через submetricShownParts — тот же словарь, пояснение в скобке отдельно (в подсказку)
      pageImports: breakdown.includes('import { displayOnly, fmtKb, submetricContext, submetricShownParts, submetricTitle, subweightKey } from "../report/submetrics";'),
      pageValue: breakdown.includes("submetricShownParts(key, sub, entry, ctx)"),
      pageTitle: breakdown.includes("submetricTitle(key, sub)"),
      mdRow: md.includes("const value = submetricShownValue(key, sub, entry, ctx, cat.submetrics);") && md.includes("line(submetricTitle(key, sub)),"),
      mdContext: md.includes("const ctx = submetricContext(score.computedAt);"),
      proofRaw: page.includes("{fmtFactValue(fact.value)}"),
    }).toEqual({ pageImports: true, pageValue: true, pageTitle: true, mdRow: true, mdContext: true, proofRaw: true });
    // строка значения больше не режется многоточием
    const css = readFileSync(join(root, "web", "layout.css"), "utf8");
    const rule = css.slice(css.indexOf(".rh-subrow__value {"), css.indexOf("}", css.indexOf(".rh-subrow__value {")));
    expect({ ellipsis: rule.includes("text-overflow: ellipsis"), nowrap: rule.includes("white-space: nowrap") }).toEqual({ ellipsis: false, nowrap: false });
  });
});
