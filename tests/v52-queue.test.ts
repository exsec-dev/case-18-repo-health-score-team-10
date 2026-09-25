// v52-queue.test.ts — В5.2, очередь: «ничто не должно блокировать пользовательские запросы;
// большие репозитории не должны блочить все» (решение Екатерины 25.09, TASK.md §2 «В5.2 —
// очередь»). Живой случай: AI-обзор и скан пользователя полчаса ждали планового скана
// тяжелого репо — в роли `all` один цикл вел обе полосы и все роды заявок.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loopSlots, MAX_LOOP_SLOTS, type Config } from "../src/config";
import { openDb } from "../src/db";
import { claimNext, JOB_KINDS, startWorkerLoops, workerLoopPlan, workerLoopSummary, type WorkerDeps } from "../src/jobs/scheduler";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-queue-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}
const wrap = (db: Database) => ({ db, close: () => {} });
function seeded(db: Database, repo: string): { repoId: number; scanId: number } {
  const repoId = seedRepo(wrap(db), { org: "q", repo });
  const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
  seedScore(wrap(db), repoId, scanId, { total: 60 });
  return { repoId, scanId };
}
function user(db: Database, n: number): void {
  db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, '2026', '2026')").run(n, `y${n}`, `u${n}`);
}
function job(
  db: Database,
  repoId: number,
  o: { user?: number | null; kind?: string; status?: string; lease?: string | null; claimed?: string | null; audience?: string },
): number {
  const r = db
    .query(
      "INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, claimed_at, lease_until, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(
      repoId,
      o.status ?? "queued",
      o.user ?? null,
      o.user == null ? "periodic" : "user",
      o.kind ?? "scan",
      new Date().toISOString(),
      o.claimed ?? null,
      o.lease ?? null,
      o.audience ?? "full",
    ) as { id: number };
  return r.id;
}
const statusOf = (db: Database, id: number): string => (db.query("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();
const past = () => new Date(Date.now() - 10 * 60_000).toISOString();

describe("план циклов: у каждой пары «полоса роли × род» свой цикл", () => {
  const queue = loadConfig().queue;
  test("all — обе полосы, каждый род; web — только user; rating — только рейтинг", () => {
    const all = workerLoopPlan("all", queue);
    for (const lane of ["user", "rating"] as const) {
      for (const kind of JOB_KINDS) expect(all.filter((s) => s.lane === lane && s.kind === kind)).toHaveLength(1);
    }
    expect(workerLoopPlan("web", queue).every((s) => s.lane === "user")).toBe(true);
    expect(workerLoopPlan("rating", queue).every((s) => s.lane === "rating")).toBe(true);
    expect(workerLoopPlan("web", queue)).toHaveLength(JOB_KINDS.length);
  });
  test("слоты: пользовательские сканы и обзоры — по 2 (env), рейтинг и проверки — 1; эксклюзивность — только user", () => {
    const plan = workerLoopPlan("all", { ...queue, userScanSlots: 3, userAiSlots: 4 });
    const of = (lane: string, kind: string) => plan.find((s) => s.lane === lane && s.kind === kind)!;
    expect(of("user", "scan")).toMatchObject({ slots: 3, perUserExclusive: true, historyRescore: false, tickMarks: true });
    expect(of("user", "summary")).toMatchObject({ slots: 4, perUserExclusive: true, tickMarks: false });
    expect(of("user", "check")).toMatchObject({ slots: 1, perUserExclusive: false });
    expect(of("rating", "scan")).toMatchObject({ slots: 1, perUserExclusive: false, historyRescore: true, tickMarks: true });
    expect(of("rating", "summary").slots).toBe(1);
    expect(workerLoopSummary(plan)).toContain("user/scan×3");
  });
  test("env: дефолт 2, мусор — дефолт, сверх предела — предел", () => {
    expect(loadConfig().queue.userScanSlots).toBe(process.env.QUEUE_USER_SCAN_SLOTS ? loopSlots(Number(process.env.QUEUE_USER_SCAN_SLOTS)) : 2);
    expect(loopSlots(undefined)).toBe(2);
    expect(loopSlots(0)).toBe(1);
    expect(loopSlots(99)).toBe(MAX_LOOP_SLOTS);
    // замороженные литералы QueueConfig без поля — тоже 2
    const { userScanSlots: _, userAiSlots: __, ...legacy } = loadConfig().queue;
    expect(workerLoopPlan("web", legacy as Config["queue"]).find((s) => s.kind === "scan")!.slots).toBe(2);
  });
});

describe("claim: у автора одна заявка каждого рода одновременно", () => {
  test("второй слот достается другому человеку, а не второй заявке того же", () => {
    const db = freshDb();
    user(db, 1);
    user(db, 2);
    const a = seeded(db, "a");
    const b = seeded(db, "b");
    const c = seeded(db, "c");
    job(db, a.repoId, { user: 1, status: "running", claimed: new Date().toISOString(), lease: future() });
    const b1 = job(db, b.repoId, { user: 1 });
    // у второго человека более свежая прошлая заявка — круговой порядок сам по себе выбрал бы первого
    job(db, a.repoId, { user: 2, status: "done", claimed: new Date(Date.now() + 1000).toISOString() });
    const c2 = job(db, c.repoId, { user: 2 });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan" })!.id).toBe(b1);
    db.query("UPDATE jobs SET status = 'queued', claimed_at = NULL, lease_until = NULL, attempts = 0 WHERE id = ?").run(b1);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", perUserExclusive: true })!.id).toBe(c2);
    // у обоих идет скан — третьему слоту брать нечего
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", perUserExclusive: true })).toBeNull();
  });
  test("зависшая заявка (лиз истек) автора не держит; заявка другого рода — тоже", () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    const b = seeded(db, "b");
    job(db, a.repoId, { user: 1, status: "running", claimed: past(), lease: past(), kind: "summary" });
    const next = job(db, b.repoId, { user: 1, kind: "summary", audience: "public" });
    // первый — перехват зависшей (она сама running с истекшим лизом), второй — следующая
    const first = claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary", perUserExclusive: true })!;
    expect(first.id).not.toBe(next);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary", perUserExclusive: true })).toBeNull();
    // скан того же автора по другому репо — другой род, не ждет
    const scan = job(db, b.repoId, { user: 1 });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", perUserExclusive: true })!.id).toBe(scan);
  });
});

describe("claim: обзор и проверка пользователя ждут его более ранний скан того же репо", () => {
  test("полный цикл владельца: скан в очереди или идет — обзор и проверка не берутся; скан закончился — берутся", () => {
    const db = freshDb();
    user(db, 1);
    user(db, 2);
    const a = seeded(db, "a");
    const scan = job(db, a.repoId, { user: 1 });
    const summary = job(db, a.repoId, { user: 1, kind: "summary" });
    const check = job(db, a.repoId, { user: 1, kind: "check", audience: "public" });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })).toBeNull();
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "check" })).toBeNull();
    // скан идет — все еще ждут
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan" })!.id).toBe(scan);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })).toBeNull();
    // чужой обзор того же репо не ждет чужой скан
    const other = job(db, a.repoId, { user: 2, kind: "summary", audience: "public" });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })!.id).toBe(other);
    db.query("UPDATE jobs SET status = 'done' WHERE id = ?").run(scan);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })!.id).toBe(summary);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "check" })!.id).toBe(check);
  });
  test("скан, поставленный ПОСЛЕ обзора, обзор не держит; упавший скан — тоже", () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    const b = seeded(db, "b");
    const summary = job(db, a.repoId, { user: 1, kind: "summary" });
    job(db, a.repoId, { user: 1 });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })!.id).toBe(summary);
    const failedScan = job(db, b.repoId, { user: 1, status: "failed" });
    const s2 = job(db, b.repoId, { user: 1, kind: "summary" });
    expect(failedScan).toBeLessThan(s2);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary" })!.id).toBe(s2);
  });
  test("полоса рейтинга не ждет плановый скан: топ берет последний анализ", () => {
    const db = freshDb();
    const a = seeded(db, "a");
    job(db, a.repoId, {});
    const top = job(db, a.repoId, { kind: "summary", audience: "public" });
    expect(claimNext(db, new Date(), 60_000, { queue: "rating", kind: "summary" })!.id).toBe(top);
  });
});

describe("живые циклы: плановый скан тяжелого репо и тяжелый скан одного человека никого не держат", () => {
  test("рейтинг занят надолго, у человека 1 тяжелый скан — скан человека 2, обзор и проверка исполняются", async () => {
    const db = freshDb();
    user(db, 1);
    user(db, 2);
    user(db, 3);
    const heavy = seeded(db, "heavy");
    const userHeavy = seeded(db, "user-heavy");
    const light = seeded(db, "light");
    const sum = seeded(db, "sum");
    // обзор этого анализа уже есть — заявка закрывается без клона и без модели
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'overview', 't', '[]', '1', 'm', '2026', 'public')").run(sum.repoId, sum.scanId);
    const periodic = job(db, heavy.repoId, {});
    const heavyUser = job(db, userHeavy.repoId, { user: 1 });
    const secondOfUser1 = job(db, light.repoId, { user: 1 });
    const lightUser = job(db, light.repoId, { user: 2 });
    const summary = job(db, sum.repoId, { user: 3, kind: "summary", audience: "public" });
    const check = job(db, sum.repoId, { user: 3, kind: "check", audience: "public" });

    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    const base = loadConfig();
    const config = { ...base, auth: { ...base.auth, appSecret: base.auth.appSecret ?? "test-secret-test-secret-test-secret" } } as Config;
    const deps: WorkerDeps = {
      db,
      config,
      serverClient: () => null,
      getPat: () => "PAT",
      runScan: (async (_deps: unknown, slug: string) => {
        started.push(slug);
        if (slug === "q/heavy" || slug === "q/user-heavy") await hang;
        return { status: "ok", scanId: 1, channels: {}, repoAccess: "granted" };
      }) as never,
      runFraudCheck: (async () => ({ scanId: 1, ok: true, flag: null, signals: null, answered: 1 })) as never,
    };
    const plan = workerLoopPlan("all", { ...config.queue, userScanSlots: 2 }).map((s) => ({ ...s, pollMs: 10 }));
    const stop = startWorkerLoops(deps, plan);
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && [lightUser, summary, check].some((id) => statusOf(db, id) !== "done")) await new Promise((r) => setTimeout(r, 20));
      expect({ light: statusOf(db, lightUser), summary: statusOf(db, summary), check: statusOf(db, check) }).toEqual({ light: "done", summary: "done", check: "done" });
      // тяжелые идут; вторая заявка человека 1 ждет его первую, хотя слот свободен
      expect(statusOf(db, periodic)).toBe("running");
      expect(statusOf(db, heavyUser)).toBe("running");
      expect(statusOf(db, secondOfUser1)).toBe("queued");
      expect(started.filter((s) => s === "q/heavy")).toHaveLength(1);
      release();
      const deadline2 = Date.now() + 5000;
      while (Date.now() < deadline2 && statusOf(db, secondOfUser1) !== "done") await new Promise((r) => setTimeout(r, 20));
      expect(statusOf(db, secondOfUser1)).toBe("done");
      expect(statusOf(db, periodic)).toBe("done");
    } finally {
      release();
      stop();
    }
  });
});
