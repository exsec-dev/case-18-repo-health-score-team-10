// Задания: штатная остановка не портит итог; лиз 10 мин, свип клонов от
// худшего скана, продление с повтором BUSY, «затянулось» – признак сервера;
// итог скана = итог задания; таймаут обмена кода Я ID. Временные БД,
// фейковые каналы скана, локальный мок; сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LEASE_MS, loadConfig, worstCaseScanMs, type Config } from "../src/config";
import { openDb } from "../src/db";
import { okFact } from "../src/collectors/facts";
import { runScan } from "../src/jobs/runner";
import { enqueueScan, JOB_ERRORS, maintenanceTick, withBusyRetry, workerTick } from "../src/jobs/scheduler";
import { channelSources, getRepoCard } from "../src/api/repos";
import { addFavorite, checkFavoriteAccess, myJobs } from "../src/api/me";
import { upsertUser } from "../src/auth/session";
import { exchangeCode, makeYaHttp } from "../src/auth/ya";
import { analysisOutcome } from "../src/web/format";
import { seedRepo, seedScan, type ApiTestDb } from "./api-fixtures";
import { startMockApi } from "./server-harness";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; config: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v485-b2-"));
  dirs.push(dir);
  const config: Config = { ...loadConfig(), dataDir: dir };
  const db = openDb(config);
  dbs.push(db);
  return { db, config, dir };
}

const NOW_ISO = new Date().toISOString();
const gitFacts = () => [
  okFact("tree.stats", { top_level: ["src"], file_count: 10, bytes: 1000, loc: 200 }, "git", NOW_ISO),
  okFact("docs.readme", { bytes: 1200, sections: 3, flags: {} }, "git", NOW_ISO),
];

describe("К8.5.12: итог скана и итог задания согласованы", () => {
  test("скор-хук упал → скан bad/score_failed без оценки, задание failed «не удалось посчитать оценку»", async () => {
    const { db, config } = freshDb();
    // тестовый триггер: запись оценки падает (сбой хука), схема продукта не меняется
    db.exec("CREATE TRIGGER v485_scores_fail BEFORE INSERT ON scores BEGIN SELECT RAISE(ABORT, 'score write failed'); END");
    const repoId = seedRepo({ db, close: () => {} }, { org: "k12", repo: "hook" });
    const jobId = enqueueScan(db, repoId, { triggerKind: "periodic" });
    const scan = ((d: Parameters<typeof runScan>[0], slug: string, opts: Parameters<typeof runScan>[2]) =>
      runScan(
        { ...d, collectGit: async () => ({ facts: gitFacts() }), collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }) },
        slug,
        opts,
      )) as typeof runScan;
    const out = await workerTick({ db, config, serverClient: () => null, runScan: scan }, ["rating"], { busy: false });
    const row = db.query("SELECT status, public_status, status_detail, finished_at IS NOT NULL AS fin FROM scans WHERE repo_id = ?").get(repoId);
    const scores = (db.query("SELECT COUNT(*) AS c FROM scores").get() as { c: number }).c;
    const job = db.query("SELECT status, error FROM jobs WHERE id = ?").get(jobId);
    expect({ out, row, scores, job }).toEqual({
      out: "failed",
      row: { status: "bad", public_status: "bad", status_detail: "score_failed", fin: 1 },
      scores: 0,
      job: { status: "failed", error: JOB_ERRORS.scoreFailed },
    });
  });

  test("без сбоя хука статус скана и оценка записаны вместе", async () => {
    const { db } = freshDb();
    const out = await runScan(
      { db, scClient: null, restBase: "http://127.0.0.1:1", appsecBase: "http://127.0.0.1:1", collectGit: async () => ({ facts: gitFacts() }), collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }) },
      "k12/ok",
      { trigger: "periodic" },
    );
    const row = db.query("SELECT status, status_detail FROM scans WHERE id = ?").get(out.scanId) as { status: string; status_detail: string | null };
    const scores = (db.query("SELECT COUNT(*) AS c FROM scores WHERE scan_id = ?").get(out.scanId) as { c: number }).c;
    expect({ scoreFailed: out.scoreFailed ?? false, detail: row.status_detail, scores, notRunning: row.status !== "running" }).toEqual({
      scoreFailed: false,
      detail: null,
      scores: 1,
      notRunning: true,
    });
  });

  test("источники каналов карточки — только завершенные не-bad сканы (С10-14)", () => {
    const { db } = freshDb();
    const t: ApiTestDb = { db, close: () => {} };
    const repoId = seedRepo(t, { org: "k12", repo: "chan" });
    const cicd = [
      { key: "cicd.configs", value: { files: ["ci.yaml"] } },
      { key: "cicd.runs", value: { total: 3 } },
    ];
    const good = seedScan(t, repoId, { status: "ok", facts: cicd });
    seedScan(t, repoId, { status: "bad", facts: cicd });
    seedScan(t, repoId, { status: "running", finishedAt: null, facts: cicd });
    expect(channelSources(db, repoId).cicdScanId).toBe(good);
  });
});

describe("К8.5.2a: штатная остановка не портит итог", () => {
  test("прерванный скан — «interrupted», а не ошибка; сигнатура analysisOutcome прежняя", () => {
    const fin = "2026-09-22T10:00:00Z";
    expect(analysisOutcome({ status: "bad", finishedAt: fin, detail: "shutdown" })).toBe("interrupted");
    expect(analysisOutcome({ status: "bad", finishedAt: fin, detail: "orphaned" })).toBe("interrupted");
    expect(analysisOutcome({ status: "bad", finishedAt: fin, detail: "score_failed" })).toBe("failed");
    expect(analysisOutcome({ status: "bad", finishedAt: fin })).toBe("failed");
  });

  test("карточка отдает причину закрытия скана закрытым списком", () => {
    const { db } = freshDb();
    const t: ApiTestDb = { db, close: () => {} };
    const repoId = seedRepo(t, { org: "k2a", repo: "card" });
    const scanId = seedScan(t, repoId, { status: "bad" });
    db.query("UPDATE scans SET status_detail = 'shutdown' WHERE id = ?").run(scanId);
    expect(getRepoCard(db, "k2a", "card")?.scan?.detail).toBe("shutdown");
    db.query("UPDATE scans SET status_detail = 'appsec bucket HIGH unavailable after 2 attempts' WHERE id = ?").run(scanId);
    expect(getRepoCard(db, "k2a", "card")?.scan?.detail).toBeNull();
  });

  test("bad-скан зрителя (shutdown) не включает кулдаун: проверка прав ставит анализ", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-k2a", "k2a");
    const repoId = seedRepo({ db, close: () => {} }, { org: "k2a", repo: "own" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
    const scanId = seedScan({ db, close: () => {} }, repoId, { status: "bad", userId: uid });
    db.query("UPDATE scans SET status_detail = 'shutdown' WHERE id = ?").run(scanId);
    addFavorite(db, uid, "k2a", "own");
    const out = await checkFavoriteAccess(
      db,
      uid,
      "k2a",
      "own",
      { restGet: async () => ({ status: 200, json: { visibility: "private" } }), appsecLatest: async () => ({ status: 404 }), cooldownMs: 6 * 3600_000 },
      async () => ({ status: "queued", code: null }),
    );
    expect(out.enqueue).toEqual({ status: "queued", code: null });
  });
});

describe("К8.5.2b: лиз, свип клонов, «затянулось»", () => {
  test("дефолт лиза — 10 минут", () => {
    const saved = process.env.SCHEDULER_LEASE_MS;
    process.env.SCHEDULER_LEASE_MS = "";
    try {
      expect(loadConfig().scheduler.leaseMs).toBe(DEFAULT_LEASE_MS);
    } finally {
      if (saved === undefined) delete process.env.SCHEDULER_LEASE_MS;
      else process.env.SCHEDULER_LEASE_MS = saved;
    }
  });

  test("свип клонов при лизе 10 мин не трогает клон моложе худшего скана (60 мин), сносит старше", async () => {
    const { db, config } = freshDb();
    const sweepDir = mkdtempSync(join(tmpdir(), "rh-v485-sweep-"));
    dirs.push(sweepDir);
    const cfg = { ...config, scheduler: { ...config.scheduler, leaseMs: 10 * 60_000 } };
    const hourOld = mkdtempSync(join(sweepDir, "rh-clone-hour-"));
    const ancient = mkdtempSync(join(sweepDir, "rh-clone-old-"));
    const t1 = new Date(Date.now() - 60 * 60_000);
    const t2 = new Date(Date.now() - worstCaseScanMs(cfg.scan) - 60_000);
    utimesSync(hourOld, t1, t1);
    utimesSync(ancient, t2, t2);
    const out = await maintenanceTick(db, cfg, { cloneDir: sweepDir });
    expect({ clones: out.clones, hourOld: existsSync(hourOld), ancient: existsSync(ancient) }).toEqual({ clones: 1, hourOld: true, ancient: false });
  });

  test("«затянулось» — признак сервера: running с истекшим лизом → stalled в /api/me/jobs и в карточке", () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-stall", "stall");
    const repoId = seedRepo({ db, close: () => {} }, { org: "k2b", repo: "stall" });
    const jobId = enqueueScan(db, repoId, { userId: uid, triggerKind: "user" });
    const past = new Date(Date.now() - 20 * 60_000).toISOString();
    db.query("UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ? WHERE id = ?").run(past, new Date(Date.now() + 60_000).toISOString(), jobId);
    const live = { jobs: myJobs(db, uid).active[0]?.stalled, card: getRepoCard(db, "k2b", "stall", { viewerUserId: uid })?.job?.stalled };
    db.query("UPDATE jobs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), jobId);
    const expired = { jobs: myJobs(db, uid).active[0]?.stalled, card: getRepoCard(db, "k2b", "stall", { viewerUserId: uid })?.job?.stalled };
    expect({ live, expired }).toEqual({ live: { jobs: false, card: false }, expired: { jobs: true, card: true } });
  });

  test("запись под SQLITE_BUSY повторяется и проходит, когда блокировка снята (продление лиза, finishJob)", async () => {
    const { db, dir } = freshDb();
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('busy', 'r')").run();
    db.query("INSERT INTO jobs (repo_id, status, claimed_at, lease_until) VALUES (1, 'running', 'c1', 'x')").run();
    const holder = new Database(join(dir, "repo-health.db"));
    dbs.push(holder);
    db.exec("PRAGMA busy_timeout = 0;");
    holder.exec("BEGIN IMMEDIATE");
    holder.query("UPDATE jobs SET lease_until = 'held'").run();
    setTimeout(() => holder.exec("COMMIT"), 300);
    let attempts = 0;
    const changed = await withBusyRetry(
      () => {
        attempts++;
        return db.query("UPDATE jobs SET lease_until = 'renewed' WHERE claimed_at = 'c1'").run().changes;
      },
      "test renew",
      { attempts: 6, baseMs: 100 },
    );
    db.exec("PRAGMA busy_timeout = 5000;");
    expect({ changed, retried: attempts > 1 }).toEqual({ changed: 1, retried: true });
  });
});

describe("К8.5.12 (С10-15): таймаут обмена кода Я ID", () => {
  test("Я ID не отвечает — вход не висит до idleTimeout, а возвращает ошибку", async () => {
    const mock = startMockApi(() => new Promise<Response>(() => {}));
    try {
      const t0 = Date.now();
      const out = await exchangeCode(
        { clientId: "id", clientSecret: "secret", redirect: "http://127.0.0.1/cb" },
        "code",
        makeYaHttp(200),
        { oauthBase: mock.url, loginBase: mock.url },
      );
      expect({ ok: out.ok, fast: Date.now() - t0 < 5000 }).toEqual({ ok: false, fast: true });
    } finally {
      mock.stop();
    }
  });
});
