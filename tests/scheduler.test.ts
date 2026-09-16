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
  enqueueScan,
  evictRepo,
  finishJob,
  nightlyCatalog,
  processJob,
  returnRepo,
  type ClaimedJob,
} from "../src/jobs/scheduler";
import { upsertRepo, type ScanDeps, type ScanResult } from "../src/jobs/runner";
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
    const j2 = enqueueScan(db, b, { triggerKind: "periodic" });
    const now = new Date("2026-09-18T00:00:00Z");
    const first = claimNext(db, now, 60_000);
    expect(first?.slug).toBe("cl/a");
    expect(first?.userId).toBeNull();
    // лиз поставлен и живёт: строка больше не заявляется
    expect(claimNext(db, new Date(now.getTime() + 30_000), 60_000)?.slug).toBe("cl/b");
    expect(claimNext(db, new Date(now.getTime() + 30_000), 60_000)).toBeNull();
    // истёкший лиз (упавший воркер) → job снова доступна
    const revived = claimNext(db, new Date(now.getTime() + 120_000), 60_000);
    expect(revived?.id).toBe(j1);
    finishJob(db, j1, "done");
    finishJob(db, j2, "done");
  });

  test("юзерская заявка встаёт вперёд периодической", () => {
    const c = seedRepo("cl", "c");
    const d = seedRepo("cl", "d");
    enqueueScan(db, c, { triggerKind: "periodic" });
    const userId = (db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-1', 'u', '2026', '2026')").run(), Number((db.query("SELECT id FROM users WHERE ya_id = 'ya-1'").get() as { id: number }).id));
    const userJob = enqueueScan(db, d, { userId, triggerKind: "user" });
    const claimed = claimNext(db);
    expect(claimed?.id).toBe(userJob);
    expect(claimed?.userId).toBe(userId);
    finishJob(db, claimed!.id, "done");
    const periodic = claimNext(db);
    expect(periodic?.slug).toBe("cl/c");
    finishJob(db, periodic!.id, "done");
    // чистим за собой: дальше каталог-тесты видят чистую таблицу repos
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
  });

  test("finishJob по id: очередь допускает несколько строк одного репо", () => {
    const e = seedRepo("cl", "e");
    const j1 = enqueueScan(db, e, {});
    const j2 = enqueueScan(db, e, { triggerKind: "user" });
    expect(j1).not.toBe(j2);
    finishJob(db, j1, "done");
    expect((db.query("SELECT status FROM jobs WHERE id = ?").get(j2) as { status: string }).status).toBe("queued");
    finishJob(db, j2, "failed");
    db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'cl')").run();
    db.query("DELETE FROM repos WHERE org_slug = 'cl'").run();
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
    const out = await processJob(deps, { id: 1, repoId: g, slug: "pj/gone-repo", userId: null, triggerKind: "periodic" });
    expect(out).toBe("gone");
    const row = db.query("SELECT rating_active, evict_reason FROM repos WHERE id = ?").get(g) as { rating_active: number; evict_reason: string };
    expect(row.rating_active).toBe(0);
    expect(row.evict_reason).toContain("404/403");
    returnRepo(db, g);
    // cicd-403: repoAccess ok (репо-GET прошёл) — эвикции нет
    const s = seedRepo("pj", "cicd-403");
    const { deps: d2 } = fakeWorker(() => ({ repoAccess: "ok" }));
    const out2 = await processJob(d2, { id: 2, repoId: s, slug: "pj/cicd-403", userId: null, triggerKind: "periodic" });
    expect(out2).not.toBe("gone");
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(s) as { rating_active: number }).rating_active).toBe(1);
  });

  test("заявка юзера: автор и PAT пробрасываются в runScan; без PAT — null", async () => {
    db.query("INSERT OR REPLACE INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-2', 'u2', '2026', '2026')").run();
    const uid = (db.query("SELECT id FROM users WHERE ya_id = 'ya-2'").get() as { id: number }).id;
    const { deps, calls } = fakeWorker(() => ({ repoAccess: "ok" }));
    const job: ClaimedJob = { id: 3, repoId: 1, slug: "pj/own", userId: uid, triggerKind: "user" };
    // PAT нет (getPat реальный, APP_SECRET инъектирован в конфиг) → userToken null
    await processJob(deps, job);
    expect(calls[0]!.opts["userId"]).toBe(uid);
    expect(calls[0]!.opts["userToken"]).toBeNull();
    // сохраняем PAT через шов настроек окружения — проверяем проброс
    const withPat = { ...deps, getPat: () => "user-pat-value" };
    calls.length = 0;
    await processJob(withPat, job);
    expect(calls[0]!.opts["userToken"]).toBe("user-pat-value");
  });

  test("H1: repo-GET 403/404 у заявки юзера НЕ эвиктирует; у периодики — эвиктирует", async () => {
    const r = seedRepo("pj", "popular");
    const { deps } = fakeWorker(() => ({ repoAccess: "gone" }));
    const out = await processJob({ ...deps, getPat: () => "narrow-pat" }, { id: 4, repoId: r, slug: "pj/popular", userId: 1, triggerKind: "user" });
    expect(out).not.toBe("gone");
    expect((db.query("SELECT rating_active FROM repos WHERE id = ?").get(r) as { rating_active: number }).rating_active).toBe(1);
    const out2 = await processJob(deps, { id: 5, repoId: r, slug: "pj/popular", userId: null, triggerKind: "periodic" });
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
      await processJob(w, { id: 6, repoId: 1, slug: "o/r", userId: null, triggerKind: "periodic" });
      await processJob(w, { id: 7, repoId: 1, slug: "o/r", userId: null, triggerKind: "periodic" });
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
