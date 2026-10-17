// MD-отчет по сид-набору: разделы по эталону вида, показатель с плашкой,
// категории, причины «нет данных», действия, приложение с путем
// «число → факт», «оценки нет» вместо нуля. Отчет — чистая функция от
// карточки.
import { MODEL_VERSION } from "../src/score/model";
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { REPORT_NO_SCORE } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const scoredRepo = seedRepo(t, {
  org: "report",
  repo: "sample",
  title: "report sample",
  language: "Go",
  likes: 11,
  forks: 2,
  lastActivityAt: "2026-09-15T00:00:00Z",
});
const scoredScan = seedScan(t, scoredRepo, { status: "partial", trigger: "user", facts: cardFacts() });
seedScore(t, scoredRepo, scoredScan, { total: 67 });
seedRecommendation(t, scoredScan, {
  ruleId: "contributing-missing",
  priority: 1,
  problem: "Нет CONTRIBUTING – как вносить правки не описано",
  factRef: "docs.presence",
  deltaScore: 2.25,
  expectedImpact: "+2.3 к HealthCraft Index (по одному)",
});
seedRecommendation(t, scoredScan, {
  ruleId: "connect-appsec",
  priority: 2,
  channel: "appsec", // канальное правило: на карточке собирается движком на показанных фактах
  problem: "Security без данных: AppSec SourceCraft не подключён (публичный режим)",
  factRef: "appsec.findings",
  opensCategory: "security",
  expectedImpact: "coverage 1.00→1.00 – категория Security 20%",
});
// отчёт зрителя с доступом к каналам: полный разбор (матрица доступа — api.test.ts)
const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;
const md = renderRepoReport(getRepoCard(t.db, "report", "sample", { access: GRANTED })!);
const main = md.slice(0, md.indexOf("## Приложение"));
const appendix = md.slice(md.indexOf("## Приложение"));

describe("MD-отчёт: структура", () => {
  test("разделы эталона вида – по порядку, приложение последним", () => {
    expect(md.startsWith("# report/sample")).toBe(true);
    const order = [
      "Repo Health Score: **",
      // показатель назван прямо в заголовке полосы
      "## Вклад категорий в HealthCraft Index",
      "## Категории",
      // блока «Что сделать первым» нет, раздел рекомендаций один и стоит после категорий
      "## Рекомендации",
      "## Ограничения данных",
      "## Разбор по категориям",
      "## Как считается",
      "## Приложение. Расчет оценки и исходные данные",
      "### А. Расчет итоговой оценки",
      "### Б. Источники чисел отчета",
      "### В. Исходные данные",
      "### Г. Версия методики, номер анализа и режим запуска",
    ].map((h) => md.indexOf(h));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("шапка: ссылка на репозиторий и дата анализа; номер анализа и версия методики – в приложении (К9.4)", () => {
    expect(main).toContain("[sourcecraft.dev/report/sample](https://sourcecraft.dev/report/sample)");
    // имя документа, дата без слова «Анализ» и плашка доступа зрителя после
    // нее (в PDF — второй строкой шапки); плашка называет оценку — «полная
    // оценка»/«публичная оценка»
    expect(main).toContain("Отчет HealthCraft. 16 сент. 2026 (полная оценка).");
    expect(main).not.toContain("(полный).");
    expect(main).not.toContain(`#${scoredScan}`);
    expect(main).not.toContain("4.0.0-hci");
    // UX 17.10: дата и время — «16 сент. 2026, 12:00 UTC»
    expect(appendix).toContain(`| Последний анализ | #${scoredScan}, завершен 16 сент. 2026, 12:00 UTC |`);
    expect(appendix).toContain(`| Версия методики | ${MODEL_VERSION} |`);
    expect(md).not.toContain("режим:");
  });
});

describe("MD-отчёт: числа и tri-state", () => {
  // порядок везде «сначала публичный, потом полный»: крупно слева —
  // HealthCraft Index, справа — Repo Health Score
  test("зрителю с обоими показателями первым – HealthCraft Index, вторым Repo Health Score (TASK.md §2, круг 4)", () => {
    const at = (s: string) => main.indexOf(s);
    expect(main).toContain("HealthCraft Index: **67 из 100 · требует внимания**");
    // CI без прогонов — no-data, вес перенормирован: (60+70+40+80)/65·... = 64
    expect(main).toContain("Repo Health Score: **64 из 100 · требует внимания**");
    expect(at("HealthCraft Index: **67")).toBeLessThan(at("Repo Health Score: **64"));
    // и в строке-пояснении публичный показатель назван первым
    expect(main).toContain("HealthCraft Index считается по открытым данным – по нему строится рейтинг. Repo Health Score учитывает 6 категорий, включая CI/CD и Безопасность.");
    // полос вклада две, публичная первой
    expect(at("## Вклад категорий в HealthCraft Index")).toBeGreaterThan(-1);
    expect(at("## Вклад категорий в HealthCraft Index")).toBeLessThan(at("## Вклад категорий в Repo Health Score"));
  });

  test("все шесть категорий: балл и слово шкалы; у Безопасности без данных – «–», а не 0 (tri-state)", () => {
    for (const title of ["Документация", "CI/CD", "Безопасность", "Активность", "Задачи", "Состояние кода"]) expect(main).toContain(`| ${title} |`);
    expect(main).toContain("| Документация | 60 | требует внимания |");
    expect(main).toContain("| Безопасность | – | нет данных |");
    // вес — в приложении А: 15 из 65 весовых пунктов с данными = 23,1%; у категории без данных веса нет.
    // «баллов в итог» — те же десятые, что в полосе вкладов (наибольший остаток), поэтому 13,9, а не 13,8
    expect(appendix).toContain("| Документация | 60,0 | 23,1% | 13,9 |");
    expect(main).toContain("Документация +13,9");
    expect(appendix).toContain("| Безопасность | – | не входит | – |");
    expect(md).not.toMatch(/Безопасность \| [^|]* \| 0%/);
  });

  test("Безопасность без данных – причина в строке, опорная фраза «не участвует и не снижает» – один раз под таблицей (К9.2)", () => {
    // зрителю с доступом причина прочерка — та же, что в действии движка
    expect(main).toContain("| Данных AppSec по репозиторию нет: проверка не подключена или не завершена. |");
    // UX 17.10: фраза — один раз на список, а не у каждой строки
    expect(main.split("Категории без данных в оценке не участвуют и ее не снижают.").length - 1).toBe(1);
    expect(main).not.toContain("Категория в оценке не участвует и ее не снижает.");
  });

  test("причина честного no-data у категории с конфигом проговаривается (23.09, кап 50 удалён)", () => {
    // фраза — только о невидимых запусках
    expect(main).toContain("Результаты запусков CI сервису не видны");
    expect(main).toContain("категорию не оцениваем");
  });

  test("подметрики показаны баллом 0–100, а не долей; название – из словаря", () => {
    // readme в фикстуре — 0.72 доли → 72 в разборе
    expect(main).toContain("| README (наличие и качество) | 7,8 КБ | 72 | 45% |");
  });
});

describe("MD-отчёт: действия и приложение", () => {
  test("действия – рекомендации движка с эффектом; ключей правил и фактов в основном тексте нет", () => {
    // подпись эффекта — перед числом
    expect(main).toMatch(/^1\. \*\*.+\*\* .+ Ожидаемый эффект: \+\d+,\d+ к .+\.$/m);
    expect(main).not.toContain("`docs.presence`");
    expect(main).not.toContain("(источник: rule)");
    expect(main).not.toContain("contributing-missing`");
  });

  test("приложение В: факты таблицами «поле – значение» с источником и временем сбора", () => {
    // UX 17.10: дата и время — «16 сент. 2026, 12:00 UTC»
    expect(appendix).toContain("`docs.presence` – Документация, данные есть, история git, 16 сент. 2026, 12:00 UTC");
    expect(appendix).toContain("`cicd.runs` – CI/CD, данных нет, API SourceCraft, 16 сент. 2026, 12:00 UTC");
    expect(appendix).toContain("| contributing | нет |");
  });

  test("история коммитов – итогом, сырьё в отчёт не едет", () => {
    expect(appendix).toContain("`activity.git.timeline`");
    expect(appendix).toContain("| events | 2 |");
    expect(md).not.toContain('"sha"');
    expect(md).not.toContain("a1");
  });

  test("приложение Б: путь «число → откуда взято» для итога, категорий и показателей", () => {
    // удваивается только строка самого показателя, публичная первой;
    // в «порядке расчета» названо, по скольким категориям он считается
    expect(appendix).toContain("| **HealthCraft Index 67** | сумма по 4 открытым категориям: балл × вес, приложение А |");
    expect(appendix).toContain("| **Repo Health Score 64** | сумма по 6 категориям: балл × вес, приложение А |");
    expect(appendix.indexOf("| **HealthCraft Index 67**")).toBeLessThan(appendix.indexOf("| **Repo Health Score 64**"));
    expect(appendix).toContain("| **Документация 60** | сумма по показателям: балл × вес, приложение А | `documentation.score` → 60 |");
    // «Порядок расчета» у показателя не пустой — там вес в балле категории
    expect(appendix).toMatch(/\| README \(наличие и качество\): 7,8 КБ \| балл показателя × вес 45% в балле категории \| `documentation\.readme` → bytes 8000; балл 72 \|/);
  });

  test("«Как считается»: веса, порог, пределы оценки; без внутренних путей и LLM-жаргона (К9.3)", () => {
    const method = main.slice(main.indexOf("## Как считается"));
    expect(method).toContain("Документация 23%, Активность 23%, Задачи 23%, Состояние кода 31%");
    expect(method).toContain("меньше 40%");
    expect(method).toContain("Популярность (реакции и ответвления) в оценку не входит");
    expect(md).not.toMatch(/reports\/.+\.md/);
    // сноски «собран автоматически… нейросети не участвуют» в документе нет
    expect(md).not.toContain("Нейросети в расчете не участвуют.");
    expect(method.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(7);
  });
});

describe("MD-отчёт: репозитории без оценки", () => {
  test("индекс NULL – «Оценки нет», покрытие и порог; не 0 и без «Как считается» (К9.1)", () => {
    const repoId = seedRepo(t, { org: "report", repo: "dark", language: "C++" });
    const scanId = seedScan(t, repoId, { status: "partial", facts: [] });
    seedScore(t, repoId, scanId, {
      total: null,
      coverage: 0.375,
      noData: [
        "security: AppSec data unavailable (no AppSec access or no finished scan)",
        "documentation: git channel no-data",
        "code: git channel no-data",
      ],
      categories: {
        documentation: { score: null, no_data: "git channel no-data", submetrics: {} },
        code: { score: null, no_data: "git channel no-data", submetrics: {} },
      },
    });
    const dark = renderRepoReport(getRepoCard(t.db, "report", "dark", { access: GRANTED })!);
    expect(dark).toContain("HealthCraft Index: **Оценки нет**");
    expect(dark).toContain("Собрано 38% данных, а оценка рассчитывается начиная с 40%.");
    // не прочитан — своей фразой (у пустого репо — другая)
    expect(dark).toContain("Репозиторий не удалось прочитать");
    expect(dark).toContain("Оценка рассчитывается при объеме данных от 40%.");
    expect(dark).not.toContain("Score: 0");
    expect(dark).not.toContain("## Как считается");
    expect(dark).not.toContain("улучшать нечего");
  });

  // без оценки отчет не выдается: пустое состояние остается на карточке,
  // документ не собирается
  test("репо в каталоге без скана – отчета нет", () => {
    seedRepo(t, { org: "report", repo: "never-scanned" });
    expect(() => renderRepoReport(getRepoCard(t.db, "report", "never-scanned")!)).toThrow(REPORT_NO_SCORE);
  });
});

// ---------------------------------------------------------------------------
// Экранирование заголовков MD: tracking-pixel из title репозитория не
// выживает в выгрузке
// ---------------------------------------------------------------------------

describe("В4.4: экранирование заголовков MD", () => {
  test("title с ![img](url) и <img> не становится разметкой/HTML в отчёте", () => {
    const repoId = seedRepo(t, { org: "esc", repo: "pixel", title: "x ![t](https://evil.example/pixel) <img src=x> *em*" });
    // отчет выдается только при наличии оценки
    const escScan = seedScan(t, repoId, { facts: cardFacts() });
    seedScore(t, repoId, escScan, { total: 60 });
    const card = getRepoCard(t.db, "esc", "pixel", { access: GRANTED })!;
    const md = renderRepoReport(card);
    expect(md).not.toMatch(/!\[[^\]]*\]\(https:\/\/evil\.example\/pixel\)/);
    expect(md).not.toContain("<img");
    expect(md).toContain("\\!\\[t\\]");
    expect(md).toContain("&lt;img");
    void repoId;
  });
});

// ---------------------------------------------------------------------------
// repo.language и текст рекомендации экранируются, как title.
// ---------------------------------------------------------------------------

describe("Б5 (круг 2 В4.4): mdEscape-дыры", () => {
  test("S-1: repo.language с разметкой не становится картинкой/HTML в отчёте", () => {
    const repoId = seedRepo(t, { org: "esc2", repo: "lang", language: "x ![t](https://evil.example/l) <s>" });
    const scanId = seedScan(t, repoId, {});
    seedScore(t, repoId, scanId, { total: 60 });
    const md = renderRepoReport(getRepoCard(t.db, "esc2", "lang", { access: GRANTED })!);
    // язык — в паспорте анализа (приложение Г); ссылку убивает экранированная
    // «[», круглые скобки читаются как текст. В имени поля названо, что язык
    // из каталога, а не из скачанного репозитория (он есть и там, где скачать
    // не удалось)
    expect(md).toContain("| Язык (по каталогу SourceCraft) | x \\!\\[t\\](https://evil.example/l) &lt;s&gt; |");
    expect(md).not.toMatch(/!\[[^\]]*\]\(https:\/\/evil\.example\/l\)/);
    expect(md).not.toContain("<s>");
  });

  test("S-2: сохраненный текст рекомендации экранирован в действиях первого экрана", () => {
    const repoId = seedRepo(t, { org: "esc2", repo: "top" });
    const scanId = seedScan(t, repoId, {});
    seedScore(t, repoId, scanId, { total: 60 });
    seedRecommendation(t, scanId, { ruleId: "top-esc", priority: 1, problem: "p ![x](https://evil.example/t)", factRef: "docs.presence", deltaScore: 1.5 });
    const md = renderRepoReport(getRepoCard(t.db, "esc2", "top", { access: GRANTED })!);
    expect(md).toContain("p \\!\\[x\\](https://evil.example/t)");
    expect(md).not.toMatch(/!\[[^\]]*\]\(https:\/\/evil\.example\/t\)/);
  });
});
