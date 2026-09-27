// OAuth через Я ID. Я ID отвечает только за вход, права на данные дает PAT.
// Секреты берутся из env и не попадают в логи и ответы API: exchangeCode
// возвращает профиль, но не токены Яндекса. HTTP подставляется снаружи,
// чтобы тесты шли без сети.

import { AUTH_NO_ANSWER, AUTH_NOT_CONFIGURED, AUTH_NOT_CONFIRMED, AUTH_UNEXPECTED } from "./messages";

export interface YaIdCredentials {
  clientId: string | null;
  clientSecret: string | null;
  redirect: string;
}

export interface YaProfile {
  yaId: string;
  login: string;
  /** ФИО для показа (real_name → first_name+last_name → display_name); нет права login:info — null */
  displayName: string | null;
  /** default_avatar_id портрета; право login:avatar не выдано или портрета нет — null */
  avatarId: string | null;
}

/** URL портрета Я ID по id (islands-68 — квадрат 68px, хватает для 40px retina). */
export function yaAvatarUrl(avatarId: string): string {
  return `https://avatars.yandex.net/get-yapic/${encodeURIComponent(avatarId)}/islands-68`;
}

export type ExchangeResult =
  | { ok: true; profile: YaProfile }
  | { ok: false; error: string };

/** Минимальный HTTP-интерфейс: только то, что нужно OAuth-потоку. */
export interface YaHttp {
  postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: unknown }>;
  getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }>;
}

/**
 * Адреса Я ID. Тестовый сервер направляет их на локальный мок, чтобы
 * маршруты `/auth/*` проверялись по HTTP целиком; по умолчанию – боевые.
 */
export interface YaEndpoints {
  oauthBase: string;
  loginBase: string;
}

export const DEFAULT_YA_ENDPOINTS: YaEndpoints = {
  oauthBase: "https://oauth.yandex.ru",
  loginBase: "https://login.yandex.ru",
};

/**
 * Таймаут одной операции входа. Без него обмен кода висит до `idleTimeout`
 * сервера (120 с), и человек видит обрыв соединения вместо «вход не удался».
 */
export const YA_HTTP_TIMEOUT_MS = 10_000;

/** HTTP на fetch. Ретраи не нужны: вход – две короткие операции. */
export function makeYaHttp(timeoutMs = YA_HTTP_TIMEOUT_MS): YaHttp {
  return {
    async postForm(url, form) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async getJson(url, headers) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

export const liveYaHttp: YaHttp = makeYaHttp();

/** URL начала OAuth-потока (state — CSRF-токен, генерирует вызываемый). */
export function buildAuthUrl(
  creds: YaIdCredentials,
  state: string,
  endpoints: YaEndpoints = DEFAULT_YA_ENDPOINTS,
  /**
   * `forceConfirm` – параметр Я ID `force_confirm=yes`: экран подтверждения
   * показывается, даже если в браузере есть сессия Яндекса и доступ уже выдан.
   * Только так можно сменить аккаунт: иначе Яндекс молча вернет прежнего
   * пользователя, а наш «Выход» его сессию не трогает. Обычному входу этот
   * экран не нужен.
   */
  opts: { forceConfirm?: boolean } = {},
): string {
  if (!creds.clientId) {
    throw new Error("YA_CLIENT_ID не задан: приложение Я ID не сконфигурировано (env)");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: creds.redirect,
    state,
  });
  if (opts.forceConfirm) params.set("force_confirm", "yes");
  return `${endpoints.oauthBase}/authorize?${params.toString()}`;
}

/**
 * Обмен code → профиль Я ID: /token, затем /info. Любой сбой (сеть, отказ,
 * неожиданная форма ответа) возвращается готовым текстом без секретов.
 */
export async function exchangeCode(
  creds: YaIdCredentials,
  code: string,
  http: YaHttp = liveYaHttp,
  endpoints: YaEndpoints = DEFAULT_YA_ENDPOINTS,
): Promise<ExchangeResult> {
  if (!creds.clientId || !creds.clientSecret) {
    return { ok: false, error: AUTH_NOT_CONFIGURED };
  }
  let tokenRes: { status: number; json: unknown };
  try {
    tokenRes = await http.postForm(`${endpoints.oauthBase}/token`, {
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: creds.redirect,
    });
  } catch {
    return { ok: false, error: AUTH_NO_ANSWER };
  }
  const tokenBody = tokenRes.json as { access_token?: unknown; error_description?: unknown } | null;
  if (tokenRes.status !== 200 || typeof tokenBody?.access_token !== "string") {
    return { ok: false, error: AUTH_NOT_CONFIRMED };
  }
  let infoRes: { status: number; json: unknown };
  try {
    infoRes = await http.getJson(`${endpoints.loginBase}/info`, { Authorization: `OAuth ${tokenBody.access_token}` });
  } catch {
    return { ok: false, error: AUTH_NO_ANSWER };
  }
  const info = infoRes.json as {
    id?: unknown;
    login?: unknown;
    display_name?: unknown;
    real_name?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    default_avatar_id?: unknown;
    is_avatar_empty?: unknown;
  } | null;
  if (infoRes.status !== 200 || (typeof info?.id !== "number" && typeof info?.id !== "string") || typeof info?.login !== "string") {
    return { ok: false, error: AUTH_UNEXPECTED };
  }
  // ФИО важнее публичного имени: display_name у Я ID по умолчанию равен логину
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const fromParts = [str(info.first_name), str(info.last_name)].filter((v): v is string => v !== null).join(" ");
  const name = str(info.real_name) ?? (fromParts !== "" ? fromParts : null) ?? str(info.display_name);
  const avatarId =
    typeof info.default_avatar_id === "string" && info.default_avatar_id !== "" && info.is_avatar_empty !== true ? info.default_avatar_id : null;
  return { ok: true, profile: { yaId: String(info.id), login: info.login, displayName: name, avatarId } };
}
