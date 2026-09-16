// scan-runner.test.ts — Б4+В4/Б3: конвейер scan-job на фейк-каналах
// (git/REST инъектятся целиком — сетевых вызовов нет): статусы
// ok/partial/bad, факты со scan_id/status/source/collected_at,
// повторный скан = новый scan_id; очередь (jobs) с В4/Б3 отделена от
// runScan и живёт в scheduler (enqueued отдельно, без UNIQUE(repo_id)).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { fillMissingFacts, runScan, GitChannelOutcome, ScanDeps } from "../src/jobs/runner";
import { okFact, noDataFact, badChannelFact, Fact } from "../src/collectors/facts";
import { cleanupClone, gitFactsNoData } from "../src/collectors/git";
import type { Database } from "bun:sqlite";
import type { RestCollectResult } from "../src/collectors/rest";

const dir = mkdtempSync(join(tmpdir(), "rh-runner-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const gitOk = (): GitChannelOutcome => ({
  facts: [
    okFact("activity.git.summary", { commits: 5 }, "git"),
    okFact("docs.presence", { readme: true }, "git"),
  ],
});
const gitLimits = (): GitChannelOutcome => ({
  facts: [noDataFact("activity.git.summary", "limits", "git", "disk")],
  failure: "limits",
  detail: "disk",
});
const restOk = (slug: string): RestCollectResult => ({
  facts: [
    okFact("issues.stats", { open: 1, closed: 2 }, "rest:issues"),
    okFact("cicd.runs", { last_status: null }, "rest:cicd"),
  ],
  repoMeta: { org: "o", repo: slug.split("/")[1] ?? "", title: "T", language: "Go", likes: 25, lastActivityAt: "2026-09-15T00:00:00Z", forks: 3, reactionCounts: [{ type: "positive_high", count: 5 }], visibility: "public" },
  channelErrors: [],
});
const rest403Runs = (slug: string): RestCollectResult => ({
  facts: [
    okFact("issues.stats", { open: 1 }, "rest:issues"),
    noDataFact("cicd.runs", "access", "rest:cicd", "status 403"),
  ],
  repoMeta: null,
  channelErrors: [{ resource: "cicd-runs", kind: "access", status: 403 }],
});
const restDead = (): RestCollectResult => ({
  facts: [
    badChannelFact("issues.stats", "rest:issues", "503"),
    badChannelFact("issues.comments_sample", "rest:comments", "503"),
    badChannelFact("activity.rest", "rest:activity", "503"),
    badChannelFact("cicd.runs", "rest:cicd", "503"),
  ],
  repoMeta: null,
  channelErrors: [
    { resource: "repo", kind: "bad-channel", status: 503 },
    { resource: "issues-open", kind: "bad-channel", status: 503 },
    { resource: "cicd-runs", kind: "bad-channel", status: 503 },
  ],
});

const deps = (git: () => GitChannelOutcome, rest: (slug: string) => RestCollectResult): ScanDeps => ({
  db,
  scClient: null,
  collectGit: async () => git(),
  collectRest: async (slug) => rest(slug),
});

describe("runScan: статусы и три-state", () => {
  test("все факты ok → scan ok; факты в БД со всеми колонками контракта", async () => {
    const r = await runScan(deps(gitOk, restOk), "o/alpha");
    expect(r.status).toBe("ok");
    expect(r.counts.ok).toBe(4);
    const rows = db.query("SELECT * FROM facts WHERE scan_id = ?").all(r.scanId) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row["status"]).toBe("ok");
      expect(typeof row["collected_at"]).toBe("string");
      expect((row["collected_at"] as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof row["source"]).toBe("string");
    }
    // мета репо из REST доехала в repos
    const repo = db.query("SELECT * FROM repos WHERE repo_slug = 'alpha'").get() as Record<string, unknown>;
    expect(repo["title"]).toBe("T");
    expect(repo["likes"]).toBe(25);
    expect(repo["language"]).toBe("Go");
    // В4/Б3: очередь отделена от runScan (jobs — scheduler/enqueueScan)
    const jobs = db.query("SELECT COUNT(*) c FROM jobs WHERE repo_id = ?").get(r.repoId) as { c: number };
    expect(jobs.c).toBe(0);
    // scan закрыт временем
    const scan = db.query("SELECT * FROM scans WHERE id = ?").get(r.scanId) as Record<string, unknown>;
    expect(scan["status"]).toBe("ok");
    expect(scan["finished_at"]).toBeTruthy();
  });

  test("git no-data(limits) + rest ok → partial (ядро есть)", async () => {
    const r = await runScan(deps(gitLimits, restOk), "o/big");
    expect(r.status).toBe("partial");
    expect(r.channels.git).toBe("no-data(limits)");
    expect(r.counts.noData).toBe(1);
  });

  test("cicd/runs 403 → no-data reason=access в фактах, скан partial", async () => {
    const r = await runScan(deps(gitOk, rest403Runs), "o/foreign");
    expect(r.status).toBe("partial");
    const runs = db.query("SELECT value, status FROM facts WHERE scan_id = ? AND key = 'cicd.runs'").get(r.scanId) as Record<string, unknown>;
    expect(runs["status"]).toBe("no-data");
    expect(JSON.parse(String(runs["value"])).reason).toBe("access");
  });

  test("git fatal + весь REST bad-channel → bad; repo-сигнал неизвестен", async () => {
    const r = await runScan(deps(gitLimits, restDead), "o/doom");
    expect(r.status).toBe("bad");
    expect(r.repoAccess).toBe("unknown"); // REST мёртв — репо-GET не состоялся
  });

  test("REST нет токена → rest no-data, git ok → partial", async () => {
    const r = await runScan({ db, scClient: null, collectGit: async () => gitOk() }, "o/notoken");
    expect(r.status).toBe("partial");
    expect(r.channels.rest).toBe("no-data(no-token)");
    const restFacts = db.query("SELECT * FROM facts WHERE scan_id = ? AND source LIKE 'rest%'").all(r.scanId) as Array<Record<string, unknown>>;
    expect(restFacts.length).toBe(4);
    expect(restFacts.every((f) => f["status"] === "no-data")).toBe(true);
  });

  test("повторный скан = новый scan_id со свежим временем, старые факты остаются", async () => {
    const r1 = await runScan(deps(gitOk, restOk), "o/twice");
    await new Promise((res) => setTimeout(res, 20));
    const r2 = await runScan(deps(gitOk, restOk), "o/twice");
    expect(r2.scanId).toBeGreaterThan(r1.scanId);
    expect(new Date(r2.startedAt).getTime()).toBeGreaterThan(new Date(r1.startedAt).getTime());
    expect(r2.repoId).toBe(r1.repoId);
    const n1 = db.query("SELECT COUNT(*) c FROM facts WHERE scan_id = ?").get(r1.scanId) as { c: number };
    const n2 = db.query("SELECT COUNT(*) c FROM facts WHERE scan_id = ?").get(r2.scanId) as { c: number };
    expect(n1.c).toBe(4);
    expect(n2.c).toBe(4);
    // В4/Б3: очередь без UNIQUE — строки создаются enqueueScan'ом, не сканом
    const jobs = db.query("SELECT COUNT(*) c FROM jobs WHERE repo_id = ?").get(r1.repoId) as { c: number };
    expect(jobs.c).toBe(0);
  });

  test("fatal воркера ловится: канал кидает — скан bad, не бросает", async () => {
    const boom: ScanDeps = {
      db,
      scClient: null,
      collectGit: () => {
        throw new Error("boom-git");
      },
      collectRest: () => {
        throw new Error("boom-rest");
      },
    };
    const r = await runScan(boom, "o/boom");
    expect(r.status).toBe("bad");
    expect(r.channels.git).toBe("fatal");
    const factRows = db.query("SELECT status FROM facts WHERE scan_id = ?").all(r.scanId) as Array<Record<string, unknown>>;
    expect(factRows.length).toBeGreaterThan(0); // git no-data факты записаны
    void ([] as Fact[]);
  });
});

describe("В2/Б5: score-hook — конец скана пишет scores/recommendations", () => {
  test("runScan с полными фейк-каналами → строки scores и recommendations на месте", async () => {
    const facts: Fact[] = [
      okFact("activity.git.timeline", { events: [{ sha: "a1", author: { name: "A", email: "a@x.y", date: "2026-09-10T00:00:00Z" }, committer: { name: "A", email: "a@x.y", date: "2026-09-10T00:00:00Z" } }] }, "git"),
      okFact("activity.git.summary", { commits: 1, authors: 1, committers: 1, robot_commits: 0, robot_ratio: 0 }, "git"),
      okFact("docs.presence", { readme: true, license: false, contributing: false, codeowners: false }, "git"),
      okFact("docs.readme", { bytes: 3000, sections: 2, flags: { install: true, build: false, test: false } }, "git"),
      okFact("tree.stats", { top_level: [{ name: "src", type: "tree" }], file_count: 5, bytes: 1000, loc: 400 }, "git"),
      okFact("cicd.configs", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true }, "git"),
      noDataFact("cicd.runs", "access", "rest:cicd", "403"),
      okFact("code.todo", { count: 1, fixme: 0, older_180d: 0, todo_files: 1, blamed_files: 1 }, "git"),
      okFact("issues.stats", { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 }, "rest:issues"),
      okFact("issues.comments_sample", { issues: 0, with_comments: 0, median_first_comment_delay_hours: null, delays_hours: [] }, "rest:comments"),
      okFact("activity.rest", { contributors: 1, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] }, "rest:activity"),
    ];
    const deps: ScanDeps = {
      db,
      scClient: null,
      collectGit: async () => ({ facts: facts.filter((f) => f.source === "git") }),
      collectRest: async () => ({ facts: facts.filter((f) => f.source.startsWith("rest")), repoMeta: null, channelErrors: [{ resource: "cicd-runs", kind: "access", status: 403 }] }),
    };
    const res = await runScan(deps, "hook/repo");
    expect(res.score).not.toBeNull();
    expect(res.score!.total).not.toBeNull();
    const row = db.query("SELECT total, model_version FROM scores WHERE scan_id = ?").get(res.scanId) as { total: number; model_version: string };
    expect(row.model_version).toBe("3.0.0-m4");
    expect(row.total).toBe(Math.round(res.score!.total!));
    const recs = db.query("SELECT rule_id FROM recommendations WHERE scan_id = ? ORDER BY priority").all(res.scanId) as { rule_id: string }[];
    expect(recs.map((r) => r.rule_id)).toContain("start-tracker");
    expect(recs.map((r) => r.rule_id)).toContain("license-missing");
  });
});

// ERROR_LOG 16.09: сбой уборки клона не должен разрушать успешный
// git-канал. Два инварианта отдельно — путь «rm бросил после
// extractFacts» не воспроизводится портируемо, поэтому проверяем
// механизмы, из которых он был собран.
describe("EBUSY-регрессия (16.09): уборка клона не рушит собранное", () => {
  test("fillMissingFacts: fallback дополняет, но не затирает собранные kind'ы", () => {
    const collected: Fact[] = [
      okFact("activity.git.summary", { commits: 42 }, "git"),
      okFact("docs.presence", { readme: true }, "git"),
    ];
    const fallback = gitFactsNoData("other", "EBUSY: resource busy or locked");
    const added = fillMissingFacts(collected, fallback);

    const addedKinds = added.map((f) => f.key);
    expect(addedKinds).not.toContain("activity.git.summary");
    expect(addedKinds).not.toContain("docs.presence");
    expect(addedKinds).toContain("code.todo"); // не собранный kind — дополняется
    expect(added.every((f) => f.status === "no-data")).toBe(true);
    // объединение: живые факты на месте, дублей по kind нет
    const merged = [...collected, ...added];
    expect(new Set(merged.map((f) => f.key)).size).toBe(merged.length);
    expect(merged.find((f) => f.key === "activity.git.summary")!.status).toBe("ok");
  });

  test("cleanupClone: удаляет каталог, возвращает null; ошибку отдаёт значением, не исключением", () => {
    const victim = mkdtempSync(join(tmpdir(), "rh-cleanup-"));
    writeFileSync(join(victim, "HEAD"), "ref: refs/heads/main\n");
    expect(cleanupClone(victim)).toBeNull();
    expect(existsSync(victim)).toBe(false);
    // повторная уборка уже удалённого — не ошибка (force)
    expect(cleanupClone(victim)).toBeNull();
    // заведомо невалидный путь: строка-диагностика вместо throw
    const err = cleanupClone("\0:invalid", 1, 1);
    expect(typeof err).toBe("string");
  });
});
