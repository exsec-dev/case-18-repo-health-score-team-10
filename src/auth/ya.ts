// ya.ts — Я ID OAuth (В4/Б1, решение Q4: Я ID = вход/UX, PAT = права на
// данные). Приложение зарегистрировано (17.09); redirect из конфига.
// Секреты только из env — в код/логи/ответы API значения не попадают:
// exchangeCode возвращает только {yaId, login}, без токенов Яндекса.
// HTTP-шов (fetch) инъектится — тесты без живой сети; живой вход
// Алексея — приёмка HQ, воркер проверяет контракт моками.

export interface YaIdCredentials {
  clientId: string | null;
  clientSecret: string | null;
  redirect: string;
}

export interface YaProfile {
  yaId: string;
  login: string;
}

export type ExchangeResult =
  | { ok: true; profile: YaProfile }
  | { ok: false; error: string };

/** Минимальный HTTP-шов: только то, что нужно OAuth-потоку. */
export interface YaHttp {
  postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: unknown }>;
  getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }>;
}

export const YA_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
const YA_TOKEN_URL = "https://oauth.yandex.ru/token";
const YA_INFO_URL = "https://login.yandex.ru/info";

/** Живой шов на fetch (ретраи не нужны: две короткие операции входа). */
export const liveYaHttp: YaHttp = {
  async postForm(url, form) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  },
  async getJson(url, headers) {
    const res = await fetch(url, { headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  },
};

/** URL начала OAuth-потока (state — CSRF-токен, генерирует вызываемый). */
export function buildAuthUrl(creds: YaIdCredentials, state: string): string {
  if (!creds.clientId) {
    throw new Error("YA_CLIENT_ID не задан: приложение Я ID не сконфигурировано (env)");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: creds.redirect,
    state,
  });
  return `${YA_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Обмен code → профиль Я ID: token → /info. Ошибки Яндекса проходят
 * текстом (без секретов): 400 invalid_grant, сеть, форма ответа /info.
 */
export async function exchangeCode(creds: YaIdCredentials, code: string, http: YaHttp = liveYaHttp): Promise<ExchangeResult> {
  if (!creds.clientId || !creds.clientSecret) {
    return { ok: false, error: "приложение Я ID не сконфигурировано (YA_CLIENT_ID/SECRET)" };
  }
  let tokenRes: { status: number; json: unknown };
  try {
    tokenRes = await http.postForm(YA_TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: creds.redirect,
    });
  } catch (e) {
    return { ok: false, error: `сеть Я ID: ${String((e as Error).message).slice(0, 120)}` };
  }
  const tokenBody = tokenRes.json as { access_token?: unknown; error_description?: unknown } | null;
  if (tokenRes.status !== 200 || typeof tokenBody?.access_token !== "string") {
    const desc = typeof tokenBody?.error_description === "string" ? tokenBody.error_description : `HTTP ${tokenRes.status}`;
    return { ok: false, error: `Я ID отклонил код: ${desc.slice(0, 160)}` };
  }
  let infoRes: { status: number; json: unknown };
  try {
    infoRes = await http.getJson(YA_INFO_URL, { Authorization: `OAuth ${tokenBody.access_token}` });
  } catch (e) {
    return { ok: false, error: `сеть Я ID (info): ${String((e as Error).message).slice(0, 120)}` };
  }
  const info = infoRes.json as { id?: unknown; login?: unknown } | null;
  if (infoRes.status !== 200 || (typeof info?.id !== "number" && typeof info?.id !== "string") || typeof info?.login !== "string") {
    return { ok: false, error: `Я ID info: HTTP ${infoRes.status}, форма ответа неожиданна` };
  }
  return { ok: true, profile: { yaId: String(info.id), login: info.login } };
}
