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
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А3; Г2.8): полоса ушла из панели под
  // числа; сборка полосы — ОДНА функция `contributionBar` (sections.ts), ее
  // зовут и отчет (`contributionsBlock`), и view-модель карточки
  // (`contributionBars`); строки «Сильнее всего…» нет нигде — `lossParts`
  // удален. Равенство полей — поведенческий тест v49-ui-r1-card.
  test("карточка и отчет собирают полосу одной функцией (sections.ts)", () => {
    const view = src("web/cardView.ts");
    const sections = src("report/sections.ts");
    const report = src("report/build.ts");
    expect({ view: view.includes("lossParts"), report: report.includes("lossParts"), format: src("web/format.ts").includes("export function lossParts") }).toEqual({ view: false, report: false, format: false });
    for (const token of ["categoryContributions(", "CONTRIBUTIONS_TITLE", "CONTRIBUTIONS_REST", "contributionsNote(", "fmtContribution("]) {
      expect({ token, sections: sections.includes(token) }).toEqual({ token, sections: true });
    }
    expect(view).toContain("contributionBars(card)");
    expect(report).toContain("contributionBar(c, metricName)");
    // веса — те же, что у отчета: индекса — INDEX_WEIGHTS, полного — вес категории из карточки
    expect(sections).toContain("INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS]");
    expect(sections).toContain("score.categories[k]?.weight ?? SCORE_WEIGHTS[k]");
  });

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, §2 23.09 «финальный вид подтвержден» п.1):
  // на карточке цвет категорий возвращен — тот же, что в панели «Вклад
  // категорий» рейтинга, по КЛЮЧУ категории; К9.15 снят только для карточки,
  // PDF остается серым (pdf.ts не менялся).
  test("сегменты карточки и рейтинга — цвет по ключу категории, CI/CD и Безопасность — два новых тона", () => {
    const css = src("web/layout.css");
    expect(css).not.toMatch(/\.rh-contrib-band__seg/);
    expect(css).not.toMatch(/\.rh-contrib__seg_\d/);
    expect(between(css, ".rh-cat-color_cicd {", "}")).toContain("var(--g-color-base-misc-heavy)");
    expect(between(css, ".rh-cat-color_security {", "}")).toContain("var(--g-color-base-utility-medium)");
    expect(between(css, ".rh-cat-color_documentation {", "}")).toContain("var(--g-color-base-info-heavy)");
    expect(src("web/Rating.tsx")).toContain("categoryColorClass(c.key)");
    expect(src("web/Rating.tsx")).not.toMatch(/rh-contrib__seg_\$\{i/);
    expect(src("web/RepoPage.tsx")).toContain("className={`rh-contrib__seg ${s.colorClass}`}");
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

  // ПЕРЕНОС С ЗАМЕНОЙ (В4.9 ч.2, А4, инвариант 1): основание любой категории
  // на карточке и в отчете — одна функция `categoryWhy` (sections.ts), в
  // которой живут `lockedCategoryText` и опорная фраза `NOT_IN_SCORE`.
  test("карточка и отчет берут основание одной функцией, склейки «недоступны» нет", () => {
    const page = src("web/RepoPage.tsx");
    const sections = src("report/sections.ts");
    expect(src("web/cardView.ts")).toContain("categoryWhy(card, key, ctx)");
    expect(src("report/build.ts")).toContain("categoryWhy(card, key, ctx)");
    expect(sections).toContain("${NOT_IN_SCORE}");
    expect(sections).toContain("lockedCategoryText(cat.locked, card.viewer?.auth)");
    expect(page).not.toContain("Категория не снизила Score");
  });
});

describe("К9.14: слово шкалы у категории — плашкой", () => {
  test("в строке категории — Label темы scoreLabelTheme; слова в подсказке числа нет", () => {
    const row = between(src("web/RepoPage.tsx"), "function CategoryRow", "function Markers");
    // ПЕРЕНОС (В4.9 ч.2): плашку собирает view-модель (`chip`), тема — scoreLabelTheme, как у отчета
    expect(row).toMatch(/<Label theme=\{c\.chip\.theme\} size="xs" className="rh-category__word">/);
    expect(src("web/cardView.ts")).toContain("chip: { theme: scoreLabelTheme(cat.score)");
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
