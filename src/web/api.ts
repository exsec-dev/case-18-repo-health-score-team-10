// api.ts — тонкий слой доступа к read-API. Типы берутся из серверного
// модуля import type'ом: одна форма данных на обе стороны, при этом в
// бандл фронтенда не утекает ни строчки серверного кода (типы стираются).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, MetaResponse, RatingResponse, RepoCard } from "../api/repos";
import type { MyRepoEntry } from "../api/me";
import { errorText } from "./format";

export type { MetaResponse, RatingResponse, RepoCard, MyRepoEntry };

export interface MeResponse {
  /** null = аноним (зонд шапки отдаёт 200 и без сессии) */
  login: string | null;
  /** имя из Я ID (право login:info); null — показываем логин */
  displayName: string | null;
  /** портрет Я ID (право login:avatar); null — инициалы */
  avatarUrl: string | null;
  hasPat: boolean;
  patCheckedAt: string | null;
}

export interface MyReposResponse {
  username: string | null;
  entries: MyRepoEntry[];
}

/**
 * В4.8.5 (К8.5.4): ошибка запроса с кодом сервера и HTTP-статусом — текст для
 * человека берётся из словаря `errorText` по коду/статусу, а не из сырого
 * `message` («HTTP 502», «Failed to fetch»).
 */
export class RequestError extends Error {
  constructor(
    message: string,
    /** HTTP-статус; 0 — сеть (ответа нет) */
    readonly status: number,
    /** код ошибки сервера (`error.code`) или null */
    readonly code: string | null,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * В4.8.5 (К8.5.8): сессия — одно состояние на клиенте. 401 любого
 * `/api/me/*` означает «сессии больше нет» — событие будит App, тот
 * перечитывает `/api/me`, и приложение целиком переходит в «вы вышли»
 * (rail с «Войти», «Задания» гаснут), а не остаётся полуживым.
 */
export const SESSION_LOST = "rh-session-lost";

function noteStatus(url: string, status: number): void {
  if (status === 401 && url.startsWith("/api/me/")) {
    try {
      window.dispatchEvent(new Event(SESSION_LOST));
    } catch {
      /* не браузер (тесты) — событие некому ловить */
    }
  }
}

/** Ответ сервера → ошибка со словарным текстом. */
async function errorOf(url: string, res: Response): Promise<RequestError> {
  noteStatus(url, res.status);
  const body = (await res.json().catch(() => null)) as ApiError | { error?: { code?: string; message?: string } } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : null;
  return new RequestError(errorText({ status: res.status, code, message: body?.error?.message ?? null, retryAfter: res.headers.get("retry-after") }), res.status, code);
}

/** Сетевой сбой (нет ответа) → ошибка со словарным текстом. */
function networkError(): RequestError {
  return new RequestError(errorText({ status: 0, code: null, message: null }), 0, null);
}

/** Выход: сервер отзывает сессию; дальше — полная перезагрузка на рейтинг (сбрасывает всё, что знала страница о зрителе). */
export async function logout(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/auth/logout", { method: "POST" });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await errorOf("/auth/logout", res);
  window.location.assign("/");
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw networkError();
  }
  if (!res.ok) throw await errorOf(url, res);
  const data = (await res.json().catch(() => undefined)) as T | undefined;
  if (data === undefined) throw new RequestError(errorText({ status: res.status, code: "bad_body", message: null }), res.status, "bad_body");
  return data;
}

/** Мутации me-поверхности: PUT/DELETE/POST с телом и словарным текстом ошибки. */
export async function mutateJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await errorOf(url, res);
  return (await res.json().catch(() => null)) as T;
}

/**
 * `stale` — данные прошлого успешного ответа, пока грузится новый (только с
 * опцией `keepPrevious`); без опции загрузка всегда «пустая», как раньше.
 * В4.8.5 (К8.5.3): `ok.refreshError` — повторная загрузка не удалась, но
 * данные на экране остаются (мягкая пометка вместо замены экрана ошибкой).
 */
export type AsyncState<T> = { kind: "loading"; stale?: T } | { kind: "ok"; data: T; refreshError?: string } | { kind: "error"; message: string };

/**
 * Загрузка по URL с отменой устаревшего запроса и ручным повтором.
 * В4.7 круг 2 (Р2.6): `keepPrevious` — при смене URL прежние данные остаются
 * на экране (`loading.stale`), пока не придёт новый ответ: каркас страницы не
 * перерисовывается через скелетон и не прыгает. Первая загрузка — без `stale`.
 */
export function stateOnReload<T>(prev: AsyncState<T>, keepPrevious: boolean): AsyncState<T> {
  if (!keepPrevious) return { kind: "loading" };
  if (prev.kind === "ok") return { kind: "loading", stale: prev.data };
  if (prev.kind === "loading" && prev.stale !== undefined) return prev;
  return { kind: "loading" };
}

/**
 * В4.8.5 (К8.5.3): сбой загрузки. С `keepPrevious` и данными на экране —
 * «данные + ошибка» (экран не пропадает, опросы живы); без данных — ошибка.
 */
export function stateOnError<T>(prev: AsyncState<T>, message: string, keepPrevious: boolean): AsyncState<T> {
  const data = dataOf(prev);
  if (keepPrevious && data !== null) return { kind: "ok", data, refreshError: message };
  return { kind: "error", message };
}

/** Данные состояния: свежие или прежние (перечитывание с `keepPrevious`); нет — null. */
export function dataOf<T>(state: AsyncState<T>): T | null {
  if (state.kind === "ok") return state.data;
  if (state.kind === "loading" && state.stale !== undefined) return state.stale;
  return null;
}

export function useJson<T>(url: string, opts: { keepPrevious?: boolean } = {}): { state: AsyncState<T>; reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const keepPrevious = opts.keepPrevious === true;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((prev) => stateOnReload(prev, keepPrevious));
    fetchJson<T>(url, ctrl.signal)
      .then((data) => setState({ kind: "ok", data }))
      .catch((e: unknown) => {
        // отмена — это не ошибка показа: пришёл более свежий запрос
        if (ctrl.signal.aborted) return;
        setState((prev) => stateOnError(prev, e instanceof Error ? e.message : String(e), keepPrevious));
      });
    return () => ctrl.abort();
  }, [url, attempt, keepPrevious]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // К8.5.7: точечная правка данных без перечитывания (строка после действия)
  const set = useCallback((data: T) => setState({ kind: "ok", data }), []);
  return { state, reload, set };
}

/** Вкладка видна пользователю (скрытая — опросы на паузе). */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Последнее значение в ref — для колбэков таймеров без пересоздания эффекта. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
