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

/** Кусок исходника между двумя якорями — чтобы утверждение говорило о нужной функции, а не о файле. */
const between = (src: string, from: string, to: string): string => src.slice(src.indexOf(from), src.indexOf(to));

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
// Т1 (Р15): затухание `.rh-fade::after` красит КОНТЕНТ карточки на 1366.
// Диагноз уточнён аудит-парой: `.rh-page__main` прокручивает себя только при
// ≥1440 (layout.css:296-299) и перестаёт под `@media (max-width: 1439px)` —
// значит на 1920 затухание работает верно, а дефект живёт на 1366. Правка:
// тот же порог 1439 гасит псевдоэлемент; собственный `::after` таблицы
// рейтинга (layout.css:535-543) не трогается, класс со Shell.tsx не вычищается.
// ---------------------------------------------------------------------------

describe("Р15: затухание живёт только на контейнерах с собственной прокруткой", () => {
  repro("`.rh-fade::after` погашен порогом 1439, кромка таблицы рейтинга цела", () => {
    const css = srcOf("layout.css");
    const narrow = css.slice(css.indexOf("@media (max-width: 1439px)"), css.indexOf("@media (max-width: 767px)"));
    expect({
      fadeGatedAt1439: /\.rh-fade::after\s*\{[^}]*display:\s*none/.test(narrow),
      tableEdgeKept: css.includes(".rh-table-fill .g-table__scroll-container::after"),
      classKept: srcOf("Shell.tsx").includes('className="rh-page__main rh-fade"'),
    }).toEqual({ fadeGatedAt1439: true, tableEdgeKept: true, classKept: true });
  });
});

// ---------------------------------------------------------------------------
// Т2 (Р14): «вес N% → вклад M%» стоит СТРОКОЙ, а не одной плашкой. Владелец
// просил одну серую плашку «Вклад M%» в стиле плашки «Здоров», прижатую к
// правому краю; тема плашки — `normal` (решение HQ), у категории без данных
// она несёт NOT_COUNTED («не учитывается»), а не «Вклад 0%».
// ---------------------------------------------------------------------------

describe("Р14: вклад категории — одна плашка, а не строка «вес → вклад»", () => {
  repro("CategoryRow: Label theme=\"normal\" со словом «Вклад», старой строки нет", () => {
    const row = between(srcOf("RepoPage.tsx"), "function CategoryRow", "// ---------- маркеры расчёта");
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
  repro("RepoPage: пользовательского слова «закрыто» нет, есть «Недоступно»", () => {
    const src = srcOf("RepoPage.tsx");
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
  repro("таблица категорий и заголовки разбора говорят «Недоступно»", () => {
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
  repro("одна функция округления фактов на страницу и отчёт", async () => {
    const mod = (await import("../src/web/format")) as { roundFacts?: (v: unknown) => unknown };
    expect(typeof mod.roundFacts).toBe("function");
    expect(mod.roundFacts!(0.8723404255319149)).toBe(0.87);
    expect(mod.roundFacts!(8000)).toBe(8000);
    expect(mod.roundFacts!({ ratio: 0.8723404255319149, count: 47 })).toEqual({ ratio: 0.87, count: 47 });
  });

  repro("MD: в таблице подметрик доля округлена, поповер доказательства — нет", () => {
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

describe("Р13: кнопка «Что делать» снята, счётчик рекомендаций стал ссылкой", () => {
  repro("RepoPage: кнопки «Что делать» нет, есть ссылка «Рекомендаций: N» на таб", () => {
    const src = srcOf("RepoPage.tsx");
    expect({
      cta: src.includes("Что делать"),
      counterLink: /Рекомендаций: \{card\.recommendations\.length\}/.test(src),
      summaryStillShared: src.includes("summaryLine") && reportSrc().includes("summaryLine"),
    }).toEqual({ cta: false, counterLink: true, summaryStillShared: true });
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
  repro("CategoryCell рейтинга без scoreColor(), CategoryRow карточки с ним", () => {
    const cell = srcOf("Rating.tsx").slice(srcOf("Rating.tsx").indexOf("function CategoryCell"));
    const row = between(srcOf("RepoPage.tsx"), "function CategoryRow", "// ---------- маркеры расчёта");
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
  repro("Rating: name=\"Частота\" со значением «ежесуточно» и пояснением про «Скан»", () => {
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
  repro("Rating: блок удалён, легенда по-прежнему первая в панели", () => {
    const src = srcOf("Rating.tsx");
    const legend = src.indexOf("<ScoreLegend />");
    const contribution = src.indexOf('title="Вклад категорий"');
    expect({
      aboutRating: src.includes("О рейтинге"),
      legendFirst: legend >= 0 && contribution >= 0 && legend < contribution,
    }).toEqual({ aboutRating: false, legendFirst: true });
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
