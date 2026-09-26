// config.ts — env → конфиг. Fail-soft на старте (проверка при
// использовании — хакатон: сервер обязан подниматься и без ключей),
// честные сообщения об ошибках в момент обращения.
// Консолидация лимитов скана (решение 15.09, Алексей): все бюджеты
// живут здесь (Config.scan), а не константами в модулях. Слои:
// дефолты в коде ← env (.env — правка без GUI/CI). Пользовательский
// DB-override бюджетов удалён (К5 В4.1): лимиты скана — только оператор.
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
   * В5.4 (аудит очереди О3): резерв свободного места в tmp перед клоном, байт. Нет или 0 —
   * проверки нет (дефолт; стенд задает SCAN_MIN_FREE_MB в deploy/compose.yaml). Меньше
   * резерва — клон ждет, пока соседние клоны освободят диск (waitForDiskRoom).
   */
  minFreeBytes?: number;
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
  /** timeoutMs (Ф2.19) — СОБСТВЕННЫЙ бюджет извлечения фактов из клона: до
   *  В4.2a runner передавал сюда `degrade.timeoutMs`, и выключение
   *  деградационного яруса молча меняло дедлайн извлечения */
  extract: { maxBlameFiles: number; textCapBytes: number; commentsTopN: number; timeoutMs: number };
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
  // Ф2.5: потолок страниц — ПРЕДОХРАНИТЕЛЬ, не продуктовый дефолт. Полный
  // публичный каталог 17.09 — 27 446 репо за 275 страниц по 100; 1000 взято
  // с запасом почти вчетверо. Прежние 100 были бюджетом приёмки В1 и в проде
  // означали «эвикция не сработает никогда» (M7)
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
  /** адреса Я ID (Ф2.10): env YA_OAUTH_BASE / YA_LOGIN_BASE; дефолты боевые,
   *  тесты направляют их на локальный мок — как Config.api в Ф1.13 */
  yaOauthBase: string;
  yaLoginBase: string;
}

export interface SchedulerConfig {
  /** интервал ночной фазы обхода каталога (сутки по умолчанию, ТЗ §6) */
  intervalMs: number;
  /** интервал СВЕРКИ каталога (Ф2.5): дешёвый проход чаще сканов — час по
   *  умолчанию (решение Екатерины 17.09; задержка отражения ≤ интервала) */
  catalogIntervalMs: number;
  /** форс-полный рескан: игнорировать дифф last_updated, поставить все репо */
  fullRescan: boolean;
  /** лиз job'а: время, на которое job закрепляется за воркером; воркер продлевает
   *  его каждые leaseMs/3. В4.8.5 (§2-В2): дефолт 10 мин (DEFAULT_LEASE_MS),
   *  пол «худший скан» снят — см. leaseMsFromEnv */
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
  /** проверок прав избранного на юзера в минуту, сверх — 429 rate_limited (В4.2-port-fix, П2): 6, env QUEUE_FAVORITE_CHECKS_PER_MINUTE */
  favoriteChecksPerMinute: number;
  /** кулдаун автозаявки по избранному от последнего OWN-скана зрителя (П2; решение 17.09 — 6 ч): env QUEUE_FAVORITE_OWN_COOLDOWN_MS */
  favoriteOwnCooldownMs: number;
  /** ретеншен завершённых строк `jobs` (Ф2.13): 30 дней, env QUEUE_RETENTION_DAYS */
  retentionDays: number;
  /** чтений /api/me/repos на юзера в минуту (Ф2.8): 30 (В4.8.5, §2-В3; было 6 — его съедали перечитывания списка после действий), env QUEUE_MY_REPOS_PER_MINUTE */
  myReposPerMinute: number;
  /** предел избранного на юзера (Ф2.21): 500, env QUEUE_FAVORITES_MAX */
  favoritesMax: number;
  /** открытий карточки залогиненным зрителем в минуту (В4.4, кластер G): 30, env QUEUE_CARD_PER_MINUTE; аноним — без лимита (проб нет).
   *  Optional ТОЛЬКО для старых литералов QueueConfig в замороженных аудит-тестах
   *  (правка чужих аудит-файлов запрещена промптом вехи); loadConfig задаёт всегда. */
  cardPerMinute?: number;
  /** мутаций избранного (PUT/DELETE звезды) на юзера в минуту (В4.4, кластер K/З6): 30, env QUEUE_FAVORITES_MUTATIONS_PER_MINUTE.
   *  Optional — как cardPerMinute: замороженные аудит-литералы QueueConfig не правятся. */
  favoritesMutationsPerMinute?: number;
  /** кулдаун генерации AI-summary на репозиторий (В5, спека §3.4): 60 мин,
   *  env QUEUE_SUMMARY_COOLDOWN_MS. Кэш по скану (заметки уже есть —
   *  генерации нет) сужает поверхность (оп-ин удален В5.2; с В5.2 кулдаун — на версию
   *  public/full, а кредиты держат и лимиты AI в jobs/ai-quota.ts); кулдаун держит кредиты.
   *  Optional ТОЛЬКО для старых литералов QueueConfig в замороженных
   *  аудит-тестах (как cardPerMinute); loadConfig задаёт всегда. */
  summaryCooldownMs?: number;
  /** В5.1 (Security-З3): активных summary-заявок на юзера, сверх — 429
   *  too_many_active (симметрично userActiveMax): 2, env QUEUE_SUMMARY_ACTIVE_MAX.
   *  Optional ТОЛЬКО для старых литералов QueueConfig в замороженных
   *  аудит-тестах (как summaryCooldownMs); loadConfig задаёт всегда. */
  summaryActiveMax?: number;
  /** В5.2 (очередь, решение Екатерины 25.09): параллельных пользовательских СКАНОВ в процессе —
   *  вторая заявка того же пользователя идет после чужих, но свободный слот не простаивает
   *  (аудит очереди О4: приоритет, не запрет); тяжелый репо одного не держит остальных:
   *  2, env QUEUE_USER_SCAN_SLOTS (1-8). Optional — как summaryActiveMax. */
  userScanSlots?: number;
  /** В5.2 (там же): параллельных пользовательских AI-обзоров в процессе (обзор тоже клонирует
   *  репо для инструментов модели): 2, env QUEUE_USER_AI_SLOTS (1-8). Optional — как выше. */
  userAiSlots?: number;
  /** В5.2 (аудит очереди О2): репо «тяжелый», если какой-то его скан (кроме закрытых свипом
   *  сирот) шел дольше порога; тяжелые берет только первый слот пользовательских сканов и
   *  обзоров: 5 мин (p99 скана на стенде 25.09 — 0,93 мин; тяжелых 38 из ~28 тыс.),
   *  env QUEUE_HEAVY_SCAN_MS. Optional — как выше. */
  heavyScanMs?: number;
}

/** Дефолт порога «тяжелого» репо (аудит очереди О2). */
export const DEFAULT_HEAVY_SCAN_MS = 5 * 60_000;

/** В5.2 (очередь): предел слотов цикла — защита от опечатки в env (каждый слот — свой клон). */
export const MAX_LOOP_SLOTS = 8;
/** Слоты цикла из конфига: дефолт 2, в пределах 1..MAX_LOOP_SLOTS. */
export function loopSlots(value: number | undefined): number {
  return Math.min(MAX_LOOP_SLOTS, Math.max(1, value ?? 2));
}

/** Аудит очереди О9: слоты из env — зажим и отброшенное значение не молчат. */
function slotsFromEnv(env: Record<string, string>, name: string): number {
  const raw = env[name];
  const parsed = envInt(env, name);
  const slots = loopSlots(parsed ?? undefined);
  if (raw !== undefined && raw !== "" && parsed === null) console.warn(`[config] ${name}=${raw.slice(0, 20)} is not a positive integer, using default ${slots}`);
  else if (parsed !== null && parsed !== slots) console.warn(`[config] ${name}=${parsed} is above the limit, using ${slots}`);
  return slots;
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

/**
 * Адрес API из env (круг 2, LOW-11): только https://, кроме localhost и
 * 127.0.0.1 (тестовые моки). Иное значение — дефолт и предупреждение с
 * именем переменной (значение не печатается: в нём могут быть креды).
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
  /** ПОРТ S2: роль процесса — web | rating | all (очереди разделены) */
  processRole: "web" | "rating" | "all";
  api: ApiConfig;
  dataDir: string;
  sourcecraftToken: string | null;
  /**
   * В5.3 (круг 3, О5): публичный адрес сервиса без завершающего «/» — из него
   * строится код бейджа для README (относительный путь в чужом README не
   * покажет картинку). PUBLIC_BASE_URL; по умолчанию — origin YA_REDIRECT_URI:
   * адрес возврата Я ID и есть внешний адрес стенда.
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
    /** OpenAI-совместимый base URL (В5, К5.19): env LLM_BASE_URL — локальный
     *  дев-цикл (Ollama/LM Studio/vLLM) и зонд тарифа; null = дефолт z.ai.
     *  Только https, кроме localhost/127.0.0.1 (как apiBaseFromEnv). */
    baseUrl: string | null;
    yandexApiKey: string | null;
    yandexFolderId: string | null;
    zaiApiKey: string | null;
    /** В5.5 тур 2 (Т2-Б): общий предел длительности одного вызова модели, мс (запрос +
     *  весь стрим); env LLM_CALL_TIMEOUT_MS, дефолт DEFAULT_LLM_CALL_TIMEOUT_MS (180 с) */
    callTimeoutMs: number;
  };
  /** В5.2 (Б4, Б5): лимиты AI, пароль неограниченного доступа, автозапуск топа рейтинга */
  ai: AiConfig;
  scan: ScanConfig;
}

/** Лимиты одного действия AI (§2 «В5.2 — публичный AI-обзор…» п.5). */
export interface AiActionLimits {
  /** на человека за скользящий час */
  perHour: number;
  /** на человека за сутки (календарные, МСК) */
  perDay: number;
  /** на весь сервис за сутки — пользователи без пароля */
  globalPerDay: number;
}

export interface AiConfig {
  overview: AiActionLimits;
  check: AiActionLimits;
  /** аварийный потолок обзоров в сутки для пользователей с паролем (на весь сервис, п.6) */
  unlockedOverviewPerDay: number;
  /** то же для проверок оценки (решение Екатерины 25.09: «лимит 100 по паролю») */
  unlockedCheckPerDay: number;
  /** пароль неограниченного доступа — секрет .env (AI_UNLOCK_PASSWORD); null — функции нет */
  unlockPassword: string | null;
  /** состояние пароля для строки старта: задан / не задан / короче UNLOCK_PASSWORD_MIN (функция выключена) */
  unlockStatus: "on" | "off" | "too_short";
  /** ключ отпечатка пароля — APP_SECRET (аудит М5: HMAC, а не голый sha256); null — не задан */
  unlockKey: string | null;
  /** обзор и проверка для топа рейтинга после нового скана (п.4): AI_TOP_AUTO, по умолчанию выключено */
  topAuto: boolean;
  /** размер топа (AI_TOP_AUTO_SIZE, по умолчанию 10) */
  topAutoSize: number;
}

/** Дефолты — числа решения §2 «В5.2 — публичный AI-обзор…» (25.09) п.5-6. */
export const DEFAULT_AI: AiConfig = {
  overview: { perHour: 2, perDay: 6, globalPerDay: 30 },
  check: { perHour: 5, perDay: 20, globalPerDay: 60 },
  unlockedOverviewPerDay: 100,
  unlockedCheckPerDay: 100,
  unlockPassword: null,
  unlockStatus: "off",
  unlockKey: null,
  topAuto: false,
  topAutoSize: 10,
};

/** Чистая функция env → AiConfig (тесты инъекцией). Мусор в числах — дефолт (envInt). */
/** Минимальная длина пароля доступа к AI (аудит М5): попытки не ограничены — пароль обязан быть длинным. */
export const UNLOCK_PASSWORD_MIN = 20;

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

/** Чистая функция env → ScanConfig (тесты инъекцией, не файлами). */
export function scanFromEnv(env: Record<string, string>): ScanConfig {
  const d = DEFAULT_SCAN;
  return {
    clone: {
      timeoutMs: envInt(env, "SCAN_CLONE_TIMEOUT_MS") ?? d.clone.timeoutMs,
      maxBytes: envInt(env, "SCAN_CLONE_MAX_BYTES") ?? d.clone.maxBytes,
      pollMs: d.clone.pollMs,
      // В5.4: ключ появляется только при заданной переменной — дефолт без проверки места
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
 * Агрегатные капы генерации (спека В5 §3.3). В5.1 переехали из pipeline в
 * config: формула худшего скана включает фуз генерации, а config не может
 * импортировать pipeline (цикл).
 */
export const MAX_MODEL_CALLS = 48;
export const GENERATION_FUSE_MS = 6 * 60_000;

/**
 * ЧЕСТНЫЙ худший случай одного скана (Ф2.19, К4) — клон + (деградационный
 * ярус, если включён) + извлечение + фуз авто-генерации в окне скана + 15 мин
 * запаса; на дефолтах 20 + 25 + 25 + 6 + 15 = 91 мин.
 * В4.8.5 (К8.5.2b, решение владельца §2-В2): это больше НЕ пол лиза (функция
 * называлась `leaseFloorMs`). Им меряется то, что живёт столько же, сколько
 * скан: возраст свипа каталогов клонов (свип не сносит клон работающего git —
 * дефект Ф2.19) и признак «задание зависло» в health.
 * В5.1 (Прод-мелочь 7): фуз генерации (GENERATION_FUSE_MS) включён в формулу
 * явно — подъём фуза выше ~10 мин без правки формулы открывал гонку «свип
 * сносит клон под живой генерацией».
 */
export function worstCaseScanMs(scan: ScanConfig): number {
  return scan.clone.timeoutMs + (scan.degrade.enabled ? scan.degrade.timeoutMs : 0) + scan.extract.timeoutMs + GENERATION_FUSE_MS + 15 * 60_000;
}

/**
 * Лиз задания (К8.5.2b, решение владельца §2-В2 22.09): 10 минут, продление
 * каждые leaseMs/3 (3 мин 20 с) живым воркером. Сирота жёсткого завершения
 * уходит за 10 минут, а не за 85; цена — запись в БД раз в 3 минуты на
 * задание и перехват, если цикл событий процесса стоит дольше лиза.
 */
export const DEFAULT_LEASE_MS = 10 * 60_000;

/** Нижняя граница SCHEDULER_LEASE_MS: продление раз в треть лиза не чаще раза в 20 с. */
export const MIN_LEASE_MS = 60_000;

/** Дефолт лиза (имя — совместимость с В4.1; аргумент больше не влияет). */
export function defaultLeaseMs(_scan?: ScanConfig): number {
  return DEFAULT_LEASE_MS;
}

/**
 * `SCHEDULER_LEASE_MS` (В4.8.5): длительность лиза, которую держит живой
 * воркер продлением каждые leaseMs/3, — горизонт «процесс умер → задание
 * снова в очереди». Пол «худший скан» снят: длинный скан держится
 * продлением, а не длиной лиза. Значение ниже минуты поднимается до минуты.
 */
export function leaseMsFromEnv(env: Record<string, string>, _scan?: ScanConfig): number {
  const wanted = envInt(env, "SCHEDULER_LEASE_MS");
  if (wanted !== null && wanted < MIN_LEASE_MS) {
    console.error(`[config] SCHEDULER_LEASE_MS=${wanted} ms is below ${MIN_LEASE_MS} ms: using ${MIN_LEASE_MS} ms`);
    return MIN_LEASE_MS;
  }
  return wanted ?? DEFAULT_LEASE_MS;
}


/** Публичный адрес сервиса (В5.3, О5): PUBLIC_BASE_URL или origin адреса возврата Я ID. */
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

/** Т2-Б: общий предел вызова модели; не задан или мусор — дефолт (fail-soft, как envInt). */
export function llmCallTimeoutMsFromEnv(env: Record<string, string | undefined>): number {
  return envInt(env as Record<string, string>, "LLM_CALL_TIMEOUT_MS") ?? DEFAULT_LLM_CALL_TIMEOUT_MS;
}

export function loadConfig(): Config {
  const env = { ...envFile(), ...process.env } as Record<string, string>;
  const scan = scanFromEnv(env);
  const provider = env.LLM_PROVIDER === "zai" ? "zai" : "yandex";
  const mainModel = env.MAIN_MODEL ?? (provider === "yandex" ? "yandexgpt" : "glm-5.3");
  // Ф2.8: слишком короткий секрет = отсутствующий (сессии и PAT выключены),
  // а не «слабый, но рабочий»; значение в лог не печатается
  const appSecretRaw = env.APP_SECRET ?? null;
  const appSecret =
    appSecretRaw !== null && appSecretRaw.length < 32
      ? (console.error("[config] APP_SECRET: shorter than 32 chars — sessions and PAT storage are disabled"), null)
      : appSecretRaw;
  return {
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8418,
    processRole: (["all", "web", "rating"] as const).includes(process.env.PROCESS_ROLE as "all" | "web" | "rating")
      ? (process.env.PROCESS_ROLE as "all" | "web" | "rating")
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
      retentionDays: envInt(env, "QUEUE_RETENTION_DAYS") ?? 30,
      myReposPerMinute: envInt(env, "QUEUE_MY_REPOS_PER_MINUTE") ?? 30,
      favoritesMax: envInt(env, "QUEUE_FAVORITES_MAX") ?? 500,
      cardPerMinute: envInt(env, "QUEUE_CARD_PER_MINUTE") ?? 30,
      favoritesMutationsPerMinute: envInt(env, "QUEUE_FAVORITES_MUTATIONS_PER_MINUTE") ?? 30,
      summaryCooldownMs: envInt(env, "QUEUE_SUMMARY_COOLDOWN_MS") ?? 60 * 60_000,
      summaryActiveMax: envInt(env, "QUEUE_SUMMARY_ACTIVE_MAX") ?? 2,
      userScanSlots: slotsFromEnv(env, "QUEUE_USER_SCAN_SLOTS"),
      userAiSlots: slotsFromEnv(env, "QUEUE_USER_AI_SLOTS"),
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
