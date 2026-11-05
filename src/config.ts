// Конфиг из env (.env поверх дефолтов в коде). Fail-soft на старте: сервер
// поднимается и без ключей, а отсутствующий ключ дает понятную ошибку в момент
// обращения. Все бюджеты скана живут здесь (Config.scan) и задаются только
// оператором, не пользователем.
import { DEFAULT_YA_ENDPOINTS } from "./auth/ya";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, DEFAULT_ZAI_BASE_URL } from "./llm";

export interface CloneLimits {
  /** таймаут субпроцесса клонирования */
  timeoutMs: number;
  /** диск-бюджет: размер bare .git (du) */
  maxBytes: number;
  /** интервал du-поллинга watchdog'а */
  pollMs: number;
  /**
   * Резерв свободного места в tmp перед клоном, байт. Не задан — проверки нет (стенд задает
   * SCAN_MIN_FREE_MB в deploy/compose.yaml). Места меньше резерва — клон ждет, пока соседние
   * клоны освободят диск (waitForDiskRoom).
   */
  minFreeBytes?: number;
}

export interface DegradeLimits {
  /** деградационная попытка --shallow-since=<N>.months */
  sinceMonths: number;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
}

/** Лимиты git-канала: первая попытка + деградационный ярус. */
export interface ScanCloneLimits extends CloneLimits {
  degrade: DegradeLimits;
}

export interface ScanConfig {
  clone: CloneLimits;
  degrade: DegradeLimits;
  /** timeoutMs — таймаут одного REST-запроса; истек → status 0 */
  rest: { budget: number; minIntervalMs: number; appsecMinIntervalMs: number; timeoutMs: number };
  catalog: { maxPages: number };
  /** timeoutMs — собственный бюджет извлечения фактов из клона, не зависит от
   *  деградационного яруса (иначе его выключение меняло бы дедлайн извлечения) */
  extract: { maxBlameFiles: number; textCapBytes: number; commentsTopN: number; timeoutMs: number };
}

/**
 * Ярусы бюджета клона: первый 1.5 ГБ / 20 мин, деградация 2.5 ГБ / 25 мин
 * (самый крупный замеренный репо, 1.39 ГБ, проходит первым ярусом целиком).
 * Интервал AppSec ≥ 100 мс: лимиты частоты в документации SCS API не
 * определены, бережем сервис сами.
 */
export const DEFAULT_SCAN: ScanConfig = {
  clone: { timeoutMs: 20 * 60_000, maxBytes: 1.5 * 1024 * 1024 * 1024, pollMs: 5_000 },
  degrade: { sinceMonths: 13, timeoutMs: 25 * 60_000, maxBytes: 2.5 * 1024 * 1024 * 1024, enabled: true },
  rest: { budget: 1000, minIntervalMs: 50, appsecMinIntervalMs: 100, timeoutMs: 10_000 },
  // Потолок страниц — предохранитель, а не продуктовый лимит: весь публичный
  // каталог — около 275 страниц по 100, 1000 дает запас почти вчетверо.
  // Слишком низкий потолок означал бы, что эвикция удаленных репо не сработает
  catalog: { maxPages: 1000 },
  extract: { maxBlameFiles: 200, textCapBytes: 1_000_000, commentsTopN: 50, timeoutMs: 25 * 60_000 },
};

export interface AuthConfig {
  yaClientId: string | null;
  yaClientSecret: string | null;
  /** redirect URI приложения Я ID (стенд: http://localhost:8418/auth/ya/callback) */
  redirect: string;
  /** ключ подписи сессий и шифрования PAT (AES-256-GCM) */
  appSecret: string | null;
  /** адреса Я ID: env YA_OAUTH_BASE / YA_LOGIN_BASE; дефолты боевые,
   *  тесты направляют их на локальный мок (как Config.api) */
  yaOauthBase: string;
  yaLoginBase: string;
}

export interface SchedulerConfig {
  /** интервал ночной фазы обхода каталога (сутки по умолчанию) */
  intervalMs: number;
  /** интервал сверки каталога: дешевый проход чаще сканов, час по умолчанию
   *  (новые и удаленные репо отражаются не позже интервала) */
  catalogIntervalMs: number;
  /** форс-полный рескан: игнорировать дифф last_updated, поставить все репо */
  fullRescan: boolean;
  /** лиз задания: на сколько оно закрепляется за воркером; воркер продлевает
   *  его каждые leaseMs/3. Дефолт — DEFAULT_LEASE_MS, см. leaseMsFromEnv */
  leaseMs: number;
  /** задержка первого обхода после старта сервера: окно управления стендом
   *  (обход с живым токеном ставит в очередь первый скан всего каталога —
   *  это дизайн продукта, но оператор обязан успеть это видеть/отключить) */
  startDelayMs: number;
}

export interface QueueConfig {
  /** новых пользовательских заявок за скользящий час на пользователя: 10, env QUEUE_USER_SCANS_PER_HOUR */
  userScansPerHour: number;
  /** предел попыток задания: достигнут → failed без claim: 3, env QUEUE_MAX_ATTEMPTS */
  maxAttempts: number;
  /** активных (queued/running) заявок на пользователя, сверх — 429 too_many_active: 2, env QUEUE_USER_ACTIVE_MAX */
  userActiveMax: number;
  /** проверок прав избранного на пользователя в минуту, сверх — 429 rate_limited: 6, env QUEUE_FAVORITE_CHECKS_PER_MINUTE */
  favoriteChecksPerMinute: number;
  /** кулдаун автозаявки по избранному от последнего OWN-скана зрителя: 6 ч, env QUEUE_FAVORITE_OWN_COOLDOWN_MS */
  favoriteOwnCooldownMs: number;
  /** как часто можно запускать анализ публичного репозитория своей организации, когда токену не видны
   *  CI/CD и Безопасность: раз в 6 ч от последнего анализа репозитория кем угодно, включая плановый,
   *  env QUEUE_REPO_COOLDOWN_MS. Optional — как cardPerMinute. */
  repoCooldownMs?: number;
  /** сколько хранить завершенные строки `jobs`: 30 дней, env QUEUE_RETENTION_DAYS */
  retentionDays: number;
  /** чтений /api/me/repos на пользователя в минуту: 30 (кабинет перечитывает список после каждого действия), env QUEUE_MY_REPOS_PER_MINUTE */
  myReposPerMinute: number;
  /** предел избранного на пользователя: 500, env QUEUE_FAVORITES_MAX */
  favoritesMax: number;
  /** открытий карточки залогиненным зрителем в минуту: 30, env QUEUE_CARD_PER_MINUTE; аноним без лимита (для него нет проб доступа).
   *  Optional только ради старых литералов QueueConfig в тестах; loadConfig задает всегда. */
  cardPerMinute?: number;
  /** чтений истории оценки и истории AI-текстов (/history, /ai-notes) залогиненным зрителем в минуту: 60,
   *  env QUEUE_HISTORY_PER_MINUTE. Свое окно, не окно карточки: страница репозитория читает их вместе с
   *  карточкой и перечитывает после каждого задания, иначе 5 открытий подряд съедали бы окно карточки.
   *  Optional — как cardPerMinute. */
  historyPerMinute?: number;
  /** мутаций избранного (PUT/DELETE звезды) на пользователя в минуту: 30, env QUEUE_FAVORITES_MUTATIONS_PER_MINUTE.
   *  Optional — как cardPerMinute. */
  favoritesMutationsPerMinute?: number;
  /** кулдаун генерации AI-summary на репозиторий и версию (public/full): 60 мин,
   *  env QUEUE_SUMMARY_COOLDOWN_MS. Бережет кредиты модели вместе с лимитами AI
   *  в jobs/ai-quota.ts. Optional — как cardPerMinute. */
  summaryCooldownMs?: number;
  /** активных summary-заявок на пользователя, сверх — 429 too_many_active
   *  (симметрично userActiveMax): 2, env QUEUE_SUMMARY_ACTIVE_MAX. Optional — как cardPerMinute. */
  summaryActiveMax?: number;
  /** параллельных пользовательских сканов в процессе: вторая заявка того же пользователя идет
   *  после чужих, но свободный слот не простаивает (приоритет, а не запрет), и один тяжелый
   *  репо не держит остальных. 2, env QUEUE_USER_SCAN_SLOTS (1-8). Optional — как cardPerMinute. */
  userScanSlots?: number;
  /** параллельных пользовательских AI-обзоров в процессе (обзор тоже клонирует репо для
   *  инструментов модели): 2, env QUEUE_USER_AI_SLOTS (1-8). Optional — как выше. */
  userAiSlots?: number;
  /** параллельных сканов полосы рейтинга (пересбор каталога): 1, env QUEUE_RATING_SCAN_SLOTS (1-8);
   *  тяжелые репо берет только первый слот. Optional — как выше. */
  ratingScanSlots?: number;
  /** репо «тяжелый», если какой-то его скан (кроме сирот, закрытых свипом) шел дольше порога;
   *  тяжелые берет только первый слот пользовательских сканов и обзоров. 5 мин: p99 скана на
   *  стенде меньше минуты, тяжелых — десятки из ~28 тыс. env QUEUE_HEAVY_SCAN_MS. Optional — как выше. */
  heavyScanMs?: number;
}

export const DEFAULT_HEAVY_SCAN_MS = 5 * 60_000;

/** Ограничение частоты анализа публичного репозитория по членству в организации (QueueConfig.repoCooldownMs). */
export const DEFAULT_REPO_COOLDOWN_MS = 6 * 60 * 60_000;

/** Предел слотов цикла — защита от опечатки в env (каждый слот — свой клон). */
export const MAX_LOOP_SLOTS = 8;
/** Слоты цикла из конфига: дефолт 2, в пределах 1..MAX_LOOP_SLOTS. */
export function loopSlots(value: number | undefined): number {
  return Math.min(MAX_LOOP_SLOTS, Math.max(1, value ?? 2));
}

/** Слоты из env: о зажатом или отброшенном значении пишет предупреждение. */
function slotsFromEnv(env: Record<string, string>, name: string): number {
  const raw = env[name];
  const parsed = envInt(env, name);
  const slots = loopSlots(parsed ?? undefined);
  if (raw !== undefined && raw !== "" && parsed === null) console.warn(`[config] ${name}=${raw.slice(0, 20)} is not a positive integer, using default ${slots}`);
  else if (parsed !== null && parsed !== slots) console.warn(`[config] ${name}=${parsed} is above the limit, using ${slots}`);
  return slots;
}

export interface AccessConfig {
  /** TTL кэша проверок доступа зрителя: 15 мин, env ACCESS_CACHE_TTL_MS */
  cacheTtlMs: number;
  /** TTL результата check-failed — короче основного, потому что сбой проверки не ответ: 60 с, env ACCESS_FAILED_TTL_MS */
  failedTtlMs: number;
  /** предел записей кэша доступа, сверх — вытеснение старейших: 10 000, env ACCESS_CACHE_MAX_ENTRIES */
  maxEntries: number;
}

/** Адреса внешних API. Тестовый шов: тесты указывают их на локальный мок;
 *  дефолты — боевые адреса. */
export interface ApiConfig {
  /** SourceCraft REST (env SOURCECRAFT_API_BASE) */
  restBase: string;
  /** AppSec API (env APPSEC_API_BASE) */
  appsecBase: string;
  /** git-хост клонов (env SOURCECRAFT_GIT_BASE) — чтобы заявка в тестовом
   *  сервере не клонировала с живого хоста */
  gitBase: string;
}

export const DEFAULT_API: ApiConfig = {
  restBase: "https://api.sourcecraft.tech",
  appsecBase: "https://appsec.sourcecraft.tech",
  gitBase: "https://git.sourcecraft.dev",
};

/**
 * Адрес API из env: только https://, кроме localhost и 127.0.0.1 (тестовые
 * моки). Иное значение — дефолт и предупреждение с именем переменной
 * (само значение не печатается: в нем могут быть креды).
 */
export function apiBaseFromEnv(env: Record<string, string>, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return raw.replace(/\/+$/, "");
  } catch {
    /* не URL */
  }
  console.error(`[config] ${name}: only https:// (or http://localhost / http://127.0.0.1) is allowed; using the default`);
  return fallback;
}

export interface Config {
  port: number;
  /** роль процесса — web | rating | all (очереди разделены) */
  processRole: "web" | "rating" | "all";
  api: ApiConfig;
  dataDir: string;
  sourcecraftToken: string | null;
  /**
   * Публичный адрес сервиса без завершающего «/» — из него строится код бейджа
   * для README (относительный путь в чужом README картинку не покажет).
   * PUBLIC_BASE_URL; по умолчанию — origin YA_REDIRECT_URI: адрес возврата
   * Я ID и есть внешний адрес стенда.
   */
  publicBaseUrl: string;
  auth: AuthConfig;
  scheduler: SchedulerConfig;
  access: AccessConfig;
  queue: QueueConfig;
  llm: {
    provider: "yandex" | "zai";
    mainModel: string;
    sideModel: string;
    /** OpenAI-совместимый base URL: env LLM_BASE_URL — локальная разработка
     *  (Ollama/LM Studio/vLLM); null = дефолт z.ai.
     *  Только https, кроме localhost/127.0.0.1 (как apiBaseFromEnv). */
    baseUrl: string | null;
    yandexApiKey: string | null;
    yandexFolderId: string | null;
    zaiApiKey: string | null;
    /** общий предел длительности одного вызова модели, мс (запрос + весь стрим);
     *  env LLM_CALL_TIMEOUT_MS, дефолт DEFAULT_LLM_CALL_TIMEOUT_MS (180 с) */
    callTimeoutMs: number;
  };
  /** лимиты AI, пароль неограниченного доступа, автозапуск для топа рейтинга */
  ai: AiConfig;
  scan: ScanConfig;
}

/** Лимиты одного действия AI; null — окна нет. */
export interface AiActionLimits {
  /** на человека за скользящий час */
  perHour: number | null;
  /** на человека за сутки (календарные, МСК) */
  perDay: number;
  /** на весь сервис за сутки — пользователи без пароля */
  globalPerDay: number | null;
}

export interface AiConfig {
  overview: AiActionLimits;
  check: AiActionLimits;
  /** аварийный потолок обзоров в сутки для пользователей с паролем (на весь сервис); null — нет */
  unlockedOverviewPerDay: number | null;
  /** то же для проверок оценки */
  unlockedCheckPerDay: number | null;
  /** пароль неограниченного доступа — секрет .env (AI_UNLOCK_PASSWORD); null — функции нет */
  unlockPassword: string | null;
  /** состояние пароля для строки старта: задан / не задан / короче UNLOCK_PASSWORD_MIN (функция выключена) */
  unlockStatus: "on" | "off" | "too_short";
  /** ключ HMAC-отпечатка пароля — APP_SECRET (не голый sha256); null — не задан */
  unlockKey: string | null;
  /** обзор и проверка для топа рейтинга после нового скана: AI_TOP_AUTO, по умолчанию выключено */
  topAuto: boolean;
  /** размер топа (AI_TOP_AUTO_SIZE, по умолчанию 10) */
  topAutoSize: number;
}

// 20.10.2026: только суточный лимит на человека; часового, общего и потолка
// по паролю нет, пока их не задали в env
export const DEFAULT_AI: AiConfig = {
  overview: { perHour: null, perDay: 25, globalPerDay: null },
  check: { perHour: null, perDay: 50, globalPerDay: null },
  unlockedOverviewPerDay: null,
  unlockedCheckPerDay: null,
  unlockPassword: null,
  unlockStatus: "off",
  unlockKey: null,
  topAuto: false,
  topAutoSize: 10,
};

/** Минимальная длина пароля доступа к AI: число попыток не ограничено, поэтому пароль обязан быть длинным. */
export const UNLOCK_PASSWORD_MIN = 20;

/** Чистая функция env → AiConfig (тесты передают env напрямую). Мусор в числах — дефолт. */
export function aiConfigFromEnv(env: Record<string, string>): AiConfig {
  const password = (env.AI_UNLOCK_PASSWORD ?? "").trim();
  const status: AiConfig["unlockStatus"] = password === "" ? "off" : password.length < UNLOCK_PASSWORD_MIN ? "too_short" : "on";
  return {
    overview: {
      perHour: envInt(env, "AI_OVERVIEW_PER_HOUR") ?? DEFAULT_AI.overview.perHour,
      perDay: envInt(env, "AI_OVERVIEW_PER_DAY") ?? DEFAULT_AI.overview.perDay,
      globalPerDay: envInt(env, "AI_OVERVIEW_GLOBAL_PER_DAY") ?? DEFAULT_AI.overview.globalPerDay,
    },
    check: {
      perHour: envInt(env, "AI_CHECK_PER_HOUR") ?? DEFAULT_AI.check.perHour,
      perDay: envInt(env, "AI_CHECK_PER_DAY") ?? DEFAULT_AI.check.perDay,
      globalPerDay: envInt(env, "AI_CHECK_GLOBAL_PER_DAY") ?? DEFAULT_AI.check.globalPerDay,
    },
    unlockedOverviewPerDay: envInt(env, "AI_UNLOCKED_OVERVIEW_PER_DAY") ?? DEFAULT_AI.unlockedOverviewPerDay,
    unlockedCheckPerDay: envInt(env, "AI_UNLOCKED_CHECK_PER_DAY") ?? DEFAULT_AI.unlockedCheckPerDay,
    unlockPassword: status === "on" ? password : null,
    unlockStatus: status,
    unlockKey: env.APP_SECRET ? env.APP_SECRET : null,
    topAuto: envBool(env, "AI_TOP_AUTO") ?? DEFAULT_AI.topAuto,
    topAutoSize: envInt(env, "AI_TOP_AUTO_SIZE") ?? DEFAULT_AI.topAutoSize,
  };
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

/** Чистая функция env → ScanConfig (тесты передают env напрямую, без файлов). */
export function scanFromEnv(env: Record<string, string>): ScanConfig {
  const d = DEFAULT_SCAN;
  return {
    clone: {
      timeoutMs: envInt(env, "SCAN_CLONE_TIMEOUT_MS") ?? d.clone.timeoutMs,
      maxBytes: envInt(env, "SCAN_CLONE_MAX_BYTES") ?? d.clone.maxBytes,
      pollMs: d.clone.pollMs,
      // ключ появляется только при заданной переменной: по умолчанию место не проверяется
      ...(envInt(env, "SCAN_MIN_FREE_MB") !== null ? { minFreeBytes: envInt(env, "SCAN_MIN_FREE_MB")! * 1024 * 1024 } : {}),
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
    extract: { ...d.extract, timeoutMs: envInt(env, "SCAN_EXTRACT_TIMEOUT_MS") ?? d.extract.timeoutMs },
  };
}

/**
 * Агрегатные капы генерации. Живут здесь, а не в pipeline: формула худшего
 * скана включает фуз генерации, а config не может импортировать pipeline (цикл).
 */
export const MAX_MODEL_CALLS = 48;
export const GENERATION_FUSE_MS = 6 * 60_000;

/**
 * Худший случай одного скана: клон + деградационный ярус (если включен) +
 * извлечение + фуз авто-генерации + 15 мин запаса; на дефолтах
 * 20 + 25 + 25 + 6 + 15 = 91 мин. Этим меряется то, что живет столько же,
 * сколько скан: возраст, после которого свип сносит каталог клона (чтобы не
 * снести клон под работающим git или генерацией), и признак «задание зависло»
 * в health. Длину лиза он не задает.
 */
export function worstCaseScanMs(scan: ScanConfig): number {
  return scan.clone.timeoutMs + (scan.degrade.enabled ? scan.degrade.timeoutMs : 0) + scan.extract.timeoutMs + GENERATION_FUSE_MS + 15 * 60_000;
}

/**
 * Лиз задания: 10 минут, живой воркер продлевает его каждые leaseMs/3
 * (3 мин 20 с). Задание упавшего процесса возвращается в очередь за 10 минут;
 * цена — запись в БД раз в 3 минуты на задание и перехват, если цикл событий
 * процесса стоит дольше лиза.
 */
export const DEFAULT_LEASE_MS = 10 * 60_000;

/** Нижняя граница SCHEDULER_LEASE_MS: продление раз в треть лиза не чаще раза в 20 с. */
export const MIN_LEASE_MS = 60_000;

/** Дефолт лиза; аргумент оставлен ради совместимости вызовов и ни на что не влияет. */
export function defaultLeaseMs(_scan?: ScanConfig): number {
  return DEFAULT_LEASE_MS;
}

/**
 * `SCHEDULER_LEASE_MS` — через сколько задание умершего процесса снова
 * попадает в очередь. Длинный скан держится продлением, а не длиной лиза.
 * Значение ниже минуты поднимается до минуты.
 */
export function leaseMsFromEnv(env: Record<string, string>, _scan?: ScanConfig): number {
  const wanted = envInt(env, "SCHEDULER_LEASE_MS");
  if (wanted !== null && wanted < MIN_LEASE_MS) {
    console.error(`[config] SCHEDULER_LEASE_MS=${wanted} ms is below ${MIN_LEASE_MS} ms: using ${MIN_LEASE_MS} ms`);
    return MIN_LEASE_MS;
  }
  return wanted ?? DEFAULT_LEASE_MS;
}


/** Публичный адрес сервиса: PUBLIC_BASE_URL или origin адреса возврата Я ID. */
export function publicBaseUrlFromEnv(env: Record<string, string | undefined>): string {
  const raw = env.PUBLIC_BASE_URL ?? env.YA_REDIRECT_URI ?? "http://localhost:8418/auth/ya/callback";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    return env.PUBLIC_BASE_URL ? raw.replace(/\/+$/, "") : url.origin;
  } catch {
    throw new Error(`PUBLIC_BASE_URL: нужен адрес вида https://host — получено «${raw}»`);
  }
}

/** Общий предел вызова модели; не задан или мусор — дефолт. */
export function llmCallTimeoutMsFromEnv(env: Record<string, string | undefined>): number {
  return envInt(env as Record<string, string>, "LLM_CALL_TIMEOUT_MS") ?? DEFAULT_LLM_CALL_TIMEOUT_MS;
}

export function loadConfig(): Config {
  const env = { ...envFile(), ...process.env } as Record<string, string>;
  const scan = scanFromEnv(env);
  const provider = env.LLM_PROVIDER === "zai" ? "zai" : "yandex";
  // для yandex — Qwen3.6-35B-A3B в Yandex AI Studio, (до 20.10.2026 — yandexgpt)
  const mainModel = env.MAIN_MODEL ?? (provider === "yandex" ? "qwen3.6-35b-a3b" : "glm-5.3");
  // слишком короткий секрет считается отсутствующим (сессии и хранение PAT
  // выключаются), а не «слабым, но рабочим»; значение в лог не печатается
  const appSecretRaw = env.APP_SECRET ?? null;
  const appSecret =
    appSecretRaw !== null && appSecretRaw.length < 32
      ? (console.error("[config] APP_SECRET: shorter than 32 chars — sessions and PAT storage are disabled"), null)
      : appSecretRaw;
  return {
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8418,
    // как остальные переменные – из .env и окружения процесса (окружение важнее)
    processRole: (["all", "web", "rating"] as const).includes(env.PROCESS_ROLE as "all" | "web" | "rating")
      ? (env.PROCESS_ROLE as "all" | "web" | "rating")
      : "all",
    dataDir: env.DATA_DIR ?? "data",
    api: {
      restBase: apiBaseFromEnv(env, "SOURCECRAFT_API_BASE", DEFAULT_API.restBase),
      appsecBase: apiBaseFromEnv(env, "APPSEC_API_BASE", DEFAULT_API.appsecBase),
      gitBase: apiBaseFromEnv(env, "SOURCECRAFT_GIT_BASE", DEFAULT_API.gitBase),
    },
    sourcecraftToken: env.SOURCECRAFT_TOKEN ?? null,
    publicBaseUrl: publicBaseUrlFromEnv(env),
    auth: {
      yaClientId: env.YA_CLIENT_ID ?? null,
      yaClientSecret: env.YA_CLIENT_SECRET ?? null,
      redirect: env.YA_REDIRECT_URI ?? "http://localhost:8418/auth/ya/callback",
      appSecret,
      yaOauthBase: apiBaseFromEnv(env, "YA_OAUTH_BASE", DEFAULT_YA_ENDPOINTS.oauthBase),
      yaLoginBase: apiBaseFromEnv(env, "YA_LOGIN_BASE", DEFAULT_YA_ENDPOINTS.loginBase),
    },
    scheduler: {
      intervalMs: envInt(env, "SCHEDULER_INTERVAL_MS") ?? 24 * 60 * 60_000,
      catalogIntervalMs: envInt(env, "SCHEDULER_CATALOG_INTERVAL_MS") ?? 60 * 60_000,
      fullRescan: envBool(env, "SCHEDULER_FULL_RESCAN") ?? false,
      leaseMs: leaseMsFromEnv(env, scan),
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
      favoriteChecksPerMinute: envInt(env, "QUEUE_FAVORITE_CHECKS_PER_MINUTE") ?? 6,
      favoriteOwnCooldownMs: envInt(env, "QUEUE_FAVORITE_OWN_COOLDOWN_MS") ?? 6 * 60 * 60_000,
      repoCooldownMs: envInt(env, "QUEUE_REPO_COOLDOWN_MS") ?? DEFAULT_REPO_COOLDOWN_MS,
      retentionDays: envInt(env, "QUEUE_RETENTION_DAYS") ?? 30,
      myReposPerMinute: envInt(env, "QUEUE_MY_REPOS_PER_MINUTE") ?? 30,
      favoritesMax: envInt(env, "QUEUE_FAVORITES_MAX") ?? 500,
      cardPerMinute: envInt(env, "QUEUE_CARD_PER_MINUTE") ?? 30,
      historyPerMinute: envInt(env, "QUEUE_HISTORY_PER_MINUTE") ?? 60,
      favoritesMutationsPerMinute: envInt(env, "QUEUE_FAVORITES_MUTATIONS_PER_MINUTE") ?? 30,
      summaryCooldownMs: envInt(env, "QUEUE_SUMMARY_COOLDOWN_MS") ?? 60 * 60_000,
      summaryActiveMax: envInt(env, "QUEUE_SUMMARY_ACTIVE_MAX") ?? 2,
      userScanSlots: slotsFromEnv(env, "QUEUE_USER_SCAN_SLOTS"),
      userAiSlots: slotsFromEnv(env, "QUEUE_USER_AI_SLOTS"),
      ratingScanSlots: env["QUEUE_RATING_SCAN_SLOTS"] ? slotsFromEnv(env, "QUEUE_RATING_SCAN_SLOTS") : undefined,
      heavyScanMs: envInt(env, "QUEUE_HEAVY_SCAN_MS") ?? DEFAULT_HEAVY_SCAN_MS,
    },
    llm: {
      provider,
      mainModel,
      sideModel: env.SIDE_MODEL ?? mainModel,
      baseUrl: env.LLM_BASE_URL ? apiBaseFromEnv(env, "LLM_BASE_URL", DEFAULT_ZAI_BASE_URL) : null,
      yandexApiKey: env.YAGPT_API_KEY ?? null,
      yandexFolderId: env.YAGPT_FOLDER_ID ?? null,
      zaiApiKey: env.ZAI_API_KEY ?? null,
      callTimeoutMs: llmCallTimeoutMsFromEnv(env),
    },
    ai: aiConfigFromEnv(env),
    scan,
  };
}
