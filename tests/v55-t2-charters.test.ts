// Charter fixes after a live run: the model misread `issues.stats.flow`
// (old-to-new windows) as "no issues in the last 30 days", called a 0.45-day median
// close "slow" and read index coverage as test coverage. LLM-free regression:
// versions load via loadCharter (fail-fast intact) and the rules are in the texts.
import { expect, test } from "bun:test";
import { loadAllCharters } from "../src/summary/charters";

const all = loadAllCharters();

test("tour 2 charter versions (bumped again by tour 3 round 5): issues 7, trajectory 6, activity 6, code 10", () => {
  // versions include the reader-language section (tests/v55-t3-ai-text-leaks.test.ts)
  expect(all.issues.version).toBe("14");
  expect(all.trajectory.version).toBe("10");
  expect(all.activity.version).toBe("13");
  expect(all.code.version).toBe("17");
});

test("issues charter explains flow windows order and the median close unit", () => {
  const t = all.issues.text;
  expect(t).toContain("от старых к новым");
  expect(t).toContain("ПОСЛЕДНИЙ элемент массива – последние 30 дней");
  expect(t).toContain("меньше 1 – задачи закрываются в тот же день, это быстро");
});

test("trajectory charter: coverage is data completeness, not tests", () => {
  expect(all.trajectory.text).toContain("НЕ о\nтестах");
});

test("activity charter names the PR review sample with its numbers; code charter leaves ownership alone", () => {
  expect(all.activity.text).toContain("{f:activity.pr_review}");
  expect(all.activity.text).toContain("автор\nсливает сам");
  expect(all.code.text).toContain("`code.ownership`");
});

test("edited charters keep the UI language rule: no long dash, no yo", () => {
  for (const role of ["issues", "trajectory", "activity", "code"] as const) {
    expect(all[role].text).not.toContain("—");
    expect(all[role].text).not.toMatch(/[ёЁ]/);
  }
});
