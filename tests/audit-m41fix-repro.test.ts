// audit-m41fix-repro.test.ts — воспроизведение находок аудит-пары на
// реализацию В4.1-fix (reports/2026-09-17-m41fix-audit-pair.md; решение
// владельца п.1 «правило карточки» и механические правки 1–15, TASK.md §2
// «Аудит В4.1-fix → правило карточки и исправления»). Второй круг, Б7.
// Каждый тест описывает ПРАВИЛЬНОЕ поведение и ассертит конкретное значение.
// Пока находка жива — test.failing (набор зелёный); в строгом режиме красный:
// AUDIT_STRICT=1 bun test tests/audit-m41fix-repro.test.ts
// Сети нет: каналы скана — фейки, git — локальные каталоги.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { noDataFact, okFact, type Fact } from "../src/collectors/facts";
import { extractFacts, gitFactsNoData } from "../src/collectors/git";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { upsertUser } from "../src/auth/session";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { runScan, type ScanDeps } from "../src/jobs/runner";
import { claimNext, nightlyCatalog } from "../src/jobs/scheduler";
import { CATEGORY_WEIGHTS, type CategoryKey } from "../src/score/model";
import { healthyFacts } from "./score-fixtures";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-audit41fix-"));
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
const healthy = (): Fact[] => healthyFacts().map((f) => okFact(f.key, f.value, SOURCES[f.key] ?? "git"));
const replace = (facts: Fact[], ...patch: Fact[]): Fact[] => [...facts.filter((f) => !patch.some((p) => p.key === f.key)), ...patch];
const APPSEC_OK = okFact("appsec.findings", { severity_counts: { critical: 0, high: 1, medium: 2, low: 3 }, resolved_share: 0.9, secrets_critical: false }, "appsec:api");
const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;

/** Скан через настоящий runScan (хук, пригодность, мета); каналы — готовые факты. */
async function scanWith(db: Database, slug: string, facts: Fact[], opts: { userId?: number | null; appsec?: Fact | null; visibility?: string } = {}) {
  const [org, repo] = slug.split("/") as [string, string];
  const git = facts.filter((f) => f.source === "git");
  const rest = facts.filter((f) => f.source.startsWith("rest:"));
  const deps: ScanDeps = {
    db,
    scClient: null,
    collectGit: async () => ({ facts: git }),
    collectRest: async () => ({
      facts: rest,
      repoMeta: { org, repo, title: repo, language: "Go", likes: 1, lastActivityAt: "2026-09-10T00:00:00Z", forks: 0, reactionCounts: null, visibility: opts.visibility ?? "public" },
      channelErrors: [],
    }),
    collectAppsec: async () =>
      opts.appsec ? { fact: opts.appsec, noData: null } : { fact: null, noData: { reason: "access", detail: "401" } },
  };
  const user = opts.userId ?? null;
  return runScan(deps, slug, user !== null ? { trigger: "user", userId: user, userToken: "pat" } : { trigger: "periodic" });
}

/** Полный Score «складывается из показанных категорий»: взвешенное среднее категорий с данными. */
function composedFull(categories: Record<CategoryKey, { score: number | null }>): number {
  let w = 0;
  let acc = 0;
  for (const [key, cat] of Object.entries(categories) as [CategoryKey, { score: number | null }][]) {
    if (cat.score === null) continue;
    w += CATEGORY_WEIGHTS[key];
    acc += cat.score * CATEGORY_WEIGHTS[key];
  }
  return acc / w;
}

// ---------------------------------------------------------------------------
describe("Н1 (HIGH): claimNext на большой истории очереди", () => {
  repro(
    "claimNext при 20k строк истории и 300 заявках в очереди — быстрее 100 мс",
    () => {
      const db = tempDb();
      const HISTORY = 20_000;
      const USERS = 2_000;
      db.transaction(() => {
        const users = db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, '2026', '2026')");
        for (let u = 1; u <= USERS; u++) users.run(`ya-${u}`, `u${u}`);
        const repos = db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('perf', ?, 'public')");
        for (let r = 1; r <= 300; r++) repos.run(`r${r}`);
        const job = db.query(
          "INSERT INTO jobs (repo_id, status, user_id, trigger_kind, claimed_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const base = Date.parse("2026-08-01T00:00:00Z");
        for (let i = 0; i < HISTORY; i++) {
          job.run(1 + (i % 300), "done", 1 + (i % USERS), "user", new Date(base + i * 1000).toISOString(), 1, new Date(base + i * 1000).toISOString());
        }
        for (let r = 1; r <= 300; r++) {
          const user = r % 3 === 0 ? null : 1 + ((r * 7) % USERS);
          job.run(r, "queued", user, user === null ? "periodic" : "user", null, 0, new Date(base + HISTORY * 1000 + r).toISOString());
        }
      })();
      const times: number[] = [];
      let t = Date.parse("2026-09-18T00:00:00Z");
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const job = claimNext(db, new Date((t += 1000)));
        times.push(performance.now() - t0);
        expect(job).not.toBeNull();
      }
      const median = [...times].sort((a, b) => a - b)[1]!;
      expect(median).toBeLessThan(100);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
describe("С1: канальная часть карточки и полный Score не из последнего скана вслепую", () => {
  repro("скан с отозванным PAT не меняет CI/Security/полный Score участника; полный Score складывается из показанных категорий", async () => {
    const db = tempDb();
    const owner = upsertUser(db, "ya-owner", "owner");
    const stranger = upsertUser(db, "ya-revoked", "revoked");
    await scanWith(db, "team/app", healthy(), { userId: owner, appsec: APPSEC_OK });
    const before = getRepoCard(db, "team", "app", { access: GRANTED })!;
    const snap = (c: typeof before) => ({
      cicd: c.score!.categories.cicd.score,
      security: c.score!.categories.security.score,
      totalFull: c.score!.totalFull,
    });
    expect(snap(before).totalFull).not.toBeNull();

    // скан с отозванным PAT: клон по PAT не удался, REST и AppSec — 401
    const revoked = [
      ...gitFactsNoData("other", "Authentication failed"),
      noDataFact("issues.stats", "access", "rest:issues", "401"),
      noDataFact("issues.comments_sample", "access", "rest:issues", "401"),
      noDataFact("activity.rest", "access", "rest:activity", "401"),
      noDataFact("cicd.runs", "access", "rest:cicd", "401"),
    ];
    await scanWith(db, "team/app", revoked, { userId: stranger, appsec: null });
    const after = getRepoCard(db, "team", "app", { access: GRANTED })!;
    expect(snap(after)).toEqual(snap(before));
    const shown = composedFull(after.score!.categories);
    expect(Math.abs(after.score!.totalFull! - shown)).toBeLessThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
describe("С2: приватный репо без пригодного скана", () => {
  repro("владелец видит оценку своего приватного репо и свои CI/Security, хотя трекер выключен (issues 404 → access)", async () => {
    const db = tempDb();
    const owner = upsertUser(db, "ya-private-owner", "powner");
    const facts = replace(
      healthy(),
      noDataFact("issues.stats", "access", "rest:issues", "status 404/404"),
      noDataFact("issues.comments_sample", "access", "rest:issues", "status 404/404"),
    );
    const res = await scanWith(db, "own/private", facts, { userId: owner, appsec: APPSEC_OK, visibility: "private" });
    expect(res.status).toBe("partial");
    const card = getRepoCard(db, "own", "private", { access: GRANTED })!;
    expect(card).not.toBeNull();
    expect({
      totalRating: typeof card.score?.totalRating,
      cicd: typeof card.score?.categories.cicd.score,
      security: typeof card.score?.categories.security.score,
      totalFull: typeof card.score?.totalFull,
    }).toEqual({ totalRating: "number", cicd: "number", security: "number", totalFull: "number" });
  });
});

// ---------------------------------------------------------------------------
describe("С3: непригодный периодический скан перезапускается", () => {
  repro("ночной обход ставит перескан репо, чей последний периодический скан непригоден (last_updated не менялся)", async () => {
    const db = tempDb();
    const last = "2026-09-01T00:00:00Z";
    db.query("INSERT INTO repos (org_slug, repo_slug, visibility, last_activity_at) VALUES ('cat', 'flaky', 'public', ?)").run(last);
    const repoId = (db.query("SELECT id FROM repos WHERE repo_slug = 'flaky'").get() as { id: number }).id;
    // ночь 16.09: периодический скан с исчерпанным бюджетом — partial, непригоден; job закрыта done
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, public_status, trigger, rating_eligible) VALUES (?, ?, ?, 'partial', 'partial', 'periodic', 0)").run(
      repoId,
      "2026-09-16T20:00:00Z",
      "2026-09-16T20:05:00Z",
    );
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, claimed_at, attempts, created_at) VALUES (?, 'done', 'periodic', ?, 1, ?)").run(
      repoId,
      "2026-09-16T20:00:00Z",
      "2026-09-16T19:00:00Z",
    );
    const client: ScClient = {
      async get(path: string): Promise<ScResponse> {
        if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
        return {
          status: 200,
          json: { repositories: [{ organization: { slug: "cat" }, slug: "flaky", name: "flaky", visibility: "public", last_updated: last, language: null }], next_page_token: "" },
          bodyText: "",
        };
      },
      requestCount: () => 0,
    };
    const out = await nightlyCatalog(db, client, { now: new Date("2026-09-17T20:00:00Z") });
    expect(out.enqueued.map((e) => e.slug)).toEqual(["cat/flaky"]);
  });
});

// ---------------------------------------------------------------------------
describe("С4: Δ канальных правил не раскрывает Security", () => {
  repro("зритель с CI без AppSec не видит числа Δ CI-правила и текста про кап 49 (карточка и MD)", async () => {
    const db = tempDb();
    const owner = upsertUser(db, "ya-ci-only", "cionly");
    const noCi = replace(healthy(), okFact("cicd.configs", { paths: [], has_ci_yaml: false, has_steps: false }, "git"));
    const secrets = okFact("appsec.findings", { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true }, "appsec:api");
    await scanWith(db, "leak/app", noCi, { userId: owner, appsec: secrets });
    const card = getRepoCard(db, "leak", "app", { access: { cicd: "granted", appsec: "denied", repo: "granted" } })!;
    const rule = card.recommendations.find((r) => r.ruleId === "ci-missing")!;
    expect(rule).toBeDefined();
    const md = renderRepoReport(card);
    const mdBlock = md.slice(md.indexOf(rule.problem), md.indexOf("- Правило: `ci-missing`"));
    expect({
      delta: rule.deltaScore,
      impactHasNumber: /\d/.test(rule.expectedImpact ?? ""),
      impactMentionsCap: /кап|49/.test(rule.expectedImpact ?? ""),
      mdHasNumber: /\d/.test(mdBlock.replace(/`[^`]*`/g, "")),
      mdMentionsCap: /кап 49/.test(mdBlock),
    }).toEqual({ delta: null, impactHasNumber: false, impactMentionsCap: false, mdHasNumber: false, mdMentionsCap: false });
  });
});

// ---------------------------------------------------------------------------
describe("С5: временные сбои git не делают скан пригодным", () => {
  repro("юзерский скан с no-data git-фактами (limits) непригоден", async () => {
    const db = tempDb();
    const user = upsertUser(db, "ya-slow-pat", "slowpat");
    const facts = [...gitFactsNoData("limits", "clone exceeded timeout"), ...healthy().filter((f) => f.source !== "git")];
    const res = await scanWith(db, "slow/app", facts, { userId: user, appsec: null });
    const row = db.query("SELECT rating_eligible FROM scans WHERE id = ?").get(res.scanId) as { rating_eligible: number };
    expect({ result: res.ratingEligible, stored: row.rating_eligible }).toEqual({ result: false, stored: 0 });
  });

  repro("исключение symbolic-ref/rev-parse, не означающее «нет коммитов», — no-data other, а не empty", async () => {
    const missing = join(tmpdir(), `rh-no-such-clone-${Date.now()}`);
    const facts = await extractFacts(missing, { maxBlameFiles: 10, textCapBytes: 10_000 });
    expect([...new Set(facts.map((f) => (f.value as { reason?: string }).reason))]).toEqual(["other"]);
  });
});
