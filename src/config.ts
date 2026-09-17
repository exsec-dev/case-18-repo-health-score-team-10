// config.ts — env → конфиг. Fail-soft на старте (проверка при
// использовании — хакатон: сервер обязан подниматься и без ключей),
// честные сообщения об ошибках в момент обращения.
// Консолидация лимитов скана (решение 15.09, Алексей): все бюджеты
// живут здесь (Config.scan), а не константами в модулях. Слои:
// дефолты в коде ← env (.env — правка без GUI/CI). Пользовательский
// DB-override бюджетов удалён (К5 В4.1): лимиты скана — только оператор.
export interface CloneLimits {
  /** таймаут субпроцесса клонирования */
  timeoutMs: number;
  /** диск-бюджет: размер bare .git (du) */
  maxBytes: number;
  /** интервал du-поллинга watchdog'а */
  pollMs: number;
}

export interface DegradeLimits {
  /** деградационная попытка --shallow-since=<N>.months */
  sinceMonths: number;
  timeoutMs: number;
  maxBytes: number;
  /** ярус включён (RESOLVED 17.09, Алексей: 2.5ГБ/25мин по умолчанию ВКЛ) */
  enabled: boolean;
}

/** Лимиты git-канала: первая попытка + деградационный ярус (§5.7). */
export interface ScanCloneLimits extends CloneLimits {
  degrade: DegradeLimits;
}

export interface ScanConfig {
  clone: CloneLimits;
  degrade: DegradeLimits;
  /** timeoutMs — таймаут REST-запроса (В4.1-fix, Ф1.6): истёк → status 0 */
  rest: { budget: number; minIntervalMs: number; appsecMinIntervalMs: number; timeoutMs: number };
  catalog: { maxPages: number };
  extract: { maxBlameFiles: number; textCapBytes: number; commentsTopN: number };
}

/**
 * Ярусы бюджета клона — RESOLVED 17.09 (Алексей): первый 1.5ГБ/20мин,
 * деградация 2.5ГБ/25мин ВКЛ (зонд опроверг «потолок 1ГБ»: divkit
 * 1.39ГБ проходит первым ярусом целиком). AppSec-интервал ≥100мс —
 * лимиты частоты в доке SCS API не определены, бережность наша.
 */
export const DEFAULT_SCAN: ScanConfig = {
  clone: { timeoutMs: 20 * 60_000, maxBytes: 1.5 * 1024 * 1024 * 1024, pollMs: 5_000 },
  degrade: { sinceMonths: 13, timeoutMs: 25 * 60_000, maxBytes: 2.5 * 1024 * 1024 * 1024, enabled: true },
  rest: { budget: 1000, minIntervalMs: 50, appsecMinIntervalMs: 100, timeoutMs: 10_000 },
  catalog: { maxPages: 100 },
  extract: { maxBlameFiles: 200, textCapBytes: 1_000_000, commentsTopN: 50 },
};

export interface AuthConfig {
  yaClientId: string | null;
  yaClientSecret: string | null;
  /** redirect URI приложения Я ID (стенд: http://localhost:8418/auth/ya/callback) */
  redirect: string;
  /** ключ подписи сессий и шифрования PAT (AES-256-GCM) */
  appSecret: string | null;
}

export interface SchedulerConfig {
  /** интервал ночного обхода каталога (сутки по умолчанию, ТЗ §6) */
  intervalMs: number;
  /** форс-полный рескан: игнорировать дифф last_updated, поставить все репо */
  fullRescan: boolean;
  /** лиз job'а: время, на которое job закрепляется за воркером; дефолт (К4) =
   *  clone.timeout + degrade.timeout + 15 мин (60 мин), воркер продлевает каждые leaseMs/3 */
  leaseMs: number;
  /** задержка первого обхода после старта сервера: окно управления стендом
   *  (обход с живым токеном ставит в очередь первый скан всего каталога —
   *  это дизайн продукта, но оператор обязан успеть это видеть/отключить) */
  startDelayMs: number;
}

export interface QueueConfig {
  /** новых юзерских заявок за скользящий час на юзера (К4 В4.1): 10, env QUEUE_USER_SCANS_PER_HOUR */
  userScansPerHour: number;
  /** предел попыток job: достигнут → failed без claim (К4): 3, env QUEUE_MAX_ATTEMPTS */
  maxAttempts: number;
  /** активных (queued/running) юзерских заявок на юзера, сверх — 429 too_many_active (В4.1-fix, Ф1.7): 2, env QUEUE_USER_ACTIVE_MAX */
  userActiveMax: number;
}

export interface AccessConfig {
  /** TTL кэша проверок доступа зрителя (К2 В4.1): 15 мин по умолчанию, env ACCESS_CACHE_TTL_MS */
  cacheTtlMs: number;
  /** TTL результата check-failed (В4.1-fix, Ф1.6; уточнение C1 «кэш 15 мин»: сбой ≠ результат): 60 с, env ACCESS_FAILED_TTL_MS */
  failedTtlMs: number;
  /** предел записей кэша доступа, сверх — вытеснение старейших (Ф1.6): 10 000, env ACCESS_CACHE_MAX_ENTRIES */
  maxEntries: number;
}

/** Адреса внешних API (В4.1-fix, Ф1.13): тестовый шов — серверы в тестах
 *  указывают их на локальный мок; дефолты — боевые адреса. */
export interface ApiConfig {
  /** SourceCraft REST (env SOURCECRAFT_API_BASE) */
  restBase: string;
  /** AppSec API (env APPSEC_API_BASE) */
  appsecBase: string;
  /** git-хост клонов (env SOURCECRAFT_GIT_BASE) — расширение шва: юзерская
   *  заявка в тестовом сервере иначе клонировала бы с живого хоста */
  gitBase: string;
}

export const DEFAULT_API: ApiConfig = {
  restBase: "https://api.sourcecraft.tech",
  appsecBase: "https://appsec.sourcecraft.tech",
  gitBase: "https://git.sourcecraft.dev",
};

export interface Config {
  port: number;
  api: ApiConfig;
  dataDir: string;
  sourcecraftToken: string | null;
  auth: AuthConfig;
  scheduler: SchedulerConfig;
  access: AccessConfig;
  queue: QueueConfig;
  llm: {
    provider: "yandex" | "zai";
    mainModel: string;
    sideModel: string;
    yandexApiKey: string | null;
    yandexFolderId: string | null;
    zaiApiKey: string | null;
  };
  scan: ScanConfig;
}

function envFile(): Record<string, string> {
  try {
    const raw = require("node:fs").readFileSync(".env", "utf8") as string;
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq > 0) out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** int > 0 из env или null (fail-soft: мусор → дефолт). */
function envInt(env: Record<string, string>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Явные true/false/1/0; мусор → null = дефолт (fail-soft, как envInt). */
function envBool(env: Record<string, string>, name: string): boolean | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

/** Чистая функция env → ScanConfig (тесты инъекцией, не файлами). */
export function scanFromEnv(env: Record<string, string>): ScanConfig {
  const d = DEFAULT_SCAN;
  return {
    clone: {
      timeoutMs: envInt(env, "SCAN_CLONE_TIMEOUT_MS") ?? d.clone.timeoutMs,
      maxBytes: envInt(env, "SCAN_CLONE_MAX_BYTES") ?? d.clone.maxBytes,
      pollMs: d.clone.pollMs,
    },
    degrade: {
      sinceMonths: d.degrade.sinceMonths,
      timeoutMs: envInt(env, "SCAN_DEGRADE_TIMEOUT_MS") ?? d.degrade.timeoutMs,
      maxBytes: envInt(env, "SCAN_DEGRADE_MAX_BYTES") ?? d.degrade.maxBytes,
      enabled: envBool(env, "SCAN_DEGRADE_ENABLED") ?? d.degrade.enabled,
    },
    rest: {
      budget: envInt(env, "SCAN_BUDGET") ?? d.rest.budget,
      minIntervalMs: d.rest.minIntervalMs,
      appsecMinIntervalMs: envInt(env, "SCAN_APPSEC_MIN_INTERVAL_MS") ?? d.rest.appsecMinIntervalMs,
      timeoutMs: envInt(env, "SCAN_REST_TIMEOUT_MS") ?? d.rest.timeoutMs,
    },
    catalog: { maxPages: envInt(env, "SCAN_CATALOG_MAX_PAGES") ?? d.catalog.maxPages },
    extract: { ...d.extract },
  };
}

/** Дефолт лиза (К4): худший скан (клон + деградационный ярус) + 15 мин запаса. */
export function defaultLeaseMs(scan: ScanConfig): number {
  return scan.clone.timeoutMs + scan.degrade.timeoutMs + 15 * 60_000;
}

export function loadConfig(): Config {
  const env = { ...envFile(), ...process.env } as Record<string, string>;
  const scan = scanFromEnv(env);
  const provider = env.LLM_PROVIDER === "zai" ? "zai" : "yandex";
  const mainModel = env.MAIN_MODEL ?? (provider === "yandex" ? "yandexgpt" : "glm-5.3");
  return {
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8418,
    dataDir: env.DATA_DIR ?? "data",
    api: {
      restBase: env.SOURCECRAFT_API_BASE || DEFAULT_API.restBase,
      appsecBase: env.APPSEC_API_BASE || DEFAULT_API.appsecBase,
      gitBase: env.SOURCECRAFT_GIT_BASE || DEFAULT_API.gitBase,
    },
    sourcecraftToken: env.SOURCECRAFT_TOKEN ?? null,
    auth: {
      yaClientId: env.YA_CLIENT_ID ?? null,
      yaClientSecret: env.YA_CLIENT_SECRET ?? null,
      redirect: env.YA_REDIRECT_URI ?? "http://localhost:8418/auth/ya/callback",
      appSecret: env.APP_SECRET ?? null,
    },
    scheduler: {
      intervalMs: envInt(env, "SCHEDULER_INTERVAL_MS") ?? 24 * 60 * 60_000,
      fullRescan: envBool(env, "SCHEDULER_FULL_RESCAN") ?? false,
      leaseMs: envInt(env, "SCHEDULER_LEASE_MS") ?? defaultLeaseMs(scan),
      startDelayMs: envInt(env, "SCHEDULER_START_DELAY_MS") ?? 5 * 60_000,
    },
    access: {
      cacheTtlMs: envInt(env, "ACCESS_CACHE_TTL_MS") ?? 15 * 60_000,
      failedTtlMs: envInt(env, "ACCESS_FAILED_TTL_MS") ?? 60_000,
      maxEntries: envInt(env, "ACCESS_CACHE_MAX_ENTRIES") ?? 10_000,
    },
    queue: {
      userScansPerHour: envInt(env, "QUEUE_USER_SCANS_PER_HOUR") ?? 10,
      maxAttempts: envInt(env, "QUEUE_MAX_ATTEMPTS") ?? 3,
      userActiveMax: envInt(env, "QUEUE_USER_ACTIVE_MAX") ?? 2,
    },
    llm: {
      provider,
      mainModel,
      sideModel: env.SIDE_MODEL ?? mainModel,
      yandexApiKey: env.YAGPT_API_KEY ?? null,
      yandexFolderId: env.YAGPT_FOLDER_ID ?? null,
      zaiApiKey: env.ZAI_API_KEY ?? null,
    },
    scan,
  };
}
