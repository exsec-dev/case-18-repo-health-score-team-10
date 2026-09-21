// routes-auth.test.ts — Ф2.10 (M10 В4): маршруты `/auth/*` на НАСТОЯЩЕМ
// сервере с моком Я ID (шов адресов YA_OAUTH_BASE/YA_LOGIN_BASE, как
// Config.api в Ф1.13) и проверка «PAT не в ответах» по `/api/me*` и
// `/auth/*`. До этой вехи `/auth/*` не покрывались ни одним тестом, а
// «PAT не утекает» было приёмочным пунктом без теста.
//
// Сети нет: все внешние адреса сервера (REST, AppSec, git, Я ID) — один
// локальный Bun.serve-мок во временном DATA_DIR.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const SECRET = "routes-auth-test-secret-0123456789abcdef";
const PAT = "pat-must-never-appear-in-a-response";
const dir = mkdtempSync(join(tmpdir(), "rh-routes-auth-"));

/** Что мок Я ID отвечает на обмен кода — переключается тестом. */
const ya = { tokenStatus: 200, infoStatus: 200, yaId: 424242, login: "tester" };

const mock = startMockApi((req, url) => {
  const p = url.pathname;
  // --- Я ID ---
  if (p === "/token") {
    return ya.tokenStatus === 200
      ? Response.json({ access_token: "ya-access-token-value" })
      : Response.json({ error_description: "invalid_grant" }, { status: ya.tokenStatus });
  }
  if (p === "/info") {
    return ya.infoStatus === 200
      ? Response.json({ id: ya.yaId, login: ya.login, real_name: "Тест Тестов", default_avatar_id: "av-1" })
      : Response.json({ error: "nope" }, { status: ya.infoStatus });
  }
  // --- SourceCraft ---
  if (p === "/user") return Response.json({ username: "tester" });
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return Response.json({ id: "gid-1", name: "r", visibility: "public" });
  return null;
});

let server: SpawnedServer | null = null;

beforeAll(async () => {
  server = await spawnServer({
    dataDir: dir,
    mock,
    appSecret: SECRET,
    env: { YA_CLIENT_ID: "test-client-id", YA_CLIENT_SECRET: "test-client-secret" },
  });
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY: каталог подберёт ОС */
  }
});

const at = (path: string) => `${server!.base}${path}`;

/** Cookie из Set-Cookie по имени (значение до первой ';'). */
function cookieOf(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq) === name) return pair!.slice(eq + 1);
  }
  return null;
}

describe("Ф2.10 (M10): маршруты /auth/* с моком Я ID", () => {
  test("/auth/ya: 302 на адрес приложения Я ID из конфига + state-cookie", async () => {
    const res = await fetch(at("/auth/ya"), { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(mock.url); // шов адресов держит: боевой oauth.yandex.ru не зовётся
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    // state уехал и в cookie — иначе callback нечем сверять (CSRF)
    expect(res.headers.getSetCookie().join(";")).toContain("rh_oauth_state");
  });

  test("callback с валидным state: сессия создана, редирект на /me, вход работает", async () => {
    const start = await fetch(at("/auth/ya"), { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("rh_oauth_state="))!.split(";")[0]!;
    const res = await fetch(at(`/auth/ya/callback?code=good-code&state=${encodeURIComponent(state)}`), {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, server!.base).pathname).toBe("/me");
    const session = cookieOf(res, "rh_session");
    expect(session).toBeTruthy();
    const me = await fetch(at("/api/me"), { headers: { cookie: `rh_session=${session}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ login: "tester", displayName: "Тест Тестов" });
  });

  test("callback без совпадения state → /me?auth_error=state, сессии нет", async () => {
    const res = await fetch(at("/auth/ya/callback?code=good-code&state=forged"), { redirect: "manual" });
    const location = new URL(res.headers.get("location")!, server!.base);
    expect({ path: location.pathname, error: location.searchParams.get("auth_error") }).toEqual({ path: "/me", error: "state" });
    expect(cookieOf(res, "rh_session")).toBeNull();
  });

  test("Я ID отклонил код → /me?auth_error=<текст>, сессии нет", async () => {
    const start = await fetch(at("/auth/ya"), { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("rh_oauth_state="))!.split(";")[0]!;
    ya.tokenStatus = 400;
    try {
      const res = await fetch(at(`/auth/ya/callback?code=bad&state=${encodeURIComponent(state)}`), {
        redirect: "manual",
        headers: { cookie: stateCookie },
      });
      const location = new URL(res.headers.get("location")!, server!.base);
      expect(location.pathname).toBe("/me");
      // ПЕРЕВОРОТ (В4.8.5, К8.5.4, С1-6): причина — фразой языка продукта, не кодом провайдера
      expect(location.searchParams.get("auth_error")).toBe("Яндекс ID не подтвердил вход – попробуйте войти еще раз");
      expect(cookieOf(res, "rh_session")).toBeNull();
    } finally {
      ya.tokenStatus = 200;
    }
  });

  test("провайдер вернул ошибку в query (?error=access_denied) → auth_error без обращения к Я ID", async () => {
    const before = mock.requests.length;
    const res = await fetch(at("/auth/ya/callback?error=access_denied"), { redirect: "manual" });
    const location = new URL(res.headers.get("location")!, server!.base);
    expect(location.searchParams.get("auth_error")).toBe("access_denied");
    expect(mock.requests.length).toBe(before); // в сеть не ходили
  });

  test("POST /auth/logout: 204, cookie гасится, сессия больше не работает", async () => {
    const start = await fetch(at("/auth/ya"), { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("rh_oauth_state="))!.split(";")[0]!;
    const cb = await fetch(at(`/auth/ya/callback?code=good&state=${encodeURIComponent(state)}`), {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    const session = cookieOf(cb, "rh_session")!;
    const out = await fetch(at("/auth/logout"), { method: "POST", headers: { cookie: `rh_session=${session}` } });
    expect(out.status).toBe(204);
    const after = await fetch(at("/api/me"), { headers: { cookie: `rh_session=${session}` } });
    expect((await after.json()) as { login: string | null }).toMatchObject({ login: null });
  });
});

describe("Ф2.10 (M10): PAT не появляется ни в одном ответе /api/me* и /auth/*", () => {
  let session = "";

  beforeAll(async () => {
    const start = await fetch(at("/auth/ya"), { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("rh_oauth_state="))!.split(";")[0]!;
    const cb = await fetch(at(`/auth/ya/callback?code=good&state=${encodeURIComponent(state)}`), {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    session = cookieOf(cb, "rh_session")!;
    const put = await fetch(at("/api/me/pat"), {
      method: "PUT",
      headers: { cookie: `rh_session=${session}`, "content-type": "application/json" },
      body: JSON.stringify({ token: PAT }),
    });
    expect(put.status).toBe(200);
    // сам ответ на сохранение — тоже поверхность утечки
    expect(await put.text()).not.toContain(PAT);
  }, 30_000);

  test("ни тело, ни заголовки ответов не содержат значения PAT", async () => {
    const paths = ["/api/me", "/api/me/repos", "/api/me/jobs", "/api/me/favorites", "/auth/ya", "/auth/ya/callback?error=x"];
    const leaks: string[] = [];
    for (const path of paths) {
      const res = await fetch(at(path), { headers: { cookie: `rh_session=${session}` }, redirect: "manual" });
      const body = await res.text();
      const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      if (body.includes(PAT) || headers.includes(PAT)) leaks.push(path);
    }
    expect(leaks).toEqual([]);
  }, 30_000);

  test("/api/me отдаёт только факт наличия PAT и дату проверки", async () => {
    const res = await fetch(at("/api/me"), { headers: { cookie: `rh_session=${session}` } });
    const body = (await res.json()) as { hasPat: boolean; patCheckedAt: string | null };
    expect(body.hasPat).toBe(true);
    expect(typeof body.patCheckedAt).toBe("string");
  });

  test("DELETE /api/me/pat: PAT удалён, ответ его не содержит", async () => {
    const res = await fetch(at("/api/me/pat"), { method: "DELETE", headers: { cookie: `rh_session=${session}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(PAT);
    const me = await fetch(at("/api/me"), { headers: { cookie: `rh_session=${session}` } });
    expect(((await me.json()) as { hasPat: boolean }).hasPat).toBe(false);
  });
});
