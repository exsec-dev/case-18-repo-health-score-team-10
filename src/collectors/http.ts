// http.ts — общий живой клиент SourceCraft REST (каталог + ресурсные
// коллекторы): токен из env (значение никогда не логируется), бережность
// (интервал ≥50мс между запросами), счётчик запросов для бюджета зондов,
// таймаут запроса (В4.1-fix, Ф1.6: зависший ответ платформы = status 0).
// Сеть не бросается исключениями: сбой = status 0 + error-текст.
//
// В4.8.5 (К8.5.5a, бережный доступ в пределах процесса):
//  - ретрай 429/503 с учетом `Retry-After` (секунды или HTTP-дата) и
//    экспоненциальным бэкоффом, если заголовка нет; ожидание длиннее потолка
//    (`maxWaitMs`) не выполняется — ответ возвращается как есть с
//    `retryAfterMs`, вызывающий решает сам. Ретраи НЕ считаются в
//    `maxRequests`: бюджет — это число логических запросов (страниц), а не
//    попыток; иначе один 429 на странице 2 съедал бы бюджет обхода «страницы
//    + 10»;
//  - ОБЩИЙ ритм всех клиентов одного (хост, токен) в процессе: реестр
//    слотов в памяти модуля (ключ — хост и sha256-отпечаток токена, сам токен
//    не хранится и не логируется). Слот резервируется синхронно до ожидания,
//    поэтому и параллельные `get` одного клиента идут не чаще интервала;
//  - шов `sleep`/`now` — фейковые часы тестов.
// Межпроцессная и межрепличная координация — веха В6 (TASK.md §2, Р1).
import { createHash } from "node:crypto";

export interface ScResponse {
  status: number;
  json: unknown;
  bodyText: string;
  error?: string;
  /** К8.5.5a: ожидание, которое просила платформа (`Retry-After`), если ответ 429/503 остался последним */
  retryAfterMs?: number;
}

export interface ScClient {
  get(path: string): Promise<ScResponse>;
  /** число сделанных живых запросов (бюджет приёмки ≤1000) */
  requestCount(): number;
}

export interface RetryPolicy {
  /** повторов 429/503 сверх первой попытки (дефолт 3) */
  maxRetries?: number;
  /** потолок одного ожидания, мс (дефолт 30 с): Retry-After длиннее — не ждём, отдаём ответ */
  maxWaitMs?: number;
  /** база бэкоффа без Retry-After, мс (дефолт 1 с): 1, 2, 4 … */
  baseBackoffMs?: number;
}

export interface ScClientOptions {
  token: string | null;
  /**
   * Адрес REST-хоста (`Config.api.restBase`) — ОБЯЗАТЕЛЕН (М7 круга 2
   * В4.2-port-fix). Дефолт модуля молча уводил клиент на боевой хост в обход
   * шва Ф1.13: ровно так PAT зрителя уходил в живой AppSec при
   * `APPSEC_API_BASE` на мок (Н2). Соглашение «все живые места и так
   * передают адрес» держалось на дисциплине; теперь его держит тип.
   */
  baseUrl: string;
  minIntervalMs?: number;
  maxRequests?: number;
  /** таймаут запроса (Config.scan.rest.timeoutMs, дефолт 10 с): истёк → status 0 (Ф1.6) */
  timeoutMs?: number;
  onRequest?: (path: string, res: ScResponse) => void;
  /** К8.5.5a: политика ретраев 429/503 */
  retry?: RetryPolicy;
  /** шов фейковых часов: ожидание (дефолт — setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** шов фейковых часов: текущее время, мс (дефолт — Date.now) */
  now?: () => number;
}

/** Потолок одного ожидания `Retry-After` по умолчанию (К8.5.5a; выбор исполнителя — отчёт вехи). */
export const RETRY_AFTER_CAP_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_MS = 1_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Статусы, которые платформа отдаёт на перегрузку: их — повторять. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** `Retry-After`: целые секунды или HTTP-дата; мусор/нет — null. */
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
 * потолка; иначе (заголовка нет) — экспоненциальный бэкофф; null — ждать
 * дольше потолка платформа просит сама, повтор не выполняется.
 */
export function retryDelayMs(retryAfterMs: number | null | undefined, attempt: number, policy: RetryPolicy = {}): number | null {
  const cap = policy.maxWaitMs ?? RETRY_AFTER_CAP_MS;
  if (retryAfterMs !== null && retryAfterMs !== undefined) return retryAfterMs <= cap ? retryAfterMs : null;
  const backoff = (policy.baseBackoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** attempt;
  return Math.min(backoff, cap);
}

// ---------- общий ритм клиентов одного (хост, токен) в процессе ----------

/** ключ → время следующего разрешённого запроса (мс) */
const rhythm = new Map<string, number>();
const RHYTHM_MAX_KEYS = 1000;
const RHYTHM_IDLE_MS = 60_000;

/** Ключ ритма: хост + отпечаток токена (сам токен в реестре не лежит). */
export function rhythmKey(baseUrl: string, token: string | null): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    /* не URL — ключ по строке */
  }
  const who = token === null || token === "" ? "anon" : createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${host}|${who}`;
}

/**
 * Зарезервировать слот запроса и вернуть, сколько ждать до него. Резерв
 * синхронный — следующий вызов (параллельный `get`, другой клиент того же
 * токена) встаёт за этим слотом, а не рядом с ним.
 */
export function reserveSlot(key: string, minIntervalMs: number, nowMs: number): number {
  if (rhythm.size > RHYTHM_MAX_KEYS) {
    for (const [k, slot] of rhythm) if (slot < nowMs - RHYTHM_IDLE_MS) rhythm.delete(k);
  }
  const slot = Math.max(nowMs, (rhythm.get(key) ?? Number.NEGATIVE_INFINITY) + minIntervalMs);
  rhythm.set(key, slot);
  return slot - nowMs;
}

/** Шов тестов: реестр модульный, герметичность — сбросом. */
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
        /* не json — остаётся в bodyText */
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
      count++; // бюджет — логические запросы; ретраи ниже его не расходуют
      let res = await once(path);
      for (let attempt = 0; attempt < maxRetries && isRetryableStatus(res.status); attempt++) {
        const delay = retryDelayMs(res.retryAfterMs, attempt, opts.retry);
        if (delay === null) break; // платформа просит ждать дольше потолка — решает вызывающий
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
