// HTTP-сервер: фронтенд (React + Gravity UI, Bun бандлит из HTML-импорта; в dev —
// HMR, при NODE_ENV=production — без него), API чтения, вход и кабинет.
// Сервер только разбирает запрос, валидирует и сериализует: логика чтения —
// чистые функции src/api/*, логика входа — src/auth/* (тестируются без HTTP).
// Наружу сервер ходит только при входе (OAuth-обмен) и по явному действию
// пользователя с его PAT; данные рейтинга появляются исключительно сканом.
import { loadConfig } from "./config";
import { openDb, setMetaValue } from "./db";
import { fixFileFor, getAiJobStatus, getMeta, listRepos, parseReposQuery, resolveCardForViewer, type CardOutcome, type RepoCard } from "./api/repos";
import { isFixRuleId, isLicenseId, LICENSE_IDS, type LicenseId } from "./fix/templates";
import { buildCompare, parseCompareQuery } from "./api/compare";
import { getHealth } from "./api/health";
import {
  classifyScStatus,
  isOwnRepo,
  makeAccessCache,
  probeIoOf,
  ownUndecided,
  probeRepoAccess,
  resolveAccess,
  visibilityOf,
  type AccessRepo,
  type AccessResult,
  type NormalizedAccess,
  type ProbeIo,
} from "./auth/access";
import { makeAppsecClient } from "./collectors/appsec";
import {
  addFavoriteCapped,
  checkFavoriteAccess,
  favoriteEnqueueOf,
  isFavorite,
  listFavorites,
  listMyRepos,
  myJobs,
  myRepoEntryOf,
  parseFavoriteInput,
  removeFavorite,
  requestUserScan,
  resetFavoriteRights,
  seedFavoritesFromNamespace,
  staleFavoriteSlugs,
  userScanCheapGate,
  viewerMayReadRepo,
  type FavoriteCheckResult,
  type FavoriteEnqueue,
  type PatSeed,
  type UserScanResponse,
} from "./api/me";
import { makeRecheckPump } from "./api/recheck";
import { recordRefusedUserJob } from "./jobs/scheduler";
import { renderRepoReport } from "./report/markdown";
import { REPORT_NO_SCORE } from "./report/build";
import { reportFileName } from "./web/format";
import { pdfResponse } from "./report/pdf";
import { docsImageResponse, docsPdfResponse, docsSource } from "./docs/load";
import { catalogClientBudget, closeOwnRunningScans, maintenanceTick, returnOwnRunningJobs, startMaintenance, startScheduler, startWorkerLoops, workerLoopPlan, workerLoopSummary } from "./jobs/scheduler";
import { enqueueCheck, enqueueSummary, lastFinishedScan } from "./jobs/scheduler";
import { aiQuota, clearUnlock, isUnlocked, quotaRefusal, tryUnlock, type QuotaRefusal } from "./jobs/ai-quota";
import type { AiAudience } from "./db";
import { getAiNotesHistory, getRepoHistory } from "./api/history";
import { BADGE_CACHE_SECONDS, getPublicRepo, parseBadgeStyle, publicRankBadge, renderBadgeSvg } from "./api/public";
import { NO_PAT_ACCESS } from "./auth/access";
import { killActiveClones } from "./collectors/git";
import {
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  cookieNames,
  createSession,
  getSessionUser,
  makeOAuthState,
  oauthStateCookieHeader,
  oauthNextCookieHeader,
  clearOAuthNextCookieHeader,
  oauthNextFromCookie,
  safeNextPath,
  oauthStateFromCookie,
  loopbackOriginRedirect,
  parseCookies,
  sessionCookieHeader,
  SESSION_TTL_MS,
  revokeSession,
  upsertUser,
  userProfile,
} from "./auth/session";
import { deletePat, getPat, patMeta, patReadable, storePat } from "./auth/pat";
import { buildAuthUrl, exchangeCode, yaAvatarUrl, type YaEndpoints } from "./auth/ya";
import { makeScClient } from "./collectors/http";
import { listSourcecraftRepos } from "./api/me";
import { needsRescore, runStartupRescore, RESCORE_ERROR } from "./score/rescore";
import index from "./web/index.html";

const config = loadConfig();
// Скользящие окна лимитов, ключ — id пользователя.
const patProbes = new Map<number, number[]>();
const favoriteChecks = new Map<number, number[]>();
const myReposViews = new Map<number, number[]>();
// Показ карточки залогиненному зрителю — до 3 живых запросов с его PAT плюс
// вымывание кэша доступа, поэтому окно нужно. Аноним без лимита: публичная
// карточка в сеть не ходит.
const cardViews = new Map<number, number[]>();
// опросов статуса AI-заявок на пользователя в минуту: вкладка делает 4,
// предел щадящий и нужен только против скриптов
const aiStatusPolls = new Map<number, number[]>();
const AI_STATUS_POLLS_PER_MINUTE = 120;
// запросов генерации описания на пользователя в минуту (кулдаун репо — отдельно)
const summaryPosts = new Map<number, number[]>();
const SUMMARY_POSTS_PER_MINUTE = 6;
// бейдж и публичный API — свой лимит по IP: README дергает бейдж чаще, чем UI
const badgeHits = new Map<string, number[]>();
const BADGE_PER_MINUTE_PER_IP = 120;
// потолок карты: подделанный X-Forwarded-For не должен растить память бесконечно
const BADGE_KEYS_CAP = 10_000;

/** Адрес из частной или локальной сети: так к сервису подключается прокси стенда. */
function isPrivatePeer(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

/**
 * Ключ лимита публичного API – адрес клиента. X-Forwarded-For учитывается,
 * только если соединение пришло из частной сети, то есть от прокси: Caddy
 * стенда не доверяет входящему заголовку (trusted_proxies не заданы) и ставит
 * в него один адрес клиента. Если сервис открыт наружу без прокси, заголовок
 * мог бы подставить сам клиент, поэтому ключом служит адрес соединения.
 */
function clientKey(req: Request): string {
  const peer = server.requestIP(req)?.address ?? null;
  if (peer === null || isPrivatePeer(peer)) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return peer ?? "local";
}

function badgeWindowHasRoom(req: Request, now = Date.now()): boolean {
  const key = clientKey(req);
  const windowMs = 60_000;
  // чистка всей карты на каждый вызов (как в allowInWindow) и вытеснение
  // старейших ключей сверх капа (Map хранит порядок вставки)
  for (const [id, stamps] of badgeHits) {
    const alive = stamps.filter((t) => now - t < windowMs);
    if (alive.length === 0) badgeHits.delete(id);
    else badgeHits.set(id, alive);
  }
  while (badgeHits.size >= BADGE_KEYS_CAP) {
    const oldest = badgeHits.keys().next().value;
    if (oldest === undefined) break;
    badgeHits.delete(oldest);
  }
  const hits = badgeHits.get(key) ?? [];
  if (hits.length >= BADGE_PER_MINUTE_PER_IP) return false;
  hits.push(now);
  badgeHits.set(key, hits);
  return true;
}
/**
 * CORS публичного API: любой сайт может прочитать JSON и бейдж из браузера.
 * Заголовок ставится на все ответы /api/v1/*, включая 404, 400 и 429, чтобы
 * браузерный код видел ошибку; cookie и авторизация здесь не используются,
 * поэтому Allow-Credentials не нужен. OPTIONS отвечает сразу, без лимита.
 */
function publicCors<R extends Request>(handler: (req: R) => Response): (req: R) => Response {
  return (req) => {
    const res =
      req.method === "OPTIONS"
        ? new Response(null, {
            status: 204,
            headers: { "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-max-age": "86400" },
          })
        : handler(req);
    res.headers.set("access-control-allow-origin", "*");
    return res;
  };
}

/** Одинаковый 404 для приватного, исключенного из каталога и несуществующего — чтобы не выдавать, что репо есть. */
function publicNotFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
// частые PUT/DELETE звезды нагружают БД — минутное окно мутаций избранного
const favMutations = new Map<number, number[]>();

/**
 * Скользящее окно счетчика на пользователя: true = пропустить, лимит не исчерпан.
 * Карта чистится целиком на каждый вызов — иначе в ней навсегда оставалась бы
 * запись о каждом пользователе, заходившем за жизнь процесса.
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

/** Есть ли место в окне — без списания (проба PAT списывает место только при вердикте). */
function windowHasRoom(windows: Map<number, number[]>, userId: number, limit: number, windowMs: number, now = Date.now()): boolean {
  const stamps = (windows.get(userId) ?? []).filter((ts) => ts > now - windowMs);
  return stamps.length < limit;
}

function windowPush(windows: Map<number, number[]>, userId: number, now = Date.now()): void {
  const stamps = windows.get(userId) ?? [];
  stamps.push(now);
  windows.set(userId, stamps);
}

/** Через сколько секунд освободится место в окне — значение `Retry-After`. */
function windowRetryAfterSec(windows: Map<number, number[]>, userId: number, windowMs: number, now = Date.now()): number {
  const alive = (windows.get(userId) ?? []).filter((ts) => ts > now - windowMs);
  if (alive.length === 0) return 1;
  return Math.max(1, Math.ceil((Math.min(...alive) + windowMs - now) / 1000));
}

/** Каждый 429 несет `Retry-After`. */
function rateLimited(message: string, retryAfterSec: number): Response {
  return Response.json({ error: { code: "rate_limited", message } }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.round(retryAfterSec))) } });
}

/** Отказ по лимиту AI: код окна, текст и время, когда можно повторить. */
function quotaResponse(refusal: QuotaRefusal): Response {
  const retryAfterSec = Math.max(1, Math.round((Date.parse(refusal.until) - Date.now()) / 1000));
  return Response.json(
    { error: { code: refusal.code, message: refusal.message, until: refusal.until } },
    { status: 429, headers: { "retry-after": String(retryAfterSec) } },
  );
}

const allowFavoriteCheck = (userId: number, now = Date.now()): boolean =>
  allowInWindow(favoriteChecks, userId, config.queue.favoriteChecksPerMinute, 60_000, now);

const allowMyReposView = (userId: number, now = Date.now()): boolean =>
  allowInWindow(myReposViews, userId, config.queue.myReposPerMinute, 60_000, now);

const allowCardView = (userId: number, now = Date.now()): boolean =>
  allowInWindow(cardViews, userId, config.queue.cardPerMinute ?? 30, 60_000, now);

/**
 * Сравнение N репозиториев списывает N открытий карточки, и только если в окне
 * есть место под все N: сравнение 3 репо стоит как 3 карточки, нагрузка на
 * проверки прав не растет. true = пропустить.
 */
const allowCardViews = (userId: number, n: number, now = Date.now()): boolean => {
  const limit = config.queue.cardPerMinute ?? 30;
  const alive = (cardViews.get(userId) ?? []).filter((ts) => ts > now - 60_000);
  if (alive.length + n > limit) return false;
  cardViews.set(userId, alive);
  for (let i = 0; i < n; i++) windowPush(cardViews, userId, now);
  return true;
};

/**
 * `Retry-After` сравнения — до освобождения N-го места, а не одного, иначе
 * повтор в указанный срок снова получит 429.
 */
function cardViewsRetryAfterSec(userId: number, n: number, now = Date.now()): number {
  const limit = config.queue.cardPerMinute ?? 30;
  const alive = (cardViews.get(userId) ?? []).filter((ts) => ts > now - 60_000).sort((a, b) => a - b);
  const needFree = alive.length + n - limit;
  if (needFree <= 0) return 1;
  const stamp = alive[needFree - 1];
  return stamp === undefined ? 60 : Math.max(1, Math.ceil((stamp + 60_000 - now) / 1000));
}

const allowFavMutation = (userId: number, now = Date.now()): boolean =>
  allowInWindow(favMutations, userId, config.queue.favoritesMutationsPerMinute ?? 30, 60_000, now);

/**
 * У Bun.serve нет глобальных заголовков — защита от фрейминга и
 * MIME-сниффинга ставится оберткой над каждым ответом.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function harden(handler: (req: Request) => Response | Promise<Response>): (req: Request) => Response | Promise<Response> {
  const apply = (res: Response): Response => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  };
  return (req: Request) => {
    const out = handler(req);
    return out instanceof Promise ? out.then(apply) : apply(out);
  };
}

/** Обёртка над таблицей маршрутов: каждый обработчик (и метод во вложенной
 *  карте) отвечает с заголовками; Response/HTMLBundle-значения проходят
 *  как есть (их Bun разложил бы в метод-карту и сломал). */
function hardenRoutes<T extends Record<string, unknown>>(routes: T): T {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === "function") {
      out[path] = harden(value as (req: Request) => Response | Promise<Response>);
    } else if (value !== null && typeof value === "object" && Object.values(value).length > 0 && Object.values(value).every((v) => typeof v === "function")) {
      const methods: Record<string, unknown> = {};
      for (const [method, handler] of Object.entries(value as Record<string, unknown>)) {
        methods[method] = harden(handler as (req: Request) => Response | Promise<Response>);
      }
      out[path] = methods;
    } else {
      out[path] = value;
    }
  }
  return out as T;
}

/** Живая проба токена — оракул валидности PAT; лимит не дает использовать сервис для перебора токенов. */
const PAT_PROBES_PER_HOUR = 10;

const db = openDb(config);

// Имена и атрибуты cookie зависят от схемы YA_REDIRECT_URI: на https это
// `__Host-rh_*` с Secure. Читается только актуальное имя.
const ck = cookieNames(config.auth);

const badQuery = (message: string): Response =>
  Response.json({ error: { code: "bad_query", message } }, { status: 400 });
// 404 API не кэшируется (как publicNotFound): иначе ответ на кривой слаг мог бы
// осесть в кэше прокси или браузера
const notFound = (message: string): Response =>
  Response.json({ error: { code: "not_found", message } }, { status: 404, headers: { "cache-control": "no-store" } });
const unauthorized = (message = "нужно войти через Я ID"): Response =>
  Response.json({ error: { code: "unauthorized", message } }, { status: 401 });
const forbidden = (message: string): Response =>
  Response.json({ error: { code: "forbidden", message } }, { status: 403 });

const favoriteRateLimited = (userId: number): Response =>
  rateLimited(
    `не больше ${config.queue.favoritesMutationsPerMinute ?? 30} изменений избранного в минуту – попробуйте чуть позже`,
    windowRetryAfterSec(favMutations, userId, 60_000),
  );

/** Окно открытий карточки (карточка, MD, PDF) исчерпано — 429 с Retry-After. */
const cardRateLimited = (userId: number): Response =>
  rateLimited(`не больше ${config.queue.cardPerMinute ?? 30} открытий карточки в минуту – попробуйте чуть позже`, windowRetryAfterSec(cardViews, userId, 60_000));

/** Предел избранного — 409 без меты репо, чтобы не выдать факт существования приватного. */
const favoriteLimit = (max: number): Response =>
  Response.json({ error: { code: "favorite_limit", message: `в избранном не больше ${max} репозиториев – уберите лишние, чтобы добавить новый` } }, { status: 409 });

// CSRF-гард по Origin на мутирующих /api/me/* и /auth/logout. Заголовка нет —
// пропустить (межсайтовый POST и так закрыт SameSite=Lax); есть и не совпал с
// origin YA_REDIRECT_URI (без него — localhost/127.0.0.1:PORT) — 403.
const allowedOrigins = (): Set<string> => {
  const out = new Set<string>();
  try {
    out.add(new URL(config.auth.redirect).origin);
  } catch {
    /* кривой redirect — остаются локальные дефолты ниже */
  }
  // локальные адреса разрешаются и на фактическом PORT: без YA_REDIRECT_URI
  // дефолт redirect смотрит на 8418, и стенд на другом порту отклонял бы любое
  // изменение как «чужую страницу»
  const local = [...out].some((o) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  if (out.size === 0 || local) {
    out.add(`http://localhost:${config.port}`);
    out.add(`http://127.0.0.1:${config.port}`);
  }
  return out;
};

/** null = запрос прошёл гард; Response = 403 «чужой Origin». */
function guardOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "") return null;
  return allowedOrigins().has(origin) ? null : forbidden("запрос отклонен: он пришел с чужой страницы");
}

/**
 * Сегмент слага из одних точек («.», «..») проходит по набору символов, но по
 * смыслу это обход пути — отдается 400.
 */
function validSlugSegment(segment: string | undefined): boolean {
  return typeof segment === "string" && /^[a-z0-9_.-]+$/i.test(segment) && !/^[.]+$/.test(segment);
}

/** Сессия из cookie; APP_SECRET отсутствует = сессии принципиально выключены. */
function sessionOf(req: Request) {
  if (!config.auth.appSecret) return null;
  const cookies = parseCookies(req.headers.get("cookie"));
  return getSessionUser(db, config.auth.appSecret, cookies[ck.session]);
}

/**
 * Ретраи 429/503 для клиентов, которые отвечают человеку в том же HTTP-запросе
 * (проба токена, карточка, проверка прав, предпроверка запуска): один повтор и
 * короткий потолок ожидания, чтобы запрос не висел десятки секунд. Фоновые
 * клиенты (каталог, скан) используют дефолт `http.ts` (3 повтора, потолок 30 с).
 */
const INTERACTIVE_RETRY = { maxRetries: 1, maxWaitMs: 2_000, baseBackoffMs: 500 } as const;

/** REST-клиент с PAT пользователя; PAT нет — null. */
function userClient(userId: number) {
  const pat = config.auth.appSecret ? getPat(db, config.auth.appSecret, userId) : null;
  if (!pat) return null;
  return makeScClient({ retry: INTERACTIVE_RETRY, token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, timeoutMs: config.scan.rest.timeoutMs });
}

// Доступ зрителя к каналам карточки — прямые чтения с PAT зрителя и кэш в
// памяти процесса (TTL cacheTtlMs, для сбоя — failedTtlMs, предел maxEntries;
// одновременные проверки склеиваются, смена PAT сбрасывает запись)
const accessCache = makeAccessCache(config.access.cacheTtlMs, { failedTtlMs: config.access.failedTtlMs, maxEntries: config.access.maxEntries });

/** Резолвер доступа зрителя запроса (аноним / без PAT → no-pat без запросов). */
function viewerAccess(req: Request): (repo: AccessRepo) => Promise<AccessResult> {
  const user = sessionOf(req);
  return (repo) => {
    const pat = user && config.auth.appSecret ? getPat(db, config.auth.appSecret, user.userId) : null;
    return resolveAccess(
      {
        restClient: (token) =>
          makeScClient({ retry: INTERACTIVE_RETRY, token, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 4, timeoutMs: config.scan.rest.timeoutMs }),
        appsecClient: (token) =>
          makeAppsecClient({ token, baseUrl: config.api.appsecBase, minIntervalMs: config.scan.rest.appsecMinIntervalMs, maxRequests: 2, timeoutMs: 10_000, retryMaxWaitMs: INTERACTIVE_RETRY.maxWaitMs }),
        cache: accessCache,
      },
      user ? { userId: user.userId, pat } : null,
      repo,
    );
  };
}

/**
 * Доступ зрителя к репо по строке каталога — как у карточки: ключ кэша прав —
 * настоящий repos.id (с общим ключом все репо делили бы одну запись кэша, и
 * чужой репо получал бы права своего), видимость — из каталога. Нет строки —
 * прав нет (ответ все равно 404).
 */
async function accessBySlug(req: Request, org: string, repo: string): Promise<AccessResult> {
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
  if (!row) return { ...NO_PAT_ACCESS };
  return viewerAccess(req)({ id: row.id, org, repo, visibility: row.visibility });
}

/** PAT пользователя, если он читается текущим ключом; иначе null. */
function patOf(userId: number): string | null {
  return config.auth.appSecret ? getPat(db, config.auth.appSecret, userId) : null;
}

/** Ввод-вывод живой проверки прав на PAT пользователя: интерактивный ретрай, общий ритм токена. */
function probeIoFor(pat: string): ProbeIo {
  const rest = makeScClient({ retry: INTERACTIVE_RETRY, token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 8, timeoutMs: config.scan.rest.timeoutMs });
  // адрес AppSec — из конфига, чтобы тесты не ходили на боевой
  const appsec = makeAppsecClient({ token: pat, baseUrl: config.api.appsecBase, minIntervalMs: config.scan.rest.appsecMinIntervalMs, retryMaxWaitMs: INTERACTIVE_RETRY.maxWaitMs });
  return probeIoOf(rest, appsec);
}

/**
 * Фоновая перепроверка прав избранного — насос в памяти процесса: окно
 * проверок пользователя не расходует, анализ не ставит. Клиенты — на PAT
 * пользователя, ритм общий с остальными его запросами.
 */
const recheckPump = makeRecheckPump({
  db,
  probeIo: (userId) => {
    const pat = patOf(userId);
    return pat ? probeIoFor(pat) : null;
  },
  log: (m) => console.log(m),
});

/** Чем располагает зритель карточки: нет сессии / нет токена / токен есть. */
function viewerAuthOf(req: Request): "no-session" | "no-pat" | "pat" {
  const user = sessionOf(req);
  if (!user) return "no-session";
  return patOf(user.userId) ? "pat" : "no-pat";
}

/**
 * Исход показа карточки зрителю запроса — одна сборка для карточки, MD, PDF и
 * сравнения (у сравнения нет своей проверки прав, оно идет через тот же гейт).
 */
function cardOutcome(req: Request, org: string, repo: string): Promise<CardOutcome> {
  const viewer = sessionOf(req);
  const auth = viewerAuthOf(req);
  return resolveCardForViewer(db, org, repo, viewerAccess(req), {
    limits: config.scan,
    viewerUserId: viewer?.userId,
    viewerAuth: auth,
    summaryCooldownMs: config.queue.summaryCooldownMs,
    provenRights: () => viewer !== null && viewerMayReadRepo(db, viewer.userId, org, repo, { savedRightsValid: auth === "pat" }),
  });
}

/**
 * Карточка для зрителя запроса или готовый отказ. Владелец приватного
 * репозитория с доказанными правами при сбое проверки получает «проверка не
 * удалась» / «токен отклонен», а не «не найден»; остальным — нейтральный 404.
 */
async function cardOrRefusal(req: Request, org: string, repo: string): Promise<RepoCard | Response> {
  const out = await cardOutcome(req, org, repo);
  if (out.kind === "card") return out.card;
  if (out.kind === "check_failed") {
    return Response.json(
      { error: { code: "check_failed", message: "SourceCraft сейчас не отвечает – не удалось проверить доступ к репозиторию, попробуйте позже" } },
      { status: 503 },
    );
  }
  if (out.kind === "token_rejected") {
    return Response.json({ error: { code: "pat_rejected", message: "SourceCraft отклонил ваш токен – обновите его в Настройках" } }, { status: 409 });
  }
  return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
}

/**
 * Добавление в избранное (звезда и «Добавить») с синхронной проверкой прав в
 * том же PUT (до 3 запросов). Первый анализ своего репозитория ставится только
 * здесь, при явном добавлении, через `requestUserScan` со всеми его кулдаунами
 * и капами. Окно проверок исчерпано — новый репозиторий не добавляется (429 с
 * `Retry-After`), а повторная звезда существующей записи уходит в фоновый
 * насос без анализа. Ответ — обновленная запись строки (чтобы клиент не
 * перечитывал весь список) и исход проверки.
 */
async function addFavoriteAndCheck(userId: number, org: string, repo: string): Promise<Response> {
  const outcome = addFavoriteCapped(db, userId, org, repo, config.queue.favoritesMax);
  if (outcome === "limit") return favoriteLimit(config.queue.favoritesMax);
  const pat = patOf(userId);
  let check: { status: FavoriteCheckResult | "deferred" | "no_pat"; enqueue: FavoriteEnqueue | null } = { status: "no_pat", enqueue: null };
  if (pat !== null) {
    if (!allowFavoriteCheck(userId)) {
      // новый репозиторий без проверки существования не добавляется (окно
      // исчерпано нашим лимитом, а не сбоем SourceCraft); повторная звезда
      // существующей записи уходит в фон
      if (outcome === "added") {
        removeFavorite(db, userId, org, repo);
        return rateLimited(
          "не больше " + config.queue.favoriteChecksPerMinute + " добавлений в избранное в минуту – повторите чуть позже",
          windowRetryAfterSec(favoriteChecks, userId, 60_000),
        );
      }
      check = { status: "deferred", enqueue: null };
      recheckPump.enqueue(userId, [{ org, repo }]);
    } else {
      const io = probeIoFor(pat);
      const rest = userClient(userId)!;
      const result = await checkFavoriteAccess(db, userId, org, repo, { ...io, cooldownMs: config.queue.favoriteOwnCooldownMs }, async (repoRes) =>
        // постановка целиком через requestUserScan, чтобы не обойти дедуп,
        // too_many_active, rate_limited и транзакцию; repo-GET не повторяется
        favoriteEnqueueOf(await requestUserScan(db, rest, userId, org, repo, config.queue, new Date(), repoRes)),
      );
      // репозиторий, которого SourceCraft не отдает токену (нет такого или нет
      // доступа), в избранное не добавляется; прежняя запись (повторная звезда)
      // остается
      if (outcome === "added" && result.result === "checked" && !result.access.clone) {
        removeFavorite(db, userId, org, repo);
        return Response.json(
          { error: { code: "repo_not_found", message: `репозиторий ${org}/${repo} не найден в SourceCraft или ваш токен его не видит` } },
          { status: 404 },
        );
      }
      check = { status: result.result, enqueue: result.enqueue };
      // сбой проверки (платформа или каналы) — не вердикт: запись остается
      // «не проверенной» и уходит в насос (он анализ не ставит)
      if (result.result === "failed") recheckPump.enqueue(userId, [{ org, repo }]);
    }
  }
  const saved = listFavorites(db, userId).find((f) => f.org === org && f.repo === repo) ?? null;
  return Response.json({
    ok: true,
    favorite: true,
    entry: myRepoEntryOf(db, userId, org, repo, { savedRightsValid: pat !== null }),
    access: saved?.access ?? null,
    lastCheckedAt: saved?.lastCheckedAt ?? null,
    check,
  });
}

/** Исход «свой ли репозиторий» для запуска анализа. */
type Ownership =
  | { kind: "own"; repoRes: { status: number; json: unknown } }
  | { kind: "not_own" }
  | { kind: "denied" }
  | { kind: "token_rejected" }
  | { kind: "unknown" };

async function ownershipOf(req: Request, userId: number, org: string, repo: string): Promise<Ownership> {
  const row = db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
  let access: NormalizedAccess;
  let repoRes: { status: number; json: unknown };
  if (row) {
    // общий резолвер доступа карточки — с её кэшем (повторный запуск с
    // карточки не делает новых запросов)
    const res = await viewerAccess(req)({ id: row.id, org, repo, visibility: row.visibility });
    access = { repo: res.repo, cicd: res.cicd, appsec: res.appsec, visibility: visibilityOf(row.visibility) };
    repoRes = { status: res.repo === "granted" ? 200 : 0, json: { visibility: row.visibility } };
  } else {
    const pat = patOf(userId);
    if (!pat) return { kind: "unknown" };
    const probe = await probeRepoAccess(probeIoFor(pat), org, repo);
    access = probe.access;
    repoRes = probe.repoRes;
  }
  if (isOwnRepo(access)) return { kind: "own", repoRes };
  if (access.repo === "pat-expired") return { kind: "token_rejected" };
  if (access.repo === "denied") return { kind: "denied" };
  if (access.repo !== "granted") return { kind: "unknown" };
  // репо видно, но каналы не проверились — «свой» не определён: не вердикт
  if (ownUndecided(access)) return { kind: "unknown" };
  return { kind: "not_own" };
}

/** Отказ запуска для не своего репозитория; `record` — записать строку отказа (она входит в лимит частоты, как прочие отказы). */
function scanRefusal(own: Exclude<Ownership, { kind: "own" }>, org: string, repo: string): { status: number; body: unknown; record: boolean } {
  switch (own.kind) {
    case "not_own":
      return {
        status: 403,
        body: { error: { code: "not_own", message: `анализ запускается только для своих репозиториев – ${org}/${repo} обновляется ночным обходом` } },
        record: true,
      };
    case "denied":
      return { status: 403, body: { error: { code: "no_access", message: `ваш токен не дает доступа к ${org}/${repo}` } }, record: true };
    case "token_rejected":
      return { status: 401, body: { error: { code: "pat_expired", message: "SourceCraft отклонил ваш токен – обновите его в Настройках" } }, record: true };
    default:
      // сбой проверки — не вердикт и не списание лимита запусков
      return {
        status: 503,
        body: { error: { code: "check_failed", message: `SourceCraft сейчас не отвечает – не удалось проверить доступ к ${org}/${repo}, попробуйте позже` } },
        record: false,
      };
  }
}

/** Ответ `requestUserScan` → HTTP; 429 — с `Retry-After`. */
function scanResponse(out: UserScanResponse): Response {
  const res = Response.json(out.body, { status: out.status });
  if (out.status === 429) res.headers.set("retry-after", String(out.retryAfterSec ?? 60));
  return res;
}

/** config.auth → креды Я ID (имена полей разъезжаются — склеиваем в одном месте). */
const yaCreds = () => ({
  clientId: config.auth.yaClientId,
  clientSecret: config.auth.yaClientSecret,
  redirect: config.auth.redirect,
});

/** Адреса Я ID — из конфига (тесты направляют их на локальный мок). */
const yaEndpoints = (): YaEndpoints => ({ oauthBase: config.auth.yaOauthBase, loginBase: config.auth.yaLoginBase });

// документация docs/guide: в разработке перечитывается на каждом запросе
const docs = docsSource({ reload: process.env.NODE_ENV !== "production", log: (m) => console.warn(m) });

// таблица маршрутов типизирована как у Bun.serve, чтобы обертка hardenRoutes
// не стирала сигнатуры обработчиков и метод-карт вроде POST
type RoutesTable = NonNullable<Parameters<typeof Bun.serve>[0]>["routes"];
const routes = {
    "/api/health": () => {
      // ok вычисляется (незавершенный рескор, подозрительно пустой каталог,
      // провал ночной фазы) и отдается в теле; HTTP всегда 200 — проверки
      // порта ждут статус, а здоровье читают по телу
      return Response.json(getHealth(db, config));
    },
    "/api/meta": () => Response.json(getMeta(db, { leaseMs: config.scheduler.leaseMs, publicBaseUrl: config.publicBaseUrl })),
    "/api/repos": (req) => {
      const parsed = parseReposQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      return Response.json(listRepos(db, parsed.query));
    },
    // единая карточка: состав ответа зависит от доступа зрителя из cookie.
    // Слаг с невалидным percent-encoding (например, %zz) — 400 bad_query,
    // а не «не найдено» и не 500
    "/api/repos/:org/:repo": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      // 429 — до резолва доступа, чтобы не тратить PAT-запросы
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      return Response.json(card);
    },
    // сравнение 1-3 репозиториев — карточки того же зрителя без AI, рекомендаций
    // и фактов; недоступный репо — элемент `unavailable`, а не 404 всего ответа
    "/api/compare": async (req) => {
      const parsed = parseCompareQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      const viewer = sessionOf(req);
      // 429 — до резолва доступа, как у карточки; списывается по открытию на репо
      if (viewer) {
        const limit = config.queue.cardPerMinute ?? 30;
        // сравнение шире минутного окна не пройдет никогда — честный отказ, а не вечный 429
        if (parsed.slugs.length > limit) return badQuery(`сравнить можно не больше ${limit} репозиториев в минуту`);
        if (!allowCardViews(viewer.userId, parsed.slugs.length)) {
          return rateLimited(
            `не больше ${limit} открытий карточки в минуту – сравнение ${parsed.slugs.length} репозиториев откроется чуть позже`,
            cardViewsRetryAfterSec(viewer.userId, parsed.slugs.length),
          );
        }
      }
      const body = await buildCompare(parsed.slugs, (org, repo) => cardOutcome(req, org, repo));
      return Response.json(body, { headers: { "cache-control": "private, no-store" } });
    },
    "/api/repos/:org/:repo/report.md": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      // MD-выгрузка — та же карточка того же зрителя и тот же лимит
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      // без оценки отчета нет (кнопки выгрузки на такой карточке тоже нет —
      // отказ ловит прямую ссылку)
      if (!card.score) return notFound(REPORT_NO_SCORE);
      return new Response(renderRepoReport(card), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          // отчёт открывают как файл, а не читают в браузере
          "content-disposition": `attachment; filename="${reportFileName(org!, repo!, "md")}"`,
        },
      });
    },
    // PDF того же отчета — зеркало report.md: тот же гард слага, то же окно,
    // та же карточка зрителя (закрытые каналы — без чисел и фактов). Сбой
    // генерации — 500 без стека (`pdfResponse`).
    "/api/repos/:org/:repo/report.pdf": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      if (!card.score) return notFound(REPORT_NO_SCORE);
      return pdfResponse(card);
    },
    // Файл-заготовка presence-правила (без LLM) — зеркало report.md: тот же гард
    // слага, то же окно, та же карточка зрителя. Неизвестное правило или лицензия —
    // 400 до резолва доступа; правило, которое у репо сейчас не срабатывает, — 404.
    "/api/repos/:org/:repo/fix/:ruleId": async (req) => {
      const { org, repo, ruleId } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      if (!isFixRuleId(ruleId!)) return badQuery(`для правила ${ruleId} файла-заготовки нет`);
      const licenseRaw = new URL(req.url).searchParams.get("license");
      if (licenseRaw !== null && !isLicenseId(licenseRaw)) return badQuery(`лицензия ${licenseRaw} не поддерживается: выберите одну из ${LICENSE_IDS.join(", ")}`);
      // лицензию выбирает человек: по умолчанию ничего не выбираем
      if (ruleId === "license-missing" && licenseRaw === null) return badQuery(`выберите лицензию: ${LICENSE_IDS.join(", ")}`);
      const viewer = sessionOf(req);
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      const file = fixFileFor(db, card, ruleId, { license: licenseRaw === null ? undefined : (licenseRaw as LicenseId) });
      if (file === null) return notFound(`у ${org}/${repo} сейчас нет рекомендации ${ruleId} – файл-заготовка не нужна`);
      return new Response(file.content, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${file.filename}"`,
          // содержимое зависит от зрителя (приватный репо) и от свежего анализа
          "cache-control": "private, no-store",
        },
      });
    },
    // ---------- публичный API и бейдж ----------
    // Без авторизации, только публичные репо из рейтинга; приватный, исключенный и
    // несуществующий — одинаковый 404. Отдельный лимит по IP (бейдж дергают из
    // README, он не должен мешать интерактиву); кэш-заголовки на 200; CORS на все
    // ответы (publicCors).
    "/api/v1/repos/:org/:repo": publicCors((req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) return notFound("not found");
      if (!badgeWindowHasRoom(req)) return rateLimited("слишком много запросов – попробуйте позже", 60);
      const proj = getPublicRepo(db, org!, repo!);
      if (proj === null) return publicNotFound();
      return Response.json(proj, { headers: { "cache-control": `public, max-age=${BADGE_CACHE_SECONDS}` } });
    }),
    "/api/v1/repos/:org/:repo/badge.svg": publicCors((req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) return notFound("not found");
      if (!badgeWindowHasRoom(req)) return rateLimited("слишком много запросов – попробуйте позже", 60);
      // `?style=rank` — вариант со значком места
      const style = parseBadgeStyle(new URL(req.url).searchParams);
      if (style === null) return badQuery("неизвестный вид бейджа: допустим только style=rank");
      const proj = getPublicRepo(db, org!, repo!);
      if (proj === null) return publicNotFound();
      return new Response(renderBadgeSvg(proj.healthcraftIndex, style === "rank" ? publicRankBadge(db, proj) : null), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": `public, max-age=${BADGE_CACHE_SECONDS}`,
        },
      });
    }),
    // неизвестный адрес публичного API – тот же JSON-404, что у /api/*, но с CORS
    "/api/v1/*": publicCors(() => notFound("такого адреса нет")),
    // ---------- статус AI-заявок: легкий опрос без прав и без лимита карточки ----------
    // Страница опрашивает его раз в 15 с, пока идет обзор или проверка, и
    // перечитывает карточку один раз по завершении: опрос не съедает окно
    // «30 открытий карточки в минуту» и не делает проб доступа через PAT.
    // Свой щадящий предел — от скриптов, а не от вкладок.
    "/api/repos/:org/:repo/ai-status": (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      if (viewer && !allowInWindow(aiStatusPolls, viewer.userId, AI_STATUS_POLLS_PER_MINUTE, 60_000)) {
        return rateLimited(`не больше ${AI_STATUS_POLLS_PER_MINUTE} опросов статуса в минуту`, windowRetryAfterSec(aiStatusPolls, viewer.userId, 60_000));
      }
      return Response.json(getAiJobStatus(db, org!, repo!, viewer?.userId ?? null), { headers: { "cache-control": "no-store" } });
    },
    // ---------- история оценки и история AI-текстов ----------
    // Публичная проекция строк scores + scans.head_sha; полного Score без прав
    // нет, исключенный или приватный — 404, неотличимый от несуществующего
    "/api/repos/:org/:repo/history": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      // то же минутное окно, что у карточки: иначе историю по списку репо
      // можно было бы дергать без лимита
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const access = viewer === null ? NO_PAT_ACCESS : await accessBySlug(req, org!, repo!);
      const history = getRepoHistory(db, org!, repo!, { access });
      if (history === null) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
      return Response.json(history);
    },
    // Полные AI-тексты не публичны: не видно репо — 404, видно, но полный
    // Score закрыт — 403 locked с причиной
    "/api/repos/:org/:repo/ai-notes": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      const viewer = sessionOf(req);
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const access = viewer === null ? NO_PAT_ACCESS : await accessBySlug(req, org!, repo!);
      const notes = getAiNotesHistory(db, org!, repo!, { access });
      if (notes === null) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
      if (notes.locked) return Response.json({ error: { code: "locked", message: notes.reason } }, { status: 403 });
      return Response.json(notes);
    },
    // ---------- AI-обзор и проверка на накрутку (только по кнопке) ----------
    // Аудиторию обзора решает сервер: свой репо с правами на CI/CD и Безопасность —
    // полная версия; любой вошедший на публичном репо — публичная (4 открытые
    // категории). Лимиты — в БД (jobs/ai-quota.ts), проверяются после бесплатных
    // исходов (кэш, дедуп).
    "/api/repos/:org/:repo/summary": {
      POST: async (req) => {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
        const user = sessionOf(req);
        if (!user) return unauthorized();
        const { org, repo } = req.params;
        if (!validSlugSegment(org) || !validSlugSegment(repo)) {
          return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
        }
        if (!windowHasRoom(summaryPosts, user.userId, SUMMARY_POSTS_PER_MINUTE, 60_000)) {
          return rateLimited("слишком много запросов генерации – попробуйте позже", windowRetryAfterSec(summaryPosts, user.userId, 60_000));
        }
        // окно списывается до живых проб PAT и проверки «свой»: иначе перебор чужих
        // слагов был бы бесплатным, а каждый отказ стоит до 4 REST и 2 AppSec запросов
        windowPush(summaryPosts, user.userId);
        const card = await cardOrRefusal(req, org!, repo!);
        if (card instanceof Response) return card;
        const own = card.viewer?.own === true;
        const fullAccess = card.access?.cicd === "granted" && card.access?.appsec === "granted";
        let audience: AiAudience;
        if (own && fullAccess) audience = "full";
        else if (card.repo.visibility === "public") audience = "public";
        else if (own) {
          // «свой» по доступу к коду, но без прав на CI и AppSec: полного обзора нет,
          // а публичного у закрытого репо не бывает
          return Response.json(
            { error: { code: "no_full_access", message: "AI-обзор доступен, когда токену открыты CI/CD и Безопасность этого репозитория" } },
            { status: 403 },
          );
        } else {
          return Response.json({ error: { code: "not_own", message: "AI-обзор закрытого репозитория доступен его владельцу" } }, { status: 403 });
        }
        const repoRow = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
        if (repoRow === null) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
        // публичная версия строится по готовому анализу — свежий скан она не запускает
        if (audience === "public" && lastFinishedScan(db, repoRow.id) === null) {
          return Response.json({ error: { code: "no_scan", message: "у репозитория еще нет завершенного анализа – обзор строить не по чему" } }, { status: 409 });
        }
        const quota = (): QuotaRefusal | null => quotaRefusal(aiQuota(db, user.userId, "overview", config.ai));
        const unlocked = isUnlocked(db, user.userId, config.ai);
        // Для полной версии кнопка запускает полный цикл: сначала свежий скан, затем
        // генерация по нему; публичная строится по последнему завершенному скану.
        // Кулдаун и лимит проверяются до скана, чтобы не запускать анализ зря.
        const cooldownMs = config.queue.summaryCooldownMs ?? 60 * 60_000;
        const lastSummary = db
          .query("SELECT created_at FROM jobs WHERE repo_id = ? AND kind = 'summary' AND audience = ? AND created_at IS NOT NULL ORDER BY id DESC LIMIT 1")
          .get(repoRow.id, audience) as { created_at: string } | null;
        if (lastSummary !== null && cooldownMs > 1) {
          const elapsed = Date.now() - Date.parse(lastSummary.created_at);
          if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
            return Response.json(
              { error: { code: "cooldown", message: "описание недавно формировалось – следующий запуск будет доступен позже", until: new Date(Date.parse(lastSummary.created_at) + cooldownMs).toISOString() } },
              { status: 429 },
            );
          }
        }
        let scanQueued = false;
        if (audience === "full") {
          const early = quota();
          if (early !== null) return quotaResponse(early);
          // свежий скан best-effort: упрется в лимиты — генерация пойдет по
          // последнему скану, и пользователь увидит об этом уведомление
          const scanClient = userClient(user.userId);
          if (scanClient !== null) {
            const scanOut = await requestUserScan(db, scanClient, user.userId, org!, repo!, config.queue, new Date());
            scanQueued = scanOut.status === 202;
          }
        }
        const out = enqueueSummary(db, repoRow.id, {
          userId: user.userId,
          cooldownMs: config.queue.summaryCooldownMs,
          activeMax: config.queue.summaryActiveMax,
          skipCached: scanQueued,
          audience,
          unlocked,
          quota,
        });
        // заметки по последнему скану уже есть — ответ без второй генерации
        // (лимит не списывается: заявки нет)
        if (out.kind === "cached") {
          console.log(`[summary] ${org}/${repo} (${audience}): POST поверх готовых заметок последнего скана — кэш, заявка не создана`);
          return Response.json({ ok: true, jobId: null, audience, cached: true, queued: false, scanQueued: false });
        }
        if (out.kind === "quota") return quotaResponse(out.refusal);
        if (out.kind === "too_many") {
          return Response.json(
            { error: { code: "too_many_active", message: `не больше ${out.activeMax} генераций описания в очереди одновременно – дождитесь завершения` } },
            { status: 429 },
          );
        }
        if (out.kind === "cooldown") {
          return Response.json(
            { error: { code: "cooldown", message: "описание недавно формировалось – следующий запуск будет доступен позже", until: out.until } },
            { status: 429 },
          );
        }
        return Response.json({ ok: true, jobId: out.jobId, audience, queued: out.kind === "active", scanQueued });
      },
    },
    // «Проверить оценку»: проверка на накрутку по фактам последнего анализа —
    // любому вошедшему, кому видна карточка; результат видят все
    "/api/repos/:org/:repo/check": {
      POST: async (req) => {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
        const user = sessionOf(req);
        if (!user) return unauthorized();
        const { org, repo } = req.params;
        if (!validSlugSegment(org) || !validSlugSegment(repo)) {
          return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
        }
        if (!windowHasRoom(summaryPosts, user.userId, SUMMARY_POSTS_PER_MINUTE, 60_000)) {
          return rateLimited("слишком много запросов – попробуйте позже", windowRetryAfterSec(summaryPosts, user.userId, 60_000));
        }
        windowPush(summaryPosts, user.userId);
        const card = await cardOrRefusal(req, org!, repo!);
        if (card instanceof Response) return card;
        // результат проверки живет в AI-блоке карточки; зрителю, которому AI-блок не
        // открыт (закрытый репо без прав на CI/CD и Безопасность), проверку не ставим —
        // кредиты ушли бы на невидимый ему результат
        if (card.ai === undefined) {
          return Response.json(
            { error: { code: "no_full_access", message: "проверка закрытого репозитория доступна, когда токену открыты CI/CD и Безопасность" } },
            { status: 403 },
          );
        }
        const repoRow = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number } | null;
        if (repoRow === null) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
        const out = enqueueCheck(db, repoRow.id, {
          userId: user.userId,
          activeMax: config.queue.summaryActiveMax,
          unlocked: isUnlocked(db, user.userId, config.ai),
          quota: () => quotaRefusal(aiQuota(db, user.userId, "check", config.ai)),
        });
        if (out.kind === "cached") return Response.json({ ok: true, jobId: null, cached: true, queued: false });
        if (out.kind === "no_scan") {
          return Response.json({ error: { code: "no_scan", message: "у репозитория еще нет завершенного анализа – проверять нечего" } }, { status: 409 });
        }
        if (out.kind === "quota") return quotaResponse(out.refusal);
        if (out.kind === "too_many") {
          return Response.json(
            { error: { code: "too_many_active", message: `не больше ${out.activeMax} проверок в очереди одновременно – дождитесь завершения` } },
            { status: 429 },
          );
        }
        return Response.json({ ok: true, jobId: out.jobId, cached: false, queued: out.kind === "active" });
      },
    },
    // ---------- вход через Я ID (OAuth) ----------
    // Вход всегда с выбором аккаунта. Наш «Выход» отзывает только нашу сессию,
    // а сессия Яндекса живет в его домене: без `force_confirm=yes` следующий
    // `/authorize` молча вернул бы прежнего пользователя, и сменить аккаунт из
    // интерфейса было бы нельзя. Цена — один лишний клик при обычном входе.
    "/auth/ya": (req) => {
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "вход на сервере не настроен – обратитесь к администратору" } }, { status: 503 });
      }
      // Петлевой алиас хоста (127.0.0.1 при redirect_uri на localhost или
      // наоборот) рвал бы первую попытку входа: state-cookie осталась бы на хосте
      // входа, а callback Яндекс отдает на хост redirect_uri. Поэтому вход сначала
      // переводится на канонический хост — state и callback в одной банке кук.
      const hop = loopbackOriginRedirect(new URL(req.url), config.auth.redirect);
      if (hop !== null) {
        return new Response(null, { status: 302, headers: { location: hop } });
      }
      try {
        const state = makeOAuthState();
        const url = buildAuthUrl(yaCreds(), state, yaEndpoints(), { forceConfirm: true });
        // путь возврата после входа — только свой путь (safeNextPath); без него —
        // кабинет
        const next = safeNextPath(new URL(req.url).searchParams.get("next"));
        const headers = new Headers({ location: url });
        headers.append("set-cookie", oauthStateCookieHeader(ck, state));
        headers.append("set-cookie", next !== null ? oauthNextCookieHeader(ck, next) : clearOAuthNextCookieHeader(ck));
        return new Response(null, { status: 302, headers });
      } catch (e) {
        return Response.json({ error: { code: "unconfigured", message: "вход через Я ID на сервере не настроен – обратитесь к администратору" } }, { status: 503 });
      }
    },
    // выход: сессия отзывается в БД, cookie гасится; PAT пользователя остается
    // (он привязан к аккаунту, а не к сессии). Только POST: SameSite=Lax не
    // отдает cookie межсайтовому POST, так что чужая страница выйти не заставит
    "/auth/logout": {
      POST: (req) => {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
        if (!config.auth.appSecret) return new Response(null, { status: 204 });
        revokeSession(db, config.auth.appSecret, parseCookies(req.headers.get("cookie"))[ck.session]);
        return new Response(null, { status: 204, headers: { "set-cookie": sessionCookieHeader(ck, "", 0) } });
      },
    },
    "/auth/ya/callback": async (req) => {
      const url = new URL(req.url);
      // Редирект относительный (абсолютный из Host опасен за кривым прокси), и
      // все исходы callback гасят state-cookie. Несколько Set-Cookie — через
      // Headers.append.
      const callbackRedirect = (location: string, extraCookies: string[] = []): Response => {
        const headers = new Headers({ location });
        for (const c of extraCookies) headers.append("set-cookie", c);
        headers.append("set-cookie", clearOAuthNextCookieHeader(ck));
        return new Response(null, { status: 302, headers });
      };
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        // та же чистка, что у клиента (format.ts authErrorText): без управляющих
        // символов и не длиннее 200 — уже до редиректа, а не только при отрисовке
        const safeError = errorParam.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
        return callbackRedirect(`/me?auth_error=${encodeURIComponent(safeError)}`, [clearOAuthStateCookieHeader(ck)]);
      }
      const stateCookie = oauthStateFromCookie(parseCookies(req.headers.get("cookie"))[ck.oauthState]);
      const state = url.searchParams.get("state");
      if (!stateCookie || !state || state !== stateCookie) {
        return callbackRedirect("/me?auth_error=state", [clearOAuthStateCookieHeader(ck)]);
      }
      const code = url.searchParams.get("code");
      if (!code || !config.auth.appSecret) {
        return callbackRedirect("/me?auth_error=no_code", [clearOAuthStateCookieHeader(ck)]);
      }
      const exchanged = await exchangeCode(yaCreds(), code, undefined, yaEndpoints());
      if (!exchanged.ok) {
        return callbackRedirect(`/me?auth_error=${encodeURIComponent(exchanged.error.slice(0, 120))}`, [clearOAuthStateCookieHeader(ck)]);
      }
      const { yaId, login, displayName, avatarId } = exchanged.profile;
      const userId = upsertUser(db, yaId, login, new Date(), { displayName, avatarId });
      const cookie = createSession(db, config.auth.appSecret, userId);
      const next = oauthNextFromCookie(parseCookies(req.headers.get("cookie"))[`${ck.oauthState}_next`]);
      return callbackRedirect(next ?? "/me", [
        sessionCookieHeader(ck, cookie, SESSION_TTL_MS),
        clearOAuthStateCookieHeader(ck),
      ]);
    },
    // ---------- /api/me: аккаунт, PAT, мои репо ----------
    "/api/me": (req) => {
      // шапка опрашивает этот маршрут на каждой странице: аноним получает 200 с
      // login:null, а не 401 — браузер пишет каждый не-2xx в консоль. Остальные
      // me-эндпоинты отвечают 401
      const user = sessionOf(req);
      if (!user) return Response.json({ login: null, displayName: null, avatarUrl: null, hasPat: false, patCheckedAt: null });
      const meta = config.auth.appSecret ? patMeta(db, user.userId) : null;
      const profile = userProfile(db, user.userId);
      // hasPat = строка есть и читается текущим ключом: после ротации APP_SECRET
      // мертвая строка не выдается за рабочий PAT
      const readable = config.auth.appSecret ? patReadable(db, config.auth.appSecret, user.userId) : false;
      return Response.json({
        login: user.login,
        displayName: profile.displayName,
        avatarUrl: profile.avatarId ? yaAvatarUrl(profile.avatarId) : null,
        hasPat: meta?.hasPat === true && readable,
        patCheckedAt: meta && meta.hasPat && readable ? meta.checkedAt : null,
        // токен сохранен, но текущим ключом не читается (ротация APP_SECRET) —
        // интерфейс объясняет, почему он «не задан»
        patUnreadable: meta?.hasPat === true && !readable,
      });
    },
    "/api/me/pat": async (req) => {
      const csrf = guardOrigin(req);
      if (csrf) return csrf;
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "хранение токенов на сервере не настроено – обратитесь к администратору" } }, { status: 503 });
      }
      if (req.method === "PUT") {
        // живая проба токена — оракул валидности PAT, поэтому окно на пользователя
        // (10 в час). Окно списывает только вердикт платформы (токен принят или
        // отклонен); сбой SourceCraft пробу не сжигает
        if (!windowHasRoom(patProbes, user.userId, PAT_PROBES_PER_HOUR, 60 * 60_000)) {
          return rateLimited("слишком много проверок токена – попробуйте позже", windowRetryAfterSec(patProbes, user.userId, 60 * 60_000));
        }
        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        if (typeof body?.token !== "string" || body.token.length < 8) return badQuery("это не похоже на персональный токен доступа SourceCraft");
        // живая проверка GET /user: вердикт — по общему классификатору статусов
        const probe = makeScClient({
          token: body.token,
          retry: INTERACTIVE_RETRY,
          baseUrl: config.api.restBase,
          minIntervalMs: config.scan.rest.minIntervalMs,
          maxRequests: 2,
          timeoutMs: config.scan.rest.timeoutMs,
        });
        const who = await probe.get("/user");
        const verdict = classifyScStatus(who.status);
        if (verdict === "unavailable") {
          return Response.json(
            { error: { code: "sourcecraft_unavailable", message: "SourceCraft сейчас не отвечает – токен не проверен и не сохранен, попробуйте позже" } },
            { status: 503 },
          );
        }
        windowPush(patProbes, user.userId);
        if (verdict !== "ok") {
          return Response.json({ error: { code: "bad_token", message: "SourceCraft отклонил токен – проверьте, что он скопирован целиком и не отозван" } }, { status: 400 });
        }
        storePat(db, config.auth.appSecret!, user.userId, body.token);
        accessCache.clearUser(user.userId); // новый PAT — новые права
        // права избранного проверялись прежним токеном — гасятся, новые проверит
        // фоновый насос (анализ он не ставит)
        resetFavoriteRights(db, user.userId);
        const username = (who.json as { username?: unknown } | null)?.username ?? null;
        // PAT уже сохранен, посев избранного fail-soft: любой его исход сохранение
        // не откатывает. Отдельный клиент с бюджетом 6 запросов (до 5 страниц по
        // 100; /user уже запрошен пробой). Без username посев не начинается —
        // отдельный код, чтобы не обвинять пространство имен
        let seed: PatSeed = { status: "partial", added: 0, error: { code: "no_username" } };
        if (typeof username === "string" && username !== "") {
          const seeder = makeScClient({
            token: body.token,
            retry: INTERACTIVE_RETRY,
            baseUrl: config.api.restBase,
            minIntervalMs: config.scan.rest.minIntervalMs,
            maxRequests: 6,
            timeoutMs: config.scan.rest.timeoutMs,
          });
          seed = await seedFavoritesFromNamespace(db, seeder, username, user.userId, config.queue.favoritesMax);
        }
        // перепроверка — все записи (и посеянные): их права «не проверены»
        recheckPump.enqueue(user.userId, staleFavoriteSlugs(db, user.userId));
        return Response.json({ ok: true, tokenOwner: typeof username === "string" ? username : null, seed });
      }
      if (req.method === "DELETE") {
        deletePat(db, user.userId);
        accessCache.clearUser(user.userId);
        // удаление токена гасит права, проверенные им
        resetFavoriteRights(db, user.userId);
        recheckPump.clear(user.userId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: { code: "bad_query", message: "метод запроса не поддерживается" } }, { status: 405 });
    },
    "/api/me/repos": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      // кабинет часто перечитывает список — минутное окно; 429 до любой работы маршрута
      if (!allowMyReposView(user.userId)) {
        return rateLimited(
          `не больше ${config.queue.myReposPerMinute} обновлений списка в минуту – попробуйте позже`,
          windowRetryAfterSec(myReposViews, user.userId, 60_000),
        );
      }
      // кабинет читает только избранное — в сеть маршрут не ходит. Сохраненные
      // права действительны, только пока PAT читается (ротация APP_SECRET их гасит)
      const pat = patOf(user.userId);
      const result = await listMyRepos(db, user.userId, { savedRightsValid: pat !== null });
      // записи «не проверено» или старше суток — в фон, по нескольку за раз;
      // ответ не ждет (итог — при следующем чтении списка)
      if (pat !== null) recheckPump.enqueue(user.userId, staleFavoriteSlugs(db, user.userId));
      return Response.json({ username: result.username, entries: result.entries });
    },
    // остаток лимитов AI зрителя — для счетчика у кнопок
    "/api/me/ai-quota": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const now = new Date();
      return Response.json({
        unlockAvailable: config.ai.unlockPassword !== null,
        unlocked: isUnlocked(db, user.userId, config.ai),
        overview: aiQuota(db, user.userId, "overview", config.ai, now),
        check: aiQuota(db, user.userId, "check", config.ai, now),
      });
    },
    // Пароль неограниченного доступа к AI. Попытки не ограничиваются — вместо
    // этого пароль обязан быть длинным; сам пароль не пишется ни в БД (только
    // отпечаток), ни в лог
    "/api/me/ai-unlock": async (req) => {
      const csrf = guardOrigin(req);
      if (csrf) return csrf;
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "DELETE") {
        clearUnlock(db, user.userId);
        return Response.json({ ok: true, unlocked: false });
      }
      if (req.method !== "POST") return Response.json({ error: { code: "method", message: "метод не поддерживается" } }, { status: 405 });
      if (config.ai.unlockPassword === null) {
        return Response.json({ error: { code: "unlock_disabled", message: "доступ по паролю на этом сервере не настроен" } }, { status: 404 });
      }
      // раз попытки не ограничены, размер тела и пароля ограничен — чтобы перебор не
      // превращался в хэширование мегабайтных тел
      if (Number(req.headers.get("content-length") ?? "0") > 4096) {
        return Response.json({ error: { code: "too_large", message: "слишком длинный запрос" } }, { status: 413 });
      }
      const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
      if (typeof body?.password !== "string" || body.password.length === 0) return badQuery("введите пароль");
      if (body.password.length > 256) return badQuery("пароль длиннее 256 символов");
      // пароль в .env читается без пробелов по краям — введенный тоже
      if (!tryUnlock(db, user.userId, body.password.trim(), config.ai)) {
        return Response.json({ error: { code: "wrong_password", message: "пароль не подошел" } }, { status: 403 });
      }
      return Response.json({ ok: true, unlocked: true });
    },
    "/api/me/jobs": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      // ответ несет `login`: если в соседней вкладке вошли другим аккаунтом,
      // эта вкладка заметит расхождение на ближайшем опросе и перечитает /api/me
      return Response.json({ login: user.login, ...myJobs(db, user.userId) });
    },
    // пикер своих репозиториев — только по PAT зрителя, то же минутное окно
    // чтений, что у кабинета
    "/api/me/sourcecraft-repos": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const pat = patOf(user.userId);
      if (pat === null) return Response.json({ error: { code: "no_pat" } }, { status: 409 });
      if (!allowMyReposView(user.userId)) {
        return rateLimited(
          `не больше ${config.queue.myReposPerMinute} обновлений списка в минуту – попробуйте позже`,
          windowRetryAfterSec(myReposViews, user.userId, 60_000),
        );
      }
      // бюджет запросов — под полный обход страниц: платформа отдает по 1-2 записи на страницу
      const client = makeScClient({ retry: INTERACTIVE_RETRY, token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 40, timeoutMs: config.scan.rest.timeoutMs });
      const result = await listSourcecraftRepos(client);
      if (result.status === "source_http") return Response.json({ error: { code: "source_http" } }, { status: 502 });
      return Response.json({ repos: result.repos, partial: result.partial });
    },
    "/api/me/favorites": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "GET") {
        return Response.json({ entries: listFavorites(db, user.userId) });
      }
      // ручной ввод — JSON {repository: "org/repo" | ссылка SourceCraft};
      // тот же парсер, что у маршрута звезды
      if (req.method === "PUT") {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
        // ввод разбирается до окна, чтобы отказ 400 не списывал мутацию
        const body = (await req.json().catch(() => null)) as { repository?: unknown } | null;
        if (typeof body?.repository !== "string") return badQuery("укажите репозиторий как org/repo или ссылкой на него");
        const parsed = parseFavoriteInput(body.repository);
        if (!parsed) return badQuery("укажите репозиторий как org/repo или ссылкой на него");
        if (!allowFavMutation(user.userId)) return favoriteRateLimited(user.userId);
        return addFavoriteAndCheck(user.userId, parsed.org, parsed.repo);
      }
      return Response.json({ error: { code: "bad_query", message: "метод запроса не поддерживается" } }, { status: 405 });
    },
    "/api/me/favorites/:org/:repo": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      if (req.method !== "GET") {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
      }
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "PUT") {
        // тот же парсер, что у ручного ввода; разбор — до окна
        const parsed = parseFavoriteInput(`${org}/${repo}`);
        if (!parsed) return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
        if (!allowFavMutation(user.userId)) return favoriteRateLimited(user.userId);
        return addFavoriteAndCheck(user.userId, parsed.org, parsed.repo);
      }
      if (req.method === "DELETE") {
        if (!allowFavMutation(user.userId)) return favoriteRateLimited(user.userId);
        removeFavorite(db, user.userId, org!, repo!);
        return Response.json({ ok: true, favorite: false });
      }
      if (req.method === "GET") {
        return Response.json({ favorite: isFavorite(db, user.userId, org!, repo!) });
      }
      return Response.json({ error: { code: "bad_query", message: "метод запроса не поддерживается" } }, { status: 405 });
    },
    "/api/me/repos/:org/:repo/scan": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("адрес репозитория указан неверно: нужен вид org/repo из латинских букв, цифр, точек, дефисов и подчеркиваний");
      }
      if (req.method !== "POST") {
        return Response.json({ error: { code: "bad_query", message: "метод запроса не поддерживается" } }, { status: 405 });
      }
      const csrf = guardOrigin(req);
      if (csrf) return csrf;
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const client = userClient(user.userId);
      if (!client) {
        return Response.json({ error: { code: "no_pat", message: "сначала добавьте персональный токен доступа SourceCraft в Настройках" } }, { status: 409 });
      }
      // дешевые отказы (дедуп, активные, часовой лимит) — до сети
      const cheap = userScanCheapGate(db, user.userId, org!, repo!, config.queue);
      if (cheap) return scanResponse(cheap);
      // Анализ по запросу — только для своих репозиториев. «Свой» определяется
      // по доступу из общего резолвера (с кэшем карточки); строки репо еще нет —
      // живая проверка теми же правилами. Неизвестно — не свой
      const own = await ownershipOf(req, user.userId, org!, repo!);
      if (own.kind !== "own") {
        const refusal = scanRefusal(own, org!, repo!);
        if (refusal.record) recordRefusedUserJob(db, user.userId, new Date(), `${org}/${repo}`);
        return Response.json(refusal.body, { status: refusal.status });
      }
      // repo-GET уже сделан (или доступ подтвержден кэшем карточки) — строка
      // repos и заявка появляются только при доказанном доступе
      const out = await requestUserScan(db, client, user.userId, org!, repo!, config.queue, new Date(), own.repoRes);
      return scanResponse(out);
    },
    // документация: все страницы одним ответом (раздел /docs переходит между
    // страницами без запросов) и PDF с тем же текстом
    "/api/docs": () => Response.json(docs().bundle, { headers: { "cache-control": "no-cache" } }),
    "/docs/healthcraft.pdf": () => docsPdfResponse(docs(), config.publicBaseUrl),
    "/docs/img/:name": (req) => docsImageResponse(req.params.name),
    // неизвестный /api/* обязан остаться JSON-404, а не отдать HTML
    "/api/*": () => notFound("такого адреса нет"),
    // catch-all фронтенда: маршруты /repo/{org}/{repo} живут в History API,
    // прямая ссылка и F5 на карточке должны отдавать тот же бандл
    "/*": index,
  } satisfies NonNullable<RoutesTable>;
// Заголовки защиты на HTML-бандл не ставятся: маршрут HTML-импорта Bun не дает
// управлять ответом (HTMLBundle непрозрачен и из обработчика не возвращается).
// JSON API закрыт целиком, фрейминг страницы закрывает reverse-proxy стенда.

const server = Bun.serve({
  port: config.port,
  // по умолчанию Bun рвет соединение примерно после 10 с тишины, а хендлеры с
  // живыми запросами (PUT PAT: проба и посев, карточка с PAT, callback) бывают
  // дольше; 120 с — с запасом
  idleTimeout: 120,
  routes: hardenRoutes(routes),
  fetch() {
    const res = new Response("not found", { status: 404 });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
  // упавший хендлер перехватывается здесь, чтобы 500 ушел с теми же
  // заголовками защиты (встроенный фолбэк Bun идет мимо hardenRoutes)
  error(err) {
    console.error(`[http] handler failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
    const res = Response.json({ error: { code: "internal", message: "внутренняя ошибка сервера" } }, { status: 500 });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
});

// --- периодика: воркеры очереди и ночной обход каталога ---
// общего клиента на процесс нет — фабрика выдает новый клиент с полным
// бюджетом на каждую задачу воркера
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
// у обхода каталога свой бюджет (потолок страниц + 10), а не бюджет скана:
// с ростом каталога бюджет скана мог бы кончиться посреди обхода, и тот
// считался бы недочитанным
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
// роли процесса: web — сервер и пользовательские воркеры, rating — планировщик
// и воркеры рейтинга, all — все вместе для разработки (пользовательские вперед)
const role = config.processRole;
// стоп-функции таймеров — SIGTERM снимает их штатно
const stopWorkerLoops: Array<() => void> = [];
// Стартовый рескор асинхронный, уже после поднятия порта: иначе деплой со
// сменой производных держал бы порт десятки минут. Выполняют его только роли
// rating/all (web оценки не пишет, ее health читает прогресс из meta). Курсор
// прогресса хранится в meta — рестарт продолжает с места остановки, BUSY не
// фатален (ретраи с бэкоффом).
if (needsRescore(db)) {
  if (role === "rating" || role === "all") {
    console.log("[startup] stored scores are outdated or missing: background rescore (port is already up)");
    // непойманный rejection в Bun — exit 1, и супервизор ушел бы в цикл
    // перезапусков. .catch — страховка: ошибка пишется в meta (health это
    // покажет), процесс остается жив
    void runStartupRescore(db, { log: (m) => console.log(`[rescore] ${m}`) }).catch((e: unknown) => {
      const msg = String((e as Error).message ?? e).slice(0, 200);
      console.error(`[rescore] startup pass crashed: ${msg}`);
      try {
        setMetaValue(db, RESCORE_ERROR, msg);
      } catch (metaError) {
        console.error(`[rescore] failed to record rescore error: ${String((metaError as Error).message).slice(0, 200)}`);
      }
    });
  } else {
    console.log("[startup] stored scores are outdated or missing: rescore runs in the rating process (PROCESS_ROLE=web)");
  }
}
// у каждой пары «полоса роли × род заявки» свой цикл: плановый скан тяжелого
// репо не держит пользователей, скан не держит AI-обзор
const loopPlan = workerLoopPlan(role, config.queue);
stopWorkerLoops.push(startWorkerLoops({ db, config, serverClient }, loopPlan));
// часовое обслуживание (осиротевшие сканы, ретеншен, каталоги клонов) нужно в
// любой роли; у rating/all его запускает startScheduler
if (role === "web") {
  stopWorkerLoops.push(startMaintenance(db, config));
}
if (role === "rating" || role === "all") {
  stopWorkerLoops.push(startScheduler(db, catalogClient, config));
}
console.log(`  role: ${role} (PROCESS_ROLE); worker loops: ${workerLoopSummary(loopPlan)}`);

// Стартовое обслуживание в любой роли: осиротевшие каталоги клонов в tmp
// (после падения или OOM их никто не подберет) и осиротевшие `running`-строки
// `scans` (процесс умер, а скан «идет» вечно)
void maintenanceTick(db, config);

// SIGTERM/SIGINT — штатное завершение за 5 с, чтобы не оставлять сирот до
// истечения лиза и свипа: перестаем принимать запросы, свои running-заявки
// возвращаем в queued (попытка откатывается — остановка попыткой не считается),
// живые группы клонов гасим, таймеры снимаем.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[signal] ${signal} — штатное завершение (заявки возвращены в очередь, клоны погашены)`);
  try {
    server.stop(false);
  } catch {
    /* уже стоит */
  }
  for (const stop of stopWorkerLoops) {
    try {
      stop();
    } catch {
      /* таймер уже снят */
    }
  }
  // порядок важен: сначала закрыть свои running-сканы (bad + shutdown), потом
  // вернуть заявки в queued
  try {
    const closed = closeOwnRunningScans(db);
    if (closed > 0) console.log(`[signal] прерванных сканов закрыто как bad (shutdown): ${closed}`);
  } catch (e) {
    console.error(`[signal] close scans failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  try {
    const returned = returnOwnRunningJobs(db);
    if (returned > 0) console.log(`[signal] заявок возвращено в очередь: ${returned}`);
  } catch (e) {
    console.error(`[signal] return jobs failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  const killed = killActiveClones();
  if (killed > 0) console.log(`[signal] групп клонов погашено: ${killed}`);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
console.log(`  scheduler: интервал ${Math.round(config.scheduler.intervalMs / 60000)} мин, форс-полный ${config.scheduler.fullRescan ? "ВКЛ" : "выкл"}`);
// кулдаун генерации в строке старта: расхождение .env с процессом видно по stdout
console.log(`  summary cooldown: ${config.queue.summaryCooldownMs ?? 3_600_000} ms, кэш по скану ${(config.queue.summaryCooldownMs ?? 3_600_000) > 1 ? "ВКЛ" : "выкл (дебаг)"}`);
// пароль короче 20 символов выключает функцию — это видно в строке старта
console.log(`  AI: пароль доступа — ${config.ai.unlockStatus === "on" ? "задан" : config.ai.unlockStatus === "too_short" ? "КОРОЧЕ 20 СИМВОЛОВ, доступ по паролю выключен" : "не задан"}; автозапуск топа — ${config.ai.topAuto ? `вкл (топ-${config.ai.topAutoSize})` : "выкл"}; лимиты обзора ${config.ai.overview.perHour}/${config.ai.overview.perDay}/${config.ai.overview.globalPerDay}, проверки ${config.ai.check.perHour}/${config.ai.check.perDay}/${config.ai.check.globalPerDay}`);
