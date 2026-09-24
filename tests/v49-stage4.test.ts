// Ступень 4 В4.9 (финальный проход, §2 23.09): поведенческие тесты на числа и
// утверждения о данных, которые появились или изменились в круге по сводке
// аудитов (reports/2026-09-23-m49-stage4-synthesis.md). Правило AGENTS.md
// 21.09: число, названное местом или долей, закрывается тестом на данных.
import { describe, expect, test } from "bun:test";
import { DEFAULT_QUERY, getRepoCard, listRepos, type ReposQuery } from "../src/api/repos";
import { metricWeights, noRecommendationsKind, noRecommendationsText } from "../src/report/sections";
import { INDEX_WEIGHTS, SCORE_WEIGHTS } from "../src/score/model";
import { renderRepoReport } from "../src/report/markdown";
import { coverageLine as coverageLineRaw } from "../src/web/ratingParams";
import { authErrorText, noScoreText, reportFileName } from "../src/web/format";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { fixtureCard } from "./report-fixtures";

const q = (patch: Partial<ReposQuery> = {}): ReposQuery => ({ ...DEFAULT_QUERY, ...patch });
const GRANTED = { access: { cicd: "granted" as const, appsec: "granted" as const, repo: "granted" as const } };

describe("В-4: колонка «#» — место в рейтинге, а не номер строки выдачи", () => {
  test("при поиске и сортировке по другому полю место = место на карточке", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      const mk = (repo: string, total: number): void => {
        const id = seedRepo(t, { org: "rank", repo });
        seedScore(t, id, seedScan(t, id, { facts }), { total });
      };
      mk("alpha", 90);
      mk("beta", 70);
      mk("gamma", 50);
      // поиск оставляет одну строку; раньше «#» показывал бы 1
      const found = listRepos(t.db, q({ q: "gamma" })).items;
      expect(found.map((i) => i.rank)).toEqual([3]);
      expect(getRepoCard(t.db, "rank", "gamma", GRANTED)!.score!.rank).toBe(3);
      // сортировка по имени по убыванию: порядок строк другой, места — те же
      const byName = listRepos(t.db, q({ sort: "name", order: "desc" })).items;
      expect(byName.map((i) => [i.repo, i.rank])).toEqual([
        ["gamma", 3],
        ["beta", 2],
        ["alpha", 1],
      ]);
    } finally {
      t.close();
    }
  });
});

describe("В-4, ревью кода R15: место при равных индексах, фильтре и приватном", () => {
  test("равные индексы — порядок org/repo, как на карточке; приватного в выдаче нет; фильтр языка места не меняет", () => {
    const t = makeApiDb();
    try {
      const facts = cardFacts();
      const mk = (repo: string, total: number, language: string | null = null): number => {
        const id = seedRepo(t, { org: "tie", repo, language });
        seedScore(t, id, seedScan(t, id, { facts }), { total });
        return id;
      };
      mk("zeta", 80, "Go");
      mk("alpha", 80, "Rust");
      mk("mid", 60, "Go");
      const priv = mk("hidden", 95, "Go");
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      const all = listRepos(t.db, q()).items;
      expect(all.map((i) => [i.repo, i.rank])).toEqual([
        ["alpha", 1],
        ["zeta", 2],
        ["mid", 3],
      ]);
      for (const i of all) expect(getRepoCard(t.db, "tie", i.repo, GRANTED)!.score!.rank).toBe(i.rank);
      const goOnly = listRepos(t.db, q({ lang: ["Go"] })).items;
      expect(goOnly.map((i) => [i.repo, i.rank])).toEqual([
        ["zeta", 2],
        ["mid", 3],
      ]);
    } finally {
      t.close();
    }
    // Т-1 В5.3: синхронный тест на временной БД — на раннере CI 24.09 шел
    // 5532 мс при лимите по умолчанию 5000 (флака скорости, не дефект)
  }, 30_000);
});

describe("ревью кода R1, R2: «рекомендаций нет» — одна фраза и в отчете без индекса", () => {
  test("отчет «оценка есть, индекса нет» без рекомендаций печатает ту же фразу, что карточка", () => {
    const { card, close } = fixtureCard("null");
    try {
      const noRecs = { ...card, recommendations: [] };
      expect(renderRepoReport(noRecs)).toContain(noRecommendationsText(noRecs));
    } finally {
      close();
    }
  });

  test("слабость — по округленному баллу: 69,6 — это «70, здоров», не слабая", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const cats = Object.fromEntries(
        Object.entries(card.score!.categories).map(([k, c]) => [k, c.locked === undefined ? { ...c, score: 69.6 } : c]),
      );
      const healthy = { ...card, recommendations: [], score: { ...card.score!, categories: cats as NonNullable<typeof card.score>["categories"] } };
      expect(noRecommendationsKind(healthy)).toBe("healthy");
    } finally {
      close();
    }
  });
});

describe("В-5: строка охвата рейтинга", () => {
  test("неоцененные называются числом; ноль — фразы нет", () => {
    // разряды — неразрывным пробелом (`toLocaleString`), в ожиданиях — обычным
    const coverageLine = (r: { scored: number; nullScore: number; catalog: number }): string => coverageLineRaw(r).replace(/ /g, " ");
    expect(coverageLine({ scored: 27917, nullScore: 0, catalog: 27978 })).toBe("Оценено 27 917 из 27 978 репозиториев. Еще 61 пока не оценен.");
    expect(coverageLine({ scored: 10, nullScore: 1, catalog: 11 })).toBe("Оценено 10 из 11 репозиториев.");
    expect(coverageLine({ scored: 20, nullScore: 0, catalog: 21 })).toBe("Оценено 20 из 21 репозитория. Еще 1 пока не оценен.");
    expect(coverageLine({ scored: 20, nullScore: 0, catalog: 25 })).toBe("Оценено 20 из 25 репозиториев. Еще 5 пока не оценены.");
  });
});

describe("Ф5: имя файла отчета", () => {
  test("длинный слаг обрезается, чтобы браузер не отменял загрузку; короткий — как был", () => {
    expect(reportFileName("m47", "full", "pdf")).toBe("m47-full-health.pdf");
    const long = reportFileName("alittlebear", "razrabotan-" + "x".repeat(240), "md");
    expect(long.length).toBeLessThanOrEqual(130);
    expect(long.endsWith("-health.md")).toBe(true);
  });
});

describe("В-1: «рекомендаций нет» — по ситуации, одна фраза для карточки и отчета", () => {
  test("слабая категория — не «улучшать нечего»; закрытые каналы названы", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const noRecs = { ...card, recommendations: [] };
      const text = noRecommendationsText(noRecs);
      // у фикстуры есть категории ниже 70 и закрыты CI/CD и Безопасность
      expect(text).toContain("Автоматических рекомендаций для этих данных нет.");
      expect(text).toContain("Рекомендации по CI/CD и Безопасности видны участникам репозитория.");
      expect(text).not.toContain("улучшать нечего");
    } finally {
      close();
    }
  });
});

describe("Ф6: пустое состояние по статусу анализа", () => {
  test("сбой — не «анализ прошел»", () => {
    expect(noScoreText({ status: "bad" }).description).toContain("завершился сбоем");
    expect(noScoreText({ status: "bad" }).description).not.toContain("Анализ прошел");
    expect(noScoreText({ status: "partial" }).description).toContain("Анализ прошел");
  });
});

describe("Ф17: текст из адреса входа не печатается", () => {
  test("только известные сообщения сервера — дословно", () => {
    expect(authErrorText("Я ID не ответил – попробуйте войти еще раз")).toBe("Вход не удался: Я ID не ответил – попробуйте войти еще раз");
    expect(authErrorText("Позвоните по номеру 8-800")).toBe("Вход не удался – попробуйте войти еще раз.");
  });
});

// Завершающие правки В4.9 (пункт 2): веса в подсказках показателей = словари расчета
describe("веса в подсказках показателей", () => {
  test("HealthCraft Index — 4 категории, веса INDEX_WEIGHTS; Repo Health Score — 6, SCORE_WEIGHTS", () => {
    const index = metricWeights("HealthCraft Index");
    const full = metricWeights("Repo Health Score");
    expect(index.map((w) => [w.key, w.weight])).toEqual(index.map((w) => [w.key, `${INDEX_WEIGHTS[w.key as keyof typeof INDEX_WEIGHTS]}%`]));
    expect(index).toHaveLength(4);
    expect(full.map((w) => [w.key, w.weight])).toEqual(full.map((w) => [w.key, `${SCORE_WEIGHTS[w.key]}%`]));
    expect(full).toHaveLength(6);
    const sum = (ws: { weight: string }[]) => ws.reduce((a, w) => a + Number.parseInt(w.weight, 10), 0);
    expect([sum(index), sum(full)]).toEqual([100, 100]);
  });
});
