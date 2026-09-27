// Избранное, видимость internal и CSRF-гард:
// (1) репозиторий, которого SourceCraft не отдает токену, в избранное не
//     добавляется — ответ `repo_not_found`, строки нет; повторная звезда
//     на уже существующей записи ее не удаляет;
// (2) видимость `internal` (третье значение `Repository.Visibility` спеки
//     SourceCraft) доходит до прав строки, а не превращается в `unknown`;
// (3) CSRF-гард Origin на локальном стенде пропускает страницу самого
//     стенда на его фактическом PORT, даже если YA_REDIRECT_URI смотрит на
//     другой локальный порт; чужой Origin по-прежнему отклоняется.
// Живых запросов нет: SourceCraft – локальный мок харнесса. Ответ мока на
// несуществующий репо повторяет ответ живого SourceCraft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { appsecOn404, visibilityOf } from "../src/auth/access";
import type { FavoriteAccess } from "../src/api/me";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "v485-gate-secret-0123456789abcdef-xyz";

const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "gatetester" });
  // AppSec на «скана нет» отвечает 404, не проверяя права
  if (p === "/v1/scans/latest") return Response.json({ error: "no scans" }, { status: 404 });
  if (/^\/orgs\/[^/]+\/repos$/.test(p)) return Response.json({ repositories: [] });
  if (/^\/repos\/[^/]+\/[^/]+\/cicd\/runs$/.test(p)) return Response.json({ error: "denied" }, { status: 403 });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) {
    if (repo[1] === "ghost") {
      return Response.json({ error_code: "RepositoryNotFound", message: `repository#${repo[2]} does not exist` }, { status: 404 });
    }
    const body: Record<string, unknown> = { name: repo[2], visibility: repo[1] === "inner" ? "internal" : repo[1] === "priv" ? "private" : "public" };
    if (repo[2].startsWith("withid")) body.id = `gid-${repo[1]}-${repo[2]}`;
    return Response.json(body);
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

  // internal, код которого виден токену, – «свой» для анализа
  test("права строки internal-репо несут visibility internal; виден токену — «свой»", async () => {
    const res = await put("/api/me/favorites", { repository: "inner/team-repo" });
    expect(res.status).toBe(200);
    const row = (await favorites()).find((f) => f.org === "inner" && f.repo === "team-repo");
    expect(row?.access?.visibility).toBe("internal");
    expect(row?.access?.own).toBe(true);
  });
});

describe("закрытие В4.8.5 (ревью): AppSec 404 не делает чужой internal «своим»", () => {
  test("подтверждение «репо виден токену» — только у приватного", () => {
    expect(appsecOn404("denied", "private", "granted")).toBe("granted");
    expect(appsecOn404("denied", "internal", "granted")).toBe("denied");
    expect(appsecOn404("denied", "unknown", "granted")).toBe("denied");
    expect(appsecOn404("denied", "public", "granted")).toBe("denied");
    expect(appsecOn404("granted", "internal", "granted")).toBe("granted");
  });

  // Security у чужого internal не открывается (AppSec 404 не подтверждает
  // доступ), но «свой» определяется по доступу к коду: анализ ставится, AI-обзор нет
  test("internal-репо: CI 403, AppSec 404 — Security не открыт, но «свой» по коду, анализ не отказан как чужой", async () => {
    const res = await put("/api/me/favorites", { repository: "inner/withid-team" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { check: { enqueue: { status: string; code: string | null } | null } };
    expect(body.check.enqueue?.code).not.toBe("not_own");
    const row = (await favorites()).find((f) => f.org === "inner" && f.repo === "withid-team");
    expect(row?.access?.visibility).toBe("internal");
    expect(row?.access?.appsec).toBe(false);
    expect(row?.access?.own).toBe(true);
  });

  test("приватный, видимый токену, при AppSec 404 — по-прежнему «свой» (правило Ф1.4 не сломано)", async () => {
    await put("/api/me/favorites", { repository: "priv/withid-mine" });
    const row = (await favorites()).find((f) => f.org === "priv" && f.repo === "withid-mine");
    expect(row?.access?.visibility).toBe("private");
    expect(row?.access?.own).toBe(true);
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

  test("настоящий дефолт: YA_REDIRECT_URI не задан, .env нет, стенд не на 8418 — своя страница проходит гард", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rh-gate-default-"));
    dirs.push(cwd);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
      DATA_DIR: cwd,
      PORT: String(port),
      PROCESS_ROLE: "rating",
      SCHEDULER_START_DELAY_MS: "86400000",
      APP_SECRET: SECRET,
      SOURCECRAFT_TOKEN: "",
      SOURCECRAFT_API_BASE: mock.url,
      APPSEC_API_BASE: mock.url,
      SOURCECRAFT_GIT_BASE: mock.url,
      YA_OAUTH_BASE: mock.url,
      YA_LOGIN_BASE: mock.url,
    };
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts")], { cwd, env, stdout: "ignore", stderr: "ignore" });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
        } catch {
          await Bun.sleep(100);
        }
      }
      expect(up).toBe(true);
      const own = await fetch(`http://127.0.0.1:${port}/api/me/pat`, {
        method: "PUT",
        headers: { origin: `http://localhost:${port}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(own.status).toBe(401);
      const evil = await fetch(`http://127.0.0.1:${port}/api/me/pat`, {
        method: "PUT",
        headers: { origin: "http://localhost.evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(evil.status).toBe(403);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);

  test("чужой Origin по-прежнему 403", async () => {
    const res = await fetch(`${otherPortServer!.base}/api/me/pat`, {
      method: "PUT",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
