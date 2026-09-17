// me.test.ts — В4.1: поверхность «мой кабинет» без HTTP-слоя.
// К3: запуск анализа юзером — repo-GET с PAT до постановки (200/403/404/
// 401/0/429/5xx), строка repos не создаётся без доступа (H1, LOW-3).
// Сети нет: REST-клиент — фейк с заданным статусом.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import type { ScClient } from "../src/collectors/http";
import { upsertUser } from "../src/auth/session";
import { requestUserScan } from "../src/api/me";

const dir = mkdtempSync(join(tmpdir(), "rh-me-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function statusClient(status: number, json: unknown = null): ScClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async get(path: string) {
      paths.push(path);
      return { status, json, bodyText: "" };
    },
    requestCount: () => paths.length,
  };
}

const QUEUE = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 100 };
const refusedOf = (userId: number) =>
  (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status = 'refused'").get(userId) as { c: number }).c;

const repoRow = (org: string, repo: string) =>
  db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
const jobsOf = (userId: number) => (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?").get(userId) as { c: number }).c;

describe("requestUserScan: предпроверка доступа PAT (К3)", () => {
  const user = upsertUser(db, "ya-scan", "scanner");

  test("200 → upsert repos (visibility из ответа) → заявка → 202", async () => {
    const client = statusClient(200, { id: "42", name: "Secret", visibility: "private" });
    const out = await requestUserScan(db, client, user, "acme", "secret", QUEUE);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ queued: true, slug: "acme/secret" });
    expect(client.paths).toEqual(["/repos/acme/secret"]);
    expect(repoRow("acme", "secret")?.visibility).toBe("private");
    const job = db.query("SELECT user_id, trigger_kind, status FROM jobs WHERE id = ?").get(out.body["jobId"] as number) as {
      user_id: number;
      trigger_kind: string;
      status: string;
    };
    expect(job).toEqual({ user_id: user, trigger_kind: "user", status: "queued" });
  });

  test("403 и 404 → 403 no_access; строка repos и заявка НЕ создаются; отказ учтён строкой refused (Ф1.6)", async () => {
    const before = jobsOf(user);
    const refusedBefore = refusedOf(user);
    for (const [status, slug] of [
      [403, "forbidden"],
      [404, "missing"],
    ] as const) {
      const out = await requestUserScan(db, statusClient(status), user, "other", slug, QUEUE);
      expect(out.status).toBe(403);
      expect((out.body["error"] as { code: string }).code).toBe("no_access");
      expect(repoRow("other", slug)).toBeNull();
    }
    expect(refusedOf(user)).toBe(refusedBefore + 2);
    // отказанные строки воркером не заявляются и в очереди не стоят
    expect((db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')").get(user) as { c: number }).c).toBe(before);
  });

  test("отказы учитываются лимитом частоты: после N отказов за час — 429 без сети", async () => {
    const u = upsertUser(db, "ya-prober", "prober");
    const limit = { userScansPerHour: 3, maxAttempts: 3, userActiveMax: 100 };
    for (let i = 0; i < 3; i++) expect((await requestUserScan(db, statusClient(404), u, "enum", `slug-${i}`, limit)).status).toBe(403);
    const client = statusClient(200, { visibility: "public" });
    const out = await requestUserScan(db, client, u, "enum", "real", limit);
    expect(out.status).toBe(429);
    expect(client.paths).toEqual([]);
  });

  test("401 → 401 pat_expired; 0/429/5xx → 503 check_failed; без постановки; отказ учтён строкой refused (круг 2, LOW-6)", async () => {
    const before = jobsOf(user);
    const refusedBefore = refusedOf(user);
    const expired = await requestUserScan(db, statusClient(401), user, "x", "expired", QUEUE);
    expect(expired.status).toBe(401);
    expect((expired.body["error"] as { code: string }).code).toBe("pat_expired");
    for (const status of [0, 429, 500, 503]) {
      const out = await requestUserScan(db, statusClient(status), user, "x", `flaky-${status}`, QUEUE);
      expect(out.status).toBe(503);
      expect((out.body["error"] as { code: string }).code).toBe("check_failed");
      expect(repoRow("x", `flaky-${status}`)).toBeNull();
    }
    expect(repoRow("x", "expired")).toBeNull();
    expect(refusedOf(user)).toBe(refusedBefore + 5);
    expect(jobsOf(user)).toBe(before + 5); // только refused-строки
    expect((db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')").get(user) as { c: number }).c).toBe(1);
  });

  test("too_many_active проверяется до сети (круг 2, LOW-6)", async () => {
    const u = upsertUser(db, "ya-active-cheap", "activecheap");
    const limit = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 1 };
    expect((await requestUserScan(db, statusClient(200, { visibility: "public" }), u, "cheap", "one", limit)).status).toBe(202);
    const client = statusClient(200, { visibility: "public" });
    const out = await requestUserScan(db, client, u, "cheap", "two", limit);
    expect({ status: out.status, code: (out.body["error"] as { code: string }).code, requests: client.paths.length }).toEqual({
      status: 429,
      code: "too_many_active",
      requests: 0,
    });
  });
});
