// routes-favorites.test.ts — В4.2-port-fix Б2 (П2, Н1 HIGH): HTTP-контракт
// POST /api/me/favorites/:org/:repo/check на настоящем сервере во временном
// каталоге. До этой вехи портовая поверхность избранного не была покрыта
// тестами вовсе (0 совпадений `favorites` в tests/).
//
// Проверяется: порядок ответов (404 not_favorite → 409 no_pat → 429
// rate_limited), что отказы 404/409 лимит НЕ жгут, форма исхода
// `enqueue: {status, code}`, кулдаун по own-скану ИМЕННО зрителя и
// `skipped/not_own` без собственных прав.
//
// Живых запросов нет: адреса API — локальный мок (харнесс), repo-GET мока
// НЕ отдаёт `id`, поэтому AppSec-канал не вызывается вовсе.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import type { FavoriteCheckResponse } from "../src/api/me";
import { seedRepo, seedScan, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "routes-favorites-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-fav-"));

// org `pubnoci` — публичный репо без прав на CI (own = false);
// остальное — приватный репо зрителя (own = true). `id` не отдаём: без него
// AppSec-клиент не строится и PAT никуда не уходит.
// org `withid` — repo-GET отдаёт `id`, поэтому вызывается AppSec-канал:
// это и есть проверка П3 (адрес AppSec обязан быть из конфига, не боевой).
const mock = startMockApi((req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "favtester" });
  if (p === "/v1/scans/latest") return Response.json({ scanUuid: "s-1", timeFinished: 1, isLatest: true });
  const runs = p.match(/^\/repos\/([^/]+)\/([^/]+)\/cicd\/runs$/);
  if (runs) return runs[1] === "pubnoci" ? Response.json({ error: "denied" }, { status: 403 }) : Response.json({ runs: [] });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    const body: Record<string, unknown> = { name: repo[2], visibility: repo[1] === "pubnoci" ? "public" : "private" };
    if (repo[1] === "withid") body.id = `gid-${repo[2]}`;
    return Response.json(body);
  }
  return null;
});

let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t: ApiTestDb = { db, close: () => db.close() };
  const fav = db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, ?, ?, '2026-09-17T00:00:00Z')");
  for (const name of ["lim", "gate", "cool", "noci", "other", "appsec"]) {
    ids[name] = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, ids[name]!);
  }
  for (let i = 1; i <= 4; i++) fav.run(ids.lim!, "lim", `l${i}`);
  for (let i = 1; i <= 3; i++) fav.run(ids.gate!, "gate", `g${i}`);
  fav.run(ids.noci!, "pubnoci", "repo");
  fav.run(ids.appsec!, "withid", "repo");
  // кулдаун: own-скан ДРУГОГО юзера не блокирует автозаявку зрителя,
  // свой свежий own-скан — блокирует (К-П П2)
  const other = seedRepo(t, { org: "cool", repo: "other-scan" });
  seedScan(t, other, { startedAt: new Date().toISOString(), userId: ids.other!, status: "ok" });
  fav.run(ids.cool!, "cool", "other-scan");
  const mine = seedRepo(t, { org: "cool", repo: "my-scan" });
  seedScan(t, mine, { startedAt: new Date().toISOString(), userId: ids.cool!, status: "ok" });
  fav.run(ids.cool!, "cool", "my-scan");
  db.close();
  server = await spawnServer({
    dataDir: dir,
    mock,
    appSecret: SECRET,
    env: {
      // HTTP жив, но юзерскую полосу никто не разбирает — исходы постановки стабильны
      PROCESS_ROLE: "rating",
      QUEUE_FAVORITE_CHECKS_PER_MINUTE: "3",
      QUEUE_USER_ACTIVE_MAX: "50",
      QUEUE_USER_SCANS_PER_HOUR: "50",
    },
  });
}, 60_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` } });
const at = (path: string) => `${server!.base}${path}`;
const putPat = (name: string, token: string) =>
  fetch(at("/api/me/pat"), as(name, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));

async function check(name: string, slug: string): Promise<{ status: number; code: string | null; body: FavoriteCheckResponse | null }> {
  const res = await fetch(at(`/api/me/favorites/${slug}/check`), as(name, { method: "POST" }));
  const raw = (await res.json()) as { error?: { code?: string } } & Partial<FavoriteCheckResponse>;
  return {
    status: res.status,
    code: raw.error?.code ?? null,
    body: res.status === 200 ? (raw as FavoriteCheckResponse) : null,
  };
}

describe("POST /api/me/favorites/:org/:repo/check — порядок отказов и лимит частоты (П2)", () => {
  test("404 not_favorite и 409 no_pat лимит НЕ жгут: три проверки после них проходят", async () => {
    // не в избранном → 404 (перебор несуществующих слагов не должен жечь лимит)
    for (let i = 0; i < 4; i++) {
      expect(await check("gate", "gate/unknown")).toEqual({ status: 404, code: "not_favorite", body: null });
    }
    // в избранном, но PAT нет → 409 (тоже до лимита)
    for (let i = 0; i < 4; i++) {
      expect(await check("gate", "gate/g1")).toEqual({ status: 409, code: "no_pat", body: null });
    }
    expect((await putPat("gate", "pat-gate-00000000")).status).toBe(200);
    for (const slug of ["gate/g1", "gate/g2", "gate/g3"]) {
      const out = await check("gate", slug);
      expect({ status: out.status, enqueue: out.body?.enqueue }).toEqual({ status: 200, enqueue: { status: "queued", code: null } });
    }
  }, 60_000);

  test("четвёртая проверка в минуту → 429 rate_limited (Config.queue.favoriteChecksPerMinute)", async () => {
    expect((await putPat("lim", "pat-lim-000000000")).status).toBe(200);
    const statuses: number[] = [];
    for (const slug of ["lim/l1", "lim/l2", "lim/l3", "lim/l4"]) statuses.push((await check("lim", slug)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(await check("lim", "lim/l4")).toEqual({ status: 429, code: "rate_limited", body: null });
  }, 60_000);
});

describe("исход автопостановки — единственное поле enqueue (П2, решение (1) 18.09)", () => {
  test("кулдаун считается по own-скану ЗРИТЕЛЯ: чужой свежий скан не блокирует, свой — блокирует", async () => {
    expect((await putPat("cool", "pat-cool-00000000")).status).toBe(200);
    const mark = mock.requests.length;
    const foreign = await check("cool", "cool/other-scan");
    // К-П П2: repo-GET не дублируется — тело прокинуто в requestUserScan,
    // живых запросов ровно два (repo-GET + cicd/runs), а не три
    expect(mock.requests.slice(mark).map((r) => r.path)).toEqual([
      "/repos/cool/other-scan",
      "/repos/cool/other-scan/cicd/runs?page_size=1",
    ]);
    const mine = await check("cool", "cool/my-scan");
    expect({
      foreign: foreign.body?.enqueue,
      mine: mine.body?.enqueue,
      // форма ответа: `enqueued` больше нет ни в одном исходе
      legacyField: Object.prototype.hasOwnProperty.call(foreign.body ?? {}, "enqueued"),
    }).toEqual({
      foreign: { status: "queued", code: null },
      mine: { status: "skipped", code: "cooldown" },
      legacyField: false,
    });
  }, 60_000);

  test("П3 (Н2): AppSec-клиент проверки идёт на APPSEC_API_BASE — в запросах мока есть путь /v1/scans/latest", async () => {
    expect((await putPat("appsec", "pat-appsec-0000000")).status).toBe(200);
    const mark = mock.requests.length;
    const out = await check("appsec", "withid/repo");
    const paths = mock.requests.slice(mark).map((r) => r.path);
    // ассерт по ПУТИ, а не по счётчику: харнесс шлёт REST и AppSec в один мок,
    // и двух REST-запросов проверки хватило бы, чтобы счётчик был > 0 без правки
    expect({
      appsecHit: paths.filter((p) => p.startsWith("/v1/scans/latest")).length,
      access: out.body?.access,
    }).toEqual({ appsecHit: 1, access: { clone: true, visibility: "private", ci: true, appsec: true, own: true } });
  }, 60_000);

  test("нет своих прав (публичный репо, CI 403, AppSec не спрашивали) → skipped/not_own, права всё равно показаны", async () => {
    expect((await putPat("noci", "pat-noci-00000000")).status).toBe(200);
    const out = await check("noci", "pubnoci/repo");
    expect({ status: out.status, access: out.body?.access, enqueue: out.body?.enqueue }).toEqual({
      status: 200,
      access: { clone: true, visibility: "public", ci: false, appsec: null, own: false },
      enqueue: { status: "skipped", code: "not_own" },
    });
  }, 60_000);
});
