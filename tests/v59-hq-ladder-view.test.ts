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
      // 19.10.2026: строка «52 (+5,8)» (поле effect) снята — на экране прирост и индекс после шага отдельно.
      // Аудит 20.10: прирост — разница показанных (округленных) индексов, чтобы видимые
      // числа складывались (63 → 66 → 70: «+3», «+4»); сырой Δ — только если разница не положительна
      steps.forEach((st, i) => {
        const before = roundScore(i === 0 ? c.ladder!.start : steps[i - 1]!.indexAfter);
        const d = roundScore(st.indexAfter) - before;
        expect(shown[i]!.gain).toBe(d > 0 ? `+${d}` : fmtSigned(st.delta));
        expect(shown[i]!.after).toBe(fmtScore(st.indexAfter));
      });
      const extra = shown.slice(steps.length);
      expect(extra.length).toBeLessThanOrEqual(1);
      if (extra[0]) {
        expect(c.ladder!.reached).toBe(false);
        expect(extra[0].item.ceiling).not.toBeNull();
        expect(extra[0].after).toMatch(/^до \d+$/);
      }
      // остальные — все прочие рекомендации карточки (в порядке карточки), номера продолжают шаги
      const inSteps = new Set(shown.map((s) => s.item.rec.ruleId));
      expect(v.ladder!.rest.map((r) => r.rec.ruleId)).toEqual(v.recommendations.filter((r) => !inSteps.has(r.rec.ruleId)).map((r) => r.rec.ruleId));
      v.ladder!.rest.forEach((r, i) => expect(r.n).toBe(shown.length + i + 1));
    }
  });

  // 19.10.2026: итог под последним шагом (поле summary) снят — на экране только строка над
  // списком (headline); проверка та же по смыслу: дошли — «в зону „Здоров“», не дошли — разрыв
  test("итог: дошли — «в зону „Здоров“»; не дошли — индекс после последнего шага и разрыв до 70", () => {
    const reached = card("reaches");
    expect(reached.ladder!.reached).toBe(true);
    const lastR = roundScore(reached.ladder!.steps.at(-1)!.indexAfter);
    expect(lastR).toBeGreaterThanOrEqual(70);
    const kR = reached.ladder!.steps.length;
    expect(cardView(reached).ladder!.headline).toBe(`${kR === 1 ? "Шаг №1 выведет" : `Шаги №1-${kR} выведут`} индекс в зону «Здоров»`);

    const un = card("unreached");
    expect(un.ladder!.reached).toBe(false);
    const lastU = roundScore(un.ladder!.steps.at(-1)!.indexAfter);
    expect(lastU).toBeLessThan(70);
    const unView = cardView(un).ladder!;
    const k = un.ladder!.steps.length;
    const head = `${k === 1 ? "Шаг №1 поднимет" : `Шаги №1-${k} поднимут`} индекс до ${lastU}`;
    // следующий шаг без числа есть — итог говорит, может ли он закрыть разрыв, нет — называет разрыв.
    // Аудит 20.10: «может вывести» — по тому же правилу, что отметка reach шага: округленный
    // «индекс после последнего шага + потолок» (не больше 100) дотягивает до 70
    const extra = unView.steps[k];
    if (extra) {
      const reach = roundScore(Math.min(100, un.ladder!.steps.at(-1)!.indexAfter + extra.item.ceiling!)) >= 70;
      expect(extra.reach).toBe(reach);
      expect(unView.headline).toBe(`${head}, а №${k + 1} ${reach ? "может вывести его в зону «Здоров»" : "приблизит его к зоне «Здоров»"}`);
    }
    else expect(unView.headline).toBe(`${head} – до зоны «Здоров» не хватит ${70 - lastU}`);
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
