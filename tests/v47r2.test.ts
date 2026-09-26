// v47r2.test.ts — В4.7 круг 2: замечания UX-гейта владельца 21.09 (Р2.1–Р2.5).
// Поведение — на чистых функциях и описании документа PDF; вёрстка UI —
// source-assert (правило AGENTS.md: числа и данные — поведением, вёрстка и
// тексты — формой кода).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReportModel, renderRepoReport } from "../src/report/markdown";
import { COLORS, buildPdfDocument } from "../src/report/pdf";
import { avatarInitials, avatarTone } from "../src/web/format";
import { langOptions } from "../src/web/lang-filter";
import { REPORT_FIXTURES, fixtureCard, goldenPath } from "./report-fixtures";

const ROOT = join(import.meta.dir, "..");
const srcOf = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const facets = [
  { language: null, count: 6854, color: null },
  { language: "Python", count: 4621, color: "#3572A5" },
  { language: "Go", count: 379, color: "#00ADD8" },
  { language: "Rich Text Format", count: 1, color: null },
];

describe("Р2.1: список языков на время загрузки", () => {
  test("опции строятся из запомненных фасетов, а не из текущего ответа", () => {
    const src = srcOf("src/web/Rating.tsx");
    expect(src).toContain("const lastFacets = useRef<Facets>([]);");
    expect(src).toContain("if (data) lastFacets.current = data.facets.languages;");
    expect(src).toContain("options={langOptions(lastFacets.current, langValues)}");
    expect(src).toContain('from "./lang-filter"');
  });

  test("выбранные языки сохраняют цвет и счётчик из прежних фасетов", () => {
    const opts = langOptions(facets, ["Python", "Go"]);
    expect(opts.find((o) => o.value === "Python")?.data).toEqual({ title: "Python", count: 4621, color: "#3572A5" });
    expect(opts).toHaveLength(4);
  });
});

describe("Р2.2: «не определен» — последней опцией", () => {
  test("при самом большом счётчике — всё равно в конце; остальные — в порядке фасетов", () => {
    const values = langOptions(facets, []).map((o) => o.value);
    expect(values.at(-1)).toBe(" none");
    expect(values.slice(0, -1)).toEqual(["Python", "Go", "Rich Text Format"]);
  });

  test("выбранный язык вне фасетов не встаёт после «не определен»", () => {
    const values = langOptions(facets, ["Kotlin"]).map((o) => o.value);
    expect(values.at(-1)).toBe(" none");
    expect(values).toContain("Kotlin");
  });
});

describe("Р2.3: язык без цвета платформы — нейтральная точка", () => {
  test("LanguageName: известный язык без цвета получает нейтральную точку, «не определен» — никакой", () => {
    const src = srcOf("src/web/ui.tsx");
    expect(src).toContain('const known = name !== null && !noLanguage;');
    expect(src).toContain('color ? "rh-lang__dot" : "rh-lang__dot rh-lang__dot_neutral"');
    expect(srcOf("src/web/layout.css")).toMatch(/\.rh-lang__dot_neutral \{\s*background: var\(--g-color-text-hint\);/);
    expect(srcOf("src/web/Rating.tsx")).toContain("noLanguage={option.value === LANG_NONE}");
  });
});

describe("Р2.4: спиннер на кнопке «Отчет»", () => {
  // ПЕРЕВОРОТ (В4.8.5, К8.5.11): MD тоже качается через fetch — спиннер
  // стоит, пока собирается любой из двух форматов (был только PDF)
  test("кнопка показывает loading, пока отчет собирается", () => {
    expect(srcOf("src/web/RepoPage.tsx")).toContain('aria-haspopup="menu" loading={busy !== null}');
  });
});

describe("Р2.5: PDF — синяя ссылка; аватар снят (В4.9, К9.5); MD — эталоны", () => {
  // В4.9 (К9.6): ссылка в MD — `[адрес](url)` вместо голого URL (MD переписан заново, эталоны — закрытым списком)
  test("MD всех фикстур байт-в-байт равен эталонам; ссылка в MD — markdown-ссылкой", () => {
    // решение владельца 22.09: без оценки отчета нет — фикстура `never` документом не снимается
    for (const name of REPORT_FIXTURES) {
      const { card, close } = fixtureCard(name);
      try {
        const md = renderRepoReport(card);
        expect(md).toBe(readFileSync(goldenPath(name), "utf8"));
        expect(md).toContain(`[sourcecraft.dev/m47/${name}](${card.repo.webUrl})`);
      } finally {
        close();
      }
    }
  });

  test("ссылка на репозиторий в PDF — кликабельная и синяя (токен text-link UI)", () => {
    const { card, close } = fixtureCard("full");
    try {
      const doc = buildPdfDocument(buildReportModel(card)) as { content: Record<string, unknown>[] };
      const json = JSON.stringify(doc.content[0]);
      expect(json).toContain(`"text":"sourcecraft.dev/m47/full","link":"${card.repo.webUrl}","color":"${COLORS.link}"`);
      expect(COLORS.link).toBe("#4768c2");
    } finally {
      close();
    }
  });

  // ПЕРЕВОРОТ (В4.9, эталон вида круг 3-4): аватар из букв снят как «ИИ-маркер» —
  // шапка PDF: имя репозитория и ссылка; картинок и монограммы нет
  test("в шапке PDF нет аватара: ни монограммы, ни картинки; сеть не нужна", () => {
    const { card, close } = fixtureCard("full");
    try {
      const doc = buildPdfDocument(buildReportModel(card)) as { content: Record<string, unknown>[] };
      const json = JSON.stringify(doc.content[0]);
      expect(json).not.toContain(`"text":"${avatarInitials(card.repo.repo)}"`);
      expect(json).not.toContain("image");
      // тур 3 В5.5 (п.8, 26.09): слаг в шапке PDF без пробелов вокруг слеша
      expect(json).toContain('"text":"m47/full"');
    } finally {
      close();
    }
  });

  test("буквы и тон — одно правило с карточкой (алгоритм Gravity getAvatarDisplayText)", () => {
    expect(avatarInitials("full")).toBe("FU");
    expect(avatarInitials("dozzle-plus")).toBe("DP");
    expect(avatarInitials("its-wednesday-my-dudes")).toBe("IW");
    expect(avatarInitials("uikit")).toBe("UI");
    expect(avatarTone("full")).toBe(avatarTone("full"));
    expect(srcOf("src/web/ui.tsx")).toMatch(/import \{[^}]*avatarTone[^}]*\} from "\.\/format"/);
  });
});

describe("Р2.6: обновление рейтинга без моргания (stale-while-revalidate)", () => {
  test("stateOnReload: с keepPrevious прежние данные остаются как stale; без — пустая загрузка, как раньше", async () => {
    const { stateOnReload } = await import("../src/web/api");
    const ok = { kind: "ok" as const, data: { n: 1 } };
    expect(stateOnReload(ok, true)).toEqual({ kind: "loading", stale: { n: 1 } });
    expect(stateOnReload(ok, false)).toEqual({ kind: "loading" });
    // вторая смена URL до ответа — stale не теряется
    expect(stateOnReload({ kind: "loading", stale: { n: 1 } }, true)).toEqual({ kind: "loading", stale: { n: 1 } });
    // первая загрузка и после ошибки — без stale (скелетон / честная ошибка)
    expect(stateOnReload({ kind: "loading" }, true)).toEqual({ kind: "loading" });
    expect(stateOnReload({ kind: "error", message: "x" }, true)).toEqual({ kind: "loading" });
  });

  test("рейтинг: keepPrevious, данные из stale, скелетон только при первой загрузке, выдача приглушена и не кликается", () => {
    const src = srcOf("src/web/Rating.tsx");
    expect(src).toContain("{ keepPrevious: true });");
    expect(src).toContain('state.kind === "loading" ? (state.stale ?? null) : null');
    expect(src).toContain('{state.kind === "loading" && !refreshing && <SkeletonRows');
    expect(src).toContain('className={refreshing ? "rh-table-fill rh-refreshing" : "rh-table-fill"}');
    // все три вида выдачи: таблица, список на телефоне, «Без оценки»
    expect(src).toContain('<ul className={refreshing ? "rh-list rh-refreshing" : "rh-list"}>');
    expect(src).toContain('className={refreshing ? "rh-refreshing" : undefined}');
    const css = srcOf("src/web/layout.css");
    expect(css).toMatch(/\.rh-refreshing \{[^}]*pointer-events: none;/);
    // полоса зарезервирована всегда — её появление не сдвигает таблицу
    expect(css).toMatch(/\.rh-refresh-bar \{[^}]*height: 2px;/);
    expect(src).toContain('className="rh-view-tabs"');
    expect(css).toMatch(/\.rh-view-tabs \{\s*font-variant-numeric: tabular-nums;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.rh-refresh-bar_on/);
    // ПЕРЕВОРОТ (В4.8.5, К8.5.3): было «остальные экраны — без изменений: опция
    // только у рейтинга». Карточка и «Мои репозитории» перечитываются теперь без
    // мигания тем же механизмом (поведение — tests/v485-ui.test.ts)
    for (const f of ["RepoPage.tsx", "MePage.tsx"]) expect(srcOf(`src/web/${f}`)).toContain("keepPrevious: true");
  });
});
