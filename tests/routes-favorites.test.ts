// routes-favorites.test.ts — В4.2-port-fix Б2 (П2, Н1 HIGH): HTTP-контракт
// проверки прав избранного на настоящем сервере во временном каталоге.
//
// ПЕРЕНОС (В4.8.5, К8.5.14 (г), §2-В1): маршрута «Проверить доступ»
// (`POST /api/me/favorites/:org/:repo/check`) больше нет — права проверяются
// сами при явном добавлении в избранное (звезда `PUT /api/me/favorites/:org/:repo`
// и «Добавить» `PUT /api/me/favorites`). Инварианты прежних тестов не сняты,
// а перенесены на путь добавления: окно проверок не жгут запросы без PAT;
// сверх окна запись не проверяется синхронно, а уходит в фон; форма исхода
// `enqueue: {status, code}`; кулдаун по own-скану ИМЕННО зрителя; repo-GET не
// дублируется; AppSec — на APPSEC_API_BASE; не свой — права показаны, заявки нет.
//
// Живых запросов нет: адреса API — локальный мок (харнесс), repo-GET мока
// НЕ отдаёт `id` (кроме org `withid`), поэтому AppSec-канал в прочих не вызывается.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import type { FavoriteAccess, FavoriteEnqueue } from "../src/api/me";
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
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
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
  for (const name of ["lim", "gate", "cool", "noci", "other", "appsec"]) {
    ids[name] = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, ids[name]!);
  }
  // кулдаун: own-скан ДРУГОГО юзера не блокирует автозаявку зрителя,
  // свой свежий own-скан — блокирует (К-П П2)
  const other = seedRepo(t, { org: "cool", repo: "other-scan" });
  seedScan(t, other, { startedAt: new Date().toISOString(), userId: ids.other!, status: "ok" });
  const mine = seedRepo(t, { org: "cool", repo: "my-scan" });
  seedScan(t, mine, { startedAt: new Date().toISOString(), userId: ids.cool!, status: "ok" });
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

interface AddBody {
  access: FavoriteAccess | null;
  check: { status: string; enqueue: FavoriteEnqueue | null };
}

/** Добавить в избранное звездой — путь автопроверки прав (К8.5.14). */
async function add(name: string, slug: string): Promise<{ status: number; body: AddBody | null }> {
  const res = await fetch(at(`/api/me/favorites/${slug}`), as(name, { method: "PUT" }));
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as AddBody) : null };
}

/** Дождаться, пока фоновый насос (запущен сохранением PAT) проверит все записи пользователя. */
async function settled(name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const favs = (await (await fetch(at("/api/me/favorites"), as(name))).json()) as { entries: { lastCheckedAt: string | null }[] };
    if (favs.entries.every((e) => e.lastCheckedAt !== null)) return;
    await Bun.sleep(50);
  }
  throw new Error(`background recheck for ${name} did not settle`);
}

describe("автопроверка прав при добавлении — порядок и окно проверок (П2 → К8.5.14)", () => {
  test("без PAT добавление не проверяет права и окно проверок не жжёт: после PAT три добавления проверены и поставлены", async () => {
    // без PAT: запись добавлена, проверки нет (было: 409 no_pat до лимита)
    for (const slug of ["gate/g1", "gate/g2", "gate/g3", "gate/g4"]) {
      const out = await add("gate", slug);
      expect({ status: out.status, check: out.body?.check.status }).toEqual({ status: 200, check: "no_pat" });
    }
    expect((await putPat("gate", "pat-gate-00000000")).status).toBe(200);
    await settled("gate");
    for (const slug of ["gate/g1", "gate/g2", "gate/g3"]) {
      const out = await add("gate", slug);
      expect({ status: out.status, check: out.body?.check }).toEqual({ status: 200, check: { status: "checked", enqueue: { status: "queued", code: null } } });
    }
  }, 60_000);

  // ПЕРЕВОРОТ (закрытие В4.8.5, ревью; решение Екатерины 22.09): новый
  // репозиторий сверх окна проверок больше не добавляется без проверки
  // существования — 429 с Retry-After, записи нет; повторная звезда уже
  // добавленного сверх окна по-прежнему уходит в фон. Инвариант «сверх окна
  // анализ не ставится» — прежний.
  test("четвёртое НОВОЕ добавление в минуту — 429 с Retry-After, записи нет; повторная звезда существующего — в фон; анализ сверх окна не ставится (Config.queue.favoriteChecksPerMinute)", async () => {
    expect((await putPat("lim", "pat-lim-000000000")).status).toBe(200);
    const checks: string[] = [];
    for (const slug of ["lim/l1", "lim/l2", "lim/l3"]) checks.push((await add("lim", slug)).body?.check.status ?? "?");
    expect(checks).toEqual(["checked", "checked", "checked"]);
    const over = await add("lim", "lim/l4");
    expect(over.status).toBe(429);
    const favs = (await (await fetch(at("/api/me/favorites"), as("lim"))).json()) as { entries: { repo: string }[] };
    expect(favs.entries.some((f) => f.repo === "l4")).toBe(false);
    const again = await add("lim", "lim/l1");
    expect({ status: again.status, check: again.body?.check.status }).toEqual({ status: 200, check: "deferred" });
    // дождаться фоновой перепроверки l1 — иначе ее запросы к моку попадут в
    // счет запросов следующего теста
    const l1Probes = () => mock.requests.filter((r) => r.path.startsWith("/repos/lim/l1/cicd/runs")).length;
    for (let i = 0; i < 100 && l1Probes() < 2; i++) await Bun.sleep(50);
    expect(l1Probes()).toBe(2);
    // фон проверяет права, но заявку не ставит (§2-Р1)
    await settled("lim");
    const jobs = (await (await fetch(at("/api/me/jobs"), as("lim"))).json()) as { active: { slug: string }[] };
    expect(jobs.active.map((j) => j.slug).sort()).toEqual(["lim/l1", "lim/l2", "lim/l3"]);
  }, 60_000);
});

describe("исход автопостановки — единственное поле enqueue (П2, решение (1) 18.09)", () => {
  test("кулдаун считается по own-скану ЗРИТЕЛЯ: чужой свежий скан не блокирует, свой — блокирует", async () => {
    expect((await putPat("cool", "pat-cool-00000000")).status).toBe(200);
    const mark = mock.requests.length;
    const foreign = await add("cool", "cool/other-scan");
    // К-П П2: repo-GET не дублируется — тело прокинуто в requestUserScan,
    // живых запросов ровно два (repo-GET + cicd/runs), а не три
    expect(mock.requests.slice(mark).map((r) => r.path)).toEqual([
      "/repos/cool/other-scan",
      "/repos/cool/other-scan/cicd/runs?page_size=1",
    ]);
    const mine = await add("cool", "cool/my-scan");
    expect({
      foreign: foreign.body?.check.enqueue,
      mine: mine.body?.check.enqueue,
      // форма ответа: `enqueued` больше нет ни в одном исходе
      legacyField: Object.prototype.hasOwnProperty.call(foreign.body?.check ?? {}, "enqueued"),
    }).toEqual({
      foreign: { status: "queued", code: null },
      mine: { status: "skipped", code: "cooldown" },
      legacyField: false,
    });
  }, 60_000);

  test("П3 (Н2): AppSec-клиент проверки идёт на APPSEC_API_BASE — в запросах мока есть путь /v1/scans/latest", async () => {
    expect((await putPat("appsec", "pat-appsec-0000000")).status).toBe(200);
    const mark = mock.requests.length;
    const out = await add("appsec", "withid/repo");
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
    const out = await add("noci", "pubnoci/repo");
    expect({ status: out.status, access: out.body?.access, enqueue: out.body?.check.enqueue }).toEqual({
      status: 200,
      access: { clone: true, visibility: "public", ci: false, appsec: null, own: false },
      enqueue: { status: "skipped", code: "not_own" },
    });
    const jobs = (await (await fetch(at("/api/me/jobs"), as("noci"))).json()) as { active: unknown[] };
    expect(jobs.active).toEqual([]);
  }, 60_000);

  test("маршрута «Проверить доступ» больше нет — прежний адрес отвечает общим JSON-404 (К8.5.14 (г))", async () => {
    const res = await fetch(at("/api/me/favorites/pubnoci/repo/check"), as("noci", { method: "POST" }));
    expect({ status: res.status, code: ((await res.json()) as { error?: { code?: string } }).error?.code }).toEqual({ status: 404, code: "not_found" });
  }, 30_000);
});
