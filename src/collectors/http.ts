// Общий клиент SourceCraft REST (каталог и сборщики). Значение токена никогда
// не логируется. Между запросами выдерживается интервал (по умолчанию 50 мс),
// число запросов ограничено бюджетом, у каждого запроса таймаут. Сеть не
// бросает исключений: сбой или таймаут – status 0 и текст в `error`.
//
// Бережный доступ в пределах процесса:
//  - 429/503 повторяются с учетом `Retry-After` (секунды или HTTP-дата), а без
//    него – с экспоненциальным бэкоффом. Ожидание длиннее потолка (`maxWaitMs`)
//    не выполняется: ответ возвращается с `retryAfterMs`, решает вызывающий.
//    Повторы не расходуют `maxRequests`: бюджет считает логические запросы
//    (страницы), а не попытки;
//  - все клиенты одного (хост, токен) делят общий ритм: реестр слотов в памяти
//    модуля по хосту и sha256-отпечатку токена. Слот резервируется синхронно до
//    ожидания, поэтому и параллельные `get` одного клиента идут не чаще интервала.
// Между процессами и репликами ритм не согласуется.
import { createHash } from "node:crypto";

export interface ScResponse {
  status: number;
  json: unknown;
  bodyText: string;
  error?: string;
  /** ожидание, о котором просила платформа (`Retry-After`), если последним остался ответ 429/503 */
  retryAfterMs?: number;
}

export interface ScClient {
  get(path: string): Promise<ScResponse>;
  /** число логических запросов, израсходованных из бюджета */
  requestCount(): number;
}

export interface RetryPolicy {
  /** повторов 429/503 сверх первой попытки (по умолчанию 3) */
  maxRetries?: number;
  /** потолок одного ожидания, мс (по умолчанию 30 с): Retry-After длиннее – не ждем, отдаем ответ */
  maxWaitMs?: number;
  /** база бэкоффа без Retry-After, мс (по умолчанию 1 с): 1, 2, 4 … */
  baseBackoffMs?: number;
}

export interface ScClientOptions {
  token: string | null;
  /**
   * Адрес REST-хоста (`Config.api.restBase`) обязателен без умолчания: иначе
   * клиент молча уходил бы на боевой хост, даже когда конфиг направил API на
   * мок, и токен зрителя утекал бы в живой сервис.
   */
  baseUrl: string;
  minIntervalMs?: number;
  maxRequests?: number;
  /** таймаут запроса (Config.scan.rest.timeoutMs, по умолчанию 10 с): истек → status 0 */
  timeoutMs?: number;
  onRequest?: (path: string, res: ScResponse) => void;
  retry?: RetryPolicy;
  /** подмена часов в тестах: ожидание (по умолчанию setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** подмена часов в тестах: текущее время, мс (по умолчанию Date.now) */
  now?: () => number;
}

/** Потолок одного ожидания `Retry-After` по умолчанию. */
export const RETRY_AFTER_CAP_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_MS = 1_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Статусы перегрузки платформы – их повторяем. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** `Retry-After`: целые секунды или HTTP-дата, в мс; нет или мусор – null. */
export function parseRetryAfter(raw: string | null, nowMs: number): number | null {
  if (raw === null) return null;
  const v = raw.trim();
  if (v === "") return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Сколько ждать перед повтором: Retry-After, если он есть и не длиннее
 * потолка, а без заголовка – экспоненциальный бэкофф. null – платформа
 * просит ждать дольше потолка, повтора не будет.
 */
export function retryDelayMs(retryAfterMs: number | null | undefined, attempt: number, policy: RetryPolicy = {}): number | null {
  const cap = policy.maxWaitMs ?? RETRY_AFTER_CAP_MS;
  if (retryAfterMs !== null && retryAfterMs !== undefined) return retryAfterMs <= cap ? retryAfterMs : null;
  const backoff = (policy.baseBackoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** attempt;
  return Math.min(backoff, cap);
}

// ---------- общий ритм клиентов одного (хост, токен) в процессе ----------

/** ключ → время следующего разрешенного запроса (мс) */
const rhythm = new Map<string, number>();
const RHYTHM_MAX_KEYS = 1000;
const RHYTHM_IDLE_MS = 60_000;

/** Ключ ритма: хост + отпечаток токена, сам токен в реестре не хранится. */
export function rhythmKey(baseUrl: string, token: string | null): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    /* не URL – ключ по строке */
  }
  const who = token === null || token === "" ? "anon" : createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${host}|${who}`;
}

/**
 * Резервирует слот запроса и возвращает, сколько до него ждать. Резерв
 * синхронный: следующий вызов (параллельный `get`, другой клиент того же
 * токена) встает за этим слотом, а не рядом с ним.
 */
export function reserveSlot(key: string, minIntervalMs: number, nowMs: number): number {
  if (rhythm.size > RHYTHM_MAX_KEYS) {
    for (const [k, slot] of rhythm) if (slot < nowMs - RHYTHM_IDLE_MS) rhythm.delete(k);
  }
  const slot = Math.max(nowMs, (rhythm.get(key) ?? Number.NEGATIVE_INFINITY) + minIntervalMs);
  rhythm.set(key, slot);
  return slot - nowMs;
}

/** Для тестов: реестр общий на модуль, изоляция – сбросом. */
export function __resetRhythm(): void {
  rhythm.clear();
}

export function makeScClient(opts: ScClientOptions): ScClient {
  const baseUrl = opts.baseUrl;
  const minInterval = opts.minIntervalMs ?? 50;
  const maxRequests = opts.maxRequests ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const maxRetries = Math.max(0, opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const key = rhythmKey(baseUrl, opts.token);
  let count = 0;

  const once = async (path: string): Promise<ScResponse> => {
    const wait = reserveSlot(key, minInterval, now());
    if (wait > 0) await sleep(wait);
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await r.text();
      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* не JSON – остается в bodyText */
      }
      const res: ScResponse = { status: r.status, json, bodyText };
      if (isRetryableStatus(r.status)) {
        const after = parseRetryAfter(r.headers.get("retry-after"), now());
        if (after !== null) res.retryAfterMs = after;
      }
      return res;
    } catch (e) {
      return { status: 0, json: null, bodyText: "", error: String((e as Error).message ?? e) };
    }
  };

  return {
    async get(path: string): Promise<ScResponse> {
      if (count >= maxRequests) {
        return { status: 0, json: null, bodyText: "", error: `budget exhausted: ${maxRequests} requests` };
      }
      count++; // бюджет – логические запросы; повторы ниже его не расходуют
      let res = await once(path);
      for (let attempt = 0; attempt < maxRetries && isRetryableStatus(res.status); attempt++) {
        const delay = retryDelayMs(res.retryAfterMs, attempt, opts.retry);
        if (delay === null) break; // платформа просит ждать дольше потолка – решает вызывающий
        opts.onRequest?.(path, res);
        if (delay > 0) await sleep(delay);
        res = await once(path);
      }
      opts.onRequest?.(path, res);
      return res;
    },
    requestCount: () => count,
  };
}
