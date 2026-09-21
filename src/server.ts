// server.ts — фронтенд (React + Gravity UI, бандлит Bun из HTML-импорта;
// dev — HMR, NODE_ENV=production — бандл без HMR) + read-API В3 + auth/моя
// поверхность В4. Сервер ТОЛЬКО разбирает запрос, валидирует и
// сериализует: логика чтения — чистые функции src/api/*, логика auth —
// src/auth/* (тестируются без HTTP). Живые вызовы наружу — только
// OAuth-обмен (вход) и PAT/me-repos по явному действию юзера; данные
// рейтинга появляются исключительно сканом.
import { loadConfig } from "./config";
import { openDb, setMetaValue } from "./db";
import { getMeta, listRepos, parseReposQuery, resolveCardForViewer, type RepoCard } from "./api/repos";
import { getHealth } from "./api/health";
import {
  classifyScStatus,
  isOwnRepo,
  makeAccessCache,
  probeIoOf,
  probeRepoAccess,
  resolveAccess,
  visibilityOf,
  type AccessRepo,
  type AccessResult,
  type ChannelAccess,
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
import { pdfResponse } from "./report/pdf";
import { catalogClientBudget, closeOwnRunningScans, maintenanceTick, returnOwnRunningJobs, startMaintenance, startScheduler, startWorkerLoop } from "./jobs/scheduler";
import { killActiveClones } from "./collectors/git";
import {
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  cookieNames,
  createSession,
  getSessionUser,
  makeOAuthState,
  oauthStateCookieHeader,
  oauthStateFromCookie,
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
import { needsRescore, runStartupRescore, RESCORE_ERROR } from "./score/rescore";
import index from "./web/index.html";

const config = loadConfig();
// ПОРТ hq-parallel (S1/security): окно живых проб PAT на юзера.
const patProbes = new Map<number, number[]>();
// В4.2-port-fix (П2): окно лимита проверок прав избранного на юзера.
const favoriteChecks = new Map<number, number[]>();
// Ф2.8 (В4.2b): минутное окно чтений /api/me/repos на юзера.
const myReposViews = new Map<number, number[]>();
// В4.4 (кластер G код-аудита): карточка — единственная пробная поверхность
// без лимита (до 3 живых запросов PAT зрителя на показ + вымывание кэша
// доступа): минутное окно на ЗАЛОГИНЕННОГО зрителя; аноним — без лимита
// (публичная карточка в сеть не ходит, проб нет).
const cardViews = new Map<number, number[]>();
// В4.4 (кластер K/З6): churn-цикл PUT/DELETE избранного деградирует БД —
// минутное окно мутаций на юзера (добавление/снятие звезды).
const favMutations = new Map<number, number[]>();

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

/** В4.8.5 (К8.5.6): есть ли место в окне — БЕЗ списания (проба PAT списывает только вердикт). */
function windowHasRoom(windows: Map<number, number[]>, userId: number, limit: number, windowMs: number, now = Date.now()): boolean {
  const stamps = (windows.get(userId) ?? []).filter((ts) => ts > now - windowMs);
  return stamps.length < limit;
}

/** Списать одну отметку окна. */
function windowPush(windows: Map<number, number[]>, userId: number, now = Date.now()): void {
  const stamps = windows.get(userId) ?? [];
  stamps.push(now);
  windows.set(userId, stamps);
}

/** В4.8.5 (К8.5.7): через сколько секунд освободится место в окне — значение `Retry-After`. */
function windowRetryAfterSec(windows: Map<number, number[]>, userId: number, windowMs: number, now = Date.now()): number {
  const alive = (windows.get(userId) ?? []).filter((ts) => ts > now - windowMs);
  if (alive.length === 0) return 1;
  return Math.max(1, Math.ceil((Math.min(...alive) + windowMs - now) / 1000));
}

/** В4.8.5 (К8.5.7, С9-14): каждый 429 несёт `Retry-After`. */
function rateLimited(message: string, retryAfterSec: number): Response {
  return Response.json({ error: { code: "rate_limited", message } }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.round(retryAfterSec))) } });
}

/** Минутное окно проверок прав избранного: true = пропустить. */
const allowFavoriteCheck = (userId: number, now = Date.now()): boolean =>
  allowInWindow(favoriteChecks, userId, config.queue.favoriteChecksPerMinute, 60_000, now);

/** Минутное окно чтений /api/me/repos (Ф2.8): true = пропустить. */
const allowMyReposView = (userId: number, now = Date.now()): boolean =>
  allowInWindow(myReposViews, userId, config.queue.myReposPerMinute, 60_000, now);

/** Минутное окно показов карточки залогиненным зрителем (В4.4, кластер G): true = пропустить. */
const allowCardView = (userId: number, now = Date.now()): boolean =>
  allowInWindow(cardViews, userId, config.queue.cardPerMinute ?? 30, 60_000, now);

/** Минутное окно мутаций избранного (В4.4, кластер K/З6): true = пропустить. */
const allowFavMutation = (userId: number, now = Date.now()): boolean =>
  allowInWindow(favMutations, userId, config.queue.favoritesMutationsPerMinute ?? 30, 60_000, now);

/**
 * В4.4 (кластер K/З3): у Bun.serve нет глобальных headers — защита от
 * фрейминга и MIME-сниффинга ставится обёрткой над каждым ответом.
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

/** Живая проба токена = оракул валидности PAT; сервис не переборщик (ПОРТ S1). */
const PAT_PROBES_PER_HOUR = 10;

const db = openDb(config);

// Ф2.7 (В4.2b): имена/атрибуты cookie по схеме YA_REDIRECT_URI — на https
// это `__Host-rh_*` с Secure. Читается ТОЛЬКО актуальное имя.
const ck = cookieNames(config.auth);

// В4.4 (кластер A код-аудита): стартовый рескор — АСИНХРОННО ПОСЛЕ поднятия
// порта (ниже, у старта ролей): деплой с бампом производных больше не держит
// порт десятки минут и не порождает рестарт-луп «рескор-kill-рескор».

const badQuery = (message: string): Response =>
  Response.json({ error: { code: "bad_query", message } }, { status: 400 });
const notFound = (message: string): Response =>
  Response.json({ error: { code: "not_found", message } }, { status: 404 });
const unauthorized = (message = "требуется вход (Я ID)"): Response =>
  Response.json({ error: { code: "unauthorized", message } }, { status: 401 });
const forbidden = (message: string): Response =>
  Response.json({ error: { code: "forbidden", message } }, { status: 403 });

/** В4.4 (кластер K/З6): окно мутаций избранного исчерпано — 429. */
const favoriteRateLimited = (userId: number): Response =>
  rateLimited(
    `не больше ${config.queue.favoritesMutationsPerMinute ?? 30} изменений избранного в минуту — попробуйте чуть позже`,
    windowRetryAfterSec(favMutations, userId, 60_000),
  );

/** В4.4 (кластер G): окно открытий карточки (карточка, MD, PDF) исчерпано — 429 с Retry-After. */
const cardRateLimited = (userId: number): Response =>
  rateLimited(`не больше ${config.queue.cardPerMinute ?? 30} открытий карточки в минуту — попробуйте чуть позже`, windowRetryAfterSec(cardViews, userId, 60_000));

/** Ф2.21: предел избранного — 409 без меты репо и без факта существования приватного. */
const favoriteLimit = (max: number): Response =>
  Response.json({ error: { code: "favorite_limit", message: `в избранном не больше ${max} репозиториев — уберите лишние, чтобы добавить новый` } }, { status: 409 });

// Ф2.8 (LOW-6): CSRF-гард по Origin на мутирующих /api/me/* и /auth/logout.
// Заголовка нет → пропустить (межсайтовой POST закрыт SameSite=Lax); есть и
// не совпал с origin YA_REDIRECT_URI (без него — localhost/127.0.0.1:PORT) → 403.
const allowedOrigins = (): Set<string> => {
  const out = new Set<string>();
  try {
    out.add(new URL(config.auth.redirect).origin);
  } catch {
    /* кривой redirect — остаются локальные дефолты ниже */
  }
  if (out.size === 0) {
    out.add(`http://localhost:${config.port}`);
    out.add(`http://127.0.0.1:${config.port}`);
  }
  return out;
};

/** null = запрос прошёл гард; Response = 403 «чужой Origin». */
function guardOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "") return null;
  return allowedOrigins().has(origin) ? null : forbidden("чужой Origin: запрос отклонён");
}

/**
 * Ф2.8 (LOW-4): сегмент слага из ОДНИХ ТОЧЕК («.», «..») в charset проходит,
 * а семантически это обход пути — наружу 400. Остальной charset проверяет
 * прежняя регулярка.
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
 * В4.8.5 (К8.5.5a): политика ретраев 429/503 клиентов, которые отвечают
 * человеку в том же HTTP-запросе (проба токена, карточка, проверка прав,
 * предпроверка запуска): один повтор и короткий потолок ожидания — запрос не
 * должен висеть десятки секунд. Фоновые клиенты (каталог, скан) — дефолт
 * `http.ts` (3 повтора, потолок 30 с).
 */
const INTERACTIVE_RETRY = { maxRetries: 1, maxWaitMs: 2_000, baseBackoffMs: 500 } as const;

/** REST-клиент с юзерским PAT (PAT-окно/«мои репо»); PAT нет → null. */
function userClient(userId: number) {
  const pat = config.auth.appSecret ? getPat(db, config.auth.appSecret, userId) : null;
  if (!pat) return null;
  return makeScClient({ retry: INTERACTIVE_RETRY, token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, timeoutMs: config.scan.rest.timeoutMs });
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

/** PAT пользователя, если он читается текущим ключом; иначе null. */
function patOf(userId: number): string | null {
  return config.auth.appSecret ? getPat(db, config.auth.appSecret, userId) : null;
}

/** Ввод-вывод живой проверки прав (К8.5.14) на PAT пользователя: интерактивный ретрай, общий ритм токена. */
function probeIoFor(pat: string): ProbeIo {
  const rest = makeScClient({ retry: INTERACTIVE_RETRY, token: pat, baseUrl: config.api.restBase, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 8, timeoutMs: config.scan.rest.timeoutMs });
  // П3 (Н2 HIGH): адрес AppSec — из конфига, не боевой по умолчанию
  const appsec = makeAppsecClient({ token: pat, baseUrl: config.api.appsecBase, minIntervalMs: config.scan.rest.appsecMinIntervalMs, retryMaxWaitMs: INTERACTIVE_RETRY.maxWaitMs });
  return probeIoOf(rest, appsec);
}

/**
 * В4.8.5 (К8.5.14 (д)): фоновая перепроверка прав избранного — насос в
 * памяти процесса; окно проверок человека не расходует, анализ не ставит.
 * Клиенты — на PAT пользователя, ритм общий с остальными его запросами.
 */
const recheckPump = makeRecheckPump({
  db,
  probeIo: (userId) => {
    const pat = patOf(userId);
    return pat ? probeIoFor(pat) : null;
  },
  log: (m) => console.log(m),
});

/** Причина доступа зрителя карточки (К8.5.8): нет сессии / нет токена / токен есть. */
function viewerAuthOf(req: Request): "no-session" | "no-pat" | "pat" {
  const user = sessionOf(req);
  if (!user) return "no-session";
  return patOf(user.userId) ? "pat" : "no-pat";
}

/**
 * Карточка для зрителя запроса (карточка, MD, PDF — одна сборка, К2) или
 * готовый отказ. В4.8.5 (К8.5.6, С6-1): владелец приватного репозитория с
 * доказанными правами при сбое проверки получает «проверка не удалась» /
 * «токен отклонён», а не «не найден»; прочим — прежний нейтральный 404.
 */
async function cardOrRefusal(req: Request, org: string, repo: string): Promise<RepoCard | Response> {
  const viewer = sessionOf(req);
  const auth = viewerAuthOf(req);
  const out = await resolveCardForViewer(db, org, repo, viewerAccess(req), {
    limits: config.scan,
    viewerUserId: viewer?.userId,
    viewerAuth: auth,
    provenRights: () => viewer !== null && viewerMayReadRepo(db, viewer.userId, org, repo, { savedRightsValid: auth === "pat" }),
  });
  if (out.kind === "card") return out.card;
  if (out.kind === "check_failed") {
    return Response.json(
      { error: { code: "check_failed", message: "SourceCraft сейчас не отвечает – не удалось проверить доступ к репозиторию, попробуйте позже" } },
      { status: 503 },
    );
  }
  if (out.kind === "token_rejected") {
    return Response.json({ error: { code: "pat_rejected", message: "SourceCraft отклонил ваш токен – замените его в Настройках" } }, { status: 409 });
  }
  return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
}

/**
 * В4.8.5 (К8.5.14 (д), (е)): добавление в избранное — звезда и «Добавить» —
 * с автопроверкой прав СИНХРОННО в том же PUT (до 3 запросов, как прежняя
 * «Проверить доступ»). Первый анализ своего ставится только здесь, при явном
 * добавлении (§2-Р1): кулдаун и капы — как у прежней автопостановки
 * (`requestUserScan` целиком, тело repo-GET прокинуто). Окно проверок
 * человека исчерпано — запись «не проверена», уходит в фоновый насос (без
 * анализа). Ответ — обновлённая запись строки (К8.5.7: список не
 * перечитывается целиком) и исход проверки.
 */
async function addFavoriteAndCheck(userId: number, org: string, repo: string): Promise<Response> {
  const outcome = addFavoriteCapped(db, userId, org, repo, config.queue.favoritesMax);
  if (outcome === "limit") return favoriteLimit(config.queue.favoritesMax);
  const pat = patOf(userId);
  let check: { status: FavoriteCheckResult | "deferred" | "no_pat"; enqueue: FavoriteEnqueue | null } = { status: "no_pat", enqueue: null };
  if (pat !== null) {
    if (!allowFavoriteCheck(userId)) {
      check = { status: "deferred", enqueue: null };
      recheckPump.enqueue(userId, [{ org, repo }]);
    } else {
      const io = probeIoFor(pat);
      const rest = userClient(userId)!;
      const result = await checkFavoriteAccess(db, userId, org, repo, { ...io, cooldownMs: config.queue.favoriteOwnCooldownMs }, async (repoRes) =>
        // Н1: постановка ЦЕЛИКОМ через requestUserScan — дедуп, too_many_active,
        // rate_limited и транзакцию Ф1.5 не обойти; repo-GET не повторяется
        favoriteEnqueueOf(await requestUserScan(db, rest, userId, org, repo, config.queue, new Date(), repoRes)),
      );
      check = { status: result.result, enqueue: result.enqueue };
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

/** Исход «свой ли репозиторий» для запуска анализа (К8.5.14 (б)). */
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
  const undecided = (c: ChannelAccess) => c === "check-failed" || c === "pat-expired";
  if (undecided(access.cicd) || undecided(access.appsec)) return { kind: "unknown" };
  return { kind: "not_own" };
}

/** Отказ запуска по «своему» (К8.5.14 (б)); `record` — строка отказа предпроверки (лимит частоты, как у прочих отказов). */
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
      return { status: 401, body: { error: { code: "pat_expired", message: "SourceCraft отклонил ваш токен – замените его в Настройках" } }, record: true };
    default:
      // К8.5.6: сбой проверки — не вердикт и не списание лимита запусков
      return {
        status: 503,
        body: { error: { code: "check_failed", message: `SourceCraft сейчас не отвечает – не удалось проверить доступ к ${org}/${repo}, попробуйте позже` } },
        record: false,
      };
  }
}

/** Ответ `requestUserScan` → HTTP; 429 — с `Retry-After` (К8.5.7). */
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

/** Ф2.10: адреса Я ID — из конфига (тесты направляют их на локальный мок). */
const yaEndpoints = (): YaEndpoints => ({ oauthBase: config.auth.yaOauthBase, loginBase: config.auth.yaLoginBase });

// В4.4 (кластер K): таблица маршрутов — тип Bun.serve, чтобы обёртка
// hardenRoutes не стирала сигнатуры обработчиков (и метод-карты вроде POST)
type RoutesTable = NonNullable<Parameters<typeof Bun.serve>[0]>["routes"];
const routes = {
    "/api/health": () => {
      // В4.4 (кластер B): ok — вычисляемое (pending-рескор, подозрительно
      // пустой каталог, провал ночной фазы); тело — честный статус, HTTP-200
      // остаётся (здоровье читают по телу, порт-гарды ждут статус)
      return Response.json(getHealth(db, config));
    },
    "/api/meta": () => Response.json(getMeta(db, { leaseMs: config.scheduler.leaseMs })),
    "/api/repos": (req) => {
      const parsed = parseReposQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      return Response.json(listRepos(db, parsed.query));
    },
    // единая карточка (К2): состав ответа — по доступу зрителя из cookie.
    // К-Р13: слаг с невалидным percent-encoding (напр. %zz) — управляемый
    // отказ bad_query 400, не «не найдено» и не 500
    "/api/repos/:org/:repo": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      const viewer = sessionOf(req);
      // В4.4 (кластер G): 429 — до резолва доступа (не тратим PAT-запросы)
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      return Response.json(card);
    },
    "/api/repos/:org/:repo/report.md": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      const viewer = sessionOf(req);
      // В4.4 (кластер G): MD-выгрузка — та же карточка, тот же лимит
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      // тот же сборщик карточки с тем же зрителем (К2)
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      return new Response(renderRepoReport(card), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          // отчёт открывают как файл, а не читают в браузере
          "content-disposition": `attachment; filename="${org}-${repo}-health.md"`,
        },
      });
    },
    // В4.7 (П1): PDF того же отчёта — зеркало report.md: тот же гард слага,
    // то же минутное окно карточки, тот же сборщик карточки с тем же зрителем
    // (закрытые каналы — без чисел и фактов), приватный/эвиктированный — 404.
    // Сбой генерации — честная 500 без стека (`pdfResponse`), MD не задет.
    "/api/repos/:org/:repo/report.pdf": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      const viewer = sessionOf(req);
      if (viewer && !allowCardView(viewer.userId)) return cardRateLimited(viewer.userId);
      const card = await cardOrRefusal(req, org!, repo!);
      if (card instanceof Response) return card;
      return pdfResponse(card);
    },
    // ---------- auth: Я ID OAuth (Б1) ----------
    // Вход ВСЕГДА с выбором аккаунта (решение владельца 21.09). Наш «Выход»
    // отзывает только нашу сессию — сессия Яндекса живёт в его домене и
    // переживает её, поэтому при следующем `/authorize` он молча возвращал
    // прежнего пользователя, и сменить аккаунт из интерфейса было нельзя.
    // `force_confirm=yes` показывает экран выбора; цена — один лишний клик
    // при обычном входе, и она принята ради того, чтобы вход вообще был
    // управляемым. Отдельной кнопки «в другой аккаунт» больше нет.
    "/auth/ya": () => {
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "APP_SECRET не задан: сессии выключены" } }, { status: 503 });
      }
      try {
        const state = makeOAuthState();
        const url = buildAuthUrl(yaCreds(), state, yaEndpoints(), { forceConfirm: true });
        return new Response(null, { status: 302, headers: { location: url, "set-cookie": oauthStateCookieHeader(ck, state) } });
      } catch (e) {
        return Response.json({ error: { code: "unconfigured", message: String((e as Error).message) } }, { status: 503 });
      }
    },
    // выход: сессия отзывается в БД, cookie гасится; PAT пользователя остаётся
    // (он привязан к аккаунту, а не к сессии). Только POST: SameSite=Lax не
    // отдаёт cookie межсайтовому POST, выход чужой страницей невозможен
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
      // Ф2.7: редирект ОТНОСИТЕЛЬНЫЙ (абсолютный из Host — риск за кривым
      // прокси), и ВСЕ исходы callback гасят state-cookie. Несколько
      // Set-Cookie — через Headers.append.
      const callbackRedirect = (location: string, extraCookies: string[] = []): Response => {
        const headers = new Headers({ location });
        for (const c of extraCookies) headers.append("set-cookie", c);
        return new Response(null, { status: 302, headers });
      };
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        // S-4 (круг 2 В4.4): серверный кап симметричен клиентскому санитайзеру
        // (format.ts authErrorText): управляющие символы + 200 символов —
        // до редиректа, а не только на рендере
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
      return callbackRedirect("/me", [
        sessionCookieHeader(ck, cookie, SESSION_TTL_MS),
        clearOAuthStateCookieHeader(ck),
      ]);
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
      // Ф2.8 (LOW-5): hasPat = строка есть И она читается текущим ключом —
      // после ротации APP_SECRET мёртвая строка не выдаётся за рабочий PAT
      const readable = config.auth.appSecret ? patReadable(db, config.auth.appSecret, user.userId) : false;
      return Response.json({
        login: user.login,
        displayName: profile.displayName,
        avatarUrl: profile.avatarId ? yaAvatarUrl(profile.avatarId) : null,
        hasPat: meta?.hasPat === true && readable,
        patCheckedAt: meta && meta.hasPat && readable ? meta.checkedAt : null,
      });
    },
    "/api/me/pat": async (req) => {
      const csrf = guardOrigin(req);
      if (csrf) return csrf;
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (!config.auth.appSecret) {
        return Response.json({ error: { code: "unconfigured", message: "APP_SECRET не задан: PAT хранить нельзя" } }, { status: 503 });
      }
      if (req.method === "PUT") {
        // ПОРТ hq-parallel (S1/security): живая проба токена = оракул
        // валидности PAT — окно на юзера (10/час), сервис не переборщик.
        // В4.8.5 (К8.5.6, С2-1): окно списывает только ВЕРДИКТ платформы
        // (токен принят или отклонён); сбой SourceCraft пробу не сжигает
        if (!windowHasRoom(patProbes, user.userId, PAT_PROBES_PER_HOUR, 60 * 60_000)) {
          return rateLimited("Слишком много проверок токена — попробуйте через час", windowRetryAfterSec(patProbes, user.userId, 60 * 60_000));
        }
        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        if (typeof body?.token !== "string" || body.token.length < 8) return badQuery("token: ожидается строка PAT");
        // живая проверка GET /user: вердикт — по общему классификатору (К8.5.6)
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
          return Response.json({ error: { code: "bad_token", message: `SourceCraft отклонил токен (HTTP ${who.status})` } }, { status: 400 });
        }
        storePat(db, config.auth.appSecret!, user.userId, body.token);
        accessCache.clearUser(user.userId); // новый PAT — новые права
        // В4.8.5 (К8.5.9, К8.5.14): права избранного — поколения прежнего
        // токена: гасятся, а новые проверяет фоновый насос (анализ он не ставит)
        resetFavoriteRights(db, user.userId);
        const username = (who.json as { username?: unknown } | null)?.username ?? null;
        // Ф2.20: PAT уже сохранён — посев избранного fail-soft, любой его
        // исход сохранение не откатывает. Отдельный клиент с бюджетом 6
        // запросов (до 5 страниц по 100; /user уже сделан пробой выше)
        // UX-9 (круг 2 В4.4): без username посев НЕ начинался — отдельный код
        // вместо source_http, который ложно обвинял namespace
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
        // К8.5.9 (С2-3): удаление токена гасит права, проверенные им
        resetFavoriteRights(db, user.userId);
        recheckPump.clear(user.userId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался PUT или DELETE" } }, { status: 405 });
    },
    "/api/me/repos": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      // Ф2.8 (LOW-11): минутное окно чтений на юзера — в кабинете список
      // перечитывается; 429 — до какой-либо работы маршрута
      if (!allowMyReposView(user.userId)) {
        return rateLimited(
          `не больше ${config.queue.myReposPerMinute} обновлений списка в минуту — попробуйте позже`,
          windowRetryAfterSec(myReposViews, user.userId, 60_000),
        );
      }
      // Ф2.20: кабинет читает ТОЛЬКО избранное — PAT здесь не нужен и в сеть
      // маршрут не ходит. К8.5.9: сохранённые права — только поколения
      // читаемого PAT (ротация APP_SECRET гасит их на чтении)
      const pat = patOf(user.userId);
      const result = await listMyRepos(db, user.userId, { savedRightsValid: pat !== null });
      // К8.5.14 (д): записи «не проверено» или старше суток — в фон, по
      // нескольку за раз; ответ не ждёт (итог — при следующем чтении списка)
      if (pat !== null) recheckPump.enqueue(user.userId, staleFavoriteSlugs(db, user.userId));
      return Response.json({ username: result.username, entries: result.entries });
    },
    // ПОРТ 5: панель заданий — колокольчик/«Мои задания» (диагноз UX «очереди не видно»)
    "/api/me/jobs": (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      return Response.json(myJobs(db, user.userId));
    },
    "/api/me/favorites": async (req) => {
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "GET") {
        return Response.json({ entries: listFavorites(db, user.userId) });
      }
      // Ф2.20: ручной ввод — JSON {repository: "org/repo" | SourceCraft-URL};
      // тот же парсер, что у path-роут звезды
      if (req.method === "PUT") {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
        // В4.8.5 (К8.5.7, С3-4): отказ 400 окно мутаций не списывает — разбор
        // ввода ДО окна; S-7 (круг 2): сессия читается ОДИН раз — выше
        const body = (await req.json().catch(() => null)) as { repository?: unknown } | null;
        if (typeof body?.repository !== "string") return badQuery("repository: ожидается строка org/repo или URL");
        const parsed = parseFavoriteInput(body.repository);
        if (!parsed) return badQuery("repository: ожидается org/repo или http(s)-URL; пустые и точечные сегменты не принимаются");
        if (!allowFavMutation(user.userId)) return favoriteRateLimited(user.userId);
        return addFavoriteAndCheck(user.userId, parsed.org, parsed.repo);
      }
      return Response.json({ error: { code: "bad_query", message: "ожидался GET или PUT" } }, { status: 405 });
    },
    "/api/me/favorites/:org/:repo": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      if (req.method !== "GET") {
        const csrf = guardOrigin(req);
        if (csrf) return csrf;
      }
      const user = sessionOf(req);
      if (!user) return unauthorized();
      if (req.method === "PUT") {
        // общий парсер (Ф2.20) применён и к path-роуту звезды; разбор — до окна (К8.5.7)
        const parsed = parseFavoriteInput(`${org}/${repo}`);
        if (!parsed) return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
        // S-7 (круг 2): сессия читается ОДИН раз — выше
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
      return Response.json({ error: { code: "bad_query", message: "ожидался GET/PUT/DELETE" } }, { status: 405 });
    },
    // В4.8.5 (К8.5.14 (г), §2-В1): маршрута «Проверить доступ»
    // (`POST /api/me/favorites/:org/:repo/check`) больше нет — права
    // проверяются сами при добавлении в избранное и фоном; его инварианты
    // (порядок отказов, лимит проверок, кулдаун по own-скану зрителя, AppSec
    // на APPSEC_API_BASE, «не свой — без постановки», капы requestUserScan)
    // перенесены на путь добавления. Прежний адрес отвечает общим JSON-404.
    "/api/me/repos/:org/:repo/scan": async (req) => {
      const { org, repo } = req.params;
      if (!validSlugSegment(org) || !validSlugSegment(repo)) {
        return badQuery("слаг org/repo: ожидается [a-z0-9_.-]");
      }
      if (req.method !== "POST") {
        return Response.json({ error: { code: "bad_query", message: "ожидался POST" } }, { status: 405 });
      }
      const csrf = guardOrigin(req);
      if (csrf) return csrf;
      const user = sessionOf(req);
      if (!user) return unauthorized();
      const client = userClient(user.userId);
      if (!client) {
        return Response.json({ error: { code: "no_pat", message: "сначала сохраните PAT SourceCraft" } }, { status: 409 });
      }
      // К4/Ф1.7: дешёвые отказы (дедуп, активные, часовой лимит) — ДО сети
      const cheap = userScanCheapGate(db, user.userId, org!, repo!, config.queue);
      if (cheap) return scanResponse(cheap);
      // В4.8.5 (К8.5.14 (б), §2-В1): анализ — только своих. «Свой» — общее
      // правило над доступом из общего резолвера (с кэшем карточки); строки
      // репо ещё нет — живая проверка теми же правилами. Неизвестно — не свой
      const own = await ownershipOf(req, user.userId, org!, repo!);
      if (own.kind !== "own") {
        const refusal = scanRefusal(own, org!, repo!);
        if (refusal.record) recordRefusedUserJob(db, user.userId, new Date(), `${org}/${repo}`);
        return Response.json(refusal.body, { status: refusal.status });
      }
      // H1/LOW-3 (К3): repo-GET уже сделан (или доступ подтверждён кэшем
      // карточки) — строка repos и заявка появляются только при доказанном доступе
      const out = await requestUserScan(db, client, user.userId, org!, repo!, config.queue, new Date(), own.repoRes);
      return scanResponse(out);
    },
    // неизвестный /api/* обязан остаться JSON-404, а не отдать HTML
    "/api/*": () => notFound("неизвестный endpoint"),
    // catch-all фронтенда: маршруты /repo/{org}/{repo} живут в History API,
    // прямая ссылка и F5 на карточке должны отдавать тот же бандл
    // HTML-импорт — готовый Response: заголовки выставляются один раз (идемпотентно)
    "/*": index,
  } satisfies NonNullable<RoutesTable>;
// В4.4 (кластер K, отклонение): заголовки защиты НЕ ставятся на HTML-бандл —
// Bun HTML-import маршрут (routes["/*"] = index) не даёт управлять ответом
// (проверено живьём на bun 1.4.2: HTMLBundle непрозрачен, из обработчика не
// возвращается). JSON API закрыт целиком; фрейминг страницы закроет
// reverse-proxy стенда (В6, add_header) — честное ограничение в отчёте.

const server = Bun.serve({
  port: config.port,
  // В4.4 (кластер H, Прод-С4): Bun рвёт соединение при ~10–12 с тишины
  // (замер аудита) — «думающие» хендлеры (PUT PAT: проба+посев, карточка
  // с PAT, callback) легально живут дольше; 120 с — с запасом
  idleTimeout: 120,
  routes: hardenRoutes(routes),
  fetch() {
    const res = new Response("not found", { status: 404 });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
  // S-6 (круг 2 В4.4): упавший хендлер перехватывается опцией error — 500
  // уходит С теми же security-заголовками (раньше Bun-внутренний фолбэк шёл
  // мимо hardenRoutes)
  error(err) {
    console.error(`[http] handler failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
    const res = Response.json({ error: { code: "internal", message: "внутренняя ошибка сервера" } }, { status: 500 });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
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
// В4.4 (кластер L): стоп-хендлалы таймеров — SIGTERM снимает их штатно
const stopWorkerLoops: Array<() => void> = [];
// В4.4 (кластер A): стартовый рескор асинхронен и исполняется ТОЛЬКО ролями
// rating/all — порт уже поднят; web-роль не пишет оценки, её health читает
// прогресс из meta. Прогресс персистентен (курсор в meta): рестарт
// продолжает с места остановки, BUSY не фатален (бэкофф-ретраи).
if (needsRescore(db)) {
  if (role === "rating" || role === "all") {
    console.log("[startup] stored scores are outdated or missing: background rescore (port is already up)");
    // Круг 2 В4.4 (глубокая эщ к крэш-лупу деплой-окна): непойманный rejection
    // в Bun — exit 1, супервизор перезапускает, процесс не поднимается. Б1
    // чинит корень (кодек-осознанные читатели причины), .catch — страховка:
    // ошибка уходит в meta derived_rescore_error (health окрасится), процесс жив
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
if (role === "web" || role === "all") {
  stopWorkerLoops.push(startWorkerLoop({ db, config, serverClient }, { user: true, rating: role === "all" }));
}
// В4.8.5 (К8.5.2b, С10-4): часовое обслуживание (сироты-сканы, ретеншен,
// каталоги клонов) — в ЛЮБОЙ роли; у rating/all его запускает startScheduler
if (role === "web") {
  stopWorkerLoops.push(startMaintenance(db, config));
}
if (role === "rating" || role === "all") {
  stopWorkerLoops.push(startScheduler(db, catalogClient, config));
  if (role === "rating") {
    stopWorkerLoops.push(startWorkerLoop({ db, config, serverClient }, { rating: true }));
  }
}
console.log(`  role: ${role} (PROCESS_ROLE)`);

// ПОРТ hq-parallel (S3) + Ф2.2 (В4.2a): стартовое обслуживание — осиротевшие
// каталоги клонов в tmp (после crash/OOM их не подбирал никто) И осиротевшие
// `running`-строки `scans` (процесс умер, скан «идёт» вечно). Свип при старте
// работает в любой роли процесса: роль `web` планировщика не поднимает
void maintenanceTick(db, config);

// В4.4 (кластер L/З1 код-аудита): SIGTERM/SIGINT — ШТАТНОЕ завершение ≤ 5 с,
// а не мгновенный выход с сиротами до лиза (85 мин) и свипа (170 мин):
// перестаём принимать, свои running-заявки возвращаем в queued (claimed_at
// NULL, попытка откатывается — В4.8.5, К8.5.2a: остановка не считается попыткой), живые группы
// клонов гасим, таймеры снимаем.
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
  // П-5 (круг 2 В4.4): порядок — сначала закрыть СВОИ running-сканы честным
  // квартетом (bad + shutdown), ПОТОМ вернуть заявки в queued
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
