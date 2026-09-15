// http.ts — общий живой клиент SourceCraft REST (каталог + ресурсные
// коллекторы): токен из env (значение никогда не логируется), бережность
// (интервал ≥50мс между запросами), счётчик запросов для бюджета зондов.
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
  baseUrl?: string;
  minIntervalMs?: number;
  maxRequests?: number;
  onRequest?: (path: string, res: ScResponse) => void;
}

export function makeScClient(opts: ScClientOptions): ScClient {
  const baseUrl = opts.baseUrl ?? "https://api.sourcecraft.tech";
  const minInterval = opts.minIntervalMs ?? 50;
  const maxRequests = opts.maxRequests ?? 1000;
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
