// Репро-тесты на дефекты карточки, рейтинга и MD-отчета, найденные аудитом UI.
// Обертка `repro` – в обычном прогоне `test.failing`, под AUDIT_STRICT=1 обычный
// `test`; в конце файла строгая самопроверка, что под `repro` ничего не осталось.
//
// Живых запросов нет: MD – чистая функция от карточки на временной БД, UI –
// source-assert или чистый хелпер.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
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


const repro = process.env.AUDIT_STRICT ? test : test.failing;

const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");
const reportSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");
const buildSrc = (): string => readFileSync(join(import.meta.dir, "..", "src", "report", "build.ts"), "utf8");

/**
 * Исходник без комментариев – для утверждений «такого слова в интерфейсе нет».
 * Иначе тест ловит комментарий, объясняющий правку, и утверждение говорит о
 * файле, а не о разметке.
 */
const codeOf = (file: string): string => stripComments(srcOf(file));

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/**
 * Кусок исходника между двумя якорями. Закрывающий якорь ищется после
 * открывающего: иначе на повторяющихся тегах (`</DefinitionList.Item>`) срез
 * уходил бы назад и утверждение молча проверяло пустую строку.
 */
const between = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end < 0 ? undefined : end);
};

// ---------------------------------------------------------------------------
// Фикстура: одна карточка, два зрителя. Сырое значение подметрики (доля с 16
// знаками) – ровно то, что однажды попало на первый экран неокругленным.
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

/** Зритель без прав на каналы: CI/CD и Security приходят `locked`. */
const mdLocked = (): string =>
  renderRepoReport(getRepoCard(t.db, "v46r2", "repro", { access: { cicd: "denied", appsec: "denied", repo: "granted" } })!);

// ---------------------------------------------------------------------------
// Затухание нижней кромки (`.rh-fade::after`) красило контент карточки на 1366.
// Оно снято целиком: ни CSS, ни разметка его больше не создают.
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
// Вклад категории на карточке: ни строки «вес → вклад», ни плашки вклада, ни
// «не учитывается» – вклад показан полосой под числами.
// ---------------------------------------------------------------------------

describe("Р14: вклад категории — одна плашка, а не строка «вес → вклад»", () => {
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
// Пользовательское слово «закрыто» на карточке. Переименование меняет слово, не
// смысл: сведения об отсутствии доступа остаются (tri-state, ТЗ §3.4).
// ---------------------------------------------------------------------------

describe("Р12 (UI): «закрыто» → «Недоступно» на карточке", () => {
  test("RepoPage: пользовательского слова «закрыто» нет, есть «Недоступно»", () => {
    const src = codeOf("RepoPage.tsx");
    expect({
      userWordClosed: />\s*закрыто\s*</.test(src),
      // закрытый показатель назван фразой, а не одним словом
      userWordUnavailable: src.includes("Виден участникам репозитория"),
    }).toEqual({ userWordClosed: false, userWordUnavailable: true });
  });
});

// ---------------------------------------------------------------------------
// То же слово в отчете: «закрыто доступом» в ячейке «Статус» и заголовках разбора.
// ---------------------------------------------------------------------------

describe("Р12 (MD): «закрыто»/«закрыто доступом» → «Недоступно» в отчёте", () => {
  test("таблица категорий и заголовки разбора говорят «Недоступно»", () => {
    const out = mdLocked();
    expect({
      // закрытая категория в отчете – «недоступно» и фраза по причине доступа, а не «нет данных»
      statusCell: out.includes("| CI/CD | — | недоступно | У вашего токена нет прав на эти данные репозитория. |"),
      detailHeader: out.includes("### Безопасность – недоступно"),
      oldStatusCell: out.includes("закрыто доступом"),
      oldDetailHeader: /### [^\n]* – закрыто$/m.test(out),
    }).toEqual({ statusCell: true, detailHeader: true, oldStatusCell: false, oldDetailHeader: false });
  });
});

// ---------------------------------------------------------------------------
// Сырое значение факта («0.8723404255319149») стояло в списке подметрик на
// карточке и в MD. Округляются только подметрики – доли до 2 знаков, целые без
// хвоста; поповер «Основание» остается сырым JSON, это доказательная база.
// ---------------------------------------------------------------------------

describe("Р20: значения подметрик округлены, доказательная база остаётся сырой", () => {
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
      // строка – русское название и единица из словаря подметрик, десятичная запятая
      mdRounded: out.includes("| Плотность TODO/FIXME в коде | 0,9 на 1 тыс. строк | 80 | 35% |"),
      mdRaw: out.includes("0.8723404255319149"),
      // страница берет значение из словаря подметрик (округление внутри него);
      // соседние подметрики нужны для прочерка доли старых TODO при нуле пометок
      pageUsesRounding: /\{submetricShownValue\(key, subKey, sub, submetricContext\(card\.score\?\.computedAt\), cat\.submetrics\)\}/.test(page),
      proofStaysRaw: between(page, "function FactProof", "function factStatusText").includes("fmtFactValue(fact.value)"),
    }).toEqual({ mdRounded: true, mdRaw: false, pageUsesRounding: true, proofStaysRaw: true });
  });
});

// ---------------------------------------------------------------------------
// Нижний ярус под показателями снят целиком: ни кнопки «Что делать», ни счетчика
// рекомендаций, ни строки итога.
// ---------------------------------------------------------------------------

describe("Р13 + П1.10: нижний ярус показателей полностью снят", () => {
  test("RepoPage: под показателями нет CTA, итогового текста и ссылки рекомендаций", () => {
    const src = codeOf("RepoPage.tsx");
    const band = between(src, "function ScoreBand", "function ScoreFigure");
    expect({
      cta: src.includes("Что делать"),
      counterLink: /Рекомендаций: \{card\.recommendations\.length\}/.test(band),
      summaryOnPage: band.includes("summaryLine"),
      // вывод отчета – крупное число с плашкой зоны
      reportHasChip: reportHeroHasChip(),
    }).toEqual({ cta: false, counterLink: false, summaryOnPage: false, reportHasChip: true });
  });
});

// ---------------------------------------------------------------------------
// В рейтинге подсвечены только исключения: >=70 – нейтральный текст, 40-69 и
// <40 – семантический Label. Tri-state не двигается: `null` остается Label
// theme="unknown" со «н/д».
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
      // на карточке цвет несет только плашка уровня, число и полоса нейтральны
      cardKeepsColor: /scoreColor\(/.test(row),
      cardChipCarriesColor: /<Label theme=\{c\.chip\.theme\}/.test(row),
    }).toEqual({ healthyPlain: true, exceptionsLabeled: true, ratingInlineColor: false, ratingNullStaysUnknown: true, cardKeepsColor: false, cardChipCarriesColor: true });
  });
});

// ---------------------------------------------------------------------------
// Пункт панели рейтинга о частоте обхода называется «Частота», а не «Свежесть».
// Подметрика «Свежесть последнего коммита человека» – другое понятие, не трогается.
// ---------------------------------------------------------------------------

describe("Р10: пункт «Свежесть» в панели рейтинга стал «Частота»", () => {
  test("Rating: name=\"Частота\" с пояснением о сверке каталога и повторных анализах", () => {
    const src = srcOf("Rating.tsx");
    expect({
      oldName: src.includes('name="Свежесть"'),
      newName: src.includes('name="Частота"'),
      note: src.includes("Каталог сверяется ежечасно") && src.includes("анализируются повторно ежесуточно"),
      // названия подметрик живут в словаре src/report/submetrics.ts
      submetricTitleKept: readFileSync(join(import.meta.dir, "..", "src", "report", "submetrics.ts"), "utf8").includes("Свежесть последнего коммита человека"),
    }).toEqual({ oldName: false, newName: true, note: true, submetricTitleKept: true });
  });
});

// ---------------------------------------------------------------------------
// Блока «О рейтинге» в правой панели нет – нужное живет в тексте над таблицей.
// Якорь «легенда первая» – следующий блок панели.
// ---------------------------------------------------------------------------

describe("Р7: блока «О рейтинге» в правой панели нет", () => {
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
// Затухания нет и у таблицы рейтинга: она прокручивается сама, обертка – нет.
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
// Правило языка (без длинного тире и «ё») в заготовленных текстах рекомендаций
// и пользовательских строках API; подпись фактов рекомендации.
// ---------------------------------------------------------------------------

describe("Б5 (Р18, Р19): правило языка в текстах движка и «Основание»", () => {
  const textOf = (rel: string): string => stripComments(readFileSync(join(import.meta.dir, "..", rel), "utf8"));

  test("Р18: в текстах рекомендаций нет длинного тире и нет «ё»", () => {
    const src = textOf("src/score/recommend.ts");
    expect({ emDash: src.includes("—"), yo: /[ёЁ]/.test(src) }).toEqual({ emDash: false, yo: false });
  });

  test("Р18: две названные пользовательские строки API — по правилу языка", async () => {
    const { CHANNEL_DELTA_HIDDEN_TEXT } = (await import("../src/api/repos")) as { CHANNEL_DELTA_HIDDEN_TEXT: string };
    expect(CHANNEL_DELTA_HIDDEN_TEXT).toBe("повысит балл категории «CI/CD»; насколько вырастет Repo Health Score, видно при доступе к CI/CD и Безопасности");
    expect(CHANNEL_DELTA_HIDDEN_TEXT).not.toMatch(/[—ё\d]/);
    // без «PAT» и «кабинета»; одно слово «обновите» во всех сообщениях об отклоненном токене
    expect(textOf("src/api/me.ts")).toContain("SourceCraft отклонил ваш токен – обновите его в Настройках");
  });

  // подпись фактов рекомендации – «Показатель:»
  test("Р19: подпись фактов рекомендации — «Причина»", () => {
    const src = codeOf("RepoPage.tsx");
    expect({ newWord: src.includes("Показатель:"), oldWord: src.includes("Основано на фактах") || src.includes("Основание:") || src.includes("Причина:") }).toEqual({ newWord: true, oldWord: false });
  });
});

// ---------------------------------------------------------------------------
// Список категорий: закрытые категории и контейнер разделов.
// ---------------------------------------------------------------------------

describe("Б4 (Р14, Р16): список категорий и контейнер табов", () => {
  // Закрытые категории – не строки, а одна плашка под списком: имена именно
  // закрытых категорий и пояснение одним предложением по причине (собирает
  // `lockedView`, поведенческий тест – v49-ui-r1-card).
  test("Р14: закрытые категории не строки, а ОДНА плашка под списком, с их конкретной причиной", () => {
    const src = codeOf("RepoPage.tsx");
    const view = codeOf("cardView.ts");
    const categories = between(src, "function Categories", "function LockedCategories");
    const row = between(src, "function CategoryRow", "function Markers");
    expect({
      rowsFiltered: /score\.categories\[k\]!\.locked === undefined/.test(view),
      noteAfterList: categories.indexOf("</ul>") < categories.indexOf("<LockedCategories"),
      namesActualCategories: /const names = locked\.map\(\(k\) => CATEGORY_TITLES\[k\]\)\.join\(" и "\)/.test(view),
      // причина для зрителя с токеном – словарь `LOCKED_WHY` по причине отказа
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

  // Одно предложение без заголовка и без склейки «недоступна/недоступны» –
  // согласовывать число нечего.
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

  // Верхнего поля у списка нет: раскрытое содержимое отбивает от строки
  // категории шапка «Значение / Балл», поэтому список не начинается вплотную.
  test("Р14: раскрытое содержимое отбито от шапки коллапс-блока", () => {
    const css = srcOf("layout.css");
    const src = codeOf("RepoPage.tsx");
    const subrows = between(css, ".rh-subrows {", "}");
    expect({
      topPaddingGone: /padding: var\(--g-spacing-2\)/.test(subrows),
      headerSeparates: src.includes('<div className="rh-subrows__head">'),
    }).toEqual({ topPaddingGone: false, headerSeparates: true });
  });

  // Табов нет – разделы «Категории» и «Рекомендации» живут в том же контейнере,
  // что блок величины.
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
// Верх карточки: мета-строка, плашка и покрытие, строка замка, подсказки к
// показателям, плашка версии методики, размер звезды.
// ---------------------------------------------------------------------------

describe("Б3 (Р11, Р12, Р13, Р17, Р22): верх карточки по замечаниям 11-13, 17 и Р22", () => {
  test("Р11: мета-строка серая, выровнена отступом сверху, без слова «активность»", () => {
    const meta = between(codeOf("ui.tsx"), "function MetaItem", "function SkeletonRows");
    const head = between(codeOf("RepoPage.tsx"), "function Header", "export const RECOMMENDATIONS_ID");
    expect({
      grey: meta.includes('color="secondary"'),
      steelGone: meta.includes('color="misc"'),
      topGap: /\.rh-meta \{[^}]*margin-top: [^;]*var\(--g-spacing-half\)/.test(srcOf("layout.css")),
      // «активность <дата>» рядом с «анализ <время>»: две даты различены словом,
      // иначе иконка часов читается как время скана
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
    // «Покрытие» живет в паспорте анализа справа с подсказкой; строка замка –
    // путь к полной оценке по типу зрителя (`fullScorePath`, одна копия с
    // отчетом), «Настройках» в ней – ссылка.
    expect({
      coverageWord: figure.includes("Покрытие: {fmtCoverage(coverage)}"),
      // у одного показателя – строка «Полнота данных»; у двух – «Полнота: индекс» и
      // «Полнота: полная оценка», в подсказке каждой показатель назван полностью
      // UX 17.10: «Покрытие» → «Полнота данных», аббревиатуры HCI/RHS в имени строки сняты
      coverageInAside:
        /name="Полнота данных" note=\{coverageHelp\}/.test(aside) &&
        /name="Полнота: индекс" note=\{`HealthCraft Index\. \$\{coverageHelp\}`\}/.test(aside) &&
        /name="Полнота: полная оценка" note=\{`Repo Health Score\. \$\{fullCoverageHelp\}`\}/.test(aside),
      oldCoverageWord: figure.includes("данных хватило"),
      chipLikeAside: /scoreLabelTheme\(total\)\} size="s"/.test(figure),
      // блок не схлопывается в метку: заголовок, путь по типу зрителя и
      // переход – как карточка показателя у платформы
      lockIsInvite:
        lock.includes("Виден участникам репозитория") &&
        /<PathLine parts=\{view\.fullPath\} \/>/.test(lock) &&
        !src.includes("FullLockMessage"),
      buttonGone: lock.includes("Открыть личный кабинет"),
      // переход к токену один на экран и стоит у самого показателя
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
        src.includes("Виден, если вашему токену доступны и CI/CD, и Безопасность репозитория"),
      helpOnLockedBranch: /view\.fullPath \?[\s\S]{0,1200}<HelpMark/.test(band),
      // MD-отчет свою формулировку сохраняет: документ читается без наведения.
      // Отличие показателей объясняет одна строка под обоими числами.
      mdKeepsParagraph: buildSrc().includes("считается по открытым данным – по нему строится рейтинг"),
    }).toEqual({ paragraphGone: false, indexHelp: true, fullHelp: true, helpOnLockedBranch: true, mdKeepsParagraph: true });
  });

  test("Р17/Р22: модель в плашке как в панели рейтинга, звезда одного размера с иконкой перехода", () => {
    const src = codeOf("RepoPage.tsx");
    const aside = between(src, "function ScoreAside", "function ScoreBand");
    const star = src.slice(src.indexOf("function FavoriteStar"));
    const link = between(src, "Открыть на sourcecraft.dev", "</ActionTooltip>");
    expect({
      // «Версия методики» в «Сведениях» — та же плашка, что в панели рейтинга (`ModelVersion`)
      modelPlate: /name="Версия методики">\s*<ModelVersion version=\{score\.modelVersion\} \/>/.test(aside) && !aside.includes('name="Модель"'),
      sameAsRating: /name="Версия методики">\s*<ModelVersion version=\{meta\.modelVersion\} \/>/.test(codeOf("Rating.tsx")),
      starIcon14: /data=\{state === "on" \? StarFill : Star\} size=\{14\}/.test(star),
      linkIcon14: /data=\{ArrowUpRightFromSquare\} size=\{14\}/.test(link),
      // кнопки-обертки совпадают по габариту: обе `size="s"`
      sameButtonSize: /<Button[\s\S]{0,200}size="s"/.test(star) && /<Button[\s\S]{0,200}size="s"/.test(link),
    }).toEqual({ modelPlate: true, sameAsRating: true, starIcon14: true, linkIcon14: true, sameButtonSize: true });
  });
});

// ---------------------------------------------------------------------------
// Строка рейтинга: состав и типографика ячеек, сортировка.
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
      skeletonRhythm: src.includes("<SkeletonRows rows={10} height={isPhone ? 84 : 56} />"),
    }).toEqual({ avatar: true, slugComponent: true, languageName: true, dotOnly: false, skeletonRhythm: true });
  });

  // аудит 16.10: число нейтральное 15/500 — уровень несет полоса
  test("Р3 + П1.1: число как в остальных колонках, нейтральное; полоса снова читаемая", () => {
    // ячейка таблицы; ветка телефона (`narrow`, цветное число без полосы) — выше нее
    const whole = between(codeOf("Rating.tsx"), "function ScoreCell", "function CategoryCell");
    const cell = whole.slice(whole.indexOf("if (item.healthcraftIndex === null)"));
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
        /\.rh-score-cell__num \{[^}]*font-size: var\(--g-text-body-2-font-size\)[^}]*font-weight: var\(--g-text-accent-font-weight\)/.test(css),
      neutralNumber: cell.includes('<Text color="primary" className="rh-score-cell__num"'),
    }).toEqual({ normalNumber: true, boldNumberGone: false, colouredNumber: false, readableBar: true, tighterGap: true, widths: true, neutralNumber: true });
  });

  // Сортируют заголовки колонок (как в таблицах платформы); проверяется, что
  // селект сортировки не вернулся.
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
// Рейтинг: поиск, заголовок и охват, диапазоны, подсказки панели. Утверждения
// обычные, не репро: они закрепляют требования, а не найденные дефекты.
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
      oneLead: src.includes("description={ratingLead(meta, isPhone)}"),
      oldSubheader: src.includes("а не число лайков"),
      secondParagraph: src.includes("<CoverageNote"),
      fromDb: /ratingLead[\s\S]{0,900}meta\.repos/.test(src),
      wave: src.includes("первыми идут самые заметные проекты"),
      // охват – одна функция `coverageLine` (число проверяет поведенческий тест)
      concise: src.includes("{coverageLine(meta.repos)}"),
    }).toEqual({ title: true, oneLead: true, oldSubheader: false, secondParagraph: false, fromDb: true, wave: false, concise: true });
  });

  test("Р6: в числовых диапазонах дефис — шкала, MD-таблица подметрик, слот сравнения", async () => {
    const { SCORE_SCALE } = (await import("../src/web/format")) as { SCORE_SCALE: { range: string }[] };
    expect(SCORE_SCALE.map((s) => s.range)).toEqual(["70-100", "40-69", "0-39"]);
    // словесная шкала в MD – в разделе «Как считается»
    expect(mdLocked()).toContain("Шкала: здоров 70-100, требует внимания 40-69, в зоне риска 0-39.");
    const { SLOT_EMPTY } = (await import("../src/web/slots")) as { SLOT_EMPTY: { compare: { title: string } } };
    expect(SLOT_EMPTY.compare.title).toBe("Добавьте 2-3 репозитория");
    // глиф «нет данных» (длинное тире) правилом не затронут
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
      // UX 17.10: «покрытие» → «полнота данных»
      note: item.includes("Оценка рассчитывается только при достаточной полноте данных. Недостающие категории исключаются из расчета"),
      oldNote: src.includes("Score не выставляется, а не занижается"),
      numberFromDb: item.includes("fmtCoverage(meta.coverageNullBelow)"),
    }).toEqual({ note: true, oldNote: false, numberFromDb: true });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» – тавтология,
// потому что незакрытые находки стоят под `test.failing`.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
