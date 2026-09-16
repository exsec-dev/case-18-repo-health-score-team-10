// audit-m4-repro.test.ts — воспроизведение CRITICAL/HIGH находок аудит-пары
// В4 (reports/2026-09-17-m4-audit-pair.md). Каждый тест описывает
// ПРАВИЛЬНОЕ поведение, поэтому на текущем коде он красный.
// По умолчанию тесты помечены test.failing: набор зелёный, пока баг жив,
// и «краснеет», как только баг починен, — сигнал снять пометку.
// Строгий режим (видно реальные падения): AUDIT_STRICT=1 bun test tests/audit-m4-repro.test.ts
// Сети нет: сервер без токенов, REST/каталог — локальный мок, git/AppSec — фейки.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { openDb } from "../src/db";
import { okFact } from "../src/collectors/facts";
import { makeScClient } from "../src/collectors/http";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { effectiveCloneLimits, parseUserScanSettings, UNLIMITED_TIMEOUT_MS } from "../src/auth/settings";
import { runScan, type ScanDeps, type ScanOptions } from "../src/jobs/runner";
import { claimNext, enqueueScan, nightlyCatalog, processJob } from "../src/jobs/scheduler";
import { MODEL_VERSION } from "../src/score/model";
import { seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const repro = process.env.AUDIT_STRICT ? test : test.failing;
const ROOT = join(import.meta.dir, "..");
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDb(): { dir: string; t: ApiTestDb } {
  const dir = mkdtempSync(join(tmpdir(), "rh-audit-"));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t: ApiTestDb = { db, close: () => db.close() };
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, t };
}

function insertRepo(db: Database, org: string, repo: string, visibility: string): number {
  const r = db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES (?, ?, ?)").run(org, repo, visibility);
  return Number(r.lastInsertRowid);
}

const APPSEC_VALUE = { severity_counts: { critical: 2, high: 7, medium: 74, low: 457 }, resolved_share: 0.8, secrets_critical: true };

// ---------------------------------------------------------------------------
describe("C1: own-результаты не привязаны к пользователю", () => {
  repro(
    "чужой пользователь (свой Я ID, без PAT, без прав) НЕ получает own-карточку приватного репо",
    async () => {
      const { dir, t } = tempDb();
      const secret = "audit-test-secret";
      const owner = upsertUser(t.db, "ya-owner", "owner");
      const stranger = upsertUser(t.db, "ya-stranger", "stranger");
      const repoId = insertRepo(t.db, "acme", "secret-repo", "private");
      const scanId = seedScan(t, repoId, { facts: [{ key: "appsec.findings", value: APPSEC_VALUE }] });
      seedScore(t, repoId, scanId, { total: 42 }); // скан владельца на его PAT
      createSession(t.db, secret, owner);
      const strangerCookie = createSession(t.db, secret, stranger);
      t.close();

      const port = 41000 + Math.floor(Math.random() * 9000);
      const server = Bun.spawn(["bun", "run", join(ROOT, "src/server.ts")], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: dir,
          APP_SECRET: secret,
          SOURCECRAFT_TOKEN: "", // без серверного токена: ни каталога, ни REST
          YA_CLIENT_ID: "",
          YA_CLIENT_SECRET: "",
          SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(`${base}/api/me`)).ok) break;
          } catch {}
          await Bun.sleep(100);
        }
        const res = await fetch(`${base}/api/me/repos/acme/secret-repo`, {
          headers: { cookie: `${SESSION_COOKIE}=${strangerCookie}` },
        });
        const body = await res.text();
        // правильно: отказ (403/404) и ни байта данных AppSec владельца
        expect({ ok: res.ok, leaksAppsec: body.includes("severity_counts") }).toEqual({ ok: false, leaksAppsec: false });
      } finally {
        server.kill();
        await server.exited;
      }
    },
    30_000,
  );

  repro("scores/scans хранят автора own-скана (иначе «последний own» — чей угодно)", () => {
    const { t } = tempDb();
    const cols = (table: string) => (t.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const hasOwner = cols("scores").includes("user_id") || cols("scans").includes("user_id");
    t.close();
    expect(hasOwner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("H1: own-скан с узким PAT эвиктирует публичный репо", () => {
  repro("403 на repo-GET по PAT юзера НЕ снимает чужой публичный репо с рейтинга", async () => {
    const { t } = tempDb();
    const user = upsertUser(t.db, "ya-griefer", "griefer");
    const repoId = insertRepo(t.db, "popular", "project", "public");
    const config: Config = { ...loadConfig(), auth: { ...loadConfig().auth, appSecret: "audit-test-secret" } };

    // настоящий runScan; фейки — только сетевые каналы (git ок, REST: repo-GET 403 по PAT юзера)
    const realRunScan = (d: ScanDeps, slug: string, o: ScanOptions) =>
      runScan(
        {
          ...d,
          collectGit: async () => ({ facts: [okFact("tree.stats", { file_count: 10, loc: 500 }, "git")] }),
          collectRest: async () => ({
            facts: [],
            repoMeta: null,
            channelErrors: [{ resource: "repo", kind: "access", status: 403 }],
          }),
          collectAppsec: async () => ({ fact: null, noData: { reason: "access", detail: "403" } }),
        },
        slug,
        o,
      );
    const jobId = enqueueScan(t.db, repoId, { mode: "own", userId: user, triggerKind: "user" });
    const job = claimNext(t.db)!;
    expect(job.id).toBe(jobId);
    await processJob({ db: t.db, config, scClient: null, runScan: realRunScan as typeof runScan, getPat: () => "narrow-pat" }, job);

    const row = t.db.query("SELECT rating_active FROM repos WHERE id = ?").get(repoId) as { rating_active: number };
    t.close();
    expect(row.rating_active).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("H2: серверный REST-клиент с бюджетом на весь процесс", () => {
  repro("после budget запросов сканов ночной обход каталога всё ещё работает", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/repos") {
          return Response.json({
            repositories: [{ organization: { slug: "o" }, slug: "r", name: "r", visibility: "public", last_updated: "2026-09-01T00:00:00Z", language: null, rating: null }],
            next_page_token: "",
          });
        }
        return Response.json({});
      },
    });
    try {
      const config = loadConfig();
      // ровно как src/server.ts:254-256 (интервал обнулён ради скорости теста)
      const serverClient = makeScClient({
        token: "x",
        baseUrl: `http://127.0.0.1:${mock.port}`,
        minIntervalMs: 0,
        maxRequests: config.scan.rest.budget,
      });
      // публичные сканы воркера: ~23 REST-запроса на репо (приёмка В4: 322 на 14 репо)
      // → бюджет 1000 = ~43 скана с момента старта сервера
      for (let i = 0; i < config.scan.rest.budget; i++) await serverClient.get("/repos/o/r");
      const { t } = tempDb();
      const nightly = await nightlyCatalog(t.db, serverClient);
      t.close();
      expect({ ok: nightly.ok, error: nightly.error }).toEqual({ ok: true, error: undefined });
    } finally {
      mock.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("H3: rescore-m4.ts затирает own-скоры", () => {
  // В4.1 (К1): режима в хранении нет — одна строка оценки на скан с двумя
  // итогами. Утверждение находки сохранено: пересчёт не теряет данных
  // скана с PAT (строка на каждый скан, полный итог с Security на месте) и
  // не выносит его AppSec-факты на карточку зрителя без доступа.
  repro(
    "пересчёт не теряет оценку скана с PAT и не выносит его факты на публичную карточку",
    async () => {
      const { dir, t } = tempDb();
      const repoId = insertRepo(t.db, "pub", "repo", "public");
      const publicScan = seedScan(t, repoId, { facts: [{ key: "tree.stats", value: { file_count: 10, loc: 500 } }] });
      seedScore(t, repoId, publicScan, { total: 60 });
      // позже пользователь сделал скан на своём PAT (AppSec-данные)
      const ownScan = seedScan(t, repoId, {
        facts: [
          { key: "tree.stats", value: { file_count: 10, loc: 500 } },
          { key: "appsec.findings", value: APPSEC_VALUE },
        ],
      });
      seedScore(t, repoId, ownScan, { total: 90 });
      t.close();

      const proc = Bun.spawn([process.execPath, join(ROOT, "scripts/rescore-m4.ts")], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dir, SOURCECRAFT_TOKEN: "" },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(0);

      const db = openDb({ ...loadConfig(), dataDir: dir });
      const scans = (db.query("SELECT COUNT(*) AS c FROM scans").get() as { c: number }).c;
      const rows = (db.query("SELECT COUNT(*) AS c FROM scores WHERE model_version = ?").get(MODEL_VERSION) as { c: number }).c;
      const ownRow = db.query("SELECT categories FROM scores WHERE scan_id = ?").get(ownScan) as { categories: string };
      const ownSecurity = (JSON.parse(ownRow.categories) as { security: { score: number | null } }).security.score;
      const { getRepoCard } = await import("../src/api/repos");
      const card = getRepoCard(db, "pub", "repo")!;
      db.close();
      expect({
        rowsPerScan: rows === scans,
        userScanKeepsSecurity: ownSecurity !== null,
        publicCardShowsAppsec: card.evidence.some((e) => e.key === "appsec.findings"),
      }).toEqual({ rowsPerScan: true, userScanKeepsSecurity: true, publicCardShowsAppsec: false });
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
describe("H4: DoS одним пользователем", () => {
  repro("«снять лимит» не обходится явным числом: таймаут клона ≤ серверного потолка", () => {
    const parsed = parseUserScanSettings({ useDefaults: false, maxBytes: null, timeoutMs: 1e300 });
    expect(parsed.ok).toBe(true); // валидатор принимает
    if (!parsed.ok) return;
    const limits = effectiveCloneLimits(loadConfig().scan, parsed.settings);
    expect(limits.timeoutMs).toBeLessThanOrEqual(UNLIMITED_TIMEOUT_MS); // потолок «6 ч» из settings.ts
  });

  repro("повторные заявки одного юзера на один репо не множат очередь и не отодвигают периодику", () => {
    const { t } = tempDb();
    const user = upsertUser(t.db, "ya-spammer", "spammer");
    const other = insertRepo(t.db, "some", "periodic", "public");
    const target = insertRepo(t.db, "huge", "repo", "public");
    enqueueScan(t.db, other, { mode: "public", triggerKind: "periodic" }); // стоит первым
    // как POST /api/me/repos/huge/repo/scan × 50 (маршрут зовёт enqueueScan без проверок)
    for (let i = 0; i < 50; i++) enqueueScan(t.db, target, { mode: "own", userId: user, triggerKind: "user" });
    const queued = (t.db.query("SELECT COUNT(*) AS c FROM jobs WHERE repo_id = ? AND status = 'queued'").get(target) as { c: number }).c;
    // сколько заявок пройдёт раньше периодической job, стоявшей первой
    let before = 0;
    for (let job = claimNext(t.db); job && job.slug !== "some/periodic"; job = claimNext(t.db)) before++;
    t.close();
    expect({ queued, claimedBeforePeriodic: before }).toEqual({ queued: 1, claimedBeforePeriodic: 1 });
  });
});
