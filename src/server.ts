// server.ts — фронтенд (React + Gravity UI, бандлит Bun из HTML-импорта;
// dev — HMR, NODE_ENV=production — бандл без HMR) + read-API В3 + auth/моя
// поверхность В4. Сервер ТОЛЬКО разбирает запрос, валидирует и
// сериализует: логика чтения — чистые функции src/api/*, логика auth —
// src/auth/* (тестируются без HTTP). Живые вызовы наружу — только
// OAuth-обмен (вход) и PAT/me-repos по явному действию юзера; данные
// рейтинга появляются исключительно сканом.
import { loadConfig } from "./config";
import { openDb } from "./db";
import { getMeta, getRepoCard, listRepos, parseReposQuery } from "./api/repos";
import { listMyRepos } from "./api/me";
import { renderRepoReport } from "./report/markdown";
import { upsertRepo } from "./jobs/runner";
import { enqueueScan, startScheduler, startWorkerLoop } from "./jobs/scheduler";
import {
  clearSessionCookieHeader,
  createSession,
  getSessionUser,
  makeOAuthState,
  oauthStateCookieHeader,
  oauthStateFromCookie,
  parseCookies,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  sessionCookieHeader,
  SESSION_TTL_MS,
  upsertUser,
} from "./auth/session";
import { deletePat, getPat, patMeta, storePat } from "./auth/pat";
import { buildAuthUrl, exchangeCode } from "./auth/ya";
import { parseUserScanSettings, readUserScanSettings, writeUserScanSettings } from "./auth/settings";
import { makeScClient } from "./collectors/http";
import index from "./web/index.html";

const config = loadConfig();
const db = openDb(config);

const badQuery = (message: string): Response =>
  Response.json({ error: { code: "bad_query", message } }, { status: 400 });
const notFound = (message: string): Response =>
  Response.json({ error: { code: "not_found", message } }, { status: 404 });
const unauthorized = (message = "требуется вход (Я ID)"): Response =>
  Response.json({ error: { code: "unauthorized", message } }, { status: 401 });

/** Сессия из cookie; APP_SECRET отсутствует = сессии принципиально выключены. */
function sessionOf(req: Request) {
  if (!config.auth.appSecret) return null;
  const cookies = parseCookies(req.headers.get("cookie"));
  return getSessionUser(db, config.auth.appSecret, cookies[SESSION_COOKIE]);
}

/** REST-клиент с юзерским PAT (PAT-окно/«мои репо»); PAT нет → null. */
function userClient(userId: number) {
  const pat = config.auth.appSecret ? getPat(db, config.auth.appSecret, userId) : null;
  if (!pat) return null;
  return makeScClient({ token: pat, minIntervalMs: config.scan.rest.minIntervalMs });
}

/** config.auth → креды Я ID (имена полей разъезжаются — склеиваем в одном месте). */
const yaCreds = () => ({
  clientId: config.auth.yaClientId,
  clientSecret: config.auth.yaClientSecret,
  redirect: config.auth.redirect,
});

const server = Bun.serve({
  port: config.port,
  routes: {
    "/api/health": () => {
      const n = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
      return Response.json({ ok: true, repos: n, llmProvider: config.llm.provider });
    },
    "/api/meta": () => Response.json(getMeta(db)),
    "/api/repos": (req) => {
      const parsed = parseReposQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      return Response.json(listRepos(db, parsed.query));
    },
    "/api/repos/:org/:repo": (req) => {
      const card = getRepoCard(db, req.params.org, req.params.repo);
      if (!card) return notFound(`репозиторий ${req.params.org}/${req.params.repo} не найден в каталоге`);
      return Response.json(card);
    },
    "/api/repos/:org/:repo/report.md": (req) => {
      const { org, repo } = req.params;
      const card = getRepoCard(db, org, repo);
      if (!card) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
      return new Response(renderRepoReport(card), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          // отчёт открывают как файл, а не читают в браузере
          "content-disposition": `attachment; filename="${org}-${repo}-health.md"`,
        },
      });
    },
    // ---------- auth: Я ID OAuth (Б1) ----------
    "/auth/ya": () => {
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "APP_SECRET не задан: сессии выключены" } }, { status: 503 });
      }
      try {
        const state = makeOAuthState();
        const url = buildAuthUrl(yaCreds(), state);
        return new Response(null, { status: 302, headers: { location: url, "set-cookie": oauthStateCookieHeader(state) } });
      } catch (e) {
        return Response.json({ error: { code: "unconfigured", message: String((e as Error).message) } }, { status: 503 });
      }
    },
    "/auth/ya/callback": async (req) => {
      const url = new URL(req.url);
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        return Response.redirect(new URL(`/me?auth_error=${encodeURIComponent(errorParam)}`, url.origin), 302);
      }
      const stateCookie = oauthStateFromCookie(parseCookies(req.headers.get("cookie"))[OAUTH_STATE_COOKIE]);
      const state = url.searchParams.get("state");
      if (!stateCookie || !state || state !== stateCookie) {
        return Response.redirect(new URL("/me?auth_error=state", url.origin), 302);
      }
      const code = url.searchParams.get("code");
      if (!code || !config.auth.appSecret) {
        return Response.redirect(new URL("/me?auth_error=no_code", url.origin), 302);
      }
      const exchanged = await exchangeCode(yaCreds(), code);
      if (!exchanged.ok) {
        return Response.redirect(new URL(`/me?auth_error=${encodeURIComponent(exchanged.error.slice(0, 120))}`, url.origin), 302);
      }
      const userId = upsertUser(db, exchanged.profile.yaId, exchanged.profile.login);
      const cookie = createSession(db, config.auth.appSecret, userId);
      return new Response(null, {
        status: 302,
        headers: { location: "/me", "set-cookie": sessionCookieHeader(config.auth.appSecret, cookie, SESSION_TTL_MS) },
      });
    },
    // ---------- /api/me: аккаунт, PAT-окно, настройки, мои репо ----------
    "/api/me": (req) => {
      // фоновый зонд шапки: аноним — это 200 с login:null, а не 401 —
      // браузер логирует каждый не-2xx в консоль, а чистая консоль —
      // критерий cdp-харнесса В3; остальные me-эндпоинты остаются 401
      const user = sessionOf(req);
      if (!user) return Response.json({ login: null, hasPat: false, patCheckedAt: null });
      const meta = config.auth.appSecret ? patMeta(db, user.userId) : null;
      return Response.json({
        login: user.login,
        hasPat: meta?.hasPat === true,
        patCheckedAt: meta && meta.hasPat ? meta.checkedAt : null,
      });
    },
    "/api/me/pat": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "APP_SECRET не задан: PAT хранить нельзя" } }, { status: 503 });
      }
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        if (typeof body?.token !== "string" || body.token.length < 8) return badQuery("token: ожидается строка PAT");
        // живая проверка GET /user: 401 = токен отклонён платформой
        const probe = makeScClient({ token: body.token, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 2 });
        const who = await probe.get("/user");
        if (who.status !== 200) {
          return Response.json(
            { error: { code: "bad_token", message: `SourceCraft отклонил токен (HTTP ${who.status})` } },
            { status: 400 },
          );
        }
        storePat(db, config.auth.appSecret!, user.userId, body.token);
        const username = (who.json as { username?: unknown } | null)?.username ?? null;
        return Response.json({ ok: true, tokenOwner: typeof username === "string" ? username : null });
      }
      if (req.method === "DELETE") {
        deletePat(db, user.userId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался PUT или DELETE" } }, { status: 405 });
    },
    "/api/me/settings": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "GET") {
        return Response.json({
          scan: readUserScanSettings(db, user.userId),
          // серверные дефолты для показа рядом с настройками (ярусы RESOLVED 17.09)
          defaults: {
            maxBytes: config.scan.clone.maxBytes,
            timeoutMs: config.scan.clone.timeoutMs,
            degrade: { enabled: config.scan.degrade.enabled, maxBytes: config.scan.degrade.maxBytes, timeoutMs: config.scan.degrade.timeoutMs },
          },
        });
      }
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as { scan?: unknown } | null;
        const parsed = parseUserScanSettings(body?.scan);
        if (!parsed.ok) return badQuery(parsed.message);
        writeUserScanSettings(db, user.userId, parsed.settings);
        return Response.json({ ok: true, scan: parsed.settings });
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался GET или PUT" } }, { status: 405 });
    },
    "/api/me/repos": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const client = userClient(user.userId);
      if (!client) {
        return Response.json(
          { error: { code: "no_pat", message: "сначала сохраните PAT SourceCraft (окно на этой странице)" } },
          { status: 409 },
        );
      }
      const result = await listMyRepos(db, client);
      if (!result.ok) {
        return Response.json({ error: { code: "bad_token", message: result.error } }, { status: 400 });
      }
      return Response.json({ username: result.username, entries: result.entries });
    },
    "/api/me/repos/:org/:repo": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      // own-карточка: последний own-скор (6 категорий, Security с фактами);
      // приватные/эвиктированные репо читаемы — личная страница юзера
      const card = getRepoCard(db, req.params.org, req.params.repo, { mode: "own" });
      if (!card) return notFound(`репозиторий ${req.params.org}/${req.params.repo} не найден`);
      return Response.json(card);
    },
    "/api/me/repos/:org/:repo/scan": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method !== "POST") {
        return Response.json({ error: { code: "bad_query", message: "ожидался POST" } }, { status: 405 });
      }
      if (!userClient(user.userId)) {
        return Response.json({ error: { code: "no_pat", message: "сначала сохраните PAT SourceCraft" } }, { status: 409 });
      }
      const { org, repo } = req.params;
      if (!/^[a-z0-9_.-]+$/i.test(org ?? "") || !/^[a-z0-9_.-]+$/i.test(repo ?? "")) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      const repoId = upsertRepo(db, org, repo);
      const jobId = enqueueScan(db, repoId, { mode: "own", userId: user.userId, triggerKind: "user" });
      return Response.json({ queued: true, jobId, slug: `${org}/${repo}` }, { status: 202 });
    },
    // неизвестный /api/* обязан остаться JSON-404, а не отдать HTML
    "/api/*": () => notFound("неизвестный endpoint"),
    // catch-all фронтенда: маршруты /repo/{org}/{repo} живут в History API,
    // прямая ссылка и F5 на карточке должны отдавать тот же бандл
    "/*": index,
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

// --- периодика (В4/Б3): воркер очереди + ночной обход каталога ---
const serverScClient = config.sourcecraftToken
  ? makeScClient({ token: config.sourcecraftToken, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: config.scan.rest.budget })
  : null;
startWorkerLoop({ db, config, scClient: serverScClient });
startScheduler(db, serverScClient, config);

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
console.log(`  scheduler: интервал ${Math.round(config.scheduler.intervalMs / 60000)} мин, форс-полный ${config.scheduler.fullRescan ? "ВКЛ" : "выкл"}`);
