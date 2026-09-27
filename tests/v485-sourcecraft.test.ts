// Бережный доступ к SourceCraft, метки фаз, переживающие рестарт, честный
// health планировщика. Локальный мок вместо SourceCraft, временные БД,
// фейковые часы через шов `sleep`.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN, loadConfig, worstCaseScanMs, type Config } from "../src/config";
import { getMetaValue, openDb, setMetaValue } from "../src/db";
import { getHealth, SCHED_META, USER_LANE_STALE_MS } from "../src/api/health";
import { makeScClient, parseRetryAfter, retryDelayMs, RETRY_AFTER_CAP_MS, type ScResponse } from "../src/collectors/http";
import { makeAppsecClient } from "../src/collectors/appsec";
import { catalogTick, loopTickIsAlive, newCatalogTickState } from "../src/jobs/scheduler";
import { startMockApi } from "./server-harness";

const HOUR = 60 * 60_000;
const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; config: Config } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v485-b1-"));
  dirs.push(dir);
  const config: Config = {
    ...loadConfig(),
    dataDir: dir,
    scan: { ...DEFAULT_SCAN, catalog: { maxPages: 100 } },
  };
  config.scheduler = { ...config.scheduler, catalogIntervalMs: HOUR, intervalMs: 24 * HOUR, fullRescan: false };
  const db = openDb(config);
  dbs.push(db);
  return { db, config };
}

describe("К8.5.5a: ретрай 429/503 и Retry-After", () => {
  test("Retry-After: секунды и HTTP-дата; мусор — null", () => {
    const now = Date.parse("2026-09-22T10:00:00Z");
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("Tue, 22 Sep 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  test("пауза: Retry-After в пределах потолка; длиннее потолка — повтора нет; без заголовка — бэкофф 1, 2, 4 с", () => {
    expect(retryDelayMs(1500, 0)).toBe(1500);
    expect(retryDelayMs(RETRY_AFTER_CAP_MS + 1, 0)).toBeNull();
    expect([0, 1, 2].map((a) => retryDelayMs(null, a))).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(null, 10)).toBe(RETRY_AFTER_CAP_MS);
  });

  test("503 без заголовка: три повтора с бэкоффом, потом ответ как есть; ретраи не расходуют бюджет", async () => {
    let hits = 0;
    const mock = startMockApi(() => {
      hits++;
      return Response.json({ e: 1 }, { status: 503 });
    });
    try {
      const sleeps: number[] = [];
      const client = makeScClient({ token: "t-503", baseUrl: mock.url, minIntervalMs: 0, maxRequests: 1, sleep: async (ms) => void sleeps.push(ms) });
      const res = await client.get("/repos/o/r");
      expect({ status: res.status, hits, sleeps, count: client.requestCount() }).toEqual({ status: 503, hits: 4, sleeps: [1000, 2000, 4000], count: 1 });
    } finally {
      mock.stop();
    }
  });

  test("Retry-After длиннее потолка: повтора нет, ответ несёт retryAfterMs", async () => {
    let hits = 0;
    const mock = startMockApi(() => {
      hits++;
      return Response.json({ e: 1 }, { status: 429, headers: { "retry-after": "120" } });
    });
    try {
      const client = makeScClient({ token: "t-cap", baseUrl: mock.url, minIntervalMs: 0, sleep: async () => {} });
      const res = await client.get("/repos/o/r");
      expect({ status: res.status, retryAfterMs: res.retryAfterMs, hits }).toEqual({ status: 429, retryAfterMs: 120_000, hits: 1 });
    } finally {
      mock.stop();
    }
  });

  test("AppSec: пауза ретрая 429 — Retry-After, а не фиксированные 600 мс", async () => {
    let hits = 0;
    const mock = startMockApi(() => {
      hits++;
      return hits === 1 ? Response.json({ e: 1 }, { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: true });
    });
    try {
      const sleeps: number[] = [];
      const client = makeAppsecClient({ token: "t-appsec", baseUrl: mock.url, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
      const res = await client.get("/v1/scans/latest", { gitRepo: "x" });
      expect({ status: res.status, attempts: res.attempts, sleeps }).toEqual({ status: 200, attempts: 2, sleeps: [2000] });
    } finally {
      mock.stop();
    }
  });
});

describe("К8.5.5a: общий ритм клиентов одного токена в процессе", () => {
  test("второй клиент того же (хост, токен) ждет интервал; другой токен — не ждет", async () => {
    const mock = startMockApi(() => Response.json({ ok: true }));
    try {
      const waits: Record<string, number[]> = { a: [], b: [], other: [] };
      const mk = (token: string, bucket: string) =>
        makeScClient({ token, baseUrl: mock.url, minIntervalMs: 400, sleep: async (ms) => void waits[bucket]!.push(ms) });
      await mk("rhythm-shared", "a").get("/x");
      await mk("rhythm-shared", "b").get("/x");
      await mk("rhythm-other", "other").get("/x");
      expect({ a: waits.a!.length, bWaited: (waits.b![0] ?? 0) > 300, other: waits.other!.length }).toEqual({ a: 0, bWaited: true, other: 0 });
    } finally {
      mock.stop();
    }
  });

  test("параллельные get одного клиента резервируют разные слоты (http.ts:47 из С10-9)", async () => {
    const mock = startMockApi(() => Response.json({ ok: true }));
    try {
      const waits: number[] = [];
      const client = makeScClient({ token: "rhythm-parallel", baseUrl: mock.url, minIntervalMs: 300, sleep: async (ms) => void waits.push(ms) });
      await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
      waits.sort((x, y) => x - y);
      expect({ n: waits.length, second: (waits[0] ?? 0) > 200, third: (waits[1] ?? 0) > 500 }).toEqual({ n: 2, second: true, third: true });
    } finally {
      mock.stop();
    }
  });
});

/** Фейковый клиент каталога: страницы по одной записи; `failAt` — номер запроса со статусом `status`. */
function pages(n: number, failAt: number | null = null, status = 503) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async get(): Promise<ScResponse> {
        calls++;
        if (failAt !== null && calls === failAt) return { status, json: null, bodyText: "down" };
        const last = calls >= n;
        return {
          status: 200,
          json: { repositories: [{ organization: { slug: "o" }, slug: `r${calls}`, visibility: "public", last_updated: "2026-09-01T00:00:00Z" }], next_page_token: last ? "" : `p${calls + 1}` },
          bodyText: "",
        };
      },
      requestCount: () => calls,
    },
  };
}

describe("К8.5.5b: метки успеха фаз", () => {
  test("после неуспешной ночной фазы рестарт ее повторяет, после успешной — нет; ключ успеха ночной фазы отдельный", async () => {
    const { db, config } = freshDb();
    const T0 = new Date();
    const failing = pages(3, 2);
    const r1 = await catalogTick(db, () => failing.client, config, newCatalogTickState(), { now: T0 });
    expect({ ok: r1?.ok, nightlyAttempt: getMetaValue(db, SCHED_META.nightlyAt), nightlyOkAt: getMetaValue(db, SCHED_META.nightlyOkAt) }).toEqual({
      ok: false,
      nightlyAttempt: T0.toISOString(),
      nightlyOkAt: null,
    });
    // рестарт через 10 минут: ночная фаза не удалась — повторяется
    const retry = pages(3);
    const r2 = await catalogTick(db, () => retry.client, config, newCatalogTickState(), { now: new Date(T0.getTime() + 10 * 60_000) });
    expect(r2?.phases).toEqual({ reconcile: true, nightly: true });
    expect(getMetaValue(db, SCHED_META.nightlyOkAt)).toBe(new Date(T0.getTime() + 10 * 60_000).toISOString());
    // ещё рестарт — обе фазы свежие, обхода нет
    const idle = pages(3);
    expect(await catalogTick(db, () => idle.client, config, newCatalogTickState(), { now: new Date(T0.getTime() + 20 * 60_000) })).toBeNull();
    expect(idle.calls()).toBe(0);
  });
});

describe("К8.5.5c: честный health планировщика", () => {
  test("сбой сверки внутри двух интервалов — не красное; успешная сверка стирает ошибку", async () => {
    const { db, config } = freshDb();
    const now = new Date();
    setMetaValue(db, SCHED_META.reconcileAt, new Date(now.getTime() - 90 * 60_000).toISOString());
    const state = { ...newCatalogTickState(), lastNightlyAt: now };
    await catalogTick(db, () => pages(3, 2).client, config, state, { now });
    expect(getMetaValue(db, SCHED_META.reconcileError)).not.toBeNull();
    expect(getHealth(db, config).reasons.filter((r) => /сверк/.test(r))).toEqual([]);
    const later = new Date(now.getTime() + 2 * HOUR);
    await catalogTick(db, () => pages(3).client, config, state, { now: later });
    expect(getMetaValue(db, SCHED_META.reconcileError)).toBeNull();
  });

  test("нет серверного токена у тика каталога — красная причина; тик с токеном ее снимает", async () => {
    const { db, config } = freshDb();
    await catalogTick(db, () => null, config, newCatalogTickState());
    expect(getHealth(db, config).reasons.some((r) => /серверного токена/.test(r))).toBe(true);
    await catalogTick(db, () => pages(1).client, config, newCatalogTickState());
    expect(getHealth(db, config).reasons.some((r) => /серверного токена/.test(r))).toBe(false);
  });

  test("задание с истекшим лизом и задание дольше худшего бюджета скана — красные причины", () => {
    const { db, config } = freshDb();
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('o', 'r')").run();
    const past = (ms: number) => new Date(Date.now() - ms).toISOString();
    db.query("INSERT INTO jobs (repo_id, status, claimed_at, lease_until, created_at) VALUES (1, 'running', ?, ?, ?)").run(past(60_000), past(1000), past(60_000));
    const h1 = getHealth(db, config);
    expect(h1.reasons.some((r) => /истекшим лизом: 1/.test(r))).toBe(true);
    db.query("UPDATE jobs SET lease_until = ?, claimed_at = ?").run(new Date(Date.now() + 60_000).toISOString(), past(worstCaseScanMs(config.scan) + 60_000));
    const h2 = getHealth(db, config);
    expect({ expired: h2.reasons.some((r) => /истекшим лизом/.test(r)), stuck: h2.reasons.some((r) => /худшего бюджета/.test(r)) }).toEqual({ expired: false, stuck: true });
  });

  test("пользовательская полоса стоит: давняя заявка и нет живой метки user-стороны — красное; свежая метка — нет", () => {
    const { db, config } = freshDb();
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('o', 'r')").run();
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, user_id, created_at) VALUES (1, 'queued', 'user', 7, ?)").run(
      new Date(Date.now() - USER_LANE_STALE_MS - 60_000).toISOString(),
    );
    expect(getHealth(db, config).reasons.some((r) => /пользовательская очередь/.test(r))).toBe(true);
    setMetaValue(db, SCHED_META.userTickAt, new Date().toISOString());
    expect(getHealth(db, config).reasons.some((r) => /пользовательская очередь/.test(r))).toBe(false);
  });

  test("тик busy жив, только пока текущее задание в пределах худшего бюджета скана (С10-3)", () => {
    const { config } = freshDb();
    const worst = worstCaseScanMs(config.scan);
    const now = Date.now();
    expect(loopTickIsAlive("idle", { busy: false }, config, now)).toBe(true);
    expect(loopTickIsAlive("busy", { busy: true }, config, now)).toBe(false);
    expect(loopTickIsAlive("busy", { busy: true, currentSince: now - 60_000 }, config, now)).toBe(true);
    expect(loopTickIsAlive("busy", { busy: true, currentSince: now - worst - 1 }, config, now)).toBe(false);
  });
});
