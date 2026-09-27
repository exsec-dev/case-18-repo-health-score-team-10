// Свои лимиты: штатное использование не упирается в окна. Список «Моих
// репозиториев» – 30 чтений в минуту, мутации избранного возвращают обновленную
// запись строки (список не перечитывается целиком), отказ 400 окно не
// списывает, каждый 429 несёт `Retry-After`. Окно проб PAT остаётся.
// Настоящий сервер харнесса, локальный мок; живых запросов нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { storePat } from "../src/auth/pat";
import { listMyRepos, type MyRepoEntry } from "../src/api/me";
import { seedRepo, seedScan, seedScore, cardFacts, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "v485-limits-secret-0123456789abcdef-xyz";
const dir = mkdtempSync(join(tmpdir(), "rh-v485-b4-"));
const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "lim" });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (/\/cicd\/runs$/.test(p)) return Response.json({ runs: [] });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) return Response.json({ name: repo[2], visibility: "private" });
  return null;
});
let server: SpawnedServer | null = null;
let tight: SpawnedServer | null = null;
const tightDir = mkdtempSync(join(tmpdir(), "rh-v485-b4t-"));
const cookies: Record<string, string> = {};
const userIds: Record<string, number> = {};

function seedUsers(dataDir: string, names: string[], withPat: string[]): void {
  const db = openDb({ ...loadConfig(), dataDir });
  const t: ApiTestDb = { db, close: () => db.close() };
  const pub = seedRepo(t, { org: "pub", repo: "repo" });
  seedScore(t, pub, seedScan(t, pub, { facts: cardFacts() }), { total: 60 });
  for (const name of names) {
    const id = upsertUser(db, `ya-${name}`, name);
    userIds[name] = id;
    cookies[name] = createSession(db, SECRET, id);
    if (withPat.includes(name)) storePat(db, SECRET, id, `pat-${name}-00000`);
  }
  db.close();
}

beforeAll(async () => {
  seedUsers(dir, ["busy", "typo"], ["busy", "typo"]);
  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating" } });
  // второй сервер с маленькими окнами — у каждого 429 проверяется Retry-After
  seedUsers(tightDir, ["t"], ["t"]);
  tight = await spawnServer({
    dataDir: tightDir,
    mock,
    appSecret: SECRET,
    env: {
      PROCESS_ROLE: "rating",
      QUEUE_CARD_PER_MINUTE: "1",
      QUEUE_MY_REPOS_PER_MINUTE: "1",
      QUEUE_FAVORITES_MUTATIONS_PER_MINUTE: "1",
      QUEUE_USER_SCANS_PER_HOUR: "1",
    },
  });
}, 90_000);

afterAll(async () => {
  if (server) await server.stop();
  if (tight) await tight.stop();
  mock.stop();
  for (const d of [dir, tightDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows EBUSY */
    }
  }
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...((init.headers as Record<string, string>) ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` },
});

describe("К8.5.7: штатное использование кабинета не упирается в свои лимиты", () => {
  test("10 действий на «Моих репозиториях» за минуту (добавить, убрать, прочитать список) — ни одного 429", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      statuses.push((await fetch(`${server!.base}/api/me/favorites/busy/r${i}`, as("busy", { method: "PUT" }))).status);
      statuses.push((await fetch(`${server!.base}/api/me/repos`, as("busy"))).status);
    }
    for (let i = 1; i <= 3; i++) statuses.push((await fetch(`${server!.base}/api/me/favorites/busy/r${i}`, as("busy", { method: "DELETE" }))).status);
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${server!.base}/api/me/repos`, as("busy"))).status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  }, 60_000);

  test("мутация избранного возвращает обновленную запись строки — она равна строке списка", async () => {
    const res = await fetch(`${server!.base}/api/me/favorites`, as("busy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "busy/one" }) }));
    const body = (await res.json()) as { entry: MyRepoEntry; check: { status: string } };
    const db = openDb({ ...loadConfig(), dataDir: dir });
    try {
      const row = (await listMyRepos(db, userIds.busy!)).entries.find((e) => e.repo === "one");
      expect({ status: res.status, entry: body.entry, check: body.check.status }).toEqual({ status: 200, entry: row!, check: "checked" });
    } finally {
      db.close();
    }
  }, 60_000);

  test("С3-4: 31 неверный ввод «Добавить» (400) окно мутаций не списывает — звезда после них работает", async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 31; i++) {
      const r = await fetch(`${server!.base}/api/me/favorites`, as("typo", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "https://x/only-one" }) }));
      codes.add(r.status);
    }
    const star = await fetch(`${server!.base}/api/me/favorites/typo/ok`, as("typo", { method: "PUT" }));
    expect({ codes: [...codes], star: star.status }).toEqual({ codes: [400], star: 200 });
  }, 60_000);
});

describe("К8.5.7 (С9-14): каждый 429 несет Retry-After", () => {
  const retryAfter = async (res: Response) => ({ status: res.status, retryAfter: Number(res.headers.get("retry-after")) });
  test("карточка, список, мутации избранного, запуск анализа", async () => {
    const at = (p: string) => `${tight!.base}${p}`;
    await fetch(at("/api/repos/pub/repo"), as("t"));
    const card = await retryAfter(await fetch(at("/api/repos/pub/repo"), as("t")));
    await fetch(at("/api/me/repos"), as("t"));
    const list = await retryAfter(await fetch(at("/api/me/repos"), as("t")));
    await fetch(at("/api/me/favorites/t/a"), as("t", { method: "PUT" }));
    const fav = await retryAfter(await fetch(at("/api/me/favorites/t/b"), as("t", { method: "PUT" })));
    // свой приватный (мок) — запуск ставится, второй в час — 429
    await fetch(at("/api/me/repos/t/s1/scan"), as("t", { method: "POST" }));
    const scan = await retryAfter(await fetch(at("/api/me/repos/t/s2/scan"), as("t", { method: "POST" })));
    for (const r of [card, list, fav, scan]) {
      expect(r.status).toBe(429);
      expect(r.retryAfter).toBeGreaterThan(0);
    }
    expect(card.retryAfter).toBeLessThanOrEqual(60);
    expect(scan.retryAfter).toBeLessThanOrEqual(3600);
  }, 60_000);
});
