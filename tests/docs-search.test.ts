// Поиск по документации (src/docs/search.ts) – на настоящих страницах docs/guide.
import { describe, expect, test } from "bun:test";
import { loadDocs } from "../src/docs/load";
import { buildSearchIndex, queryTerms, searchDocs, stem } from "../src/docs/search";

const index = buildSearchIndex(loadDocs().bundle.pages);

describe("поиск по документации", () => {
  test("основа слова: окончания срезаются у длинных слов, короткие не трогаются", () => {
    expect(stem("оценки")).toBe("оценк");
    expect(stem("Оценка")).toBe("оценк");
    expect(stem("токен")).toBe("токен");
    expect(stem("api")).toBe("api");
    expect(queryTerms("Потолок, ё-моё")).toEqual(["потолок", "моe".replace("e", "е")]);
  });

  test("индекс: каждая страница и каждый раздел", () => {
    const pages = new Set(index.map((e) => e.slug));
    expect(pages.size).toBeGreaterThanOrEqual(15);
    expect(index.some((e) => e.anchor === "potolok")).toBe(true);
  });

  test("запрос находит нужный раздел первым", () => {
    const hit = searchDocs(index, "потолки repo health score")[0]!;
    expect(hit.entry.slug).toBe("method/scores");
    expect(hit.entry.anchor).toBe("potolok");
  });

  test("словоформы: «токена» находит выпуск токена", () => {
    const hits = searchDocs(index, "персонального токена");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.entry.slug === "quickstart")).toBe(true);
  });

  test("все слова должны совпасть; пустой и короткий запрос – пусто", () => {
    expect(searchDocs(index, "потолок абракадабра")).toEqual([]);
    expect(searchDocs(index, "")).toEqual([]);
    expect(searchDocs(index, "а")).toEqual([]);
  });
});
