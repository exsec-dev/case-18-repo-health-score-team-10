// Вид рейтинга, карточки и оболочки: утвержденные тексты и геометрия.
// Без живых запросов к SourceCraft.
import { describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", name), "utf8");

describe("В4.6 круг 3: рейтинг", () => {
  // аудит 16.10: уровень несет полоса, число нейтральное 15/550
  test("индекс имеет полосу 80×8px, нейтральное число 15/500 и нулевой зазор", () => {
    const rating = web("Rating.tsx");
    const whole = rating.slice(rating.indexOf("function ScoreCell"), rating.indexOf("function CategoryCell"));
    const css = web("layout.css");
    // UX 17.10: на телефоне полосы нет — число цвета зоны; в таблице – полоса 80px и нейтральное число
    expect(whole).toMatch(/if \(narrow && [^)]*\) \{[\s\S]{0,200}scoreColor\(item\.healthcraftIndex\)/);
    const cell = whole.slice(whole.indexOf("if (item.healthcraftIndex === null)"));
    // аудит 20.10: полоса — общий ScoreBar шириной 80px (своей обертки rh-score-cell__bar нет)
    expect(cell).toContain("<ScoreBar value={item.healthcraftIndex} width={80} />");
    expect(cell).not.toContain("scoreColor(item.healthcraftIndex)");
    expect(cell).toContain('<Flex gap={0} alignItems="center"');
    expect(css).toMatch(/\.rh-score-bar\s*\{[^}]*flex:\s*none/);
    expect(css).toMatch(/\.rh-score-cell__num\s*\{[^}]*font-size:\s*var\(--g-text-body-2-font-size\)[^}]*font-weight:\s*var\(--g-text-accent-font-weight\)/);
    expect(css).toMatch(/\.rh-score-bar \.g-progress,[\s\S]{0,100}height:\s*8px/);
    const categoryCell = rating.slice(rating.indexOf("function CategoryCell"));
    expect(categoryCell).toMatch(/scoreTheme\(value\) === "success"[\s\S]{0,300}rh-cat-plain/);
    expect(categoryCell).toMatch(/scoreLabelTheme\(value\)[\s\S]{0,100}rh-cat-chip/);
    expect(css).toMatch(/\.rh-cat-plain\s*\{[^}]*padding-inline-end:\s*8px/);
    expect(css).toMatch(/\.rh-cat-chip\.g-label_theme_(?:warning|danger)[\s\S]{0,260}color-mix\(in srgb,[^;]*60%, transparent\)/);
  });

  test("поиск, лид, вклад и частота используют утвержденные формулировки", () => {
    const rating = web("Rating.tsx");
    const api = readFileSync(join(import.meta.dir, "..", "src", "api", "repos.ts"), "utf8");
    expect(rating).toContain("Поиск по организации и названию репозитория");
    expect(api).toMatch(/function matchesQ[\s\S]{0,300}item\.org[\s\S]{0,150}item\.repo[\s\S]{0,150}item\.title/);
    expect(rating).toContain("HealthCraft Index показывает состояние открытых репозиториев SourceCraft по 4 категориям: документация, активность, задачи и состояние кода.");
    // в подзаголовке – ссылка «Как считается» и строка охвата с числом неоцененных
    expect(rating).toMatch(/\{about\} <HowCountedLink \/>\s*<br \/>\s*\{coverageLine\(meta\.repos\)\}/);
    expect(rating).toContain("Категории CI/CD и Безопасность учитываются только в показателе Repo Health Score");
    expect(rating).toContain("виден, если вашему токену доступны и CI/CD, и Безопасность репозитория\n");
    // колонки «Скан» нет – подсказка ведет на карточку
    expect(rating).toContain("Каталог сверяется ежечасно, новые репозитории сразу встают в очередь. Изменившиеся репозитории анализируются повторно ежесуточно. Дата последнего анализа – на карточке репозитория.");
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
    // в панели паспорт «Анализ» и «Реквизиты» вместо «Параметров расчета»
    expect(repo).toContain('title="Анализ"');
    expect(repo).not.toContain('title="Параметры расчета"');
    // 18.10: под шкалой текста нет ни на карточке, ни в рейтинге — порог и
    // «без данных – не ноль» сказаны в панели по одному разу
    expect(repo).toContain("<ScoreLegend />");
    expect(ui).not.toContain("При полноте данных ниже");
    expect(ui).not.toContain("Отсутствующие данные не учитываются");
  });

  test("верх и категории соответствуют новой геометрии", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    const band = repo.slice(repo.indexOf("function ScoreBand"), repo.indexOf("function ScoreFigure"));
    const figure = repo.slice(repo.indexOf("function ScoreFigure"), repo.indexOf("// ---------- категории"));
    const row = repo.slice(repo.indexOf("function CategoryRow"), repo.indexOf("function AppsecEngines"));
    expect(figure).toContain('alignItems="baseline"');
    // в строке категории – полоса · балл · плашка, плашки вклада нет, название и
    // основание – одним треком, плашка не растягивается
    expect(band).toMatch(/title="Repo Health Score" help=\{FULL_HELP\}/);
    // под числом не цветная полоса балла, а полоса вклада своего показателя
    expect(figure).not.toContain("<Progress");
    expect(band).toContain('<ContributionStrip bar={barOf("HealthCraft Index")} />');
    expect(row.indexOf('className="rh-category__bar"')).toBeLessThan(row.indexOf('className="rh-category__value"'));
    expect(row.indexOf('className="rh-category__value"')).toBeLessThan(row.indexOf('className="rh-category__word"'));
    expect(row).not.toContain("rh-category__weight");
    // последний трек — только плашка «Нет данных» (уровень несет полоса), пустой схлопывается
    expect(css).toContain("grid-template-columns: 16px minmax(0, 1fr) minmax(80px, 240px) 28px auto;");
    // плашка уровня прижата вправо
    expect(css).toMatch(/\.rh-category__word \{[^}]*justify-self: end/);
    // селектор стал составным: тот же отступ получил блок «Вклад категорий»
    expect(css).toMatch(/\.rh-aside-section > \.g-definition-list,[\s\S]{0,80}\{[^}]*margin-block-start:\s*var\(--g-spacing-1\)/);
  });

  test("недоступные каналы — плашки под списком нет, нижний CTA снят, основания раскрываемы", () => {
    const repo = web("RepoPage.tsx");
    const band = repo.slice(repo.indexOf("function ScoreBand"), repo.indexOf("function ScoreFigure"));
    // 19.10.2026: плашка закрытых категорий под списком снята – путь к полной оценке у Repo Health Score
    expect(repo).not.toContain("function LockedCategories");
    expect(web("layout.css")).not.toMatch(/\.rh-locked-note\s*\{/);
    expect(band).not.toContain("summaryLine");
    expect(band).not.toContain("Рекомендаций:");
    // основание – по кнопке «Источник данных» (18.10.2026: синий ярлык подметрики
    // спорил с заголовком; 19.10.2026: «Откуда данные» → «Источник данных»),
    // раскрывается по клику; ключ факта – мелко в поповере. Аудит 20.10: имя окна
    // для скринридера — DialogName внутри содержимого (aria-label Popover не доходит)
    expect(repo).toMatch(/content=\{\s*<>\s*<DialogName label=\{`Источник данных: \$\{item\.label\}`\} \/>\s*<FactProof item=\{item\} \/>\s*<\/>\s*\}>[\s\S]{0,200}Источник данных[\s\S]{0,60}<Icon data=\{ChevronDown\}/);
    expect(repo).not.toContain("Порядок задан движком правил");
  });

  test("переход к токену встроен в текст, иконка избранного центрирована", () => {
    const repo = web("RepoPage.tsx");
    const css = web("layout.css");
    // переход встроен в строку пути – слово «Настройках» ссылкой (`PathLine`),
    // отдельной строки-ссылки нет
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
    const settingsPage = me.slice(me.indexOf("export function SettingsPage"), me.indexOf("function SettingsSkeleton"));
    // заголовок раздела – в шапке списка, как в SourceCraft: отдельный
    // `PageHeader` над ним дублировал бы его
    expect(reposPage).toContain("<MyReposSection");
    expect(me).toMatch(/<Text variant="header-2" as="h1" className="rh-page-title">\s*Избранное\s*<\/Text>/);
    expect(reposPage).not.toContain("<PatSection");
    // UX 17.10 (A11Y-10): у «Настроек» свой H1, как у остальных разделов
    expect(settingsPage).toContain('<PageHeader title="Настройки" description="Учетная запись, токен SourceCraft и лимиты AI" />');
    expect(settingsPage).toContain("<PatSection");
    expect(settingsPage).not.toContain("Управление доступом к данным репозиториев SourceCraft");
    expect(me).toContain("Токен хранится в зашифрованном виде, не возвращается");
    expect(router).toContain('parts[0] === "settings"');
    expect(app).toContain('route.kind === "settings" && <SettingsPage />');
    expect(shell).toContain('{ id: "me", title: "Избранное", href: "/me", icon: Bookmark }');
    expect([me, router, shell, app].join("\n")).not.toMatch(/Личный кабинет|личный кабинет/);
  });

  test("нижнее затухание удалено полностью", () => {
    expect(web("layout.css")).not.toContain("rh-fade");
    expect(web("Shell.tsx")).not.toContain("rh-fade");
  });
});

// --- Место в рейтинге на карточке -------------------------------------------
// Утверждение поведенческое, а не текстовое: «#N из M» – обещание про выборку
// рейтинга, и цену ошибки платит не верстка, а число на экране.
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

  // Место стоит в строке позиции «#N из M, лучше X% похожих» серым текстом;
  // числа строки проверяет поведенческий тест `tests/v59-hq-position-view.test.ts`
  test("место печатается серым текстом «#N из M», а не чипом", () => {
    const repo = web("RepoPage.tsx");
    const line = repo.slice(repo.indexOf("function PositionLine"), repo.indexOf("// ---------- категории ----------"));
    expect(line).toMatch(/<Text color="secondary"[^>]*>[\s\S]*?\{position\.rank\}[\s\S]*?<\/Text>/);
    // title – только на тексте места, не на обертке с ⓘ (иначе два тултипа)
    expect(line).not.toMatch(/<Text[^>]*title=/);
    expect(line).not.toMatch(/<Label[^>]*>\s*\{position\.rank\}/);
  });
});
