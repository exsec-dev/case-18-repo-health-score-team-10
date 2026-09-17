// routes-me.test.ts — В4.1-fix Б5 (Ф1.13, LOW-11): HTTP-контракт /api/me/*
// и единой карточки на настоящем сервере во временном каталоге. Все внешние
// адреса (REST, AppSec, git) — локальный мок со счётчиком: аноним — ноль
// запросов; PUT/DELETE /api/me/pat сбрасывают кэш доступа; POST scan —
// 202 / 202 deduplicated / 429 too_many_active / 429 rate_limited / 409 /
// 403 / 401 / 503. PAT сохраняется настоящим PUT (шифрование APP_SECRET).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { cardFacts, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "routes-me-test-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-routes-me-"));

// мок платформы: /user, repo-GET по слагу (статус задаётся именем), CI-раны, AppSec
const REPO_STATUS: Record<string, number> = { forbidden: 403, missing: 404, expired: 401, broken: 500 };
const mock = startMockApi((req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "tester" });
  const runs = p.match(/^\/repos\/([^/]+)\/([^/]+)\/cicd\/runs$/);
  if (runs) return Response.json({ runs: [] });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const status = REPO_STATUS[repo[2]!];
    if (status) return Response.json({ error: "mock" }, { status });
    return Response.json({ id: `gid-${repo[2]}`, name: repo[2], visibility: "public" });
  }
  if (p === "/v1/scans/latest") return Response.json({ error: "no scan" }, { status: 404 });
  return null; // git и прочее — 404: юзерская заявка в воркере до живого хоста не дойдёт
});

let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t: ApiTestDb = { db, close: () => db.close() };
  const repoId = seedRepo(t, { org: "pub", repo: "repo" });
  seedScore(t, repoId, seedScan(t, repoId, { facts: cardFacts() }), { total: 60 });
  for (const name of ["active", "rate", "cache", "nopat"]) {
    cookies[name] = createSession(db, SECRET, upsertUser(db, `ya-${name}`, name));
  }
  db.close();
  server = await spawnServer({
    dataDir: dir,
    mock,
    appSecret: SECRET,
    env: { QUEUE_USER_ACTIVE_MAX: "2", QUEUE_USER_SCANS_PER_HOUR: "6" },
  });
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` } });
const url = (path: string) => `${server!.base}${path}`;
const putPat = (name: string, token: string) =>
  fetch(url("/api/me/pat"), as(name, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
const postScan = async (name: string | null, slug: string) => {
  const res = await fetch(url(`/api/me/repos/${slug}/scan`), name ? as(name, { method: "POST" }) : { method: "POST" });
  const body = (await res.json()) as { deduplicated?: boolean; jobId?: number; error?: { code: string } };
  return { status: res.status, code: body.error?.code ?? null, deduplicated: body.deduplicated ?? null };
};

describe("POST /api/me/repos/:org/:repo/scan — коды ответа (Ф1.13)", () => {
  // первым тестом: воркер-луп сервера (опрос 5 с) ещё не успел заявить job
  test("202, 202 deduplicated, 429 too_many_active, 403, 401, 503, 409, 401 без сессии", async () => {
    expect((await putPat("active", "pat-active-000000")).status).toBe(200);
    // отказы предпроверки (401/503/403) учитываются лимитом частоты (круг 2, LOW-6)
    expect(await postScan("active", "own/expired")).toEqual({ status: 401, code: "pat_expired", deduplicated: null });
    expect(await postScan("active", "own/broken")).toEqual({ status: 503, code: "check_failed", deduplicated: null });
    expect(await postScan("active", "own/forbidden")).toEqual({ status: 403, code: "no_access", deduplicated: null });
    expect(await postScan("active", "own/a1")).toEqual({ status: 202, code: null, deduplicated: false });
    expect(await postScan("active", "own/a1")).toEqual({ status: 202, code: null, deduplicated: true });
    expect(await postScan("active", "own/a2")).toEqual({ status: 202, code: null, deduplicated: false });
    // too_many_active — до сети
    const mark = mock.requests.length;
    expect(await postScan("active", "own/a3")).toEqual({ status: 429, code: "too_many_active", deduplicated: null });
    expect(mock.requests.length).toBe(mark);
    expect(await postScan("nopat", "own/a1")).toEqual({ status: 409, code: "no_pat", deduplicated: null });
    expect(await postScan(null, "own/a1")).toEqual({ status: 401, code: "unauthorized", deduplicated: null });
  });

  test("429 rate_limited: отказанные предпроверки учитываются лимитом частоты", async () => {
    expect((await putPat("rate", "pat-rate-00000000")).status).toBe(200);
    for (const slug of ["forbidden", "missing", "expired", "broken", "forbidden"]) {
      expect((await postScan("rate", `enum/${slug}`)).status).not.toBe(202);
    }
    expect(await postScan("rate", "enum/b1")).toEqual({ status: 202, code: null, deduplicated: false });
    const before = mock.requests.length;
    expect(await postScan("rate", "enum/b2")).toEqual({ status: 429, code: "rate_limited", deduplicated: null });
    expect(mock.requests.length).toBe(before); // дешёвая проверка до сети
  });
});

describe("карточка: аноним без запросов, кэш доступа сбрасывается сменой PAT (Ф1.13)", () => {
  const cardRequests = (from: number) =>
    mock.requests.slice(from).filter((r) => r.path.startsWith("/repos/pub/repo") || r.path.startsWith("/v1/scans/latest"));

  test("аноним и зритель без PAT: карточка, MD, рейтинг, мета — ноль внешних запросов", async () => {
    const before = mock.requests.length;
    for (const init of [{}, as("nopat")]) {
      for (const path of ["/api/repos/pub/repo", "/api/repos/pub/repo/report.md", "/api/repos", "/api/meta"]) {
        expect((await fetch(url(path), init)).status).toBe(200);
      }
    }
    expect(cardRequests(before)).toEqual([]);
  });

  test("PUT PAT → проверки; повтор — из кэша; PUT нового PAT и DELETE сбрасывают кэш", async () => {
    const card = async () => (await (await fetch(url("/api/repos/pub/repo"), as("cache"))).json()) as { access: { cicd: string; appsec: string } };
    expect((await putPat("cache", "pat-cache-one-000")).status).toBe(200);
    let mark = mock.requests.length;
    expect((await card()).access).toEqual({ cicd: "granted", appsec: "granted" }); // AppSec 404 «скана нет» → granted (Ф1.4)
    expect(cardRequests(mark).map((r) => r.path).sort()).toEqual(["/repos/pub/repo", "/repos/pub/repo/cicd/runs?page_size=1", "/v1/scans/latest?gitRepo=gid-repo"]);
    mark = mock.requests.length;
    await card();
    expect(cardRequests(mark)).toEqual([]); // кэш
    expect((await putPat("cache", "pat-cache-two-000")).status).toBe(200);
    mark = mock.requests.length;
    await card();
    expect(cardRequests(mark)).toHaveLength(3); // новый PAT — новые права
    expect((await fetch(url("/api/me/pat"), as("cache", { method: "DELETE" }))).status).toBe(200);
    mark = mock.requests.length;
    expect((await card()).access).toEqual({ cicd: "no-pat", appsec: "no-pat" });
    expect(cardRequests(mark)).toEqual([]);
  });
});
