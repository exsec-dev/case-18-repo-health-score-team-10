// eligibility.test.ts — В4.1-fix Б1: пригодность скана для рейтинга
// (К-Ф1.1), публичный статус скана (Ф1.11), индексы (Ф1.12). Правило —
// одно в TS и SQL (миграция); рейтинг, /api/meta, «мои репо» и публичная
// часть карточки читают последний пригодный скан; блок scan — последний
// скан; канальная часть — последняя строка оценки. Сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { categoryOf, noDataFact, okFact, type Fact } from "../src/collectors/facts";
import type { ScClient } from "../src/collectors/http";
import { CHANNEL_KINDS, PUBLIC_KINDS, READ_KINDS, ratingEligible, ratingEligibleSql, totalsFromCategories } from "../src/score/compute";
import { runScan, type ScanDeps } from "../src/jobs/runner";
import { upsertUser } from "../src/auth/session";
import { listMyRepos, requestUserScan } from "../src/api/me";
import { DEFAULT_QUERY, getMeta, getRepoCard, listRepos } from "../src/api/repos";
import { healthyFacts } from "./score-fixtures";
import { makeApiDb, seedRepo, seedScan, seedScore, seedRecommendation, type FactSpec } from "./api-fixtures";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-elig-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SOURCES: Record<string, string> = {
  "issues.stats": "rest:issues",
  "issues.comments_sample": "rest:comments",
  "activity.rest": "rest:activity",
  "cicd.runs": "rest:cicd",
};
const healthy = (): Fact[] => healthyFacts().map((f) => okFact(f.key, f.value, SOURCES[f.key] ?? "git"));
const asSpec = (f: Fact): FactSpec => ({ key: f.key, value: f.value, status: f.status, source: f.source });
const replace = (facts: Fact[], ...patch: Fact[]): Fact[] => [...facts.filter((f) => !patch.some((p) => p.key === f.key)), ...patch];

type Case = [string, Fact[], { status: string; userId: number | null }, boolean];
const PERIODIC = { status: "partial", userId: null };
const CASES: Case[] = [
  ["все публичные факты ok", healthy(), PERIODIC, true],
  ["нет факта публичного kind", healthy().filter((f) => f.key !== "code.todo"), PERIODIC, false],
  ["bad у публичного факта", replace(healthy(), { ...noDataFact("activity.rest", "other", "rest:activity"), status: "bad" }), PERIODIC, false],
  ["no-data access", replace(healthy(), noDataFact("issues.stats", "access", "rest:issues")), PERIODIC, false],
  ["no-data other", replace(healthy(), noDataFact("docs.presence", "other", "git")), PERIODIC, false],
  ["no-data limits (репо больше лимита)", replace(healthy(), noDataFact("tree.stats", "limits", "git")), PERIODIC, true],
  ["no-data empty (пустой репо)", replace(healthy(), noDataFact("docs.readme", "empty", "git")), PERIODIC, true],
  ["каналы CI/Security не влияют", replace(healthy(), noDataFact("cicd.runs", "access", "rest:cicd"), noDataFact("appsec.findings", "access", "appsec:api")), PERIODIC, true],
  // круг 2 (LOW-1): статус скана bad — непригоден при любых фактах
  ["status bad", healthy(), { status: "bad", userId: null }, false],
  // круг 2 (С5): юзерский скан с любым no-data git-фактом — непригоден
  ["юзерский скан, git no-data limits", replace(healthy(), noDataFact("tree.stats", "limits", "git")), { status: "partial", userId: 1 }, false],
  ["юзерский скан, всё ok", healthy(), { status: "ok", userId: 1 }, true],
];

describe("правило пригодности (К-Ф1.1)", () => {
  test("константы: PUBLIC_KINDS = READ_KINDS минус CHANNEL_KINDS", () => {
    expect(CHANNEL_KINDS).toEqual(["cicd.configs", "cicd.runs", "appsec.findings"]);
    expect(PUBLIC_KINDS).toEqual(READ_KINDS.filter((k) => !CHANNEL_KINDS.includes(k)));
    expect(PUBLIC_KINDS.length).toBe(9);
  });

  test("TS и SQL дают одинаковый ответ на каждом случае", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "e", repo: "rule" });
    for (const [name, facts, scan, expected] of CASES) {
      expect({ name, ts: ratingEligible(facts, scan) }).toEqual({ name, ts: expected });
      const scanId = seedScan(t, repoId, { facts: facts.map(asSpec), status: scan.status, userId: scan.userId });
      const row = t.db.query(`SELECT CASE WHEN ${ratingEligibleSql("s")} THEN 1 ELSE 0 END AS e FROM scans s WHERE s.id = ?`).get(scanId) as { e: number };
      expect({ name, sql: row.e === 1 }).toEqual({ name, sql: expected });
    }
  });

  test("миграция: колонки добавляются и заполняются одним UPDATE по фактам", () => {
    const dir = tempDir();
    const cfg = { ...loadConfig(), dataDir: dir };
    let db = openDb(cfg);
    const t = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "e", repo: "migrate" });
    CASES.forEach(([, facts, scan]) => seedScan(t, repoId, { facts: facts.map(asSpec), status: scan.status, userId: scan.userId }));
    db.exec("ALTER TABLE scans DROP COLUMN rating_eligible");
    db.exec("ALTER TABLE scans DROP COLUMN public_status");
    db.close();
    db = openDb(cfg);
    const rows = db.query("SELECT id, rating_eligible, public_status FROM scans ORDER BY id").all() as { id: number; rating_eligible: number; public_status: string }[];
    db.close();
    expect(rows.map((r) => r.rating_eligible === 1)).toEqual(CASES.map(([, , , e]) => e));
    // публичный статус: все публичные ok → ok (даже если каналы no-data); bad скан → bad; иначе partial
    expect(rows.map((r) => r.public_status)).toEqual(["ok", "ok", "partial", "partial", "partial", "partial", "partial", "ok", "bad", "partial", "ok"]);
  });

  test("индексы scans(repo_id, id) и jobs(status, claimed_at) (Ф1.12)", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const names = (t.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("idx_scans_repo");
    expect(names).toContain("idx_jobs_status_claimed");
  });
});

describe("runScan: хук пишет пригодность, мета — только пригодным (К-Ф1.1), public_status (Ф1.11)", () => {
  const meta = (lastActivityAt: string, visibility: string | null = "public") => ({
    org: "o",
    repo: "r",
    title: `T ${lastActivityAt}`,
    language: "Go",
    likes: 7,
    lastActivityAt,
    forks: 1,
    reactionCounts: null,
    visibility: visibility as string,
  });

  test("пригодный скан применяет мету; непригодный — только видимость; public_status без каналов", async () => {
    const dir = tempDir();
    const db = openDb({ ...loadConfig(), dataDir: dir });
    cleanups.push(() => db.close());
    const facts = healthy();
    const git = facts.filter((f) => f.source === "git");
    const rest = facts.filter((f) => f.source !== "git");
    const deps = (restFacts: Fact[], m: ReturnType<typeof meta>): ScanDeps => ({
      db,
      scClient: null,
      collectGit: async () => ({ facts: git }),
      collectRest: async () => ({ facts: restFacts, repoMeta: m, channelErrors: [] }),
    });
    // прогоны CI недоступны (канал), публичное всё ok
    const channelNoData = replace(rest, noDataFact("cicd.runs", "access", "rest:cicd"));
    const first = await runScan(deps(channelNoData, meta("2026-09-01T00:00:00Z")), "o/r");
    const row1 = db.query("SELECT status, public_status, rating_eligible FROM scans WHERE id = ?").get(first.scanId);
    expect(row1).toEqual({ status: "partial", public_status: "ok", rating_eligible: 1 });
    expect(first.ratingEligible).toBe(true);
    expect(db.query("SELECT title, last_activity_at, visibility FROM repos WHERE id = ?").get(first.repoId)).toEqual({
      title: "T 2026-09-01T00:00:00Z",
      last_activity_at: "2026-09-01T00:00:00Z",
      visibility: "public",
    });

    // непригодный скан (issues no-data access): мета не двигается, видимость — да
    const narrow = replace(rest, noDataFact("issues.stats", "access", "rest:issues"));
    const second = await runScan(deps(narrow, meta("2026-09-17T00:00:00Z", "private")), "o/r");
    expect(second.ratingEligible).toBe(false);
    expect(db.query("SELECT public_status, rating_eligible FROM scans WHERE id = ?").get(second.scanId)).toEqual({ public_status: "partial", rating_eligible: 0 });
    expect(db.query("SELECT title, last_activity_at, visibility FROM repos WHERE id = ?").get(first.repoId)).toEqual({
      title: "T 2026-09-01T00:00:00Z",
      last_activity_at: "2026-09-01T00:00:00Z",
      visibility: "private",
    });
  });
});

describe("чтение: последний пригодный (P) и последний скан (L)", () => {
  const CATS = (cicd: number, docs: number) => ({
    documentation: { score: docs, submetrics: {} },
    cicd: { score: cicd, submetrics: {} },
  });

  test("рейтинг, мета и карточка: оценка из P; scan и статус — L; CI — скан с ok-данными CI; полный Score — из показанных категорий", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "pl", repo: "repo" });
    const p = seedScan(t, repoId, { status: "partial", publicStatus: "ok", facts: [{ key: "docs.presence", source: "git", value: { readme: true } }] });
    seedScore(t, repoId, p, { total: 60, totalFull: 50, categories: CATS(50, 61) });
    seedRecommendation(t, p, { ruleId: "license-missing", priority: 1, factRef: "docs.presence", deltaScore: 5.7692 });
    seedRecommendation(t, p, { ruleId: "fix-red-runs", priority: 2, factRef: "cicd.runs", channel: "cicd" });
    const l = seedScan(t, repoId, {
      status: "partial",
      publicStatus: "partial",
      ratingEligible: false,
      facts: [
        { key: "docs.presence", source: "git", status: "no-data", value: { reason: "other" } },
        { key: "cicd.configs", source: "git", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
        { key: "cicd.runs", source: "rest:cicd", value: { runs_count: 3, success_rate: 1, last_status: "success", duration_p50: 10 } },
      ],
    });
    seedScore(t, repoId, l, { total: 10, totalFull: 70, categories: CATS(90, 5) });
    seedRecommendation(t, l, { ruleId: "readme-missing", priority: 1, factRef: "docs.presence" });
    seedRecommendation(t, l, { ruleId: "speed-up-pipeline", priority: 2, factRef: "cicd.runs", channel: "cicd" });
    // незавершённый скан после них: блок scan показывает его
    const running = t.db.query("INSERT INTO scans (repo_id, started_at, status, public_status, trigger) VALUES (?, '2026-09-17T10:00:00Z', 'running', 'running', 'user')").run(repoId);

    const item = listRepos(t.db, DEFAULT_QUERY).items.find((i) => i.repo === "repo")!;
    // круг 2 (LOW-2): статус и время — последнего скана, как в карточке
    expect({ score: item.score, status: item.scanStatus }).toEqual({ score: 60, status: "running" });
    expect(getMeta(t.db).repos).toEqual({ scored: 1, nullScore: 0 });

    const granted = { cicd: "granted", appsec: "granted", repo: "granted" } as const;
    const card = getRepoCard(t.db, "pl", "repo", { access: granted })!;
    expect(card.scan).toMatchObject({ id: Number(running.lastInsertRowid), status: "running" });
    expect({
      totalRating: card.score!.totalRating,
      totalFull: card.score!.totalFull,
      docs: card.score!.categories.documentation.score,
      cicd: card.score!.categories.cicd.score,
    }).toEqual({
      totalRating: 60,
      totalFull: Math.round(totalsFromCategories(card.score!.categories, { codeEmpty: false, secretsCritical: false }).totalFull!),
      docs: 61,
      cicd: 100, // посчитана из ok-фактов CI скана L (зелёные быстрые раны), не из сохранённой строки
    });
    // публичные правила — сохранённые P; канальные — движок на показанных фактах (раны зелёные: CI-правил нет; AppSec нет)
    expect(card.recommendations.map((r) => r.ruleId)).toEqual(["license-missing", "connect-appsec"]);
    expect(card.recommendations.map((r) => r.priority)).toEqual([1, 2]);
    const docs = card.evidence.find((e) => e.key === "docs.presence")!;
    expect(docs.status).toBe("ok");
    expect(card.evidence.find((e) => e.key === "cicd.runs")?.status).toBe("ok");

    // аноним: публичная часть та же, канальной нет
    const anon = getRepoCard(t.db, "pl", "repo")!;
    expect(anon.score!.totalRating).toBe(60);
    expect(anon.recommendations.map((r) => r.ruleId)).toEqual(["license-missing"]);
    expect(anon.evidence.some((e) => CHANNEL_KINDS.includes(e.key))).toBe(false);
  });

  test("нет пригодного скана: карточка «ещё не оценивали» (score null), статус последнего анализа есть; в рейтинге нет", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "pl", repo: "never-eligible" });
    const s = seedScan(t, repoId, { status: "bad", publicStatus: "bad", ratingEligible: false });
    seedScore(t, repoId, s, { total: null });
    const card = getRepoCard(t.db, "pl", "never-eligible")!;
    expect({ score: card.score, scan: card.scan?.status, recs: card.recommendations.length }).toEqual({ score: null, scan: "bad", recs: 0 });
    const out = listRepos(t.db, DEFAULT_QUERY);
    expect([...out.items, ...out.nullItems].some((i) => i.repo === "never-eligible")).toBe(false);
  });
});

describe("«мои репо» и заявка (К-Ф1.1)", () => {
  test("listMyRepos: Score — из последнего пригодного скана", async () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "me", repo: "mine" });
    seedScore(t, repoId, seedScan(t, repoId), { total: 71 });
    seedScore(t, repoId, seedScan(t, repoId, { ratingEligible: false }), { total: 12 });
    const client: ScClient = {
      async get(path: string) {
        if (path === "/user") return { status: 200, json: { username: "me" }, bodyText: "" };
        return { status: 200, json: { repositories: [{ organization: { slug: "me" }, slug: "mine", name: "Mine" }] }, bodyText: "" };
      },
      requestCount: () => 0,
    };
    const out = await listMyRepos(t.db, client, null);
    expect(out.entries.map((e) => [e.repo, e.score])).toEqual([["mine", 71]]);
  });

  test("listMyRepos (круг 2): приватный без пригодного скана — Score последнего не-bad; время — последнего анализа", async () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const priv = seedRepo(t, { org: "me", repo: "secret" });
    t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    seedScore(t, priv, seedScan(t, priv, { ratingEligible: false, status: "partial", startedAt: "2026-09-10T00:00:00Z" }), { total: 44 });
    seedScore(t, priv, seedScan(t, priv, { ratingEligible: false, status: "bad", startedAt: "2026-09-11T00:00:00Z" }), { total: null });
    const pub = seedRepo(t, { org: "me", repo: "open" });
    seedScore(t, pub, seedScan(t, pub, { ratingEligible: false, status: "partial", startedAt: "2026-09-12T00:00:00Z" }), { total: 33 });
    const client: ScClient = {
      async get(path: string) {
        if (path === "/user") return { status: 200, json: { username: "me" }, bodyText: "" };
        return {
          status: 200,
          json: { repositories: [{ organization: { slug: "me" }, slug: "secret" }, { organization: { slug: "me" }, slug: "open" }] },
          bodyText: "",
        };
      },
      requestCount: () => 0,
    };
    const out = await listMyRepos(t.db, client, null);
    expect(out.entries.map((e) => [e.repo, e.score, e.lastScanAt])).toEqual([
      ["secret", 44, "2026-09-11T00:00:00Z"],
      ["open", null, "2026-09-12T00:00:00Z"],
    ]);
  });

  test("requestUserScan: существующая строка не обновляется; новая без visibility — private", async () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const user = upsertUser(t.db, "ya-meta", "meta");
    const existing = seedRepo(t, { org: "own", repo: "old", title: "Old" });
    const body = (json: unknown): ScClient => ({ get: async () => ({ status: 200, json, bodyText: "" }), requestCount: () => 0 });
    const queue = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 100 };
    expect((await requestUserScan(t.db, body({ name: "New", visibility: "private" }), user, "own", "old", queue)).status).toBe(202);
    expect(t.db.query("SELECT title, visibility FROM repos WHERE id = ?").get(existing)).toEqual({ title: "Old", visibility: "public" });
    expect((await requestUserScan(t.db, body({ name: "Fresh" }), user, "own", "fresh", queue)).status).toBe(202);
    expect(t.db.query("SELECT title, visibility FROM repos WHERE repo_slug = 'fresh'").get()).toEqual({ title: "Fresh", visibility: "private" });
  });
});

test("категории фактов фикстур (гигиена)", () => {
  expect(PUBLIC_KINDS.map(categoryOf)).not.toContain("meta");
});

describe("правило карточки (круг 2): источники каналов и приватный без P", () => {
  test("CI без скана с ok-ранами — из последнего скана с ok-конфигом (потолок «только конфиг»); приватный только с bad-сканами — score null", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "ch", repo: "cfg" });
    const s1 = seedScan(t, repoId, {
      facts: [
        { key: "cicd.configs", source: "git", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
        { key: "cicd.runs", source: "rest:cicd", status: "no-data", value: { reason: "access" } },
      ],
    });
    seedScore(t, repoId, s1, { total: 50 });
    const granted = { cicd: "granted", appsec: "granted", repo: "granted" } as const;
    const card = getRepoCard(t.db, "ch", "cfg", { access: granted })!;
    expect(card.score!.categories.cicd.score).toBe(50);
    expect(card.markers.ciConfigOnlyCap).toBe(true);
    expect(card.evidence.find((e) => e.key === "cicd.runs")?.status).toBe("no-data");

    const priv = seedRepo(t, { org: "ch", repo: "badonly" });
    t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    seedScore(t, priv, seedScan(t, priv, { status: "bad", ratingEligible: false }), { total: null });
    expect(getRepoCard(t.db, "ch", "badonly", { access: granted })!.score).toBeNull();
  });
});
