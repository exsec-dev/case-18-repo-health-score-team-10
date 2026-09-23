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
    // В4.7 круг 2: построение опций переехало в чистый модуль lang-filter.ts (Р2.1, Р2.2)
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
    const start = src.indexOf("function ReportMenu");
    return src.slice(start, src.indexOf("\n}\n", start));
  };

  // ПЕРЕВОРОТ (В4.8.5, К8.5.11, С7-1/С7-2): MD качается так же, как PDF
  // (fetch + blob), а не ссылкой `href` — любой сбой теперь тост в приложении, а
  // не сырой JSON вместо приложения; текст тоста — по коду ответа
  // (`reportFailureText`), а не сырым сообщением сервера с советом про MD
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

  // В4.8 (решение 21.09, вариант A): фраза-инструкция в КАЖДОЙ строке без
  // проверки была шумом — строка без проверки молчит, путь «узнать» — пункт
  // меню строки с прежним названием действия; без токена путь — плашка П3.3.
  // ПЕРЕВОРОТ (В4.8.5, К8.5.14 (г), §2-В1): пункта «Проверить доступ» нет —
  // права проверяются сами (при добавлении, после смены токена, фоном);
  // остальное прежнее: кнопки «Проверить права» нет, строка без проверки молчит
  test("П3.2 → В4.8 → В4.8.5: ручного действия проверки прав нет; строка без проверки молчит", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      menuItem: me().includes("Проверить доступ"),
      oldButton: me().includes("Проверить права"),
      silentWithoutCheck: /if \(!access\) return null;/.test(rights),
      internalState: /проверяли/.test(me()),
    }).toEqual({ menuItem: false, oldButton: false, silentWithoutCheck: true, internalState: false });
  });

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, В1 / U11-b): вместо CabinetAlert — плашка
  // из 3 шагов, текущий шаг — кнопка «Перейти в Настройки»; место — то же, до списка.
  test("П3.3 → В1: без PAT — 3 шага с кнопкой-ссылкой на /settings, до списка", () => {
    const section = slice("function MyReposSection", "\nfunction RepoRow");
    const steps = slice("function OwnerSteps", "\nexport function MePage");
    expect({
      banner: section.includes("<OwnerSteps hasPat={hasPat} />"),
      alert: /<CabinetAlert\s+theme="info"\s+title="Добавьте персональный токен доступа SourceCraft"/.test(section),
      link: /<Button view="normal" size="m" \{\.\.\.linkProps\("\/settings"\)\}>\s*Перейти в Настройки/.test(steps),
      beforeList: section.indexOf("<OwnerSteps") < section.indexOf('<ul className="rh-repo-list">'),
      notToast: !/toaster\.add\([^)]*токен/.test(section),
    }).toEqual({ banner: true, alert: false, link: true, beforeList: true, notToast: true });
  });

  // В4.8 круг 3 (5a, решение Екатерины): три `Label` каналов собраны в ОДНУ
  // плашку с тремя иконками (Code / Terminal / Shield — как у SourceCraft);
  // состояние — цветом иконки, закрытый канал — серым, без замка. Смысл П3.4
  // (компоненты, а не глифы; без легенды) сохранен.
  test("П3.4 → В4.8 круг 3: права — одна плашка с иконками каналов, а не глифы; замка и легенды нет", () => {
    const rights = slice("function AccessRights", "\n}\n");
    expect({
      onePill: /<span className="rh-pill rh-access" title=\{summary\} aria-label=\{summary\} role="img">/.test(rights),
      icons: /<Icon key=\{c\.key\} data=\{c\.icon\} size=\{14\} className=\{`rh-access__icon \$\{c\.state\.cls\}`\} \/>/.test(rights),
      channels: /\{ key: "clone", title: "Код", icon: Code \},\s*\{ key: "ci", title: "CI\/CD", icon: Terminal \},\s*\{ key: "appsec", title: "Безопасность", icon: Shield \}/.test(me()),
      lockForClosed: /no: \{[^}]*Lock/.test(me()),
      glyphs: /[✓✗]/.test(me()),
      legend: me().includes("право есть ·"),
    }).toEqual({ onePill: true, icons: true, channels: true, lockForClosed: false, glyphs: false, legend: false });
  });

  test("П3.4: один Alert — view и size общие, тема по смыслу", () => {
    const code = me();
    expect((code.match(/<Alert\b/g) ?? []).length).toBe(1);
    expect(code).toMatch(/<Alert theme=\{theme\} view="outlined" size="m"/);
    // все плашки кабинета идут через обёртку
    // В4.8: 7 — плашка исхода «Проверки доступа» стала тостом, как у остальных действий строки
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, В1): 6 — alert о токене стал плашкой из 3 шагов
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
      // В4.8: журнал заданий убран из тела страницы (круг 1), панель заданий
      // стала `Popup` (круг 3) — карточек `rh-me-card` в кабинете нет, класс удален из CSS
    }).toEqual({ repoSlug: true, assembled: false, codeSlug: false, emptyState: true, inlinePadding: false, cardClass: 0 });
    expect(web("layout.css")).not.toContain(".rh-me-card");
  });

  test("П3.4 (У26): счётчик рекомендаций — ссылкой на карточку с открытым табом; null — строки нет", () => {
    const row = slice("function RepoRow", "\nfunction ");
    // В4.8: адрес карточки — одна константа строки `href`; у ссылки класс слоя над слоем-ссылкой строки
    expect(row).toContain("const href = repoHref(org, repo);");
    // В4.8 круг 2 (7a): перед текстом — иконка лампочки внутри ссылки
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А1): табов нет — ссылка ведет к разделу
    // «Рекомендации» якорем (`recommendationsHref` → `#recommendations`)
    expect(row).toMatch(/entry\.recommendationsCount !== null && \(\s*<MetaItem>[\s\S]*?<Link \{\.\.\.linkProps\(recommendationsHref\(href\)\)\}[^>]*>\s*<Icon data=\{Bulb\} size=\{14\} \/>\s*\{recommendationsText\(entry\.recommendationsCount\)\}\s*<\/Link>/);
    expect(row).not.toContain("?tab=");
  });
});
