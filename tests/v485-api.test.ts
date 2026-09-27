// API для UI: `MyJob` несет скан задания, исход и «изменилась ли публичная
// оценка» – каждое поле сверяется с источником на временной БД.
// `/api/me/jobs` несет `login`; карточка – причину доступа зрителя
// (`viewer.auth`: нет сессии / нет токена / токен есть) и идущий
// чужой/периодический скан. Живых запросов нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { myJobs } from "../src/api/me";
import { getRepoCard } from "../src/api/repos";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { storePat } from "../src/auth/pat";
import { enqueueScan } from "../src/jobs/scheduler";
import { seedRepo, seedScan, seedScore, cardFacts, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; t: ApiTestDb } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v485-b5-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return { db, t: { db, close: () => {} } };
}

/** Задание пользователя, взятое в работу в `claimedAt`, с итогом `status`. */
function job(db: Database, repoId: number, userId: number, claimedAt: string, status: "done" | "failed" | "running" | "queued"): number {
  const id = enqueueScan(db, repoId, { userId, triggerKind: "user" });
  db.query("UPDATE jobs SET status = ?, claimed_at = ? WHERE id = ?").run(status, status === "queued" ? null : claimedAt, id);
  return id;
}

describe("К8.5.1: итог анализа — по заданию", () => {
  test("исход и скан задания равны источнику: bad, interrupted, partial без изменения индекса, ok с новым индексом, идет", () => {
    const { db, t } = freshDb();
    const uid = upsertUser(db, "ya-jobs", "jobs");
    const t0 = "2026-09-22T10:00:00.000Z";
    const later = "2026-09-22T10:00:05.000Z";
    // 1. сбор не удался
    const r1 = seedRepo(t, { org: "j", repo: "bad" });
    const j1 = job(db, r1, uid, t0, "failed");
    const s1 = seedScan(t, r1, { status: "bad", userId: uid, startedAt: later, ratingEligible: false });
    // 2. прерван перезапуском: скан shutdown, задание снова в очереди — и ещё одно прерванное, уже закрытое
    const r2 = seedRepo(t, { org: "j", repo: "int" });
    const j2 = job(db, r2, uid, t0, "done");
    const s2 = seedScan(t, r2, { status: "bad", userId: uid, startedAt: later, ratingEligible: false });
    db.query("UPDATE scans SET status_detail = 'shutdown' WHERE id = ?").run(s2);
    // 3. partial (таймаут клона): непригоден — публичная оценка прежняя
    const r3 = seedRepo(t, { org: "j", repo: "partial" });
    seedScore(t, r3, seedScan(t, r3, { status: "ok", startedAt: "2026-09-20T00:00:00.000Z" }), { total: 70 });
    const j3 = job(db, r3, uid, t0, "done");
    const s3 = seedScan(t, r3, { status: "partial", userId: uid, startedAt: later, ratingEligible: false });
    seedScore(t, r3, s3, { total: 40 });
    // 4. ok: новый пригодный скан с другим индексом
    const r4 = seedRepo(t, { org: "j", repo: "ok" });
    seedScore(t, r4, seedScan(t, r4, { status: "ok", startedAt: "2026-09-20T00:00:00.000Z" }), { total: 50 });
    const j4 = job(db, r4, uid, t0, "done");
    const s4 = seedScan(t, r4, { status: "ok", userId: uid, startedAt: later });
    seedScore(t, r4, s4, { total: 64 });
    // 5. идёт
    const r5 = seedRepo(t, { org: "j", repo: "run" });
    const j5 = job(db, r5, uid, t0, "running");
    const s5 = seedScan(t, r5, { status: "running", finishedAt: null, userId: uid, startedAt: later });
    // скан ДРУГОГО пользователя по тому же репо итогом задания не считается
    const other = upsertUser(db, "ya-other", "other");
    seedScan(t, r5, { status: "ok", userId: other, startedAt: later });

    const all = [...myJobs(db, uid).active, ...myJobs(db, uid).recent];
    const view = (id: number) => {
      const j = all.find((x) => x.jobId === id)!;
      return { scanId: j.scanId, outcome: j.outcome, scoreChanged: j.scoreChanged };
    };
    expect([view(j1), view(j2), view(j3), view(j4), view(j5)]).toEqual([
      { scanId: s1, outcome: "bad", scoreChanged: false },
      { scanId: s2, outcome: "interrupted", scoreChanged: false },
      { scanId: s3, outcome: "partial", scoreChanged: false },
      { scanId: s4, outcome: "ok", scoreChanged: true },
      { scanId: s5, outcome: null, scoreChanged: null },
    ]);
  });

  test("С6-3: карточка без оценки видит идущий чужой/периодический скан (статус running), не «скан был – данных не хватило»", () => {
    const { db, t } = freshDb();
    const r = seedRepo(t, { org: "c", repo: "new" });
    seedScan(t, r, { status: "running", finishedAt: null, userId: null, trigger: "periodic" });
    const card = getRepoCard(db, "c", "new");
    expect({ score: card?.score, scanStatus: card?.scan?.status, job: card?.job }).toEqual({ score: null, scanStatus: "running", job: null });
  });
});

// ---------------------------------------------------------------------------
// HTTP: login в /api/me/jobs; причина доступа карточки
// ---------------------------------------------------------------------------

const SECRET = "v485-api-secret-0123456789abcdef-xyzw";
const httpDir = mkdtempSync(join(tmpdir(), "rh-v485-b5-http-"));
const mock = startMockApi((_req, url) => {
  if (/\/cicd\/runs$/.test(url.pathname)) return Response.json({ error: "denied" }, { status: 403 });
  if (url.pathname === "/v1/scans/latest") return Response.json({ error: "none" }, { status: 404 });
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return Response.json({ id: "g-1", visibility: "public" });
  return null;
});
let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: httpDir });
  const t: ApiTestDb = { db, close: () => db.close() };
  const r = seedRepo(t, { org: "pub", repo: "repo" });
  seedScore(t, r, seedScan(t, r, { facts: cardFacts() }), { total: 60 });
  for (const name of ["withpat", "nopat"]) {
    const id = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, id);
    if (name === "withpat") storePat(db, SECRET, id, "pat-withpat-00000");
  }
  db.close();
  server = await spawnServer({ dataDir: httpDir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating" } });
}, 60_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  try {
    rmSync(httpDir, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY */
  }
});

const as = (name: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE}=${cookies[name]}` } });

describe("К8.5.8: сессия на сервере", () => {
  test("/api/me/jobs несет login зрителя", async () => {
    const body = (await (await fetch(`${server!.base}/api/me/jobs`, as("withpat"))).json()) as { login: string };
    expect(body.login).toBe("withpat");
  }, 30_000);

  test("причина доступа карточки — отдельным полем: нет сессии / нет токена / токен есть; ChannelAccess прежний", async () => {
    const card = async (init?: RequestInit) =>
      (await (await fetch(`${server!.base}/api/repos/pub/repo`, init)).json()) as { viewer: { auth: string; own: boolean }; access: { cicd: string } };
    const anon = await card();
    const expired = await card({ headers: { cookie: `${SESSION_COOKIE}=forged.value` } });
    const nopat = await card(as("nopat"));
    const withpat = await card(as("withpat"));
    expect({
      anon: [anon.viewer.auth, anon.access.cicd],
      expired: [expired.viewer.auth, expired.access.cicd],
      nopat: [nopat.viewer.auth, nopat.access.cicd],
      withpat: [withpat.viewer.auth, withpat.viewer.own],
    }).toEqual({
      anon: ["no-session", "no-pat"],
      expired: ["no-session", "no-pat"],
      nopat: ["no-pat", "no-pat"],
      withpat: ["pat", false],
    });
  }, 30_000);
});
