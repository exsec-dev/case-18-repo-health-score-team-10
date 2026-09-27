// Лестница – гипотетический план карточки; ответ сравнения ее не несет.
import { expect, test } from "bun:test";
import { compareCardOf } from "../src/api/compare";
import type { RepoCard } from "../src/api/repos";

test("compareCardOf drops the card ladder", () => {
  const card = {
    ai: null,
    recommendations: [],
    evidence: [],
    derived: null,
    job: null,
    ladder: { start: 43, target: 70, steps: [{ ruleId: "license-missing", delta: 5.8, indexAfter: 48.8 }], reached: false, unreachedReason: "no-positive-rules", withoutNumber: [] },
  } as unknown as RepoCard;
  const out = compareCardOf(card) as unknown as Record<string, unknown>;
  expect("ladder" in out).toBe(false);
});
