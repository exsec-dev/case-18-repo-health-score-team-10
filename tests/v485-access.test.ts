// v485-access.test.ts — В4.8.5, блок Б3: доступ и права. К8.5.6 (один
// классификатор ответа SourceCraft; сбой — не вердикт), К8.5.9 (права строки
// = права карточки, поколение PAT), К8.5.14 (серверная часть: «свой» — одно
// определение, автопроверка при добавлении, фоновая перепроверка, `/scan`
// только своих). Временные БД, фейки ввода-вывода и настоящий сервер
// харнесса с локальным моком; живых запросов нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import {
  appsecOn404,
  classifyScStatus,
  isOwnRepo,
  makeAccessCache,
  probeRepoAccess,
  resolveAccess,
  type AccessResult,
  type ProbeIo,
} from "../src/auth/access";
import {
  addFavorite,
  checkFavoriteAccess,
  listFavorites,
  listMyRepos,
  resetFavoriteRights,
  staleFavoriteSlugs,
} from "../src/api/me";
import { makeRecheckPump } from "../src/api/recheck";
import { getRepoCard, resolveCardForViewer } from "../src/api/repos";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { storePat } from "../src/auth/pat";
import { seedRepo, seedScan, seedScore, cardFacts, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; t: ApiTestDb } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v485-b3-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return { db, t: { db, close: () => {} } };
}

/** Фейк ввода-вывода проверки: статусы по пути; считает запросы. */
function fakeIo(statuses: { repo: number; cicd?: number; appsec?: number; visibility?: string; id?: string | null }): ProbeIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    restGet: async (path) => {
      calls.push(path);
      if (path.endsWith("/cicd/runs?page_size=1")) return { status: statuses.cicd ?? 200, json: {} };
      return { status: statuses.repo, json: statuses.repo === 200 ? { visibility: statuses.visibility ?? "private", ...(statuses.id ? { id: statuses.id } : {}) } : null };
    },
    appsecLatest: async (gitRepo) => {
      calls.push(`appsec:${gitRepo}`);
      return { status: statuses.appsec ?? 404 };
    },
  };
}

describe("К8.5.6: один классификатор ответа SourceCraft", () => {
  test("200 — ok; 401 — токен отклонен; 403/404 — отказ; 0/429/5xx/прочее — недоступен", () => {
    expect([200, 401, 403, 404, 0, 429, 500, 502, 503, 418].map(classifyScStatus)).toEqual([
      "ok",
      "token-rejected",
      "denied",
      "denied",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("С8-6: CI 429 + AppSec 404 — Security «неизвестно», а не отказ на 15 минут кэша", async () => {
    const cache = makeAccessCache(15 * 60_000, { failedTtlMs: 60_000 });
    const rest = {
      get: async (p: string) => (p.includes("/cicd/runs") ? { status: 429, json: null, bodyText: "" } : { status: 200, json: { id: "uuid-1" }, bodyText: "" }),
      requestCount: () => 0,
    };
    const appsec = { get: async () => ({ status: 404, json: null, attempts: 1 }), requestCount: () => 0 };
    const r = await resolveAccess({ restClient: () => rest, appsecClient: () => appsec, cache }, { userId: 1, pat: "x" }, { id: 7, org: "o", repo: "r", visibility: "public" });
    const t = Date.now();
    expect({ r, cachedAfter61s: cache.get(1, 7, "appsec", t + 61_000) }).toEqual({
      r: { cicd: "check-failed", appsec: "check-failed", repo: "granted" },
      cachedAfter61s: null,
    });
    expect(appsecOn404("denied", "public", "granted")).toBe("denied");
    expect(appsecOn404("granted", "public", "granted")).toBe("granted");
  });

  test("С3-1: сбой SourceCraft при проверке прав не затирает сохраненные права и время проверки", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-c31", "c31");
    addFavorite(db, uid, "o", "p");
    const ok = await checkFavoriteAccess(db, uid, "o", "p", { ...fakeIo({ repo: 200 }), cooldownMs: 0 }, null);
    const checkedAt = listFavorites(db, uid)[0]!.lastCheckedAt;
    const failed = await checkFavoriteAccess(db, uid, "o", "p", { ...fakeIo({ repo: 503 }), cooldownMs: 0 }, async () => ({ status: "queued", code: null }));
    const after = listFavorites(db, uid)[0]!;
    expect({ ok: ok.result, failed: failed.result, enqueue: failed.enqueue, access: after.access?.clone, checkedAtKept: after.lastCheckedAt === checkedAt }).toEqual({
      ok: "checked",
      failed: "failed",
      enqueue: { status: "skipped", code: "check_failed" },
      access: true,
      checkedAtKept: true,
    });
  });

  test("401 — токен отклонен: права перезаписаны отказом, заявки нет, исход token_rejected", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-401", "u401");
    addFavorite(db, uid, "o", "p");
    await checkFavoriteAccess(db, uid, "o", "p", { ...fakeIo({ repo: 200 }), cooldownMs: 0 }, null);
    const out = await checkFavoriteAccess(db, uid, "o", "p", { ...fakeIo({ repo: 401 }), cooldownMs: 0 }, async () => ({ status: "queued", code: null }));
    expect({ result: out.result, clone: listFavorites(db, uid)[0]!.access?.clone, enqueue: out.enqueue }).toEqual({
      result: "token_rejected",
      clone: false,
      enqueue: { status: "skipped", code: "pat_expired" },
    });
  });
});

describe("К8.5.14 (а): «свой» — одно определение", () => {
  test("правило: CI или Security доступны, или приватный и виден; неизвестно — не свой", () => {
    const base = { repo: "granted", cicd: "denied", appsec: "denied", visibility: "public" } as const;
    expect(isOwnRepo(base)).toBe(false);
    expect(isOwnRepo({ ...base, cicd: "granted" })).toBe(true);
    expect(isOwnRepo({ ...base, appsec: "granted" })).toBe(true);
    expect(isOwnRepo({ ...base, visibility: "private" })).toBe(true);
    expect(isOwnRepo({ ...base, visibility: "private", repo: "check-failed" })).toBe(false);
    expect(isOwnRepo({ repo: "no-pat", cicd: "no-pat", appsec: "no-pat", visibility: "private" })).toBe(false);
  });

  test("живая проверка и карточка считают «свой» одинаково на одних и тех же ответах", async () => {
    const { db, t } = freshDb();
    const pub = seedRepo(t, { org: "own", repo: "pub" });
    seedScore(t, pub, seedScan(t, pub, { facts: cardFacts() }), { total: 60 });
    const probe = await probeRepoAccess(fakeIo({ repo: 200, visibility: "public", cicd: 200, id: "g1", appsec: 404 }), "own", "pub");
    const cardAccess: AccessResult = { repo: "granted", cicd: probe.access.cicd, appsec: probe.access.appsec };
    const card = getRepoCard(db, "own", "pub", { access: cardAccess, viewerAuth: "pat" });
    const foreign = await probeRepoAccess(fakeIo({ repo: 200, visibility: "public", cicd: 403, id: "g2", appsec: 404 }), "x", "pub");
    const foreignCard = getRepoCard(db, "own", "pub", { access: { repo: "granted", cicd: foreign.access.cicd, appsec: foreign.access.appsec }, viewerAuth: "pat" });
    const anon = getRepoCard(db, "own", "pub");
    expect({
      probeOwn: isOwnRepo(probe.access),
      cardOwn: card?.viewer?.own,
      foreignOwn: isOwnRepo(foreign.access),
      foreignCardOwn: foreignCard?.viewer?.own,
      anon: anon?.viewer,
    }).toEqual({ probeOwn: true, cardOwn: true, foreignOwn: false, foreignCardOwn: false, anon: { own: false, auth: "no-session" } });
  });
});

describe("К8.5.9: права строки = права карточки, поколение PAT", () => {
  test("гашение прав (удаление/замена PAT) — строка приватного без меты; нечитаемый PAT — сохраненные права не в счет", async () => {
    const { db, t } = freshDb();
    const uid = upsertUser(db, "ya-gen", "gen");
    const priv = seedRepo(t, { org: "g", repo: "priv", title: "Secret" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    addFavorite(db, uid, "g", "priv");
    db.query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ?").run(
      JSON.stringify({ clone: true, visibility: "private", ci: true, appsec: null, own: true }),
      new Date().toISOString(),
      uid,
    );
    const before = (await listMyRepos(db, uid)).entries[0]!;
    const unreadable = (await listMyRepos(db, uid, { savedRightsValid: false })).entries[0]!;
    resetFavoriteRights(db, uid);
    const after = (await listMyRepos(db, uid)).entries[0]!;
    const fav = listFavorites(db, uid)[0]!;
    expect({
      before: [before.mayRead, before.title],
      unreadable: [unreadable.mayRead, unreadable.title],
      after: [after.mayRead, after.title],
      reset: [fav.access, fav.lastCheckedAt],
    }).toEqual({ before: [true, "Secret"], unreadable: [false, null], after: [false, null], reset: [null, null] });
  });

  test("С6-2: выбывший публичный с сохраненным clone:true — строка не раскрывает, как и карточка (404)", async () => {
    const { db, t } = freshDb();
    const uid = upsertUser(db, "ya-ev", "ev");
    const ev = seedRepo(t, { org: "o", repo: "ev", title: "EV" });
    db.query("UPDATE repos SET rating_active = 0 WHERE id = ?").run(ev);
    addFavorite(db, uid, "o", "ev");
    db.query("UPDATE favorites SET last_access = ? WHERE user_id = ?").run(JSON.stringify({ clone: true, visibility: "public", ci: true, appsec: true, own: true }), uid);
    const row = (await listMyRepos(db, uid)).entries[0]!;
    const card = await resolveCardForViewer(db, "o", "ev", async () => ({ cicd: "granted", appsec: "granted", repo: "granted" }));
    expect({ mayRead: row.mayRead, title: row.title, card: card.kind }).toEqual({ mayRead: false, title: null, card: "not_found" });
  });

  test("С6-1: приватный при сбое проверки — владельцу с доказанными правами «проверка не удалась», прочим — нейтральный 404", async () => {
    const { db, t } = freshDb();
    const priv = seedRepo(t, { org: "p", repo: "priv" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    const failed = async (): Promise<AccessResult> => ({ repo: "check-failed", cicd: "check-failed", appsec: "check-failed" });
    const rejected = async (): Promise<AccessResult> => ({ repo: "pat-expired", cicd: "pat-expired", appsec: "pat-expired" });
    const owner = await resolveCardForViewer(db, "p", "priv", failed, { provenRights: () => true });
    const stranger = await resolveCardForViewer(db, "p", "priv", failed, { provenRights: () => false });
    const expired = await resolveCardForViewer(db, "p", "priv", rejected, { provenRights: () => true });
    const denied = await resolveCardForViewer(db, "p", "priv", async () => ({ repo: "denied", cicd: "denied", appsec: "denied" }), { provenRights: () => true });
    expect([owner.kind, stranger.kind, expired.kind, denied.kind]).toEqual(["check_failed", "not_found", "token_rejected", "not_found"]);
  });
});

describe("К8.5.14 (д): фоновая перепроверка — насос", () => {
  test("порции с паузой (не быстрее ритма), анализ не ставит, сбой платформы останавливает очередь", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-pump", "pump");
    for (let i = 1; i <= 5; i++) addFavorite(db, uid, "pump", `r${i}`);
    const pauses: number[] = [];
    let mode: "ok" | "down" = "ok";
    const calls: string[] = [];
    const io: ProbeIo = {
      restGet: async (path) => {
        calls.push(path);
        if (mode === "down") return { status: 503, json: null };
        return path.includes("/cicd/") ? { status: 200, json: {} } : { status: 200, json: { visibility: "private" } };
      },
      appsecLatest: async () => ({ status: 404 }),
    };
    const pump = makeRecheckPump({ db, probeIo: () => io, batchSize: 2, pauseMs: 1000, sleep: async (ms) => void pauses.push(ms) });
    pump.enqueue(uid, staleFavoriteSlugs(db, uid));
    await pump.idle(uid);
    const checked = listFavorites(db, uid).filter((f) => f.lastCheckedAt !== null).length;
    const jobs = (db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
    expect({ checked, pauses, jobs }).toEqual({ checked: 5, pauses: [1000, 1000], jobs: 0 });
    // сбой: первая же запись — стоп, права остальных не тронуты, очередь пуста
    resetFavoriteRights(db, uid);
    mode = "down";
    calls.length = 0;
    pump.enqueue(uid, staleFavoriteSlugs(db, uid));
    await pump.idle(uid);
    expect({ requests: calls.length, pending: pump.pending(uid), checked: listFavorites(db, uid).filter((f) => f.lastCheckedAt !== null).length }).toEqual({
      requests: 1,
      pending: 0,
      checked: 0,
    });
  });

  test("кандидаты перепроверки — «не проверено» или старше суток", () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-stale", "stale");
    for (const r of ["never", "old", "young"]) addFavorite(db, uid, "s", r);
    db.query("UPDATE favorites SET last_checked_at = ? WHERE repo_slug = 'old'").run(new Date(Date.now() - 25 * 3600_000).toISOString());
    db.query("UPDATE favorites SET last_checked_at = ? WHERE repo_slug = 'young'").run(new Date(Date.now() - 2 * 3600_000).toISOString());
    expect(staleFavoriteSlugs(db, uid).map((s) => s.repo).sort()).toEqual(["never", "old"]);
  });
});

// ---------------------------------------------------------------------------
// HTTP: PUT PAT гасит права и запускает фон; чтение списка перепроверяет старое
// ---------------------------------------------------------------------------

const SECRET = "v485-access-secret-0123456789abcdef-xyz";
const httpDir = mkdtempSync(join(tmpdir(), "rh-v485-b3-http-"));

const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "httpuser" });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (/\/cicd\/runs$/.test(p)) return Response.json({ runs: [] });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) return Response.json({ name: repo[2], visibility: "private" });
  return null;
});
let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: httpDir });
  for (const name of ["swap", "reader"]) {
    const id = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, id);
    if (name === "reader") storePat(db, SECRET, id, "pat-reader-000000");
    for (const r of ["a", "b"]) {
      db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access, last_checked_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        name,
        r,
        new Date().toISOString(),
        JSON.stringify({ clone: false, visibility: "unknown", ci: null, appsec: null, own: false }),
        r === "a" ? new Date(Date.now() - 30 * 3600_000).toISOString() : new Date().toISOString(),
      );
    }
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
    /* Windows EBUSY: каталог временный, уберёт ОС */
  }
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` } });
const at = (path: string) => `${server!.base}${path}`;
const favs = async (name: string) =>
  ((await (await fetch(at("/api/me/favorites"), as(name))).json()) as { entries: { repo: string; access: { clone: boolean } | null; lastCheckedAt: string | null }[] }).entries;
async function until(cond: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("HTTP: гашение прав и фоновая перепроверка (К8.5.9, К8.5.14)", () => {
  test("PUT PAT гасит прежние права и фоном проверяет все записи; анализ не ставится", async () => {
    const put = await fetch(at("/api/me/pat"), as("swap", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "pat-swap-0000000" }) }));
    expect(put.status).toBe(200);
    const settled = await until(async () => (await favs("swap")).every((f) => f.access?.clone === true));
    const jobs = (await (await fetch(at("/api/me/jobs"), as("swap"))).json()) as { active: unknown[] };
    expect({ settled, active: jobs.active.length }).toEqual({ settled: true, active: 0 });
  }, 60_000);

  test("чтение списка перепроверяет запись старше суток, моложе — нет", async () => {
    const mark = mock.requests.length;
    expect((await fetch(at("/api/me/repos"), as("reader"))).status).toBe(200);
    const done = await until(async () => (await favs("reader")).find((f) => f.repo === "a")?.access?.clone === true);
    const paths = mock.requests.slice(mark).map((r) => r.path);
    expect({ done, oldChecked: paths.includes("/repos/reader/a"), youngChecked: paths.includes("/repos/reader/b") }).toEqual({
      done: true,
      oldChecked: true,
      youngChecked: false,
    });
  }, 60_000);
});
