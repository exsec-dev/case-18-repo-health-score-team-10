// v47r2.test.ts — В4.7 круг 2: замечания UX-гейта владельца 21.09 (Р2.1–Р2.5).
// Поведение — на чистых функциях и описании документа PDF; вёрстка UI —
// source-assert (правило AGENTS.md: числа и данные — поведением, вёрстка и
// тексты — формой кода).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReportModel, renderRepoReport } from "../src/report/markdown";
import { buildPdfDocument } from "../src/report/pdf";
import { avatarInitials, avatarTone } from "../src/web/format";
import { langOptions } from "../src/web/lang-filter";
import { fixtureCard, goldenPath } from "./report-fixtures";

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
  test("кнопка показывает loading, пока PDF собирается", () => {
    expect(srcOf("src/web/RepoPage.tsx")).toContain('aria-haspopup="menu" loading={pdfBusy}');
  });
});

describe("Р2.5: PDF — синяя ссылка и аватар из букв; MD не меняется", () => {
  test("MD всех фикстур байт-в-байт равен эталонам (ссылка в MD — голый URL, как было)", () => {
    for (const name of ["anon", "full", "grant-ci", "null", "never"] as const) {
      const { card, close } = fixtureCard(name);
      try {
        expect(renderRepoReport(card)).toBe(readFileSync(goldenPath(name), "utf8"));
      } finally {
        close();
      }
    }
  });

  test("ссылка на репозиторий в PDF — кликабельная и синяя", () => {
    const { card, close } = fixtureCard("full");
    try {
      const doc = buildPdfDocument(buildReportModel(card)) as { content: { ul?: { text: { text: string; link?: string; style?: string }[] }[] }[]; styles: Record<string, { color?: string }> };
      const list = doc.content.find((n) => n.ul)!;
      const link = list.ul![0]!.text.find((f) => f.link);
      expect(link).toEqual({ text: card.repo.webUrl, link: card.repo.webUrl, style: "link" });
      expect(doc.styles.link?.color).toBe("#0969da");
    } finally {
      close();
    }
  });

  test("аватар из букв стоит рядом с заголовком, без сети (canvas + текст, никаких картинок)", () => {
    const { card, close } = fixtureCard("full");
    try {
      const doc = buildPdfDocument(buildReportModel(card), { avatarName: card.repo.repo }) as { content: Record<string, unknown>[] };
      const head = doc.content[0] as { columns: Record<string, unknown>[] };
      expect(head.columns).toHaveLength(2);
      const json = JSON.stringify(head.columns[0]);
      expect(json).toContain('"canvas"');
      expect(json).toContain(`"text":"${avatarInitials(card.repo.repo)}"`);
      expect(json).not.toContain("image");
      // без имени — прежний заголовок без колонок
      const plain = buildPdfDocument(buildReportModel(card)) as { content: Record<string, unknown>[] };
      expect(plain.content[0]).not.toHaveProperty("columns");
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
