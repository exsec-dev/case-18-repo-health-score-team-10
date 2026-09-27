// V5.5 tour 3 round 5 (design audit decisions, 27.09): behavioral tests on data for
// the rating's "нет кода" field (rule 21.09: a field the UI draws = its source) and
// for the rewritten adjustment texts (no jargon, same numbers).
import { describe, expect, test } from "bun:test";
import { listRepos, parseReposQuery } from "../src/api/repos";
import { adjustmentLabel, adjustmentText } from "../src/report/sections";
import { submetricNote } from "../src/report/submetrics";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore } from "./api-fixtures";

describe("rating item codeEmpty = scores.code_empty (finding 7)", () => {
  test("empty repo -> true, repo with code -> false; equals the source row", () => {
    const t = makeApiDb();
    try {
      const empty = seedRepo(t, { org: "r5", repo: "empty" });
      const emptyScan = seedScan(t, empty, { facts: cardFacts() });
      seedScore(t, empty, emptyScan, { total: 0 });
      t.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(emptyScan);
      const full = seedRepo(t, { org: "r5", repo: "full" });
      seedScore(t, full, seedScan(t, full, { facts: cardFacts() }), { total: 70 });
      const parsed = parseReposQuery(new URLSearchParams(""));
      if (!parsed.ok) throw new Error("query");
      const items = listRepos(t.db, parsed.query).items;
      const by = Object.fromEntries(items.map((i) => [i.repo, i.codeEmpty]));
      const source = Object.fromEntries(
        (t.db.query("SELECT r.repo_slug AS repo, s.code_empty AS ce FROM scores s JOIN repos r ON r.id = s.repo_id").all() as { repo: string; ce: number | null }[]).map((r) => [r.repo, r.ce === 1]),
      );
      expect(by).toEqual({ empty: true, full: false });
      expect(by).toEqual(source);
    } finally {
      t.close();
    }
  });
});

describe("adjustment texts without jargon (findings 16, 17, 6)", () => {
  test("small sample: numbers kept, no 'сжат'", () => {
    const text = adjustmentText({ score: 18.5, adjustment: { kind: "small-sample", n: 3, full: 10, floor: 6, raw: 47.5 } } as never)!;
    expect(text).toBe("Мало закрытых задач: 3 из 10 нужных для надежной оценки – балл снижен с 47,5 до 18,5.");
    expect(text).not.toMatch(/сжат/);
  });

  test("labels by kind replace 'Балл сжат'", () => {
    expect(adjustmentLabel({ adjustment: { kind: "small-sample" } } as never)).toBe("Мало задач");
    expect(adjustmentLabel({ adjustment: { kind: "small-code" } } as never)).toBe("Мало кода");
    expect(adjustmentLabel({ adjustment: { kind: "cap" } } as never)).toBe("Есть находки");
  });

  test("older collector -> reader's words, no internal version", () => {
    for (const key of ["issues.backlog_trend", "issues.monthly_flow", "cicd.stability"]) {
      const [cat, sub] = key.split(".") as [string, string];
      expect(submetricNote(cat, sub, "older collector (v4)")).toEqual({ value: "появится после следующего анализа" });
    }
  });
});

describe("trajectory input: categories named in Russian (live check 27.09)", () => {
  test("keys become interface titles; values and other fields unchanged", async () => {
    const { namedTrajectoryPoints } = await import("../src/summary/pipeline");
    const out = namedTrajectoryPoints([{ date: "2026-09-25", headSha: "abc", index: 83, coverage: 1, categories: { documentation: 54, activity: 90, issues: 95, code: 88 } }]);
    expect(out[0]!.categories).toEqual({ Документация: 54, Активность: 90, Задачи: 95, "Состояние кода": 88 });
    expect(out[0]!.index).toBe(83);
  });
});

describe("stripMarkers: markers listed with commas leave no ',,' (live check 27.09)", () => {
  test("commas before the sentence end are dropped, runs of commas collapse", async () => {
    const { stripMarkers } = await import("../src/summary/validator");
    expect(stripMarkers("Проект часто обновляется{sp:activity:1},{sp:activity:2}.")).toBe("Проект часто обновляется.");
    expect(stripMarkers("Есть README{f:docs.presence},, и лицензия.")).toBe("Есть README, и лицензия.");
    expect(stripMarkers("Индекс 83{f:scores.points}, покрытие полное.")).toBe("Индекс 83, покрытие полное.");
  });
});
