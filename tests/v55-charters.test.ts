// Charters issues/code/overview after the AI fact-check. LLM-free regression:
// versions load via loadCharter (fail-fast intact), the rules are present in
// the charter texts.
import { expect, test } from "bun:test";
import { loadAllCharters } from "../src/summary/charters";

const all = loadAllCharters();

test("charter versions bumped and load: issues 4->5, code 7->8, overview 5->6", () => {
  // current versions are pinned in tests/v55-t3-ai-text-leaks.test.ts
  expect(all.issues.version).toBe("14");
  expect(all.code.version).toBe("17");
  expect(all.overview.version).toBe("18");
});

test("issues charter: no issue titles/texts in input; comments sample named explicitly", () => {
  const t = all.issues.text;
  // the model claimed "судя по заголовкам открытых задач" with no titles in input
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
  // specialist wrote "долг" and one paragraph later "актуальных задач нет"
  expect(t).toContain("Самопротиворечие");
  expect(t).toContain("актуальных задач нет");
  expect(t).toMatch(/фикстур/);
  expect(t).toMatch(/тестовых строк/);
});

test("overview charter: specialist's self-refuted claim is not propagated; recommendations only on confirmed", () => {
  const t = all.overview.text;
  // overview recommended "уделить внимание анализу пометок TODO" on a refuted claim
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
