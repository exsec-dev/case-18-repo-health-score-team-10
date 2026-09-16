// api.test.ts — read-API В3 (Б1): рейтинг (сортировки, фильтры, фасеты,
// пагинация, tri-state), карточка (маркеры, доказательная база, чипы
// без факта), мета. Сети нет: сид-набор — tests/api-fixtures.ts.
import { afterAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_QUERY,
  getMeta,
  getRepoCard,
  listRepos,
  parseReposQuery,
  type ReposQuery,
} from "../src/api/repos";
import { MODEL_VERSION } from "../src/score/model";
import {
  cardFacts,
  makeApiDb,
  seedRating,
  seedRecommendation,
  seedRepo,
  seedScan,
  seedScore,
  type ApiTestDb,
} from "./api-fixtures";

// две БД: карточка сеет свои репо в теле describe (bun вычисляет его до
// прогона тестов), и в общей БД они сдвинули бы фасеты и пагинацию рейтинга
const t: ApiTestDb = makeApiDb();
const c: ApiTestDb = makeApiDb();
seedRating(t);
afterAll(() => {
  t.close();
  c.close();
});

const q = (patch: Partial<ReposQuery> = {}): ReposQuery => ({ ...DEFAULT_QUERY, ...patch });
const names = (items: { org: string; repo: string }[]): string[] => items.map((i) => `${i.org}/${i.repo}`);

describe("рейтинг: выборка строк", () => {
  test("одна строка на репозиторий; репо без скоров в рейтинг не попадает", () => {
    const res = listRepos(t.db, q());
    const all = [...names(res.items), ...names(res.nullItems)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("catalog-only/never-scanned");
    expect(res.total).toBe(7); // 8 строк со скорами минус NULL-Score
  });

  test("«последний скан» — по scans.id, не по датам", () => {
    const repoId = seedRepo(t, { org: "z-order", repo: "by-id", language: "Go", likes: 1, lastActivityAt: "2026-01-01T00:00:00Z" });
    // id больше, дата старта раньше: реализация на датах взяла бы 41
    const older = seedScan(t, repoId, { startedAt: "2026-09-10T00:00:00Z" });
    const newer = seedScan(t, repoId, { startedAt: "2026-01-05T00:00:00Z" });
    expect(newer).toBeGreaterThan(older);
    seedScore(t, repoId, older, { total: 41 });
    seedScore(t, repoId, newer, { total: 88 });

    const item = listRepos(t.db, q()).items.find((i) => i.repo === "by-id");
    expect(item?.score).toBe(88);
    expect(getRepoCard(t.db, "z-order", "by-id")?.score?.total).toBe(88);

    t.db.query("DELETE FROM scores WHERE repo_id = ?").run(repoId);
    t.db.query("DELETE FROM scans WHERE repo_id = ?").run(repoId);
    t.db.query("DELETE FROM repos WHERE id = ?").run(repoId);
  });

  test("строки чужой model_version не видны", () => {
    const repoId = seedRepo(t, { org: "old-model", repo: "legacy", language: "Go" });
    const scanId = seedScan(t, repoId);
    seedScore(t, repoId, scanId, { total: 99, modelVersion: "1.0.0-old" });
    expect(names(listRepos(t.db, q()).items)).not.toContain("old-model/legacy");
    t.db.query("DELETE FROM scores WHERE repo_id = ?").run(repoId);
    t.db.query("DELETE FROM scans WHERE repo_id = ?").run(repoId);
    t.db.query("DELETE FROM repos WHERE id = ?").run(repoId);
  });
});

describe("рейтинг: tri-state (закон 2)", () => {
  test("Score = NULL не попадает в items ни при desc, ни при asc и не влияет на total", () => {
    for (const order of ["desc", "asc"] as const) {
      const res = listRepos(t.db, q({ order }));
      expect(names(res.items)).not.toContain("nodata/dark-repo");
      expect(res.items.every((i) => i.score !== null)).toBe(true);
      expect(res.total).toBe(7);
      expect(res.nulls).toBe(1);
      expect(names(res.nullItems)).toEqual(["nodata/dark-repo"]);
    }
  });

  test("NULL-группа видна на каждой странице: пагинация считается только по items", () => {
    const first = listRepos(t.db, q({ perPage: 3, page: 1 }));
    const last = listRepos(t.db, q({ perPage: 3, page: 3 }));
    expect(first.totalPages).toBe(3);
    expect(first.nullItems).toHaveLength(1);
    expect(last.nullItems).toHaveLength(1);
    expect(first.items).toHaveLength(3);
    expect(last.items).toHaveLength(1);
  });

  test("NULL-значение величины — всегда в хвосте items при любом order", () => {
    const desc = names(listRepos(t.db, q({ sort: "likes", order: "desc" })).items);
    const asc = names(listRepos(t.db, q({ sort: "likes", order: "asc" })).items);
    expect(desc[desc.length - 1]).toBe("tail/no-meta");
    expect(asc[asc.length - 1]).toBe("tail/no-meta");
    const byDate = names(listRepos(t.db, q({ sort: "activity", order: "asc" })).items);
    expect(byDate[byDate.length - 1]).toBe("tail/no-meta");
  });
});

describe("рейтинг: сортировки", () => {
  test("дефолт — Score ↓", () => {
    const res = listRepos(t.db, q());
    expect(res.items.map((i) => i.score)).toEqual([74, 62, 60, 56, 50, 47, 35]);
  });

  test("score asc", () => {
    expect(listRepos(t.db, q({ order: "asc" })).items.map((i) => i.score)).toEqual([35, 47, 50, 56, 60, 62, 74]);
  });

  test("likes desc", () => {
    expect(names(listRepos(t.db, q({ sort: "likes" })).items).slice(0, 3)).toEqual([
      "divkit/divkit",
      "gravity-ui/uikit",
      "raph/its-wednesday-my-dudes",
    ]);
  });

  test("activity — дата последней активности репозитория, не балл категории", () => {
    const res = listRepos(t.db, q({ sort: "activity" }));
    expect(names(res.items).slice(0, 2)).toEqual(["gravity-ui/uikit", "divkit/divkit"]);
    expect(res.items[0]!.lastActivityAt).toBe("2026-09-16T07:46:00Z");
  });

  test("name — org/repo по алфавиту", () => {
    expect(names(listRepos(t.db, q({ sort: "name", order: "asc" })).items)).toEqual([
      "divkit/divkit",
      "gravity-ui/uikit",
      "hex21h/datahint",
      "k-5-45mm/dozzle-plus",
      "raph/its-wednesday-my-dudes",
      "tail/no-meta",
      "yandex-cloud-examples/cloudapp-hugo",
    ]);
  });

  test("равные значения — стабильно по org/repo (пагинация не «дышит»)", () => {
    expect(names(listRepos(t.db, q({ sort: "coverage", order: "desc" })).items)).toEqual(
      names(listRepos(t.db, q({ sort: "name", order: "asc" })).items),
    );
  });
});

describe("рейтинг: фильтры и фасеты", () => {
  test("lang — точное значение", () => {
    const res = listRepos(t.db, q({ lang: "Go" }));
    expect(names(res.items)).toEqual(["k-5-45mm/dozzle-plus", "hex21h/datahint", "tail/no-meta"]);
    expect(res.total).toBe(3);
  });

  test("lang= (пустой) — группа «язык не определён»", () => {
    const res = listRepos(t.db, q({ lang: null }));
    expect(names(res.items)).toEqual(["yandex-cloud-examples/cloudapp-hugo", "raph/its-wednesday-my-dudes"]);
  });

  test("q — подстрока по org/repo/title, регистронезависимо", () => {
    expect(names(listRepos(t.db, q({ q: "DIV" })).items)).toEqual(["divkit/divkit"]);
    expect(names(listRepos(t.db, q({ q: "hugo" })).items)).toEqual(["yandex-cloud-examples/cloudapp-hugo"]);
    expect(listRepos(t.db, q({ q: "нет-такого" })).items).toEqual([]);
  });

  test("фасеты считаются без учёта lang, но с учётом q", () => {
    const withLang = listRepos(t.db, q({ lang: "Go" }));
    const facet = (r: { facets: { languages: { language: string | null; count: number }[] } }, lang: string | null) =>
      r.facets.languages.find((f) => f.language === lang)?.count;
    expect(facet(withLang, "Go")).toBe(3);
    expect(facet(withLang, "Kotlin")).toBe(1);
    // NULL-Score репо тоже репозиторий выборки: его язык из фасетов не исчезает
    expect(facet(withLang, "C++")).toBe(1);
    expect(facet(withLang, null)).toBe(2);
    const withQ = listRepos(t.db, q({ q: "div" }));
    expect(withQ.facets.languages).toEqual([{ language: "Kotlin", count: 1 }]);
  });

  test("пагинация: срез и totalPages", () => {
    const p2 = listRepos(t.db, q({ perPage: 2, page: 2 }));
    expect(p2.items.map((i) => i.score)).toEqual([60, 56]);
    expect(p2.totalPages).toBe(4);
    expect(listRepos(t.db, q({ perPage: 2, page: 99 })).items).toEqual([]);
  });
});

describe("разбор query-параметров", () => {
  test("дефолты и известные значения", () => {
    const res = parseReposQuery(new URLSearchParams("sort=likes&order=asc&page=2&per_page=10&lang=Go&q=div"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.query).toEqual({ sort: "likes", order: "asc", page: 2, perPage: 10, lang: "Go", q: "div" });
    const empty = parseReposQuery(new URLSearchParams(""));
    if (empty.ok) expect(empty.query).toEqual(DEFAULT_QUERY);
  });

  test("lang= отличается от отсутствующего lang", () => {
    const withEmpty = parseReposQuery(new URLSearchParams("lang="));
    if (withEmpty.ok) expect(withEmpty.query.lang).toBeNull();
    const without = parseReposQuery(new URLSearchParams(""));
    if (without.ok) expect("lang" in without.query).toBe(false);
  });

  test("неизвестный параметр игнорируется, неверное значение известного — ошибка", () => {
    expect(parseReposQuery(new URLSearchParams("unknown=42")).ok).toBe(true);
    for (const bad of ["sort=rating", "order=up", "page=0", "page=abc", "per_page=0", "per_page=101"]) {
      const res = parseReposQuery(new URLSearchParams(bad));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
    }
  });
});

describe("карточка репозитория", () => {
  const repoId = seedRepo(c, {
    org: "card",
    repo: "sample",
    title: "card sample",
    language: "Go",
    likes: 7,
    forks: 2,
    lastActivityAt: "2026-09-15T00:00:00Z",
  });
  const scanId = seedScan(c, repoId, {
    status: "partial",
    trigger: "user",
    facts: [
      ...cardFacts(),
      // не адресуемый факт: в доказательную базу не едет
      { key: "meta.debug", value: { hello: "world" }, source: "test" },
    ],
  });
  seedScore(c, repoId, scanId, { total: 67, stale: ["issues.stats"] });
  seedRecommendation(c, scanId, { ruleId: "contributing-missing", priority: 1, factRef: "docs.presence", deltaScore: 2.25, expectedImpact: "+2.3 Score (по одному)" });
  seedRecommendation(c, scanId, { ruleId: "connect-appsec", priority: 2, factRef: "appsec.findings", opensCategory: "security", expectedImpact: "coverage 1.00→1.00 — категория Security 20%" });
  const card = getRepoCard(c.db, "card", "sample")!;

  test("шапка и синтезированный webUrl", () => {
    expect(card.repo).toMatchObject({ org: "card", repo: "sample", title: "card sample", language: "Go", likes: 7, forks: 2 });
    expect(card.repo.webUrl).toBe("https://sourcecraft.dev/card/sample");
  });

  test("скан и скор со всеми полями показа", () => {
    expect(card.scan).toMatchObject({ id: scanId, status: "partial", trigger: "user" });
    expect(card.score?.total).toBe(67);
    expect(card.score?.modelVersion).toBe(MODEL_VERSION);
    expect(card.score?.noData[0]).toContain("security");
    expect(card.derived).toMatchObject({ commitsPerMonth: 12 });
  });

  test("категории несут номинальный вес модели (для объяснения перенормировки)", () => {
    expect(card.score?.categories.security).toMatchObject({ score: null, weight: 20 });
    expect(card.score?.categories.documentation.weight).toBe(15);
    expect(card.score?.categories.code.weight).toBe(20);
    expect(Object.keys(card.score!.categories)).toHaveLength(6);
  });

  test("маркеры — полями, а не парсингом текста", () => {
    expect(card.markers.historyTruncatedSince).toBe("2025-08-16");
    expect(card.markers.ciConfigOnlyCap).toBe(true);
    expect(card.markers.staleFacts).toBe(true);
  });

  test("рекомендации читаются из таблицы: source, порядок, fact_ref → factRefs", () => {
    expect(card.recommendations.map((r) => r.ruleId)).toEqual(["contributing-missing", "connect-appsec"]);
    expect(card.recommendations[0]).toMatchObject({ kind: "presence", deltaScore: 2.25, source: "rule" });
    expect(card.recommendations[0]!.factRefs).toEqual([{ key: "docs.presence", missing: false }]);
    expect(card.recommendations[1]).toMatchObject({ kind: "activation", opensCategory: "security" });
  });

  test("чип факта без строки в evidence помечен missing (штатный случай appsec)", () => {
    expect(card.recommendations[1]!.factRefs).toEqual([{ key: "appsec.findings", missing: true }]);
    expect(card.evidence.find((e) => e.key === "appsec.findings")).toBeUndefined();
  });

  test("evidence — только адресуемые факты, с источником и временем сбора", () => {
    const keys = card.evidence.map((e) => e.key);
    expect(keys).toContain("docs.presence");
    expect(keys).toContain("cicd.runs"); // no-data-факт — тоже доказательство
    expect(keys).not.toContain("meta.debug");
    const presence = card.evidence.find((e) => e.key === "docs.presence")!;
    expect(presence).toMatchObject({ category: "documentation", status: "ok", source: "git" });
    expect(presence.collectedAt.length).toBeGreaterThan(0);
  });

  test("таймлайн отдаётся агрегатом — сырьё коммитов не едет в ответ", () => {
    const timeline = card.evidence.find((e) => e.key === "activity.git.timeline")!;
    expect(timeline.value).toEqual({ events: 2, first: "2025-08-16T10:00:00Z", last: "2026-09-10T10:00:00Z", truncated: true });
    expect(JSON.stringify(timeline.value)).not.toContain("sha");
  });

  test("тяжёлое значение усекается единой формой", () => {
    const heavyRepo = seedRepo(c, { org: "card", repo: "heavy", language: "Go" });
    const heavyScan = seedScan(c, heavyRepo, {
      facts: [{ key: "tree.stats", source: "git", value: { top_level: Array.from({ length: 400 }, (_, i) => ({ name: `directory-with-long-name-${i}`, type: "tree" })), loc: 1 } }],
    });
    seedScore(c, heavyRepo, heavyScan, { total: 50 });
    const value = getRepoCard(c.db, "card", "heavy")!.evidence[0]!.value as { truncated: boolean; bytes: number; preview: string };
    expect(value.truncated).toBe(true);
    expect(value.bytes).toBeGreaterThan(4096);
    expect(value.preview).toHaveLength(512);
  });

  test("репо в каталоге без скана — 200 с пустыми scan/score, а не ошибка", () => {
    seedRepo(c, { org: "catalog-only", repo: "never-scanned", language: "Rust", likes: 1 });
    const empty = getRepoCard(c.db, "catalog-only", "never-scanned")!;
    expect(empty.repo.repo).toBe("never-scanned");
    expect(empty.scan).toBeNull();
    expect(empty.score).toBeNull();
    expect(empty.derived).toBeNull();
    expect(empty.recommendations).toEqual([]);
    expect(empty.evidence).toEqual([]);
  });

  test("неизвестный репозиторий — null (роут отдаёт 404)", () => {
    expect(getRepoCard(c.db, "нет", "такого")).toBeNull();
  });
});

describe("мета", () => {
  test("версия модели, шесть категорий с русскими именами и весами, порог NULL", () => {
    const meta = getMeta(t.db);
    expect(meta.modelVersion).toBe(MODEL_VERSION);
    expect(meta.categories.map((c) => c.key)).toEqual(["documentation", "cicd", "security", "activity", "issues", "code"]);
    expect(meta.categories.map((c) => c.title)).toEqual(["Документация", "CI/CD", "Security", "Активность", "Issues", "Code health"]);
    expect(meta.categories.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(meta.coverageNullBelow).toBe(0.4);
    expect(meta.repos.nullScore).toBe(1);
    expect(meta.repos.scored).toBeGreaterThanOrEqual(7);
    expect(meta.methodology).toMatch(/^reports\/.+\.md$/);
  });
});
