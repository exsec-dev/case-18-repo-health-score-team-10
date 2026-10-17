// Фильтры рейтинга по размеру кода и наличию CI (ТЗ §7, ЗН-1). Поведенческие
// тесты на временной БД: каждая корзина – на данных, «нет факта» не попадает никуда,
// место фильтром не меняется (= место без фильтра = место на карточке),
// комбинации с языком/поиском/AI, счетчики фасетов = число строк выборки,
// разбор адреса, пустая выдача. Сиды — tests/api-fixtures.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_QUERY, getRepoCard, listRepos, parseReposQuery, type RatingResponse, type ReposQuery } from "../src/api/repos";
import { SIZE_BUCKETS, SIZE_TITLES, sizeBucketOf, type SizeBucket } from "../src/api/rating-filters";
import { activeRatingFilters, ciOptions, nothingFoundDescription, normalizeRatingSearch, resetFiltersHref, sizeOptions, sizeSummary } from "../src/web/ratingParams";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb, type FactSpec } from "./api-fixtures";

const treeFact = (value: unknown, status: FactSpec["status"] = "ok"): FactSpec => ({ key: "tree.stats", source: "git", value, status });
const ciFact = (has: unknown, status: FactSpec["status"] = "ok"): FactSpec => ({
  key: "cicd.configs",
  source: "git",
  value: status === "ok" ? { paths: has === true ? [".sourcecraft/ci.yaml"] : [], has_ci_yaml: has, has_steps: false } : { reason: "limits" },
  status,
});
const tree = (sourceLoc: number | null, extra: Record<string, unknown> = {}) =>
  treeFact({ top_level: [{ name: "src", type: "tree" }], file_count: 10, bytes: 1000, loc: 123_456, source_files: 3, source_loc: sourceLoc, source_unread: 0, ...extra });

interface Seed {
  repo: string;
  total: number | null;
  facts: FactSpec[];
  codeEmpty?: boolean;
  language?: string | null;
  title?: string;
}

function seed(t: ApiTestDb, s: Seed): { repoId: number; scanId: number } {
  const repoId = seedRepo(t, { org: "f", repo: s.repo, language: s.language ?? null, title: s.title ?? s.repo });
  const scanId = seedScan(t, repoId, { facts: s.facts });
  seedScore(t, repoId, scanId, { total: s.total });
  if (s.codeEmpty) t.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(scanId);
  return { repoId, scanId };
}

const all = (t: ApiTestDb, patch: Partial<ReposQuery> = {}): RatingResponse => listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100, ...patch });
const names = (r: RatingResponse): string[] => [...r.items, ...r.nullItems].map((i) => i.repo).sort();

// ---------- корзины размера на данных ----------

describe("размер: каждая корзина на данных, незнание — ни в одной", () => {
  const t = makeApiDb();
  afterAll(() => t.close());
  // индекс убывает по алфавиту — место предсказуемо
  const rows: [string, number | null, FactSpec[], boolean?][] = [
    ["empty-model", 0, [tree(0)], true], // модель: «кода нет», индекс 0
    ["empty-git", 0, [treeFact({ reason: "empty" }, "no-data")], true], // пустой репо: факта нет, признак модели есть
    ["s0999", 90, [tree(999)]],
    ["m1000", 89, [tree(1000)]],
    ["m9999", 88, [tree(9999)]],
    ["l10000", 87, [tree(10_000)]],
    ["l99999", 86, [tree(99_999)]],
    ["h100000", 85, [tree(100_000)]],
    ["old-loc", 84, [treeFact({ top_level: [], file_count: 5, bytes: 10, loc: 5000 })]], // факт до сборщика 3: loc
    ["unknown-null", 83, [tree(null)]], // чтение оборвалось
    ["unknown-unread", 82, [tree(0, { source_unread: 2 })]], // 0 строк при непрочитанных файлах кода
    ["unknown-nodata", 81, [treeFact({ reason: "limits" }, "no-data")]],
    ["unknown-bad", 80, [treeFact({ reason: "bad-channel" }, "bad")]],
    ["unknown-nofact", 79, []],
    ["null-index-small", null, [tree(10)]], // без оценки — фильтр действует и на группу «Без оценки»
  ];
  for (const [repo, total, facts, codeEmpty] of rows) seed(t, { repo, total, facts, codeEmpty });
  // битое значение факта: рейтинг не падает, репо — незнание
  const broken = seed(t, { repo: "unknown-broken", total: 78, facts: [] });
  t.db.query("INSERT INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, 'code', 'tree.stats', '{not json', 'ok', 'git', '2026')").run(broken.scanId);

  const expected: Record<SizeBucket, string[]> = {
    none: ["empty-git", "empty-model"],
    small: ["null-index-small", "s0999"],
    medium: ["m1000", "m9999", "old-loc"],
    large: ["l10000", "l99999"],
    huge: ["h100000"],
  };

  for (const bucket of SIZE_BUCKETS) {
    test(`корзина «${SIZE_TITLES[bucket]}» — ровно свои репо`, () => {
      expect(names(all(t, { size: [bucket] }))).toEqual(expected[bucket]);
    });
  }

  test("репо без данных о размере не попадает ни в одну корзину; все корзины вместе — все, кроме них", () => {
    const union = names(all(t, { size: [...SIZE_BUCKETS] }));
    for (const repo of union) expect(repo.startsWith("unknown-")).toBe(false);
    expect(union.length).toBe(Object.values(expected).flat().length);
    // без фильтра они в рейтинге есть
    expect(names(all(t)).filter((r) => r.startsWith("unknown-")).length).toBe(6);
  });

  test("мультивыбор — объединение корзин", () => {
    expect(names(all(t, { size: ["none", "huge"] }))).toEqual([...expected.none, ...expected.huge].sort());
  });

  test("счетчики корзин = число строк выборки в корзине; все 5 корзин в порядке выбора", () => {
    const r = all(t);
    expect(r.facets.size.map((f) => f.bucket)).toEqual([...SIZE_BUCKETS]);
    for (const f of r.facets.size) expect(f.count).toBe(expected[f.bucket].length);
    // счетчик = то, что даст выбор этой корзины
    for (const f of r.facets.size) expect(f.count).toBe(names(all(t, { size: [f.bucket] })).length);
  });

  test("границы корзин — чистая функция", () => {
    expect(sizeBucketOf(true, 50_000)).toBe("none");
    expect(sizeBucketOf(false, 0)).toBe("small");
    expect(sizeBucketOf(false, 999)).toBe("small");
    expect(sizeBucketOf(false, 1000)).toBe("medium");
    expect(sizeBucketOf(false, 10_000)).toBe("large");
    expect(sizeBucketOf(false, 100_000)).toBe("huge");
    expect(sizeBucketOf(false, null)).toBeNull();
  });
});

// ---------- CI на данных ----------

describe("CI: есть / нет на данных, незнание — ни в одной", () => {
  const t = makeApiDb();
  afterAll(() => t.close());
  seed(t, { repo: "ci-yes-1", total: 90, facts: [ciFact(true)] });
  seed(t, { repo: "ci-yes-2", total: 70, facts: [ciFact(true), tree(50)] });
  seed(t, { repo: "ci-no", total: 80, facts: [ciFact(false)] });
  seed(t, { repo: "ci-null-idx", total: null, facts: [ciFact(false)] });
  seed(t, { repo: "unknown-nodata", total: 60, facts: [ciFact(null, "no-data")] });
  seed(t, { repo: "unknown-bad", total: 55, facts: [ciFact(null, "bad")] });
  seed(t, { repo: "unknown-nofact", total: 50, facts: [] });
  seed(t, { repo: "unknown-notbool", total: 45, facts: [{ key: "cicd.configs", source: "git", value: { paths: [], has_ci_yaml: "yes" } }] });

  test("ci=yes — только репо с ci.yaml", () => {
    expect(names(all(t, { ci: "yes" }))).toEqual(["ci-yes-1", "ci-yes-2"]);
  });

  test("ci=no — только подтвержденно без ci.yaml (и в группе «Без оценки»)", () => {
    const r = all(t, { ci: "no" });
    expect(names(r)).toEqual(["ci-no", "ci-null-idx"]);
    expect(r.nullItems.map((i) => i.repo)).toEqual(["ci-null-idx"]);
    expect(r.total).toBe(1);
    expect(r.nulls).toBe(1);
  });

  test("нет факта, no-data, bad, не булево — ни в «есть», ни в «нет»", () => {
    const shown = [...names(all(t, { ci: "yes" })), ...names(all(t, { ci: "no" }))];
    expect(shown.some((r) => r.startsWith("unknown-"))).toBe(false);
  });

  test("счетчики CI = число строк выборки", () => {
    const r = all(t);
    expect(r.facets.ci).toEqual([
      { value: "yes", count: 2 },
      { value: "no", count: 2 },
    ]);
  });

  test("факт берется из скана строки рейтинга, новый скан перечитывается (память не залипает)", () => {
    const x = seed(t, { repo: "rescanned", total: 40, facts: [ciFact(true)] });
    expect(names(all(t, { ci: "yes" }))).toContain("rescanned");
    // новый пригодный скан без CI — строка рейтинга переезжает на него
    const scan2 = seedScan(t, x.repoId, { facts: [ciFact(false)] });
    seedScore(t, x.repoId, scan2, { total: 41 });
    expect(names(all(t, { ci: "yes" }))).not.toContain("rescanned");
    expect(names(all(t, { ci: "no" }))).toContain("rescanned");
    // непригодный скан (rating_eligible = 0) строку не двигает
    const scan3 = seedScan(t, x.repoId, { facts: [ciFact(true)], ratingEligible: false });
    seedScore(t, x.repoId, scan3, { total: 42 });
    expect(names(all(t, { ci: "no" }))).toContain("rescanned");
  });
});

// ---------- место, комбинации, AI ----------

describe("место не меняется фильтром; комбинации с языком, поиском и AI", () => {
  const t = makeApiDb();
  afterAll(() => t.close());
  const a = seed(t, { repo: "alpha", total: 95, language: "Go", facts: [tree(500), ciFact(true)] });
  seed(t, { repo: "beta", total: 90, language: "Rust", facts: [tree(50_000), ciFact(false)] });
  const g = seed(t, { repo: "gamma", total: 85, language: "Go", facts: [tree(5_000), ciFact(false)], title: "service gamma" });
  seed(t, { repo: "delta", total: 80, language: "Go", facts: [tree(700), ciFact(false)] });
  seed(t, { repo: "eps", total: 75, language: null, facts: [tree(200_000), ciFact(true)] });
  const note = (x: { repoId: number; scanId: number }) =>
    t.db
      .query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'overview', 't', '[]', '1', 'm', '2026', 'public')")
      .run(x.repoId, x.scanId);
  note(a);
  note(g);

  test("место при фильтре = место без фильтра = место на карточке", () => {
    const base = new Map(all(t).items.map((i) => [i.repo, i.rank]));
    for (const patch of [{ size: ["small" as const] }, { ci: "no" as const }, { size: ["medium" as const, "huge" as const], ci: "yes" as const }, { ci: "no" as const, lang: ["Go"] }]) {
      const r = all(t, patch);
      expect(r.items.length).toBeGreaterThan(0);
      for (const item of r.items) {
        expect(item.rank).toBe(base.get(item.repo)!);
        expect(item.rank).toBe(getRepoCard(t.db, "f", item.repo)!.score!.rank);
      }
    }
    expect(all(t, { ci: "no" }).items.map((i) => [i.repo, i.rank])).toEqual([
      ["beta", 2],
      ["gamma", 3],
      ["delta", 4],
    ]);
  });

  test("размер + язык + CI + поиск — пересечение", () => {
    expect(names(all(t, { lang: ["Go"], size: ["small"] }))).toEqual(["alpha", "delta"]);
    expect(names(all(t, { lang: ["Go"], size: ["small"], ci: "no" }))).toEqual(["delta"]);
    expect(names(all(t, { q: "service", ci: "no" }))).toEqual(["gamma"]);
    expect(names(all(t, { lang: [null], size: ["huge"], ci: "yes" }))).toEqual(["eps"]);
  });

  test("AI: счетчик кнопки учитывает размер и CI (то, что даст кнопка), фильтр — пересечение", () => {
    expect(all(t).aiCount).toBe(2);
    expect(all(t, { ci: "no" }).aiCount).toBe(1);
    expect(all(t, { size: ["small"] }).aiCount).toBe(1);
    expect(names(all(t, { ci: "no", ai: true }))).toEqual(["gamma"]);
    expect(all(t, { ci: "no", ai: true }).total).toBe(all(t, { ci: "no" }).aiCount);
  });

  test("фасеты не зависят от выбранных фильтров, только от поиска (правило языка)", () => {
    const base = all(t).facets;
    expect(all(t, { size: ["small"], ci: "yes", lang: ["Rust"], ai: true }).facets).toEqual(base);
    const searched = all(t, { q: "service" }).facets;
    expect(searched.size.find((f) => f.bucket === "medium")!.count).toBe(1);
    expect(searched.ci).toEqual([
      { value: "yes", count: 0 },
      { value: "no", count: 1 },
    ]);
  });

  test("пустая выдача при фильтре: total 0, страниц 1; экран называет фильтры (статус)", () => {
    const r = all(t, { lang: ["Rust"], size: ["small"] });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.totalPages).toBe(1);
    const active = activeRatingFilters("lang=Rust&size=small");
    expect(active).toEqual(["язык", "размер"]);
    expect(nothingFoundDescription(active)).toBe("Ничего не подошло под фильтры: язык, размер. Измените их или сбросьте.");
    // EDGE-17: запрос повторяется дословно, прочие фильтры — следом; длинный обрезан в конце
    expect(nothingFoundDescription(["поиск"], " zzqq ")).toBe("По запросу «zzqq» ничего не нашлось. Измените запрос или сбросьте фильтры.");
    expect(nothingFoundDescription(["поиск", "язык"], "zzqq")).toBe("По запросу «zzqq» ничего не нашлось – с учетом фильтра: язык. Измените запрос или сбросьте фильтры.");
    expect(nothingFoundDescription(["поиск"], "x".repeat(80))).toContain(`«${"x".repeat(60)}…»`);
    // сброс убирает только фильтры: вкладка «Без оценки» и сортировка остаются
    expect(resetFiltersHref("?view=unscored&q=zz&lang=Go&page=3&sort=likes")).toBe("/?view=unscored&sort=likes");
    expect(resetFiltersHref("?q=zz&ai=1")).toBe("/");
    expect(nothingFoundDescription(["поиск"], "   ")).toBe("Ничего не нашлось. Измените запрос или сбросьте фильтры.");
  });
});

// ---------- адрес ----------

describe("адрес рейтинга: size и ci", () => {
  test("сервер: повторяемый size (без дублей), ci=yes|no", () => {
    expect(parseReposQuery(new URLSearchParams("size=small&size=none&size=small"))).toMatchObject({ ok: true, query: { size: ["small", "none"] } });
    expect(parseReposQuery(new URLSearchParams("ci=yes"))).toMatchObject({ ok: true, query: { ci: "yes" } });
    expect(parseReposQuery(new URLSearchParams("ci=no&size=huge"))).toMatchObject({ ok: true, query: { ci: "no", size: ["huge"] } });
    const none = parseReposQuery(new URLSearchParams(""));
    expect(none.ok && none.query.size).toBeUndefined();
    expect(none.ok && none.query.ci).toBeUndefined();
  });

  test("сервер: мусор — 400 с понятным текстом", () => {
    for (const bad of ["size=tiny", "size=", "size=small&size=HUGE", "ci=1", "ci=", "ci=yes&ci=no"]) {
      const r = parseReposQuery(new URLSearchParams(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/размер репозитория|фильтр CI/);
    }
  });

  test("клиент: неверные значения убираются, верные сохраняются", () => {
    expect(normalizeRatingSearch("size=tiny&size=small&ci=maybe&q=go")).toEqual({ search: "q=go&size=small", changed: true });
    expect(normalizeRatingSearch("size=small&size=none&ci=no")).toEqual({ search: "size=small&size=none&ci=no", changed: false });
    expect(normalizeRatingSearch("ci=yes&ci=no")).toEqual({ search: "", changed: true });
    // исправленный адрес сервер принимает
    for (const raw of ["size=tiny&size=small&ci=maybe", "ci=yes&ci=no&size="]) {
      expect(parseReposQuery(new URLSearchParams(normalizeRatingSearch(raw).search)).ok).toBe(true);
    }
  });

  test("активные фильтры для пустого состояния: без фильтров — пусто; каждый назван", () => {
    expect(activeRatingFilters("")).toEqual([]);
    expect(activeRatingFilters("sort=likes&page=2&view=unscored")).toEqual([]);
    expect(activeRatingFilters("q=x&lang=&size=none&ci=no&ai=1")).toEqual(["поиск", "язык", "размер", "CI", "AI-обзор"]);
  });
});

// ---------- опции тулбара: числа экрана = числа ответа ----------

describe("опции фильтров в тулбаре: счетчик = фасет ответа = число строк", () => {
  const t = makeApiDb();
  afterAll(() => t.close());
  seed(t, { repo: "a", total: 90, facts: [tree(10), ciFact(true)] });
  seed(t, { repo: "b", total: 80, facts: [tree(20_000), ciFact(false)] });
  seed(t, { repo: "c", total: null, facts: [tree(30), ciFact(false)] });
  seed(t, { repo: "d", total: 70, facts: [] });

  test("размер: 5 опций, счетчик опции = строк при выборе этой опции", () => {
    const r = all(t);
    const opts = sizeOptions(r.facets);
    expect(opts.map((o) => o.value)).toEqual([...SIZE_BUCKETS]);
    for (const o of opts) expect(o.count).toBe(names(all(t, { size: [o.value as SizeBucket] })).length);
    expect(Object.fromEntries(opts.map((o) => [o.value, o.count]))).toEqual({ none: 0, small: 2, medium: 0, large: 1, huge: 0 });
  });

  test("CI: счетчик опции = строк при выборе; без ответа счетчиков нет (не 0)", () => {
    const r = all(t);
    for (const o of ciOptions(r.facets)) expect(o.count).toBe(names(all(t, { ci: o.value as "yes" | "no" })).length);
    expect(ciOptions(null).map((o) => o.count)).toEqual([null, null]);
    expect(sizeOptions(null).every((o) => o.count === null)).toBe(true);
  });

  test("сводка выбранного размера", () => {
    expect(sizeSummary([])).toBe("");
    expect(sizeSummary(["small"])).toBe("до 1 тыс.");
    expect(sizeSummary(["small", "huge", "none"])).toBe("до 1 тыс. +2");
  });
});
