// audit-m42b-repro.test.ts — воспроизведение находок, назначенных вехе
// В4.2b (Ф2b). Закон вехи — reports/2026-09-17-fix-plan.md ревизия 6,
// Часть 2 «В4.2b = Ф2b» и Часть 3 «К-Ф2b»; источники находок —
// reports/2026-09-17-m4-audit-pair.md (M9 В4, LOW-4/5/6 В4).
//
// Б0 покрывает ЧЕТЫРЕ позиции остатка:
//   Ф2.7 — `Secure`/`__Host-` при `YA_REDIRECT_URI` на https;
//   Ф2.7 — ошибочные исходы callback отдают ОТНОСИТЕЛЬНЫЙ `Location`
//          (успех `/me` уже относительный — красным не стал бы);
//   Ф2.8 — `APP_SECRET` короче 32 символов → сессии выключены;
//   Ф2.8 — чужой `Origin` на мутирующих `/api/me/*` и `/auth/logout` → 403.
// Тест «logout отзывает сессию» из Б0 исключён планом: маршрут уже в
// `main`, красным он не станет — покрывается обычным тестом блока Б1.
//
// На Б0-коммите находки стоят под обёрткой `repro` (в строгом режиме —
// красные); обёртка снимается в блоке, закрывшем находку, сами
// утверждения при этом не меняются. Строгий режим — для команды приёмки:
//   AUDIT_STRICT=1 bun test tests/audit-m42b-repro.test.ts
//
// Живых запросов нет: настоящий сервер по HTTP во временном DATA_DIR,
// SOURCECRAFT_TOKEN="", REST/AppSec/git/Я ID — один локальный мок
// (server-harness), `YA_REDIRECT_URI` задан явно в обоих вариантах
// (http и https).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

// Обёртка строгого режима (как в audit-m42a-repro.test.ts): в обычном
// прогоне — `test.failing` (набор зелёный, красноты в CI нет), под
// AUDIT_STRICT=1 — обычный `test`, то есть красный, пока находка не закрыта.
const repro = process.env.AUDIT_STRICT ? test : test.failing;

const SECRET = "audit-m42b-repro-test-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-audit-m42b-"));

/** Что мок Я ID отвечает на обмен кода — фикстура входа. */
const ya = { tokenStatus: 200, infoStatus: 200, yaId: 4242, login: "tester" };

const mock = startMockApi((req, url) => {
  const p = url.pathname;
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
  return null;
});

/** Сервер с http-redirect (дефолт харнесса) — Origin- и Location-тесты. */
let server: SpawnedServer | null = null;
/** Сервер с YA_REDIRECT_URI на https — cookie-тесты `__Host-`/`Secure`. */
let httpsServer: SpawnedServer | null = null;

beforeAll(async () => {
  const yaEnv = { YA_CLIENT_ID: "test-client-id", YA_CLIENT_SECRET: "test-client-secret" };
  server = await spawnServer({ dataDir: join(dir, "http"), mock, appSecret: SECRET, env: yaEnv });
  httpsServer = await spawnServer({
    dataDir: join(dir, "https"),
    mock,
    appSecret: SECRET,
    env: { ...yaEnv, YA_REDIRECT_URI: "https://rh-stand.example/auth/ya/callback" },
  });
}, 30_000);

afterAll(async () => {
  if (server) await server.stop();
  if (httpsServer) await httpsServer.stop();
  mock.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY: каталог подберёт ОС */
  }
});

const at = (path: string) => `${server!.base}${path}`;

function cookieOf(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq) === name) return pair!.slice(eq + 1);
  }
  return null;
}

/** Полный вход через мок Я ID на заданном сервере; возвращает cookie-значение сессии. */
async function login(base: string, sessionCookieName: string): Promise<string> {
  const start = await fetch(`${base}/auth/ya`, { redirect: "manual" });
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("rh_oauth_state="))!.split(";")[0]!;
  const cb = await fetch(`${base}/auth/ya/callback?code=good&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: stateCookie },
  });
  return cookieOf(cb, sessionCookieName)!;
}

// ---------------------------------------------------------------------------
// Ф2.8. `APP_SECRET` короче 32 символов → сессии выключены
// (К-Ф2b Ф2.8: в loadConfig `appSecret = null` + лог).
// ---------------------------------------------------------------------------

describe("Ф2.8: APP_SECRET < 32 символов выключает сессии", () => {
  repro("loadConfig: короткий APP_SECRET → appSecret = null", () => {
    const saved = process.env.APP_SECRET;
    process.env.APP_SECRET = "short-secret";
    try {
      const cfg = loadConfig();
      expect(cfg.auth.appSecret).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Ф2.7. Ошибочные исходы callback — относительный `Location: /me?auth_error=…`
// (LOW-7: абсолютный редирект из Host — риск за кривым прокси).
// ---------------------------------------------------------------------------

describe("Ф2.7: ошибочный исход callback отдаёт относительный Location", () => {
  repro("провайдер вернул ?error= → Location ровно /me?auth_error=…", async () => {
    const res = await fetch(at("/auth/ya/callback?error=access_denied"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/me?auth_error=access_denied");
  });

  repro("state не сошёлся → Location ровно /me?auth_error=state", async () => {
    const res = await fetch(at("/auth/ya/callback?code=x&state=forged"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/me?auth_error=state");
  });
});

// ---------------------------------------------------------------------------
// Ф2.7. `YA_REDIRECT_URI` на https → `__Host-rh_session` / `__Host-rh_oauth_state`
// с `Secure; Path=/` без `Domain` (К-Ф2b Ф2.7: `cookieNames(config)`).
// ---------------------------------------------------------------------------

describe("Ф2.7: https-redirect включает __Host-/Secure cookie", () => {
  repro("state-cookie зовётся __Host-rh_oauth_state и помечена Secure", async () => {
    const start = await fetch(`${httpsServer!.base}/auth/ya`, { redirect: "manual" });
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("__Host-rh_oauth_state="));
    expect(stateCookie ?? "(no __Host-rh_oauth_state cookie)").toContain("Secure");
    expect(stateCookie!.split(";").map((s) => s.trim())).not.toContain("Domain=rh-stand.example");
  });

  repro("сессия после входа зовётся __Host-rh_session и помечена Secure", async () => {
    const base = httpsServer!.base;
    const start = await fetch(`${base}/auth/ya`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("__Host-rh_oauth_state="))!.split(";")[0]!;
    const cb = await fetch(`${base}/auth/ya/callback?code=good&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    const sessionCookie = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-rh_session="));
    expect(sessionCookie ?? "(no __Host-rh_session cookie)").toContain("Secure");
  });
});

// ---------------------------------------------------------------------------
// Ф2.8. Чужой Origin → 403 на мутирующих `/api/me/*` и `/auth/logout`
// (LOW-6; заголовка нет → пропустить — SameSite=Lax).
// ---------------------------------------------------------------------------

describe("Ф2.8: чужой Origin на мутациях → 403", () => {
  let session = "";

  beforeAll(async () => {
    session = await login(server!.base, "rh_session");
  }, 30_000);

  repro("POST /auth/logout с чужим Origin → 403, сессия не отозвана", async () => {
    const out = await fetch(at("/auth/logout"), {
      method: "POST",
      headers: { cookie: `rh_session=${session}`, origin: "https://evil.example" },
    });
    expect(out.status).toBe(403);
    const me = await fetch(at("/api/me"), { headers: { cookie: `rh_session=${session}` } });
    expect(((await me.json()) as { login: string | null }).login).toBe("tester");
  });

  repro("PUT /api/me/favorites/:org/:repo с чужим Origin → 403", async () => {
    const res = await fetch(at("/api/me/favorites/evil/repo"), {
      method: "PUT",
      headers: { cookie: `rh_session=${session}`, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима (Т1 круга 2 В4.2-port-fix — тот же приём):
// без неё «AUDIT_STRICT=1 зелёный» — тавтология, потому что незакрытые находки
// стоят под `test.failing`. На Б0-коммите этот тест красный вместе с ними.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
