// routes.test.ts — В4.1: HTTP-контракт роутов настоящего сервера (сервер во
// временном каталоге, как C1 в audit-m4-repro). Сети нет: серверный токен
// пустой, планировщик отложен на сутки, зритель без PAT — ноль живых
// запросов. APP_SECRET инъектируется в env процесса (не из .env).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { cardFacts, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const ROOT = join(import.meta.dir, "..");
const SECRET = "routes-test-secret";
const dir = mkdtempSync(join(tmpdir(), "rh-routes-"));
const port = 42000 + Math.floor(Math.random() * 8000);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn> | null = null;
let strangerCookie = "";

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t: ApiTestDb = { db, close: () => db.close() };
  const RUNS = { last_status: "failed", success_rate: 0.5, duration_p50: 100, runs_count: 41 };
  const APPSEC = { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true };
  for (const [org, repo, visibility] of [
    ["pub", "repo", "public"],
    ["acme", "secret-repo", "private"],
  ] as const) {
    const repoId = seedRepo(t, { org, repo });
    db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, repoId);
    const facts = cardFacts().map((f) => (f.key === "cicd.runs" ? { key: "cicd.runs", source: "rest:cicd", value: RUNS } : f));
    const scanId = seedScan(t, repoId, { facts: [...facts, { key: "appsec.findings", source: "appsec:api", value: APPSEC }] });
    seedScore(t, repoId, scanId, { total: 60, totalFull: 49 });
    seedRecommendation(t, scanId, { ruleId: "fix-red-runs", priority: 1, factRef: "cicd.runs", channel: "cicd" });
  }
  const stranger = upsertUser(db, "ya-stranger", "stranger");
  strangerCookie = createSession(db, SECRET, stranger);
  db.close();

  server = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      APP_SECRET: SECRET,
      SOURCECRAFT_TOKEN: "",
      YA_CLIENT_ID: "",
      YA_CLIENT_SECRET: "",
      SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
}, 30_000);

afterAll(async () => {
  if (server) {
    server.kill();
    await server.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

const asStranger = { headers: { cookie: `${SESSION_COOKIE}=${strangerCookie}` } };

describe("роуты единой карточки (К2)", () => {
  test("GET /api/me/repos/:org/:repo удалён → JSON-404", async () => {
    const res = await fetch(`${base}/api/me/repos/x/y`, asStranger);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("/me/repo/x/y — фронт-бандл (роутер отдаёт not-found), а не карточка", async () => {
    const res = await fetch(`${base}/me/repo/pub/repo`, asStranger);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const leak of ["severity_counts", "runs_count", "totalRating"]) expect(html).not.toContain(leak);
  });

  test("приватный репо: аноним и вошедший без PAT получают 404 без данных (карточка и .md)", async () => {
    for (const init of [{}, asStranger]) {
      for (const path of ["/api/repos/acme/secret-repo", "/api/repos/acme/secret-repo/report.md"]) {
        const res = await fetch(`${base}${path}`, init);
        const body = await res.text();
        expect(res.status).toBe(404);
        expect(body).not.toContain("severity_counts");
        expect(body).not.toContain("runs_count");
      }
    }
  });

  test("публичный репо зрителю без PAT: Score в рейтинге есть, данных CI/Security нет (JSON и .md)", async () => {
    const res = await fetch(`${base}/api/repos/pub/repo`, asStranger);
    expect(res.status).toBe(200);
    const text = await res.text();
    const card = JSON.parse(text) as { access: unknown; score: { totalRating: number; totalFull: number | null; fullLocked: boolean } };
    expect(card.access).toEqual({ cicd: "no-pat", appsec: "no-pat" });
    expect(card.score.totalRating).toBe(60);
    expect(card.score.totalFull).toBeNull();
    expect(card.score.fullLocked).toBe(true);
    for (const leak of ["severity_counts", "runs_count", "fix-red-runs"]) expect(text).not.toContain(leak);
    const md = await (await fetch(`${base}/api/repos/pub/repo/report.md`)).text();
    for (const leak of ["severity_counts", "runs_count", "fix-red-runs"]) expect(md).not.toContain(leak);
  });
});
