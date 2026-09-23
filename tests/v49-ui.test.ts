// v49-ui.test.ts — карточка В4.9 (блок Б7: К9.9, К9.12-К9.14). Вид — по
// отрисованному результату (харнесс scripts/shot.ts); здесь — проводка одной
// функции и одних фраз на карточке и в отчете (source-assert допустим для
// текстов и верстки; числа — поведенческие тесты v49-contributions).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCESS_LOCK_TEXT, LOCKED_FOR_ANON, NOT_IN_SCORE, emptyCategoryText, lockedCategoryText, noDataReason } from "../src/web/format";
import { submetricNote, submetricShownValue } from "../src/report/submetrics";

const root = join(import.meta.dir, "..", "src");
const src = (p: string): string => readFileSync(join(root, p), "utf8");
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  return start < 0 ? "" : text.slice(start, text.indexOf(to, start + from.length));
};

describe("К9.12: «Вклад категорий в оценку» на карточке — тот же расчет, что в отчете", () => {
  test("карточка и отчет зовут одну функцию и одни подписи (format.ts)", () => {
    const band = between(src("web/RepoPage.tsx"), "function ContributionBand", "\n}\n");
    // В4.9 ч.2 (предпосылка круга 1): вклады и основания отчета переехали в
    // чистый `report/sections.ts` — «отчет» здесь это build.ts вместе с ним
    const report = src("report/build.ts") + src("report/sections.ts");
    // Гейт 22.09 (В9): строку итога под шкалой («Сильнее всего итог снижают…»)
    // из документа убрали, на карточке она осталась — `lossParts` теперь
    // только у карточки; расчет вкладов и подписи по-прежнему общие.
    expect({ card: band.includes("lossParts("), report: report.includes("lossParts(") }).toEqual({ card: true, report: false });
    for (const token of ["categoryContributions(", "CONTRIBUTIONS_TITLE", "CONTRIBUTIONS_REST", "contributionsNote(", "fmtContribution("]) {
      expect({ token, card: band.includes(token), report: report.includes(token) }).toEqual({ token, card: true, report: true });
    }
    // веса — аргументом: индекса — из /api/meta, полного — из карточки
    expect(band).toContain("c.indexWeight");
    expect(band).toContain("weight: cat.weight");
  });

  test("сегменты — один темно-серый тон (как полосы отчета), без цветов категорий", () => {
    const css = src("web/layout.css");
    const seg = between(css, ".rh-contrib-band__seg {", "}");
    expect(seg).toContain("background: var(--g-color-text-secondary)");
    expect(css).not.toMatch(/\.rh-contrib-band__seg_\d/);
  });
});

describe("К9.13: закрытая категория — одна фраза на карточке и в отчете", () => {
  test("фраза по причине доступа зрителя", () => {
    expect(lockedCategoryText("no-pat", "no-session")).toBe(LOCKED_FOR_ANON);
    expect(lockedCategoryText("no-pat", undefined)).toBe("Видна участникам репозитория.");
    expect(lockedCategoryText("denied", "pat")).toBe(ACCESS_LOCK_TEXT.denied);
    expect(lockedCategoryText("pat-expired", "pat")).toBe(ACCESS_LOCK_TEXT["pat-expired"]);
    expect(lockedCategoryText("no-pat", "no-pat")).toBe(ACCESS_LOCK_TEXT["no-pat"]);
  });

  test("пустая категория — причина и опорная фраза «не участвует и ее не снижает»", () => {
    expect(emptyCategoryText("documentation", "git channel no-data")).toBe(`${noDataReason("documentation", "git channel no-data")} ${NOT_IN_SCORE}`);
    expect(noDataReason("code", "что-то новое по-английски")).toBe("Данных нет.");
  });

  test("карточка и отчет берут фразы из format.ts, склейки «недоступны» нет", () => {
    const page = src("web/RepoPage.tsx");
    expect(page).toContain("lockedCategoryText(cat.locked, card.viewer?.auth)");
    expect(page).toContain("${NOT_IN_SCORE}");
    expect(src("report/sections.ts")).toContain("lockedCategoryText(cat.locked, card.viewer?.auth)");
    expect(page).not.toContain("Категория не снизила Score");
  });
});

describe("К9.14: слово шкалы у категории — плашкой", () => {
  test("в строке категории — Label темы scoreLabelTheme; слова в подсказке числа нет", () => {
    const row = between(src("web/RepoPage.tsx"), "function CategoryRow", "function Markers");
    expect(row).toMatch(/<Label theme=\{scoreLabelTheme\(cat\.score\)\} size="xs" className="rh-category__word">/);
    expect(row).not.toMatch(/rh-category__value" title=\{sentence\(scoreWord/);
  });
});

describe("К9.9: служебные заметки расчета не видны читателю", () => {
  test("заметки compute.ts — словами читателя; неизвестная — не печатается", () => {
    expect(submetricNote("issues", "tracker_unused", "tracker not maintained — category minimum (Q14)")).toEqual({ remark: "Задач в трекере нет, поэтому категория получает минимальный балл." });
    expect(submetricShownValue("cicd", "pass_rate", { score: null, note: "no declared CI" }, { at: null })).toBe("CI не настроен");
    expect(submetricShownValue("cicd", "duration", { score: null, note: "runs no-data" }, { at: null })).toBe("запуски недоступны");
    expect(submetricShownValue("code", "old_share", { score: null, value: null, note: "todo sample incomplete (cat-file truncated) — old_share needs the full sample" }, { at: null })).toBe(
      "не посчитано: прочитаны не все файлы",
    );
    expect(submetricNote("activity", "freq", "some future note")).toBeNull();
    expect(submetricShownValue("activity", "freq", { score: null, note: "some future note" }, { at: null })).toBe("—");
  });

  test("строка подметрики на карточке не печатает `sub.note`; иконка — на уровне первой строки названия", () => {
    const page = src("web/RepoPage.tsx");
    expect(page).not.toContain("(${sub.note})");
    const icon = between(src("web/layout.css"), ".rh-subrow__icon {", "}");
    expect(icon).toContain("align-self: flex-start");
    expect(icon).not.toContain("align-self: center");
  });
});
