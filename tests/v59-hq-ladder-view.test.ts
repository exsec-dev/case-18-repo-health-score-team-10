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
      // шаги лестницы — первыми; не дошла до цели — следом правило без числа с
      // наибольшим потолком (`до N`), если такое есть
      const shown = v.ladder!.steps;
      expect(shown.slice(0, steps.length).map((s) => s.item.rec.ruleId)).toEqual(steps.map((s) => s.ruleId));
      shown.forEach((s, i) => expect(s.item.n).toBe(i + 1));
      steps.forEach((st, i) => expect(shown[i]!.effect).toBe(`${fmtScore(st.indexAfter)} (${fmtSigned(st.delta)})`));
      const extra = shown.slice(steps.length);
      expect(extra.length).toBeLessThanOrEqual(1);
      if (extra[0]) {
        expect(c.ladder!.reached).toBe(false);
        expect(extra[0].item.ceiling).not.toBeNull();
        expect(extra[0].effect).toMatch(/^до \d+$/);
      }
      // остальные — все прочие рекомендации карточки (в порядке карточки), номера продолжают шаги
      const inSteps = new Set(shown.map((s) => s.item.rec.ruleId));
      expect(v.ladder!.rest.map((r) => r.rec.ruleId)).toEqual(v.recommendations.filter((r) => !inSteps.has(r.rec.ruleId)).map((r) => r.rec.ruleId));
      v.ladder!.rest.forEach((r, i) => expect(r.n).toBe(shown.length + i + 1));
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
    const unView = cardView(un).ladder!;
    const k = un.ladder!.steps.length;
    const head = `После шага №${k} индекс – ${lastU}, до 70 не хватит ${70 - lastU}`;
    // следующий шаг без числа есть — итог называет его потолок, нет — обрывается на разрыве
    const extra = unView.steps[k];
    if (extra) expect(unView.summary).toBe(`${head}. Шаг №${k + 1} ${extra.item.ceiling! >= 70 - lastU ? "может закрыть разрыв" : "сократит разрыв"}: до ${fmtSigned(extra.item.ceiling!)}, в зависимости от объема работы`);
    else expect(unView.summary).toBe(head);
    expect(unView.summary).not.toContain("Здоров");
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
