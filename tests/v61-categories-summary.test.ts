// Итог под заголовком «Категории» карточки (19.10.2026, вариант A без жаргона):
// две сильнейшие категории и самая слабая — с тем, чего ей не хватает, простыми
// словами; баллов нет — они на полосах под строкой. В MD/PDF остается прежняя строка `strengthsLine`.
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { categoriesSummary } from "../src/web/cardView";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const dbs: ApiTestDb[] = [];
afterAll(() => {
  for (const t of dbs) {
    try {
      t.close();
    } catch {}
  }
});

const cat = (score: number | null, submetrics: Record<string, unknown> = {}) =>
  score === null ? { score: null, no_data: "issues channel no-data", submetrics: {} } : { score, submetrics };

function cardWith(categories: Record<string, unknown>, opts: { codeEmpty?: boolean } = {}) {
  const t = makeApiDb();
  dbs.push(t);
  const id = seedRepo(t, { org: "cs", repo: "r" });
  seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 70, categories });
  if (opts.codeEmpty) t.db.query("UPDATE scores SET code_empty = 1 WHERE repo_id = ?").run(id);
  return getRepoCard(t.db, "cs", "r", {})!;
}

const docs = cat(54, {
  readme: { score: 0.9, value: null },
  license: { score: 1, value: true },
  contributing: { score: 0, value: false },
  codeowners: { score: 0, value: false },
});

describe("categoriesSummary: итог раздела «Категории»", () => {
  test("сильнейшие и слабейшая с причиной простыми словами, без баллов", () => {
    const text = categoriesSummary(cardWith({ documentation: docs, activity: cat(82), issues: cat(96), code: cat(98) }));
    expect(text).toBe("Сильнее всего – состояние кода и задачи. Слабее всего – документация: нет правил для участников и не назначены ответственные за код.");
    // без имен файлов и терминов методики
    expect(text).not.toMatch(/CONTRIBUTING|CODEOWNERS|подметрик/);
    // баллы — на полосах под строкой, в самой строке их нет
    expect(text).not.toMatch(/\d/);
  });

  test("все ниже 70 — опора на лучшую категорию", () => {
    expect(categoriesSummary(cardWith({ documentation: cat(19), activity: cat(30), issues: cat(6), code: cat(65) }))).toBe(
      "Лучше всего – состояние кода. Слабее всего – задачи.",
    );
  });

  test("все от 70 — только сильнейшие; без данных и пустой репо — строки нет", () => {
    expect(categoriesSummary(cardWith({ documentation: cat(90), activity: cat(80), issues: cat(null), code: cat(85) }))).toBe(
      "Сильнее всего – документация и состояние кода.",
    );
    expect(categoriesSummary(cardWith({ documentation: cat(null), activity: cat(null), issues: cat(null), code: cat(null) }))).toBeNull();
    expect(categoriesSummary(cardWith({ documentation: cat(90), activity: cat(20), issues: cat(null), code: cat(0) }, { codeEmpty: true }))).toBeNull();
  });
});
