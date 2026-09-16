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
  hasPat: boolean;
  patCheckedAt: string | null;
}

export interface MyReposResponse {
  username: string;
  entries: MyRepoEntry[];
}

export interface ScanSettings {
  useDefaults: boolean;
  maxBytes: number | null;
  timeoutMs: number | null;
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

export type AsyncState<T> = { kind: "loading" } | { kind: "ok"; data: T } | { kind: "error"; message: string };

/** Загрузка по URL с отменой устаревшего запроса и ручным повтором. */
export function useJson<T>(url: string): { state: AsyncState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetchJson<T>(url, ctrl.signal)
      .then((data) => setState({ kind: "ok", data }))
      .catch((e: unknown) => {
        // отмена — это не ошибка показа: пришёл более свежий запрос
        if (ctrl.signal.aborted) return;
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [url, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
