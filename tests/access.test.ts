// access.test.ts — В4.1/К2: резолвер доступа зрителя к каналам карточки.
// Все пять ChannelAccess из ответов 200/403/404/401/429/0; кэш (повтор без
// запроса, TTL, check-failed не кэшируется, сброс по смене PAT); аноним и
// зритель без PAT — ноль запросов; один REST repo-GET на показ. Сети нет:
// REST и AppSec — фейки со счётчиками.
import { describe, expect, test } from "bun:test";
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

function fake(ttlMs = 15 * 60_000): Fake {
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
    deps: { restClient, appsecClient, cache: makeAccessCache(ttlMs), now: () => clock.now },
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
      [{ runs: 404, appsec: 404 }, { cicd: "denied", appsec: "denied" }],
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

  test("check-failed не кэшируется: следующий показ проверяет снова", async () => {
    const f = fake();
    f.set({ runs: 503, repo: 200, appsec: 429 });
    const r1 = await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(r1).toMatchObject({ cicd: "check-failed", appsec: "check-failed" });
    f.set({ runs: 200, appsec: 200 });
    const r2 = await resolveAccess(f.deps, viewer("pat"), PUBLIC);
    expect(r2).toMatchObject({ cicd: "granted", appsec: "granted" });
    expect(f.rest.filter((p) => p.includes("cicd/runs"))).toHaveLength(2);
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
