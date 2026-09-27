// Очередь: ничто не блокирует пользовательские запросы, большие репозитории не
// блокируют все остальное. Иначе AI-обзор и скан пользователя ждут планового
// скана тяжелого репо, если один цикл ведет обе полосы и все роды заявок.
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

describe("claim: у кого уже идет заявка рода — в конец очереди (аудит О4: приоритет, не запрет)", () => {
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
    // ждет только человек 1 – свободный слот не простаивает
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", perUserExclusive: true })!.id).toBe(b1);
  });
  test("зависшая заявка (лиз истек) автора не отодвигает; заявка другого рода — тоже", () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    const b = seeded(db, "b");
    job(db, a.repoId, { user: 1, status: "running", claimed: past(), lease: past(), kind: "summary" });
    const next = job(db, b.repoId, { user: 1, kind: "summary", audience: "public" });
    // первый — перехват зависшей (она сама running с истекшим лизом), второй — следующая
    const first = claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary", perUserExclusive: true })!;
    expect(first.id).not.toBe(next);
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary", perUserExclusive: true })!.id).toBe(next);
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
    // Кэш summary-заявки зависит от кулдауна: с дебаг-кулдауном из .env
    // (QUEUE_SUMMARY_COOLDOWN_MS=1) кэш снимается и «заявка закрывается без
    // клона» уходит в настоящий git clone. Кулдаун задан явно, не из окружения.
    const config = {
      ...base,
      auth: { ...base.auth, appSecret: base.auth.appSecret ?? "test-secret-test-secret-test-secret" },
      queue: { ...base.queue, summaryCooldownMs: 60 * 60_000 },
    } as Config;
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
      while (Date.now() < deadline && [lightUser, summary, check, secondOfUser1].some((id) => statusOf(db, id) !== "done")) await new Promise((r) => setTimeout(r, 20));
      expect({ light: statusOf(db, lightUser), summary: statusOf(db, summary), check: statusOf(db, check) }).toEqual({ light: "done", summary: "done", check: "done" });
      // тяжелые идут; вторая заявка человека 1 – после заявки человека 2, но свободный слот
      // не простаивает: это приоритет, а не запрет
      expect(statusOf(db, periodic)).toBe("running");
      expect(statusOf(db, heavyUser)).toBe("running");
      expect(statusOf(db, secondOfUser1)).toBe("done");
      const claimedAt = (id: number) => (db.query("SELECT claimed_at FROM jobs WHERE id = ?").get(id) as { claimed_at: string }).claimed_at;
      expect(claimedAt(lightUser) <= claimedAt(secondOfUser1)).toBe(true);
      expect(started.filter((s) => s === "q/heavy")).toHaveLength(1);
      release();
      const deadline2 = Date.now() + 5000;
      while (Date.now() < deadline2 && statusOf(db, periodic) !== "done") await new Promise((r) => setTimeout(r, 20));
      expect(statusOf(db, periodic)).toBe("done");
    } finally {
      release();
      stop();
    }
  });
});

// ---------- правки очереди по аудиту ----------

import { getHealth } from "../src/api/health";
import { makeLlm, ProviderGate } from "../src/llm";
import { closeOwnRunningScans, workerTick, type WorkerLoopSpec } from "../src/jobs/scheduler";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("О1: семафор провайдера — пользователь впереди фона, отмена снимает ожидающего", () => {
  test("проверка обгоняет очередь обзоров; фону не больше 1 места; внутри приоритета — порядок прихода", async () => {
    const gate = new ProviderGate(3, 1);
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const call = (name: string, p: "check" | "interactive" | "background") =>
      gate.run(
        () =>
          new Promise<void>((r) => {
            order.push(name);
            releases.push(r);
          }),
        p,
      );
    const all = [call("bg1", "background"), call("bg2", "background"), call("u1", "interactive"), call("u2", "interactive"), call("u3", "interactive"), call("c1", "check")];
    await tick();
    // фону — одно место (bg2 ждет, хотя места есть), u1, u2 — оставшиеся
    expect(order).toEqual(["bg1", "u1", "u2"]);
    releases.shift()!(); // bg1 закончился
    await tick();
    // первой — проверка, хотя пришла последней
    expect(order.at(-1)).toBe("c1");
    while (releases.length > 0) {
      releases.shift()!();
      await tick();
    }
    await Promise.all(all);
    expect(order).toEqual(["bg1", "u1", "u2", "c1", "u3", "bg2"]);
  });
  test("ожидание места слушает отмену: предохранитель снимает ожидающего, место ему не выдается", async () => {
    const gate = new ProviderGate(1, 1);
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((r) => (release = r)), "interactive");
    const ac = new AbortController();
    let ran = false;
    const waiting = gate.run(
      async () => {
        ran = true;
      },
      "check",
      ac.signal,
    );
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    release();
    await first;
    await tick();
    expect(ran).toBe(false);
    expect(gate.inFlight).toBe(0);
  });
  test("makeLlm передает приоритет в общий семафор: фоновые вызовы не занимают больше 1 места", async () => {
    const base = loadConfig();
    const config = { ...base, llm: { ...base.llm, provider: "zai", zaiApiKey: "k", baseUrl: "http://127.0.0.1:9" } } as Config;
    let fetches = 0;
    const fetchImpl = ((_u: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_r, reject) => {
        fetches++;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const ac = new AbortController();
    const bg = makeLlm(config, undefined, { fetchImpl, priority: "background" });
    const userCall = makeLlm(config, undefined, { fetchImpl, priority: "check" });
    const calls = [0, 1, 2].map(() => bg({ messages: [{ role: "user", content: "x" }], signal: ac.signal }).catch(() => null));
    await tick();
    expect(fetches).toBe(1);
    const c = userCall({ messages: [{ role: "user", content: "x" }], signal: ac.signal }).catch(() => null);
    await tick();
    expect(fetches).toBe(2);
    ac.abort();
    await Promise.all([...calls, c]);
  });
});

describe("О2: тяжелые репо — только первый слот рода", () => {
  const longScan = (db: Database, repoId: number, minutes: number, detail: string | null, finished: boolean) => {
    const start = new Date(Date.now() - minutes * 60_000 - 60_000).toISOString();
    const end = finished ? new Date(Date.now() - 60_000).toISOString() : null;
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, status_detail) VALUES (?, ?, ?, ?, 'periodic', ?)").run(repoId, start, end, finished ? "bad" : "running", detail);
  };
  test("скан дольше порога (и прерванный перезапуском, и идущий) — тяжелый; закрытый свипом сирот — нет", () => {
    const db = freshDb();
    user(db, 1);
    const shut = seeded(db, "shut");
    const live = seeded(db, "live");
    const orphan = seeded(db, "orphan");
    const light = seeded(db, "light");
    longScan(db, shut.repoId, 24, "shutdown", true);
    longScan(db, live.repoId, 12, null, false);
    longScan(db, orphan.repoId, 3000, "orphaned", true);
    const ids = [shut, live, orphan, light].map((r) => job(db, r.repoId, { user: 1 }));
    const claimLight = () => claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", lightOnly: true, heavyMs: 5 * 60_000 })?.id;
    expect([claimLight(), claimLight(), claimLight()]).toEqual([ids[2], ids[3], undefined]);
    // слот «любой» берет и тяжелый
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "scan", heavyMs: 5 * 60_000 })!.id).toBe(ids[0]);
  });
  test("проводка: первый слот рода берет тяжелые, остальные — только легкие; пересчет — только цикл сканов рейтинга", async () => {
    const seen: { lane: string; kind?: string; lightOnly?: boolean; historyRescore?: boolean; state: object }[] = [];
    const plan: WorkerLoopSpec[] = workerLoopPlan("all", { ...loadConfig().queue, userScanSlots: 3 }).map((s) => ({ ...s, pollMs: 5 }));
    // настоящая БД: циклы сканов пишут метки живости в meta после тика
    const stop = startWorkerLoops({ db: freshDb(), config: loadConfig(), serverClient: () => null }, plan, {
      tick: (async (_d: unknown, order: string[], state: object, opts: { kind?: string; lightOnly?: boolean; historyRescore?: boolean }) => {
        seen.push({ lane: order.join(","), kind: opts.kind, lightOnly: opts.lightOnly, historyRescore: opts.historyRescore, state });
        return "idle";
      }) as never,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const loops = new Map<object, (typeof seen)[number]>();
    for (const s of seen) loops.set(s.state, s);
    const v = [...loops.values()];
    const userScans = v.filter((s) => s.lane === "user" && s.kind === "scan");
    expect(userScans.map((s) => s.lightOnly).sort()).toEqual([false, true, true]);
    expect(v.filter((s) => s.historyRescore).map((s) => `${s.lane}/${s.kind}`)).toEqual(["rating/scan"]);
    expect(v).toHaveLength(3 + 2 + 1 + 1 + 1 + 1);
  });
});

describe("О5-О7: ожидание в полосе рейтинга, исчерпанный скан, SIGTERM, health", () => {
  test("О6: обзор топа ждет ИДУЩИЙ плановый скан того же репо, стоящий в очереди — нет", () => {
    const db = freshDb();
    const a = seeded(db, "a");
    const scan = job(db, a.repoId, { status: "running", claimed: new Date().toISOString(), lease: future() });
    const top = job(db, a.repoId, { kind: "summary", audience: "public" });
    expect(claimNext(db, new Date(), 60_000, { queue: "rating", kind: "summary" })).toBeNull();
    db.query("UPDATE jobs SET status = 'queued', claimed_at = NULL, lease_until = NULL WHERE id = ?").run(scan);
    expect(claimNext(db, new Date(), 60_000, { queue: "rating", kind: "summary" })!.id).toBe(top);
  });
  test("исчерпанный скан закрывается и снимает ожидание обзора", () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    const scan = job(db, a.repoId, { user: 1 });
    db.query("UPDATE jobs SET attempts = 3 WHERE id = ?").run(scan);
    const summary = job(db, a.repoId, { user: 1, kind: "summary" });
    expect(claimNext(db, new Date(), 60_000, { queue: "user", kind: "summary", maxAttempts: 3 })!.id).toBe(summary);
    expect(statusOf(db, scan)).toBe("failed");
  });
  test("О7: SIGTERM закрывает сканы только за скан-заявки — идущая проверка не закрывает чужой живой скан", async () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    db.query("INSERT INTO scans (repo_id, started_at, status, trigger, user_id) VALUES (?, ?, 'running', 'user', 1)").run(a.repoId, new Date().toISOString());
    job(db, a.repoId, { user: 1, kind: "check", audience: "public" });
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const deps = {
      db,
      config: loadConfig(),
      serverClient: () => null,
      runFraudCheck: async () => {
        await hang;
        return { scanId: 1, ok: true, flag: null, signals: null, answered: 1 };
      },
    } as never;
    const running = workerTick(deps, ["user"], { busy: false }, { kind: "check" });
    await tick();
    expect(closeOwnRunningScans(db)).toBe(0);
    release();
    expect(await running).toBe("done");
  });
  test("О5: health показывает, сколько ждет самая старая пользовательская заявка каждого рода", () => {
    const db = freshDb();
    user(db, 1);
    const a = seeded(db, "a");
    const id = job(db, a.repoId, { user: 1, kind: "summary" });
    db.query("UPDATE jobs SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), id);
    const h = getHealth(db, loadConfig());
    expect(h.userQueueOldestMs.scan).toBeNull();
    expect(h.userQueueOldestMs.check).toBeNull();
    expect(h.userQueueOldestMs.summary!).toBeGreaterThanOrEqual(20 * 60_000 - 1000);
  });
});

describe("живые циклы: два тяжелых репо двух людей не держат третьего", () => {
  test("тяжелые ждут друг друга в первом слоте, легкий третьего идет во втором", async () => {
    const db = freshDb();
    for (const n of [1, 2, 3]) user(db, n);
    const h1 = seeded(db, "h1");
    const h2 = seeded(db, "h2");
    const l3 = seeded(db, "l3");
    for (const r of [h1, h2]) {
      db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger) VALUES (?, ?, ?, 'partial', 'periodic')").run(
        r.repoId,
        new Date(Date.now() - 40 * 60_000).toISOString(),
        new Date(Date.now() - 10 * 60_000).toISOString(),
      );
    }
    const j1 = job(db, h1.repoId, { user: 1 });
    const j2 = job(db, h2.repoId, { user: 2 });
    const j3 = job(db, l3.repoId, { user: 3 });
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const base = loadConfig();
    // Кэш summary-заявки зависит от кулдауна: с дебаг-кулдауном из .env
    // (QUEUE_SUMMARY_COOLDOWN_MS=1) кэш снимается и «заявка закрывается без
    // клона» уходит в настоящий git clone. Кулдаун задан явно, не из окружения.
    const config = {
      ...base,
      auth: { ...base.auth, appSecret: base.auth.appSecret ?? "test-secret-test-secret-test-secret" },
      queue: { ...base.queue, summaryCooldownMs: 60 * 60_000 },
    } as Config;
    const deps: WorkerDeps = {
      db,
      config,
      serverClient: () => null,
      getPat: () => "PAT",
      runScan: (async (_d: unknown, slug: string) => {
        if (slug !== "q/l3") await hang;
        return { status: "ok", scanId: 1, channels: {}, repoAccess: "granted" };
      }) as never,
    };
    const plan = workerLoopPlan("web", { ...config.queue, userScanSlots: 2 }).map((s) => ({ ...s, pollMs: 10 }));
    const stop = startWorkerLoops(deps, plan);
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && statusOf(db, j3) !== "done") await new Promise((r) => setTimeout(r, 20));
      expect(statusOf(db, j3)).toBe("done");
      expect([statusOf(db, j1), statusOf(db, j2)].sort()).toEqual(["queued", "running"]);
    } finally {
      release();
      await new Promise((r) => setTimeout(r, 60));
      stop();
    }
  });
});
