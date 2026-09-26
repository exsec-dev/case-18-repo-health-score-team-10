// V5.5 tour 1 (W3): charters issues/code/overview by the repo-vitals fact-check
// (reports/2026-09-25-m52-ai-factcheck-repo-vitals.md, items a-c).
// LLM-free regression: bumped versions load via loadCharter (fail-fast intact),
// new rules are present in the charter texts (source-assert is valid for texts).
import { expect, test } from "bun:test";
import { loadAllCharters } from "../src/summary/charters";

const all = loadAllCharters();

test("charter versions bumped and load: issues 4->5, code 7->8, overview 5->6", () => {
  // V5.5 tour 2 (HQ acceptance, live repo-vitals rerun): issues 5->6, code 8->9 —
  // pinned in tests/v55-t2-charters.test.ts; the tour-1 rules below still hold
  expect(all.issues.version).toBe("6");
  expect(all.code.version).toBe("9");
  expect(all.overview.version).toBe("6");
});

test("issues charter: no issue titles/texts in input; comments sample named explicitly", () => {
  const t = all.issues.text;
  // X1: the model claimed "судя по заголовкам открытых задач" with no titles in input
  expect(t).toContain("Текстов и заголовков задач во входе НЕТ");
  expect(t).not.toContain("Прочитай заголовки открытых задач");
  // comments sample must be named as "N answered out of M fresh"
  expect(t).toContain("задач с ответом из");
  expect(t).toContain("answered");
  expect(t).toContain("censored");
  // small-N guard: 1 out of 50 is "answers are rare", not "responsive"
  expect(t).toContain("1 ответ из 50");
});

test("code charter: fixtures/tests/docs markers are not tech debt; self-contradiction is rejected", () => {
  const t = all.code.text;
  // X2: specialist wrote "долг" and one paragraph later "актуальных задач нет"
  expect(t).toContain("Самопротиворечие");
  expect(t).toContain("актуальных задач нет");
  expect(t).toMatch(/фикстур/);
  expect(t).toMatch(/тестовых строк/);
});

test("overview charter: specialist's self-refuted claim is not propagated; recommendations only on confirmed", () => {
  const t = all.overview.text;
  // X3: overview recommended "уделить внимание анализу пометок TODO" on a refuted claim
  expect(t).toContain("опровергнут");
  expect(t).toContain("не переносится");
  expect(t).toContain("только по подтвержденному");
});

test("charters typography: no long dash, no «ё» in edited charters", () => {
  for (const role of ["issues", "code", "overview"] as const) {
    // loaded text = tone guide + charter body; both must follow the language rule
    const body = all[role].text;
    expect(body).not.toContain("—");
    expect(body).not.toMatch(/[ёЁ]/);
  }
});
