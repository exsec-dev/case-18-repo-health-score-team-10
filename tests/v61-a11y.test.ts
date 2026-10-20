// UX 17.10, доступность (аудит A11Y-6…18): объявления о результатах, сортировка в
// имени кнопки, combobox поиска по документации, заголовки, ссылка «К содержимому»,
// роли кнопок у действий rail, различимые имена. Разметка — по исходнику.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

describe("доступность: объявления и состояние", () => {
  test("A11Y-6: рейтинг и «Избранное» объявляют итог фильтра в live-регионе", () => {
    expect(web("Rating.tsx")).toContain('<span className="rh-sr-only" aria-live="polite">');
    expect(web("Rating.tsx")).toContain("ratingAnnouncement(view, state.data)");
    expect(web("MePage.tsx")).toContain("`Показано ${shown.length} из ${entries.length}`");
  });

  test("A11Y-7: направление сортировки — в имени кнопки заголовка", () => {
    expect(web("Rating.tsx")).toMatch(/aria-label=\{active \? `\$\{label\}, \$\{order === "desc" \? "по убыванию" : "по возрастанию"\}/);
  });

  test("A11Y-9: поиск по документации — combobox с aria-activedescendant и счетчиком", () => {
    const s = web("DocsSearch.tsx");
    for (const attr of ['"aria-controls": listId', '"aria-autocomplete": "list"', '"aria-activedescendant"', 'role="option"', "id={hitId(i)}"]) expect(s).toContain(attr);
    expect(s).not.toMatch(/<button[\s\S]{0,120}role="option"/);
  });
});

describe("доступность: структура и имена", () => {
  test("A11Y-10: у заглушек — роль заголовка; 404 — первого уровня; у «Настроек» — H1", () => {
    expect(web("ui.tsx")).toContain('el.setAttribute("role", "heading");');
    for (const f of ["App.tsx", "DocsPage.tsx", "RepoPage.tsx"]) expect(web(f)).toContain("headingLevel={1}");
    expect(web("MePage.tsx")).toContain('<PageHeader title="Настройки"');
  });

  test("A11Y-12: тема и выход в rail — роль кнопки; «Как считается?» — кнопка с пробелом", () => {
    const shell = web("Shell.tsx");
    expect(shell).toContain('a.setAttribute("role", "button");');
    expect(shell).toContain("{...actionTip(themeTitle)}");
    expect(shell).toContain('{...actionTip("Выйти")}');
    expect(web("Rating.tsx")).toMatch(/href="#"\s+role="button"/);
  });

  test("A11Y-15: строка категории — H3 с aria-controls, полоса скрыта, подметрики — таблица", () => {
    const page = web("RepoPage.tsx");
    expect(page).toContain('<h3 className="rh-category__h">');
    expect(page).toContain('aria-controls={`${categoryAnchor(key)}-subs`}');
    expect(page).toContain('<span className="rh-category__bar" aria-hidden="true">');
    expect(page).toContain('role="table" aria-label={`Показатели категории «${c.title}»`}');
  });

  test("A11Y-16: имена различимы — репозиторий в кнопках строки, счетчик очереди словами, якорь документации скрыт", () => {
    const me = web("MePage.tsx");
    expect(me).toContain("aria-label={`Запустить анализ ${entry.org}/${entry.repo}`}");
    expect(me).toMatch(/aria-label=\{jobs === null \? "Очередь"/);
    expect(web("DocsPage.tsx")).toMatch(/className="rh-docs__anchor"[^>]*aria-hidden="true" tabIndex=\{-1\}/);
    // аудит 20.10: aria-label Popover uikit до role="dialog" не доходит — окно основания
    // называет себя через DialogName внутри содержимого, имя различимо по подметрике
    const repoPage = web("RepoPage.tsx");
    expect(repoPage).toContain("<DialogName label={`Источник данных: ${item.label}`} />");
    expect(repoPage).not.toContain("aria-label={`Исходные данные: ${item.label}`}");
    expect(web("ui.tsx")).toMatch(/export function DialogName[\s\S]{0,300}closest\('\[role="dialog"\]'\)\?\.setAttribute\("aria-label", label\)/);
  });

  test("A11Y-18: «К содержимому» — первым, ведет на main", () => {
    const shell = web("Shell.tsx");
    expect(shell.indexOf('className="rh-skip"')).toBeLessThan(shell.indexOf("<AsideHeader"));
    expect(shell).toContain('<main className="rh-page__main" id="rh-main" tabIndex={-1}>');
  });

  test("A11Y-11, A11Y-14: complementary на залитых плашках в темной теме; цели иконок 24px на любом экране", () => {
    const css = web("layout.css");
    // 19.10.2026: пустые AI-обзор и история — без заливки, вторичный текст на чистом фоне
    expect(css).toContain(".g-root_theme_dark :is(.rh-score-band_locked, .rh-empty, .rh-summary__tile) .g-color-text_color_secondary");
    expect(css).toMatch(/\n\.rh-rating-ext,\n\.rh-rating-ai,\n\.rh-rating-fraud \{\n  padding: 5px;\n  margin: -5px;/);
  });
});
