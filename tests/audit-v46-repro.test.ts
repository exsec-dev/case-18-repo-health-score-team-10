// audit-v46-repro.test.ts — репро-трипваи вехи В4.6 «UI-финал» (блок Б0).
// Закон вехи: workers/V4.6-oneshot.md (одноразовый) + синтез дизайн-пары
// reports/2026-09-20-ui-design-pair-synthesis.md (8 корней, охранный список
// из 10 пунктов) + палитровый раунд
// reports/2026-09-20-ui-card-layout-and-palette-round.md (25 токенов с
// посчитанными контрастами).
//
// Механика (как в audit-m42a-r2-repro.test.ts): каждая находка стоит под
// обёрткой `repro` — в обычном прогоне это `test.failing` (набор зелёный,
// красноты в CI нет), под AUDIT_STRICT=1 — обычный `test`, то есть красный,
// пока находка не закрыта. Закрытая находка выходит из-под обёртки в том
// блоке, который её закрыл; сами утверждения при этом не меняются.
// В конце файла — strict-самопроверка «ни одной находки не осталось под
// repro», иначе «зелёный строгий режим» был бы тавтологией.
//
// Живых запросов нет: MD — чистая функция от карточки на временной БД,
// UI-ветки — source-assert (приём tests/me.test.ts:151), палитра —
// арифметика WCAG по src/web/theme.css (tests/theme-contrast.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { contrast, flatten, pageBackground, parseColor, progressFill, progressTrack, themeTokens } from "./theme-contrast";

/**
 * Импорт модуля, которого на Б0-коммите ЕЩЁ НЕТ: путь — переменная, чтобы
 * `tsc` не падал на отсутствующем файле (репро обязано быть красным тестом,
 * а не красной типизацией — иначе Б0-коммит не соберётся и приёмка «честно
 * красного дерева» станет невозможной).
 */
const importLater = async (path: string): Promise<Record<string, unknown>> => (await import(path)) as Record<string, unknown>;

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const reportSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");

// ---------------------------------------------------------------------------
// Общая фикстура MD: карточка со ЗАКРЫТОЙ (Security без данных) категорией —
// именно на ней живёт «вклад 0%» (находка В4.6-2) и словесная шкала итога.
// ---------------------------------------------------------------------------

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const repoId = seedRepo(t, { org: "v46", repo: "repro", title: "v46 repro", language: "Go", likes: 7, forks: 1, lastActivityAt: "2026-09-15T00:00:00Z" });
const scanId = seedScan(t, repoId, { status: "partial", trigger: "user", facts: cardFacts() });
seedScore(t, repoId, scanId, { total: 67 });
seedRecommendation(t, scanId, {
  ruleId: "contributing-missing",
  priority: 1,
  problem: "Нет CONTRIBUTING — как вносить правки не описано",
  factRef: "docs.presence",
  deltaScore: 2.25,
  expectedImpact: "+2.3 к HealthCraft Index (по одному)",
});
const md = (): string => renderRepoReport(getRepoCard(t.db, "v46", "repro", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!);

// ---------------------------------------------------------------------------
// В4.6-1 (ДП1 / У20): категорийные числа рейтинга не кодируют качество.
// 26 и 98 набраны одним цветом, а `null` — бледное тире, то есть «плохо» и
// «нет данных» глазом не различить. Требование: цвет числа по scoreTheme()
// (success ≥70 — решение владельца 20.09 «красим»), `null` — Label
// theme="unknown", НИКОГДА не красный и не ноль (охранный пункт 1).
// ---------------------------------------------------------------------------

describe("В4.6-1 (У20): качество категорий закодировано в рейтинге и на карточке", () => {
  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("рейтинг: число категории окрашено по scoreTheme(), null — Label theme=\"unknown\"", () => {
    const src = srcOf("Rating.tsx");
    const cell = src.slice(src.indexOf("function CategoryCell"));
    expect({
      // Круг 2 (Р4): утверждение `colorsByTheme` СНЯТО — владелец отменила
      // цветовую индикацию категорийных колонок рейтинга, и обратное
      // утверждение живёт в tests/audit-v46r2-repro.test.ts (трипвай Т7).
      // Tri-state-половина находки остаётся здесь в полной силе.
      nullIsUnknownLabel: /theme="unknown"/.test(cell),
      nullIsNotBareDash: !/>\s*—\s*</.test(cell),
    }).toEqual({ nullIsUnknownLabel: true, nullIsNotBareDash: true });
  });

  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("карточка: число категории окрашено теми же порогами, «нет данных» остаётся нейтральным", () => {
    const src = srcOf("RepoPage.tsx");
    const row = src.slice(src.indexOf("function CategoryRow"), src.indexOf("// ---------- маркеры расчёта"));
    expect({
      valueColored: /rh-category__value[\s\S]{0,400}scoreColor|scoreColor[\s\S]{0,400}rh-category__value/.test(row),
      noDataNeutral: /theme="unknown"/.test(row),
    }).toEqual({ valueColored: true, noDataNeutral: true });
  });
});

// ---------------------------------------------------------------------------
// В4.6-2 (ДП6 / У25): «вклад 0%» у закрытых и пустых категорий — единственное
// место, где продукт своими руками опровергает собственный tri-state
// (категория «дала ноль» вместо «не учитывается»).
// ---------------------------------------------------------------------------

describe("В4.6-2 (У25): «вклад 0%» заменён на «не учитывается»", () => {
  // ЗАКРЫТО блоком Б6 (вариант А компоновки карточки).
  // Круг 2 (Р14): литерал «не учитывается» на карточке стоял ТОЛЬКО в
  // комментарии к правке круга 1 — сам текст всегда приходил из константы
  // `NOT_COUNTED` (src/web/format.ts). Р14 переписал этот комментарий, и
  // утверждение покраснело по ложной причине; оно переведено на константу,
  // то есть проверяет ровно то же и уже не зависит от прозы комментариев.
  test("карточка: у категории без данных вклад не печатается нулём", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ hasHonestWording: src.includes("NOT_COUNTED"), printsZeroContribution: /вклад \{contribution\}%/.test(src) }).toEqual({
      hasHonestWording: true,
      printsZeroContribution: false,
    });
  });

  // ЗАКРЫТО блоком Б6 (вариант А компоновки карточки).
  test("MD: в таблице категорий у Security стоит «не учитывается», а не «0%»", () => {
    const out = md();
    expect({ honest: out.includes("| Security | 20% | — | не учитывается |"), zero: out.includes("| 0% |") }).toEqual({
      honest: true,
      zero: false,
    });
  });
});

// ---------------------------------------------------------------------------
// В4.6-3 (ДП3 / У22): у числа нет шкалы. scoreTheme() (src/web/format.ts)
// уже делит ≥70 / 40–69 / <40 и называет полосы словами В КОММЕНТАРИИ кода,
// но на экране словесной шкалы нет ни на карточке, ни в строке итога MD.
// ---------------------------------------------------------------------------

describe("В4.6-3 (У22): словесная шкала здоровья видна на карточке и в MD", () => {
  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("format.ts отдаёт слово шкалы чистой функцией (одна копия на страницу и отчёт)", async () => {
    const { scoreWord } = (await import("../src/web/format")) as { scoreWord?: (v: number | null) => string };
    expect(typeof scoreWord).toBe("function");
    expect([scoreWord!(83), scoreWord!(55), scoreWord!(12)]).toEqual(["здоров", "есть над чем работать", "запущен"]);
  });

  // Б2: фраза легенды живёт в ОДНОМ месте (format.ts SCORE_LEGEND_TITLE) и
  // рисуется общим компонентом ui.tsx/ScoreLegend — литерал в каждой странице
  // означал бы две копии одной формулировки. Проверяется тот же факт: шкала
  // видна на обоих экранах, и заголовок у неё один.
  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("легенда шкалы — один компонент с одним заголовком «Как читать оценку»", () => {
    const ui = srcOf("ui.tsx");
    expect({
      component: ui.includes("export function ScoreLegend"),
      titleFromFormat: ui.includes("SCORE_LEGEND_TITLE"),
      oneHome: srcOf("format.ts").includes('SCORE_LEGEND_TITLE = "Как читать оценку"'),
    }).toEqual({ component: true, titleFromFormat: true, oneHome: true });
  });

  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("карточка: Label со словом шкалы у числа плюс блок легенды в методике", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ importsWord: src.includes("scoreWord"), legend: src.includes("<ScoreLegend />") }).toEqual({ importsWord: true, legend: true });
  });

  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  // Круг 2 (Р7): блок «О рейтинге» удалён владельцем, поэтому якорь «что
  // стоит после легенды» переехал на следующий блок панели — «Вклад
  // категорий». Утверждение то же: легенда открывает панель.
  test("рейтинг: легенда — первым блоком правой панели", () => {
    const src = srcOf("Rating.tsx");
    const legend = src.indexOf("<ScoreLegend />");
    const nextSection = src.indexOf('title="Вклад категорий"');
    expect({ hasLegend: legend >= 0, isFirst: legend >= 0 && nextSection >= 0 && legend < nextSection }).toEqual({ hasLegend: true, isFirst: true });
  });

  // ЗАКРЫТО блоком Б2 (шкала и кодирование).
  test("MD: строка итога называет то же слово шкалы", () => {
    const out = md();
    expect(/\*\*HealthCraft Index \(4 категории\): 67 из 100[^\n]*есть над чем работать/.test(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// В4.6-4 (ДП5 / У24 + У37): методическая проза набрана `color="secondary"`,
// контраст которого ниже AA 4.5:1 в ОБЕИХ темах по значениям theme.css
// (тёмная 4,40:1 — ДП5 цитирует 4,39 округлением своего инструмента;
// светлая 3,98:1). Порог проверяется расчётом: снимков светлой темы владелец
// сознательно не заказывал (решение 20.09).
// ---------------------------------------------------------------------------

describe("В4.6-4 (У24/У37): проза color=\"secondary\" берёт AA в обеих темах", () => {
  const secondaryContrast = (theme: "dark" | "light"): number => {
    const tokens = themeTokens(theme);
    const bg = parseColor(pageBackground(tokens));
    return contrast(flatten([bg, tokens.get("--g-color-text-secondary")!]), bg);
  };

  // ЗАКРЫТО блоком Б1 (палитра): обёртка снята, утверждение не менялось.
  test("тёмная тема: --g-color-text-secondary ≥ 4.5:1 (было 4.4:1)", () => {
    expect(secondaryContrast("dark")).toBeGreaterThanOrEqual(4.5);
  });

  // ЗАКРЫТО блоком Б1.
  test("светлая тема: --g-color-text-secondary ≥ 4.5:1 (было 3.98:1)", () => {
    expect(secondaryContrast("light")).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// В4.6-5 (замечание владельца 14 / У37): `Progress` заливает полосу токеном
// `--g-color-base-*-medium`, а в нашей палитре это ПОЛУПРОЗРАЧНЫЕ значения
// (0.5 в тёмной — theme.css:77; .3/.7 в светлой — theme.css:215,231). Полоса
// смешивается с дорожкой и «сливается с серым»: зелёный 1,95:1, красный
// 1,46:1. Проверяются ОБЕ темы и все четыре тона, а не одно значение.
// ---------------------------------------------------------------------------

describe("В4.6-5 (У37): заливка полос непрозрачна и берёт 3:1 к дорожке в обеих темах", () => {
  const TONES = ["positive", "warning", "danger", "misc"] as const;

  for (const theme of ["dark", "light"] as const) {
    // ЗАКРЫТО блоком Б1.
    test(`${theme === "dark" ? "тёмная" : "светлая"} тема: base-*-medium без альфы`, () => {
      const tokens = themeTokens(theme);
      const withAlpha = TONES.filter((tone) => parseColor(tokens.get(`--g-color-base-${tone}-medium`)!).a < 1);
      expect(withAlpha).toEqual([]);
    });

    // ЗАКРЫТО блоком Б1.
    test(`${theme === "dark" ? "тёмная" : "светлая"} тема: каждая заливка ≥ 3:1 к дорожке Progress`, () => {
      const tokens = themeTokens(theme);
      const track = progressTrack(tokens);
      const below = TONES.filter((tone) => contrast(progressFill(tokens, tone), track) < 3);
      expect(below).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// В4.6-6 (замечание владельца 2 / У21): колонка индекса — полоса 64×4px под
// числом `subheader-2` (шаг к соседям 1,15 вне вилки 1,2–1,33), 0,64px на
// балл. Требование: полоса 80×10px слева, число `subheader-3` в фиксированном
// слоте справа, `tabular-nums`; `perPage` 20 и опция 20 в pageSizeOptions.
// ---------------------------------------------------------------------------

describe("В4.6-6 (У21): колонка индекса — горизонтально, число справа", () => {
  // ЗАКРЫТО блоком Б3 (колонка индекса и уплотнение строки).
  test("ScoreCell: полоса 80px слева, число subheader-3 в слоте справа", () => {
    const src = srcOf("Rating.tsx");
    const cell = src.slice(src.indexOf("function ScoreCell"), src.indexOf("function CategoryCell"));
    expect({
      horizontal: !/direction="column"/.test(cell),
      bar80: cell.includes("width: 80"),
      // Круг 2 (Р3): утверждение `subheader3` СНЯТО — владелец попросила у
      // числа меньше жирности, и набор выбирает соседний шаг шкалы
      // (`body-3`). Ширины пары НЕ пересчитываются, поэтому `bar80` и слот
      // числа остаются проверяемыми здесь.
      slot: cell.includes("rh-score-cell__num"),
      noOldBar: !cell.includes("width: 64"),
    }).toEqual({ horizontal: true, bar80: true, slot: true, noOldBar: true });
  });

  // ЗАКРЫТО блоком Б3 (колонка индекса и уплотнение строки).
  test("дефолт страницы 20 и опция 20 в pageSizeOptions (иначе к дефолту не вернуться)", async () => {
    const { DEFAULT_QUERY } = await import("../src/api/repos");
    expect(DEFAULT_QUERY.perPage).toBe(20);
    expect(srcOf("Rating.tsx")).toContain("[10, 20, 50, 100]");
  });
});

// ---------------------------------------------------------------------------
// В4.6-7 (ДП4 / У23 + решение владельца (iii) 20.09): у сетки нет границ с
// двух сторон. Порог правой панели рейтинга — 1280 (на 1366 колонка «Code
// health» режется), полоса категории растянута `1fr` (на 1920 — 840px и
// перестаёт быть мерой), у основной колонки нет меры. Карточка Drawer не
// умеет (asideInDrawer гейтится mode==="fill", Shell.tsx:399) — ей правится
// CSS-порог 1279 → 1439.
// ---------------------------------------------------------------------------

describe("В4.6-7 (У23): границы сетки и разрешения", () => {
  const layout = (): string => srcOf("layout.css");

  // ЗАКРЫТО блоком Б4 (границы сетки и разрешения).
  test("рейтинг: JS-порог правой панели — 1440 (на ровно 1440 панель остаётся)", () => {
    expect(srcOf("Shell.tsx")).toContain('useMediaQuery("(min-width: 1440px)")');
  });

  // ЗАКРЫТО блоком Б4 (границы сетки и разрешения).
  test("карточка: CSS-порог укладки колонок — 1439, панель на 1366 уходит под основную", () => {
    expect(layout()).toContain("@media (max-width: 1439px)");
  });

  // ЗАКРЫТО блоком Б4 (границы сетки и разрешения).
  test("полоса категории ограничена мерой minmax(80px, 360px), а не 1fr", () => {
    const css = layout();
    expect({ hasMeasure: css.includes("minmax(80px, 360px)"), stretches: css.includes("minmax(80px, 1fr)") }).toEqual({
      hasMeasure: true,
      stretches: false,
    });
  });

  // ЗАКРЫТО блоком Б4 (границы сетки и разрешения).
  test("у основной колонки есть мера, у прокручиваемых кромок — затухание", () => {
    const css = layout();
    expect({ measure: /\.rh-page__main[\s\S]{0,200}max-width/.test(css), fade: css.includes("rh-fade") }).toEqual({ measure: true, fade: true });
  });
});

// ---------------------------------------------------------------------------
// В4.6-8 (ДП7 / У26 + У13, вариант А компоновки — решение владельца 20.09):
// главную колонку карточки занимают номинальные веса, величина уехала в
// правую панель (x = 80% ширины окна), следующий шаг спрятан за вторым табом,
// состояние таба не в URL. Шов строки итога назван аудит-парой: генератор
// фразы живёт в src/web/format.ts, markdown.ts его вызывает (импорт
// src/report в клиент валит Bun.build — живой тест tests/web.test.ts:9).
// ---------------------------------------------------------------------------

describe("В4.6-8 (У26/У13/У38): вариант А — карточка начинается с вывода", () => {
  // ЗАКРЫТО блоком Б6 (вариант А компоновки карточки).
  test("генератор строки итога — чистая функция src/web/format.ts, MD её вызывает", async () => {
    const mod = (await import("../src/web/format")) as { summaryLine?: unknown };
    expect(typeof mod.summaryLine).toBe("function");
    expect(reportSrc()).toContain("summaryLine");
  });

  // Б6: проверяется ПОРЯДОК РЕНДЕРА, а не порядок объявления функций в файле.
  // Первый вариант ассерта сравнивал позиции `rh-score-band` и
  // `function ScoreAside` в исходнике — это мерило ничего не говорит о том,
  // где блок оказывается на экране: `Page` берёт панель пропом `aside` и
  // рендерит `main`, потом `aside`, поэтому «полоса раньше панели» = «полоса
  // лежит среди детей Page». Заодно проверяется, что панель стала
  // МЕТОДИЧЕСКОЙ по составу, а не просто лишилась числа.
  // ЗАКРЫТО блоком Б6 (вариант А компоновки карточки).
  test("величина — блоком в главной колонке, правая панель чисто методическая", () => {
    const src = srcOf("RepoPage.tsx");
    const pageOpen = src.indexOf("<Page crumbs={crumbs} actions={actions}");
    const bandMount = src.indexOf("<ScoreBand card={card}");
    const asideBody = src.slice(src.indexOf("function ScoreAside"), src.indexOf("function ScoreBand"));
    expect({
      bandIsMainChild: pageOpen >= 0 && bandMount > pageOpen,
      bandHasOwnClass: src.includes('className="rh-score-band"'),
      asideKeepsFigure: /display-2/.test(asideBody),
      asideIsMethodOnly: asideBody.includes("<ScoreLegend />") && asideBody.includes("Реквизиты расчета"),
    }).toEqual({ bandIsMainChild: true, bandHasOwnClass: true, asideKeepsFigure: false, asideIsMethodOnly: true });
  });

  // ЗАКРЫТО блоком Б6 (вариант А компоновки карточки).
  test("строка итога и кнопка «Что делать (N)» — над табами; таб в query", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ cta: src.includes("Что делать"), tabInQuery: src.includes("?tab=") || src.includes('"tab"'), worstOpen: src.includes("worstKey") }).toEqual({
      cta: true,
      tabInQuery: true,
      worstOpen: true,
    });
  });
});

// ---------------------------------------------------------------------------
// В4.6-9 (ДП8 / У27–У32): консистентность и мелкие замечания владельца.
// Звезда — юникодный глиф ★/☆ вместо иконки из @gravity-ui/icons (нарушение
// правила 3а docs/ui/gravity-uikit.md); плейсхолдер поиска называет поля
// вместо действия; опция сортировки «Имя (org/repo)» — жаргон.
// Область — всё, КРОМЕ MePage.tsx (кабинет отдан вехе В4.7, П3.4).
// ---------------------------------------------------------------------------

describe("В4.6-9 (У27–У32): консистентность вне кабинета", () => {
  // ЗАКРЫТО блоком Б7 (консистентность и мелкие замечания владельца).
  test("У32: звезда избранного — иконка @gravity-ui/icons, не глиф ★/☆", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ glyph: src.includes("★") || src.includes("☆"), icon: /Star/.test(src) }).toEqual({ glyph: false, icon: true });
  });

  // ЗАКРЫТО блоком Б7 (консистентность и мелкие замечания владельца).
  test("У29: плейсхолдер «Поиск» плюс подсказка о полях поиска", () => {
    const src = srcOf("Rating.tsx");
    expect({
      placeholder: src.includes('placeholder="Поиск"'),
      oldPlaceholder: src.includes('placeholder="org, repo или название"'),
      // Круг 2 (Р2): формулировка подсказки задана владельцем дословно
      hint: src.includes("Поиск по владельцу, имени репозитория и названию"),
    }).toEqual({ placeholder: true, oldPlaceholder: false, hint: true });
  });

  // ЗАКРЫТО блоком Б7 (консистентность и мелкие замечания владельца).
  test("У30: опция сортировки «Название» вместо «Имя (org/repo)»", () => {
    const src = srcOf("Rating.tsx");
    expect({ plain: src.includes('content: "Название"'), jargon: src.includes("Имя (org/repo)") }).toEqual({ plain: true, jargon: false });
  });

  // Б7: имя класса в ассерте было взято на слух. AsideHeader 6.6.0 рисует
  // линию под шапкой rail псевдоэлементами блока `gn-aside-header__header`
  // (`::after` в широком режиме, `::before` в узком), а класса
  // `gn-aside-header__divider` в пакете нет вовсе — проверяется тот же факт
  // по настоящему имени, а не ослабляется.
  // ЗАКРЫТО блоком Б7 (консистентность и мелкие замечания владельца).
  test("У28: разделительной линии между лого и меню в rail нет", () => {
    const css = srcOf("layout.css");
    expect({
      afterHidden: css.includes('.rh-rail [class*="gn-aside-header__header"]::after'),
      beforeHidden: css.includes('.rh-rail [class*="gn-aside-header__header"]::before'),
    }).toEqual({ afterHidden: true, beforeHidden: true });
  });
});

// ---------------------------------------------------------------------------
// В4.6-10 (У18): слоты под В5 — видимые места с honest-состоянием «пока нет
// данных», без выдуманных чисел и без мёртвых кнопок. Имена полей и форма
// ступени оп-ина — из спеки В5 (К5.4 AI-summary, К5.7 история Score,
// К5.8 badge, К5.15 сравнение). Для сравнения слот = контракт полей и пустое
// состояние В КОДЕ, без маршрута и без пункта rail.
// ---------------------------------------------------------------------------

describe("В4.6-10 (У18): слоты под В5 заложены честными состояниями", () => {
  // ЗАКРЫТО блоком Б8 (слоты под В5).
  test("слоты AI-summary, истории Score и badge видны с состоянием «пока нет данных»", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ ai: src.includes("aiSummary"), history: src.includes("scoreHistory"), badge: src.includes("badge") }).toEqual({
      ai: true,
      history: true,
      badge: true,
    });
  });

  // ЗАКРЫТО блоком Б8 (слоты под В5).
  test("контракты полей слотов совпадают со спекой В5 по именам", async () => {
    const mod = await importLater("../src/web/slots");
    const contracts = mod.SLOT_CONTRACTS as Record<string, readonly string[]> | undefined;
    expect(Object.keys(contracts ?? {}).sort()).toEqual(["aiSummary", "badge", "compare", "scoreHistory"]);
  });

  // ЗАКРЫТО блоком Б8 (слоты под В5).
  test("сравнение: контракт и пустое состояние есть, маршрута и пункта rail нет", async () => {
    const mod = await importLater("../src/web/slots");
    const contracts = mod.SLOT_CONTRACTS as Record<string, readonly string[]> | undefined;
    const shell = srcOf("Shell.tsx");
    const router = srcOf("router.ts");
    expect({
      contract: (contracts?.compare ?? []).length > 0,
      noRailItem: !shell.includes("Сравнение"),
      noRoute: !router.includes("compare"),
    }).toEqual({ contract: true, noRailItem: true, noRoute: true });
  });
});

// ---------------------------------------------------------------------------
// В4.6-11 (У15/У16/У17 — возвращены в веху решением владельца 20.09): охват
// каталога, граница доступа «моих репозиториев» и движки AppSec.
// ---------------------------------------------------------------------------

describe("В4.6-11 (У15/У16/У17): охват, границы доступа, движки AppSec", () => {
  // ЗАКРЫТО блоком Б9 (охват, границы доступа, движки AppSec).
  test("У15: рейтинг называет охват числами из БД и стратегию первой волны", () => {
    const src = srcOf("Rating.tsx");
    expect({
      coverage: /оценено/i.test(src),
      wave: src.includes("по убыванию лайков") || src.includes("самые заметные"),
      onlyScored: src.includes("view=") || src.includes("unscored"),
    }).toEqual({ coverage: true, wave: true, onlyScored: true });
  });

  // ЗАКРЫТО блоком Б9 (охват, границы доступа, движки AppSec).
  test("У15: охват берётся из БД, а не из константы (в /api/meta есть размер каталога)", async () => {
    const { getMeta } = await import("../src/api/repos");
    const meta = getMeta(t.db) as unknown as { repos: Record<string, number> };
    expect(typeof meta.repos.catalog).toBe("number");
  });

  // ЗАКРЫТО блоком Б9 (охват, границы доступа, движки AppSec).
  test("У16: карточка объясняет, что «мои репозитории» — избранное, а не автоперечисление", () => {
    expect(srcOf("RepoPage.tsx")).toContain("это избранное, а не автоматический список");
  });

  // ЗАКРЫТО блоком Б9 (охват, границы доступа, движки AppSec).
  test("У17: находки AppSec показаны с разбивкой по движкам, SCA отдельной строкой", () => {
    const src = srcOf("RepoPage.tsx");
    expect({ engines: src.includes("backlog.engines") || src.includes("enginesOf"), sca: src.includes("SCA") }).toEqual({ engines: true, sca: true });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима (образец audit-m42a-r2-repro.test.ts:595-601):
// без неё «AUDIT_STRICT=1 зелёный» — тавтология, потому что незакрытые
// находки стоят под `test.failing`. На Б0-коммите этот тест красный вместе
// с ними.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
