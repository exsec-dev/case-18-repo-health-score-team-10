// http.ts — общий живой клиент SourceCraft REST (каталог + ресурсные
// коллекторы): токен из env (значение никогда не логируется), бережность
// (интервал ≥50мс между запросами), счётчик запросов для бюджета зондов,
// таймаут запроса (В4.1-fix, Ф1.6: зависший ответ платформы = status 0).
// Сеть не бросается исключениями: сбой = status 0 + error-текст.
export interface ScResponse {
  status: number;
  json: unknown;
  bodyText: string;
  error?: string;
}

export interface ScClient {
  get(path: string): Promise<ScResponse>;
  /** число сделанных живых запросов (бюджет приёмки ≤1000) */
  requestCount(): number;
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
}

export function makeScClient(opts: ScClientOptions): ScClient {
  const baseUrl = opts.baseUrl;
  const minInterval = opts.minIntervalMs ?? 50;
  const maxRequests = opts.maxRequests ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let count = 0;
  let lastAt = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      if (count >= maxRequests) {
        return { status: 0, json: null, bodyText: "", error: `budget exhausted: ${maxRequests} requests` };
      }
      const wait = minInterval - (Date.now() - lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      count++;
      let res: ScResponse;
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
        res = { status: r.status, json, bodyText };
      } catch (e) {
        res = { status: 0, json: null, bodyText: "", error: String((e as Error).message ?? e) };
      }
      opts.onRequest?.(path, res);
      return res;
    },
    requestCount: () => count,
  };
}
