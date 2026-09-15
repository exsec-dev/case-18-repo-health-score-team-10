// scan-runner.test.ts — Б4: конвейер scan-job на фейк-каналах (git/REST
// инъектятся целиком — сетевых вызовов нет): статусы ok/partial/bad,
// факты со scan_id/status/source/collected_at, повторный скан = новый
// scan_id, job-строка одна на репо (UNIQUE).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { runScan, GitChannelOutcome, ScanDeps } from "../src/jobs/runner";
import { okFact, noDataFact, badChannelFact, Fact } from "../src/collectors/facts";
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
  repoMeta: { org: "o", repo: slug.split("/")[1] ?? "", title: "T", language: "Go", likes: 25, lastActivityAt: "2026-09-15T00:00:00Z" },
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
    // job-строка done
    const job = db.query("SELECT * FROM jobs WHERE repo_id = ?").get(r.repoId) as Record<string, unknown>;
    expect(job["status"]).toBe("done");
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

  test("git fatal + весь REST bad-channel → bad; job failed", async () => {
    const r = await runScan(deps(gitLimits, restDead), "o/doom");
    expect(r.status).toBe("bad");
    const job = db.query("SELECT status FROM jobs WHERE repo_id = ?").get(r.repoId) as Record<string, unknown>;
    expect(job["status"]).toBe("failed");
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
    // одна job-строка на репо
    const jobs = db.query("SELECT COUNT(*) c FROM jobs WHERE repo_id = ?").get(r1.repoId) as { c: number };
    expect(jobs.c).toBe(1);
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
