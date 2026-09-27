// v59-hq-position-view.test.ts — В5.9 (HQ, UI): строка позиции «#N из M, лучше X% похожих»
// и плашка лиги в плашке индекса (§2 «В5.9 — выбор вариантов», п.3-5). Правило 21.09:
// место, доля и размер выборки — тестом на данных (карточка из временной БД → вид); фраза
// пустого состояния («похожих мало») — тестом на статусе (23.09). Цвет плашки = цвет
// сегмента SVG-бейджа — source-assert на вёрстку (допустимо: это стиль, не данные).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RANK_BADGE_COLORS } from "../src/api/public";
import { COHORT_MIN } from "../src/api/cohort";
import { getRepoCard, type RepoCard } from "../src/api/repos";
import { cardView, categoryCohortNote, positionView } from "../src/web/cardView";
import { fmtCount } from "../src/web/format";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

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
      expect(p.cohort).toBe(pct === 100 ? `лучший среди ${fmtCount(c.score!.cohort!.size!)} похожих` : pct === 0 ? "у всех похожих индекс не ниже" : `лучше ${pct}% похожих`);
      expect(p.cohortHelp).toContain(`на Go размером 1-10 тыс. строк с местом в рейтинге: ${fmtCount(c.score!.cohort!.size!)}`);
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

  test("процент по категории — поле когорты категории; без процента и не «мало» — строки нет", () => {
    const c = card("go05");
    for (const [key, stat] of Object.entries(c.score!.cohort!.categories)) {
      const note = categoryCohortNote(c, key as never);
      if (stat.percentile !== null) expect(note).toBe(stat.percentile === 0 ? "Среди похожих – у всех балл не ниже" : `Среди похожих – лучше ${stat.percentile}%`);
      else if (stat.reason === "small-cohort") expect(note).toBe("Похожих с данными по категории мало для сравнения");
      else expect(note).toBeNull();
    }
  });
});

describe("В5.9 HQ: плашка лиги — цвет сегмента SVG-бейджа", () => {
  test("у каждой лиги градиент плашки проходит через цвет сегмента SVG", () => {
    const layout = readFileSync(join(import.meta.dir, "../src/web/layout.css"), "utf8");
    const theme = readFileSync(join(import.meta.dir, "../src/web/theme.css"), "utf8");
    for (const [tier, c] of Object.entries(RANK_BADGE_COLORS)) {
      const rule = layout.slice(layout.indexOf(`.rh-league_${tier} {`), layout.indexOf("}", layout.indexOf(`.rh-league_${tier} {`)));
      expect(rule).toContain(`var(--rh-league-${tier}-bg)`);
      // светлая тема (первое вхождение токена): яркий край градиента = фон сегмента SVG, текст = текст SVG
      const bg = theme.match(new RegExp(`--rh-league-${tier}-bg:([^;]+);`))![1]!;
      expect(bg.toLowerCase()).toContain(c.bg.toLowerCase());
      // круг 4: текст плашки = цвет иконки = текст сегмента SVG (один токен ink)
      expect(rule).toContain(`color: var(--rh-league-${tier}-ink)`);
      expect(theme.match(new RegExp(`--rh-league-${tier}-ink:([^;]+);`))![1]!.trim().toLowerCase()).toBe(c.fg.toLowerCase());
    }
  });
});

describe("В5.9 HQ: код бейджа «Индекс и место»", () => {
  test("rank — тот же адрес с ?style=rank; по умолчанию — прежний код", async () => {
    const { badgeMarkdown } = await import("../src/web/slots");
    expect(badgeMarkdown("https://hc.example.ru/", "org", "repo")).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/repo/badge.svg)](https://hc.example.ru/repo/org/repo)");
    expect(badgeMarkdown("https://hc.example.ru/", "org", "repo", "rank")).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/repo/badge.svg?style=rank)](https://hc.example.ru/repo/org/repo)");
  });
});
