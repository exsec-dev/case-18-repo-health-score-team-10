// audit-m41-repro.test.ts — воспроизведение находок аудит-пары В4.1
// (reports/2026-09-17-m41-audit-pair.md; план reports/2026-09-17-fix-plan.md,
// веха В4.1-fix, Б0). Каждый тест описывает ПРАВИЛЬНОЕ поведение (контракты
// Части 3 плана) и ассертит конкретное значение. На Б0-коммите тесты были
// помечены test.failing (набор зелёный, в строгом режиме — красный); пометка
// снималась в блоке, закрывшем находку (Б1–Б4), утверждения не ослаблялись.
// Сейчас все тесты обычные и зелёные в обоих режимах; строгий режим оставлен
// для команды приёмки: AUDIT_STRICT=1 bun test tests/audit-m41-repro.test.ts
// Сети нет: каналы скана — фейки, REST/AppSec-клиенты — фейки.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config, type QueueConfig } from "../src/config";
import { openDb } from "../src/db";
import { noDataFact, okFact, type Fact } from "../src/collectors/facts";
import type { ScClient } from "../src/collectors/http";
import type { AppsecClient } from "../src/collectors/appsec";
import { upsertUser } from "../src/auth/session";
import { makeAccessCache, resolveAccess } from "../src/auth/access";
import { requestUserScan } from "../src/api/me";
import { getRepoCard, listRepos, DEFAULT_QUERY } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { runScan, type ScanDeps } from "../src/jobs/runner";
import { enqueueScan, claimNext, processJob } from "../src/jobs/scheduler";
import { compute } from "../src/score/compute";
import { recommend } from "../src/score/recommend";
import { healthyFacts, makeDb, seedScan as seedScoreScan, withFacts, NOW as SCORE_NOW } from "./score-fixtures";
import { makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore } from "./api-fixtures";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-audit41-"));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const SOURCES: Record<string, string> = {
  "issues.stats": "rest:issues",
  "issues.comments_sample": "rest:comments",
  "activity.rest": "rest:activity",
  "cicd.runs": "rest:cicd",
};
const asFact = (f: { key: string; value: unknown }): Fact => okFact(f.key, f.value, SOURCES[f.key] ?? "git");

// ---------------------------------------------------------------------------
describe("Ф1.1 (HIGH-1): из какого скана рейтинг", () => {
  // закрыто Б1 (К-Ф1.1): рейтинг — последний пригодный скан, мета — только пригодным
  test("юзерский скан с no-data(access) у публичного факта не меняет Score в рейтинге", async () => {
    const db = tempDb();
    db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('victim', 'public-repo', 'public')").run();
    const user = upsertUser(db, "ya-narrow", "narrow");
    const facts = healthyFacts().map(asFact);
    const gitFacts = facts.filter((f) => f.source === "git");
    const restFacts = facts.filter((f) => f.source !== "git");
    const meta = { org: "victim", repo: "public-repo", title: "Victim", language: "Go", likes: 5, lastActivityAt: "2026-09-10T00:00:00Z", forks: 0, reactionCounts: null, visibility: "public" };
    // М7 (круг 2): restBase/appsecBase обязательны типом; каналы подменены
    // швами, живого клиента не строится — адрес заведомо нерабочий локальный
    const base: ScanDeps = { db, scClient: null, restBase: "http://127.0.0.1:1", appsecBase: "http://127.0.0.1:1", collectGit: async () => ({ facts: gitFacts }) };

    // периодический скан серверным токеном: все публичные факты ok
    await runScan({ ...base, collectRest: async () => ({ facts: restFacts, repoMeta: meta, channelErrors: [] }) }, "victim/public-repo", { trigger: "periodic" });
    const before = listRepos(db, DEFAULT_QUERY).items.find((i) => i.repo === "public-repo")?.healthcraftIndex ?? null;

    // пользовательский скан узким PAT: issues недоступны (no-data access)
    const narrowRest = [
      ...restFacts.filter((f) => !f.key.startsWith("issues.")),
      noDataFact("issues.stats", "access", "rest:issues", "status 403/403"),
      noDataFact("issues.comments_sample", "access", "rest:issues", "status 403/403"),
    ];
    await runScan(
      {
        ...base,
        collectRest: async () => ({ facts: narrowRest, repoMeta: { ...meta, lastActivityAt: "2026-09-17T00:00:00Z" }, channelErrors: [] }),
        collectAppsec: async () => ({ fact: null, noData: { reason: "access", detail: "403" } }),
      },
      "victim/public-repo",
      { trigger: "user", userId: user, userToken: "narrow-pat" },
    );
    const after = listRepos(db, DEFAULT_QUERY).items.find((i) => i.repo === "public-repo")?.healthcraftIndex ?? null;
    const lastActivity = (db.query("SELECT last_activity_at FROM repos WHERE repo_slug = 'public-repo'").get() as { last_activity_at: string }).last_activity_at;
    expect(before).not.toBeNull();
    expect({ after, lastActivity }).toEqual({ after: before, lastActivity: "2026-09-10T00:00:00Z" });
  });
});

// ---------------------------------------------------------------------------
describe("Ф1.2 (LOW-1): реальный прирост рекомендаций", () => {
  // закрыто Б2 (К-Ф1.2): computeFromFacts на подменённых фактах
  test("Δ license-missing к Score в рейтинге = реальный прирост итога", () => {
    const t = makeDb();
    cleanups.push(t.close);
    const noLicense = withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: false, contributing: true, codeowners: false } });
    const withLicense = withFacts(healthyFacts(), { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: false } });
    const baseScan = seedScoreScan(t, noLicense);
    const fixedScan = seedScoreScan(t, withLicense);
    const real = compute(t.db, fixedScan, { now: SCORE_NOW }).healthcraftIndex! - compute(t.db, baseScan, { now: SCORE_NOW }).healthcraftIndex!;
    const rule = recommend(t.db, baseScan, { now: SCORE_NOW }).find((r) => r.ruleId === "license-missing")!;
    expect(real).toBeGreaterThan(0);
    expect(rule.deltaScore).toBe(Math.round(real * 10000) / 10000);
  });
});

// ---------------------------------------------------------------------------
describe("Ф1.3 (MED-1): номера рекомендаций после фильтра каналов", () => {
  // закрыто Б2 (Ф1.3): перенумерация после фильтра каналов
  test("аноним видит номера 1..N без пропусков (карточка и MD)", () => {
    const t = makeApiDb();
    cleanups.push(t.close);
    const repoId = seedRepo(t, { org: "pub", repo: "numbers" });
    const scanId = seedScan(t, repoId);
    seedScore(t, repoId, scanId, { total: 60 });
    seedRecommendation(t, scanId, { ruleId: "fix-red-runs", priority: 1, factRef: "cicd.runs", channel: "cicd" });
    seedRecommendation(t, scanId, { ruleId: "license-missing", priority: 2, factRef: "docs.presence" });
    seedRecommendation(t, scanId, { ruleId: "appsec-critical", priority: 3, factRef: "appsec.findings", channel: "appsec" });
    seedRecommendation(t, scanId, { ruleId: "reduce-stale-issues", priority: 4, factRef: "issues.stats" });
    const card = getRepoCard(t.db, "pub", "numbers")!;
    const md = renderRepoReport(card);
    const mdNumbers = [...md.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
    expect({ card: card.recommendations.map((r) => [r.ruleId, r.priority]), md: mdNumbers }).toEqual({
      card: [
        ["license-missing", 1],
        ["reduce-stale-issues", 2],
      ],
      md: [1, 2],
    });
  });
});

// ---------------------------------------------------------------------------
describe("Ф1.4 (MED-2): AppSec scans/latest 404", () => {
  // закрыто Б3 (Ф1.4)
  test("404 «скана нет» при repo-GET 200 → Security granted", async () => {
    const rest: ScClient = {
      async get(path: string) {
        if (path.endsWith("/cicd/runs?page_size=1")) return { status: 200, json: null, bodyText: "" };
        return { status: 200, json: { id: "gitrepo-1", visibility: "public" }, bodyText: "" };
      },
      requestCount: () => 0,
    };
    const appsec: AppsecClient = { get: async () => ({ status: 404, json: null }), requestCount: () => 0 };
    const out = await resolveAccess(
      { restClient: () => rest, appsecClient: () => appsec, cache: makeAccessCache(60_000) },
      { userId: 1, pat: "pat" },
      { id: 1, org: "acme", repo: "no-scan-yet", visibility: "public" },
    );
    expect(out).toEqual({ cicd: "granted", appsec: "granted", repo: "granted" });
  });
});

// ---------------------------------------------------------------------------
describe("Ф1.5 (MED-3): лимит частоты без гонки", () => {
  // закрыто Б4 (Ф1.5)
  test("5 параллельных POST при лимите 2/час → ровно 2 заявки", async () => {
    const db = tempDb();
    const user = upsertUser(db, "ya-racer", "racer");
    const slow: ScClient = {
      async get(path: string) {
        await Bun.sleep(20);
        return { status: 200, json: { name: path, visibility: "public" }, bodyText: "" };
      },
      requestCount: () => 0,
    };
    const queue = { userScansPerHour: 2, maxAttempts: 3, userActiveMax: 100, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000, retentionDays: 30, myReposPerMinute: 1000, favoritesMax: 1000 } as QueueConfig;
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => requestUserScan(db, slow, user, "race", `repo-${i}`, queue)));
    const jobs = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status = 'queued'").get(user) as { c: number }).c;
    expect({ accepted: outs.filter((o) => o.status === 202).length, limited: outs.filter((o) => o.status === 429).length, jobs }).toEqual({
      accepted: 2,
      limited: 3,
      jobs: 2,
    });
  });
});

// ---------------------------------------------------------------------------
describe("Ф1.8 (MED-6): юзерская job без PAT", () => {
  // закрыто Б4 (Ф1.8)
  test("job с автором без читаемого PAT → failed без скана, серверный токен не используется", async () => {
    const db = tempDb();
    const user = upsertUser(db, "ya-gone-pat", "gonepat");
    db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('acme', 'private-repo', 'private')").run();
    const repoId = (db.query("SELECT id FROM repos WHERE repo_slug = 'private-repo'").get() as { id: number }).id;
    const base = loadConfig();
    const config: Config = { ...base, auth: { ...base.auth, appSecret: "audit-m41-test-secret-000000000000" } };
    const calls = { serverClient: 0, scans: 0 };
    const serverClient = (): ScClient => {
      calls.serverClient++;
      return { get: async () => ({ status: 200, json: {}, bodyText: "" }), requestCount: () => 0 };
    };
    const countingScan = (async () => {
      calls.scans++;
      return { scanId: 0, repoId, status: "ok", repoAccess: "ok" };
    }) as unknown as typeof runScan;
    enqueueScan(db, repoId, { userId: user, triggerKind: "user" });
    const job = claimNext(db)!;
    await processJob({ db, config, serverClient, runScan: countingScan, getPat: () => null }, job);
    const status = (db.query("SELECT status FROM jobs WHERE id = ?").get(job.id) as { status: string }).status;
    expect({ ...calls, status }).toEqual({ serverClient: 0, scans: 0, status: "failed" });
  });
});

