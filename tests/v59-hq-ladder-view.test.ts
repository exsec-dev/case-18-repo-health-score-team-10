// Режим «По шагам» раздела рекомендаций. Фраза о данных («до 70 не хватит N»,
// «зона „Здоров“») и число в строке проверяются на данных, а не по исходнику.
// Карточки – настоящий конвейер оценки на временной БД (фикстуры v59-a-fixtures).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getRepoCard, type RepoCard } from "../src/api/repos";
import { cardView, ladderView } from "../src/web/cardView";
import { fmtScore, fmtSigned, roundScore } from "../src/web/format";
import { makeApiDb, type ApiTestDb } from "./api-fixtures";
import { healthyFacts } from "./score-fixtures";
import { codeEmptyFacts, reachesFacts, seedScored, unreachedFacts } from "./v59-a-fixtures";

let t: ApiTestDb;
let db: Database;

beforeAll(() => {
  t = makeApiDb();
  db = t.db;
  seedScored(t, "acme", "reaches", reachesFacts());
  seedScored(t, "acme", "unreached", unreachedFacts());
  seedScored(t, "acme", "healthy", healthyFacts());
  seedScored(t, "acme", "empty", codeEmptyFacts());
});

afterAll(() => t.close());

const card = (slug: string): RepoCard => getRepoCard(db, "acme", slug, { withRank: false })!;

describe("В5.9 HQ: вид лестницы = поля карточки", () => {
  test("шаги — строки рекомендаций в порядке лестницы, число = индекс после шага и прирост шага", () => {
    for (const slug of ["reaches", "unreached"]) {
      const c = card(slug);
      const v = cardView(c);
      expect(v.ladder).not.toBeNull();
      const steps = c.ladder!.steps;
      expect(v.ladder!.steps.map((s) => s.item.rec.ruleId)).toEqual(steps.map((s) => s.ruleId));
      v.ladder!.steps.forEach((s, i) => {
        expect(s.item.n).toBe(i + 1);
        expect(s.effect).toBe(`${fmtScore(steps[i]!.indexAfter)} (${fmtSigned(steps[i]!.delta)})`);
      });
      // остальные — все прочие рекомендации карточки, номера продолжают шаги
      const inSteps = new Set(steps.map((s) => s.ruleId));
      expect(v.ladder!.rest.map((r) => r.rec.ruleId)).toEqual(c.recommendations.filter((r) => !inSteps.has(r.ruleId)).map((r) => r.ruleId));
      v.ladder!.rest.forEach((r, i) => expect(r.n).toBe(steps.length + i + 1));
    }
  });

  test("итог: дошли — «зона „Здоров“»; не дошли — «до 70 не хватит N», N = 70 − индекс после последнего шага", () => {
    const reached = card("reaches");
    expect(reached.ladder!.reached).toBe(true);
    const lastR = roundScore(reached.ladder!.steps.at(-1)!.indexAfter);
    expect(lastR).toBeGreaterThanOrEqual(70);
    expect(cardView(reached).ladder!.summary).toBe(`После шага №${reached.ladder!.steps.length} индекс – ${lastR}: зона «Здоров»`);

    const un = card("unreached");
    expect(un.ladder!.reached).toBe(false);
    const lastU = roundScore(un.ladder!.steps.at(-1)!.indexAfter);
    expect(lastU).toBeLessThan(70);
    const summary = cardView(un).ladder!.summary;
    expect(summary).toBe(`После шага №${un.ladder!.steps.length} индекс – ${lastU}, до 70 не хватит ${70 - lastU}`);
    expect(summary).not.toContain("Здоров");
  });

  test("переключателя нет: репо в зоне, без кода, без лестницы", () => {
    for (const slug of ["healthy", "empty"]) {
      const c = card(slug);
      expect(c.ladder ?? null).toBeNull();
      expect(cardView(c).ladder).toBeNull();
    }
  });

  test("шаг без своей строки на карточке — режима нет (строк не выдумываем)", () => {
    const c = card("unreached");
    const forged: RepoCard = { ...c, ladder: { ...c.ladder!, steps: [...c.ladder!.steps, { ruleId: "no-such-rule", delta: 1, indexAfter: 69 }] } };
    expect(ladderView(forged, cardView(c).recommendations)).toBeNull();
  });
});
