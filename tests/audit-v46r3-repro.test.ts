// Контракт интерактивной доводки В4.6, круг 3, пакет П1.
// Проверяет решения владельца без живых запросов к SourceCraft.
import { describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", name), "utf8");

describe("В4.6 круг 3: рейтинг", () => {
  test("индекс имеет полосу 80×8px, окрашенное число 14px/600 и нулевой зазор", () => {
    const rating = web("Rating.tsx");
    const cell = rating.slice(rating.indexOf("function ScoreCell"), rating.indexOf("function CategoryCell"));
    const css = web("layout.css");
    expect(cell).toContain('className="rh-score-cell__bar"');
    expect(cell).toContain("scoreColor(item.healthcraftIndex)");
    expect(cell).toContain('<Flex gap={0} alignItems="center"');
    expect(css).toMatch(/\.rh-score-cell__bar\s*\{[^}]*flex:\s*0 0 80px[^}]*width:\s*80px/);
    expect(css).toMatch(/\.rh-score-cell__num\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\.rh-score-cell__bar \.g-progress,[\s\S]{0,100}height:\s*8px/);
    const categoryCell = rating.slice(rating.indexOf("function CategoryCell"));
    expect(categoryCell).toMatch(/scoreTheme\(value\) === "success"[\s\S]{0,300}rh-cat-plain/);
    expect(categoryCell).toMatch(/scoreLabelTheme\(value\)[\s\S]{0,100}rh-cat-chip/);
    expect(css).toMatch(/\.rh-cat-plain\s*\{[^}]*padding-inline-end:\s*8px/);
    expect(css).toMatch(/\.rh-cat-chip\.g-label_theme_(?:warning|danger)[\s\S]{0,260}color-mix\(in srgb,[^;]*60%, transparent\)/);
  });

  test("поиск, лид, вклад и частота используют утвержденные формулировки", () => {
    const rating = web("Rating.tsx");
    const api = readFileSync(join(import.meta.dir, "..", "src", "api", "repos.ts"), "utf8");
    expect(rating).toContain("Поиск по владельцу, репозиторию и заголовку");
    expect(api).toMatch(/function matchesQ[\s\S]{0,300}item\.org[\s\S]{0,150}item\.repo[\s\S]{0,150}item\.title/);
    expect(rating).toContain("HealthCraft Index показывает состояние открытых репозиториев SourceCraft по 4 категориям: документация, активность, задачи и состояние кода.");
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, Б2 / U14): в подзаголовке — ссылка «Как считается»
    expect(rating).toMatch(/\{about\} <HowCountedLink \/>\s*<br \/>\s*Оценено \{fmtCount\(scored\)\} из \{fmtCount\(catalog\)\} репозиториев\./);
    expect(rating).toContain("Категории CI/CD и Безопасность учитываются только в показателе Repo Health Score");
    expect(rating).toContain("репозиториев, к которым у вас есть доступ\n");
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, Б): колонка «Скан» скрыта — подсказка ведет на карточку
    expect(rating).toContain("Обход каталога выполняется ежесуточно. Дата последнего анализа – на карточке репозитория.");
    expect(rating).not.toContain("указана в колонке «Скан»");
  });
});

describe("В4.6 круг 3: карточка", () => {
  test("формальные тексты, шкала и компактная оговорка о данных", () => {
    const repo = web("RepoPage.tsx");
    const ui = web("ui.tsx");
    const format = web("format.ts");
    expect(format).toContain('danger: "в зоне риска"');
    expect(format).toContain('SCORE_LEGEND_TITLE = "Шкала оценки"');
    expect(format).toContain('denied: "У вашего токена нет прав на эти данные репозитория."');
    expect(format).toContain("ACCESS_LOCK_SHORT");
    expect(repo).toContain("Рассчитывается по 6 категориям");
    expect(repo).toContain('title="Что учитывается"');
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А8 / U4-A): «Параметры расчета» → паспорт «Анализ» + «Реквизиты»
    expect(repo).toContain('title="Анализ"');
    expect(repo).not.toContain('title="Параметры расчета"');
    // абзац легенды на карточке отключен пропом; на рейтинге он остается (ui.tsx ниже)
    expect(repo).toContain("<ScoreLegend withNote={false} />");
    expect(ui).toContain('variant="body-1"');
    expect(ui).toContain("При покрытии данных ниже");
    expect(ui).toContain("Отсутствующие данные не учитываются как нулевые значения");
  });

  test("верх и категории соответствуют новой геометрии", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    const band = repo.slice(repo.indexOf("function ScoreBand"), repo.indexOf("function ScoreFigure"));
    const figure = repo.slice(repo.indexOf("function ScoreFigure"), repo.indexOf("// ---------- категории"));
    const row = repo.slice(repo.indexOf("function CategoryRow"), repo.indexOf("function AppsecEngines"));
    expect(figure).toContain('alignItems="baseline"');
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А2-А4): полоса показателя есть у обоих
    // чисел без флага; в строке категории — полоса · балл · плашка, плашки вклада
    // нет, название и основание — одним треком, плашка не растягивается
    expect(band).toMatch(/title="Repo Health Score" help=\{FULL_HELP\}/);
    expect(figure).toMatch(/total !== null && \([\s\S]{0,120}<Progress value=\{Math\.round\(total\)\}/);
    expect(row.indexOf('className="rh-category__bar"')).toBeLessThan(row.indexOf('className="rh-category__value"'));
    expect(row.indexOf('className="rh-category__value"')).toBeLessThan(row.indexOf('className="rh-category__word"'));
    expect(row).not.toContain("rh-category__weight");
    expect(css).toContain("grid-template-columns: 16px minmax(0, 1fr) minmax(80px, 240px) 28px 150px;");
    expect(css).toMatch(/\.rh-category__word \{[^}]*justify-self: start/);
    // селектор стал составным: тот же отступ получил блок «Вклад категорий»
    expect(css).toMatch(/\.rh-aside-section > \.g-definition-list,[\s\S]{0,80}\{[^}]*margin-block-start:\s*var\(--g-spacing-1\)/);
  });

  test("недоступные каналы — Alert, нижний CTA снят, основания раскрываемы", () => {
    const repo = web("RepoPage.tsx");
    const locked = repo.slice(repo.indexOf("function LockedCategories"), repo.indexOf("function CategoryRow"));
    const band = repo.slice(repo.indexOf("function ScoreBand"), repo.indexOf("function ScoreFigure"));
    expect(locked).toContain('<Alert');
    expect(locked).toContain('theme="info"');
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А4): строки «категория — фраза» → заголовок и одно предложение
    expect(locked).not.toContain("<DefinitionList");
    expect(locked).toContain("title={title}");
    // ссылка из строки убрана: переход к токену живёт у показателя (решение 21.09)
    expect(locked).not.toContain('linkProps("/settings")');
    expect(web("layout.css")).toMatch(/\.rh-locked-note\s*\{[^}]*margin-top:[^}]*\}/);
    expect(web("layout.css")).not.toMatch(/\.rh-locked-note\s*\{[^}]*padding:/);
    expect(band).not.toContain("summaryLine");
    expect(band).not.toContain("Рекомендаций:");
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А5 / U8): основание — словами (ярлык
    // подметрики), раскрывается по клику; ключ факта — мелко в поповере
    expect(repo).toMatch(/<Label theme="info" size="xs" interactive>[\s\S]{0,120}\{item\.label\}[\s\S]{0,80}<Icon data=\{ChevronDown\}/);
    expect(repo).not.toContain("Порядок задан движком правил");
  });

  test("переход к токену встроен в текст, иконка избранного центрирована", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А2): переход встроен в строку пути —
    // слово «Настройках» ссылкой (`PathLine`), отдельной строки-ссылки нет
    expect(repo).toMatch(/p\.settings \?[\s\S]{0,80}linkProps\("\/settings"\)/);
    expect(repo).not.toContain(">Добавить персональный токен доступа<");
    const star = repo.slice(repo.indexOf("function FavoriteStar"));
    expect(star).toContain('className={["rh-favorite-star"');
    expect(star).toMatch(/<Button[\s\S]{0,2000}<Icon data=\{state === "on" \? StarFill : Star\} size=\{14\} \/>/);
    expect(star).not.toContain("rh-favorite-star__icon");
    expect(css).toContain("--g-button-text-color: var(--g-color-text-secondary)");
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
    // В4.8: заголовок раздела переехал в шапку списка (образец SourceCraft) —
    // `PageHeader` над отдельным `h2` дублировал его; страница — это список
    expect(reposPage).toContain("<MyReposSection");
    expect(me).toMatch(/<Text variant="header-1" as="h1">\s*Мои репозитории\s*<\/Text>/);
    expect(reposPage).not.toContain("<PatSection");
    expect(settingsPage).not.toContain('<PageHeader title="Настройки"');
    expect(settingsPage).toContain("<PatSection");
    expect(settingsPage).not.toContain("Управление доступом к данным репозиториев SourceCraft");
    expect(me).toContain("Токен хранится в зашифрованном виде (AES-256-GCM)");
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

// --- Пакет П4 (21.09): место в рейтинге на карточке -------------------------
// Утверждение поведенческое, а не текстовое: «#N из M» — обещание про выборку
// рейтинга, и цену ошибки платит не вёрстка, а число на экране.
describe("В4.6 круг 3, П4: место в рейтинге", () => {
  test("публичный оценённый получает место по тем же условиям, что рейтинг", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      const mk = (repo: string, total: number): void => {
        const id = seedRepo(t, { org: "rank", repo });
        seedScore(t, id, seedScan(t, id, { facts }), { total });
      };
      mk("top", 90);
      mk("mid", 70);
      mk("low", 50);
      const card = getRepoCard(t.db, "rank", "mid", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!;
      expect(card.score!.rank).toBe(2);
      expect(card.score!.rankedTotal).toBe(3);
    } finally {
      t.close();
    }
  });

  test("приватный репозиторий места не получает: в публичном рейтинге его нет", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      const pub = seedRepo(t, { org: "rank", repo: "public-one" });
      seedScore(t, pub, seedScan(t, pub, { facts }), { total: 40 });
      const priv = seedRepo(t, { org: "rank", repo: "private-one" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      seedScore(t, priv, seedScan(t, priv, { facts }), { total: 95 });
      const card = getRepoCard(t.db, "rank", "private-one", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!;
      // индекс у приватного есть — его видят участники репозитория
      expect(card.score!.healthcraftIndex).toBe(95);
      // а места нет: иначе карточка печатала бы «#1 из 1» про чужую выборку
      expect(card.score!.rank).toBeNull();
      expect(card.score!.rankedTotal).toBeNull();
    } finally {
      t.close();
    }
  });

  test("место печатается серым текстом «#N из M», а не чипом", () => {
    const repo = web("RepoPage.tsx");
    const figure = repo.slice(repo.indexOf("function ScoreFigure"));
    expect(figure).toMatch(/rank !== null && rank !== undefined && rankedTotal/);
    expect(figure).toMatch(/#\{fmtCount\(rank\)\} из \{fmtCount\(rankedTotal\)\}/);
    expect(figure).toContain('className="rh-score-figure__rank"');
  });
});
