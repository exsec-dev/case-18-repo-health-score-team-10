// report.test.ts — MD-отчёт (В3/Б4; В4.9 — новая модель, К9.1-К9.8) по
// сид-набору: разделы по эталону вида, показатель с плашкой, категории,
// причины «нет данных», действия, приложение с путем «число → факт»,
// «оценки нет» вместо нуля. Отчёт — чистая функция от карточки.
//
// В4.9: утверждения прежней структуры («Итог», «Доказательная база», «Вклад
// после перенормировки», «Порядок задан движком», «(источник: rule)»)
// перевернуты с заменой — закрытый список в reports/m49-worker-report.md.
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
  problem: "Нет CONTRIBUTING — как вносить правки не описано",
  factRef: "docs.presence",
  deltaScore: 2.25,
  expectedImpact: "+2.3 к HealthCraft Index (по одному)",
});
seedRecommendation(t, scoredScan, {
  ruleId: "connect-appsec",
  priority: 2,
  channel: "appsec", // канальное правило: на карточке собирается движком на показанных фактах (круг 2)
  problem: "Security без данных: AppSec SourceCraft не подключён (публичный режим)",
  factRef: "appsec.findings",
  opensCategory: "security",
  expectedImpact: "coverage 1.00→1.00 — категория Security 20%",
});
// отчёт зрителя с доступом к каналам: полный разбор (матрица доступа — api.test.ts)
const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;
const md = renderRepoReport(getRepoCard(t.db, "report", "sample", { access: GRANTED })!);
const main = md.slice(0, md.indexOf("## Приложение"));
const appendix = md.slice(md.indexOf("## Приложение"));

describe("MD-отчёт: структура", () => {
  test("разделы эталона вида — по порядку, приложение последним", () => {
    expect(md.startsWith("# report/sample")).toBe(true);
    const order = [
      "Repo Health Score: **",
      // п.3 круга 5: показатель назван прямо в заголовке полосы
      "## Вклад категорий в HealthCraft Index",
      "## Категории",
      // В11/В15 гейта: блока «Что сделать первым» нет, раздел рекомендаций один и стоит после категорий
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

  test("шапка: ссылка на репозиторий и дата анализа; номер анализа и версия методики — в приложении (К9.4)", () => {
    expect(main).toContain("[sourcecraft.dev/report/sample](https://sourcecraft.dev/report/sample)");
    // В2 гейта: имя документа и плашка доступа зрителя; п.1 круга 2: дата без
    // слова «Анализ», плашка после нее (в PDF — второй строкой шапки)
    expect(main).toContain("Отчет HealthCraft. 16 сент. 2026 (полный).");
    expect(main).not.toContain(`#${scoredScan}`);
    expect(main).not.toContain("4.0.0-hci");
    expect(appendix).toContain(`| Последний анализ | #${scoredScan}, завершен 12:00 16 сент. 2026 |`);
    expect(appendix).toContain("| Версия методики | 4.0.0-hci |");
    expect(md).not.toContain("режим:");
  });
});

describe("MD-отчёт: числа и tri-state", () => {
  // ПЕРЕВЕРНУТО С ЗАМЕНОЙ решением владельца 22.09 (TASK.md §2, «круг 4
  // гейта»): порядок везде «сначала публичный, потом полный», поэтому крупно
  // слева — HealthCraft Index, справа — Repo Health Score. Контракт К9.1 §0
  // спеки в части «какой показатель крупно» этой записью отменен.
  test("зрителю с обоими показателями первым — HealthCraft Index, вторым Repo Health Score (TASK.md §2, круг 4)", () => {
    const at = (s: string) => main.indexOf(s);
    expect(main).toContain("HealthCraft Index: **67 из 100 · требует внимания**");
    // полный Score складывается из показанных категорий (60·15+50·15+70·15+40·15+80·20)/80 = 61
    expect(main).toContain("Repo Health Score: **61 из 100 · требует внимания**");
    expect(at("HealthCraft Index: **67")).toBeLessThan(at("Repo Health Score: **61"));
    // и в строке-пояснении публичный показатель назван первым
    expect(main).toContain("HealthCraft Index считается по открытым данным – по нему строится рейтинг. Repo Health Score учитывает 6 категорий, включая CI/CD и Безопасность.");
    // полос вклада две, публичная первой
    expect(at("## Вклад категорий в HealthCraft Index")).toBeGreaterThan(-1);
    expect(at("## Вклад категорий в HealthCraft Index")).toBeLessThan(at("## Вклад категорий в Repo Health Score"));
  });

  test("все шесть категорий: балл и слово шкалы; у Безопасности без данных — «—», а не 0 (tri-state)", () => {
    for (const title of ["Документация", "CI/CD", "Безопасность", "Активность", "Задачи", "Состояние кода"]) expect(main).toContain(`| ${title} |`);
    expect(main).toContain("| Документация | 60 | требует внимания |");
    expect(main).toContain("| Безопасность | — | нет данных |");
    // вес — в приложении А: 15 из 80 весовых пунктов с данными = 18,8%; у категории без данных веса нет.
    // Г1.1 гейта: «баллов в итог» — те же десятые, что в полосе вкладов (наибольший остаток), поэтому 11,2, а не 11,3
    expect(appendix).toContain("| Документация | 60,0 | 18,8% | 11,2 |");
    expect(main).toContain("Документация +11,2");
    expect(appendix).toContain("| Безопасность | — | не входит | — |");
    expect(md).not.toMatch(/Безопасность \| [^|]* \| 0%/);
  });

  test("Безопасность без данных — причина и опорная фраза «не участвует и ее не снижает» (К9.2)", () => {
    // Г1.8 гейта: зрителю с доступом причина прочерка — та же, что в действии движка
    expect(main).toContain("Данных AppSec по репозиторию нет: проверка не подключена или не завершена. Категория в оценке не участвует и ее не снижает.");
  });

  test("причина потолка у категории с данными тоже проговаривается (CI без результатов запусков)", () => {
    expect(main).toContain("Результаты запусков CI недоступны");
    expect(main).toContain("не больше 50 из 100");
  });

  test("подметрики показаны баллом 0–100, а не долей; название — из словаря", () => {
    // readme в фикстуре — 0.72 доли → 72 в разборе
    expect(main).toContain("| README (наличие и качество) | 8000 байт | 72 | 45% |");
  });
});

describe("MD-отчёт: действия и приложение", () => {
  test("действия — рекомендации движка с эффектом; ключей правил и фактов в основном тексте нет", () => {
    // В16 гейта: подпись эффекта — перед числом
    expect(main).toMatch(/^1\. \*\*.+\*\* .+ Ожидаемый эффект: \+\d+,\d+ к .+\.$/m);
    expect(main).not.toContain("`docs.presence`");
    expect(main).not.toContain("(источник: rule)");
    expect(main).not.toContain("contributing-missing`");
  });

  test("приложение В: факты таблицами «поле – значение» с источником и временем сбора", () => {
    expect(appendix).toContain("`docs.presence` – Документация, данные есть, история git, 12:00 16 сент. 2026");
    expect(appendix).toContain("`cicd.runs` – CI/CD, данных нет, API SourceCraft, 12:00 16 сент. 2026");
    expect(appendix).toContain("| contributing | нет |");
  });

  test("история коммитов — итогом, сырьё в отчёт не едет", () => {
    expect(appendix).toContain("`activity.git.timeline`");
    expect(appendix).toContain("| events | 2 |");
    expect(md).not.toContain('"sha"');
    expect(md).not.toContain("a1");
  });

  test("приложение Б: путь «число → откуда взято» для итога, категорий и показателей", () => {
    // Круг 4: удваивается только строка самого показателя, публичная первой;
    // в «порядке расчета» названо, по скольким категориям он считается
    expect(appendix).toContain("| **HealthCraft Index 67** | сумма по 4 открытым категориям: балл × вес, приложение А |");
    expect(appendix).toContain("| **Repo Health Score 61** | сумма по 6 категориям: балл × вес, приложение А |");
    expect(appendix.indexOf("| **HealthCraft Index 67**")).toBeLessThan(appendix.indexOf("| **Repo Health Score 61**"));
    expect(appendix).toContain("| **Документация 60** | сумма по показателям: балл × вес, приложение А | `documentation.score` → 60 |");
    // Г1.11 гейта: «Порядок расчета» у показателя больше не пустой — там вес в балле категории
    expect(appendix).toMatch(/\| README \(наличие и качество\): 8000 байт \| балл показателя × вес 45% в балле категории \| `documentation\.readme` → bytes 8000; балл 72 \|/);
  });

  test("«Как считается»: веса, порог, пределы оценки; без внутренних путей и LLM-жаргона (К9.3)", () => {
    const method = main.slice(main.indexOf("## Как считается"));
    expect(method).toContain("Документация 23%, Активность 23%, Задачи 23%, Состояние кода 31%");
    expect(method).toContain("меньше 40%");
    expect(method).toContain("Популярность (реакции и ответвления) в оценку не входит");
    expect(md).not.toMatch(/reports\/.+\.md/);
    // В17 гейта: сноска «собран автоматически… нейросети не участвуют» из документа убрана
    expect(md).not.toContain("Нейросети в расчете не участвуют.");
    expect(method.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(7);
  });
});

describe("MD-отчёт: репозитории без оценки", () => {
  test("индекс NULL — «Оценки нет», покрытие и порог; не 0 и без «Как считается» (К9.1)", () => {
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
    expect(dark).toContain("Не удалось скачать репозиторий");
    expect(dark).toContain("Оценка рассчитывается при объеме данных от 40%.");
    expect(dark).not.toContain("Score: 0");
    expect(dark).not.toContain("## Как считается");
    expect(dark).not.toContain("улучшать нечего");
  });

  // Решение владельца 22.09 (круг 3 гейта): «Не выдавать отчет, если оценки
  // нет» — пустое состояние остается на карточке, документ не собирается.
  test("репо в каталоге без скана — отчета нет", () => {
    seedRepo(t, { org: "report", repo: "never-scanned" });
    expect(() => renderRepoReport(getRepoCard(t.db, "report", "never-scanned")!)).toThrow(REPORT_NO_SCORE);
  });
});

// ---------------------------------------------------------------------------
// В4.4 (кластер K/З7): экранирование заголовков MD — tracking-pixel из
// title репозитория не выживает в выгрузке
// ---------------------------------------------------------------------------

describe("В4.4: экранирование заголовков MD", () => {
  test("title с ![img](url) и <img> не становится разметкой/HTML в отчёте", () => {
    const repoId = seedRepo(t, { org: "esc", repo: "pixel", title: "x ![t](https://evil.example/pixel) <img src=x> *em*" });
    // с решения 22.09 отчет выдается только при наличии оценки
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
// Круг 2 В4.4 (Б5): mdEscape-дыры — repo.language (S-1) и текст рекомендации
// (S-2) экранируются, как title.
// ---------------------------------------------------------------------------

describe("Б5 (круг 2 В4.4): mdEscape-дыры", () => {
  test("S-1: repo.language с разметкой не становится картинкой/HTML в отчёте", () => {
    const repoId = seedRepo(t, { org: "esc2", repo: "lang", language: "x ![t](https://evil.example/l) <s>" });
    const scanId = seedScan(t, repoId, {});
    seedScore(t, repoId, scanId, { total: 60 });
    const md = renderRepoReport(getRepoCard(t.db, "esc2", "lang", { access: GRANTED })!);
    // В4.9: язык — в паспорте анализа (приложение Г)
    // Г1.10 гейта: ссылку убивает экранированная «[», круглые скобки читаются как текст
    // А14 аудита: в имени поля названо, откуда язык, — из каталога, а не из
    // скачанного репозитория (он есть и там, где скачать не удалось)
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
