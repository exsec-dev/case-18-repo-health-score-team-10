// audit-v485-repro.test.ts — репро-трипвайры вехи В4.8.5, ступень 3 (блок Б0).
// Закон вехи: reports/2026-09-21-m485-plan.md, ревизия 3 (раздел 4а —
// утвержденные контракты); дефекты и репро ступени 1 —
// reports/2026-09-22-m485-scenarios.md (раздел 2) и
// reports/m485-stage1-worker-report.md (приложение А); одноразовый промпт
// workers/V4.8.5-stage3-oneshot.md; решения владельца — TASK.md §2.
//
// Механика — как в audit-v47-repro.test.ts: находка стоит под обёрткой
// `repro` — в обычном прогоне это `test.failing` (набор зелёный), под
// AUDIT_STRICT=1 — обычный `test`, то есть красный, пока находка не закрыта.
// Закрытая находка выходит из-под обёртки в закрывшем её блоке, утверждение
// при этом НЕ меняется. В конце файла — strict-самопроверка «ни одной находки
// под repro».
//
// Все находки — поведенческие: временные БД (`mkdtemp`), настоящий сервер
// харнесса (`spawnServer`) с локальным моком вместо SourceCraft/AppSec,
// настоящие функции планировщика. Живых запросов нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN, loadConfig, type Config } from "../src/config";
import { getMetaValue, openDb, setMetaValue } from "../src/db";
import { getHealth, SCHED_META } from "../src/api/health";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { storePat } from "../src/auth/pat";
import { makeScClient, type ScClientOptions, type ScResponse } from "../src/collectors/http";
import {
  catalogTick,
  claimNext,
  closeOwnRunningScans,
  enqueueScan,
  newCatalogTickState,
  returnOwnRunningJobs,
  startWorkerLoop,
  workerTick,
} from "../src/jobs/scheduler";
import { needsRescore, rescoreBatchByCursor } from "../src/score/rescore";
import { seedRepo, seedScan, type ApiTestDb } from "./api-fixtures";
import { healthyFacts } from "./score-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const HOUR = 60 * 60_000;

function freshDb(prefix: string): { db: Database; dir: string; config: Config; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const config = { ...loadConfig(), dataDir: dir };
  const db = openDb(config);
  return { db, dir, config, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const catalogConfig = (base: Config): Config => ({
  ...base,
  scan: { ...DEFAULT_SCAN, catalog: { maxPages: 100 } },
  scheduler: { ...base.scheduler, catalogIntervalMs: HOUR, intervalMs: 24 * HOUR, fullRescan: false },
});

const repoOf = (slug: string) => ({ organization: { slug: "m485" }, slug, name: slug, visibility: "public", last_updated: "2026-09-10T00:00:00Z" });

/** Фейковый клиент каталога: `pages` страниц, на `failAt`-м запросе — `status`. */
function pagedClient(pages: number, failAt: number | null, status = 429) {
  let n = 0;
  return {
    calls: () => n,
    client: {
      async get(_path: string): Promise<ScResponse> {
        n++;
        if (failAt !== null && n === failAt) return { status, json: { error_code: "TooManyRequests" }, bodyText: '{"error_code":"TooManyRequests"}' };
        const last = n >= pages;
        return { status: 200, json: { repositories: [repoOf(`r${n}`)], next_page_token: last ? "" : `p${n + 1}` }, bodyText: "" };
      },
      requestCount: () => n,
    },
  };
}

// ---------------------------------------------------------------------------
// С8 — бережный доступ к SourceCraft и планировщик (К8.5.5a/b/c, К8.5.2b)
// ---------------------------------------------------------------------------

describe("С8: каталог, метки фаз, health, сироты", () => {
  test("С8-1: 429 с Retry-After на странице 2 не рвет обход — клиент ждет и повторяет ту же страницу; ретрай не съедает бюджет обхода", async () => {
    const t = freshDb("rh-v485-c81-");
    let page2Hits = 0;
    const mock = startMockApi((_req, url) => {
      if (url.pathname !== "/repos") return null;
      const token = url.searchParams.get("page_token");
      if (token === null) return Response.json({ repositories: [repoOf("a")], next_page_token: "p2" });
      if (token === "p2") {
        page2Hits++;
        if (page2Hits === 1) return Response.json({ error_code: "TooManyRequests" }, { status: 429, headers: { "retry-after": "1" } });
        return Response.json({ repositories: [repoOf("b")], next_page_token: "p3" });
      }
      return Response.json({ repositories: [repoOf("c")], next_page_token: "" });
    });
    try {
      const sleeps: number[] = [];
      // шов фейковых часов (К8.5.5a): на базе поля нет — опция молча игнорируется
      const client = makeScClient({
        token: "server-token",
        baseUrl: mock.url,
        minIntervalMs: 0,
        maxRequests: 3,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      } as ScClientOptions);
      const r = await catalogTick(t.db, () => client, catalogConfig(t.config), newCatalogTickState());
      expect({ ok: r?.ok, complete: r?.catalogComplete, pages: r?.pages, waitedRetryAfter: sleeps.some((ms) => ms >= 1000) }).toEqual({
        ok: true,
        complete: true,
        pages: 3,
        waitedRetryAfter: true,
      });
    } finally {
      mock.stop();
      t.close();
    }
  });

  test("С8-2: рестарт внутри интервала не повторяет обход — метки успеха фаз читаются из meta", async () => {
    const t = freshDb("rh-v485-c82-");
    try {
      const cfg = catalogConfig(t.config);
      const T0 = new Date();
      const a = pagedClient(3, null);
      const r1 = await catalogTick(t.db, () => a.client, cfg, newCatalogTickState(), { now: T0 });
      expect(r1?.phases).toEqual({ reconcile: true, nightly: true });
      // «рестарт»: процесс строит новое состояние в памяти
      const b = pagedClient(3, null);
      const r2 = await catalogTick(t.db, () => b.client, cfg, newCatalogTickState(), { now: new Date(T0.getTime() + 10 * 60_000) });
      expect({ calls: b.calls(), result: r2 }).toEqual({ calls: 0, result: null });
    } finally {
      t.close();
    }
  });

  test("С8-4: сбой часовой сверки виден — health краснеет, когда сверка не удавалась дольше двух интервалов", async () => {
    const t = freshDb("rh-v485-c84-");
    try {
      const cfg = catalogConfig(t.config);
      const now = new Date();
      // последняя УСПЕШНАЯ сверка — 3 часа назад; ночная фаза не должна
      setMetaValue(t.db, SCHED_META.reconcileAt, new Date(now.getTime() - 3 * HOUR).toISOString());
      const state = { ...newCatalogTickState(), lastReconcileAt: new Date(now.getTime() - 3 * HOUR), lastNightlyAt: now };
      const c = pagedClient(5, 2, 503);
      const r = await catalogTick(t.db, () => c.client, cfg, state, { now });
      expect(r?.ok).toBe(false);
      const health = getHealth(t.db, cfg);
      expect({ ok: health.ok, reconcileReason: health.reasons.some((x) => /сверк/i.test(x)) }).toEqual({ ok: false, reconcileReason: true });
    } finally {
      t.close();
    }
  });

  repro("С8-9: жесткое завершение — лиз 10 мин, перехват после лиза закрывает прежний running-скан в той же транзакции", () => {
    const saved = process.env.SCHEDULER_LEASE_MS;
    process.env.SCHEDULER_LEASE_MS = "";
    const t = freshDb("rh-v485-c89-");
    try {
      const leaseMs = loadConfig().scheduler.leaseMs;
      const repoId = seedRepo({ db: t.db, close: () => {} }, { org: "m485", repo: "orphan" });
      const past = new Date(Date.now() - 20 * 60_000);
      // заявка «убитого» процесса: running, лиз истек 5 минут назад; скан того же (репо, автор) — running
      t.db
        .query("INSERT INTO jobs (repo_id, status, trigger_kind, attempts, claimed_at, lease_until, created_at) VALUES (?, 'running', 'periodic', 1, ?, ?, ?)")
        .run(repoId, past.toISOString(), new Date(Date.now() - 5 * 60_000).toISOString(), past.toISOString());
      const scanId = seedScan({ db: t.db, close: () => {} }, repoId, { status: "running", finishedAt: null, startedAt: past.toISOString() });
      const job = claimNext(t.db, new Date(), leaseMs, { queue: "rating" });
      const scan = t.db.query("SELECT status, status_detail FROM scans WHERE id = ?").get(scanId);
      expect({ leaseMs, claimed: job !== null, oldScan: scan }).toEqual({
        leaseMs: 10 * 60_000,
        claimed: true,
        oldScan: { status: "bad", status_detail: "orphaned" },
      });
    } finally {
      if (saved === undefined) delete process.env.SCHEDULER_LEASE_MS;
      else process.env.SCHEDULER_LEASE_MS = saved;
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// С4-5 — штатная остановка сжигает попытки (К8.5.2a)
// ---------------------------------------------------------------------------

describe("С4-5: штатная остановка", () => {
  repro("3 штатные остановки во время одного скана не сжигают попытки: задание снова в очереди с attempts 0, 4-й запуск доводит до done", async () => {
    const t = freshDb("rh-v485-c45-");
    try {
      t.db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('m485', 'own')").run();
      const repoId = (t.db.query("SELECT id FROM repos WHERE org_slug='m485'").get() as { id: number }).id;
      const userId = upsertUser(t.db, "ya-c45", "c45");
      const jobId = enqueueScan(t.db, repoId, { userId, triggerKind: "user" });
      const config = { ...t.config, auth: { ...t.config.auth, appSecret: "m485-repro-secret-000000000000000000" } };
      for (let cycle = 1; cycle <= 3; cycle++) {
        let release: () => void = () => {};
        const gate = new Promise<void>((res) => (release = res));
        const hang = (async () => {
          t.db
            .query("INSERT INTO scans (repo_id, started_at, status, public_status, trigger, user_id) VALUES (?, ?, 'running', 'running', 'user', ?)")
            .run(repoId, new Date().toISOString(), userId);
          await gate;
          return { scanId: 0, repoId, status: "ok", repoAccess: "ok", channels: { git: "ok", rest: "ok", appsec: "ok" } };
        }) as never;
        const tick = workerTick({ db: t.db, config, serverClient: () => null, runScan: hang, getPat: () => "pat" }, ["user"], { busy: false });
        await Bun.sleep(50);
        closeOwnRunningScans(t.db); // порядок SIGTERM: сначала сканы,
        returnOwnRunningJobs(t.db); // затем заявки
        release();
        await tick;
      }
      const afterStops = t.db.query("SELECT status, attempts FROM jobs WHERE id = ?").get(jobId);
      const done = (async () => ({ scanId: 0, repoId, status: "ok", repoAccess: "ok", channels: { git: "ok", rest: "ok", appsec: "ok" } })) as never;
      const out = await workerTick({ db: t.db, config, serverClient: () => null, runScan: done, getPat: () => "pat" }, ["user"], { busy: false });
      const job = t.db.query("SELECT status, attempts, error FROM jobs WHERE id = ?").get(jobId);
      expect({ afterStops, out, job }).toEqual({
        afterStops: { status: "queued", attempts: 0 },
        out: "done",
        job: { status: "done", attempts: 1, error: null },
      });
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// С10 — итог скана и метка тика (К8.5.12, К8.5.5c)
// ---------------------------------------------------------------------------

describe("С10: скан без оценки и метка тика", () => {
  repro("С10-1 (сценарий A из А.7): проход пересчета закончился во время скана — после завершения скан все равно получает оценку", () => {
    const t = freshDb("rh-v485-c101-");
    try {
      const api: ApiTestDb = { db: t.db, close: () => {} };
      const repoId = seedRepo(api, { org: "o", repo: "r" });
      const done = seedScan(api, repoId, { facts: healthyFacts(), ratingEligible: false });
      const running = seedScan(api, repoId, { status: "running", finishedAt: null, facts: [], ratingEligible: false });
      let out;
      do {
        out = rescoreBatchByCursor(t.db);
      } while (!out.done);
      // скан завершается без своей оценки (упавший или не дошедший скор-хук)
      t.db
        .query("INSERT INTO facts (scan_id, category, key, value, status, source, collected_at) SELECT ?, category, key, value, status, source, collected_at FROM facts WHERE scan_id = ?")
        .run(running, done);
      t.db.query("UPDATE scans SET status='ok', public_status='ok', finished_at=? WHERE id=?").run(new Date().toISOString(), running);
      const pending = needsRescore(t.db);
      rescoreBatchByCursor(t.db);
      const scores = (t.db.query("SELECT COUNT(*) AS c FROM scores WHERE scan_id = ?").get(running) as { c: number }).c;
      expect({ pending, scores }).toEqual({ pending: true, scores: 1 });
    } finally {
      t.close();
    }
  });

  test("С10-3: метка тика планировщика не пишется на тике busy (зависшее задание не выглядит живым)", async () => {
    const t = freshDb("rh-v485-c103-");
    try {
      const stop = startWorkerLoop({ db: t.db, config: t.config, serverClient: () => null }, { rating: true }, 20, {
        tick: async () => "busy",
      });
      await Bun.sleep(200);
      stop();
      await Bun.sleep(30);
      expect(getMetaValue(t.db, SCHED_META.tickAt)).toBeNull();
    } finally {
      t.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP: настоящий сервер харнесса (С2-1, С2-3, С3-1, С6-1, С4-11)
// ---------------------------------------------------------------------------

const SECRET = "v485-repro-secret-0123456789abcdef-xyz";
const dir = mkdtempSync(join(tmpdir(), "rh-v485-http-"));
let userMode: "ok" | "503" = "ok";
let repoMode: "ok" | "503" = "ok";
const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return userMode === "503" ? Response.json({ error: "x" }, { status: 503 }) : Response.json({ username: "probe" });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (p === "/v1/scans/latest") return Response.json({ error: "no scan" }, { status: 404 });
  // own/*: приватные репозитории зрителя; foreign/pub — чужой публичный (CI 403, AppSec 404)
  const runs = p.match(/^\/repos\/([^/]+)\/([^/]+)\/cicd\/runs$/);
  if (runs) {
    if (repoMode === "503") return Response.json({ e: 1 }, { status: 503 });
    return runs[1] === "foreign" ? Response.json({ error: "denied" }, { status: 403 }) : Response.json({ runs: [] });
  }
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    if (repoMode === "503") return Response.json({ e: 1 }, { status: 503 });
    if (repo[1] === "foreign") return Response.json({ name: repo[2], visibility: "public", id: `gid-${repo[2]}` });
    return Response.json({ name: repo[2], visibility: "private" });
  }
  return null;
});
let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  for (const name of ["probe", "star", "owner", "del", "stranger"]) {
    const id = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, id);
    if (name !== "probe") storePat(db, SECRET, id, `pat-${name}-0000000`);
    if (name === "owner" || name === "del") {
      db.query("INSERT OR IGNORE INTO repos (org_slug, repo_slug, title, visibility, rating_active) VALUES ('own', ?, 'Secret title', 'private', 0)").run(`${name}-priv`);
      db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access, last_checked_at) VALUES (?, 'own', ?, ?, ?, ?)").run(
        id,
        `${name}-priv`,
        new Date().toISOString(),
        JSON.stringify({ clone: true, visibility: "private", ci: true, appsec: null, own: true }),
        new Date().toISOString(),
      );
    }
  }
  db.close();
  // роль rating: пользовательскую полосу никто не разбирает — постановки стабильны
  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating" } });
}, 90_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...((init.headers as Record<string, string>) ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` },
});
const at = (path: string): string => `${server!.base}${path}`;

describe("HTTP: права, токен и запуск анализа", () => {
  repro("С2-1: сбой SourceCraft на пробе токена — не «отклонил токен» и не списывает окно проб", async () => {
    const put = () =>
      fetch(at("/api/me/pat"), as("probe", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "tok-probe-0001" }) }));
    userMode = "503";
    const first = await put();
    const firstCode = ((await first.json()) as { error?: { code?: string } }).error?.code ?? null;
    for (let i = 0; i < 10; i++) await put();
    userMode = "ok";
    const after = await put();
    expect({ rejectedAsBadToken: firstCode === "bad_token", afterFailures: after.status }).toEqual({ rejectedAsBadToken: false, afterFailures: 200 });
  }, 60_000);

  repro("С3-1: добавление в избранное само проверяет права, а сбой SourceCraft при повторной проверке их не затирает", async () => {
    repoMode = "ok";
    await fetch(at("/api/me/favorites/own/star-priv"), as("star", { method: "PUT" }));
    const read = async () =>
      ((await (await fetch(at("/api/me/favorites"), as("star"))).json()) as { entries: { org: string; repo: string; access: { clone: boolean } | null }[] }).entries.find(
        (e) => e.repo === "star-priv",
      )?.access ?? null;
    const afterAdd = await read();
    repoMode = "503";
    await fetch(at("/api/me/favorites/own/star-priv"), as("star", { method: "PUT" }));
    repoMode = "ok";
    const afterFailure = await read();
    expect({ afterAdd: afterAdd?.clone ?? null, afterFailure: afterFailure?.clone ?? null }).toEqual({ afterAdd: true, afterFailure: true });
  }, 60_000);

  repro("С6-1: владелец своей приватной карточки при сбое SourceCraft не получает «не найден»", async () => {
    repoMode = "503";
    const res = await fetch(at("/api/repos/own/owner-priv"), as("owner"));
    repoMode = "ok";
    const body = (await res.json()) as { error?: { code?: string } };
    expect({ status: res.status, code: body.error?.code ?? null }).toEqual({ status: 503, code: "check_failed" });
  }, 60_000);

  repro("С2-3: удаление токена гасит сохраненные права — строка приватного без меты", async () => {
    const del = await fetch(at("/api/me/pat"), as("del", { method: "DELETE" }));
    const repos = (await (await fetch(at("/api/me/repos"), as("del"))).json()) as { entries: { repo: string; mayRead: boolean; title: string | null }[] };
    const row = repos.entries.find((e) => e.repo === "del-priv");
    expect({ del: del.status, mayRead: row?.mayRead, title: row?.title }).toEqual({ del: 200, mayRead: false, title: null });
  }, 60_000);

  repro("С4-11: POST /scan чужого публичного репозитория — отказ с кодом, задание не ставится", async () => {
    repoMode = "ok";
    const res = await fetch(at("/api/me/repos/foreign/pub/scan"), as("stranger", { method: "POST" }));
    const body = (await res.json()) as { error?: { code?: string } };
    const jobs = (await (await fetch(at("/api/me/jobs"), as("stranger"))).json()) as { active: unknown[] };
    expect({ status: res.status, code: body.error?.code ?? null, active: jobs.active.length }).toEqual({ status: 403, code: "not_own", active: 0 });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без неё «AUDIT_STRICT=1 зелёный» — тавтология.
// На Б0-коммите этот тест красный вместе с находками.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const self = Bun.file(import.meta.path);
    return self.text().then((text) => {
      const parked = text.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
      expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
    });
  });
}
