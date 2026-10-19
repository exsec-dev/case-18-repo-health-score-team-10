// Строка позиции «#N из M, лучше X% похожих» и плашка лиги в плашке индекса.
// Место, доля и размер выборки проверяются на данных (карточка из временной БД →
// вид); фраза пустого состояния («похожих мало») – на статусе. Цвет плашки = цвет
// сегмента SVG-бейджа – по исходнику верстки (это стиль, не данные).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RANK_BADGE_COLORS } from "../src/api/public";
import { COHORT_MIN, percentileBelow } from "../src/api/cohort";
import { getRepoCard, type RepoCard } from "../src/api/repos";
import { cardView, noneBelow, positionView } from "../src/web/cardView";
import { fmtCount } from "../src/web/format";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { contrast } from "./theme-contrast";

let t: ApiTestDb;

function add(repo: string, total: number, opts: { language?: string; loc?: number; visibility?: string } = {}): void {
  const id = seedRepo(t, { org: "pos", repo, language: opts.language ?? "Go" });
  const facts = [{ key: "tree.stats", source: "git", value: { top_level: [], file_count: 3, bytes: 100, source_loc: opts.loc ?? 5000 } }];
  seedScore(t, id, seedScan(t, id, { facts }), { total });
  if (opts.visibility) t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(opts.visibility, id);
}

beforeAll(() => {
  t = makeApiDb();
  // когорта Go 1-10 тыс. строк: COHORT_MIN + 5 репо с индексами 90, 89, … — процент считается
  for (let i = 0; i < COHORT_MIN + 6; i++) add(`go${String(i).padStart(2, "0")}`, 90 - i);
  // малая когорта Rust: 5 репо
  for (let i = 0; i < 5; i++) add(`rs${i}`, 50 - i, { language: "Rust" });
  add("secret", 99, { visibility: "private" });
});

afterAll(() => t.close());

const card = (repo: string): RepoCard => getRepoCard(t.db, "pos", repo, { withRank: true })!;

describe("В5.9 HQ: строка позиции = поля карточки", () => {
  test("место и процент — числа карточки; подсказка называет когорту и ее размер", () => {
    for (const repo of ["go00", "go10", "go20"]) {
      const c = card(repo);
      const p = positionView(c)!;
      expect(p.rank).toBe(`#${fmtCount(c.score!.rank!)} из ${fmtCount(c.score!.rankedTotal!)}`);
      const pct = c.score!.cohort!.index.percentile!;
      expect(pct).not.toBeNull();
      expect(p.cohort).toBe(pct === 100 ? `лучший среди ${fmtCount(c.score!.cohort!.size!)} похожих` : pct === 0 ? (noneBelow(0, c.score!.cohort!.size) ? "у всех похожих индекс не ниже" : "лучше менее 1% похожих") : `лучше ${pct}% похожих`);
      expect(p.cohortHelp).toContain(`на Go (1-10 тыс. строк кода) с местом в рейтинге: ${fmtCount(c.score!.cohort!.size!)}`);
      expect(cardView(c).position).toEqual(p);
    }
  });

  test("лучший в когорте — «лучший среди N похожих»; худший — «у всех похожих индекс не ниже»", () => {
    const best = card("go00");
    expect(best.score!.cohort!.index.percentile).toBe(100);
    expect(positionView(best)!.cohort).toBe(`лучший среди ${fmtCount(best.score!.cohort!.size!)} похожих`);
    const worst = card(`go${COHORT_MIN + 5}`);
    expect(worst.score!.cohort!.index.percentile).toBe(0);
    expect(positionView(worst)!.cohort).toBe("у всех похожих индекс не ниже");
  });

  test("малая когорта — «похожих мало для сравнения», без процента; подсказка — размер и порог", () => {
    const c = card("rs0");
    expect(c.score!.cohort!.index.reason).toBe("small-cohort");
    const p = positionView(c)!;
    expect(p.cohort).toBe("похожих мало для сравнения");
    expect(p.cohortHelp).toContain(`в рейтинге ${c.score!.cohort!.size} `);
    expect(p.cohortHelp).toContain(`от ${COHORT_MIN}`);
    expect(p.cohort).not.toMatch(/%/);
  });

  test("лига — поле карточки; без лиги плашки нет", () => {
    const gold = card("go00");
    expect(gold.score!.rankBadge?.tier).toBe("gold");
    expect(positionView(gold)!.league).toMatchObject({ tier: "gold", label: gold.score!.rankBadge!.label });
    const none = card("rs4");
    expect(none.score!.rankBadge).toBeNull();
    expect(positionView(none)!.league).toBeNull();
  });

  test("приватный: места нет — строки позиции нет (ни места, ни процента)", () => {
    const c = getRepoCard(t.db, "pos", "secret", { withRank: true, access: { repo: "granted", cicd: "granted", appsec: "granted" } })!;
    expect(c.score!.rank).toBeNull();
    expect(positionView(c)).toBeNull();
  });

  // 19.10.2026: место среди похожих по категории убрано с карточки намеренно —
  // проверки строки категории (categoryCohortNote) сняты вместе с функцией
});

describe("процент 0: «у всех не ниже» – только если ниже нет ни одного", () => {
  // карточка с подмененной когортой: процент и размер выборки – как их отдал бы сервер
  function withCohort(pct: number, size: number): RepoCard {
    const c = card("go05");
    const cohort = c.score!.cohort!;
    return {
      ...c,
      score: {
        ...c.score!,
        cohort: {
          ...cohort,
          size,
          index: { percentile: pct, reason: null },
          categories: { ...cohort.categories, code: { percentile: pct, size, reason: null } },
        },
      },
    };
  }

  test("большая когорта: 1 репо ниже из 150 – процент 0, но текст не «у всех»", () => {
    // сам процент действительно 0: floor(100 · 1 / 150)
    expect(percentileBelow(50, [40, ...Array.from({ length: 149 }, () => 60)])).toBe(0);
    expect(noneBelow(0, 150)).toBe(false);
    const c = withCohort(0, 150);
    expect(positionView(c)!.cohort).toBe("лучше менее 1% похожих");
  });

  test("когорта до 100: процент 0 = ниже нет ни одного – «у всех не ниже»", () => {
    // один репо ниже из 100 – уже 1%
    expect(percentileBelow(50, [40, ...Array.from({ length: 99 }, () => 60)])).toBe(1);
    expect(noneBelow(0, 100)).toBe(true);
    const c = withCohort(0, 40);
    expect(positionView(c)!.cohort).toBe("у всех похожих индекс не ниже");
  });
});

// Аудит 16.10: «металл» лиги был ярче оценки и выходил из палитры SourceCraft.
// На экране лига — нейтральная метка; цвета сегментов остались только у SVG.
// Аудит 16.10: «металл» лиги был ярче оценки и выходил из палитры SourceCraft.
// На экране лига — метка без фона: тон металла у кубка и подписи, контраст
// текста AA в обеих темах; градиенты сегментов остались только у SVG.
describe("В5.9 HQ: лига на экране — тон без фона, металл — только у SVG-бейджа", () => {
  test("метка лиги без фона; у каждого тира свой тон, текст AA к фону в обеих темах", () => {
    const layout = readFileSync(join(import.meta.dir, "../src/web/layout.css"), "utf8");
    const theme = readFileSync(join(import.meta.dir, "../src/web/theme.css"), "utf8");
    const rule = layout.slice(layout.indexOf(".rh-league {"), layout.indexOf("}", layout.indexOf(".rh-league {")));
    expect(rule).not.toContain("background");
    expect(theme).not.toMatch(/--rh-league-\w+-bg/);
    for (const tier of Object.keys(RANK_BADGE_COLORS)) {
      expect(layout).toContain(`.rh-league_${tier},\n.rh-league_${tier} .g-icon {\n  color: var(--rh-league-${tier});\n}`);
      const [dark, light] = [...theme.matchAll(new RegExp(`--rh-league-${tier}: (#[0-9a-f]{6});`, "g"))].map((m) => m[1]!);
      expect(contrast(dark!, "#343434")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("В5.9 HQ: код бейджа с лигой", () => {
  test("лига — тот же адрес с ?show=rank; без чипов — прежний код", async () => {
    const { badgeCode } = await import("../src/web/slots");
    const base = { publicBaseUrl: "https://hc.example.ru/", org: "org", repo: "repo" };
    expect(badgeCode({ ...base, chips: new Set() }, "md")).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/repo/badge.svg)](https://hc.example.ru/repo/org/repo)");
    expect(badgeCode({ ...base, chips: new Set(["rank"]) }, "md")).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/repo/badge.svg?show=rank)](https://hc.example.ru/repo/org/repo)");
  });
});
