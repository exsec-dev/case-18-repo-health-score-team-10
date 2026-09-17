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
  claimNext,
  countRecentUserJobs,
  enqueueScan,
  evictRepo,
  findActiveUserJob,
  finishJob,
  nightlyCatalog,
  processJob,
  renewLease,
  returnRepo,
  startWorkerLoop,
  type ClaimedJob,
} from "../src/jobs/scheduler";
import { requestUserScan } from "../src/api/me";
import { upsertRepo, type runScan, type ScanDeps, type ScanResult } from "../src/jobs/runner";
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
    const first = claimNext(db, now, 60_000);
    expect(first?.slug).toBe("cl/a");
    expect(first?.userId).toBeNull();
    expect(first?.attempts).toBe(1);
    // лиз поставлен и живёт: строка больше не заявляется
    const second = claimNext(db, new Date(now.getTime() + 30_000), 60_000);
    expect(second?.slug).toBe("cl/b");
    expect(claimNext(db, new Date(now.getTime() + 30_000), 60_000)).toBeNull();
    // истёкший лиз (упавший воркер) → job снова доступна, попытка №2
    const revived = claimNext(db, new Date(now.getTime() + 120_000), 60_000);
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
    const claimed = claimNext(db, new Date("2026-09-19T00:00:00Z"));
    expect(claimed?.id).toBe(userJob);
    expect(claimed?.userId).toBe(userId);
    finishJob(db, claimed!.id, claimed!.claimedAt, "done");
    const periodic = claimNext(db, new Date("2026-09-19T00:01:00Z"));
    expect(periodic?.slug).toBe("cl/c");
    finishJob(db, periodic!.id, periodic!.claimedAt, "done");
    // чистим за собой: дальше каталог-тесты видят чистую таблицу repos
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
  });

  test("finishJob по (id, claimed_at): очередь допускает несколько строк одного репо", () => {
    const e = seedRepo("cl", "e");
    const j1 = enqueueScan(db, e, {});
    const j2 = enqueueScan(db, e, { triggerKind: "user" });
    expect(j1).not.toBe(j2);
    const c1 = claimNext(db, new Date("2026-09-20T00:00:00Z"))!;
    const other = c1.id === j1 ? j2 : j1;
    finishJob(db, c1.id, c1.claimedAt, "done");
    expect((db.query("SELECT status FROM jobs WHERE id = ?").get(other) as { status: string }).status).toBe("queued");
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
  });
});

describe("очередь: анти-абьюз (К4 В4.1)", () => {
  // своя БД: чередование читает «последнюю заявленную» по всей таблице
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
    const claimed = claimNext(q, new Date("2026-09-18T00:00:00Z"))!;
    expect(claimed.id).toBe(j1);
    expect(enqueueScan(q, r, { userId: u, triggerKind: "user" })).toBe(j1); // running — тоже активна
    finishJob(q, j1, claimed.claimedAt, "done");
    expect(enqueueScan(q, r, { userId: u, triggerKind: "user" })).not.toBe(j1);
    expect(findActiveUserJob(q, u, r)).not.toBeNull();
  });

  test("лимит частоты: 11-я новая заявка за час → 429; дубли не считаются; окно скользящее", async () => {
    clear();
    const u = user("rate");
    const queue = { userScansPerHour: 10, maxAttempts: 3, userActiveMax: 100 };
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

  test("чередование: после юзерской заявки берётся периодическая, если она есть", () => {
    clear();
    const u = user("alt");
    const periodic = [repo("p1"), repo("p2")].map((r) => enqueueScan(q, r, { triggerKind: "periodic" }));
    const users = [repo("u1"), repo("u2"), repo("u3")].map((r) => enqueueScan(q, r, { userId: u, triggerKind: "user" }));
    const order: number[] = [];
    let t = Date.parse("2026-09-18T00:00:00Z");
    for (let job = claimNext(q, new Date(t)); job; job = claimNext(q, new Date((t += 1000)))) order.push(job.id);
    expect(order).toEqual([users[0], periodic[0], users[1], periodic[1], users[2]]);
  });

  test("attempts: +1 при claim; исчерпавшая попытки job переводится в failed и не заявляется", () => {
    clear();
    const r = repo("poison");
    const id = enqueueScan(q, r, { triggerKind: "periodic" });
    let t = Date.parse("2026-09-18T00:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const job = claimNext(q, new Date(t), 1000, { maxAttempts: 3 });
      expect(job?.id).toBe(id);
      expect(job?.attempts).toBe(i);
      t += 5000; // лиз истёк — воркер «упал»
    }
    expect(claimNext(q, new Date(t), 1000, { maxAttempts: 3 })).toBeNull();
    expect((q.query("SELECT status, attempts FROM jobs WHERE id = ?").get(id) as { status: string; attempts: number })).toEqual({ status: "failed", attempts: 3 });
  });

  test("лиз: renewLease продлевает только свою заявку; воркер-луп продлевает каждые leaseMs/3", async () => {
    clear();
    const r = repo("lease");
    const id = enqueueScan(q, r, { triggerKind: "periodic" });
    const job = claimNext(q, new Date("2026-09-18T00:00:00Z"), 60_000)!;
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
      const queue = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 2 };
      expect((await requestUserScan(q, okClient, u, "am", "a", queue)).status).toBe(202);
      expect((await requestUserScan(q, okClient, u, "am", "b", queue)).status).toBe(202);
      // дубль активной заявки — по-прежнему 202 deduplicated (дедуп раньше предела)
      const dup = await requestUserScan(q, okClient, u, "am", "a", queue);
      expect({ status: dup.status, dedup: dup.body["deduplicated"] }).toEqual({ status: 202, dedup: true });
      const third = await requestUserScan(q, okClient, u, "am", "c", queue);
      expect(third.status).toBe(429);
      expect((third.body["error"] as { code: string }).code).toBe("too_many_active");
      const job = claimNext(q)!;
      finishJob(q, job.id, job.claimedAt, "done");
      expect((await requestUserScan(q, okClient, u, "am", "c", queue)).status).toBe(202);
    });

    test("параллельные POST одного репо: одна заявка, остальные — честный deduplicated", async () => {
      clear();
      const u = user("par-dup");
      const slow = { get: async () => (await Bun.sleep(10), { status: 200, json: { visibility: "public" }, bodyText: "" }), requestCount: () => 0 };
      const queue = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 100 };
      const outs = await Promise.all([1, 2, 3].map(() => requestUserScan(q, slow, u, "pd", "same", queue)));
      expect(outs.map((o) => o.body["deduplicated"]).sort()).toEqual([false, true, true]);
      expect(new Set(outs.map((o) => o.body["jobId"])).size).toBe(1);
    });

    test("справедливость: юзер с 2 заявками не занимает юзерскую половину — второй юзер идёт между ними", () => {
      clear();
      const heavy = user("heavy");
      const light = user("light");
      const h1 = enqueueScan(q, repo("h1"), { userId: heavy, triggerKind: "user" });
      const h2 = enqueueScan(q, repo("h2"), { userId: heavy, triggerKind: "user" });
      const l1 = enqueueScan(q, repo("l1"), { userId: light, triggerKind: "user" });
      const order: number[] = [];
      let t = Date.parse("2026-09-18T00:00:00Z");
      for (let job = claimNext(q, new Date(t)); job; job = claimNext(q, new Date((t += 1000)))) order.push(job.id);
      expect(order).toEqual([h1, l1, h2]);
    });

    test("job без строки repos → failed, берётся следующая (попытки не сжигаются)", () => {
      clear();
      const orphan = q.query("INSERT INTO jobs (repo_id, status, trigger_kind, created_at) VALUES (999999, 'queued', 'periodic', ?)").run(new Date().toISOString());
      const next = enqueueScan(q, repo("after-orphan"), { triggerKind: "periodic" });
      const job = claimNext(q)!;
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
      }) as unknown as typeof runScan;
      const serverClient = () => {
        serverClients++;
        return null;
      };
      const userJob = enqueueScan(q, repo("np-user"), { userId: u, triggerKind: "user" });
      const claimedUser = claimNext(q)!;
      expect(claimedUser.id).toBe(userJob);
      expect(await processJob({ db: q, config, serverClient, runScan: fakeScan, getPat: () => null }, claimedUser)).toBe("no-pat");
      expect(q.query("SELECT status FROM jobs WHERE id = ?").get(userJob)).toEqual({ status: "failed" });
      expect({ scans, serverClients }).toEqual({ scans: 0, serverClients: 0 });
      enqueueScan(q, repo("np-periodic"), { triggerKind: "periodic" });
      await processJob({ db: q, config, serverClient, runScan: fakeScan, getPat: () => null }, claimNext(q)!);
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
    // чистим очередь этих репо
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'nc')").run();
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
