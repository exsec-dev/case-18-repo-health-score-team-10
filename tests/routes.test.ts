// routes.test.ts — В4.1: HTTP-контракт роутов настоящего сервера (сервер во
// временном каталоге, как C1 в audit-m4-repro). Сети нет: серверный токен
// пустой, планировщик отложен на сутки, зритель без PAT — ноль живых
// запросов. APP_SECRET инъектируется в env процесса (не из .env). В4.1-fix
// (Ф1.13): адреса API — локальный мок со счётчиком (server-harness.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { cardFacts, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "routes-test-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-routes-"));
const mock = startMockApi();
let base = "";
let server: SpawnedServer | null = null;
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
    seedScore(t, repoId, scanId, { total: 60 });
    seedRecommendation(t, scanId, { ruleId: "fix-red-runs", priority: 1, factRef: "cicd.runs", channel: "cicd" });
  }
  const stranger = upsertUser(db, "ya-stranger", "stranger");
  strangerCookie = createSession(db, SECRET, stranger);
  db.close();

  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET });
  base = server.base;
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
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

  test("GET/PUT /api/me/settings удалены (К5) → JSON-404", async () => {
    for (const method of ["GET", "PUT"]) {
      const res = await fetch(`${base}/api/me/settings`, { ...asStranger, method, body: method === "PUT" ? "{}" : undefined });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("/me/repo/x/y — фронт-бандл (роутер отдаёт not-found), а не карточка", async () => {
    const res = await fetch(`${base}/me/repo/pub/repo`, asStranger);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const leak of ["severity_counts", "runs_count", "totalRating", "repoHealthScore"]) expect(html).not.toContain(leak);
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
    const card = JSON.parse(text) as { access: unknown; score: { healthcraftIndex: number; repoHealthScore: number | null; fullLocked: boolean } };
    expect(card.access).toEqual({ cicd: "no-pat", appsec: "no-pat" });
    expect(card.score.healthcraftIndex).toBe(60);
    expect(card.score.repoHealthScore).toBeNull();
    expect(card.score.fullLocked).toBe(true);
    for (const leak of ["severity_counts", "runs_count", "fix-red-runs"]) expect(text).not.toContain(leak);
    const md = await (await fetch(`${base}/api/repos/pub/repo/report.md`)).text();
    for (const leak of ["severity_counts", "runs_count", "fix-red-runs"]) expect(md).not.toContain(leak);
  });
});

// ---------------------------------------------------------------------------
// В4.7 (П1): report.pdf — зеркало report.md: те же правила доступа и 404.
// ---------------------------------------------------------------------------

describe("В4.7: PDF-выгрузка по HTTP", () => {
  test("публичный репо: application/pdf, attachment с именем от слага, настоящий PDF", async () => {
    const res = await fetch(`${base}/api/repos/pub/repo/report.pdf`, asStranger);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="pub-repo-health.pdf"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 5))).toBe("%PDF-");
    // заголовки защиты — как у остальных ответов маршрутов
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("приватный репо: 404 как у .md — и анониму, и вошедшему без PAT", async () => {
    for (const init of [{}, asStranger]) {
      const [md, pdf] = await Promise.all([
        fetch(`${base}/api/repos/acme/secret-repo/report.md`, init),
        fetch(`${base}/api/repos/acme/secret-repo/report.pdf`, init),
      ]);
      expect({ md: md.status, pdf: pdf.status }).toEqual({ md: 404, pdf: 404 });
      expect(await pdf.json()).toEqual(await md.json());
    }
  });

  test("несуществующий репо — 404, кривой слаг — 400, как у .md", async () => {
    expect((await fetch(`${base}/api/repos/nope/nope/report.pdf`)).status).toBe(404);
    const bad = await fetch(`${base}/api/repos/a%25zz/b/report.pdf`);
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// В4.4 (кластер K): заголовки защиты на JSON-ответах + churn-лимит мутаций
// избранного. Отклонение (проверено воркером живьём): HTML-бандл Bun-маршрута
// заголовков не получает — механизм HTML-import не даёт управлять ответом.
// ---------------------------------------------------------------------------

describe("В4.4: security-заголовки и churn-лимит", () => {
  test("JSON-ответы несут X-Frame-Options/nosniff/Referrer-Policy", async () => {
    for (const path of ["/api/health", "/api/repos", "/api/no-such-endpoint"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  test("мутации избранного: 31-я за минуту → 429 rate_limited; GET не считается", async () => {
    // asStranger заморожен на module-load с пустым cookie — здесь нужен живой
    const as = { headers: { cookie: `${SESSION_COOKIE}=${strangerCookie}` } };
    expect(((await (await fetch(`${base}/api/me`, as)).json()) as { login: string | null }).login).toBe("stranger");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`${base}/api/me/favorites/two/repo-${i}`, { ...as, method: "PUT" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const body = (await (await fetch(`${base}/api/me/favorites/two/repo-0`, { ...as, method: "PUT" })).json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("rate_limited");
    // чтения лимит не расходуют
    const read = await fetch(`${base}/api/me/favorites`, as);
    expect(read.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Круг 2 В4.4 (Б5): Bun-внутренние ответы и серверный кап auth_error.
// ---------------------------------------------------------------------------

describe("Б5 (круг 2 В4.4): Bun-внутренние ответы и auth_error", () => {
  test("S-6: 500 упавшего хендлера несёт security-заголовки (опция error у Bun.serve)", async () => {
    // ломаем derived у карточки pub/repo: JSON.parse в хендлере бросает —
    // Bun вызывает error(), 500 обязан уйти с теми же заголовками
    const writer = openDb({ ...loadConfig(), dataDir: dir });
    writer
      .query("UPDATE scores SET derived = '{broken' WHERE repo_id = (SELECT id FROM repos WHERE org_slug = 'pub' AND repo_slug = 'repo')")
      .run();
    writer.close();
    const res = await fetch(`${base}/api/repos/pub/repo`);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal");
    // чиним обратно — общий сервер других тестов
    const fixer = openDb({ ...loadConfig(), dataDir: dir });
    fixer
      .query("UPDATE scores SET derived = ? WHERE repo_id = (SELECT id FROM repos WHERE org_slug = 'pub' AND repo_slug = 'repo')")
      .run(JSON.stringify({ commitsPerMonth: 12, mirrorLikeness: null }));
    fixer.close();
  });

  test("S-6 (отклонение, живая проверка): 405 метод-карты генерит сам Bun — без заголовков", async () => {
    // живой замер: GET-промах метод-карты уходит в HTML-шелл (отклонение 1
    // круга 1), а НЕ-GET (DELETE) даёт родной 405 Bun без хука. Перехват
    // потребовал бы перестройки таблицы маршрутов (несоразмерно) —
    // зафиксировано отклонением в отчёте воркера
    const notAllowed = await fetch(`${base}/auth/logout`, { method: "DELETE" });
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("x-frame-options")).toBeNull();
  });

  test("S-4: auth_error капается сервером до редиректа (200 символов, без управляющих)", async () => {
    const junk = `${"x".repeat(300)}\u0007\n<script>alert</script>`;
    const res = await fetch(`${base}/auth/ya/callback?error=${encodeURIComponent(junk)}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith("/me?auth_error=")).toBe(true);
    const echoed = decodeURIComponent(location.split("auth_error=")[1] ?? "");
    expect(echoed.length).toBeLessThanOrEqual(200);
    expect(echoed.includes("\u0007")).toBe(false);
    expect(echoed.includes("\n")).toBe(false);
  });
});
