// UI-контракты, которые нельзя проверить на данных: верстка и тексты фильтра
// языков, меню отчета и раздела «Избранное» (source-assert). Числа и поведение
// проверяют тесты API и отчета; живой вид – харнесс scripts/shot.ts.
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
      // на телефоне к классу добавляется rh-in-sheet: список открывается над нижней панелью
      popupClass: s.includes('popupClassName={isPhone ? "rh-lang-popup rh-in-sheet" : "rh-lang-popup"}'),
      summary: s.includes("renderSelectedOption="),
    }).toEqual({ multiple: true, renderOption: true, checkbox: true, popupClass: true, summary: true });
    const css = web("layout.css");
    expect(css).toMatch(/\.rh-lang-popup \.g-select-list \{[^}]*max-height:/);
    expect(css).toMatch(/\.rh-lang-popup \.g-select-list__tick-icon \{[^}]*display: none/);
  });

  test("у каждой опции цветной кружок из фасета (LanguageName с facet.color)", () => {
    const src = rating();
    // опции строит чистый модуль lang-filter.ts
    expect(web("lang-filter.ts")).toMatch(/color: f\.color/);
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
    const start = src.indexOf("function useReportDownload");
    return src.slice(start, src.indexOf("\n}\n", start));
  };

  // MD качается так же, как PDF (fetch + blob), а не ссылкой `href`: любой сбой –
  // тост в приложении, а не сырой JSON вместо страницы; текст тоста – по коду
  // ответа (`reportFailureText`), а не сырым сообщением сервера
  test("PDF и MD качаются через fetch + blob, на сбое — тост с текстом по коду", () => {
    const m = menu();
    expect({
      fetches: m.includes("res = await fetch(href)"),
      blob: m.includes("URL.createObjectURL(await res.blob())"),
      checksType: m.includes('kind === "md" ? "text/markdown" : "application/pdf"') && m.includes(".startsWith(expected)"),
      toast: /toaster\.add\(\{[\s\S]{0,200}theme: "danger"/.test(m),
      textByCode: m.includes("reportFailureText(kind, status, code)"),
      mdAction: m.includes('{ text: "Markdown (.md)", iconStart: <Icon data={LogoMarkdown} size={16} />, disabled: busy !== null, action: () => void download("md") }'),
      mdHref: m.includes("href: mdHref"),
    }).toEqual({ fetches: true, blob: true, checksType: true, toast: true, textByCode: true, mdAction: true, mdHref: false });
  });

  test("адрес и имя файла — от слага карточки, рядом с report.md (MD-адрес прежний)", () => {
    // имя файла – одной функцией, с обрезкой длинного слага
    expect(web("RepoPage.tsx")).toContain('pdfHref: `${cardUrl}/report.pdf`, pdfName: reportFileName(org, repo, "pdf")');
  });
});

describe("Б5 (П3.2–П3.4): кабинет «Мои репозитории»", () => {
  const me = () => stripComments(web("MePage.tsx"));
  const slice = (from: string, to: string) => {
    const src = me();
    const start = src.indexOf(from);
    return start < 0 ? "" : src.slice(start, src.indexOf(to, start + from.length));
  };

  // Права проверяются сами (при добавлении, после смены токена, фоном), поэтому
  // ручного действия проверки нет. Строка без проверки молчит: фраза-инструкция
  // в каждой такой строке была бы шумом.
  test("П3.2 → В4.8 → В4.8.5: ручного действия проверки прав нет; строка без проверки молчит", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      menuItem: me().includes("Проверить доступ"),
      oldButton: me().includes("Проверить права"),
      silentWithoutCheck: /if \(!access\) return null;/.test(rights),
      internalState: /проверяли/.test(me()),
    }).toEqual({ menuItem: false, oldButton: false, silentWithoutCheck: true, internalState: false });
  });

  // без токена – предупреждение: заголовок, пояснение, кнопка
  test("П3.3 → Е17: без PAT — предупреждение с кнопкой-ссылкой на /settings, до списка", () => {
    const section = slice("function MyReposSection", "\nfunction RepoRow");
    const notice = slice("function TokenNotice", "\nexport function MePage");
    expect({
      banner: section.includes("<TokenNotice hasPat={hasPat} />"),
      // кнопка под текстом (без `layout="horizontal"`), иконка синяя
      oneLine: !/layout="horizontal"/.test(notice) && /rh-info-icon/.test(notice) && /title="Добавьте персональный токен доступа SourceCraft"/.test(notice),
      link: /<Button view="normal" size="m" \{\.\.\.linkProps\("\/settings"\)\}>\s*Перейти в Настройки/.test(notice),
      beforeList: section.indexOf("<TokenNotice") < section.indexOf('<ul className="rh-repo-list">'),
      notToast: !/toaster\.add\([^)]*токен/.test(section),
    }).toEqual({ banner: true, oneLine: true, link: true, beforeList: true, notToast: true });
  });

  // в строке только плашка видимости: ни каналов доступа, ни глифов ✓/✗, ни легенды
  test("П3.4 → круг 4: плашки каналов доступа нет, только видимость; глифов и легенды нет", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      onePill: /rh-access/.test(me()),
      visibility: /<VisibilityPill value=\{access\.visibility\}/.test(rights),
      channels: /ACCESS_CHANNELS/.test(me()),
      glyphs: /[✓✗]/.test(me()),
      legend: me().includes("право есть ·"),
    }).toEqual({ onePill: false, visibility: true, channels: false, glyphs: false, legend: false });
  });

  // 3 Alert: обертка, предупреждение «нет токена» и плашка про одноразовый показ токена
  test("П3.4: Alert обертки — view и size общие, тема по смыслу", () => {
    const code = me();
    expect((code.match(/<Alert\b/g) ?? []).length).toBe(3);
    expect(code).toMatch(/<Alert theme=\{theme\} view="outlined" size="m"/);
    // остальные плашки кабинета идут через обертку
    expect((code.match(/<CabinetAlert\b/g) ?? []).length).toBe(6);
  });

  test("П3.4: слаг — общим RepoSlug; пустое состояние — EmptyState; карточек `rh-me-card` в кабинете нет (В4.8)", () => {
    const code = me();
    expect({
      repoSlug: code.includes('<RepoSlug org={org} repo={repo} variant="subheader-2" />'),
      assembled: /\{org\} \/ \{repo\}/.test(code),
      codeSlug: code.includes('<Text variant="code-1">{j.slug}</Text>'),
      emptyState: /entries\.length === 0 && \(\s*<EmptyState/.test(code),
      inlinePadding: /padding: "var\(--g-spacing-[45]\)"/.test(code),
      cardClass: (code.match(/className="rh-me-card"/g) ?? []).length,
      // панель заданий – `Popup`, карточек `rh-me-card` в кабинете нет, класса нет и в CSS
    }).toEqual({ repoSlug: true, assembled: false, codeSlug: false, emptyState: true, inlinePadding: false, cardClass: 0 });
    expect(web("layout.css")).not.toContain(".rh-me-card");
  });

  test("П3.4 (У26), UX 17.10: в строке избранного нет счетчика рекомендаций — они на карточке", () => {
    const row = slice("function RepoRow", "\nfunction ");
    // адрес карточки – одна константа строки `href`
    expect(row).toContain("const href = repoHref(org, repo);");
    // счетчик-ссылку «N рекомендаций» убрали по решению владельца: вся строка и
    // так ведет в карточку
    expect(row).not.toContain("recommendationsText(");
    expect(row).not.toContain("Bulb");
    expect(row).not.toContain("?tab=");
  });
});
