// Контракт интерактивной доводки В4.6, круг 3, пакет П1.
// Проверяет решения владельца без живых запросов к SourceCraft.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", name), "utf8");

describe("В4.6 круг 3: рейтинг", () => {
  test("индекс снова имеет полосу 80px, обычное окрашенное число", () => {
    const rating = web("Rating.tsx");
    const cell = rating.slice(rating.indexOf("function ScoreCell"), rating.indexOf("function CategoryCell"));
    const css = web("layout.css");
    expect(cell).toContain('className="rh-score-cell__bar"');
    expect(cell).toContain("scoreColor(item.healthcraftIndex)");
    expect(cell).not.toContain('variant="body-3"');
    expect(css).toMatch(/\.rh-score-cell__bar\s*\{[^}]*flex:\s*0 0 80px[^}]*width:\s*80px/);
  });

  test("лид, вклад и частота используют утвержденные формулировки", () => {
    const rating = web("Rating.tsx");
    expect(rating).toContain("HealthCraft Index показывает состояние открытых репозиториев SourceCraft по 4 категориям: документация, активность, issues и состояние кода.");
    expect(rating).toMatch(/\{about\}\s*<br \/>\s*Оценено \{fmtCount\(scored\)\} из \{fmtCount\(catalog\)\} репозиториев\./);
    expect(rating).toContain("Категории CI/CD и Security учитываются только в показателе Repo Health Score");
    expect(rating).toContain("Обход каталога выполняется ежесуточно. Дата последнего анализа указана в колонке «Скан»");
  });
});

describe("В4.6 круг 3: карточка", () => {
  test("формальные тексты, новый термин и компактная оговорка о данных", () => {
    const repo = web("RepoPage.tsx");
    const ui = web("ui.tsx");
    const format = web("format.ts");
    expect(format).toContain('danger: "критическое состояние"');
    expect(repo).toContain("Repo Health Score рассчитывается по 6 категориям");
    expect(repo).toContain('title="Что учитывается"');
    expect(repo).toContain('title="Параметры расчета"');
    expect(ui).toContain('variant="body-2"');
    expect(ui).toContain("Отсутствующие данные не приравниваются к нулевому результату");
  });

  test("верх и категории соответствуют новой геометрии", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    const figure = repo.slice(repo.indexOf("function ScoreFigure"), repo.indexOf("// ---------- категории"));
    const row = repo.slice(repo.indexOf("function CategoryRow"), repo.indexOf("function AppsecEngines"));
    expect(figure).toContain('alignItems="flex-end"');
    expect(row.indexOf('className="rh-category__bar"')).toBeLessThan(row.indexOf('className="rh-category__weight"'));
    expect(css).toContain("grid-template-columns: 16px minmax(120px, 180px) minmax(0, 1fr) minmax(80px, 360px) 40px auto");
  });

  test("недоступные каналы — Alert, нижний CTA снят, основания раскрываемы", () => {
    const repo = web("RepoPage.tsx");
    const locked = repo.slice(repo.indexOf("function LockedCategories"), repo.indexOf("function CategoryRow"));
    const band = repo.slice(repo.indexOf("function ScoreBand"), repo.indexOf("function ScoreFigure"));
    expect(locked).toContain('<Alert theme="info" view="outlined" size="s"');
    expect(band).not.toContain("summaryLine");
    expect(band).not.toContain("Рекомендаций:");
    expect(repo).toMatch(/<Label theme=\{ref\.missing[\s\S]{0,220}<Icon data=\{ChevronDown\}/);
    expect(repo).not.toContain("Порядок задан движком правил");
  });

  test("переход к токену встроен в текст, иконка избранного центрирована", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    expect(repo).toMatch(/добавьте токен доступа SourceCraft в\{" "\}[\s\S]{0,100}linkProps\("\/settings"\)/);
    expect(css).toMatch(/\.rh-favorite-star__icon\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*line-height:\s*0/);
  });
});

describe("В4.6 круг 3: разделы пользователя и оболочка", () => {
  test("Мои репозитории и Настройки разделены по бизнес-функции", () => {
    const me = web("MePage.tsx");
    const router = web("router.ts");
    const shell = web("Shell.tsx");
    const app = web("App.tsx");
    const reposPage = me.slice(me.indexOf("export function MePage"), me.indexOf("export function SettingsPage"));
    const settingsPage = me.slice(me.indexOf("export function SettingsPage"), me.indexOf("function AccountSection"));
    expect(reposPage).toContain('<PageHeader title="Мои репозитории" />');
    expect(reposPage).not.toContain("<PatSection");
    expect(settingsPage).toContain('<PageHeader title="Настройки"');
    expect(settingsPage).toContain("<PatSection");
    expect(router).toContain('parts[0] === "settings"');
    expect(app).toContain('route.kind === "settings" && <SettingsPage />');
    expect(shell).toContain('{ id: "me", title: "Мои репозитории"');
    expect([me, router, shell, app].join("\n")).not.toMatch(/Личный кабинет|личный кабинет/);
  });

  test("нижнее затухание удалено полностью", () => {
    expect(web("layout.css")).not.toContain("rh-fade");
    expect(web("Shell.tsx")).not.toContain("rh-fade");
  });
});
