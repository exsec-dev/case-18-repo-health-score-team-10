// api.ts — тонкий слой доступа к read-API. Типы берутся из серверного
// модуля import type'ом: одна форма данных на обе стороны, при этом в
// бандл фронтенда не утекает ни строчки серверного кода (типы стираются).
import { useCallback, useEffect, useState } from "react";
import type { ApiError, MetaResponse, RatingResponse, RepoCard } from "../api/repos";
import type { MyRepoEntry } from "../api/me";

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

/** Выход: сервер отзывает сессию; дальше — полная перезагрузка на рейтинг (сбрасывает всё, что знала страница о зрителе). */
export async function logout(): Promise<void> {
  const res = await fetch("/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`сервер ответил HTTP ${res.status}`);
  window.location.assign("/");
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    // сервер отвечает ошибкой в контракте {error:{code,message}} — показываем
    // именно её текст, а не безликое «HTTP 400»
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Мутации me-поверхности: PUT/DELETE/POST с телом и текстом ошибки сервера. */
export async function mutateJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & ApiError) | null;
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/**
 * `stale` — данные прошлого успешного ответа, пока грузится новый (только с
 * опцией `keepPrevious`); без опции загрузка всегда «пустая», как раньше.
 */
export type AsyncState<T> = { kind: "loading"; stale?: T } | { kind: "ok"; data: T } | { kind: "error"; message: string };

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

export function useJson<T>(url: string, opts: { keepPrevious?: boolean } = {}): { state: AsyncState<T>; reload: () => void } {
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
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [url, attempt, keepPrevious]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
