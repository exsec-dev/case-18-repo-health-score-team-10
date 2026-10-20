// Карточка: проводка одной функции и одних фраз на карточке и в отчете (по
// исходнику – только тексты и верстка; числа проверяет v49-contributions).
// Внешний вид проверяется по отрисованному результату (scripts/shot.ts).
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

describe("К9.12: «Вклад категорий в оценку» на карточке – тот же расчет, что в отчете", () => {
  // Полосу собирает ОДНА функция `contributionBar` (sections.ts): ее зовут и
  // отчет (`contributionsBlock`), и view-модель карточки (`contributionBars`).
  // Равенство полей проверяет v49-ui-r1-card.
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

  // Цвет категории на карточке тот же, что в панели «Вклад категорий»
  // рейтинга, по КЛЮЧУ категории; PDF остается серым.
  test("сегменты карточки и рейтинга – цвет по ключу категории, CI/CD и Безопасность – два новых тона", () => {
    const css = src("web/layout.css");
    expect(css).not.toMatch(/\.rh-contrib-band__seg/);
    expect(css).not.toMatch(/\.rh-contrib__seg_\d/);
    // цвета категорий – свои токены `--rh-cat-*` в theme.css, не зеленый/желтый/красный оценки
    for (const k of ["documentation", "cicd", "security", "activity", "issues", "code"]) {
      expect(between(css, `.rh-cat-color_${k} {`, "}")).toContain(`var(--rh-cat-${k})`);
    }
    const theme = src("web/theme.css");
    expect((theme.match(/--rh-cat-(documentation|cicd|security|activity|issues|code): #[0-9a-f]{6};/g) ?? []).length).toBe(12);
    expect(css).not.toMatch(/\.rh-cat-color_\w+ \{[^}]*(positive|warning|danger)/);
    expect(src("web/Rating.tsx")).toContain("categoryColorClass(c.key)");
    expect(src("web/Rating.tsx")).not.toMatch(/rh-contrib__seg_\$\{i/);
    expect(src("web/RepoPage.tsx")).toContain("className={`rh-contrib__seg ${p.colorClass}");
  });
});

describe("К9.13: закрытая категория – одна фраза на карточке и в отчете", () => {
  test("фраза по причине доступа зрителя", () => {
    expect(lockedCategoryText("no-pat", "no-session")).toBe(LOCKED_FOR_ANON);
    expect(lockedCategoryText("no-pat", undefined)).toBe("Видна участникам репозитория.");
    expect(lockedCategoryText("denied", "pat")).toBe(ACCESS_LOCK_TEXT.denied);
    expect(lockedCategoryText("pat-expired", "pat")).toBe(ACCESS_LOCK_TEXT["pat-expired"]);
    expect(lockedCategoryText("no-pat", "no-pat")).toBe(ACCESS_LOCK_TEXT["no-pat"]);
  });

  test("пустая категория – причина и опорная фраза «не участвует и ее не снижает»", () => {
    expect(emptyCategoryText("documentation", "git channel no-data")).toBe(`${noDataReason("documentation", "git channel no-data")} ${NOT_IN_SCORE}`);
    expect(noDataReason("code", "что-то новое по-английски")).toBe("Данных нет.");
  });

  // Основание любой категории на карточке и в отчете – одна функция
  // `categoryWhy` (sections.ts), в
  // которой живут `lockedCategoryText` и опорная фраза `NOT_IN_SCORE`.
  test("карточка и отчет берут основание одной функцией, склейки «недоступны» нет", () => {
    const page = src("web/RepoPage.tsx");
    const sections = src("report/sections.ts");
    expect(src("web/cardView.ts")).toContain("categoryWhy(card, key, ctx)");
    expect(src("report/build.ts")).toContain("categoryWhy(card, key, ctx)");
    // опорная фраза — одна на список (`notInScoreNote`), у строки только причина
    expect(sections).toContain("return cats.some((c) => c.locked === undefined && c.score === null) ? NOT_IN_SCORE_LIST : null;");
    expect(sections).toContain("lockedCategoryText(cat.locked, card.viewer?.auth)");
    expect(page).not.toContain("Категория не снизила Score");
  });
});

describe("К9.14: слово шкалы у категории – плашкой", () => {
  test("в строке категории – Label темы scoreLabelTheme; слова в подсказке числа нет", () => {
    const row = between(src("web/RepoPage.tsx"), "function CategoryRow", "function Markers");
    // плашку собирает view-модель (`chip`), тема – scoreLabelTheme, как у отчета
    expect(row).toMatch(/<Label theme=\{c\.chip\.theme\} size="xs" className="rh-category__word">/);
    expect(src("web/cardView.ts")).toContain("chip: { theme: scoreLabelTheme(cat.score)");
    expect(row).not.toMatch(/rh-category__value" title=\{sentence\(scoreWord/);
  });
});

describe("К9.9: служебные заметки расчета не видны читателю", () => {
  test("заметки compute.ts – словами читателя; неизвестная – не печатается", () => {
    // UX 17.10: замечание без слова «трекер»
    expect(submetricNote("issues", "tracker_unused", "tracker not maintained — category minimum (Q14)")).toEqual({ remark: "Задач нет – категория получает 0." });
    expect(submetricShownValue("cicd", "pass_rate", { score: null, note: "no declared CI" }, { at: null })).toBe("CI не настроен");
    expect(submetricShownValue("cicd", "duration", { score: null, note: "runs no-data" }, { at: null })).toBe("запуски недоступны");
    expect(submetricShownValue("code", "old_share", { score: null, value: null, note: "todo sample incomplete (cat-file truncated) – old_share needs the full sample" }, { at: null })).toBe(
      "не посчитано: прочитаны не все файлы",
    );
    expect(submetricNote("activity", "freq", "some future note")).toBeNull();
    expect(submetricShownValue("activity", "freq", { score: null, note: "some future note" }, { at: null })).toBe("–");
  });

  test("строка подметрики на карточке не печатает `sub.note`; иконка – на уровне первой строки названия", () => {
    const page = src("web/RepoPage.tsx");
    expect(page).not.toContain("(${sub.note})");
    // 19.10.2026: значок — в таблице разбивки (.rh-cbd__glyph), старого .rh-subrow__icon нет
    const icon = between(src("web/layout.css"), ".rh-cbd__glyph {", "}");
    expect(icon).toContain("align-self: start");
    expect(icon).not.toContain("align-self: center");
  });
});
