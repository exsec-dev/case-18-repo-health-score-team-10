// audit-v46r2-repro.test.ts — репро-трипваи КРУГА 2 вехи В4.6 (блок Б0).
// Закон круга: workers/V4.6-round2-oneshot.md (одноразовый) + раздел 13
// плана reports/2026-09-20-m46-ui-final-plan.md (контракты Р1-Р22) + раздел
// «Уточнения после аудит-пары» промпта, который при расхождении верен.
//
// Механика та же, что в audit-v46-repro.test.ts: находка стоит под обёрткой
// `repro` — в обычном прогоне это `test.failing` (набор зелёный), под
// AUDIT_STRICT=1 обычный `test`, то есть красный, пока находка не закрыта.
// Закрытая находка выходит из-под обёртки в закрывшем её блоке, утверждение
// при этом НЕ меняется. В конце файла — strict-самопроверка «ни одной находки
// под repro», иначе «зелёный строгий режим» был бы тавтологией.
//
// Круг 2 сознательно ОТМЕНЯЕТ часть решений круга 1 (окраска категорийных
// чисел в рейтинге, кнопка «Что делать», блок «О рейтинге», типографика
// числа индекса, текст подсказки поиска). Отмена решения владельцем — смена
// закона, а не ослабление: отменённые утверждения переворачиваются здесь
// (трипваи Т6, Т7, Т9) либо снимаются поимённо с записью в отчёт воркера.
//
// Живых запросов нет: MD — чистая функция от карточки на временной БД,
// UI-ветки — source-assert (приём tests/me.test.ts:151) или чистый хелпер.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const reportSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");

/**
 * Исходник БЕЗ комментариев — для утверждений «такого пользовательского слова
 * в интерфейсе больше нет». Иначе тест ловит собственную мотивировку правки
 * («слово «закрыто» заменено на «Недоступно»») и заставляет писать
 * комментарии загадками. Утверждение от этого становится СТРОЖЕ: оно говорит
 * о разметке, а не о файле.
 */
const codeOf = (file: string): string => stripComments(srcOf(file));

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/**
 * Кусок исходника между двумя якорями — чтобы утверждение говорило о нужной
 * функции, а не о файле. Закрывающий якорь ищется ПОСЛЕ открывающего: иначе
 * на повторяющихся тегах (`</DefinitionList.Item>`) срез уходил бы назад и
 * утверждение молча проверяло пустую строку.
 */
const between = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end < 0 ? undefined : end);
};

// ---------------------------------------------------------------------------
// Фикстура: одна карточка, два зрителя. Сырое значение подметрики (доля с 16
// знаками) взято ровно то, которое приёмка круга 1 нашла на первом экране.
// ---------------------------------------------------------------------------

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const repoId = seedRepo(t, { org: "v46r2", repo: "repro", title: "v46r2 repro", language: "Go", likes: 7, forks: 1, lastActivityAt: "2026-09-15T00:00:00Z" });
const scanId = seedScan(t, repoId, { status: "ok", trigger: "user", facts: cardFacts() });
seedScore(t, repoId, scanId, {
  total: 67,
  categories: { code: { score: 80, submetrics: { density: { score: 0.8, value: 0.8723404255319149 } } } },
});
seedRecommendation(t, scanId, {
  ruleId: "contributing-missing",
  priority: 1,
  problem: "Нет CONTRIBUTING – как вносить правки не описано",
  factRef: "docs.presence",
  deltaScore: 2.25,
  expectedImpact: "+2.3 к HealthCraft Index (по одному)",
});

/** Зритель с полным доступом: у него виден полный показатель и сырые значения подметрик. */
const mdOpen = (): string =>
  renderRepoReport(getRepoCard(t.db, "v46r2", "repro", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!);

/** Зритель без прав на каналы: CI/CD и Security приходят `locked` — на них живёт слово «закрыто». */
const mdLocked = (): string =>
  renderRepoReport(getRepoCard(t.db, "v46r2", "repro", { access: { cicd: "denied", appsec: "denied", repo: "granted" } })!);

// ---------------------------------------------------------------------------
// Т1 (Р15): затухание `.rh-fade::after` красило КОНТЕНТ карточки на 1366.
// Диагноз круга 2 (аудит-пара): `.rh-page__main` прокручивает себя только при
// ≥1440 и перестаёт под `@media (max-width: 1439px)` — значит на 1920
// затухание работало верно, а дефект жил на 1366. Правка круга 2 гасила
// псевдоэлемент тем же порогом 1439 и сохраняла класс со Shell.tsx.
// ОТМЕНЕНО круг 3, П1.13 (явное слово владельца «убрать затухание на всех
// экранах»): затухание снято целиком, поэтому утверждение ПЕРЕВЁРНУТО на
// отсутствие — ни CSS, ни разметка его больше не создают. Закрытый список
// отмен — reports/2026-09-20-m46r3-interactive-log.md.
// ---------------------------------------------------------------------------

describe("Р15 + П1.13: затухание полностью снято по решению владельца", () => {
  test("ни CSS, ни разметка больше не создают нижнее затухание", () => {
    const css = srcOf("layout.css");
    expect({
      fadeCss: css.includes("rh-fade"),
      tableFade: css.includes(".rh-table-fill .g-table__scroll-container::after"),
      fadeClass: srcOf("Shell.tsx").includes("rh-fade"),
    }).toEqual({ fadeCss: false, tableFade: false, fadeClass: false });
  });
});

// ---------------------------------------------------------------------------
// Т2 (Р14): «вес N% → вклад M%» стоит СТРОКОЙ, а не одной плашкой. Владелец
// просил одну серую плашку «Вклад M%» в стиле плашки «Здоров», прижатую к
// правому краю; тема плашки — `normal` (решение HQ), у категории без данных
// она несёт NOT_COUNTED («не учитывается»), а не «Вклад 0%».
// ---------------------------------------------------------------------------

describe("Р14: вклад категории — одна плашка, а не строка «вес → вклад»", () => {
  // ЗАКРЫТО блоком Б4 (карточка, категории) — обёртка снята, утверждение не менялось.
  test("CategoryRow: Label theme=\"normal\" со словом «Вклад», старой строки нет", () => {
    const row = between(codeOf("RepoPage.tsx"), "function CategoryRow", "function Markers");
    expect({
      plate: /<Label[\s\S]{0,200}rh-category__weight/.test(row) || /rh-category__weight[\s\S]{0,200}Вклад/.test(row),
      normalTheme: /theme="normal"/.test(row),
      oldWeightLine: /вес \{cat\.weight\}% → вклад/.test(row),
      notCountedFromFormat: row.includes("NOT_COUNTED"),
    }).toEqual({ plate: true, normalTheme: true, oldWeightLine: false, notCountedFromFormat: true });
  });
});

// ---------------------------------------------------------------------------
// Т3 (Р12, UI): пользовательское слово «закрыто» на карточке. Четыре
// пользовательских места назвал владелец: RepoPage.tsx:567,751 (UI, блок Б3)
// и markdown.ts:182,196 (отчёт, блок Б5) — поэтому трипвая ДВА, одним тестом
// обёртку не снять. Переименование меняет слово, не смысл: сведения об
// отсутствии доступа остаются (закон 2, ТЗ §3.4).
// ---------------------------------------------------------------------------

describe("Р12 (UI): «закрыто» → «Недоступно» на карточке", () => {
  // ЗАКРЫТО блоком Б3 (карточка, верх) — обёртка снята, утверждение не менялось.
  test("RepoPage: пользовательского слова «закрыто» нет, есть «Недоступно»", () => {
    const src = codeOf("RepoPage.tsx");
    expect({
      userWordClosed: />\s*закрыто\s*</.test(src),
      userWordUnavailable: />\s*Недоступно\s*</.test(src),
    }).toEqual({ userWordClosed: false, userWordUnavailable: true });
  });
});

// ---------------------------------------------------------------------------
// Т4 (Р12, MD): то же слово в отчёте. `markdown.ts:182` — это «закрыто
// доступом»; целевая строка ячейки «Статус» — «Недоступно» (без «доступом»),
// решение HQ после аудит-пары.
// ---------------------------------------------------------------------------

describe("Р12 (MD): «закрыто»/«закрыто доступом» → «Недоступно» в отчёте", () => {
  // ЗАКРЫТО блоком Б5 (тексты и язык) — обёртка снята, утверждение не менялось.
  test("таблица категорий и заголовки разбора говорят «Недоступно»", () => {
    const out = mdLocked();
    expect({
      statusCell: out.includes("| CI/CD | 15% | — | не учитывается | Недоступно |"),
      detailHeader: out.includes("### Security – Недоступно"),
      oldStatusCell: out.includes("закрыто доступом"),
      oldDetailHeader: /### [^\n]* – закрыто$/m.test(out),
    }).toEqual({ statusCell: true, detailHeader: true, oldStatusCell: false, oldDetailHeader: false });
  });
});

// ---------------------------------------------------------------------------
// Т5 (Р20): сырое значение факта в списке подметрик. «значение:
// 0.8723404255319149» стоит на ПЕРВОМ экране карточки (вариант А раскрывает
// худшую категорию) и в MD-таблице подметрик. Решение владельца: округляются
// ТОЛЬКО подметрики — доли до 2 знаков, целые без хвоста; поповер «Основание»
// остаётся сырым JSON, это доказательная база. Словарь единиц — не в этот круг.
// ---------------------------------------------------------------------------

describe("Р20: значения подметрик округлены, доказательная база остаётся сырой", () => {
  // ЗАКРЫТО блоком Б4 (карточка, категории) — обёртки сняты, утверждения не менялись.
  test("одна функция округления фактов на страницу и отчёт", async () => {
    const mod = (await import("../src/web/format")) as { roundFacts?: (v: unknown) => unknown };
    expect(typeof mod.roundFacts).toBe("function");
    expect(mod.roundFacts!(0.8723404255319149)).toBe(0.87);
    expect(mod.roundFacts!(8000)).toBe(8000);
    expect(mod.roundFacts!({ ratio: 0.8723404255319149, count: 47 })).toEqual({ ratio: 0.87, count: 47 });
  });

  test("MD: в таблице подметрик доля округлена, поповер доказательства — нет", () => {
    const out = mdOpen();
    const page = srcOf("RepoPage.tsx");
    expect({
      mdRounded: out.includes("| density | 80 | 0.87 |"),
      mdRaw: out.includes("0.8723404255319149"),
      pageUsesRounding: /значение: \{fmtFactValue\(roundFacts\(sub\.value\)\)\}/.test(page),
      proofStaysRaw: between(page, "function FactProof", "function factStatusText").includes("fmtFactValue(fact.value)"),
    }).toEqual({ mdRounded: true, mdRaw: false, pageUsesRounding: true, proofStaysRaw: true });
  });
});

// ---------------------------------------------------------------------------
// Т6 (Р13): кнопка «Что делать (N)» на месте. Решение владельца 20.09
// ОТМЕНЯЕТ решение круга 1 (закрытый трипвай `cta` круга 1 снят поимённо):
// следующий шаг остаётся кликабельным счётчиком «Рекомендаций: N» рядом со
// строкой итога. `summaryLine` остаётся общей со страницей и MD — резать её
// запрещено, поэтому счётчик рендерится ссылкой РЯДОМ, а не внутри строки.
// ---------------------------------------------------------------------------

describe("Р13 + П1.10: нижний ярус показателей полностью снят", () => {
  test("RepoPage: под показателями нет CTA, итогового текста и ссылки рекомендаций", () => {
    const src = codeOf("RepoPage.tsx");
    const band = between(src, "function ScoreBand", "function ScoreFigure");
    expect({
      cta: src.includes("Что делать"),
      counterLink: /Рекомендаций: \{card\.recommendations\.length\}/.test(band),
      summaryOnPage: band.includes("summaryLine"),
      reportStillUsesSummary: reportSrc().includes("summaryLine"),
    }).toEqual({ cta: false, counterLink: false, summaryOnPage: false, reportStillUsesSummary: true });
  });
});

// ---------------------------------------------------------------------------
// Т7 (Р4): категорийные числа В ТАБЛИЦЕ РЕЙТИНГА окрашены по scoreColor().
// Владелец снимает цветовую индикацию со всех категорийных колонок — это
// сознательная отмена находки ДП1 круга 1 (закрытый трипвай `colorsByTheme`
// снят поимённо). На КАРТОЧКЕ окраска остаётся (уточнение HQ по букве пункта
// «для остальных колонок»): там рядом с числом стоит полоса, она несёт цвет.
// Tri-state не двигается: `null` остаётся Label theme="unknown» со «н/д».
// ---------------------------------------------------------------------------

describe("Р4: цвет снят с категорийных чисел рейтинга, на карточке остаётся", () => {
  // ЗАКРЫТО блоком Б2 (строка рейтинга) — обёртка снята, утверждение не менялось.
  test("CategoryCell рейтинга без scoreColor(), CategoryRow карточки с ним", () => {
    const cell = codeOf("Rating.tsx").slice(codeOf("Rating.tsx").indexOf("function CategoryCell"));
    const row = between(codeOf("RepoPage.tsx"), "function CategoryRow", "function Markers");
    expect({
      ratingColored: /scoreColor\(/.test(cell),
      ratingNullStaysUnknown: /theme="unknown"/.test(cell),
      cardKeepsColor: /scoreColor\(/.test(row),
    }).toEqual({ ratingColored: false, ratingNullStaysUnknown: true, cardKeepsColor: true });
  });
});

// ---------------------------------------------------------------------------
// Т8 (Р10): пункт панели рейтинга называется «Свежесть». Владелец: «Частота»,
// значение «ежесуточно», пояснение про колонку «Скан». Метрика «Свежесть
// последнего коммита человека» (RepoPage.tsx) — другое понятие, не трогается.
// ---------------------------------------------------------------------------

describe("Р10: пункт «Свежесть» в панели рейтинга стал «Частота»", () => {
  // ЗАКРЫТО блоком Б1 (рейтинг) — обёртка снята, утверждение не менялось.
  test("Rating: name=\"Частота\" со значением «ежесуточно» и пояснением про «Скан»", () => {
    const src = srcOf("Rating.tsx");
    expect({
      oldName: src.includes('name="Свежесть"'),
      newName: src.includes('name="Частота"'),
      note: src.includes("Обход каталога выполняется ежесуточно"),
      submetricTitleKept: srcOf("RepoPage.tsx").includes("Свежесть последнего коммита человека"),
    }).toEqual({ oldName: false, newName: true, note: true, submetricTitleKept: true });
  });
});

// ---------------------------------------------------------------------------
// Т9 (Р7): блок «О рейтинге» стоит в правой панели. Владелец удаляет его
// целиком — нужное живёт в тексте над таблицей (Р5). Это отмена закрытого
// трипвая круга 1 (`aboutRating` как якорь «легенда первая»): якорь
// переезжает на следующий блок панели, утверждение «легенда первая» остаётся.
// ---------------------------------------------------------------------------

describe("Р7: блока «О рейтинге» в правой панели нет", () => {
  // ЗАКРЫТО блоком Б1 (рейтинг) — обёртка снята, утверждение не менялось.
  test("Rating: блок удалён, легенда по-прежнему первая в панели", () => {
    const src = codeOf("Rating.tsx");
    const legend = src.indexOf("<ScoreLegend ");
    const contribution = src.indexOf('title="Вклад категорий"');
    expect({
      aboutRating: src.includes("О рейтинге"),
      legendFirst: legend >= 0 && contribution >= 0 && legend < contribution,
    }).toEqual({ aboutRating: false, legendFirst: true });
  });
});

// ---------------------------------------------------------------------------
// Блок Б6 — Р15 закрыт трипваем Т1 выше; здесь второй случай того же
// диагноза: обёртка таблицы рейтинга тоже не прокручивает себя.
// ---------------------------------------------------------------------------

describe("Б6 (Р15) + П1.13: затухания нет ни на одной поверхности", () => {
  test("таблица сохраняет собственную прокрутку без псевдоэлемента затухания", () => {
    const css = srcOf("layout.css");
    expect({
      wrapperNotScrolling: /\.rh-fill__content:has\(> \.rh-table-fill\) \{[^}]*overflow: hidden/.test(css),
      tableEdge: /\.rh-table-fill \.g-table__scroll-container::after \{[^}]*position: sticky/.test(css),
    }).toEqual({ wrapperNotScrolling: true, tableEdge: false });
  });
});

// ---------------------------------------------------------------------------
// Блок Б5 — тексты и язык: Р18 (правило языка в заготовленных текстах
// рекомендаций и двух пользовательских строках API) и Р19 («Основание»).
// MD-часть Р12 закрыта трипваем Т4 выше.
// ---------------------------------------------------------------------------

describe("Б5 (Р18, Р19): правило языка в текстах движка и «Основание»", () => {
  const textOf = (rel: string): string => stripComments(readFileSync(join(import.meta.dir, "..", rel), "utf8"));

  test("Р18: в текстах рекомендаций нет длинного тире и нет «ё»", () => {
    const src = textOf("src/score/recommend.ts");
    expect({ emDash: src.includes("—"), yo: /[ёЁ]/.test(src) }).toEqual({ emDash: false, yo: false });
  });

  test("Р18: две названные пользовательские строки API — по правилу языка", async () => {
    const { CHANNEL_DELTA_HIDDEN_TEXT } = (await import("../src/api/repos")) as { CHANNEL_DELTA_HIDDEN_TEXT: string };
    expect(CHANNEL_DELTA_HIDDEN_TEXT).toBe("улучшит CI/CD – прирост Repo Health Score виден при доступе к CI и Security");
    expect(textOf("src/api/me.ts")).toContain("SourceCraft отклонил PAT – обновите токен в кабинете");
  });

  test("Р19: подпись фактов рекомендации — «Основание»", () => {
    const src = codeOf("RepoPage.tsx");
    expect({ newWord: src.includes("Основание:"), oldWord: src.includes("Основано на фактах") }).toEqual({ newWord: true, oldWord: false });
  });
});

// ---------------------------------------------------------------------------
// Блок Б4 — карточка, категории: Р14 (строка недоступных под списком; плашка
// вклада закрыта трипваем Т2), Р16 (контейнер табов), Р20 (закрыт Т5).
// ---------------------------------------------------------------------------

describe("Б4 (Р14, Р16): список категорий и контейнер табов", () => {
  test("Р14: закрытые категории не строки, а ОДНА строка под списком, с их конкретной причиной", () => {
    const src = codeOf("RepoPage.tsx");
    const categories = between(src, "function Categories", "function LockedCategories");
    const note = between(src, "function LockedCategories", "function CategoryRow");
    const row = between(src, "function CategoryRow", "function Markers");
    expect({
      rowsFiltered: /cat\.locked === undefined/.test(categories),
      noteAfterList: categories.indexOf("</ul>") < categories.indexOf("<LockedCategories"),
      namesActualCategories: note.includes("titles.join"),
      reasonFromAccessLock: /accessLockText\(cat\.locked\)/.test(categories),
      // фиксированная фраза «CI/CD и Security» была бы ложью при закрытой одной
      hardcodedPair: src.includes("CI/CD и Security – недоступны"),
      lockBranchGoneFromRow: /cat\.locked !== undefined/.test(row),
    }).toEqual({
      rowsFiltered: true,
      noteAfterList: true,
      namesActualCategories: true,
      reasonFromAccessLock: true,
      hardcodedPair: false,
      lockBranchGoneFromRow: false,
    });
  });

  test("Р14: строка склеивает категории по ПРИЧИНЕ и согласует число (одна — «недоступна»)", () => {
    const src = codeOf("RepoPage.tsx");
    const note = between(src, "function LockedCategories", "function CategoryRow");
    expect({
      groupsByReason: note.includes("groups.set(item.reason"),
      singular: note.includes('"недоступна"'),
      plural: note.includes('"недоступны"'),
      lastInList: /\.rh-locked-note \{[^}]*margin-top:\s*var\(--g-spacing-3\)/.test(srcOf("layout.css")),
    }).toEqual({ groupsByReason: true, singular: true, plural: true, lastInList: true });
  });

  test("Р14: отступ между шапкой коллапс-блока и раскрытым содержимым", () => {
    const css = srcOf("layout.css");
    const subrows = between(css, ".rh-subrows {", "}");
    expect(/padding: var\(--g-spacing-2\)/.test(subrows)).toBe(true);
  });

  test("Р16: табы и коллапс-блоки — в контейнере с границами, как блок величины", () => {
    const src = codeOf("RepoPage.tsx");
    const tabs = between(src, "function CardTabs", "function CardSlots");
    const css = srcOf("layout.css");
    expect({
      container: /<Card view="outlined" className="rh-tabs-card">/.test(tabs),
      sameAsBand:
        between(css, ".rh-tabs-card {", "}").includes("padding: var(--g-spacing-3) var(--g-spacing-4)") &&
        between(css, ".rh-score-band {", "}").includes("padding: var(--g-spacing-3) var(--g-spacing-4)"),
    }).toEqual({ container: true, sameAsBand: true });
  });
});

// ---------------------------------------------------------------------------
// Блок Б3 — карточка, верх: Р11 (мета-строка), Р12 (плашка, покрытие, замок,
// ссылка в кабинет), Р13 (пара подсказок вместо абзаца), Р17 (плашка модели),
// Р22 (размер звезды). Слово «Недоступно» и счётчик рекомендаций закрыты
// трипваями Т3 и Т6 выше.
// ---------------------------------------------------------------------------

describe("Б3 (Р11, Р12, Р13, Р17, Р22): верх карточки по замечаниям 11-13, 17 и Р22", () => {
  test("Р11: мета-строка серая, выровнена отступом сверху, без слова «активность»", () => {
    const meta = between(codeOf("ui.tsx"), "function MetaItem", "function SkeletonRows");
    const head = between(codeOf("RepoPage.tsx"), "function Header", "export const TAB_RECOMMENDATIONS");
    expect({
      grey: meta.includes('color="secondary"'),
      steelGone: meta.includes('color="misc"'),
      topGap: /\.rh-meta \{[^}]*margin-top: var\(--g-spacing-half\)/.test(srcOf("layout.css")),
      wordGone: head.includes("активность {fmtDate"),
      tooltipKept: head.includes('title="Последняя активность"'),
    }).toEqual({ grey: true, steelGone: false, topGap: true, wordGone: false, tooltipKept: true });
  });

  test("Р12: «Покрытие: N%», чип размера панели, мелкий текст замка и ссылка в кабинет на всех ветках", async () => {
    const src = codeOf("RepoPage.tsx");
    const figure = between(src, "function ScoreFigure", "// ---------- категории");
    const lock = between(src, "score.fullLocked ?", "function ScoreFigure");
    const { ACCESS_LOCK_TEXT } = (await import("../src/web/format")) as { ACCESS_LOCK_TEXT: Record<string, string> };
    expect({
      coverageWord: figure.includes("Покрытие: {fmtCoverage(coverage)}"),
      oldCoverageWord: figure.includes("данных хватило"),
      chipLikeAside: /scoreLabelTheme\(total\)\} size="s"/.test(figure),
      // мельче прежнего body-2, но всё ещё проза: правило 4а gravity-uikit.md
      lockTextSmaller: lock.includes("<FullLockMessage") && /function FullLockMessage[\s\S]{0,500}variant="body-1"/.test(src),
      buttonGone: lock.includes("Открыть личный кабинет"),
      linkInText: /linkProps\("\/settings"\)[\s\S]{0,80}>Настройках</.test(src),
      lockTextStillShared: Object.keys(ACCESS_LOCK_TEXT).sort().join(",") === "check-failed,denied,no-pat,pat-expired",
    }).toEqual({
      coverageWord: true,
      oldCoverageWord: false,
      chipLikeAside: true,
      lockTextSmaller: true,
      buttonGone: false,
      linkInText: true,
      lockTextStillShared: true,
    });
  });

  test("Р13: абзац про разницу снят, подсказки у ОБОИХ показателей называют отличие", () => {
    const src = codeOf("RepoPage.tsx");
    const band = between(src, "function ScoreBand", "function ScoreFigure");
    expect({
      paragraphGone: band.includes("Разницу с HealthCraft Index дают CI и Security:"),
      indexHelp: src.includes("Публичная оценка по 4 категориям") && src.includes("по ней и строится общий рейтинг"),
      fullHelp:
        src.includes("Repo Health Score рассчитывается по 6 категориям") &&
        src.includes("Показатель доступен только для репозиториев, к которым у вас есть доступ."),
      helpOnLockedBranch: /score\.fullLocked \?[\s\S]{0,1200}<HelpMark/.test(band),
      // MD-отчёт свою формулировку сохраняет: документ читается без наведения
      mdKeepsParagraph: reportSrc().includes("Разницу с HealthCraft Index дают CI и Security"),
    }).toEqual({ paragraphGone: false, indexHelp: true, fullHelp: true, helpOnLockedBranch: true, mdKeepsParagraph: true });
  });

  test("Р17/Р22: модель в плашке как в панели рейтинга, звезда одного размера с иконкой перехода", () => {
    const src = codeOf("RepoPage.tsx");
    const aside = between(src, "function ScoreAside", "function ScoreBand");
    const star = src.slice(src.indexOf("function FavoriteStar"));
    const link = between(src, "Открыть на sourcecraft.dev", "</ActionTooltip>");
    expect({
      modelPlate: /name="Модель"[\s\S]{0,200}<Label theme="normal" size="xs">/.test(aside),
      sameAsRating: /name="Модель"[\s\S]{0,200}<Label theme="normal" size="xs">/.test(codeOf("Rating.tsx")),
      starIcon14: /data=\{state === "on" \? StarFill : Star\} size=\{14\}/.test(star),
      linkIcon14: /data=\{ArrowUpRightFromSquare\} size=\{14\}/.test(link),
      // кнопки-обёртки совпадают по габариту: обе `size="s"`
      sameButtonSize: /<Button[\s\S]{0,200}size="s"/.test(star) && /<Button[\s\S]{0,200}size="s"/.test(link),
    }).toEqual({ modelPlate: true, sameAsRating: true, starIcon14: true, linkIcon14: true, sameButtonSize: true });
  });
});

// ---------------------------------------------------------------------------
// Блок Б2 — строка рейтинга: Р3 (лэйаут строки и типографика пары) и Р21
// (Select сортировки не режет своё значение). Р4 закрыт трипваем Т7 выше.
// ---------------------------------------------------------------------------

describe("Б2 (Р3, Р21): строка рейтинга и контрол сортировки", () => {
  test("Р3: в строке иконка, имя и НАЗВАНИЕ языка; скелетон держит ритм 56px", () => {
    const src = srcOf("Rating.tsx");
    const cell = between(src, "function RepoCell", "function buildColumns");
    expect({
      avatar: /RepoAvatar[\s\S]{0,120}size="m"/.test(cell),
      slugComponent: cell.includes("<RepoSlug"),
      languageName: cell.includes("<LanguageName"),
      dotOnly: cell.includes("<LanguageDot") || srcOf("ui.tsx").includes("LanguageDot"),
      skeletonRhythm: src.includes("<SkeletonRows rows={10} height={56} />"),
    }).toEqual({ avatar: true, slugComponent: true, languageName: true, dotOnly: false, skeletonRhythm: true });
  });

  test("Р3 + П1.1: число как в остальных колонках, окрашено; полоса снова читаемая", () => {
    const cell = between(codeOf("Rating.tsx"), "function ScoreCell", "function CategoryCell");
    const css = srcOf("layout.css");
    expect({
      normalNumber: !cell.includes('variant="body-3"') && !cell.includes('variant="subheader-3"'),
      boldNumberGone: cell.includes('variant="subheader-3"'),
      colouredNumber: cell.includes("scoreColor(item.healthcraftIndex)"),
      readableBar: /\.rh-score-cell__bar \.g-progress,[\s\S]{0,100}height:\s*8px/.test(css),
      tighterGap: /<Flex gap=\{0\} alignItems="center" justifyContent="flex-end">/.test(cell),
      widths:
        css.includes("flex: 0 0 80px") &&
        css.includes("min-width: 32px") &&
        css.includes("font-size: 14px") &&
        css.includes("font-weight: 600"),
    }).toEqual({ normalNumber: true, boldNumberGone: false, colouredNumber: true, readableBar: true, tighterGap: true, widths: true });
  });

  test("Р21: у Select сортировки нет ширины-обрезки — контрол берёт ширину по содержимому", () => {
    const src = codeOf("Rating.tsx");
    const sort = between(src, 'label="Сортировка:"', "/>");
    expect({ autoWidth: sort.includes('width="auto"'), oldFixedWidth: sort.includes("width={230}") }).toEqual({
      autoWidth: true,
      oldFixedWidth: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Блок Б1 — рейтинг: контракты Р1, Р2, Р5, Р6, Р8, Р9 (Р7 и Р10 закрыты
// трипваями Т9 и Т8 выше). Утверждения обычные, не трипваи: эти контракты
// пришли без репро-находки, они просто исполняются и закрепляются.
// ---------------------------------------------------------------------------

describe("Б1 (Р1, Р2, Р5, Р6, Р8, Р9): рейтинг по замечаниям владельца 1-2, 5-6, 8-9", () => {
  test("Р1/Р2: у иконки поиска отступ справа, текст подсказки — формулировка владельца", () => {
    const src = codeOf("Rating.tsx");
    const input = between(src, "<TextInput", "controlProps=");
    expect({
      iconGap: /data=\{Magnifier\}[\s\S]{0,260}marginInlineEnd/.test(input),
      hint: input.includes("Поиск по владельцу, репозиторию и заголовку"),
      oldHint: src.includes("регистр не важен"),
      placeholderKept: src.includes('placeholder="Поиск"'),
    }).toEqual({ iconGap: true, hint: true, oldHint: false, placeholderKept: true });
  });

  test("Р5: заголовок и ОДИН текст под ним; охват — числами из БД, не константой", () => {
    const src = codeOf("Rating.tsx");
    expect({
      title: src.includes('title="Рейтинг здоровья открытых репозиториев"'),
      oneLead: src.includes("description={ratingLead(meta)}"),
      oldSubheader: src.includes("а не число лайков"),
      secondParagraph: src.includes("<CoverageNote"),
      fromDb: /ratingLead[\s\S]{0,900}meta\.repos/.test(src),
      wave: src.includes("первыми идут самые заметные проекты"),
      concise: src.includes("из {fmtCount(catalog)} репозиториев"),
    }).toEqual({ title: true, oneLead: true, oldSubheader: false, secondParagraph: false, fromDb: true, wave: false, concise: true });
  });

  test("Р6: в числовых диапазонах дефис — шкала, MD-таблица подметрик, слот сравнения", async () => {
    const { SCORE_SCALE } = (await import("../src/web/format")) as { SCORE_SCALE: { range: string }[] };
    expect(SCORE_SCALE.map((s) => s.range)).toEqual(["70-100", "40-69", "0-39"]);
    expect(reportSrc()).toContain("Балл (0-100)");
    expect(srcOf("slots.ts")).toContain("2-3 репозиториев");
    // глиф «нет данных» (длинное тире) правилом не затронут — охранный пункт 1
    expect(reportSrc()).toContain('return "—"');
  });

  test("Р8: абзац под «Вклад категорий» снят, сведения — в подсказке у заголовка", () => {
    const src = srcOf("Rating.tsx");
    const section = between(src, 'title="Вклад категорий"', "</AsideSection>");
    expect({
      helpAtTitle: /help=\{[\s\S]{0,400}HelpMark/.test(section),
      keepsMeaning: section.includes("учитываются только в показателе Repo Health Score"),
      paragraphGone: !/<\/DefinitionList>[\s\S]{0,200}<Text/.test(section),
      asideSupportsHelp: srcOf("ui.tsx").includes("help?: ReactNode"),
    }).toEqual({ helpAtTitle: true, keepsMeaning: true, paragraphGone: true, asideSupportsHelp: true });
  });

  test("Р9: пояснение порога — формулировка владельца, число порога из БД на экране", () => {
    const src = codeOf("Rating.tsx");
    const item = between(src, 'name="Порог оценки"', "</DefinitionList.Item>");
    expect({
      note: item.includes("Оценка рассчитывается только при достаточном покрытии. Недостающие категории исключаются из расчета"),
      oldNote: src.includes("Score не выставляется, а не занижается"),
      numberFromDb: item.includes("fmtCoverage(meta.coverageNullBelow)"),
    }).toEqual({ note: true, oldNote: false, numberFromDb: true });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима (образец audit-v46-repro.test.ts:467-473):
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
