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
import { buildReportModel } from "../src/report/build";
import { fixtureCard } from "./report-fixtures";

/**
 * Круг 4 гейта: первый экран отчета несет плашку зоны. Проверка переведена с
 * поиска строки в исходнике на МОДЕЛЬ отчета — источник переименовался
 * (показателей в ряду стало два), а утверждение то же и проверяется по данным.
 */
function reportHeroHasChip(): boolean {
  const { card, close } = fixtureCard("full");
  try {
    const hero = buildReportModel(card).blocks.find((b) => b.kind === "hero");
    return hero?.kind === "hero" && hero.chip !== null && hero.chip.text.length > 0;
  } finally {
    close();
  }
}


const repro = process.env.AUDIT_STRICT ? test : test.failing;

const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const reportSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");
const buildSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "build.ts"), "utf8");

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
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А4: чип «Вклад N%» снят — Г2.1, §2 23.09
  // «выбор по вариантам» п.2): у строки категории нет ни плашки вклада, ни
  // строки «вес → вклад», ни «не учитывается»; вклад — полосой под числами (А3).
  test("CategoryRow: плашки «Вклад» нет, старой строки нет, «не учитывается» нет", () => {
    const row = between(codeOf("RepoPage.tsx"), "function CategoryRow", "function Markers");
    expect({
      plate: /rh-category__weight/.test(row) || /Вклад \$\{/.test(row),
      normalTheme: /theme="normal"/.test(row),
      oldWeightLine: /вес \{cat\.weight\}% → вклад/.test(row),
      notCountedFromFormat: row.includes("NOT_COUNTED"),
      contributionUnderFigures: /<ContributionStrip/.test(between(codeOf("RepoPage.tsx"), "function ScoreBand", "function ContributionStrip")),
    }).toEqual({ plate: false, normalTheme: false, oldWeightLine: false, notCountedFromFormat: false, contributionUnderFigures: true });
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
      // закрытый показатель назван фразой, а не одним словом (решение владельца
      // 21.09); «недоступны» оставалось только в плашке CI — ее переписал UX-проход В5.2
      // 25.09 (замечание 8, без жаргона), поэтому проверяется одна фраза показателя
      userWordUnavailable: src.includes("Виден участникам репозитория"),
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
    // В4.9 (К9.13, круг 2 эталона): закрытая категория — плашка «Нет данных» и фраза по причине
    // доступа, одна на карточке и в отчете; «Недоступно» заменено этим словом с заменой ассерта
    expect({
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): В-9 — закрытая категория в отчете «недоступно», не «нет данных»
      statusCell: out.includes("| CI/CD | — | недоступно | У вашего токена нет прав на эти данные репозитория. |"),
      detailHeader: out.includes("### Безопасность – недоступно"),
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
      // В4.7 (Б7, П4.2): строка — русское название и единица словаря; доля по-прежнему округлена
      // В4.9 (К9.6): колонки разбора «Показатель | Значение | Балл | Вес» (эталон вида)
      // В4.9 (К9.11): десятичная запятая
      mdRounded: out.includes("| Плотность TODO/FIXME в коде | 0,87 на 1 тыс. строк | 80 | 35% |"),
      mdRaw: out.includes("0.8723404255319149"),
      // слово «значение» из строки убрано (доводка 21.09) и живёт в подсказке;
      // утверждение о САМОМ округлении не менялось
      // В4.7 (Б7, П4.2): страница берет значение из словаря подметрик (округление — внутри него)
      // В4.9 (К9.9): значение — `submetricShownValue` (словарь + слова заметки вместо «—»)
      // Г1.9 гейта: пятым доводом идут соседние подметрики (прочерк доли старых TODO при нуле пометок)
      pageUsesRounding: /\{submetricShownValue\(key, subKey, sub, submetricContext\(card\.score\?\.computedAt\), cat\.submetrics\)\}/.test(page),
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
      // В4.9 (К9.1) вердикт первого экрана заменил строку итога; гейт 22.09 (В3)
      // убрал и его: вывод отчета — крупное число с плашкой зоны.
      reportHasChip: reportHeroHasChip(),
    }).toEqual({ cta: false, counterLink: false, summaryOnPage: false, reportHasChip: true });
  });
});

// ---------------------------------------------------------------------------
// Т7 (Р4): круг 3, П3/1 явно ОТМЕНЯЕТ запрет цветовой индикации круга 2.
// Новый контракт выделяет только исключения: >=70 остаётся нейтральным
// текстом, 40-69 и <40 получают семантический Label. На карточке прежняя
// окраска сохраняется. Tri-state не двигается: `null` остаётся Label
// theme="unknown» со «н/д».
// ---------------------------------------------------------------------------

describe("П3/1 отменяет Р4: в рейтинге подсвечены только исключения", () => {
  test("CategoryCell разделяет >=70, исключения и null; CategoryRow сохраняет цвет", () => {
    const cell = codeOf("Rating.tsx").slice(codeOf("Rating.tsx").indexOf("function CategoryCell"));
    const row = between(codeOf("RepoPage.tsx"), "function CategoryRow", "function Markers");
    expect({
      healthyPlain: /scoreTheme\(value\) === "success"[\s\S]{0,300}rh-cat-plain/.test(cell),
      exceptionsLabeled: /scoreLabelTheme\(value\)[\s\S]{0,100}rh-cat-chip/.test(cell),
      ratingInlineColor: /scoreColor\(/.test(cell),
      ratingNullStaysUnknown: /theme="unknown"/.test(cell),
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А4 / U2-a): на карточке цвет несет
      // только плашка уровня, число и полоса нейтральны
      cardKeepsColor: /scoreColor\(/.test(row),
      cardChipCarriesColor: /<Label theme=\{c\.chip\.theme\}/.test(row),
    }).toEqual({ healthyPlain: true, exceptionsLabeled: true, ratingInlineColor: false, ratingNullStaysUnknown: true, cardKeepsColor: false, cardChipCarriesColor: true });
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
      // В4.7 (Б7, П4.2): названия подметрик переехали в словарь src/report/submetrics.ts
      submetricTitleKept: readFileSync(join(import.meta.dir, "..", "src", "report", "submetrics.ts"), "utf8").includes("Свежесть последнего коммита человека"),
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
    // ПЕРЕВОРОТ (В4.9, К9.10): тексты правил в форме эффекта «повысит балл категории «…»»; правило языка прежнее
    expect(CHANNEL_DELTA_HIDDEN_TEXT).toBe("повысит балл категории «CI/CD»; насколько вырастет Repo Health Score, видно при доступе к CI/CD и Безопасности");
    expect(CHANNEL_DELTA_HIDDEN_TEXT).not.toMatch(/[—ё\d]/);
    // ПЕРЕВОРОТ (В4.8.5, К8.5.4, С4-12): без «PAT» и «кабинета» — правило языка прежнее (среднее тире)
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): Ф20 — одно слово «обновите» во всех сообщениях об отклоненном токене
    expect(textOf("src/api/me.ts")).toContain("SourceCraft отклонил ваш токен – обновите его в Настройках");
  });

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): в рекомендациях «Основание:» → «Причина:» (слово владельца);
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (завершающие правки В4.9, §2 23.09): «Причина:» → «Показатель:» (слово владельца)
  test("Р19: подпись фактов рекомендации — «Причина»", () => {
    const src = codeOf("RepoPage.tsx");
    expect({ newWord: src.includes("Показатель:"), oldWord: src.includes("Основано на фактах") || src.includes("Основание:") || src.includes("Причина:") }).toEqual({ newWord: true, oldWord: false });
  });
});

// ---------------------------------------------------------------------------
// Блок Б4 — карточка, категории: Р14 (строка недоступных под списком; плашка
// вклада закрыта трипваем Т2), Р16 (контейнер табов), Р20 (закрыт Т5).
// ---------------------------------------------------------------------------

describe("Б4 (Р14, Р16): список категорий и контейнер табов", () => {
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А4; §2 23.09 «финальный вид подтвержден»
  // п.2): закрытые по-прежнему НЕ строки и стоят плашкой под списком, но
  // внутри — заголовок с именами именно закрытых категорий и пояснение одним
  // предложением `ACCESS_LOCK_SHORT` по причине (собирает `lockedView`,
  // поведенческий тест — v49-ui-r1-card).
  test("Р14: закрытые категории не строки, а ОДНА плашка под списком, с их конкретной причиной", () => {
    const src = codeOf("RepoPage.tsx");
    const view = codeOf("cardView.ts");
    const categories = between(src, "function Categories", "function LockedCategories");
    const row = between(src, "function CategoryRow", "function Markers");
    expect({
      rowsFiltered: /score\.categories\[k\]!\.locked === undefined/.test(view),
      noteAfterList: categories.indexOf("</ul>") < categories.indexOf("<LockedCategories"),
      // круг 2 (Т3): имена именно закрытых категорий в предложении; причина —
      // `ACCESS_LOCK_SHORT` по праву зрителя с токеном
      namesActualCategories: /const names = locked\.map\(\(k\) => CATEGORY_TITLES\[k\]\)\.join\(" и "\)/.test(view),
      // круг 4 (3): причина зрителя с токеном — словарь `LOCKED_WHY` по причине отказа
      reasonFromAccessLock: /LOCKED_WHY\[r as keyof typeof LOCKED_WHY\]/.test(view),
      // фиксированная фраза «CI/CD и Security» была бы ложью при закрытой одной
      hardcodedPair: src.includes("CI/CD и Безопасность – недоступны"),
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

  // ПЕРЕВОРОТ (В4.9, К9.13): склейка «Категории X и Y недоступны. причина» заменена
  // строками «название — фраза отчета» — одна фраза на карточке и в отчете; согласовывать число нечего
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А4): строки «название — фраза» заменены
  // заголовком и пояснением одним предложением; склейки «недоступны» нет.
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (круг 2 части 2, Т3): заголовка нет — одно предложение.
  test("Р14 → Т3: одно предложение без заголовка, панель под списком", () => {
    const src = codeOf("RepoPage.tsx");
    const note = between(src, "function LockedCategories", "function CategoryRow");
    expect({
      titleAndSentence: !note.includes("title=") && note.includes("message={text}"),
      perCategoryRows: note.includes("items.map((item)"),
      noAgreementGlue: note.includes('"недоступна"') || note.includes('"недоступны"'),
      lastInList: /\.rh-locked-note \{[^}]*margin-top:\s*var\(--g-spacing-3\)/.test(srcOf("layout.css")),
    }).toEqual({ titleAndSentence: true, perCategoryRows: false, noAgreementGlue: false, lastInList: true });
  });

  // Доводка 21.09: верхнее поле у списка снято решением владельца — раскрытое
  // содержимое отбивает от строки категории ШАПКА «Значение / Балл», которой
  // в круге 2 ещё не было. Утверждение переведено с конкретного отступа на
  // саму отбивку: список по-прежнему не начинается вплотную.
  test("Р14: раскрытое содержимое отбито от шапки коллапс-блока", () => {
    const css = srcOf("layout.css");
    const src = codeOf("RepoPage.tsx");
    const subrows = between(css, ".rh-subrows {", "}");
    expect({
      topPaddingGone: /padding: var\(--g-spacing-2\)/.test(subrows),
      headerSeparates: src.includes('<div className="rh-subrows__head">'),
    }).toEqual({ topPaddingGone: false, headerSeparates: true });
  });

  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А1 / U1-A): табов нет — разделы ленты
  // «Категории» и «Рекомендации» живут в том же контейнере, что блок величины.
  test("Р16 → А1: разделы ленты — в контейнере с границами, как блок величины; табов нет", () => {
    const src = codeOf("RepoPage.tsx");
    const categories = between(src, "function Categories", "function LockedCategories");
    const recs = between(src, "function Recommendations", "function RecommendationRow");
    const css = srcOf("layout.css");
    expect({
      container: /<Card view="outlined" className="rh-section-card">/.test(categories) && /<Card view="outlined" className="rh-section-card">/.test(recs),
      tabsGone: /<TabList|CardTabs|rh-tabs-card/.test(src),
      sameAsBand:
        between(css, ".rh-section-card {", "}").includes("padding: var(--g-spacing-3) var(--g-spacing-4)") &&
        between(css, ".rh-score-band {", "}").includes("padding: var(--g-spacing-3) var(--g-spacing-4)"),
    }).toEqual({ container: true, tabsGone: false, sameAsBand: true });
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
    const head = between(codeOf("RepoPage.tsx"), "function Header", "export const RECOMMENDATIONS_ID");
    expect({
      grey: meta.includes('color="secondary"'),
      steelGone: meta.includes('color="misc"'),
      // отступ по-прежнему берётся от полушага; доводка 21.09 добавила к нему 2px
      topGap: /\.rh-meta \{[^}]*margin-top: [^;]*var\(--g-spacing-half\)/.test(srcOf("layout.css")),
      // Доводка 21.09: перенос реквизитов в панель ОТМЕНЁН владельцем — строка
      // снова в шапке. Слово «активность» вернулось в другой форме («обновлен
      // 17.09.2026»): без него иконка часов читалась как время скана. Запрет
      // Р11 касался формы «активность {fmtDate}», и она по-прежнему не
      // используется.
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А7; §2 23.09 ответ 4 — прочтение HQ):
      // «обновлен» → «активность» рядом с «анализ <время>»: две даты различены
      // словом явно, поэтому форма «активность {fmtDate» вернулась
      wordGone: head.includes("активность {fmtDate"),
      tooltipKept: head.includes('title="Последняя активность'),
      dateNamed: head.includes("обновлен {fmtDate(r.lastActivityAt)}"),
      analysisNamed: head.includes("анализ {fmtDateTime(view.analysisAt)}"),
    }).toEqual({ grey: true, steelGone: false, topGap: true, wordGone: true, tooltipKept: true, dateNamed: false, analysisNamed: true });
  });

  test("Р12: «Покрытие: N%», чип размера панели, мелкий текст замка и ссылка в кабинет на всех ветках", async () => {
    const src = codeOf("RepoPage.tsx");
    const figure = between(src, "function ScoreFigure", "// ---------- категории");
    const lock = between(src, "view.fullPath ?", "function ContributionStrip");
    const aside = between(src, "function ScoreAside", "function PathLine");
    const pathLine = between(src, "function PathLine", "function ScoreBand");
    const { ACCESS_LOCK_TEXT, ACCESS_LOCK_SHORT } = (await import("../src/web/format")) as {
      ACCESS_LOCK_TEXT: Record<string, string>;
      ACCESS_LOCK_SHORT: Record<string, string>;
    };
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А2 и А8): «Покрытие: N%» ушло из блока
    // показателей в паспорт анализа справа — с подсказкой ⓘ (термин тот же,
    // §2 23.09 ответ 3); строка замка — путь к полной оценке по типу зрителя
    // (`fullScorePath`, одна копия с отчетом), «Настройках» в ней — ссылка.
    expect({
      coverageWord: figure.includes("Покрытие: {fmtCoverage(coverage)}"),
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (круг 4 части 2, П2): у одного показателя — строка
      // «Покрытие» с подсказкой; у двух — «Покрытие HCI» и «Покрытие RHS», в
      // подсказке каждой аббревиатура расшифрована
      coverageInAside:
        /name="Покрытие" note=\{coverageHelp\}/.test(aside) &&
        /name="Покрытие HCI" note=\{`HCI – HealthCraft Index\. \$\{coverageHelp\}`\}/.test(aside) &&
        /name="Покрытие RHS" note=\{`RHS – Repo Health Score\. \$\{coverageHelp\}`\}/.test(aside),
      oldCoverageWord: figure.includes("данных хватило"),
      chipLikeAside: /scoreLabelTheme\(total\)\} size="s"/.test(figure),
      // блок не схлопывается в метку: заголовок, путь по типу зрителя и
      // переход — приём карточки показателя у платформы
      lockIsInvite:
        lock.includes("Виден участникам репозитория") &&
        /<PathLine parts=\{view\.fullPath\} \/>/.test(lock) &&
        !src.includes("FullLockMessage"),
      buttonGone: lock.includes("Открыть личный кабинет"),
      // переход к токену ОДИН на экран и стоит у самого показателя: слово «Настройках» — ссылка
      linkInText: /p\.settings \?[\s\S]{0,80}linkProps\("\/settings"\)/.test(pathLine),
      lockTextStillShared: Object.keys(ACCESS_LOCK_TEXT).sort().join(",") === "check-failed,denied,no-pat,pat-expired",
      shortKeysMatchFull: Object.keys(ACCESS_LOCK_SHORT).sort().join(",") === Object.keys(ACCESS_LOCK_TEXT).sort().join(","),
    }).toEqual({
      coverageWord: false,
      coverageInAside: true,
      oldCoverageWord: false,
      chipLikeAside: true,
      lockIsInvite: true,
      buttonGone: false,
      linkInText: true,
      lockTextStillShared: true,
      shortKeysMatchFull: true,
    });
  });

  test("Р13: абзац про разницу снят, подсказки у ОБОИХ показателей называют отличие", () => {
    const src = codeOf("RepoPage.tsx");
    const band = between(src, "function ScoreBand", "function ScoreFigure");
    expect({
      paragraphGone: band.includes("Разницу с HealthCraft Index дают CI/CD и Безопасность:"),
      indexHelp: src.includes("Публичная оценка по 4 категориям") && src.includes("и является основой общего рейтинга"),
      fullHelp:
        src.includes("Рассчитывается по 6 категориям") &&
        src.includes("Показатель доступен только для репозиториев, к которым у вас есть доступ"),
      // В4.9 ч.2: ветка закрытого показателя теперь по `view.fullPath` (А2) — ПЕРЕНОС
      helpOnLockedBranch: /view\.fullPath \?[\s\S]{0,1200}<HelpMark/.test(band),
      // MD-отчёт свою формулировку сохраняет: документ читается без наведения.
      // Круг 2 гейта, п.3: отличие показателей объясняет одна строка под обоими
      // числами, поэтому фраза переехала в нее (прежде — подпись под вторым числом).
      mdKeepsParagraph: buildSrc().includes("считается по открытым данным – по нему строится рейтинг"),
    }).toEqual({ paragraphGone: false, indexHelp: true, fullHelp: true, helpOnLockedBranch: true, mdKeepsParagraph: true });
  });

  test("Р17/Р22: модель в плашке как в панели рейтинга, звезда одного размера с иконкой перехода", () => {
    const src = codeOf("RepoPage.tsx");
    const aside = between(src, "function ScoreAside", "function ScoreBand");
    const star = src.slice(src.indexOf("function FavoriteStar"));
    const link = between(src, "Открыть на sourcecraft.dev", "</ActionTooltip>");
    expect({
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А10): «Модель» → «Версия методики» на
      // карточке (в свернутых «Реквизитах»); плашка та же, что в панели рейтинга
      modelPlate: /name="Версия методики"[\s\S]{0,200}<Label theme="normal" size="xs">/.test(aside) && !aside.includes('name="Модель"'),
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): Ф20 — и в панели рейтинга «Версия методики»
      sameAsRating: /name="Версия методики"[\s\S]{0,200}<Label theme="normal" size="xs">/.test(codeOf("Rating.tsx")),
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

  // Доводка 21.09: контрол снят целиком — сортировка переехала в заголовки
  // колонок (манера таблиц платформы). Обрезать нечего, и утверждение
  // ПЕРЕВЁРНУТО на отсутствие селекта: вернуть его молча уже не получится.
  test("Р21: селекта сортировки в тулбаре нет — сортируют заголовки колонок", () => {
    const src = codeOf("Rating.tsx");
    expect({
      selectGone: src.includes('label="Сортировка:"'),
      oldFixedWidth: src.includes("width={230}"),
      headerSorts: src.includes("function SortableHeader"),
    }).toEqual({ selectGone: false, oldFixedWidth: false, headerSorts: true });
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
      // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): В-5 — охват одной функцией `coverageLine` (число — поведенческим тестом)
      concise: src.includes("{coverageLine(meta.repos)}"),
    }).toEqual({ title: true, oneLead: true, oldSubheader: false, secondParagraph: false, fromDb: true, wave: false, concise: true });
  });

  test("Р6: в числовых диапазонах дефис — шкала, MD-таблица подметрик, слот сравнения", async () => {
    const { SCORE_SCALE } = (await import("../src/web/format")) as { SCORE_SCALE: { range: string }[] };
    expect(SCORE_SCALE.map((s) => s.range)).toEqual(["70-100", "40-69", "0-39"]);
    // В4.9 (К9.6): «Балл (0-100)» ушел вместе с прежней таблицей подметрик; диапазоны — шкала словами в MD.
    // Круг 2 гейта, п.5: подписи зон под полосой вкладов убраны, словесная шкала осталась в «Как считается».
    expect(mdLocked()).toContain("Шкала: здоров 70-100, требует внимания 40-69, в зоне риска 0-39.");
    // В5.3 круг 4: пустое состояние раздела «Сравнение» переписано (продуктовый Т3) — диапазон по-прежнему через дефис
    const { SLOT_EMPTY } = (await import("../src/web/slots")) as { SLOT_EMPTY: { compare: { title: string } } };
    expect(SLOT_EMPTY.compare.title).toBe("Добавьте 2-3 репозитория");
    // глиф «нет данных» (длинное тире) правилом не затронут — охранный пункт 1
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (Ступень 4 В4.9, §2 23.09): В-9 — закрытая категория «недоступно»; глиф «—» прежний
    expect(mdLocked()).toContain("| CI/CD | — | недоступно |");
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
