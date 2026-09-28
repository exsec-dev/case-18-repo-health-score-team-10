// Публичный API /api/v1/*: CORS на все ответы (200, 400, 404, 429) и OPTIONS без
// лимита; остальные /api/* – без CORS. Лимит 120 запросов в минуту считается по
// первому адресу X-Forwarded-For, если соединение пришло от прокси (тест
// подключается с 127.0.0.1 – как прокси из частной сети).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const dirs: string[] = [];
const servers: SpawnedServer[] = [];
const mocks: { stop(): void }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<SpawnedServer> {
  const dir = mkdtempSync(join(tmpdir(), "rh-cors-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t = { db, close: () => {} };
  const id = seedRepo(t, { org: "cors", repo: "open", language: "Go" });
  const facts = [{ key: "tree.stats", source: "git", value: { top_level: [], file_count: 3, bytes: 100, source_loc: 5000 } }];
  seedScore(t, id, seedScan(t, id, { facts }), { total: 75 });
  db.close();
  const mock = startMockApi();
  mocks.push(mock);
  const server = await spawnServer({ dataDir: dir, mock });
  servers.push(server);
  return server;
}

describe("CORS публичного API", () => {
  test("Access-Control-Allow-Origin: * у JSON, бейджа, 400, 404 и OPTIONS; у внутренних /api/* – нет", async () => {
    const server = await start();
    const v1 = (path: string, init?: RequestInit) => fetch(`${server.base}/api/v1/repos/${path}`, init);
    const origin = { headers: { origin: "https://example.org" } };

    const json = await v1("cors/open", origin);
    expect(json.status).toBe(200);
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(json.headers.get("access-control-allow-credentials")).toBeNull();
    expect(((await json.json()) as { healthcraftIndex: number }).healthcraftIndex).toBe(75);

    const badge = await v1("cors/open/badge.svg", origin);
    expect(badge.status).toBe(200);
    expect(badge.headers.get("access-control-allow-origin")).toBe("*");

    for (const res of [await v1("cors/nope", origin), await v1("cors/nope/badge.svg", origin), await fetch(`${server.base}/api/v1/unknown`, origin)]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const badStyle = await v1("cors/open/badge.svg?style=flat", origin);
    expect(badStyle.status).toBe(400);
    expect(badStyle.headers.get("access-control-allow-origin")).toBe("*");

    const pre = await v1("cors/open", { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");

    // внутренний API интерфейса зависит от cookie зрителя – CORS не открыт
    const internal = await fetch(`${server.base}/api/repos`, origin);
    expect(internal.headers.get("access-control-allow-origin")).toBeNull();
  }, 120_000);

  test("лимит 120 в минуту – по первому адресу X-Forwarded-For от прокси; 429 тоже с CORS", async () => {
    const server = await start();
    const get = (xff: string) => fetch(`${server.base}/api/v1/repos/cors/open`, { headers: { "x-forwarded-for": xff } });
    for (let i = 0; i < 120; i++) expect((await get("203.0.113.5")).status).toBe(200);
    const over = await get("203.0.113.5");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(over.headers.get("access-control-allow-origin")).toBe("*");
    // другой клиент – свое окно; ключ – первый адрес цепочки
    expect((await get("203.0.113.6")).status).toBe(200);
    expect((await get("203.0.113.5, 203.0.113.6")).status).toBe(429);
    // OPTIONS лимит не расходует и не упирается в него
    const pre = await fetch(`${server.base}/api/v1/repos/cors/open`, { method: "OPTIONS", headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(pre.status).toBe(204);
  }, 120_000);
});
