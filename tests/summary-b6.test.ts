// Публичный API и badge: только публичные rating_active;
// приватный/эвицтированный/несуществующий — 404 неотличимо; в SVG только
// число/подпись/цвет; отдельный лимит; кэш-заголовки. Тесты утечек: в проекции нет
// evidence/timeline/AI-текстов.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { badgeColor, getPublicRepo, renderBadgeSvg } from "../src/api/public";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const dirs: string[] = [];
const servers: SpawnedServer[] = [];
const mocks: { stop(): void }[] = [];
const cleanupAll = async (): Promise<void> => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
afterAll(cleanupAll);

function freshDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}

const wrap = (db: Database) => ({ db, close: () => {} });

function seedRatedTriple(db: Database): void {
  const rated = seedRepo(wrap(db), { org: "v5", repo: "rated", title: "Rated", language: "Go", likes: 9 });
  const s1 = seedScan(wrap(db), rated, { facts: cardFacts(), finishedAt: "2026-09-01T00:00:00Z" });
  seedScore(wrap(db), rated, s1, { total: 40 });
  const s2 = seedScan(wrap(db), rated, { facts: cardFacts(), finishedAt: "2026-09-20T00:00:00Z" });
  seedScore(wrap(db), rated, s2, { total: 74 });
  db.query("UPDATE scans SET head_sha = 'f00dcaf' WHERE id = ?").run(s2);

  const priv = seedRepo(wrap(db), { org: "v5", repo: "hidden" });
  const sp = seedScan(wrap(db), priv, { facts: cardFacts() });
  seedScore(wrap(db), priv, sp, { total: 88 });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);

  const evicted = seedRepo(wrap(db), { org: "v5", repo: "gone" });
  const se = seedScan(wrap(db), evicted, { facts: cardFacts() });
  seedScore(wrap(db), evicted, se, { total: 90 });
  db.query("UPDATE repos SET rating_active = 0, evict_reason = 'test' WHERE id = ?").run(evicted);
}

describe("getPublicRepo: проекция и гейт публичности", () => {
  test("последний пригодный скан, публичные категории; приватный/эвицтированный/нет — null", () => {
    const { db } = freshDb("rh-v5b6-proj-");
    seedRatedTriple(db);
    const ok = getPublicRepo(db, "v5", "rated")!;
    expect(ok.healthcraftIndex).toBe(74); // последний пригодный, не первый
    expect(ok.headSha).toBe("f00dcaf");
    expect(ok.title).toBe("Rated");
    expect(Object.keys(ok.categories).sort()).toEqual(["activity", "code", "documentation", "issues"]);
    expect(getPublicRepo(db, "v5", "hidden")).toBeNull();
    expect(getPublicRepo(db, "v5", "gone")).toBeNull();
    expect(getPublicRepo(db, "v5", "nope")).toBeNull();
    // репо в рейтинге без сканов — честная пустая проекция (200, без числа)
    seedRepo(wrap(db), { org: "v5", repo: "fresh" });
    const fresh = getPublicRepo(db, "v5", "fresh")!;
    expect(fresh.healthcraftIndex).toBeNull();
    expect(fresh.scannedAt).toBeNull();
  });

  test("проекция не содержит ничего, кроме публичных чисел и меты (утечки)", () => {
    const { db } = freshDb("rh-v5b6-leak-");
    seedRatedTriple(db);
    const raw = JSON.stringify(getPublicRepo(db, "v5", "rated"));
    for (const forbidden of ["timeline", "events", "evidence", "ai", "README и CI", "appsec", "recommendations", "comments"]) {
      expect(raw.includes(forbidden)).toBe(false);
    }
  });
});

describe("badge SVG: только число, подпись, цвет", () => {
  test("цвет по шкале; n/a без данных; нет внешних адресов", () => {
    expect(badgeColor(80)).toBe("#2da44e");
    expect(badgeColor(55)).toBe("#bf8700");
    expect(badgeColor(10)).toBe("#cf222e");
    expect(badgeColor(null)).toBe("#8b8b8b");
    const svg = renderBadgeSvg(74);
    expect(svg).toContain(">74<");
    expect(svg).toContain("HealthCraft Index"); // подпись — имя показателя
    expect(/https?:\/\/(?!www\.w3\.org)/.test(svg)).toBe(false);
    expect(renderBadgeSvg(null)).toContain("n/a");
  });
});

describe("Маршруты /api/v1 на живом сервере", () => {
  test("200 с кэш-заголовком публичному; 404 неотличимо остальным; лимит срабатывает", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v5b6-routes-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    seedRatedTriple(db);
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock });
    servers.push(server);

    const api = await fetch(`${server.base}/api/v1/repos/v5/rated`);
    expect(api.status).toBe(200);
    expect(api.headers.get("cache-control")).toContain("max-age=");
    const proj = (await api.json()) as { healthcraftIndex: number; categories: Record<string, number> };
    expect(proj.healthcraftIndex).toBe(74);

    const badge = await fetch(`${server.base}/api/v1/repos/v5/rated/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get("content-type")).toContain("image/svg+xml");
    expect(badge.headers.get("cache-control")).toContain("max-age=");

    // неотличимый 404: три причины — одно тело, один статус, no-store
    const bodies = await Promise.all(
      ["hidden", "gone", "nope"].map(async (r) => {
        const res = await fetch(`${server.base}/api/v1/repos/v5/${r}/badge.svg`);
        return { status: res.status, body: await res.text(), cache: res.headers.get("cache-control") };
      }),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]!.status).toBe(404);
    expect(bodies[0]!.cache).toBe("no-store");
  }, 120_000);
});
