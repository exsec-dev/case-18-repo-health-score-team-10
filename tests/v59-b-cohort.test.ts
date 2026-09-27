// v59-b-cohort.test.ts — В5.9 Б (№11): «индекс лучше, чем у X% похожих».
// Процент, размер когорты и причины его отсутствия — числа о выборке, поэтому
// поведенческие тесты на данных (AGENTS.md 21.09, 23.09): ручной подсчет на
// известной когорте во временной БД, равные значения, порог и порог−1, каждая
// причина своей веткой, каждое значение видимости.
import { describe, expect, test } from "bun:test";
import { COHORT_MIN, buildCohort, percentileBelow, type CohortMember, type CohortSelf } from "../src/api/cohort";
import { DEFAULT_QUERY, getRepoCard, listRepos } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import type { IndexCategoryKey } from "../src/score/model";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const GRANTED: AccessResult = { repo: "granted", cicd: "granted", appsec: "granted" };

// ---------- чистые функции ----------

const cats = (v: number | null): Record<IndexCategoryKey, number | null> => ({ documentation: v, activity: v, issues: v, code: v });
const member = (index: number, c: number | null = 50): CohortMember => ({ index, categories: cats(c) });
const self = (over: Partial<CohortSelf> = {}): CohortSelf => ({ language: "Go", sizeBucket: "medium", codeEmpty: false, index: 50, categories: cats(50), ...over });

describe("percentileBelow: определение процента", () => {
  test("доля со СТРОГО меньшим округленным значением, вниз до целого (ручной подсчет)", () => {
    // 49,6 округляется в 50 — равное, не «хуже»; ниже только 10 и 20: 2 из 5 = 40%
    expect(percentileBelow(50, [10, 20, 49.6, 50, 60])).toBe(40);
    // 49,4 → 49 — уже ниже: 3 из 5
    expect(percentileBelow(50, [10, 20, 49.4, 50, 60])).toBe(60);
    // 1 из 3 = 33,3… → 33 (вниз: процент не завышается)
    expect(percentileBelow(50, [10, 60, 70])).toBe(33);
    // 2 из 3 = 66,6… → 66
    expect(percentileBelow(50, [10, 20, 70])).toBe(66);
  });

  test("равные значения — не «хуже»: все равны — 0%", () => {
    expect(percentileBelow(70, [70, 70, 70])).toBe(0);
    expect(percentileBelow(70.4, [70, 69.6])).toBe(0);
  });

  test("все ниже — 100%; пустая выборка — null, а не 0", () => {
    expect(percentileBelow(90, [10, 20])).toBe(100);
    expect(percentileBelow(90, [])).toBeNull();
  });
});

describe("buildCohort: причины — каждая своей веткой", () => {
  test("порог малой когорты: ровно COHORT_MIN — процент есть, COHORT_MIN−1 — small-cohort", () => {
    const at = buildCohort(self(), Array.from({ length: COHORT_MIN }, (_, i) => member(i < 15 ? 10 : 90)));
    expect(at.size).toBe(COHORT_MIN);
    expect(at.index).toEqual({ percentile: 50, reason: null });
    const below = buildCohort(self(), Array.from({ length: COHORT_MIN - 1 }, () => member(10)));
    expect(below.size).toBe(COHORT_MIN - 1);
    expect(below.index).toEqual({ percentile: null, reason: "small-cohort" });
    expect(below.categories.code).toEqual({ percentile: null, size: COHORT_MIN - 1, reason: "small-cohort" });
  });

  test("порог — параметр (для настройки и тестов)", () => {
    expect(buildCohort(self(), [member(10), member(90)], 2).index).toEqual({ percentile: 50, reason: null });
    expect(buildCohort(self(), [member(10)], 2).index.reason).toBe("small-cohort");
  });

  test("нет языка или корзины размера — no-cohort (незнание, не 0%), размер null", () => {
    const many = Array.from({ length: 40 }, () => member(10));
    for (const c of [buildCohort(self({ language: null }), many), buildCohort(self({ sizeBucket: null }), many)]) {
      expect(c.size).toBeNull();
      expect(c.index).toEqual({ percentile: null, reason: "no-cohort" });
      expect(c.categories.documentation).toEqual({ percentile: null, size: null, reason: "no-cohort" });
    }
  });

  test("«без кода» — code-empty, даже при известном языке и большой когорте", () => {
    const c = buildCohort(self({ codeEmpty: true, sizeBucket: "none", index: 0 }), Array.from({ length: 40 }, () => member(0)));
    expect(c.size).toBeNull();
    expect(c.index).toEqual({ percentile: null, reason: "code-empty" });
    expect(c.categories.activity.reason).toBe("code-empty");
  });

  test("категория: когорта — у кого балл есть; свой балл NULL — no-data", () => {
    const members = [
      ...Array.from({ length: 30 }, (_, i) => ({ index: 10, categories: { documentation: i < 6 ? 30 : 60, activity: 60, issues: i < 5 ? null : 20, code: null } })),
      ...Array.from({ length: 5 }, () => ({ index: 10, categories: { documentation: null, activity: 60, issues: 20, code: null } })),
    ] satisfies CohortMember[];
    const c = buildCohort(self({ categories: { documentation: 60, activity: 60, issues: 50, code: 50 } }), members);
    expect(c.size).toBe(35);
    // документация: 30 с баллом (5 NULL не в выборке), ниже 6 → 20%
    expect(c.categories.documentation).toEqual({ percentile: 20, size: 30, reason: null });
    // активность: 35 равных — 0%
    expect(c.categories.activity).toEqual({ percentile: 0, size: 35, reason: null });
    // задачи: 30 с баллом, все ниже — 100%
    expect(c.categories.issues).toEqual({ percentile: 100, size: 30, reason: null });
    // код: ни у кого балла — малая выборка категории, хотя когорта индекса большая
    expect(c.categories.code).toEqual({ percentile: null, size: 0, reason: "small-cohort" });
    const own = buildCohort(self({ categories: { documentation: null, activity: 60, issues: 50, code: 50 } }), members);
    expect(own.categories.documentation).toEqual({ percentile: null, size: 30, reason: "no-data" });
  });
});

// ---------- временная БД: карточка ----------

interface Spec {
  org?: string;
  repo: string;
  language?: string | null;
  /** строки кода в tree.stats; null — факта размера нет */
  loc?: number | null;
  total: number | null;
  categories?: Partial<Record<IndexCategoryKey, number | null>>;
  codeEmpty?: boolean;
  visibility?: string;
  active?: boolean;
  eligible?: boolean;
}

function seedCohortRepo(t: ApiTestDb, s: Spec): number {
  const id = seedRepo(t, { org: s.org ?? "coh", repo: s.repo, language: s.language === undefined ? "Go" : s.language });
  const loc = s.loc === undefined ? 5000 : s.loc;
  const facts = loc === null ? [] : [{ key: "tree.stats", source: "git", value: { top_level: [], file_count: 3, bytes: 100, source_loc: loc } }];
  const scan = seedScan(t, id, { facts, ratingEligible: s.eligible !== false });
  const categories: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s.categories ?? {})) categories[k] = { score: v, submetrics: {} };
  seedScore(t, id, scan, { total: s.total, categories });
  if (s.codeEmpty) t.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(scan);
  if (s.visibility !== undefined) t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(s.visibility, id);
  if (s.active === false) t.db.query("UPDATE repos SET rating_active = 0, evict_reason = 'test' WHERE id = ?").run(id);
  return id;
}

/**
 * Известная когорта Go / 1-10 тыс. строк: сам репо (индекс 60) + 35 похожих —
 * 10 с индексом 40, 15 с 60 (равные), 10 с 80. Ручной подсчет: ниже 10 из 35
 * = 28,57…% → 28. Плюс шум, который в когорту входить НЕ должен.
 */
function seedKnownCohort(t: ApiTestDb): void {
  seedCohortRepo(t, { repo: "self", total: 60, categories: { documentation: 60, issues: 50 } });
  let n = 0;
  const add = (total: number, categories?: Spec["categories"]) => seedCohortRepo(t, { repo: `m${String(++n).padStart(2, "0")}`, total, categories });
  for (let i = 0; i < 10; i++) add(40, { documentation: i < 6 ? 30 : null, issues: null });
  for (let i = 0; i < 15; i++) add(60, { issues: i < 5 ? null : 20 });
  for (let i = 0; i < 10; i++) add(80);
  // шум: другой размер, другой язык, приватный/internal, выбывший, непригодный скан, без индекса
  for (let i = 0; i < 4; i++) seedCohortRepo(t, { repo: `small${i}`, loc: 500, total: 10 });
  for (let i = 0; i < 4; i++) seedCohortRepo(t, { repo: `py${i}`, language: "Python", total: 10 });
  seedCohortRepo(t, { repo: "priv", total: 10, visibility: "private" });
  seedCohortRepo(t, { repo: "intl", total: 10, visibility: "internal" });
  seedCohortRepo(t, { repo: "gone", total: 10, active: false });
  seedCohortRepo(t, { repo: "inelig", total: 10, eligible: false });
  seedCohortRepo(t, { repo: "nullidx", total: null });
}

describe("карточка: когорта на временной БД", () => {
  test("известная когорта: процент по ручному подсчету, размер = выдача рейтинга по тем же фильтрам без себя", () => {
    const t = makeApiDb();
    try {
      seedKnownCohort(t);
      const card = getRepoCard(t.db, "coh", "self")!;
      const cohort = card.score!.cohort!;
      expect(cohort.language).toBe("Go");
      expect(cohort.sizeBucket).toBe("medium");
      expect(cohort.size).toBe(35);
      expect(cohort.index).toEqual({ percentile: 28, reason: null });
      // «равно источнику»: та же выборка, что у фильтров рейтинга «Go» + «1-10 тыс.», минус сам репо
      const rated = listRepos(t.db, { ...DEFAULT_QUERY, lang: ["Go"], size: ["medium"], perPage: 100 });
      expect(cohort.size).toBe(rated.total - 1);
      // категории: у документации 6 с баллом 30 + 25 по умолчанию (60), NULL у 4 — не в выборке:
      // ниже 6 из 31 = 19,35…% → 19
      expect(cohort.categories.documentation).toEqual({ percentile: 19, size: 31, reason: null });
      // задачи: NULL у 10 + 5 → 20 с баллом < 30 — малая выборка категории
      expect(cohort.categories.issues).toEqual({ percentile: null, size: 20, reason: "small-cohort" });
      // активность по умолчанию у всех 70: равные — 0%
      expect(cohort.categories.activity).toEqual({ percentile: 0, size: 35, reason: null });
    } finally {
      t.close();
    }
  });

  test("порог на данных: 30 похожих — процент есть, после выбывания одного (29) — small-cohort", () => {
    const t = makeApiDb();
    try {
      seedCohortRepo(t, { repo: "self", total: 50 });
      for (let i = 0; i < COHORT_MIN; i++) seedCohortRepo(t, { repo: `m${i}`, total: i < 3 ? 10 : 90 });
      const at = getRepoCard(t.db, "coh", "self")!.score!.cohort!;
      expect(at.size).toBe(COHORT_MIN);
      expect(at.index).toEqual({ percentile: 10, reason: null });
      t.db.query("UPDATE repos SET rating_active = 0, evict_reason = 'test' WHERE repo_slug = 'm29'").run();
      const below = getRepoCard(t.db, "coh", "self")!.score!.cohort!;
      expect(below.size).toBe(COHORT_MIN - 1);
      expect(below.index).toEqual({ percentile: null, reason: "small-cohort" });
    } finally {
      t.close();
    }
  });

  test("нет языка, нет факта размера, «без кода» — своя причина, место при этом есть", () => {
    const t = makeApiDb();
    try {
      for (let i = 0; i < 35; i++) seedCohortRepo(t, { repo: `m${i}`, total: 40 });
      seedCohortRepo(t, { repo: "nolang", language: null, total: 50 });
      seedCohortRepo(t, { repo: "nosize", loc: null, total: 50 });
      seedCohortRepo(t, { repo: "empty", total: 0, codeEmpty: true });
      for (const [repo, reason] of [["nolang", "no-cohort"], ["nosize", "no-cohort"], ["empty", "code-empty"]] as const) {
        const score = getRepoCard(t.db, "coh", repo)!.score!;
        expect(score.rank).not.toBeNull();
        expect(score.cohort!.index).toEqual({ percentile: null, reason });
        expect(score.cohort!.size).toBeNull();
      }
      expect(getRepoCard(t.db, "coh", "empty")!.score!.cohort!.sizeBucket).toBe("none");
    } finally {
      t.close();
    }
  });

  test("видимость: public — когорта есть; internal и private — null (места в выборке нет)", () => {
    const t = makeApiDb();
    try {
      for (let i = 0; i < 35; i++) seedCohortRepo(t, { repo: `m${i}`, total: 40 });
      seedCohortRepo(t, { repo: "v-public", total: 90 });
      seedCohortRepo(t, { repo: "v-internal", total: 90, visibility: "internal" });
      seedCohortRepo(t, { repo: "v-private", total: 90, visibility: "private" });
      const pub = getRepoCard(t.db, "coh", "v-public", { access: GRANTED })!.score!;
      expect(pub.cohort!.index).toEqual({ percentile: 100, reason: null });
      for (const repo of ["v-internal", "v-private"]) {
        const score = getRepoCard(t.db, "coh", repo, { access: GRANTED })!.score!;
        // индекс участник видит, а процента и места в чужой выборке нет
        expect(score.healthcraftIndex).toBe(90);
        expect(score.rank).toBeNull();
        expect(score.cohort).toBeNull();
      }
      // приватные в когорту публичного не входят: 35 похожих, не 37
      expect(pub.cohort!.size).toBe(35);
    } finally {
      t.close();
    }
  });

  test("без места — когорты нет: без индекса, выбывший (404), кабинет (withRank: false)", () => {
    const t = makeApiDb();
    try {
      for (let i = 0; i < 35; i++) seedCohortRepo(t, { repo: `m${i}`, total: 40 });
      seedCohortRepo(t, { repo: "nullidx", total: null });
      seedCohortRepo(t, { repo: "gone", total: 90, active: false });
      expect(getRepoCard(t.db, "coh", "nullidx")!.score!.cohort).toBeNull();
      expect(getRepoCard(t.db, "coh", "gone")).toBeNull();
      expect(getRepoCard(t.db, "coh", "m1", { withRank: false })!.score!.cohort).toBeNull();
    } finally {
      t.close();
    }
  });
});
