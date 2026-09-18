// scheduler.test.ts — В4/Б3: claim-loop (NULL-lease матчится, лиз,
// приоритет юзерских заявок, истёкший лиз переклaimается), ночной
// каталог-дифф (new/changed/unchanged → пустая очередь на втором
// прогоне, форс-тогл, retry-failed), эвикция repo-уровневая (пропал
// из каталога; неполный каталог НЕ эвиктит; возврат флагом; канальные
// 403 cicd — не эвикция — отдельный процессJob-тест). Сети нет:
// каталог и runScan — фейки.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_SCAN } from "../src/config";
import { openDb } from "../src/db";
import type { ScClient, ScResponse } from "../src/collectors/http";
import {
  __resetRoundRobin,
  catalogTick,
  claimAny,
  claimNext,
  countRecentUserJobs,
  enqueueScan,
  evictRepo,
  failedChannelsOf,
  findActiveUserJob,
  finishJob,
  JOB_ERRORS,
  maintenanceTick,
  nightlyCatalog,
  processJob,
  renewLease,
  returnRepo,
  startWorkerLoop,
  sweepOrphanScans,
  workerTick,
  type ClaimedJob,
} from "../src/jobs/scheduler";
import { myJobs, requestUserScan } from "../src/api/me";
import { upsertRepo, type runScan as runScanType, type ScanDeps, type ScanResult } from "../src/jobs/runner";
import { makeScClient } from "../src/collectors/http";

const dir = mkdtempSync(join(tmpdir(), "rh-sched-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRepo(org: string, repo: string, lastActivityAt: string | null = null, visibility = "public"): number {
  db.query(
    "INSERT INTO repos (org_slug, repo_slug, last_activity_at, visibility) VALUES (?, ?, ?, ?) ON CONFLICT(org_slug, repo_slug) DO UPDATE SET last_activity_at = excluded.last_activity_at",
  ).run(org, repo, lastActivityAt, visibility);
  return (db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number }).id;
}

/** Фейк-клиент каталога: страницы repositories + next_page_token. */
function catalogClient(pages: { repos: Record<string, unknown>[]; next: string | null }[]): ScClient {
  let page = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
      const p = pages[Math.min(page, pages.length - 1)]!;
      page++;
      return {
        status: 200,
        json: { repositories: p.repos, next_page_token: p.next ?? "" },
        bodyText: "",
      };
    },
    requestCount: () => page,
  };
}

const repoOf = (org: string, slug: string, last_updated: string | null, visibility = "public") => ({
  organization: { slug: org },
  slug,
  name: slug,
  visibility,
  last_updated: last_updated,
  language: null as unknown,
  rating: null,
});

describe("claim-loop: лизы и приоритеты", () => {
  test("enqueue → claim: NULL-lease матчится, лиз ставится, повторный claim — другая job", () => {
    const a = seedRepo("cl", "a");
    const b = seedRepo("cl", "b");
    const j1 = enqueueScan(db, a, { triggerKind: "periodic" });
    enqueueScan(db, b, { triggerKind: "periodic" });
    const now = new Date("2026-09-18T00:00:00Z");
    const first = claimNext(db, now, 60_000, { queue: "rating" });
    expect(first?.slug).toBe("cl/a");
    expect(first?.userId).toBeNull();
    expect(first?.attempts).toBe(1);
    // лиз поставлен и живёт: строка больше не заявляется
    const second = claimNext(db, new Date(now.getTime() + 30_000), 60_000, { queue: "rating" });
    expect(second?.slug).toBe("cl/b");
    expect(claimNext(db, new Date(now.getTime() + 30_000), 60_000, { queue: "rating" })).toBeNull();
    // истёкший лиз (упавший воркер) → job снова доступна, попытка №2
    const revived = claimNext(db, new Date(now.getTime() + 120_000), 60_000, { queue: "rating" });
    expect(revived?.id).toBe(j1);
    expect(revived?.attempts).toBe(2);
    // finishJob прежней заявки (claimed_at первой попытки) — no-op (К4)
    expect(finishJob(db, j1, first!.claimedAt, "failed")).toBe(false);
    expect((db.query("SELECT status FROM jobs WHERE id = ?").get(j1) as { status: string }).status).toBe("running");
    expect(finishJob(db, j1, revived!.claimedAt, "done")).toBe(true);
    expect(finishJob(db, second!.id, second!.claimedAt, "done")).toBe(true);
  });

  test("юзерская заявка встаёт вперёд периодической", () => {
    const c = seedRepo("cl", "c");
    const d = seedRepo("cl", "d");
    enqueueScan(db, c, { triggerKind: "periodic" });
    const userId = (db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-1', 'u', '2026', '2026')").run(), Number((db.query("SELECT id FROM users WHERE ya_id = 'ya-1'").get() as { id: number }).id));
    const userJob = enqueueScan(db, d, { userId, triggerKind: "user" });
    const claimed = claimNext(db, new Date("2026-09-19T00:00:00Z"), 60_000, { queue: "user" });
    expect(claimed?.id).toBe(userJob);
    expect(claimed?.userId).toBe(userId);
    // ПОРТ S2: изоляция — пока юзерская жива, rating-claim берёт периодику
    // ПАРКЛЛЕЛЬНО (не ждёт), user-очередь не видит периодику вовсе
    const parallel = claimNext(db, new Date("2026-09-19T00:00:30Z"), 60_000, { queue: "rating" });
    expect(parallel?.slug).toBe("cl/c");
    finishJob(db, claimed!.id, claimed!.claimedAt, "done");
    finishJob(db, parallel!.id, parallel!.claimedAt, "done");
    // чистим за собой: дальше каталог-тесты видят чистую таблицу repos
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
  });

  test("finishJob по (id, claimed_at): очередь допускает несколько строк одного репо", () => {
    const e = seedRepo("cl", "e");
    const j1 = enqueueScan(db, e, {});
    const j2 = enqueueScan(db, e, { triggerKind: "user" });
    expect(j1).not.toBe(j2);
    const c1 = claimNext(db, new Date("2026-09-20T00:00:00Z"), 60_000, { queue: "rating" })!;
    const other = c1.id === j1 ? j2 : j1;
    finishJob(db, c1.id, c1.claimedAt, "done");
    expect((db.query("SELECT status FROM jobs WHERE id = ?").get(other) as { status: string }).status).toBe("queued");
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
  });
});

describe("очередь: анти-абьюз (К4 В4.1)", () => {
  // своя БД: круговой порядок Ф1.7 внутри полосы user читает MAX(claimed_at)
  // по ВСЕЙ таблице jobs (М4 круга 2: прежняя формулировка звала это
  // «чередованием» — механизма с таким именем нет с 17.09, решение (1))
  const qdir = mkdtempSync(join(tmpdir(), "rh-queue-"));
  const q: Database = openDb({ ...loadConfig(), dataDir: qdir });
  afterAll(() => {
    q.close();
    rmSync(qdir, { recursive: true, force: true });
  });
  const repo = (slug: string) => {
    q.query("INSERT OR IGNORE INTO repos (org_slug, repo_slug) VALUES ('q', ?)").run(slug);
    return (q.query("SELECT id FROM repos WHERE org_slug = 'q' AND repo_slug = ?").get(slug) as { id: number }).id;
  };
  const user = (ya: string) => {
    q.query("INSERT OR IGNORE INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, '2026', '2026')").run(ya, ya);
    return (q.query("SELECT id FROM users WHERE ya_id = ?").get(ya) as { id: number }).id;
  };
  const clear = () => q.query("DELETE FROM jobs").run();

  test("дедуп: активная заявка (user, repo) возвращается, новая не создаётся; после завершения — новая", () => {
    clear();
    const u = user("dedup");
    const r = repo("dedup");
    const j1 = enqueueScan(q, r, { userId: u, triggerKind: "user" });
    expect(enqueueScan(q, r, { userId: u, triggerKind: "user" })).toBe(j1);
    // другой юзер на тот же репо — своя заявка
    expect(enqueueScan(q, r, { userId: user("other"), triggerKind: "user" })).not.toBe(j1);
    const claimed = claimNext(q, new Date("2026-09-18T00:00:00Z"), 60_000, { queue: "user" })!;
    expect(claimed.id).toBe(j1);
    expect(enqueueScan(q, r, { userId: u, triggerKind: "user" })).toBe(j1); // running — тоже активна
    finishJob(q, j1, claimed.claimedAt, "done");
    expect(enqueueScan(q, r, { userId: u, triggerKind: "user" })).not.toBe(j1);
    expect(findActiveUserJob(q, u, r)).not.toBeNull();
  });

  test("лимит частоты: 11-я новая заявка за час → 429; дубли не считаются; окно скользящее", async () => {
    clear();
    const u = user("rate");
    const queue = { userScansPerHour: 10, maxAttempts: 3, userActiveMax: 100, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000 };
    const ok = { get: async () => ({ status: 200, json: { visibility: "public" }, bodyText: "" }), requestCount: () => 0 };
    const now = new Date("2026-09-18T10:00:00Z");
    for (let i = 0; i < 10; i++) {
      const out = await requestUserScan(q, ok, u, "q", `rate-${i}`, queue, now);
      expect(out.status).toBe(202);
      expect(out.body["deduplicated"]).toBe(false);
      // повтор той же заявки — дубль: 202 deduplicated, счётчик не растёт
      const dup = await requestUserScan(q, ok, u, "q", `rate-${i}`, queue, now);
      expect(dup.status).toBe(202);
      expect(dup.body["deduplicated"]).toBe(true);
    }
    expect(countRecentUserJobs(q, u, now)).toBe(10);
    const eleventh = await requestUserScan(q, ok, u, "q", "rate-10", queue, now);
    expect(eleventh.status).toBe(429);
    expect((eleventh.body["error"] as { code: string }).code).toBe("rate_limited");
    expect(q.query("SELECT 1 FROM repos WHERE org_slug = 'q' AND repo_slug = 'rate-10'").get()).toBeNull();
    // через час окно освободилось
    const later = await requestUserScan(q, ok, u, "q", "rate-10", queue, new Date(now.getTime() + 3600_001));
    expect(later.status).toBe(202);
  });

  test("ПОРТ S2 изоляция + П1 round-robin: периодика не ждёт конца юзерской полосы", () => {
    clear();
    // В4.2-port-fix (П1, решение владельца (1) 17.09): «user-приоритет в роли
    // all» отменён — он и был механизмом К1 (полоса rating голодала навсегда).
    // Охраняется изоляция, а не приоритет: вторая половина теста неизменна.
    __resetRoundRobin();
    const u = user("alt");
    const periodic = [repo("p1"), repo("p2")].map((r) => enqueueScan(q, r, { triggerKind: "periodic" }));
    const users = [repo("u1"), repo("u2"), repo("u3")].map((r) => enqueueScan(q, r, { userId: u, triggerKind: "user" }));
    const kinds: string[] = [];
    let t = Date.parse("2026-09-18T00:00:00Z");
    for (let job = claimAny(q, ["user", "rating"], new Date(t)); job; job = claimAny(q, ["user", "rating"], new Date((t += 1000))))
      kinds.push(job.triggerKind === "user" ? "u" : "p");
    expect({
      claimed: kinds.length,
      periodic: kinds.filter((k) => k === "p").length,
      // ключевое: периодика поехала ДО того, как кончилась юзерская полоса
      periodicBeforeUserDrained: kinds.slice(0, 4).includes("p"),
    }).toEqual({ claimed: 5, periodic: 2, periodicBeforeUserDrained: true });
    expect(periodic.length + users.length).toBe(5);
    // а ИЗОЛИРОВАННЫЙ user-воркер видит только юзерских:
    clear();
    const u2 = user("iso");
    const p2 = [repo("pp1")].map((r) => enqueueScan(q, r, { triggerKind: "periodic" }));
    const us2 = [repo("uu1"), repo("uu2")].map((r) => enqueueScan(q, r, { userId: u2, triggerKind: "user" }));
    const isoOrder: number[] = [];
    let t2 = Date.parse("2026-09-19T00:00:00Z");
    for (let job = claimAny(q, ["user"], new Date(t2)); job; job = claimAny(q, ["user"], new Date((t2 += 1000))) ) isoOrder.push(job.id);
    expect(isoOrder).toEqual(us2);
    expect(p2[0] !== undefined).toBe(true); // периодика не тронута изолированным воркером
  });

  test("attempts: +1 при claim; исчерпавшая попытки job переводится в failed и не заявляется", () => {
    clear();
    const r = repo("poison");
    const id = enqueueScan(q, r, { triggerKind: "periodic" });
    let t = Date.parse("2026-09-18T00:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const job = claimAny(q, ["user", "rating"], new Date(t), 1000, { maxAttempts: 3 });
      expect(job?.id).toBe(id);
      expect(job?.attempts).toBe(i);
      t += 5000; // лиз истёк — воркер «упал»
    }
    expect(claimAny(q, ["user", "rating"], new Date(t), 1000, { maxAttempts: 3 })).toBeNull();
    expect((q.query("SELECT status, attempts FROM jobs WHERE id = ?").get(id) as { status: string; attempts: number })).toEqual({ status: "failed", attempts: 3 });
  });

  test("лиз: renewLease продлевает только свою заявку; воркер-луп продлевает каждые leaseMs/3", async () => {
    clear();
    const r = repo("lease");
    const id = enqueueScan(q, r, { triggerKind: "periodic" });
    const job = claimAny(q, ["user", "rating"], new Date("2026-09-18T00:00:00Z"), 60_000)!;
    expect(renewLease(q, id, "1999-01-01T00:00:00.000Z", 60_000)).toBe(false);
    expect(renewLease(q, id, job.claimedAt, 10 * 60_000, new Date("2026-09-18T00:00:30Z"))).toBe(true);
    expect((q.query("SELECT lease_until FROM jobs WHERE id = ?").get(id) as { lease_until: string }).lease_until).toBe("2026-09-18T00:10:30.000Z");
    finishJob(q, id, job.claimedAt, "done");

    // воркер-луп: скан дольше лиза — лиз продлевается, job не перезаявляется
    enqueueScan(q, repo("lease-loop"), { triggerKind: "periodic" });
    const base = loadConfig();
    const leases: string[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>((res) => (finish = res));
    const slow = (async () => {
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(50);
        const row = q.query("SELECT lease_until FROM jobs WHERE status = 'running'").get() as { lease_until: string } | null;
        if (row) leases.push(row.lease_until);
      }
      finish();
      return { scanId: 1, repoId: 1, status: "ok", repoAccess: "ok" } as ScanResult;
    }) as unknown as typeof import("../src/jobs/runner").runScan;
    const stop = startWorkerLoop(
      { db: q, config: { ...base, scheduler: { ...base.scheduler, leaseMs: 150 } }, serverClient: () => null, runScan: slow },
      { user: true, rating: true },
      5,
    );
    await done;
    await Bun.sleep(30);
    stop();
    expect(new Set(leases).size).toBeGreaterThan(1); // lease_until сдвигался во время скана
    expect((q.query("SELECT status, attempts FROM jobs WHERE repo_id = ?").get(repo("lease-loop")) as { status: string; attempts: number })).toEqual({ status: "done", attempts: 1 });
  });

  describe("В4.1-fix: очередь без гонок и со справедливостью (Ф1.5, Ф1.7, Ф1.8, Ф1.12)", () => {
    const okClient = { get: async () => ({ status: 200, json: { visibility: "public" }, bodyText: "" }), requestCount: () => 0 };

    test("≤ userActiveMax активных заявок на юзера → 429 too_many_active; после завершения — снова можно", async () => {
      clear();
      const u = user("active-max");
      const queue = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 2, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000 };
      expect((await requestUserScan(q, okClient, u, "am", "a", queue)).status).toBe(202);
      expect((await requestUserScan(q, okClient, u, "am", "b", queue)).status).toBe(202);
      // дубль активной заявки — по-прежнему 202 deduplicated (дедуп раньше предела)
      const dup = await requestUserScan(q, okClient, u, "am", "a", queue);
      expect({ status: dup.status, dedup: dup.body["deduplicated"] }).toEqual({ status: 202, dedup: true });
      const third = await requestUserScan(q, okClient, u, "am", "c", queue);
      expect(third.status).toBe(429);
      expect((third.body["error"] as { code: string }).code).toBe("too_many_active");
      const job = claimAny(q, ["user", "rating"])!;
      finishJob(q, job.id, job.claimedAt, "done");
      expect((await requestUserScan(q, okClient, u, "am", "c", queue)).status).toBe(202);
    });

    test("параллельные POST одного репо: одна заявка, остальные — честный deduplicated", async () => {
      clear();
      const u = user("par-dup");
      const slow = { get: async () => (await Bun.sleep(10), { status: 200, json: { visibility: "public" }, bodyText: "" }), requestCount: () => 0 };
      const queue = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 100, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000 };
      const outs = await Promise.all([1, 2, 3].map(() => requestUserScan(q, slow, u, "pd", "same", queue)));
      expect(outs.map((o) => o.body["deduplicated"]).sort()).toEqual([false, true, true]);
      expect(new Set(outs.map((o) => o.body["jobId"])).size).toBe(1);
    });

    test("справедливость: юзер с 2 заявками не занимает юзерскую половину — второй юзер идёт между ними", () => {
      clear();
      // Т2 (круг 2): курсор round-robin модульный. Тест детерминирован не
      // сам по себе, а лишь потому, что полоса rating здесь пуста — сброс
      // курсора делает это явным и герметизирует порядок от соседей
      __resetRoundRobin();
      const heavy = user("heavy");
      const light = user("light");
      const h1 = enqueueScan(q, repo("h1"), { userId: heavy, triggerKind: "user" });
      const h2 = enqueueScan(q, repo("h2"), { userId: heavy, triggerKind: "user" });
      const l1 = enqueueScan(q, repo("l1"), { userId: light, triggerKind: "user" });
      const order: number[] = [];
      let t = Date.parse("2026-09-18T00:00:00Z");
      for (let job = claimAny(q, ["user", "rating"], new Date(t)); job; job = claimAny(q, ["user", "rating"], new Date((t += 1000)))) order.push(job.id);
      expect(order).toEqual([h1, l1, h2]);
    });

    test("job без строки repos → failed, берётся следующая (попытки не сжигаются)", () => {
      clear();
      const orphan = q.query("INSERT INTO jobs (repo_id, status, trigger_kind, created_at) VALUES (999999, 'queued', 'periodic', ?)").run(new Date().toISOString());
      const next = enqueueScan(q, repo("after-orphan"), { triggerKind: "periodic" });
      const job = claimAny(q, ["user", "rating"])!;
      expect(job.id).toBe(next);
      expect(q.query("SELECT status, attempts FROM jobs WHERE id = ?").get(Number(orphan.lastInsertRowid))).toEqual({ status: "failed", attempts: 1 });
    });

    test("юзерская job без PAT → failed без скана; периодика — серверным токеном как раньше", async () => {
      clear();
      const u = user("no-pat");
      const base = loadConfig();
      const config = { ...base, auth: { ...base.auth, appSecret: "scheduler-test-secret-0000000000000000" } };
      let scans = 0;
      let serverClients = 0;
      const fakeScan = (async () => {
        scans++;
        return { scanId: 0, repoId: 0, status: "ok", repoAccess: "ok" };
      }) as unknown as typeof runScanType;
      const serverClient = () => {
        serverClients++;
        return null;
      };
      const userJob = enqueueScan(q, repo("np-user"), { userId: u, triggerKind: "user" });
      const claimedUser = claimNext(q, new Date(), 60_000, { queue: "user" })!;
      expect(claimedUser.id).toBe(userJob);
      expect(await processJob({ db: q, config, serverClient, runScan: fakeScan, getPat: () => null }, claimedUser)).toBe("no-pat");
      expect(q.query("SELECT status FROM jobs WHERE id = ?").get(userJob)).toEqual({ status: "failed" });
      expect({ scans, serverClients }).toEqual({ scans: 0, serverClients: 0 });
      enqueueScan(q, repo("np-periodic"), { triggerKind: "periodic" });
      await processJob({ db: q, config, serverClient, runScan: fakeScan, getPat: () => null }, claimNext(q, new Date(), 60_000, { queue: "rating" })!);
      expect({ scans, serverClients }).toEqual({ scans: 1, serverClients: 1 });
    });
  });
});

describe("ночной каталог: дифф, форс, эвикция", () => {
  test("первый прогон: новые репо в очередь; второй с неизменным last_updated — очередь пуста", async () => {
    const pages = [{ repos: [repoOf("nc", "one", "2026-09-10T00:00:00Z"), repoOf("nc", "two", "2026-09-11T00:00:00Z")], next: null }];
    const r1 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect(r1.ok).toBe(true);
    expect(r1.enqueued.map((e) => e.reason)).toEqual(["new", "new"]);
    expect(r1.evicted).toEqual([]);
    // второй прогон: даты не изменились → ничего в очередь
    const r2 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect(r2.enqueued).toEqual([]);
    expect(r2.returned).toEqual([]);
    // В4.2-port-fix (П5): инвариант держится и на НЕПРИГОДНОМ репо — ветка
    // retry-ineligible ставила job каждый обход, пока живая job не проверялась
    const one = (db.query("SELECT id FROM repos WHERE org_slug = 'nc' AND repo_slug = 'one'").get() as { id: number }).id;
    // очередь первого прогона разобрана (иначе гард П5 сработает уже на ней)
    db.query("UPDATE jobs SET status = 'done' WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'nc')").run();
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible) VALUES (?, ?, ?, 'ok', 'periodic', 0)").run(
      one,
      "2026-09-12T00:00:00Z",
      "2026-09-12T00:10:00Z",
    );
    const r3 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    const r4 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    const r5 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect({
      reasons: [r3, r4, r5].map((r) => r.enqueued.map((e) => e.reason).join(",") || "-"),
      liveJobs: (db.query("SELECT COUNT(*) AS c FROM jobs WHERE repo_id = ? AND status = 'queued'").get(one) as { c: number }).c,
    }).toEqual({ reasons: ["retry-ineligible", "-", "-"], liveJobs: 1 });
    // чистим очередь этих репо
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'nc')").run();
    db.query("DELETE FROM scans WHERE repo_id = ?").run(one);
  });

  test("дифф last_updated: изменившееся — в очередь, форс-тогл — все", async () => {
    const v1 = [{ repos: [repoOf("df", "x", "2026-09-01T00:00:00Z"), repoOf("df", "y", "2026-09-01T00:00:00Z")], next: null }];
    await nightlyCatalog(db, catalogClient(v1), { now: new Date() });
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'df')").run();
    // x обновился, y нет
    const v2 = [{ repos: [repoOf("df", "x", "2026-09-18T00:00:00Z"), repoOf("df", "y", "2026-09-01T00:00:00Z")], next: null }];
    const r = await nightlyCatalog(db, catalogClient(v2), { now: new Date() });
    expect(r.enqueued).toEqual([{ slug: "df/x", reason: "changed" }]);
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'df')").run();
    // форс-полный: даже неизменные
    const rForce = await nightlyCatalog(db, catalogClient(v2), { fullRescan: true, now: new Date() });
    expect(rForce.enqueued.map((e) => e.slug).sort()).toEqual(["df/x", "df/y"]);
    expect(rForce.enqueued.every((e) => e.reason === "forced")).toBe(true);
    // Т3 (круг 2): следствие отклонения 7 круга 1 — гард П5 стоит на ВСЕХ
    // причинах постановки, поэтому SCHEDULER_FULL_RESCAN при непустой очереди
    // периодики job НЕ дублирует. Свойство закрепляется тестом, а не отчётом:
    // очередь после форса не разбиралась, второй форс не добавляет ни строки
    const rForce2 = await nightlyCatalog(db, catalogClient(v2), { fullRescan: true, now: new Date() });
    const live = (db.query("SELECT COUNT(*) AS c FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE r.org_slug = 'df' AND j.status = 'queued'").get() as { c: number }).c;
    expect({ second: rForce2.enqueued, live }).toEqual({ second: [], live: 2 });
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'df')").run();
  });

  test("проваленный скан ретраится следующей ночью (retry-failed)", async () => {
    const pages = [{ repos: [repoOf("rt", "flaky", "2026-09-01T00:00:00Z")], next: null }];
    await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    db.query("UPDATE jobs SET status = 'failed' WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'rt')").run();
    const r2 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect(r2.enqueued).toEqual([{ slug: "rt/flaky", reason: "retry-failed" }]);
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'rt')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'rt'").run();
  });

  test("retry-failed — только по периодическим job; юзерская job не навязывает и не маскирует перескан (круг 2, LOW-8)", async () => {
    const pages = [{ repos: [repoOf("rf", "a", "2026-09-01T00:00:00Z"), repoOf("rf", "b", "2026-09-01T00:00:00Z")], next: null }];
    await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    const a = seedRepo("rf", "a", "2026-09-01T00:00:00Z");
    const b = seedRepo("rf", "b", "2026-09-01T00:00:00Z");
    db.query("INSERT OR IGNORE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-rf', 'rf', '2026', '2026')").run();
    const uid = (db.query("SELECT id FROM users WHERE ya_id = 'ya-rf'").get() as { id: number }).id;
    // a: периодическая done, потом юзерская failed → перескана нет
    db.query("UPDATE jobs SET status = 'done' WHERE repo_id IN (?, ?)").run(a, b);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, 'failed', ?, 'user', '2026')").run(a, uid);
    // b: периодическая failed, потом юзерская done → перескан
    db.query("UPDATE jobs SET status = 'failed' WHERE repo_id = ? AND user_id IS NULL").run(b);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, 'done', ?, 'user', '2026')").run(b, uid);
    const r2 = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect(r2.enqueued).toEqual([{ slug: "rf/b", reason: "retry-failed" }]);
    db.query("DELETE FROM jobs WHERE repo_id IN (?, ?)").run(a, b);
    db.query("DELETE FROM repos WHERE org_slug = 'rf'").run();
  });

  test("retry-ineligible: не чаще раза за обход; пригодный последний периодический скан — без перескана (круг 2, С3)", async () => {
    const r = seedRepo("ri", "dup", "2026-09-01T00:00:00Z");
    const ok = seedRepo("ri", "fine", "2026-09-01T00:00:00Z");
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible) VALUES (?, '2026', '2026', 'partial', 'periodic', 0)").run(r);
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible) VALUES (?, '2026', '2026', 'ok', 'periodic', 1)").run(ok);
    const pages = [{ repos: [repoOf("ri", "dup", "2026-09-01T00:00:00Z"), repoOf("ri", "dup", "2026-09-01T00:00:00Z"), repoOf("ri", "fine", "2026-09-01T00:00:00Z")], next: null }];
    const out = await nightlyCatalog(db, catalogClient(pages), { now: new Date() });
    expect(out.enqueued).toEqual([{ slug: "ri/dup", reason: "retry-ineligible" }]);
    db.query("DELETE FROM jobs WHERE repo_id IN (?, ?)").run(r, ok);
    db.query("DELETE FROM scans WHERE repo_id IN (?, ?)").run(r, ok);
    db.query("DELETE FROM repos WHERE org_slug = 'ri'").run();
  });

  test("эвикция пропавших из ПОЛНОГО каталога; неполный каталог не эвиктит; возврат флагом", async () => {
    const gone = seedRepo("ev", "gone", "2026-09-01T00:00:00Z");
    seedRepo("ev", "stay", "2026-09-01T00:00:00Z");
    // каталог без 'ev/gone' и без 'ev/stay'? нет: stay остаётся
    const withStay = [{ repos: [repoOf("ev", "stay", "2026-09-01T00:00:00Z")], next: null }];
    const r = await nightlyCatalog(db, catalogClient(withStay), { now: new Date() });
    expect(r.evicted).toEqual(["ev/gone"]);
    expect((db.query("SELECT rating_active, evict_reason FROM repos WHERE id = ?").get(gone) as { rating_active: number; evict_reason: string }).rating_active).toBe(0);
    expect(db.query("SELECT COUNT(*) c FROM jobs WHERE repo_id = ?").get(gone) as { c: number }).toEqual({ c: 0 }); // эвиктированный не в очереди
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'ev')").run();
    // неполный каталог (страницы исчерпаны, next остался): эвикции нет
    db.query("UPDATE repos SET rating_active = 1 WHERE id = ?").run(gone);
    const truncated = catalogClient([{ repos: [repoOf("ev", "stay", "2026-09-01T00:00:00Z")], next: "more" }]);
    // force maxPages=1 + следующий токен → truncated
    const r2 = await nightlyCatalog(db, truncated, { maxPages: 1, now: new Date() });
    expect(r2.catalogComplete).toBe(false);
    expect(r2.evicted).toEqual([]);
    // репо вернулся в каталог → возврат флагом
    const back = [{ repos: [repoOf("ev", "gone", "2026-09-18T00:00:00Z"), repoOf("ev", "stay", "2026-09-01T00:00:00Z")], next: null }];
    db.query("UPDATE repos SET rating_active = 0 WHERE id = ?").run(gone);
    const r3 = await nightlyCatalog(db, catalogClient(back), { now: new Date() });
    expect(r3.returned).toEqual(["ev/gone"]);
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(gone) as { rating_active: number }).rating_active).toBe(1);
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'ev')").run();
  });

  test("приватный own-репо не эвиктится отсутствием в публичном каталоге", async () => {
    const privId = seedRepo("pv", "own-repo", null, "private");
    const onlyPublic = [{ repos: [repoOf("nc", "one", "2026-09-10T00:00:00Z")], next: null }];
    const r = await nightlyCatalog(db, catalogClient(onlyPublic), { now: new Date() });
    expect(r.evicted).not.toContain("pv/own-repo");
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(privId) as { rating_active: number }).rating_active).toBe(1);
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'nc')").run();
  });

  test("мёртвый каталог → ok=false с ошибкой, ничего не эвиктится", async () => {
    const dead: ScClient = {
      async get() {
        return { status: 503, json: null, bodyText: "" };
      },
      requestCount: () => 1,
    };
    const r = await nightlyCatalog(db, dead, { now: new Date() });
    expect(r.ok).toBe(false);
    expect(r.pages).toBe(0);
  });
});

describe("processJob: repo-сигнал эвикции и заявки юзеров (К3)", () => {
  // герметично (M10): APP_SECRET инъектируется в конфиг теста, не из .env
  const base = loadConfig();
  const config = { ...base, scan: DEFAULT_SCAN, auth: { ...base.auth, appSecret: "test-app-secret" } };

  function fakeWorker(runScanImpl: (slug: string, opts: Record<string, unknown>) => Partial<ScanResult>) {
    const calls: { slug: string; opts: Record<string, unknown>; deps: ScanDeps }[] = [];
    const deps = {
      db,
      config,
      serverClient: () => null,
      runScan: (async (d: ScanDeps, slug: string, opts: Record<string, unknown>) => {
        calls.push({ slug, opts, deps: d });
        return { scanId: 1, repoId: 1, status: "ok", ...runScanImpl(slug, opts) } as ScanResult;
      }) as typeof import("../src/jobs/runner").runScan,
    };
    return { deps, calls };
  }

  test("repoAccess gone (repo-GET 403/404) → эвикция; канальные cicd-403 не эвиктят", async () => {
    const g = seedRepo("pj", "gone-repo");
    const { deps } = fakeWorker(() => ({ repoAccess: "gone" }));
    const out = await processJob(deps, { id: 1, repoId: g, slug: "pj/gone-repo", userId: null, triggerKind: "periodic", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
    expect(out).toBe("gone");
    const row = db.query("SELECT rating_active, evict_reason FROM repos WHERE id = ?").get(g) as { rating_active: number; evict_reason: string };
    expect(row.rating_active).toBe(0);
    expect(row.evict_reason).toContain("404/403");
    returnRepo(db, g);
    // cicd-403: repoAccess ok (репо-GET прошёл) — эвикции нет
    const s = seedRepo("pj", "cicd-403");
    const { deps: d2 } = fakeWorker(() => ({ repoAccess: "ok" }));
    const out2 = await processJob(d2, { id: 2, repoId: s, slug: "pj/cicd-403", userId: null, triggerKind: "periodic", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
    expect(out2).not.toBe("gone");
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(s) as { rating_active: number }).rating_active).toBe(1);
  });

  test("заявка юзера: автор и PAT пробрасываются в runScan; без PAT — скана нет (Ф1.8)", async () => {
    db.query("INSERT OR REPLACE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-2', 'u2', '2026', '2026')").run();
    const uid = (db.query("SELECT id FROM users WHERE ya_id = 'ya-2'").get() as { id: number }).id;
    const { deps, calls } = fakeWorker(() => ({ repoAccess: "ok" }));
    const job: ClaimedJob = { id: 3, repoId: 1, slug: "pj/own", userId: uid, triggerKind: "user", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 };
    // PAT нет (getPat реальный, APP_SECRET инъектирован в конфиг) → failed без скана, серверный токен не берётся
    expect(await processJob(deps, job)).toBe("no-pat");
    expect(calls).toHaveLength(0);
    // сохраняем PAT через шов настроек окружения — проверяем проброс
    const withPat = { ...deps, getPat: () => "user-pat-value" };
    await processJob(withPat, job);
    expect(calls[0]!.opts["userId"]).toBe(uid);
    expect(calls[0]!.opts["userToken"]).toBe("user-pat-value");
  });

  test("H1: repo-GET 403/404 у заявки юзера НЕ эвиктирует; у периодики — эвиктирует", async () => {
    const r = seedRepo("pj", "popular");
    const { deps } = fakeWorker(() => ({ repoAccess: "gone" }));
    const out = await processJob({ ...deps, getPat: () => "narrow-pat" }, { id: 4, repoId: r, slug: "pj/popular", userId: 1, triggerKind: "user", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
    expect(out).not.toBe("gone");
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(r) as { rating_active: number }).rating_active).toBe(1);
    const out2 = await processJob(deps, { id: 5, repoId: r, slug: "pj/popular", userId: null, triggerKind: "periodic", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
    expect(out2).toBe("gone");
    returnRepo(db, r);
  });

  test("H2: фабрика серверного клиента — новый клиент и бюджет на каждую задачу", async () => {
    const mock = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    try {
      const made: ScClient[] = [];
      const serverClient = () => {
        const c = makeScClient({ token: "x", baseUrl: `http://127.0.0.1:${mock.port}`, minIntervalMs: 0, maxRequests: 3 });
        made.push(c);
        return c;
      };
      const statuses: number[][] = [];
      const burn = (async (d: ScanDeps) => {
        const got: number[] = [];
        for (let i = 0; i < 4; i++) got.push((await d.scClient!.get("/repos/o/r")).status);
        statuses.push(got);
        return { scanId: 1, repoId: 1, status: "ok", repoAccess: "ok" } as ScanResult;
      }) as typeof import("../src/jobs/runner").runScan;
      const w = { db, config, serverClient, runScan: burn };
      await processJob(w, { id: 6, repoId: 1, slug: "o/r", userId: null, triggerKind: "periodic", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
      await processJob(w, { id: 7, repoId: 1, slug: "o/r", userId: null, triggerKind: "periodic", claimedAt: "2026-09-18T00:00:00.000Z", attempts: 1 });
      expect(made).toHaveLength(2);
      // бюджет исчерпан ВНУТРИ первой задачи, вторая начинает с полным
      expect(statuses).toEqual([
        [200, 200, 200, 0],
        [200, 200, 200, 0],
      ]);
    } finally {
      mock.stop(true);
    }
  });
});

// В4.2-port-fix (П7): круговой порядок Ф1.7 — свойство полосы user. Порты
// распространили его коррелированный подзапрос и на полосу rating, где
// user_id всегда NULL: на 28 000 job без idx_jobs_user_claimed один
// claim(rating) занимал 335 655 мс (замер вехи; у ревьюера 576,8 с) — это не
// «медленнее», а мёртвый синхронный claim, останавливающий и HTTP. Индекс
// живёт в LATE_INDEXES и в норме есть — здесь он РОНЯЕТСЯ вручную, чтобы
// проверить, что подзапрос в полосе rating больше не исполняется.
describe("П7: claim(rating) не платит за подзапрос кругового порядка", () => {
  test(
    "28 000 job в полосе rating без idx_jobs_user_claimed: claim ≤ 100 мс",
    () => {
      const pdir = mkdtempSync(join(tmpdir(), "rh-p7-"));
      const p: Database = openDb({ ...loadConfig(), dataDir: pdir });
      try {
        p.exec("PRAGMA synchronous = OFF");
        const repoIds: number[] = [];
        const userIds: number[] = [];
        p.transaction(() => {
          for (let i = 0; i < 20; i++) {
            repoIds.push(Number(p.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('p7', ?, 'public')").run(`r${i}`).lastInsertRowid));
            p.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES (?, ?, '2026', '2026')").run(`ya-p7-${i}`, `p7-${i}`);
            userIds.push((p.query("SELECT id FROM users WHERE ya_id = ?").get(`ya-p7-${i}`) as { id: number }).id);
          }
        })();
        p.transaction(() => {
          const ins = p.query(
            "INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at, claimed_at) VALUES (?, ?, ?, ?, '2026-09-18T00:00:00Z', ?)",
          );
          for (let i = 0; i < 28_000; i++) ins.run(repoIds[i % repoIds.length]!, "queued", null, "periodic", null);
          for (let i = 0; i < 300; i++) ins.run(repoIds[i % repoIds.length]!, "queued", userIds[i % userIds.length]!, "user", null);
          // история с заполненным claimed_at — именно её сканировал подзапрос
          for (let i = 0; i < 20_000; i++) ins.run(repoIds[i % repoIds.length]!, "done", userIds[i % userIds.length]!, "user", `2026-09-1${i % 8}T00:00:00Z`);
        })();
        p.exec("DROP INDEX IF EXISTS idx_jobs_user_claimed");
        const t0 = Date.now();
        const job = claimNext(p, new Date("2026-09-18T12:00:00Z"), 60 * 60_000, { queue: "rating", maxAttempts: 3 });
        const elapsed = Date.now() - t0;
        expect({ triggerKind: job?.triggerKind ?? null, under100ms: elapsed <= 100 ? "≤100" : `${elapsed} мс` }).toEqual({
          triggerKind: "periodic",
          under100ms: "≤100",
        });
      } finally {
        p.close();
        rmSync(pdir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

// В4.2-port-fix круг 2 (Т2): П1 был покрыт двумя формами нагрузки из шести —
// «полоса user пустеет и наполняется» ревьюер проверял руками, охраны от
// регрессии не было. Курсор round-robin модульный: тест герметизируется
// явным __resetRoundRobin().
describe("П1 (Т2): полоса user пустеет и наполняется — курсор не залипает ни на пустой, ни на новой", () => {
  test("после опустошения юзерской полосы периодика идёт сплошь, а новые юзерские job снова разбираются", () => {
    const rdir = mkdtempSync(join(tmpdir(), "rh-rr-"));
    const r: Database = openDb({ ...loadConfig(), dataDir: rdir });
    try {
      __resetRoundRobin();
      const mk = (slug: string) => Number(r.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('rr', ?, 'public')").run(slug).lastInsertRowid);
      r.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-rr', 'rr', '2026', '2026')").run();
      const uid = (r.query("SELECT id FROM users WHERE ya_id = 'ya-rr'").get() as { id: number }).id;
      for (let i = 0; i < 2; i++) enqueueScan(r, mk(`u${i}`), { userId: uid, triggerKind: "user" });
      for (let i = 0; i < 12; i++) enqueueScan(r, mk(`p${i}`), { triggerKind: "periodic" });
      let t = Date.parse("2026-09-18T00:00:00Z");
      const take = (n: number) => {
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const job = claimAny(r, ["user", "rating"], new Date((t += 1000)), 60 * 60_000);
          out.push(job === null ? "none" : job.triggerKind);
        }
        return out;
      };
      // фаза 1: обе полосы непусты — обе разбираются
      const mixed = take(4);
      // фаза 2: юзерская полоса пуста — периодика идёт сплошь, null не возвращается
      const drained = take(4);
      // фаза 3: полоса наполнилась снова — новые юзерские job не голодают
      for (let i = 0; i < 2; i++) enqueueScan(r, mk(`u2${i}`), { userId: uid, triggerKind: "user" });
      const refilled = take(4);
      expect({
        userInMixed: mixed.filter((x) => x === "user").length,
        periodicInMixed: mixed.filter((x) => x === "periodic").length,
        drained: drained.join(" "),
        userAfterRefill: refilled.filter((x) => x === "user").length,
        periodicAfterRefill: refilled.filter((x) => x === "periodic").length,
      }).toEqual({
        userInMixed: 2,
        periodicInMixed: 2,
        drained: "periodic periodic periodic periodic",
        userAfterRefill: 2,
        periodicAfterRefill: 2,
      });
    } finally {
      r.close();
      rmSync(rdir, { recursive: true, force: true });
    }
  });
});

// В4.2-port-fix круг 2 (П12, Н-3): гард П5 спрашивает про живую периодическую
// job КАЖДОГО репо каталога. Своего индекса у jobs(repo_id, …) не было —
// SQLite брал idx_jobs_status_claimed и просматривал все queued/running строки
// на каждый вызов; обход не содержит await, поэтому цена гарда — один
// синхронный блок, во время которого не тикает даже таймер. Индекс
// idx_jobs_repo_status дополняет idx_jobs_status_claimed, а не заменяет его.
describe("П12: гард живой периодической job стоит поиска по индексу, а не обхода очереди", () => {
  const GUARD_SQL = "SELECT 1 FROM jobs WHERE repo_id = ? AND trigger_kind != 'user' AND status IN ('queued', 'running') LIMIT 1";
  test(
    "20 000 живых job: EXPLAIN QUERY PLAN гарда — SEARCH по idx_jobs_repo_status, вызов ≤ 0,05 мс",
    () => {
      const gdir = mkdtempSync(join(tmpdir(), "rh-p12-"));
      const g: Database = openDb({ ...loadConfig(), dataDir: gdir });
      try {
        g.exec("PRAGMA synchronous = OFF");
        const repoIds: number[] = [];
        g.transaction(() => {
          for (let i = 0; i < 400; i++) {
            repoIds.push(Number(g.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('p12', ?, 'public')").run(`r${i}`).lastInsertRowid));
          }
          const ins = g.query("INSERT INTO jobs (repo_id, status, trigger_kind, created_at) VALUES (?, 'queued', 'periodic', '2026-09-18T00:00:00Z')");
          // живая очередь на первой сотне репо; гард спрашивают про остальные
          for (let i = 0; i < 20_000; i++) ins.run(repoIds[i % 100]!);
        })();
        g.exec("ANALYZE");
        const plan = (g.query(`EXPLAIN QUERY PLAN ${GUARD_SQL}`).all(repoIds[200]!) as { detail: string }[]).map((r) => r.detail).join(" | ");
        const guard = g.query(GUARD_SQL);
        const calls = 200;
        const t0 = Bun.nanoseconds();
        for (let i = 0; i < calls; i++) guard.get(repoIds[100 + (i % 300)]!);
        const perCall = (Bun.nanoseconds() - t0) / calls / 1e6;
        expect({
          usesIndex: plan.includes("idx_jobs_repo_status") ? "idx_jobs_repo_status" : plan,
          perCall: perCall <= 0.05 ? "≤0,05 мс" : `${perCall.toFixed(3)} мс`,
        }).toEqual({ usesIndex: "idx_jobs_repo_status", perCall: "≤0,05 мс" });
      } finally {
        g.close();
        rmSync(gdir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

// В4.2-port-fix (П8, LOW-1): колонку jobs.error принесли порты, myJobs её
// читает, UI рисует дословно — но НИ ОДНОГО UPDATE в неё не было, то есть
// панель заданий всегда показывала «упало» без причины. Причины — закрытый
// список RU-текстов; обе ветки, ходившие мимо finishJob (предел попыток и
// job без строки repos), переведены на него.
describe("П8: причина падения job пишется в jobs.error", () => {
  const edir = mkdtempSync(join(tmpdir(), "rh-joberr-"));
  const e: Database = openDb({ ...loadConfig(), dataDir: edir });
  afterAll(() => {
    e.close();
    rmSync(edir, { recursive: true, force: true });
  });
  const errorOf = (id: number) => (e.query("SELECT status, error FROM jobs WHERE id = ?").get(id) as { status: string; error: string | null });
  const eRepo = (slug: string) => {
    e.query("INSERT OR IGNORE INTO repos (org_slug, repo_slug) VALUES ('je', ?)").run(slug);
    return (e.query("SELECT id FROM repos WHERE org_slug = 'je' AND repo_slug = ?").get(slug) as { id: number }).id;
  };

  test("предел попыток → «превышено число попыток» (ветка массового UPDATE переведена на finishJob)", () => {
    const id = enqueueScan(e, eRepo("poison"), { triggerKind: "periodic" });
    e.query("UPDATE jobs SET attempts = 3 WHERE id = ?").run(id);
    expect(claimNext(e, new Date("2026-09-18T00:00:00Z"), 60_000, { queue: "rating", maxAttempts: 3 })).toBeNull();
    expect(errorOf(id)).toEqual({ status: "failed", error: "превышено число попыток" });
  });

  test("job без строки repos → «репозиторий недоступен»; успешное завершение гасит причину", () => {
    const orphan = Number(
      e.query("INSERT INTO jobs (repo_id, status, trigger_kind, created_at) VALUES (999999, 'queued', 'periodic', '2026-09-18T00:00:00Z')").run()
        .lastInsertRowid,
    );
    const next = enqueueScan(e, eRepo("after-orphan"), { triggerKind: "periodic" });
    const job = claimNext(e, new Date("2026-09-18T01:00:00Z"), 60_000, { queue: "rating" })!;
    expect(job.id).toBe(next);
    expect(errorOf(orphan)).toEqual({ status: "failed", error: "репозиторий недоступен" });
    // причина не «липнет»: успешный прогон её гасит
    e.query("UPDATE jobs SET error = 'старая причина' WHERE id = ?").run(next);
    expect(finishJob(e, next, job.claimedAt, "done")).toBe(true);
    expect(errorOf(next)).toEqual({ status: "done", error: null });
  });

  test("юзерская job без читаемого PAT → «нет действующего токена» (Ф1.8 + П8)", async () => {
    e.query("INSERT OR IGNORE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-je', 'je', '2026', '2026')").run();
    const uid = (e.query("SELECT id FROM users WHERE ya_id = 'ya-je'").get() as { id: number }).id;
    const id = enqueueScan(e, eRepo("no-pat"), { userId: uid, triggerKind: "user" });
    const base = loadConfig();
    const config = { ...base, auth: { ...base.auth, appSecret: "scheduler-test-secret-0000000000000000" } };
    const job = claimNext(e, new Date("2026-09-18T02:00:00Z"), 60_000, { queue: "user" })!;
    expect(job.id).toBe(id);
    const out = await processJob({ db: e, config, serverClient: () => null, getPat: () => null }, job);
    expect({ out, row: errorOf(id) }).toEqual({ out: "no-pat", row: { status: "failed", error: "нет действующего токена" } });
  });

  test("bad-скан → «сбор данных не удался: <каналы>»; myJobs отдаёт причину панели заданий", () => {
    expect(failedChannelsOf({ git: "no-data(limits)", rest: "ok", appsec: "skipped" })).toEqual(["git"]);
    expect(JOB_ERRORS.channels(["git", "rest"])).toBe("сбор данных не удался: git, rest");
    e.query("INSERT OR IGNORE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-je2', 'je2', '2026', '2026')").run();
    const uid = (e.query("SELECT id FROM users WHERE ya_id = 'ya-je2'").get() as { id: number }).id;
    const id = enqueueScan(e, eRepo("bad-scan"), { userId: uid, triggerKind: "user" });
    const job = claimNext(e, new Date("2026-09-18T03:00:00Z"), 60_000, { queue: "user" })!;
    finishJob(e, id, job.claimedAt, "failed", JOB_ERRORS.channels(failedChannelsOf({ git: "bad", rest: "no-data(access)", appsec: "skipped" })));
    const recent = myJobs(e, uid).recent.find((j) => j.jobId === id);
    expect({ slug: recent?.slug, phase: recent?.phase, error: recent?.error }).toEqual({
      slug: "je/bad-scan",
      phase: "failed",
      error: "сбор данных не удался: git, rest",
    });
  });

  test("текст причины обрезан по 500 символов и не несёт секретов", () => {
    const id = enqueueScan(e, eRepo("long"), { triggerKind: "periodic" });
    const job = claimNext(e, new Date("2026-09-18T04:00:00Z"), 60_000, { queue: "rating" })!;
    finishJob(e, id, job.claimedAt, "failed", "x".repeat(900));
    expect(errorOf(id).error?.length).toBe(500);
  });

  // Т4 (круг 2): длина — не гарантия безопасности. Безопасность даёт закрытый
  // список констант: НИ ОДИН вызывающий finishJob не имеет права собрать
  // причину из ответа платформы, пути клона или текста исключения.
  test("все причины, которые пишет код, принадлежат закрытому списку JOB_ERRORS", () => {
    const fixed: string[] = [JOB_ERRORS.gone, JOB_ERRORS.noPat, JOB_ERRORS.attempts, JOB_ERRORS.internal];
    const belongs = (text: string) => fixed.includes(text) || /^сбор данных не удался: (git|rest|appsec)(, (git|rest|appsec))*$/.test(text);
    const written = (e.query("SELECT DISTINCT error FROM jobs WHERE error IS NOT NULL").all() as { error: string }[]).map((r) => r.error);
    // строка теста про обрезку — единственная искусственная, её исключаем явно
    const real = written.filter((t) => !/^x+$/.test(t));
    expect({ count: real.length > 0, stranger: real.filter((t) => !belongs(t)) }).toEqual({ count: true, stranger: [] });
    // и сам список: ни одной подстановки снаружи — только канальные имена
    expect([JOB_ERRORS.channels(["git"]), JOB_ERRORS.channels(["rest", "appsec"])].every(belongs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ф2.1 (M1, остаток после портов). Тело тика — функция, вызываемая через шов:
// тест дёргает её НАПРЯМУЮ, без таймера. Броня портов при этом не дублируется
// и не ослабляется — проверяем именно её через шов.
// ---------------------------------------------------------------------------

describe("Ф2.1: тик воркер-лупа и планировщика вызываются напрямую и не выпускают исключение", () => {
  const base = loadConfig();
  const config = { ...base, scan: DEFAULT_SCAN, auth: { ...base.auth, appSecret: "test-app-secret" } };

  test("claim бросает (SQLITE_BUSY) → тик возвращает claim-failed, цикл жив, следующий тик работает", async () => {
    let firstCall = true;
    const deps = {
      db,
      config,
      serverClient: () => null,
      claimAny: (() => {
        if (firstCall) {
          firstCall = false;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return null;
      }) as unknown as typeof claimAny,
    };
    expect(await workerTick(deps, ["user"], { busy: false })).toBe("claim-failed");
    // цикл жив: следующий тик доходит до пустой очереди
    expect(await workerTick(deps, ["user"], { busy: false })).toBe("idle");
  });

  test("processJob бросает → job закрыта failed с внутренней причиной, исключение не выходит наружу", async () => {
    const repoId = seedRepo("tick", "crash");
    const jobId = enqueueScan(db, repoId, { triggerKind: "periodic" });
    const deps = {
      db,
      config,
      serverClient: () => null,
      runScan: (async () => {
        throw new Error("boom");
      }) as unknown as typeof runScanType,
    };
    expect(await workerTick(deps, ["rating"], { busy: false })).toBe("failed");
    const row = db.query("SELECT status, error FROM jobs WHERE id = ?").get(jobId) as { status: string; error: string | null };
    expect({ status: row.status, error: row.error }).toEqual({ status: "failed", error: JOB_ERRORS.internal });
  });

  test("тик занят (busy) → повторный вызов не заявляет вторую job", async () => {
    const deps = { db, config, serverClient: () => null };
    expect(await workerTick(deps, ["user"], { busy: true })).toBe("busy");
  });

  test("catalogTick: бросок внутри обхода не выходит наружу; re-entrancy-гард пропускает повторный вход", async () => {
    const throwing: ScClient = {
      async get(): Promise<ScResponse> {
        throw new Error("network exploded");
      },
      requestCount: () => 0,
    };
    const state = { walking: false };
    expect(await catalogTick(db, () => throwing, config, state)).toBeNull();
    expect(state.walking).toBe(false); // гард сняли в finally — следующий обход возможен
    // гард поднят (обход уже идёт) → второй вход пропускается без работы
    const busyState = { walking: true };
    expect(await catalogTick(db, () => throwing, config, busyState)).toBeNull();
    expect(busyState.walking).toBe(true);
  });

  test("maintenanceTick на закрытой БД не бросает, отчитывается нулями по сканам", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rh-maint-"));
    const closed = openDb({ ...loadConfig(), dataDir: tmp });
    closed.close();
    const out = await maintenanceTick(closed, config, { cloneDir: tmp });
    expect(out.scans).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Ф2.2 (M2, остаток). Осиротевшие `running`-сканы. Не путать с
// `sweepOrphanClones` — там каталоги клонов в tmp, здесь строки `scans`.
// ---------------------------------------------------------------------------

describe("Ф2.2: осиротевшие running-сканы закрываются как bad/orphaned", () => {
  const LEASE = 60 * 60_000;
  const NOW = new Date("2026-09-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  const seedRunningScan = (repoId: number, startedAt: string, userId: number | null = null): number => {
    const r = db
      .query("INSERT INTO scans (repo_id, started_at, status, public_status, trigger, user_id) VALUES (?, ?, 'running', 'running', 'periodic', ?)")
      .run(repoId, startedAt, userId);
    return Number(r.lastInsertRowid);
  };

  test("running старше лиза без живой job → bad, finished_at, status_detail='orphaned'", () => {
    const repoId = seedRepo("orphan", "stale");
    const scanId = seedRunningScan(repoId, ago(3 * LEASE));
    expect(sweepOrphanScans(db, { leaseMs: LEASE, now: NOW })).toContain(scanId);
    const row = db.query("SELECT status, public_status, finished_at, status_detail FROM scans WHERE id = ?").get(scanId) as {
      status: string;
      public_status: string;
      finished_at: string;
      status_detail: string;
    };
    expect(row).toEqual({
      status: "bad",
      public_status: "bad",
      finished_at: NOW.toISOString(),
      status_detail: "orphaned",
    });
  });

  test("running моложе лиза не трогается: скан идёт прямо сейчас", () => {
    const repoId = seedRepo("orphan", "fresh");
    const scanId = seedRunningScan(repoId, ago(LEASE / 2));
    expect(sweepOrphanScans(db, { leaseMs: LEASE, now: NOW })).not.toContain(scanId);
    expect((db.query("SELECT status FROM scans WHERE id = ?").get(scanId) as { status: string }).status).toBe("running");
  });

  test("живая job с непросроченным лизом прикрывает свой running-скан", () => {
    const repoId = seedRepo("orphan", "alive");
    const scanId = seedRunningScan(repoId, ago(3 * LEASE));
    const jobId = enqueueScan(db, repoId, { triggerKind: "periodic" });
    db.query("UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ? WHERE id = ?").run(ago(LEASE / 2), new Date(NOW.getTime() + LEASE / 2).toISOString(), jobId);
    expect(sweepOrphanScans(db, { leaseMs: LEASE, now: NOW })).not.toContain(scanId);
    // лиз протух — прикрытия больше нет
    db.query("UPDATE jobs SET lease_until = ? WHERE id = ?").run(ago(LEASE), jobId);
    expect(sweepOrphanScans(db, { leaseMs: LEASE, now: NOW })).toContain(scanId);
  });

  test("периодический скан не прикрывается юзерской job по тому же репо (user_id IS)", () => {
    const repoId = seedRepo("orphan", "mixed");
    db.query("INSERT OR REPLACE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-orphan', 'uo', '2026', '2026')").run();
    const uid = (db.query("SELECT id FROM users WHERE ya_id = 'ya-orphan'").get() as { id: number }).id;
    const scanId = seedRunningScan(repoId, ago(3 * LEASE), null);
    const jobId = enqueueScan(db, repoId, { userId: uid, triggerKind: "user" });
    db.query("UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ? WHERE id = ?").run(ago(60_000), new Date(NOW.getTime() + LEASE).toISOString(), jobId);
    expect(sweepOrphanScans(db, { leaseMs: LEASE, now: NOW })).toContain(scanId);
  });

  test("maintenanceTick закрывает сироту тем же правилом (шов тика)", async () => {
    const repoId = seedRepo("orphan", "via-tick");
    const scanId = seedRunningScan(repoId, "2020-01-01T00:00:00.000Z");
    const base = loadConfig();
    const out = await maintenanceTick(db, { ...base, scheduler: { ...base.scheduler, leaseMs: LEASE } }, { cloneDir: dir });
    expect(out.scans).toBeGreaterThanOrEqual(1);
    expect((db.query("SELECT status_detail FROM scans WHERE id = ?").get(scanId) as { status_detail: string }).status_detail).toBe("orphaned");
  });
});
