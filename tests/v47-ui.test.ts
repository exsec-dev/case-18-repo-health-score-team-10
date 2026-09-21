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

  test("адрес и имя файла — от слага карточки, рядом с report.md (MD-адрес прежний)", () => {
    expect(web("RepoPage.tsx")).toContain("pdfHref={`${cardUrl}/report.pdf`} pdfName={`${org}-${repo}-health.pdf`}");
  });
});

describe("Б5 (П3.2–П3.4): кабинет «Мои репозитории»", () => {
  const me = () => stripComments(web("MePage.tsx"));
  const slice = (from: string, to: string) => {
    const src = me();
    const start = src.indexOf(from);
    return start < 0 ? "" : src.slice(start, src.indexOf(to, start + from.length));
  };

  test("П3.2: кнопка и строка без проверки говорят, что делать", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      button: /<Button[^>]*onClick=\{onCheck\}[^>]*>\s*Проверить доступ\s*<\/Button>/.test(me()),
      oldButton: me().includes("Проверить права"),
      withPat: rights.includes("Нажмите «Проверить доступ», чтобы узнать, какие данные репозитория открывает ваш токен."),
      withoutPat: rights.includes("Добавьте токен в Настройках, чтобы проверить доступ к данным репозитория."),
      internalState: /проверяли/.test(me()),
    }).toEqual({ button: true, oldButton: false, withPat: true, withoutPat: true, internalState: false });
  });

  test("П3.3: плашка без PAT — CabinetAlert со ссылкой-кнопкой на /settings, до списка", () => {
    const section = slice("function MyReposSection", "\nfunction RepoRow");
    const banner = section.slice(section.indexOf("{!hasPat && ("));
    expect({
      banner: section.includes("{!hasPat && ("),
      alert: /^\{!hasPat && \(\s*<CabinetAlert\s+theme="info"/.test(banner),
      link: /linkProps\("\/settings"\)/.test(banner.slice(0, 800)),
      beforeList: section.indexOf("{!hasPat && (") < section.indexOf('<ul className="rh-list">'),
      notToast: !/toaster\.add\([^)]*токен/.test(section),
    }).toEqual({ banner: true, alert: true, link: true, beforeList: true, notToast: true });
  });

  test("П3.4: права — Label с иконкой (замок у закрытого), а не глифы; легенды глифов нет", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      label: /<Label key=\{key\} theme=\{state\.theme\}[^>]*icon=\{<Icon data=\{state\.icon\}/.test(rights),
      lock: /no: \{ theme: "unknown", icon: Lock/.test(me()),
      glyphs: /[✓✗]/.test(me()),
      legend: me().includes("право есть ·"),
    }).toEqual({ label: true, lock: true, glyphs: false, legend: false });
  });

  test("П3.4: один Alert — view и size общие, тема по смыслу", () => {
    const code = me();
    expect((code.match(/<Alert\b/g) ?? []).length).toBe(1);
    expect(code).toMatch(/<Alert theme=\{theme\} view="outlined" size="m"/);
    // все плашки кабинета идут через обёртку
    expect((code.match(/<CabinetAlert\b/g) ?? []).length).toBe(8);
  });

  test("П3.4: слаг — общим RepoSlug; пустое состояние — EmptyState; паддинг карточек — один класс", () => {
    const code = me();
    expect({
      repoSlug: code.includes('<RepoSlug org={org} repo={repo} variant="subheader-2" />'),
      assembled: /\{org\} \/ \{repo\}/.test(code),
      codeSlug: code.includes('<Text variant="code-1">{j.slug}</Text>'),
      emptyState: /entries\.length === 0 && \(\s*<EmptyState/.test(code),
      inlinePadding: /padding: "var\(--g-spacing-[45]\)"/.test(code),
      cardClass: (code.match(/className="rh-me-card"/g) ?? []).length,
    }).toEqual({ repoSlug: true, assembled: false, codeSlug: false, emptyState: true, inlinePadding: false, cardClass: 2 });
    expect(web("layout.css")).toMatch(/\.rh-me-card \{[^}]*padding: var\(--g-spacing-3\) var\(--g-spacing-4\)/);
  });

  test("П3.4 (У26): счётчик рекомендаций — ссылкой на карточку с открытым табом; null — строки нет", () => {
    const row = slice("function RepoRow", "\nfunction ");
    expect(row).toMatch(/entry\.recommendationsCount !== null && \(\s*<MetaItem>\s*<Link \{\.\.\.linkProps\(`\$\{repoHref\(org, repo\)\}\?tab=\$\{TAB_RECOMMENDATIONS\}`\)\}>\{recommendationsText\(entry\.recommendationsCount\)\}<\/Link>/);
  });
});
