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
import { computeFromFacts, totalsFromCategories } from "../src/score/compute";
import { renderRepoReport } from "../src/report/markdown";
import type { AccessResult } from "../src/auth/access";
import { DEFAULT_SCAN } from "../src/config";
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
/** зритель с доступом ко всем каналам (К2) */
const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
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
    expect(item?.healthcraftIndex).toBe(88);
    expect(getRepoCard(t.db, "z-order", "by-id")?.score?.healthcraftIndex).toBe(88);

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
      expect(res.items.every((i) => i.healthcraftIndex !== null)).toBe(true);
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
    expect(res.items.map((i) => i.healthcraftIndex)).toEqual([74, 62, 60, 56, 50, 47, 35]);
  });

  test("score asc", () => {
    expect(listRepos(t.db, q({ order: "asc" })).items.map((i) => i.healthcraftIndex)).toEqual([35, 47, 50, 56, 60, 62, 74]);
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
    expect(p2.items.map((i) => i.healthcraftIndex)).toEqual([60, 56]);
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
  seedRecommendation(c, scanId, { ruleId: "connect-appsec", priority: 2, factRef: "appsec.findings", opensCategory: "security", expectedImpact: "coverage 1.00→1.00 — категория Security 20%", channel: "appsec" });
  // полный состав карточки — у зрителя с доступом к каналам; матрица доступа — ниже
  const card = getRepoCard(c.db, "card", "sample", { access: GRANTED })!;

  test("шапка и синтезированный webUrl", () => {
    expect(card.repo).toMatchObject({ org: "card", repo: "sample", title: "card sample", language: "Go", likes: 7, forks: 2 });
    expect(card.repo.webUrl).toBe("https://sourcecraft.dev/card/sample");
  });

  test("скан и скор со всеми полями показа", () => {
    expect(card.scan).toMatchObject({ id: scanId, status: "partial", trigger: "user" });
    expect(card.score?.healthcraftIndex).toBe(67);
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

  test("рекомендации: публичные — из таблицы P, канальные — движком на показанных фактах; source, порядок, fact_ref → factRefs", () => {
    // круг 2: раны CI недоступны (config-only) → grant-ci-runs; AppSec нет → connect-appsec
    expect(card.recommendations.map((r) => r.ruleId)).toEqual(["contributing-missing", "connect-appsec", "grant-ci-runs"]);
    expect(card.recommendations.map((r) => r.priority)).toEqual([1, 2, 3]);
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

describe("изоляция own/public и эвикция (В4/Б4)", () => {
  const iso: ApiTestDb = makeApiDb();
  afterAll(() => iso.close());

  test("одна строка оценки на скан (К1): рейтинг и карточка — последний скан; рейтинг без CI/Security", () => {
    const repoId = seedRepo(iso, { org: "iso", repo: "dual", language: "Go", likes: 10 });
    const scan1 = seedScan(iso, repoId, { status: "ok" });
    seedScore(iso, repoId, scan1, { total: 60 });
    // позже — скан участника с PAT: тот же репо, новая строка с двумя итогами
    const scan2 = seedScan(iso, repoId, { status: "ok", trigger: "user" });
    seedScore(iso, repoId, scan2, { total: 70 });
    expect((iso.db.query("SELECT COUNT(*) AS c FROM scores WHERE scan_id = ?").get(scan2) as { c: number }).c).toBe(1);
    // рейтинг: total_rating последнего скана; категории каналов с правами не публикуются
    const rating = listRepos(iso.db, q());
    expect(rating.items.map((i) => `${i.org}/${i.repo}`)).toEqual(["iso/dual"]);
    expect(rating.items[0]!.healthcraftIndex).toBe(70);
    expect(rating.items[0]!.categories.cicd).toBeNull();
    expect(rating.items[0]!.categories.security).toBeNull();
    // карточка: Score в рейтинге последнего пригодного скана; полный Score — из
    // показанных категорий (круг 2), а не сохранённый total_full
    const card = getRepoCard(iso.db, "iso", "dual", { access: GRANTED })!;
    expect(card.score!.healthcraftIndex).toBe(70);
    expect(card.score!.repoHealthScore).toBe(Math.round(totalsFromCategories(card.score!.categories, { codeEmpty: false, secretsCritical: false }).repoHealthScore!));
  });

  test("stale-маркер рейтинга не выдаёт фолбэк каналов с правами", () => {
    const repoId = seedRepo(iso, { org: "iso", repo: "stale-ch", language: "Go" });
    const scanId = seedScan(iso, repoId, { status: "ok" });
    seedScore(iso, repoId, scanId, { total: 40, stale: ["cicd.runs", "appsec.findings"] });
    const item = listRepos(iso.db, q()).items.find((i) => i.repo === "stale-ch")!;
    expect(item.staleFacts).toBe(false);
    iso.db.query("DELETE FROM scores WHERE repo_id = ?").run(repoId);
    iso.db.query("DELETE FROM scans WHERE repo_id = ?").run(repoId);
    iso.db.query("DELETE FROM repos WHERE id = ?").run(repoId);
  });

  test("эвикция (rating_active=0) убирает из рейтинга, карточка остаётся; приватность — так же", () => {
    const repoId = seedRepo(iso, { org: "iso", repo: "evicted", language: "Go", likes: 5 });
    const scanId = seedScan(iso, repoId, { status: "ok" });
    seedScore(iso, repoId, scanId, { total: 55 });
    expect(listRepos(iso.db, q()).total).toBe(2);
    iso.db.query("UPDATE repos SET rating_active = 0 WHERE repo_slug = 'evicted'").run();
    const rating = listRepos(iso.db, q());
    expect(names(rating.items)).toEqual(["iso/dual"]);
    // эвиктированный публичный — 404 всем, даже зрителю с доступом (К2)
    expect(getRepoCard(iso.db, "iso", "evicted")).toBeNull();
    expect(getRepoCard(iso.db, "iso", "evicted", { access: GRANTED })).toBeNull();
    // возврат флагом
    iso.db.query("UPDATE repos SET rating_active = 1 WHERE repo_slug = 'evicted'").run();
    expect(listRepos(iso.db, q()).total).toBe(2);
    // приватный репо — не в рейтинге; карточка только при repo = granted
    iso.db.query("UPDATE repos SET visibility = 'private' WHERE repo_slug = 'evicted'").run();
    expect(listRepos(iso.db, q()).total).toBe(1);
    expect(getRepoCard(iso.db, "iso", "evicted")).toBeNull();
    expect(getRepoCard(iso.db, "iso", "evicted", { access: { ...GRANTED, repo: "denied" } })).toBeNull();
    expect(getRepoCard(iso.db, "iso", "evicted", { access: GRANTED })!.repo.repo).toBe("evicted");
    // эвикция чужих скоров нейтральна: у dual ничего не поменялось
    expect(getRepoCard(iso.db, "iso", "dual")!.score!.healthcraftIndex).toBe(70);
  });

  test("code_empty маркер доезжает до карточки (Score 0 как данные)", () => {
    const repoId = seedRepo(iso, { org: "iso", repo: "empty-code" });
    const scanId = seedScan(iso, repoId, { status: "partial" });
    seedScore(iso, repoId, scanId, { total: 0, coverage: 1 });
    iso.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(scanId);
    const card = getRepoCard(iso.db, "iso", "empty-code")!;
    expect(card.score!.healthcraftIndex).toBe(0);
    expect(card.markers.codeEmpty).toBe(true);
    // NULL-скор (недостаточно данных) маркером не обладает
    const nullRepo = seedRepo(iso, { org: "iso", repo: "null-score" });
    const nullScan = seedScan(iso, nullRepo, { status: "partial" });
    seedScore(iso, nullRepo, nullScan, { total: null, coverage: 0.2 });
    const nullCard = getRepoCard(iso.db, "iso", "null-score")!;
    expect(nullCard.score!.healthcraftIndex).toBeNull();
    expect(nullCard.markers.codeEmpty).toBe(false);
  });
});

describe("единая карточка: матрица доступа зрителя (К2)", () => {
  const m: ApiTestDb = makeApiDb();
  afterAll(() => m.close());
  const RUNS = { last_status: "failed", success_rate: 0.5, duration_p50: 1500, runs_count: 41 };
  const APPSEC = { severity_counts: { critical: 1, high: 2, medium: 3, low: 4 }, resolved_share: 0.5, secrets_critical: true, provenance: { commit_hash: "deadbeef" } };
  const seedFull = (org: string, repo: string, visibility = "public") => {
    const repoId = seedRepo(m, { org, repo, language: "Go" });
    m.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, repoId);
    const facts = cardFacts().map((f) => (f.key === "cicd.runs" ? { key: "cicd.runs", source: "rest:cicd", value: RUNS } : f));
    const scanId = seedScan(m, repoId, { trigger: "user", facts: [...facts, { key: "appsec.findings", source: "appsec:api", value: APPSEC }] });
    seedScore(m, repoId, scanId, {
      total: 61,
      categories: {
        cicd: { score: 47, submetrics: { pass_rate: { score: 0.4, value: 0.5 } } },
        security: { score: 39, submetrics: { secrets: { score: 0, value: true } } },
      },
      noData: ["cicd: ci runs no-data (access/absent) — config-only cap 50"],
      stale: ["cicd.runs", "appsec.findings", "issues.stats"],
    });
    seedRecommendation(m, scanId, { ruleId: "license-missing", priority: 1, factRef: "docs.presence", deltaScore: 3.75 });
    seedRecommendation(m, scanId, { ruleId: "fix-red-runs", priority: 2, factRef: "cicd.runs", channel: "cicd" });
    seedRecommendation(m, scanId, { ruleId: "appsec-critical", priority: 3, factRef: "appsec.findings", channel: "appsec" });
    return scanId;
  };
  seedFull("mx", "pub");
  seedFull("mx", "priv", "private");
  seedFull("mx", "gone");
  m.db.query("UPDATE repos SET rating_active = 0 WHERE repo_slug = 'gone'").run();

  const view = (a: AccessResult, repo = "pub") => getRepoCard(m.db, "mx", repo, { access: a });
  // круг 2: CI и Security считаются на показе из ok-фактов своих сканов
  const channelCats = computeFromFacts(
    new Map<string, unknown>([
      ["cicd.configs", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true }],
      ["cicd.runs", RUNS],
      ["appsec.findings", APPSEC],
      ["tree.stats", { top_level: [{ name: "src", type: "tree" }], file_count: 10, bytes: 1000, loc: 5000 }],
    ]),
    { scanId: 0, repoId: 0 },
    new Date(),
  ).categories;
  const rules = (card: ReturnType<typeof view>) => card!.recommendations.map((r) => r.ruleId);
  const keys = (card: ReturnType<typeof view>) => card!.evidence.map((e) => e.key);
  const ANON: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };

  test("аноним: Score в рейтинге есть; полного итога, чисел и фактов CI/Security нет — во всём JSON", () => {
    const card = view(ANON)!;
    expect(card.access).toEqual({ cicd: "no-pat", appsec: "no-pat" });
    expect(card.score!.healthcraftIndex).toBe(61);
    expect(card.score!.repoHealthScore).toBeNull();
    expect(card.score!.repoHealthCoverage).toBeNull();
    expect(card.score!.fullLocked).toBe(true);
    expect(card.score!.categories.cicd).toEqual({ score: null, submetrics: {}, locked: "no-pat", weight: 15 });
    expect(card.score!.categories.security).toEqual({ score: null, submetrics: {}, locked: "no-pat", weight: 20 });
    expect(rules(card)).toEqual(["license-missing"]);
    expect(keys(card)).not.toContain("cicd.runs");
    expect(keys(card)).not.toContain("cicd.configs");
    expect(keys(card)).not.toContain("appsec.findings");
    expect(card.score!.stale).toEqual(["issues.stats"]);
    expect(card.score!.noData.some((x) => x.startsWith("cicd"))).toBe(false);
    expect(card.markers.ciConfigOnlyCap).toBe(false);
    const json = JSON.stringify(card);
    for (const leak of ["severity_counts", "runs_count", "secrets_critical", "deadbeef", "fix-red-runs", "appsec-critical", "config-only cap"]) {
      expect(json).not.toContain(leak);
    }
  });

  test("вошедший без PAT и с отказом (denied/pat-expired/check-failed): так же закрыто, причина в locked", () => {
    for (const reason of ["no-pat", "denied", "pat-expired", "check-failed"] as const) {
      const card = view({ cicd: reason, appsec: reason, repo: "granted" })!;
      expect(card.score!.categories.cicd.locked).toBe(reason);
      expect(card.score!.categories.security.locked).toBe(reason);
      expect(card.score!.repoHealthScore).toBeNull();
      expect(JSON.stringify(card)).not.toContain("runs_count");
    }
  });

  test("только CI: CI-блок, раны и CI-правила; Security закрыта; полного итога нет", () => {
    const card = view({ cicd: "granted", appsec: "denied", repo: "granted" })!;
    expect(card.score!.categories.cicd.score).toBe(channelCats.cicd.score);
    expect(card.score!.categories.cicd.locked).toBeUndefined();
    expect(card.score!.categories.security.locked).toBe("denied");
    expect(card.score!.fullLocked).toBe(true);
    expect(card.score!.repoHealthScore).toBeNull();
    expect(rules(card)).toEqual(["license-missing", "fix-red-runs", "speed-up-pipeline"]);
    expect(keys(card)).toContain("cicd.runs");
    expect(keys(card)).not.toContain("appsec.findings");
    const json = JSON.stringify(card);
    expect(json).toContain("runs_count");
    expect(json).not.toContain("severity_counts");
  });

  test("только Security: AppSec-блок и правила; CI закрыт; полного итога нет", () => {
    const card = view({ cicd: "denied", appsec: "granted", repo: "granted" })!;
    expect(card.score!.categories.security.score).toBe(channelCats.security.score);
    expect(card.score!.categories.cicd.locked).toBe("denied");
    expect(card.score!.repoHealthScore).toBeNull();
    expect(rules(card)).toEqual(["license-missing", "appsec-critical"]);
    const json = JSON.stringify(card);
    expect(json).toContain("severity_counts");
    expect(json).not.toContain("runs_count");
  });

  test("оба канала: полный итог и всё содержимое", () => {
    const card = view({ cicd: "granted", appsec: "granted", repo: "granted" })!;
    expect(card.score!.fullLocked).toBe(false);
    expect(card.score!.repoHealthScore).toBe(49);
    expect(card.score!.repoHealthCoverage).toBe(1);
    expect(rules(card)).toEqual(["license-missing", "fix-red-runs", "speed-up-pipeline", "appsec-critical"]);
    // канальные данные берутся из скана, где они собраны ok, — фолбэка «из истории» у них нет (круг 2)
    expect(card.score!.stale).toEqual(["issues.stats"]);
  });

  test("приватный: без доступа к repo — 404 (null) всем; с доступом — карточка по каналам", () => {
    expect(view(ANON, "priv")).toBeNull();
    expect(view({ cicd: "denied", appsec: "denied", repo: "denied" }, "priv")).toBeNull();
    expect(view({ cicd: "check-failed", appsec: "check-failed", repo: "check-failed" }, "priv")).toBeNull();
    const card = view({ cicd: "granted", appsec: "denied", repo: "granted" }, "priv")!;
    expect(card.score!.healthcraftIndex).toBe(61);
    expect(card.score!.categories.security.locked).toBe("denied");
  });

  test("эвиктированный публичный — 404 всем", () => {
    expect(view(ANON, "gone")).toBeNull();
    expect(view({ cicd: "granted", appsec: "granted", repo: "granted" }, "gone")).toBeNull();
  });

  test("MD-отчёт строится тем же сборщиком и следует тем же правилам", () => {
    const anonMd = renderRepoReport(view(ANON)!);
    for (const leak of ["severity_counts", "runs_count", "fix-red-runs", "appsec-critical", "Repo Health Score (6 категорий, с CI и Security): 49"]) {
      expect(anonMd).not.toContain(leak);
    }
    expect(anonMd).toContain("войдите и добавьте токен доступа");
    const fullMd = renderRepoReport(view({ cicd: "granted", appsec: "granted", repo: "granted" })!);
    expect(fullMd).toContain("Repo Health Score (6 категорий, с CI и Security): 49 из 100");
    expect(fullMd).toContain("runs_count");
  });
});

describe("пробой лимитов клона (К5)", () => {
  const l: ApiTestDb = makeApiDb();
  afterAll(() => l.close());

  test("git no-data(limits) → маркер с лимитами оператора и причина человеческими словами (карточка и MD)", () => {
    const repoId = seedRepo(l, { org: "big", repo: "mono" });
    const scanId = seedScan(l, repoId, {
      status: "partial",
      facts: [
        { key: "tree.stats", source: "git", status: "no-data", value: { reason: "limits", detail: "disk" } },
        { key: "issues.stats", source: "rest:issues", value: { open: 1, closed: 1, median_close_days: 3, stale_90d: 0, fetched_count: 2 } },
      ],
    });
    seedScore(l, repoId, scanId, { total: null, coverage: 0.2 });
    const card = getRepoCard(l.db, "big", "mono")!;
    expect(card.markers.gitLimits).toEqual({
      cloneMaxBytes: 1.5 * 1024 ** 3,
      cloneTimeoutMs: 20 * 60_000,
      degradeEnabled: true,
      degradeSinceMonths: 13,
      degradeMaxBytes: 2.5 * 1024 ** 3,
      degradeTimeoutMs: 25 * 60_000,
    });
    const md = renderRepoReport(card);
    expect(md).toContain("Репозиторий больше лимита сервиса: полный клон больше 1.5 ГБ или дольше 20 мин, 13 месяцев истории — больше 2.5 ГБ или дольше 25 мин");
    // лимиты — оператора из переданного конфига, не пользовательские
    const custom = getRepoCard(l.db, "big", "mono", { limits: { ...DEFAULT_SCAN, clone: { ...DEFAULT_SCAN.clone, maxBytes: 512 * 1024 ** 2 } } })!;
    expect(custom.markers.gitLimits!.cloneMaxBytes).toBe(512 * 1024 ** 2);
    // без пробоя маркера нет
    expect(getRepoCard(c.db, "card", "sample")!.markers.gitLimits).toBeNull();
  });
});

describe("мета", () => {
  test("версия модели, шесть категорий с русскими именами и весами, порог NULL", () => {
    const meta = getMeta(t.db);
    expect(meta.modelVersion).toBe(MODEL_VERSION);
    expect(meta.categories.map((c) => c.key)).toEqual(["documentation", "cicd", "security", "activity", "issues", "code"]);
    expect(meta.categories.map((c) => c.title)).toEqual(["Документация", "CI/CD", "Security", "Активность", "Issues", "Code health"]);
    expect(meta.categories.reduce((s, c) => s + c.scoreWeight, 0)).toBe(100);
    expect(meta.coverageNullBelow).toBe(0.4);
    expect(meta.repos.nullScore).toBe(1);
    expect(meta.repos.scored).toBeGreaterThanOrEqual(7);
    expect(meta.methodology).toMatch(/^reports\/.+\.md$/);
  });
});
