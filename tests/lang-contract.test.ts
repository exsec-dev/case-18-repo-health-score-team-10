// lang-contract.test.ts — контракт языка рейтинга В4.7 (П2, блок Б1).
// Повторяемый `lang`: пустое значение — «язык не определён», отсутствие —
// все языки; фильтр — принадлежность множеству по ВСЕМУ каталогу (не по
// странице); фасеты — без языкового фильтра и с цветом языка; одиночная
// ссылка `lang=Go` работает как до вехи. Сети нет: чистый читатель на
// временной БД (сид-набор рейтинга из api-fixtures).
import { afterAll, describe, expect, test } from "bun:test";
import { listRepos, parseReposQuery, type RatingResponse, type ReposQuery } from "../src/api/repos";
import { makeApiDb, seedRating, type ApiTestDb } from "./api-fixtures";

const t: ApiTestDb = makeApiDb();
seedRating(t);
t.db.query("UPDATE repos SET language_color = '#00ADD8' WHERE language = 'Go'").run();
t.db.query("UPDATE repos SET language_color = '#A97BFF' WHERE language = 'Kotlin'").run();
afterAll(() => t.close());

const parse = (qs: string): ReposQuery => {
  const res = parseReposQuery(new URLSearchParams(qs));
  if (!res.ok) throw new Error(res.message);
  return res.query;
};
const list = (qs: string): RatingResponse => listRepos(t.db, parse(qs));
const names = (items: { org: string; repo: string }[]): string[] => items.map((i) => `${i.org}/${i.repo}`);

describe("П2: разбор повторяемого lang", () => {
  test("несколько значений — множество в порядке ссылки, повторы схлопнуты", () => {
    expect(parse("lang=Go&lang=Rust").lang).toEqual(["Go", "Rust"]);
    expect(parse("lang=Go&lang=Go&lang=Rust").lang).toEqual(["Go", "Rust"]);
  });

  test("пустое значение — «язык не определён» (null), в том числе рядом с другими", () => {
    expect(parse("lang=").lang).toEqual([null]);
    expect(parse("lang=&lang=Kotlin").lang).toEqual([null, "Kotlin"]);
  });

  test("без lang фильтра нет вовсе", () => {
    expect("lang" in parse("sort=likes")).toBe(false);
  });
});

describe("П2: фильтрация", () => {
  test("обратная совместимость: одиночная ссылка lang=Go отдаёт то же, что до вехи", () => {
    const res = list("lang=Go");
    expect(names(res.items)).toEqual(["k-5-45mm/dozzle-plus", "hex21h/datahint", "tail/no-meta"]);
    expect(res.total).toBe(3);
  });

  test("множество языков — по всему каталогу, а не по странице", () => {
    const p1 = list("lang=Go&lang=Kotlin&per_page=2");
    const p2 = list("lang=Go&lang=Kotlin&per_page=2&page=2");
    expect(p1.total).toBe(4);
    expect(p1.totalPages).toBe(2);
    expect([...names(p1.items), ...names(p2.items)]).toEqual(["k-5-45mm/dozzle-plus", "hex21h/datahint", "divkit/divkit", "tail/no-meta"]);
  });

  test("«не определён» вместе с языком: оба множества проходят, NULL-Score — в nullItems", () => {
    const res = list("lang=&lang=C%2B%2B");
    expect(names(res.items)).toEqual(["yandex-cloud-examples/cloudapp-hugo", "raph/its-wednesday-my-dudes"]);
    expect(names(res.nullItems)).toEqual(["nodata/dark-repo"]);
  });

  test("язык вне каталога — пустой результат, а не ошибка", () => {
    const res = list("lang=COBOL");
    expect({ items: res.items.length, nulls: res.nulls, total: res.total }).toEqual({ items: 0, nulls: 0, total: 0 });
  });

  test("сортировка от фильтра не зависит: порядок выбранных тот же, что в полном списке", () => {
    for (const sort of ["index", "likes", "activity", "name"]) {
      const full = names(list(`sort=${sort}&per_page=100`).items.filter((i) => i.language === "Go" || i.language === "Kotlin"));
      expect(names(list(`sort=${sort}&per_page=100&lang=Go&lang=Kotlin`).items)).toEqual(full);
    }
  });
});

describe("П2: фасеты", () => {
  test("выбранный набор не схлопывает фасеты: они те же, что без фильтра", () => {
    expect(list("lang=Go&lang=Kotlin").facets).toEqual(list("").facets);
    expect(list("lang=").facets).toEqual(list("").facets);
  });

  test("фасет несёт цвет языка; у языка без цвета и у «не определён» — null", () => {
    const facets = list("").facets.languages;
    const byLang = new Map(facets.map((f) => [f.language, f]));
    expect(byLang.get("Go")).toEqual({ language: "Go", count: 3, color: "#00ADD8" });
    expect(byLang.get("Kotlin")?.color).toBe("#A97BFF");
    expect(byLang.get("TSX")?.color).toBeNull();
    expect(byLang.get(null)).toEqual({ language: null, count: 2, color: null });
  });
});
