// v485-gate.test.ts — замечания гейта В4.8.5 (Екатерина, 22.09):
// (1) репозиторий, которого SourceCraft не отдает токену, в избранное не
//     добавляется — ответ `repo_not_found`, строки нет; повторная звезда
//     на уже существующей записи ее не удаляет;
// (2) видимость `internal` (третье значение `Repository.Visibility` спеки
//     SourceCraft) доходит до прав строки, а не превращается в `unknown`;
// (3) CSRF-гард Origin на локальном стенде пропускает страницу самого
//     стенда на его фактическом PORT, даже если YA_REDIRECT_URI смотрит на
//     другой локальный порт; чужой Origin по-прежнему отклоняется.
// Живых запросов нет: SourceCraft — локальный мок харнесса. Ответ мока на
// несуществующий репо повторяет живой зонд 22.09 (TASK.md §6).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { visibilityOf } from "../src/auth/access";
import type { FavoriteAccess } from "../src/api/me";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "v485-gate-secret-0123456789abcdef-xyz";

const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "gatetester" });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (/^\/repos\/[^/]+\/[^/]+\/cicd\/runs$/.test(p)) return Response.json({ error: "denied" }, { status: 403 });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    if (repo[1] === "ghost") {
      return Response.json({ error_code: "RepositoryNotFound", message: `repository#${repo[2]} does not exist` }, { status: 404 });
    }
    return Response.json({ name: repo[2], visibility: repo[1] === "inner" ? "internal" : "public" });
  }
  return null;
});

let server: SpawnedServer | null = null;
let otherPortServer: SpawnedServer | null = null;
const dirs: string[] = [];
let cookie = "";

function freshDir(): { dir: string; cookie: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-gate-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const userId = upsertUser(db, "ya-gate", "gate");
  const c = createSession(db, SECRET, userId);
  db.close();
  return { dir, cookie: c };
}

beforeAll(async () => {
  const a = freshDir();
  cookie = a.cookie;
  server = await spawnServer({ dataDir: a.dir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating" } });
  const b = freshDir();
  // redirect на другой локальный порт — как стенд на своем PORT без YA_REDIRECT_URI
  otherPortServer = await spawnServer({
    dataDir: b.dir,
    mock,
    appSecret: SECRET,
    env: { PROCESS_ROLE: "rating", YA_REDIRECT_URI: "http://localhost:8418/auth/ya/callback" },
  });
  const pat = await fetch(`${server.base}/api/me/pat`, {
    method: "PUT",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "content-type": "application/json" },
    body: JSON.stringify({ token: "gate-token-123456" }),
  });
  expect(pat.status).toBe(200);
}, 90_000);

afterAll(async () => {
  if (server) await server.stop();
  if (otherPortServer) await otherPortServer.stop();
  mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const put = (path: string, body?: unknown) =>
  fetch(`${server!.base}${path}`, {
    method: "PUT",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const favorites = async (): Promise<{ org: string; repo: string; access: FavoriteAccess | null }[]> =>
  ((await (await fetch(`${server!.base}/api/me/favorites`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })).json()) as {
    entries: { org: string; repo: string; access: FavoriteAccess | null }[];
  }).entries;

describe("гейт В4.8.5: существование при добавлении", () => {
  test("«Добавить» несуществующего (ссылка с хвостом) — 404 repo_not_found, в избранном его нет", async () => {
    const res = await put("/api/me/favorites", { repository: "https://sourcecraft.dev/ghost/none/tree/main?x=1" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("repo_not_found");
    expect(body.error.message).toContain("не найден в SourceCraft");
    expect((await favorites()).some((f) => f.org === "ghost")).toBe(false);
  });

  test("звезда несуществующего — тот же отказ, строки нет", async () => {
    const res = await put("/api/me/favorites/ghost/star-none");
    expect(res.status).toBe(404);
    expect((await favorites()).some((f) => f.repo === "star-none")).toBe(false);
  });

  test("существующий — добавляется как раньше", async () => {
    const res = await put("/api/me/favorites", { repository: "pub/exists" });
    expect(res.status).toBe(200);
    expect((await favorites()).some((f) => f.org === "pub" && f.repo === "exists")).toBe(true);
  });
});

describe("гейт В4.8.5: видимость internal", () => {
  test("visibilityOf знает все три значения спеки", () => {
    expect(visibilityOf("public")).toBe("public");
    expect(visibilityOf("internal")).toBe("internal");
    expect(visibilityOf("private")).toBe("private");
    expect(visibilityOf("weird")).toBe("unknown");
  });

  test("права строки internal-репо несут visibility internal; «свой» по одной видимости не выводится", async () => {
    const res = await put("/api/me/favorites", { repository: "inner/team-repo" });
    expect(res.status).toBe(200);
    const row = (await favorites()).find((f) => f.org === "inner" && f.repo === "team-repo");
    expect(row?.access?.visibility).toBe("internal");
    expect(row?.access?.own).toBe(false);
  });
});

describe("гейт В4.8.5: Origin на фактическом порту стенда", () => {
  test("redirect смотрит на 8418, стенд на другом порту — своя страница проходит гард (401, не 403)", async () => {
    const base = otherPortServer!.base;
    const port = new URL(base).port;
    const res = await fetch(`${base}/api/me/pat`, {
      method: "PUT",
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("чужой Origin по-прежнему 403", async () => {
    const res = await fetch(`${otherPortServer!.base}/api/me/pat`, {
      method: "PUT",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
