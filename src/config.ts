// config.ts — env → конфиг. Fail-soft на старте (проверка при
// использовании — хакатон: сервер обязан подниматься и без ключей),
// честные сообщения об ошибках в момент обращения.
// Консолидация лимитов скана (решение 15.09, Алексей): все бюджеты
// живут здесь (Config.scan), а не константами в модулях. Слои:
// дефолты в коде ← env (.env — правка без GUI/CI) ← DB-override (В4).
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
}

/** Лимиты git-канала: первая попытка + деградационный ярус (§5.7). */
export interface ScanCloneLimits extends CloneLimits {
  degrade: DegradeLimits;
}

export interface ScanConfig {
  clone: CloneLimits;
  degrade: DegradeLimits;
  rest: { budget: number; minIntervalMs: number };
  catalog: { maxPages: number };
  extract: { maxBlameFiles: number; textCapBytes: number; commentsTopN: number };
}

export const DEFAULT_SCAN: ScanConfig = {
  clone: { timeoutMs: 10 * 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 },
  // деградационный ярус 2000МБ/20мин (Алексей 15.09: 700 слишком близко к 500)
  degrade: { sinceMonths: 13, timeoutMs: 20 * 60_000, maxBytes: 2000 * 1024 * 1024 },
  rest: { budget: 1000, minIntervalMs: 50 },
  catalog: { maxPages: 100 },
  extract: { maxBlameFiles: 200, textCapBytes: 1_000_000, commentsTopN: 50 },
};

export interface Config {
  port: number;
  dataDir: string;
  sourcecraftToken: string | null;
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
    },
    rest: {
      budget: envInt(env, "SCAN_BUDGET") ?? d.rest.budget,
      minIntervalMs: d.rest.minIntervalMs,
    },
    catalog: { maxPages: envInt(env, "SCAN_CATALOG_MAX_PAGES") ?? d.catalog.maxPages },
    extract: { ...d.extract },
  };
}

export function loadConfig(): Config {
  const env = { ...envFile(), ...process.env } as Record<string, string>;
  const provider = env.LLM_PROVIDER === "zai" ? "zai" : "yandex";
  const mainModel = env.MAIN_MODEL ?? (provider === "yandex" ? "yandexgpt" : "glm-5.3");
  return {
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8418,
    dataDir: env.DATA_DIR ?? "data",
    sourcecraftToken: env.SOURCECRAFT_TOKEN ?? null,
    llm: {
      provider,
      mainModel,
      sideModel: env.SIDE_MODEL ?? mainModel,
      yandexApiKey: env.YAGPT_API_KEY ?? null,
      yandexFolderId: env.YAGPT_FOLDER_ID ?? null,
      zaiApiKey: env.ZAI_API_KEY ?? null,
    },
    scan: scanFromEnv(env),
  };
}
