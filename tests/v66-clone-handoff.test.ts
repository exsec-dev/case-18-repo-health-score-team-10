// Передача клона от скана к AI-обзору: только в цепочке «анализ + обзор» одного
// пользователя по одному репозиторию; в остальных случаях скан убирает клон сам.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { seedRepo } from "./api-fixtures";
import { HANDOFF_TTL_MS, handoffKey, offerClone, pendingHandoffs, releaseAllHandoffs, releaseHandoff, takeClone } from "../src/jobs/clone-handoff";
import { runScan } from "../src/jobs/runner";
import { chainedSummaryQueued, claimNext, finishJob, processJob, processSummaryJob, type ClaimedJob } from "../src/jobs/scheduler";
import type { SummaryRunResult } from "../src/summary/pipeline";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  releaseAllHandoffs();
  // БД закрывается до удаления каталога: Windows держит файл открытой базы (EBUSY)
  for (const db of dbs) db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(prefix: string): Database {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}

/** Репозиторий-фикстура `file://<root>/h/repo.git` с одним коммитом. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rh-v66-src-"));
  dirs.push(root);
  const src = join(root, "h", "repo.git");
  mkdirSync(src, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: src, env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" }, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Alice Dev"]);
  git(["config", "user.email", "alice@example.com"]);
  writeFileSync(join(src, "README.md"), "# Fixture\n\nInstall: run it.\n");
  writeFileSync(join(src, "app.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial import"]);
  return root;
}

const fakeClone = (dir: string, scanId: number) => ({ dir, gitEnv: {}, scanId, headSha: null, bytes: 1 });

function tmpClone(): string {
  const d = mkdtempSync(join(tmpdir(), "rh-clone-v66-"));
  writeFileSync(join(d, "HEAD"), "ref: refs/heads/main\n");
  return d;
}

describe("В6.6: реестр передачи клона", () => {
  test("offer/take: берется только для того же скана; чужой скан – клон убран; повтор ключа убирает прежний", () => {
    const a = tmpClone();
    offerClone("1:1", fakeClone(a, 10));
    expect(pendingHandoffs()).toBe(1);
    expect(takeClone("1:1", 11)).toBeNull();
    expect(existsSync(a)).toBe(false);
    expect(pendingHandoffs()).toBe(0);
    const b = tmpClone();
    const c = tmpClone();
    offerClone("1:2", fakeClone(b, 20));
    offerClone("1:2", fakeClone(c, 21));
    expect(existsSync(b)).toBe(false);
    const taken = takeClone("1:2", 21);
    expect(taken?.dir).toBe(c);
    expect(existsSync(c)).toBe(true);
    rmSync(c, { recursive: true, force: true });
    expect(takeClone("1:2", 21)).toBeNull();
  });

  test("ранний выход обзора отпускает ждущий клон сразу (releaseHandoff); пропавший с диска клон не берется", () => {
    const a = tmpClone();
    offerClone("3:1", fakeClone(a, 5));
    expect(releaseHandoff("3:1")).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(releaseHandoff("3:1")).toBe(false);
  });

  test("по TTL клон убирается сам; releaseAll убирает ждущие", async () => {
    const a = tmpClone();
    offerClone("2:1", fakeClone(a, 1), 30);
    await Bun.sleep(80);
    expect(existsSync(a)).toBe(false);
    expect(pendingHandoffs()).toBe(0);
    const b = tmpClone();
    offerClone("2:2", fakeClone(b, 2), HANDOFF_TTL_MS);
    expect(releaseAllHandoffs()).toBe(1);
    expect(existsSync(b)).toBe(false);
  });
});

describe("В6.6: цепочка «анализ + обзор» одного пользователя", () => {
  const scanDeps = (db: Database, srcRoot: string) => ({
    db,
    config: {
      ...loadConfig(),
      api: { ...loadConfig().api, gitBase: `file://${srcRoot}`, restBase: "http://127.0.0.1:1", appsecBase: "http://127.0.0.1:1" },
    },
    serverClient: () => null,
    getPat: () => "pat-of-user",
    // настоящий runScan на фикстуре; REST и AppSec – без сети
    runScan: ((deps, slug, opts) =>
      runScan(
        {
          ...deps,
          gitUrl: () => `file://${srcRoot}/h/repo.git`,
          collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }),
          collectAppsec: async () => ({ fact: null, noData: { reason: "access", detail: "test" } }),
        },
        slug,
        opts,
      )) as typeof runScan,
  });

  function seed(db: Database, userId: number): number {
    const repoId = seedRepo({ db, close: () => {} }, { org: "h", repo: "repo" });
    db.query("UPDATE repos SET visibility = 'public' WHERE id = ?").run(repoId);
    db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, '2026', '2026')").run(userId, `ya-${userId}`, `u${userId}`);
    return repoId;
  }

  test("скан, за которым стоит обзор того же пользователя, отдает клон; обзор берет его и убирает", async () => {
    const srcRoot = fixtureRepo();
    const db = freshDb("rh-v66-chain-");
    const repoId = seed(db, 7);
    const now = new Date().toISOString();
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'queued', 7, 'user', 'scan', ?)").run(repoId, now);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 7, 'user', 'summary', ?, 'full')").run(repoId, now);
    const deps = scanDeps(db, srcRoot);

    const scanJob = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
    expect(scanJob.kind).toBe("scan"); // обзор ждет свой скан
    expect(chainedSummaryQueued(db, scanJob)).toBe(true);
    const result = await processJob(deps, scanJob);
    expect(typeof result).toBe("object");
    if (typeof result !== "object") return;
    expect(result.status).not.toBe("bad");
    expect(pendingHandoffs()).toBe(1);
    finishJob(db, scanJob.id, scanJob.claimedAt, "done");

    const summaryJob = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
    expect(summaryJob.kind).toBe("summary");
    let seenGitDir: string | null = null;
    const runSummary = (async (d: { clone?: { gitDir: string | null } | null }) => {
      seenGitDir = d.clone?.gitDir ?? null;
      expect(seenGitDir !== null && existsSync(seenGitDir)).toBe(true);
      return { notes: 1, outcomes: [], failSoft: [], skipped: [], cached: false, answered: 1 } as unknown as SummaryRunResult;
    }) as never;
    const err = await processSummaryJob({ ...deps, runSummary }, summaryJob);
    expect(err).toBeNull();
    // обзор получил клон скана (каталог rh-clone-* скана), а после себя убрал его
    expect(seenGitDir).not.toBeNull();
    expect(pendingHandoffs()).toBe(0);
    expect(existsSync(seenGitDir!)).toBe(false);
  }, 60_000);

  test("обзор без завершенного скана отпускает переданный клон сразу", async () => {
    const db = freshDb("rh-v66-bail-");
    const repoId = seed(db, 11);
    const a = tmpClone();
    offerClone(handoffKey(repoId, 11), fakeClone(a, 1));
    const now = new Date().toISOString();
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 11, 'user', 'summary', ?, 'full')").run(repoId, now);
    const job = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
    const err = await processSummaryJob({ db, config: loadConfig(), serverClient: () => null, getPat: () => "pat" }, job);
    expect(err).toContain("нет завершённого скана");
    expect(pendingHandoffs()).toBe(0);
    expect(existsSync(a)).toBe(false);
  });

  test("скан без обзора следом убирает клон сам; плановый скан и чужой обзор цепочкой не считаются", async () => {
    const srcRoot = fixtureRepo();
    const db = freshDb("rh-v66-alone-");
    const repoId = seed(db, 8);
    const now = new Date().toISOString();
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'queued', 8, 'user', 'scan', ?)").run(repoId, now);
    const scanJob = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
    expect(chainedSummaryQueued(db, scanJob)).toBe(false);
    await processJob(scanDeps(db, srcRoot), scanJob);
    expect(pendingHandoffs()).toBe(0);
    expect(takeClone(handoffKey(repoId, 8), 1)).toBeNull();
    // обзор другого пользователя – не цепочка; плановый скан – тоже
    db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (9, 'ya-9', 'u9', '2026', '2026')").run();
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 9, 'user', 'summary', ?, 'full')").run(repoId, now);
    expect(chainedSummaryQueued(db, scanJob)).toBe(false);
    expect(chainedSummaryQueued(db, { ...scanJob, triggerKind: "periodic", userId: null })).toBe(false);
    // публичный обзор у закрытого репозитория клон с токеном не получает
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 8, 'user', 'summary', ?, 'public')").run(repoId, now);
    expect(chainedSummaryQueued(db, scanJob)).toBe(true);
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
    expect(chainedSummaryQueued(db, scanJob)).toBe(false);
  }, 60_000);
});
