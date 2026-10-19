// Репро-тесты на дефекты UI и MD-отчета, найденные дизайн-аудитом (шкала, палитра,
// сетка, компоновка карточки). Обертка `repro` – в обычном прогоне `test.failing`,
// под AUDIT_STRICT=1 обычный `test`; в конце файла строгая самопроверка, что под
// `repro` ничего не осталось.
//
// Живых запросов нет: MD – чистая функция от карточки на временной БД, UI –
// source-assert, палитра – арифметика WCAG по src/web/theme.css (tests/theme-contrast.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { scoreWord } from "../src/web/format";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { contrast, flatten, pageBackground, parseColor, progressFill, progressTrack, themeTokens } from "./theme-contrast";
import { buildReportModel } from "../src/report/build";
import { fixtureCard } from "./report-fixtures";

/** Первый экран отчета несет плашку зоны – проверяется по модели отчета, а не по строке исходника. */
function reportHeroHasChip(): boolean {
  const { card, close } = fixtureCard("full");
  try {
    const hero = buildReportModel(card).blocks.find((b) => b.kind === "hero");
    return hero?.kind === "hero" && hero.chip !== null && hero.chip.text.length > 0;
  } finally {
    close();
  }
}


/**
 * Путь – переменная, чтобы `tsc` не падал, пока модуля еще нет: репро должно
 * быть красным тестом, а не красной типизацией.
 */
const importLater = async (path: string): Promise<Record<string, unknown>> => (await import(path)) as Record<string, unknown>;

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const reportSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");

// ---------------------------------------------------------------------------
// Общая фикстура MD: карточка с закрытой (Security без данных) категорией –
// на ней видны «вклад 0%» и словесная шкала итога.
// ---------------------------------------------------------------------------

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const repoId = seedRepo(t, { org: "v46", repo: "repro", title: "v46 repro", language: "Go", likes: 7, forks: 1, lastActivityAt: "2026-09-15T00:00:00Z" });
const scanId = seedScan(t, repoId, { status: "partial", trigger: "user", facts: cardFacts() });
seedScore(t, repoId, scanId, { total: 67 });
seedRecommendation(t, scanId, {
  ruleId: "contributing-missing",
  priority: 1,
  problem: "Нет CONTRIBUTING – как вносить правки не описано",
  factRef: "docs.presence",
  deltaScore: 2.25,
  expectedImpact: "+2.3 к HealthCraft Index (по одному)",
});
const md = (): string => renderRepoReport(getRepoCard(t.db, "v46", "repro", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!);

// ---------------------------------------------------------------------------
// Категорийные числа рейтинга не кодировали качество: 26 и 98 одним цветом, а
// `null` – бледное тире, то есть «плохо» и «нет данных» глазом не различить.
// `null` – Label theme="unknown", никогда не красный и не ноль.
// ---------------------------------------------------------------------------

describe("В4.6-1 (У20): качество категорий закодировано в рейтинге и на карточке", () => {
  test("рейтинг: исключения выделены Label, >=70 нейтрально, null – Label theme=\"unknown\"", () => {
    const src = srcOf("Rating.tsx");
    const cell = src.slice(src.indexOf("function CategoryCell"));
    expect({
      // цветом выделяются только исключения, а не весь числовой ряд
      exceptionsAreLabels: /scoreLabelTheme\(value\)/.test(cell) && /className="rh-cat-chip"/.test(cell),
      healthyIsPlain: /scoreTheme\(value\) === "success"/.test(cell) && /className="rh-cat-plain"/.test(cell),
      nullIsUnknownLabel: /theme="unknown"/.test(cell),
      nullIsNotBareDash: !/>\s*–\s*</.test(cell),
    }).toEqual({ exceptionsAreLabels: true, healthyIsPlain: true, nullIsUnknownLabel: true, nullIsNotBareDash: true });
  });

  // Аудит 16.10: одна полоса оценки на все экраны (ScoreBar, уровень — цветом
  // заливки); число не окрашено; плашка — только у «требует внимания» и «в зоне
  // риска» (порог `scoreLabelTheme`, как у плашки отчета). «Нет данных» –
  // нейтральная плашка view-модели (поведенческий тест – v49-ui-r1-card).
  test("карточка: полоса ScoreBar по уровню, плашка по порогам кроме «Здоров», число нейтрально, «нет данных» нейтрально", () => {
    const src = srcOf("RepoPage.tsx");
    const row = src.slice(src.indexOf("function CategoryRow"), src.indexOf("// ---------- маркеры расчёта"));
    const view = srcOf("cardView.ts");
    expect({
      valueColored: /rh-category__value[\s\S]{0,400}scoreColor|scoreColor[\s\S]{0,400}rh-category__value/.test(row),
      chipByThreshold: /<Label theme=\{c\.chip\.theme\}/.test(row) && view.includes("theme: scoreLabelTheme(cat.score)"),
      // 18.10.2026 (C1): полоса категории слитная, цветом зоны; значки показателей — тем же цветом
      barByLevel: row.includes("<CategoryBar color={color} score={c.score} />") && row.includes("ZONE_COLOR[scoreTheme(c.score)]"),
      // плашка уровня — только у «Нет данных»; уровень несет цвет полосы
      healthyNoChip: row.includes("{c.score === null && (") && !row.includes('c.chip.theme === "success"'),
      noDataNeutral: view.includes('cat.score === null ? "Нет данных"'),
    }).toEqual({ valueColored: false, chipByThreshold: true, barByLevel: true, healthyNoChip: true, noDataNeutral: true });
  });
});

// ---------------------------------------------------------------------------
// «Вклад 0%» у закрытых и пустых категорий опровергал собственный tri-state:
// категория «дала ноль» вместо «не учитывается».
// ---------------------------------------------------------------------------

describe("В4.6-2 (У25): «вклад 0%» заменён на «не учитывается»", () => {
  test("карточка: у категории без данных вклад не печатается нулём", () => {
    // Чипа вклада на карточке нет вовсе: у категории без данных вместо числа «—»
    // и плашка «Нет данных», причина – строкой основания (поведенческий тест –
    // v49-ui-r1-card).
    const src = srcOf("RepoPage.tsx");
    expect({
      contributionChip: src.includes("NOT_COUNTED") || /Вклад \$\{contribution\}%/.test(src),
      printsZeroContribution: /вклад \{contribution\}%/i.test(src),
      // прочерк один – в колонке балла (`c.scoreText` = `fmtScore(null)` = «—»), место полосы пустое
      dashInsteadOfBar: /c\.score === null \? null :/.test(src) && src.includes("{c.scoreText}"),
    }).toEqual({ contributionChip: false, printsZeroContribution: false, dashInsteadOfBar: true });
  });

  test("MD: в таблице категорий у Security стоит «не учитывается», а не «0%»", () => {
    const out = md();
    // таблица категорий – «—» и «нет данных», вес в приложении А – «не входит»
    expect({ honest: out.includes("| Безопасность | – | нет данных |") && out.includes("| Безопасность | – | не входит | – |"), zero: out.includes("| 0% |") }).toEqual({
      honest: true,
      zero: false,
    });
  });
});

// ---------------------------------------------------------------------------
// У числа не было шкалы: scoreTheme() делит ≥70 / 40–69 / <40, но словами эти
// полосы на экране не назывались ни на карточке, ни в строке итога MD.
// ---------------------------------------------------------------------------

describe("В4.6-3 (У22): словесная шкала здоровья видна на карточке и в MD", () => {
  test("format.ts отдаёт слово шкалы чистой функцией (одна копия на страницу и отчёт)", async () => {
    const { scoreWord } = (await import("../src/web/format")) as { scoreWord?: (v: number | null) => string };
    expect(typeof scoreWord).toBe("function");
    expect([scoreWord!(83), scoreWord!(55), scoreWord!(12)]).toEqual(["здоров", "требует внимания", "в зоне риска"]);
  });

  // Заголовок легенды живет в одном месте (SCORE_LEGEND_TITLE в format.ts) и
  // рисуется общим ScoreLegend – литерал в каждой странице дал бы две копии.
  test("легенда шкалы – один компонент с одним заголовком «Шкала оценки»", () => {
    const ui = srcOf("ui.tsx");
    expect({
      component: ui.includes("export function ScoreLegend"),
      titleFromFormat: ui.includes("SCORE_LEGEND_TITLE"),
      oneHome: srcOf("format.ts").includes('SCORE_LEGEND_TITLE = "Шкала оценки"'),
    }).toEqual({ component: true, titleFromFormat: true, oneHome: true });
  });

  test("карточка: Label со словом шкалы у числа плюс блок легенды в методике", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ importsWord: src.includes("scoreWord"), legend: src.includes("<ScoreLegend ") }).toEqual({ importsWord: true, legend: true });
  });

  // Якорь «что идет после легенды» – следующий блок панели, «Вклад категорий».
  test("рейтинг: легенда – первым блоком правой панели", () => {
    const src = srcOf("Rating.tsx");
    const legend = src.indexOf("<ScoreLegend ");
    const nextSection = src.indexOf('title="Вклад категорий"');
    expect({ hasLegend: legend >= 0, isFirst: legend >= 0 && nextSection >= 0 && legend < nextSection }).toEqual({ hasLegend: true, isFirst: true });
  });

  test("MD: строка итога называет то же слово шкалы", () => {
    const out = md();
    // первый экран – строка «**N из 100 · слово**», слово то же, что scoreWord у числа
    const m = /(?:HealthCraft Index|Repo Health Score): \*\*(\d+) из 100 · ([^*]+)\*\*/.exec(out);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(scoreWord(Number(m![1])));
  });
});

// ---------------------------------------------------------------------------
// Методическая проза набрана `color="secondary"`, контраст которого был ниже
// AA 4.5:1 в обеих темах по значениям theme.css (темная 4,40:1, светлая 3,98:1).
// Порог проверяется расчетом, а не снимками.
// ---------------------------------------------------------------------------

describe("В4.6-4 (У24/У37): проза color=\"secondary\" берёт AA в обеих темах", () => {
  const secondaryContrast = (theme: "dark" | "light"): number => {
    const tokens = themeTokens(theme);
    const bg = parseColor(pageBackground(tokens));
    return contrast(flatten([bg, tokens.get("--g-color-text-secondary")!]), bg);
  };

  test("тёмная тема: --g-color-text-secondary ≥ 4.5:1 (было 4.4:1)", () => {
    expect(secondaryContrast("dark")).toBeGreaterThanOrEqual(4.5);
  });

  test("светлая тема: --g-color-text-secondary ≥ 4.5:1 (было 3.98:1)", () => {
    expect(secondaryContrast("light")).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// `Progress` заливает полосу токеном `--g-color-base-*-medium`, а в палитре это
// были полупрозрачные значения: полоса смешивалась с дорожкой и «сливалась с
// серым» (зеленый 1,95:1, красный 1,46:1). Проверяются обе темы и все 4 тона.
// ---------------------------------------------------------------------------

describe("В4.6-5 (У37): заливка полос непрозрачна и берёт 3:1 к дорожке в обеих темах", () => {
  const TONES = ["positive", "warning", "danger", "misc"] as const;

  for (const theme of ["dark", "light"] as const) {
    test(`${theme === "dark" ? "тёмная" : "светлая"} тема: base-*-medium без альфы`, () => {
      const tokens = themeTokens(theme);
      const withAlpha = TONES.filter((tone) => parseColor(tokens.get(`--g-color-base-${tone}-medium`)!).a < 1);
      expect(withAlpha).toEqual([]);
    });

    test(`${theme === "dark" ? "тёмная" : "светлая"} тема: каждая заливка ≥ 3:1 к дорожке Progress`, () => {
      const tokens = themeTokens(theme);
      const track = progressTrack(tokens);
      const below = TONES.filter((tone) => contrast(progressFill(tokens, tone), track) < 3);
      expect(below).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Колонка индекса была полосой 64×4px под числом (0,64px на балл). Требование:
// полоса 80px слева, число в фиксированном слоте справа; `perPage` 20 и опция 20
// в pageSizeOptions.
// ---------------------------------------------------------------------------

describe("В4.6-6 (У21): колонка индекса – горизонтально, число справа", () => {
  // Аудит 16.10: уровень несет полоса, число нейтральное — один цветной акцент
  test("ScoreCell: полоса 80px слева, число в слоте справа, нейтральное", () => {
    const src = srcOf("Rating.tsx");
    const whole = src.slice(src.indexOf("function ScoreCell"), src.indexOf("function CategoryCell"));
    // UX 17.10: на телефоне (`narrow`) полосы нет, число цвета зоны — проверяется
    // отдельно; здесь — ячейка таблицы
    expect(whole).toMatch(/if \(narrow && [^)]*\) \{[\s\S]{0,200}scoreColor\(item\.healthcraftIndex\)/);
    const cell = whole.slice(whole.indexOf("if (item.healthcraftIndex === null)"));
    const css = srcOf("layout.css");
    expect({
      horizontal: !/direction="column"/.test(cell),
      bar80: /\.rh-score-cell__bar\s*\{[^}]*flex:\s*0 0 80px[^}]*width:\s*80px/.test(css),
      slot: cell.includes("rh-score-cell__num"),
      sameTextSize: !cell.includes('variant="body-3"') && !cell.includes('variant="subheader-3"'),
      neutralNumber: !cell.includes("scoreColor(item.healthcraftIndex)") && cell.includes('<Text color="primary" className="rh-score-cell__num"'),
      noOldBar: !cell.includes("width: 64"),
    }).toEqual({ horizontal: true, bar80: true, slot: true, sameTextSize: true, neutralNumber: true, noOldBar: true });
  });

  test("дефолт страницы 20 и опция 20 в pageSizeOptions (иначе к дефолту не вернуться)", async () => {
    const { DEFAULT_QUERY } = await import("../src/api/repos");
    expect(DEFAULT_QUERY.perPage).toBe(20);
    expect(srcOf("Rating.tsx")).toContain("[10, 20, 50, 100]");
  });
});

// ---------------------------------------------------------------------------
// У сетки не было границ: правая панель рейтинга на 1366 резала колонку «Code
// health», полоса категории тянулась `1fr` (на 1920 – 840px и переставала быть
// мерой), у основной колонки не было меры. Карточка в Drawer панель не уводит
// (asideInDrawer работает только при mode==="fill"), поэтому ей правится CSS-порог.
// ---------------------------------------------------------------------------

describe("В4.6-7 (У23): границы сетки и разрешения", () => {
  const layout = (): string => srcOf("layout.css");

  // Порог колонки панели – проп `asideColumnFrom` (по умолчанию 1440); рейтинг
  // держит панель колонкой с 1600, чтобы на 1440 таблица вмещала «Реакции» и
  // «Обновлен».
  test("рейтинг: JS-порог правой панели – 1600, остальные страницы – 1440", () => {
    const shell = srcOf("Shell.tsx");
    expect(shell).toContain("asideColumnFrom = 1440");
    expect(shell).toContain("useMediaQuery(`(min-width: ${asideColumnFrom}px)`)");
    expect(srcOf("Rating.tsx")).toContain("asideColumnFrom={1600}");
  });

  test("карточка: CSS-порог укладки колонок – 1439, панель на 1366 уходит под основную", () => {
    expect(layout()).toContain("@media (max-width: 1439px)");
  });

  test("полоса категории ограничена мерой minmax(80px, 360px), а не 1fr", () => {
    const css = layout();
    expect({ hasMeasure: css.includes("minmax(80px, 360px)"), stretches: css.includes("minmax(80px, 1fr)") }).toEqual({
      hasMeasure: true,
      stretches: false,
    });
  });

  test("у основной колонки есть мера, затухание нижней кромки полностью снято", () => {
    const css = layout();
    expect({ measure: /\.rh-page__main[\s\S]{0,200}max-width/.test(css), fade: css.includes("rh-fade") }).toEqual({ measure: true, fade: false });
  });
});

// ---------------------------------------------------------------------------
// Карточка начинается с вывода: величина – в главной колонке, правая панель
// методическая. Генератор фразы итога живет в src/web/format.ts, markdown.ts его
// вызывает (импорт src/report в клиент валит Bun.build – tests/web.test.ts).
// ---------------------------------------------------------------------------

describe("В4.6-8 (У26/У13/У38): вариант А – карточка начинается с вывода", () => {
  test("генератор строки итога – чистая функция src/web/format.ts, MD её вызывает", async () => {
    const mod = (await import("../src/web/format")) as { summaryLine?: unknown };
    expect(typeof mod.summaryLine).toBe("function");
    // в отчете итог несет крупное число с плашкой зоны, а не предложение-вывод
    expect(reportHeroHasChip()).toBe(true);
  });

  // Проверяется порядок рендера, а не порядок объявления функций в файле:
  // `Page` берет панель пропом `aside` и рендерит `main`, потом `aside`, поэтому
  // «полоса раньше панели» = «полоса лежит среди детей Page». Заодно проверяется,
  // что панель методическая по составу, а не просто лишилась числа.
  test("величина – блоком в главной колонке, правая панель чисто методическая", () => {
    const src = srcOf("RepoPage.tsx");
    const pageOpen = src.indexOf("<Page crumbs={crumbs} actions={actions}");
    const bandMount = src.search(/<ScoreBand\s+card=\{card\}/);
    const asideBody = src.slice(src.indexOf("function ScoreAside"), src.indexOf("function ScoreBand"));
    expect({
      bandIsMainChild: pageOpen >= 0 && bandMount > pageOpen,
      bandHasOwnClass: src.includes('className="rh-score-band"'),
      asideKeepsFigure: /display-2/.test(asideBody),
      // в панели паспорт «Анализ», «Сведения» и шкала
      asideIsMethodOnly: asideBody.includes("<ScoreLegend ") && asideBody.includes('title="Анализ"') && asideBody.includes('title="Сведения"'),
    }).toEqual({ bandIsMainChild: true, bandHasOwnClass: true, asideKeepsFigure: false, asideIsMethodOnly: true });
  });

  test("текст под индексами и ссылка рекомендаций сняты; таб и худшая категория сохранены", () => {
    const src = srcOf("RepoPage.tsx");
    const band = src.slice(src.indexOf("function ScoreBand"), src.indexOf("function ScoreFigure"));
    expect({ summary: band.includes("summaryLine"), recommendationLink: band.includes("Рекомендаций:"), tabInQuery: src.includes("?tab=") || src.includes('"tab"'), worstOpen: src.includes("worstKey") }).toEqual({
      summary: false,
      recommendationLink: false,
      tabInQuery: true,
      // худшая категория при первом заходе не раскрывается – это путало
      worstOpen: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Консистентность: звезда избранного – иконка @gravity-ui/icons, а не глиф ★/☆;
// плейсхолдер поиска называет действие, а не поля; сортировка без жаргона.
// ---------------------------------------------------------------------------

describe("В4.6-9 (У27–У32): консистентность вне кабинета", () => {
  test("У32: звезда избранного – иконка @gravity-ui/icons, не глиф ★/☆", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ glyph: src.includes("★") || src.includes("☆"), icon: /Star/.test(src) }).toEqual({ glyph: false, icon: true });
  });

  test("У29: плейсхолдер «Поиск» плюс подсказка о полях поиска", () => {
    const src = srcOf("Rating.tsx");
    expect({
      placeholder: src.includes('placeholder="Поиск"'),
      oldPlaceholder: src.includes('placeholder="org, repo или название"'),
      // «имя» и «название» разведены по фактическим полям поиска
      hint: src.includes("Поиск по владельцу, репозиторию и заголовку"),
    }).toEqual({ placeholder: true, oldPlaceholder: false, hint: true });
  });

  // Сортировка живет в заголовках колонок; проверяется, что жаргонной формы
  // записи слага в интерфейсе нет.
  test("У30: сортировка по имени названа словом, а не формой записи слага", () => {
    const src = srcOf("Rating.tsx");
    expect({ plain: src.includes('sortable("Репозиторий", "name")'), jargon: src.includes("Имя (org/repo)") }).toEqual({
      plain: true,
      jargon: false,
    });
  });

  // AsideHeader 6.6.0 рисует линию под шапкой rail псевдоэлементами блока
  // `gn-aside-header__header` (`::after` в широком режиме, `::before` в узком);
  // класса `gn-aside-header__divider` в пакете нет.
  test("У28: разделительной линии между лого и меню в rail нет", () => {
    const css = srcOf("layout.css");
    expect({
      afterHidden: css.includes('.rh-rail [class*="gn-aside-header__header"]::after'),
      beforeHidden: css.includes('.rh-rail [class*="gn-aside-header__header"]::before'),
    }).toEqual({ afterHidden: true, beforeHidden: true });
  });
});

// ---------------------------------------------------------------------------
// Слоты AI-summary, истории Score, badge и сравнения – видимые места с честным
// состоянием «пока нет данных», без выдуманных чисел и мертвых кнопок.
// ---------------------------------------------------------------------------

describe("В4.6-10 (У18): слоты под В5 заложены честными состояниями", () => {
  test("слоты AI-summary, истории Score и badge видны с состоянием «пока нет данных»", () => {
    const src = srcOf("RepoV5.tsx");
    expect({ ai: src.includes("aiSummary"), history: src.includes("scoreHistory"), badge: src.includes("badge") }).toEqual({
      ai: true,
      history: true,
      badge: true,
    });
  });

  test("контракты полей слотов совпадают со спекой В5 по именам", async () => {
    const mod = await importLater("../src/web/slots");
    const contracts = mod.SLOT_CONTRACTS as Record<string, readonly string[]> | undefined;
    expect(Object.keys(contracts ?? {}).sort()).toEqual(["aiSummary", "badge", "compare", "scoreHistory"]);
  });

  // Раздел сравнения появляется вместе с работающим сценарием: маршрут и третий
  // пункт rail есть; поведение раздела – tests/v53-compare.test.ts.
  test("сравнение: контракт и пустое состояние есть, маршрут и третий пункт rail – с работающим сценарием", async () => {
    const mod = await importLater("../src/web/slots");
    const contracts = mod.SLOT_CONTRACTS as Record<string, readonly string[]> | undefined;
    const router = await importLater("../src/web/router");
    const shell = srcOf("Shell.tsx");
    expect({
      contract: (contracts?.compare ?? []).length > 0,
      railItem: shell.includes('{ id: "compare", title: "Сравнение", href: "/compare"'),
      route: (router.parseRoute as (p: string, s?: string) => unknown)("/compare", "r=a/b"),
    }).toEqual({ contract: true, railItem: true, route: { kind: "compare", search: "r=a/b" } });
  });
});

// ---------------------------------------------------------------------------
// Охват каталога, граница доступа избранного и движки AppSec.
// ---------------------------------------------------------------------------

describe("В4.6-11 (У15/У16/У17): охват, границы доступа, движки AppSec", () => {
  test("У15: рейтинг называет охват числами из БД без внутренней стратегии обхода", () => {
    // строка охвата – чистая функция `coverageLine` в ratingParams.ts
    const src = srcOf("Rating.tsx") + srcOf("ratingParams.ts");
    expect({
      coverage: /оценено/i.test(src),
      wave: src.includes("по убыванию лайков") || src.includes("самые заметные"),
      onlyScored: src.includes("view=") || src.includes("unscored"),
    }).toEqual({ coverage: true, wave: false, onlyScored: true });
  });

  test("У15: охват берётся из БД, а не из константы (в /api/meta есть размер каталога)", async () => {
    const { getMeta } = await import("../src/api/repos");
    const meta = getMeta(t.db) as unknown as { repos: Record<string, number> };
    expect(typeof meta.repos.catalog).toBe("number");
  });

  test("У16: карточка формально объясняет, что раздел содержит выбранные репозитории", () => {
    expect(srcOf("RepoPage.tsx")).toContain("Раздел «Избранное» содержит выбранные вами репозитории");
  });

  test("У17: находки AppSec показаны с разбивкой по движкам, SCA отдельной строкой", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ engines: src.includes("backlog.engines") || src.includes("enginesOf"), sca: src.includes("SCA") }).toEqual({ engines: true, sca: true });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» – тавтология,
// потому что незакрытые находки стоят под `test.failing`.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing – зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
