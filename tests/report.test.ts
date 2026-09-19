// report.test.ts — MD-отчёт (В3/Б4) по сид-набору: семь разделов §6,
// Score и категории, причины no-data, каждая рекомендация со своими
// fact_ref, «недостаточно данных» вместо нуля у репо со Score = NULL.
// Отчёт — чистая функция от карточки, поэтому сети и HTTP здесь нет.
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import {
  cardFacts,
  makeApiDb,
  seedRecommendation,
  seedRepo,
  seedScan,
  seedScore,
  type ApiTestDb,
} from "./api-fixtures";

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
  expectedImpact: "+2.3 Score (по одному)",
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

describe("MD-отчёт: структура", () => {
  test("семь разделов плана §6 на месте", () => {
    expect(md.startsWith("# Repo Health: report/sample")).toBe(true);
    for (const heading of [
      "## Итог",
      "## Категории",
      "## Разбор по категориям",
      "## Рекомендации",
      "## Доказательная база",
      "## Как считается и что это не значит",
    ]) {
      expect(md).toContain(heading);
    }
  });

  test("шапка: ссылка на репозиторий, скан, версия модели (режима больше нет — К1)", () => {
    expect(md).toContain("https://sourcecraft.dev/report/sample");
    expect(md).toContain(`#${scoredScan} от 2026-09-16`);
    expect(md).toContain("4.0.0-hci");
    expect(md).not.toContain("режим:");
  });
});

describe("MD-отчёт: числа и tri-state", () => {
  test("Score и покрытие в итоге", () => {
    expect(md).toContain("**Score в рейтинге (4 категории): 67 из 100**");
    // круг 2: полный Score складывается из показанных категорий (60·15+50·15+70·15+40·15+80·20)/80 = 61
    expect(md).toContain("Полный Score (с CI и Security): 61 из 100 при покрытии данными 80%");
    expect(md).toContain("покрытии данными 100%");
  });

  test("все шесть категорий с весом и вкладом после перенормировки", () => {
    for (const title of ["Документация", "CI/CD", "Security", "Активность", "Issues", "Code health"]) {
      expect(md).toContain(`| ${title} |`);
    }
    // 15 из 80 весовых пунктов с данными = 19% вклада; Security — 0%
    expect(md).toContain("| Документация | 15% | 60 | 19% | данные есть |");
    expect(md).toContain("| Security | 20% | — | 0% | нет данных |");
  });

  test("Security объясняется доступом, а не «данных нет по неизвестной причине»", () => {
    expect(md).toContain("без них категория исключена с перенормировкой, а не занижена");
    expect(md).toContain("Категория не снизила Score");
  });

  test("причина no-data у категории с данными тоже проговаривается (CI-потолок)", () => {
    expect(md).toContain("прогоны CI недоступны");
    expect(md).toContain("потолком 50");
  });

  test("подметрики показаны баллом 0–100, а не долей", () => {
    // readme в фикстуре — 0.72 доли → 72 на экране и в отчёте
    expect(md).toContain("| readme | 72 |");
  });
});

describe("MD-отчёт: рекомендации и доказательства", () => {
  test("каждая рекомендация со своим fact_ref и эффектом", () => {
    expect(md).toContain("### 1. Нет CONTRIBUTING");
    expect(md).toContain("+2.3 Score");
    expect(md).toContain("`docs.presence`");
    expect(md).toContain("### 2. Security без данных");
    expect(md).toContain("`appsec.findings` (факта нет по построению)");
  });

  test("доказательная база перечисляет факты с источником и временем сбора", () => {
    expect(md).toContain("| `docs.presence` | documentation | данные есть | git |");
    expect(md).toContain("| `cicd.runs` | cicd | данных нет | rest:cicd |");
  });

  test("история коммитов — агрегатом, сырьё в отчёт не едет", () => {
    expect(md).toContain('{"events":2');
    expect(md).not.toContain('"sha"');
  });

  test("раздел о методике: веса, перенормировка, порог и ограничения", () => {
    expect(md).toContain("Перенормировка (tri-state)");
    expect(md).toContain("ниже 40%");
    expect(md).toContain("Ограничения методики");
    expect(md).toMatch(/reports\/.+\.md/);
    expect(md).toContain("без участия LLM");
  });
});

describe("MD-отчёт: репозитории без Score", () => {
  test("Score = NULL — «недостаточно данных», а не 0", () => {
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
    expect(dark).toContain("**Недостаточно данных для оценки.**");
    expect(dark).toContain("Покрытие данными — 38% при пороге 40%");
    expect(dark).toContain("git-канал не отдал данные");
    expect(dark).not.toContain("Score: 0");
  });

  test("репо в каталоге без скана — отчёт объясняет отсутствие фактов", () => {
    seedRepo(t, { org: "report", repo: "never-scanned" });
    const never = renderRepoReport(getRepoCard(t.db, "report", "never-scanned")!);
    expect(never).toContain("ещё не сканировался");
    expect(never).toContain("## Как считается и что это не значит");
  });
});
