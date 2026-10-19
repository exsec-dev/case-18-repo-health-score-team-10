// UX 18.10, хвост аудита: SC-9/10/15 (стили на компонентах и токенах Gravity без
// внутренних переменных uikit), таблица подметрик для Safari, тексты TXT-24…26.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../src/web/format";

const web = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

describe("стили: только публичный API Gravity", () => {
  test("SC-10: внутренние переменные uikit (--_--*) не задаются", () => {
    const css = web("layout.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/--_--[\w-]+\s*:/);
    expect(css).not.toContain("var(--_--");
  });

  test("SC-15: кегли — токенами шкалы, без чисел в px", () => {
    expect(web("layout.css")).not.toMatch(/font-size: \d+px/);
  });

  test("SC-9: состояния строк — Label unknown s, своей «пилюли» нет", () => {
    const me = web("MePage.tsx");
    expect(me).not.toContain('className="rh-state');
    expect(web("DocsPage.tsx")).not.toMatch(/className="rh-(state|pill)\b/);
    expect(web("layout.css")).not.toMatch(/^\.rh-(state|pill) \{/m);
  });

  // 19.10.2026: старой таблицы подметрик (.rh-subrows) больше нет — раскрытие категории
  // строит таблица разбивки, ее строки .rh-cbd__row — блоки на subgrid сетки таблицы
  test("Safari: строки таблицы подметрик — блоки на subgrid, а не display: contents", () => {
    const css = web("layout.css");
    expect(css).toMatch(/\.rh-cbd__row \{\s*display: grid;\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/);
    expect(css).not.toContain(".rh-subrow");
  });
});

describe("тексты", () => {
  test("TXT-24: подсказка сортировки склоняет колонку; лиги — TOP-N", () => {
    const rating = web("Rating.tsx");
    expect(rating).toContain("`Сортировать по ${SORT_BY[columnKey]}`");
    expect(rating).toContain('name: "названию"');
    expect(readFileSync(join(import.meta.dir, "..", "src", "api", "rank-badge.ts"), "utf8")).toContain('label: "TOP-10"');
  });

  test("TXT-25: «org/repo» нет в видимых строках интерфейса", () => {
    for (const f of ["MePage.tsx", "ComparePage.tsx", "compareView.ts", "RepoPage.tsx"]) {
      const visible = web(f)
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l));
      expect(visible.filter((l) => /["`][^"`]*org\/repo/.test(l))).toEqual([]);
    }
  });

  test("TXT-26: общие ошибки — с действием и без кодов", () => {
    expect(errorText({ status: 403, code: "forbidden", message: null })).toBe("Запрос отклонен – обновите страницу и повторите");
    expect(errorText({ status: 404, code: null, message: null })).toBe("Не нашли, что вы искали – обновите страницу");
    expect(errorText({ status: 503, code: "unconfigured", message: "x" })).toBe("Эта функция пока не работает на сервере");
    expect(errorText({ status: 418, code: null, message: null })).toBe("Что-то пошло не так – попробуйте еще раз");
    expect(web("RepoV5.tsx")).not.toContain("`Ошибка ${status}`");
  });
});
