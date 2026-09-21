// v47-ui.test.ts — UI-контракты вехи В4.7, которые нельзя проверить на
// данных: вёрстка и тексты (source-assert, приём tests/me.test.ts). Числа и
// поведение — в тестах API и отчёта (правило AGENTS.md 21.09: source-assert
// только для вёрстки и текстов). Живой вид — харнесс scripts/shot.ts (Б9).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Б2 (П2): мультивыбор языка в рейтинге", () => {
  const rating = () => stripComments(web("Rating.tsx"));
  const select = () => {
    const src = rating();
    const start = src.indexOf('label="Язык:"');
    return src.slice(start, src.indexOf("/>", src.indexOf("onUpdate", start)));
  };

  test("Select multiple: чекбокс опции через renderOption, штатная галочка скрыта, высота — CSS попапа", () => {
    const s = select();
    expect({
      multiple: /\bmultiple\b/.test(s),
      renderOption: s.includes("renderOption="),
      checkbox: /function LangOption[\s\S]{0,400}<Checkbox/.test(rating()),
      popupClass: s.includes('popupClassName="rh-lang-popup"'),
      summary: s.includes("renderSelectedOption="),
    }).toEqual({ multiple: true, renderOption: true, checkbox: true, popupClass: true, summary: true });
    const css = web("layout.css");
    expect(css).toMatch(/\.rh-lang-popup \.g-select-list \{[^}]*max-height:/);
    expect(css).toMatch(/\.rh-lang-popup \.g-select-list__tick-icon \{[^}]*display: none/);
  });

  test("у каждой опции цветной кружок из фасета (LanguageName с facet.color)", () => {
    const src = rating();
    expect(src).toMatch(/color: f\.color/);
    expect(src).toMatch(/function LangOption[\s\S]{0,600}<LanguageName name=\{[^}]+\} color=\{d\?\.color \?\? null\}/);
  });

  test("опции «все» нет; URL несёт повторяемый lang, старая одиночная ссылка читается набором", () => {
    const src = rating();
    expect({ allOption: src.includes("LANG_ALL"), allContent: /content: "все"/.test(src) }).toEqual({ allOption: false, allContent: false });
    expect(src).toContain('params.getAll("lang")');
    expect(src).toMatch(/next\.append\(key, v\)/);
  });
});

describe("Б4 (П1): кнопка PDF на карточке", () => {
  const menu = () => {
    const src = stripComments(web("RepoPage.tsx"));
    const start = src.indexOf("function ReportMenu");
    return src.slice(start, src.indexOf("\n}\n", start));
  };

  test("PDF качается через fetch + blob, на сбое — тост с текстом сервера, MD-пункт не тронут", () => {
    const m = menu();
    expect({
      fetches: m.includes("await fetch(pdfHref)"),
      blob: m.includes("URL.createObjectURL(await res.blob())"),
      checksType: m.includes('startsWith("application/pdf")'),
      toast: /toaster\.add\(\{[\s\S]{0,200}theme: "danger"/.test(m),
      serverMessage: m.includes("body?.error?.message"),
      mdLink: m.includes('{ text: "Markdown (.md)", iconStart: <Icon data={LogoMarkdown} size={16} />, href: mdHref }'),
    }).toEqual({ fetches: true, blob: true, checksType: true, toast: true, serverMessage: true, mdLink: true });
  });

  test("адрес и имя файла — от слага карточки, рядом с report.md", () => {
    expect(web("RepoPage.tsx")).toContain("pdfHref={`${cardUrl}/report.pdf`} pdfName={`${org}-${repo}-health.pdf`}");
  });
});
