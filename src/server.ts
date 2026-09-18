// server.ts — фронтенд (React + Gravity UI, бандлит Bun из HTML-импорта;
// dev — HMR, NODE_ENV=production — бандл без HMR) + read-API В3 + auth/моя
// поверхность В4. Сервер ТОЛЬКО разбирает запрос, валидирует и
// сериализует: логика чтения — чистые функции src/api/*, логика auth —
// src/auth/* (тестируются без HTTP). Живые вызовы наружу — только
// OAuth-обмен (вход) и PAT/me-repos по явному действию юзера; данные
// рейтинга появляются исключительно сканом.
import { loadConfig } from "./config";
import { openDb } from "./db";
import { getMeta, getRepoCardForViewer, listRepos, parseReposQuery } from "./api/repos";
import { makeAccessCache, resolveAccess, type AccessRepo, type AccessResult } from "./auth/access";
import { makeAppsecClient } from "./collectors/appsec";
import {
  addFavorite,
  checkFavoriteAccess,
  favoriteEnqueueOf,
  isFavorite,
  listFavorites,
  listMyRepos,
  myJobs,
  removeFavorite,
  requestUserScan,
  type FavoriteCheckResponse,
} from "./api/me";
import { renderRepoReport } from "./report/markdown";
import { catalogClientBudget, enqueueScan, maintenanceTick, schedulerHealthSnapshot, startScheduler, startWorkerLoop } from "./jobs/scheduler";
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
  revokeSession,
  upsertUser,
  userProfile,
} from "./auth/session";
import { deletePat, getPat, patMeta, storePat } from "./auth/pat";
import { buildAuthUrl, exchangeCode, yaAvatarUrl, type YaEndpoints } from "./auth/ya";
import { makeScClient } from "./collectors/http";
import { needsRescore, rescoreAll } from "./score/rescore";
import index from "./web/index.html";

const config = loadConfig();
// ПОРТ hq-parallel (S1/security): окно живых проб PAT на юзера.
const patProbes = new Map<number, number[]>();
// В4.2-port-fix (П2): окно лимита проверок прав избранного на юзера.
const favoriteChecks = new Map<number, number[]>();

/**
 * Скользящее окно счётчика на юзера: true = пропустить, лимит не исчерпан.
 * Чистится ЦЕЛИКОМ (М8 круга 2: `Map` без очистки течёт — ровно та утечка,
 * от которой П2 предостерегал для нового счётчика, а старое окно проб PAT
 * держало запись на каждого юзера, заходившего хоть раз за жизнь процесса).
 */
function allowInWindow(windows: Map<number, number[]>, userId: number, limit: number, windowMs: number, now = Date.now()): boolean {
  const since = now - windowMs;
  for (const [id, stamps] of windows) {
    const alive = stamps.filter((ts) => ts > since);
    if (alive.length === 0) windows.delete(id);
    else windows.set(id, alive);
  }
  const window = windows.get(userId) ?? [];
  if (window.length >= limit) return false;
  window.push(now);
  windows.set(userId, window);
  return true;
}

/** Минутное окно проверок прав избранного: true = пропустить. */
const allowFavoriteCheck = (userId: number, now = Date.now()): boolean =>
  allowInWindow(favoriteChecks, userId, config.queue.favoriteChecksPerMinute, 60_000, now);

/** Живая проба токена = оракул валидности PAT; сервис не переборщик (ПОРТ S1). */
const PAT_PROBES_PER_HOUR = 10;

/** Часовое окно живых проб PAT: true = пропустить. */
const allowPatProbe = (userId: number, now = Date.now()): boolean => allowInWindow(patProbes, userId, PAT_PROBES_PER_HOUR, 60 * 60_000, now);

const db = openDb(config);

// Ф1.9: оценки устарели (derived_version старее кода) или их нет при
// непустых сканах (после миграции схемы) — синхронный пересчёт ДО Bun.serve:
// рейтинг не отвечает пустым или смешанным. Прогресс — в лог.
if (needsRescore(db)) {
  const t0 = Date.now();
  console.log("[startup] stored scores are outdated or missing: rescoring before serving");
  // круг 2 (LOW-7): до порта — только читаемые сканы (P, L, приватный не-bad), история — фоновым тиком воркера
  const out = rescoreAll(db, { scope: "startup", log: (m) => console.log(`[startup] ${m}`), progressEvery: 200 });
  if (out.fatal > 0) throw new Error("startup rescore stopped on a schema error (see log above)");
  console.log(`[startup] rescore finished in ${Math.round((Date.now() - t0) / 1000)} s`);
}

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
  return makeScClient({ token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, timeoutMs: config.scan.rest.timeoutMs });
}

// К2: доступ зрителя к каналам карточки — прямые чтения PAT зрителя с
// кэшем в памяти процесса (TTL Config.access.cacheTtlMs; сбой — failedTtlMs;
// предел maxEntries; склейка одновременных проверок и поколение PAT — Ф1.6/Ф1.12)
const accessCache = makeAccessCache(config.access.cacheTtlMs, { failedTtlMs: config.access.failedTtlMs, maxEntries: config.access.maxEntries });

/** Резолвер доступа зрителя запроса (аноним / без PAT → no-pat без запросов). */
function viewerAccess(req: Request): (repo: AccessRepo) => Promise<AccessResult> {
  const user = sessionOf(req);
  return (repo) => {
    const pat = user && config.auth.appSecret ? getPat(db, config.auth.appSecret, user.userId) : null;
    return resolveAccess(
      {
        restClient: (token) =>
          makeScClient({ token, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 4, timeoutMs: config.scan.rest.timeoutMs }),
        appsecClient: (token) =>
          makeAppsecClient({ token, baseUrl: config.api.appsecBase, minIntervalMs: config.scan.rest.appsecMinIntervalMs, maxRequests: 2, timeoutMs: 10_000 }),
        cache: accessCache,
      },
      user ? { userId: user.userId, pat } : null,
      repo,
    );
  };
}

/** config.auth → креды Я ID (имена полей разъезжаются — склеиваем в одном месте). */
const yaCreds = () => ({
  clientId: config.auth.yaClientId,
  clientSecret: config.auth.yaClientSecret,
  redirect: config.auth.redirect,
});

/** Ф2.10: адреса Я ID — из конфига (тесты направляют их на локальный мок). */
const yaEndpoints = (): YaEndpoints => ({ oauthBase: config.auth.yaOauthBase, loginBase: config.auth.yaLoginBase });

const server = Bun.serve({
  port: config.port,
  routes: {
    "/api/health": () => {
      // ПОРТ hq-parallel (S3): health не врёт зелёным на мёртвой периодике —
      // очередь, провалы за 24ч, последний обход, свежесть данных
      const n = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
      const queue = {
        user: (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running') AND trigger_kind = 'user'").get() as { c: number }).c,
        rating: (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running') AND trigger_kind != 'user'").get() as { c: number }).c,
      };
      const failed24h = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'failed' AND created_at > ?").get(new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as { c: number }).c;
      const sched = schedulerHealthSnapshot();
      const nightly = sched.lastNightly;
      const fresh = db
        .query("SELECT MAX(s.finished_at) AS f FROM scans s JOIN scores sc ON sc.scan_id = s.id WHERE s.finished_at IS NOT NULL AND sc.total_rating IS NOT NULL")
        .get() as { f: string | null };
      return Response.json({
        ok: true,
        repos: n,
        llmProvider: config.llm.provider,
        queue,
        failedJobs24h: failed24h,
        // К-Р5: два РАЗНЫХ факта — «последний обход» и «последний обход с
        // исполнившейся ночной фазой»; lastNightly обновляет только второй
        // (часовая сверка его не трогает), lastReconcileAt/lastNightlyAt —
        // метки успеха своих фаз
        lastNightly: nightly ? { ok: nightly.ok, error: nightly.ok ? undefined : nightly.error, pages: nightly.ok ? nightly.pages : 0, catalogComplete: nightly.ok ? nightly.catalogComplete : false } : null,
        lastReconcileAt: sched.lastReconcileAt,
        lastNightlyAt: sched.lastNightlyAt,
        freshAsOf: fresh.f,
      });
    },
    "/api/meta": () => Response.json(getMeta(db)),
    "/api/repos": (req) => {
      const parsed = parseReposQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      return Response.json(listRepos(db, parsed.query));
    },
    // единая карточка (К2): состав ответа — по доступу зрителя из cookie
    "/api/repos/:org/:repo": async (req) => {
      const card = await getRepoCardForViewer(db, req.params.org, req.params.repo, viewerAccess(req), { limits: config.scan });
      if (!card) return notFound(`репозиторий ${req.params.org}/${req.params.repo} не найден в каталоге`);
      return Response.json(card);
    },
    "/api/repos/:org/:repo/report.md": async (req) => {
      const { org, repo } = req.params;
      // тот же сборщик карточки с тем же зрителем (К2)
      const card = await getRepoCardForViewer(db, org, repo, viewerAccess(req), { limits: config.scan });
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
        const url = buildAuthUrl(yaCreds(), state, yaEndpoints());
        return new Response(null, { status: 302, headers: { location: url, "set-cookie": oauthStateCookieHeader(state) } });
      } catch (e) {
        return Response.json({ error: { code: "unconfigured", message: String((e as Error).message) } }, { status: 503 });
      }
    },
    // выход: сессия отзывается в БД, cookie гасится; PAT пользователя остаётся
    // (он привязан к аккаунту, а не к сессии). Только POST: SameSite=Lax не
    // отдаёт cookie межсайтовому POST, выход чужой страницей невозможен
    "/auth/logout": {
      POST: (req) => {
        if (!config.auth.appSecret) return new Response(null, { status: 204 });
        revokeSession(db, config.auth.appSecret, parseCookies(req.headers.get("cookie"))[SESSION_COOKIE]);
        return new Response(null, { status: 204, headers: { "set-cookie": sessionCookieHeader(config.auth.appSecret, "", 0) } });
      },
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
      const exchanged = await exchangeCode(yaCreds(), code, undefined, yaEndpoints());
      if (!exchanged.ok) {
        return Response.redirect(new URL(`/me?auth_error=${encodeURIComponent(exchanged.error.slice(0, 120))}`, url.origin), 302);
      }
      const { yaId, login, displayName, avatarId } = exchanged.profile;
      const userId = upsertUser(db, yaId, login, new Date(), { displayName, avatarId });
      const cookie = createSession(db, config.auth.appSecret, userId);
      return new Response(null, {
        status: 302,
        headers: { location: "/me", "set-cookie": sessionCookieHeader(config.auth.appSecret, cookie, SESSION_TTL_MS) },
      });
    },
    // ---------- /api/me: аккаунт, PAT-окно, мои репо (настройки бюджетов удалены — К5) ----------
    "/api/me": (req) => {
      // фоновый зонд шапки: аноним — это 200 с login:null, а не 401 —
      // браузер логирует каждый не-2xx в консоль, а чистая консоль —
      // критерий cdp-харнесса В3; остальные me-эндпоинты остаются 401
      const user = sessionOf(req);
      if (!user) return Response.json({ login: null, displayName: null, avatarUrl: null, hasPat: false, patCheckedAt: null });
      const meta = config.auth.appSecret ? patMeta(db, user.userId) : null;
      const profile = userProfile(db, user.userId);
      return Response.json({
        login: user.login,
        displayName: profile.displayName,
        avatarUrl: profile.avatarId ? yaAvatarUrl(profile.avatarId) : null,
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
        // ПОРТ hq-parallel (S1/security): живая проба токена = оракул
        // валидности PAT — окно на юзера (10/час), сервис не переборщик
        if (!allowPatProbe(user.userId)) {
          return Response.json(
            { error: { code: "rate_limited", message: "Слишком много проверок токена — попробуйте через час" } },
            { status: 429 },
          );
        }
        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        if (typeof body?.token !== "string" || body.token.length < 8) return badQuery("token: ожидается строка PAT");
        // живая проверка GET /user: 401 = токен отклонён платформой
        const probe = makeScClient({
          token: body.token,
          baseUrl: config.api.restBase,
          minIntervalMs: config.scan.rest.minIntervalMs,
          maxRequests: 2,
          timeoutMs: config.scan.rest.timeoutMs,
        });
        const who = await probe.get("/user");
        if (who.status !== 200) {
          return Response.json(
            { error: { code: "bad_token", message: `SourceCraft отклонил токен (HTTP ${who.status})` } },
            { status: 400 },
          );
        }
        storePat(db, config.auth.appSecret!, user.userId, body.token);
        accessCache.clearUser(user.userId); // новый PAT — новые права
        const username = (who.json as { username?: unknown } | null)?.username ?? null;
        return Response.json({ ok: true, tokenOwner: typeof username === "string" ? username : null });
      }
      if (req.method === "DELETE") {
        deletePat(db, user.userId);
        accessCache.clearUser(user.userId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался PUT или DELETE" } }, { status: 405 });
    },
    "/api/me/repos": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const client = userClient(user.userId);
      // ПОРТ 5: union-список живёт и без PAT (заявки + избранное)
      const result = await listMyRepos(db, client, user.userId);
      if (!result.ok) {
        return Response.json({ error: { code: "bad_token", message: result.error } }, { status: 400 });
      }
      return Response.json({ username: result.username, entries: result.entries });
    },
    // ПОРТ 5: панель заданий — колокольчик/«Мои задания» (диагноз UX «очереди не видно»)
    "/api/me/jobs": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      return Response.json(myJobs(db, user.userId));
    },
    "/api/me/favorites": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      return Response.json({ entries: listFavorites(db, user.userId) });
    },
    "/api/me/favorites/:org/:repo": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const { org, repo } = req.params;
      if (!/^[a-z0-9_.-]+$/i.test(org ?? "") || !/^[a-z0-9_.-]+$/i.test(repo ?? "")) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      if (req.method === "PUT") {
        addFavorite(db, user.userId, org, repo);
        return Response.json({ ok: true, favorite: true });
      }
      if (req.method === "DELETE") {
        removeFavorite(db, user.userId, org, repo);
        return Response.json({ ok: true, favorite: false });
      }
      if (req.method === "GET") {
        return Response.json({ favorite: isFavorite(db, user.userId, org, repo) });
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался GET/PUT/DELETE" } }, { status: 405 });
    },
    "/api/me/favorites/:org/:repo/check": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method !== "POST") {
        return Response.json({ error: { code: "bad_query", message: "ожидался POST" } }, { status: 405 });
      }
      const { org, repo } = req.params;
      if (!/^[a-z0-9_.-]+$/i.test(org ?? "") || !/^[a-z0-9_.-]+$/i.test(repo ?? "")) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      if (!isFavorite(db, user.userId, org, repo)) {
        return Response.json({ error: { code: "not_favorite", message: "сначала добавьте репозиторий в избранное" } }, { status: 404 });
      }
      const pat = config.auth.appSecret ? getPat(db, config.auth.appSecret, user.userId) : null;
      if (!pat) {
        return Response.json({ error: { code: "no_pat", message: "для проверки прав нужен PAT SourceCraft" } }, { status: 409 });
      }
      // В4.2-port-fix (П2, вторая половина Н1): каждый вызов — до 3 живых
      // запросов PAT-ом зрителя, лимита не было вовсе. Окно минутное, счётчик
      // по схеме patProbes, но С ЧИСТКОЙ (Map без очистки течёт). 429 стоит
      // ПОСЛЕ not_favorite (404) и no_pat (409): перебор несуществующих
      // слагов не должен жечь лимит.
      if (!allowFavoriteCheck(user.userId)) {
        return Response.json(
          { error: { code: "rate_limited", message: `не больше ${config.queue.favoriteChecksPerMinute} проверок прав в минуту — попробуйте позже` } },
          { status: 429 },
        );
      }
      const rest = makeScClient({ token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 8, timeoutMs: config.scan.rest.timeoutMs });
      // П3 (Н2 HIGH): адрес из конфига обязателен — без baseUrl модуль
      // подставлял боевой appsec.sourcecraft.tech, и PAT зрителя уходил туда
      // даже с APPSEC_API_BASE на мок
      const appsec = makeAppsecClient({ token: pat, baseUrl: config.api.appsecBase, minIntervalMs: config.scan.rest.appsecMinIntervalMs });
      const result: FavoriteCheckResponse = await checkFavoriteAccess(
        db,
        user.userId,
        org,
        repo,
        {
          restGet: (path: string) => rest.get(path).then((r) => ({ status: r.status, json: r.json })),
          appsecLatest: (gitRepo: string) => appsec.get("/v1/scans/latest", { gitRepo }).then((r) => ({ status: r.status })),
          cooldownMs: config.queue.favoriteOwnCooldownMs,
        },
        // Н1: постановка идёт ЦЕЛИКОМ через requestUserScan — его дедуп,
        // too_many_active, rate_limited и транзакцию Ф1.5 не обойти; тело
        // repo-GET прокидывается, чтобы не делать его второй раз
        async (repoRes) => favoriteEnqueueOf(await requestUserScan(db, rest, user.userId, org, repo, config.queue, new Date(), repoRes)),
      );
      return Response.json(result);
    },
    "/api/me/repos/:org/:repo/scan": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method !== "POST") {
        return Response.json({ error: { code: "bad_query", message: "ожидался POST" } }, { status: 405 });
      }
      const client = userClient(user.userId);
      if (!client) {
        return Response.json({ error: { code: "no_pat", message: "сначала сохраните PAT SourceCraft" } }, { status: 409 });
      }
      const { org, repo } = req.params;
      if (!/^[a-z0-9_.-]+$/i.test(org ?? "") || !/^[a-z0-9_.-]+$/i.test(repo ?? "")) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      // H1/LOW-3 (К3): до постановки — repo-GET с PAT юзера; строка repos
      // и заявка появляются только при подтверждённом доступе
      const out = await requestUserScan(db, client, user.userId, org, repo, config.queue);
      return Response.json(out.body, { status: out.status });
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
// H2 (К3): клиента на процесс нет — фабрика выдаёт новый клиент с полным
// бюджетом на каждую задачу воркера и на каждый ночной обход
const serverClient = () =>
  config.sourcecraftToken
    ? makeScClient({
        token: config.sourcecraftToken,
        baseUrl: config.api.restBase,
        minIntervalMs: config.scan.rest.minIntervalMs,
        maxRequests: config.scan.rest.budget,
        timeoutMs: config.scan.rest.timeoutMs,
      })
    : null;
// Ф2.5: обходу каталога — СВОЙ бюджет (потолок страниц + 10), а не бюджет
// скана: полный каталог 27 446 репо = 275 страниц, и общий бюджет 1000
// запросов кончился бы посреди обхода, превратив его в «недочитанный»
const catalogClient = () =>
  config.sourcecraftToken
    ? makeScClient({
        token: config.sourcecraftToken,
        baseUrl: config.api.restBase,
        minIntervalMs: config.scan.rest.minIntervalMs,
        maxRequests: catalogClientBudget(config),
        timeoutMs: config.scan.rest.timeoutMs,
      })
    : null;
// ПОРТ hq-parallel (S2): роли процесса — web = сервер + user-воркер,
// rating = планировщик + rating-воркер, all = dev-всё-в-одном (user вперёд)
const role = config.processRole;
if (role === "web" || role === "all") {
  startWorkerLoop({ db, config, serverClient }, { user: true, rating: role === "all" });
}
if (role === "rating" || role === "all") {
  startScheduler(db, catalogClient, config);
  if (role === "rating") {
    startWorkerLoop({ db, config, serverClient }, { rating: true });
  }
}
console.log(`  role: ${role} (PROCESS_ROLE)`);

// ПОРТ hq-parallel (S3) + Ф2.2 (В4.2a): стартовое обслуживание — осиротевшие
// каталоги клонов в tmp (после crash/OOM их не подбирал никто) И осиротевшие
// `running`-строки `scans` (процесс умер, скан «идёт» вечно). Свип при старте
// работает в любой роли процесса: роль `web` планировщика не поднимает
void maintenanceTick(db, config);
process.on("SIGTERM", () => {
  console.log("[signal] SIGTERM — выходим (сирот подберёт стартовый свип при подъёме)");
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
console.log(`  scheduler: интервал ${Math.round(config.scheduler.intervalMs / 60000)} мин, форс-полный ${config.scheduler.fullRescan ? "ВКЛ" : "выкл"}`);
