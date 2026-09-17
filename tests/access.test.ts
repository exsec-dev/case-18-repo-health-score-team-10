// access.test.ts — В4.1/К2: резолвер доступа зрителя к каналам карточки.
// Все пять ChannelAccess из ответов 200/403/404/401/429/0; кэш (повтор без
// запроса, TTL, check-failed не кэшируется, сброс по смене PAT); аноним и
// зритель без PAT — ноль запросов; один REST repo-GET на показ. Сети нет:
// REST и AppSec — фейки со счётчиками. В4.1-fix (Ф1.4, Ф1.6, Ф1.12): AppSec
// 404 при repo-GET 200 → granted; check-failed кэшируется на failedTtlMs;
// предел кэша; склейка одновременных проверок; поколение PAT; таймаут REST.
import { describe, expect, test } from "bun:test";
import { makeScClient } from "../src/collectors/http";
import type { AppsecClient } from "../src/collectors/appsec";
import type { ScClient } from "../src/collectors/http";
import {
  accessFromStatus,
  makeAccessCache,
  resolveAccess,
  type AccessDeps,
  type AccessRepo,
  type ChannelAccess,
} from "../src/auth/access";

interface Fake {
  deps: AccessDeps;
  rest: string[];
  appsec: string[];
  set: (s: Partial<{ runs: number; repo: number; appsec: number; repoJson: unknown }>) => void;
  clock: { now: number };
}

function fake(ttlMs = 15 * 60_000, cacheOpts: { failedTtlMs?: number; maxEntries?: number } = {}): Fake {
  const state = { runs: 200, repo: 200, appsec: 200, repoJson: { id: "gitrepo-1" } as unknown };
  const rest: string[] = [];
  const appsec: string[] = [];
  const clock = { now: 1_000_000 };
  const restClient = (pat: string): ScClient => ({
    async get(path: string) {
      rest.push(`${pat}:${path}`);
      if (path.endsWith("/cicd/runs?page_size=1")) return { status: state.runs, json: null, bodyText: "" };
      return { status: state.repo, json: state.repo === 200 ? state.repoJson : null, bodyText: "" };
    },
    requestCount: () => rest.length,
  });
  const appsecClient = (pat: string): AppsecClient => ({
    async get(path: string, params: Record<string, string>) {
      appsec.push(`${pat}:${path}?gitRepo=${params["gitRepo"]}`);
      return { status: state.appsec, json: null };
    },
    requestCount: () => appsec.length,
  });
  return {
    deps: { restClient, appsecClient, cache: makeAccessCache(ttlMs, cacheOpts), now: () => clock.now },
    rest,
    appsec,
    clock,
    set: (s) => Object.assign(state, s),
  };
}

const PUBLIC: AccessRepo = { id: 1, org: "acme", repo: "app", visibility: "public" };
const PRIVATE: AccessRepo = { id: 2, org: "acme", repo: "secret", visibility: "private" };
const viewer = (pat: string | null, userId = 7) => ({ userId, pat });

describe("семантика ответа (К2)", () => {
  test("200 → granted; 403/404 → denied; 401 → pat-expired; 0/429/5xx → check-failed", () => {
    expect(accessFromStatus(200)).toBe("granted");
    expect(accessFromStatus(403)).toBe("denied");
    expect(accessFromStatus(404)).toBe("denied");
    expect(accessFromStatus(401)).toBe("pat-expired");
    for (const s of [0, 429, 500, 502, 503]) expect(accessFromStatus(s)).toBe("check-failed");
  });

  test("аноним и зритель без PAT → no-pat, ни одного запроса", async () => {
    const f = fake();
    expect(await resolveAccess(f.deps, null, PUBLIC)).toEqual({ cicd: "no-pat", appsec: "no-pat", repo: "no-pat" });
    expect(await resolveAccess(f.deps, viewer(null), PRIVATE)).toEqual({ cicd: "no-pat", appsec: "no-pat", repo: "no-pat" });
    expect(f.rest).toEqual([]);
    expect(f.appsec).toEqual([]);
  });

  test("публичный репо: CI — cicd/runs?page_size=1, Security — repo-GET → id → scans/latest", async () => {
    const f = fake();
    const r = await resolveAccess(f.deps, viewer("pat-a"), PUBLIC);
    expect(r).toEqual({ cicd: "granted", appsec: "granted", repo: "granted" });
    expect(f.rest).toEqual(["pat-a:/repos/acme/app/cicd/runs?page_size=1", "pat-a:/repos/acme/app"]);
    expect(f.appsec).toEqual(["pat-a:/v1/scans/latest?gitRepo=gitrepo-1"]);
  });

  test("все пять состояний по каналам из ответов платформы", async () => {
    const cases: [Partial<{ runs: number; repo: number; appsec: number }>, { cicd: ChannelAccess; appsec: ChannelAccess }][] = [
      [{ runs: 403, appsec: 403 }, { cicd: "denied", appsec: "denied" }],
      // Ф1.4: AppSec 404 при repo-GET 200 — «скана ещё нет», доступ есть
      [{ runs: 404, appsec: 404 }, { cicd: "denied", appsec: "granted" }],
      [{ runs: 401, repo: 401 }, { cicd: "pat-expired", appsec: "pat-expired" }],
      [{ runs: 429, appsec: 429 }, { cicd: "check-failed", appsec: "check-failed" }],
      [{ runs: 0, repo: 0 }, { cicd: "check-failed", appsec: "check-failed" }],
      [{ runs: 200, appsec: 403 }, { cicd: "granted", appsec: "denied" }],
      [{ runs: 403, appsec: 200 }, { cicd: "denied", appsec: "granted" }],
    ];
    for (const [state, expected] of cases) {
      const f = fake();
      f.set(state);
      const r = await resolveAccess(f.deps, viewer("pat"), PUBLIC);
      expect({ cicd: r.cicd, appsec: r.appsec }).toEqual(expected);
    }
  });

  test("repo-GET 200 без id → Security check-failed (не знание о правах)", async () => {
    const f = fake();
    f.set({ repoJson: { name: "x" } });
    expect((await resolveAccess(f.deps, viewer("pat"), PUBLIC)).appsec).toBe("check-failed");
    expect(f.appsec).toEqual([]);
  });

  test("приватный репо: один repo-GET на показ для repo и id AppSec; без доступа — каналы закрыты без запросов", async () => {
    const f = fake();
    expect(await resolveAccess(f.deps, viewer("pat"), PRIVATE)).toEqual({ cicd: "granted", appsec: "granted", repo: "granted" });
    expect(f.rest.filter((p) => p.endsWith("/repos/acme/secret"))).toHaveLength(1);
    const g = fake();
    g.set({ repo: 404 });
    expect(await resolveAccess(g.deps, viewer("pat"), PRIVATE)).toEqual({ cicd: "denied", appsec: "denied", repo: "denied" });
    expect(g.rest).toEqual(["pat:/repos/acme/secret"]);
    expect(g.appsec).toEqual([]);
  });
});

describe("кэш (user, repo, channel)", () => {
  test("повтор в пределах TTL — без запросов; TTL истёк — запросы снова", async () => {
    const f = fake(60_000);
    await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    const n = f.rest.length + f.appsec.length;
    await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(f.rest.length + f.appsec.length).toBe(n);
    f.clock.now += 60_001;
    await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(f.rest.length + f.appsec.length).toBe(2 * n);
  });

  test("check-failed кэшируется на failedTtlMs (Ф1.6), затем проверка снова", async () => {
    const f = fake(15 * 60_000, { failedTtlMs: 60_000 });
    f.set({ runs: 503, repo: 200, appsec: 429 });
    const r1 = await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(r1).toMatchObject({ cicd: "check-failed", appsec: "check-failed" });
    f.set({ runs: 200, appsec: 200 });
    // в пределах 60 с — сбой из кэша, платформу не дёргаем
    expect(await resolveAccess(f.deps, viewer("pat"), PUBLIC)).toMatchObject({ cicd: "check-failed", appsec: "check-failed" });
    expect(f.rest.filter((p) => p.includes("cicd/runs"))).toHaveLength(1);
    f.clock.now += 60_001;
    const r2 = await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(r2).toMatchObject({ cicd: "granted", appsec: "granted" });
    expect(f.rest.filter((p) => p.includes("cicd/runs"))).toHaveLength(2);
  });

  test("предел кэша: сверх maxEntries вытесняются старейшие записи", async () => {
    const f = fake(15 * 60_000, { maxEntries: 4 });
    const repo = (id: number): AccessRepo => ({ id, org: "acme", repo: `r${id}`, visibility: "public" });
    await resolveAccess(f.deps, viewer("pat"), repo(1)); // записи cicd, appsec
    await resolveAccess(f.deps, viewer("pat"), repo(2));
    await resolveAccess(f.deps, viewer("pat"), repo(3)); // вытесняет записи repo 1
    expect(f.deps.cache.size()).toBe(4);
    const before = f.rest.length;
    await resolveAccess(f.deps, viewer("pat"), repo(3)); // свежие — из кэша
    expect(f.rest.length).toBe(before);
    await resolveAccess(f.deps, viewer("pat"), repo(1)); // вытеснены — снова запросы
    expect(f.rest.length).toBeGreaterThan(before);
  });

  test("одновременные показы одному зрителю — одна проверка (склейка in-flight)", async () => {
    const f = fake();
    const results = await Promise.all(Array.from({ length: 10 }, () => resolveAccess(f.deps, viewer("pat"), PUBLIC)));
    expect(results.every((r) => r.cicd === "granted" && r.appsec === "granted")).toBe(true);
    expect(f.rest).toHaveLength(2);
    expect(f.appsec).toHaveLength(1);
    expect(f.deps.cache.inflight.size).toBe(0);
  });

  test("поколение PAT (Ф1.12): проверка старым PAT, завершившаяся после смены PAT, в кэш не пишется", async () => {
    const f = fake();
    f.set({ runs: 403, appsec: 403 });
    const pending = resolveAccess(f.deps, viewer("old-pat", 7), PUBLIC); // стартовала до смены
    f.deps.cache.clearUser(7); // PUT /api/me/pat
    expect((await pending).cicd).toBe("denied");
    f.set({ runs: 200, appsec: 200 });
    expect(await resolveAccess(f.deps, viewer("new-pat", 7), PUBLIC)).toMatchObject({ cicd: "granted", appsec: "granted" });
    expect(f.deps.cache.generation(7)).toBe(1);
  });

  test("denied кэшируется; смена PAT (clearUser) сбрасывает записи юзера, чужие остаются", async () => {
    const f = fake();
    f.set({ runs: 403, appsec: 403 });
    await resolveAccess(f.deps, viewer("old-pat", 7), PUBLIC);
    await resolveAccess(f.deps, viewer("other", 8), PUBLIC);
    f.set({ runs: 200, appsec: 200 });
    expect((await resolveAccess(f.deps, viewer("new-pat", 7), PUBLIC)).cicd).toBe("denied"); // кэш
    f.deps.cache.clearUser(7);
    const before = f.rest.length;
    expect(await resolveAccess(f.deps, viewer("new-pat", 7), PUBLIC)).toMatchObject({ cicd: "granted", appsec: "granted" });
    expect(f.rest.length).toBeGreaterThan(before);
    // юзер 8 не сброшен — всё ещё кэш denied
    expect((await resolveAccess(f.deps, viewer("other", 8), PUBLIC)).cicd).toBe("denied");
  });
});

describe("таймаут REST-клиента (Ф1.6)", () => {
  test("зависший ответ платформы → status 0 по таймауту", async () => {
    const hang = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => { await Bun.sleep(2_000); return Response.json({}); } });
    try {
      const client = makeScClient({ token: null, baseUrl: `http://127.0.0.1:${hang.port}`, minIntervalMs: 0, timeoutMs: 100 });
      const t0 = Date.now();
      const res = await client.get("/repos/acme/app");
      expect(res.status).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1_500);
    } finally {
      hang.stop(true);
    }
  });
});
