// Поведенческие тесты на данных и маршрутах (internal-репо, AI-обзор): «без
// прав не раскрывается», пустое состояние и число выборки – на данных.
// SourceCraft – локальный мок харнесса, живых запросов нет.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { favoriteAddedText, notOwnReason } from "../src/web/format";
import { scoreHistoryView } from "../src/web/slots";
import { makeApiDb, seedRepo, seedScan } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "v53-review-secret-0123456789abcdef-xyz";

// internal-репо: код виден токену (repo GET 200), CI 403, AppSec «скана нет» 404
const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "reviewer" });
  if (p === "/v1/scans/latest") return Response.json({ error: "no scans" }, { status: 404 });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (/^\/repos\/[^/]+\/[^/]+\/cicd\/runs$/.test(p)) return Response.json({ error: "denied" }, { status: 403 });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) return Response.json({ id: `gid-${repo[1]}-${repo[2]}`, name: repo[2], visibility: "internal" });
  return null;
});

let server: SpawnedServer | null = null;
let dir = "";
let cookie = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rh-v53-review-"));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const wrap = { db, close: () => {} };
  const id = seedRepo(wrap, { org: "inner", repo: "code-only" });
  db.query("UPDATE repos SET visibility = 'internal' WHERE id = ?").run(id);
  const userId = upsertUser(db, "ya-review", "reviewer");
  cookie = createSession(db, SECRET, userId);
  db.close();
  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating" } });
  const pat = await fetch(`${server.base}/api/me/pat`, {
    method: "PUT",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ token: "review-token-123456" }),
  });
  expect(pat.status).toBe(200);
}, 90_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  // Windows держит файл БД за процессом сервера (EBUSY) — уборка tmp не проверка
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server!.base}${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("ревью В5.3: AI-обзор без прав на CI/CD и Безопасность не запускается (внутренний репо «свой» по коду)", () => {
  test("POST /summary — 403 no_full_access, заявки нет", async () => {
    const res = await call("POST", "/api/repos/inner/code-only/summary");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_full_access");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'summary'").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);

});

describe("ревью В5.3: число и пустые состояния на данных", () => {
  const pt = (scanId: number, idx: number | null) => ({ scanId, finishedAt: `2026-09-2${scanId}T10:00:00Z`, healthcraftIndex: idx, indexCoverage: 1, repoHealthScore: null, modelVersion: "x", headSha: null, codeEmpty: false });

  // UX 17.10: подписи «по N анализам» под графиком больше нет — легенда называет только линии
  test("график строится по анализам с числом индекса, а не по всем точкам", () => {
    const view = scoreHistoryView({ points: [pt(1, 70), pt(2, null), pt(3, 72), pt(4, null), pt(5, null)] as never, fullOpen: false });
    expect(view.chart).toBe(true);
    expect(scoreHistoryView({ points: [pt(1, 70), pt(2, null)] as never, fullOpen: false }).chart).toBe(false);
  });

  test("избранное вне каталога: причина по результату проверки прав", () => {
    expect(notOwnReason(null)).toContain("еще не проверены");
    // UX 17.10: «ночной обход» → «ночной анализ каталога»
    expect(notOwnReason({ visibility: "public", own: false })).toContain("после ночного анализа каталога");
    expect(notOwnReason({ visibility: "internal", own: false })).toContain("нет доступа к коду");
  });

  test("тост звезды: без видимости репозиторий не называется закрытым", () => {
    const check = { status: "ok", enqueue: { status: "skipped", code: "not_own" } } as never;
    expect(favoriteAddedText(check, undefined)).not.toContain("закрытые");
    expect(favoriteAddedText(check, "public")).toContain("ночной анализ каталога");
    expect(favoriteAddedText(check, "private")).toContain("закрытые");
  });
});
