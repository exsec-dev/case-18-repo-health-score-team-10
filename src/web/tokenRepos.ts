// Репозитории, доступные токену зрителя (`/api/me/sourcecraft-repos`, кэш сервера
// 10 минут), – подсказка интерфейсу, где показать запуск анализа. Решает сервер
// при запуске: анализ по кнопке доступен своему репозиторию и любому
// репозиторию из этого списка (публичные – с ограничением частоты).
import { useEffect, useState } from "react";
import type { ScRepoLite } from "../api/me";
import { fetchJson } from "./api";

/** Ключ репозитория: слаг точно в том виде, как его отдает SourceCraft, – так его сверяет и сервер. */
export const repoKey = (org: string, repo: string): string => `${org}/${repo}`;

/**
 * Список по токену, ключ – `repoKey`. null – список не нужен (`enabled` false)
 * или еще грузится; сбой (нет токена, SourceCraft не ответил) – пустой список:
 * запуск не обещаем.
 */
export function useTokenRepos(enabled: boolean): ReadonlyMap<string, ScRepoLite> | null {
  const [repos, setRepos] = useState<ReadonlyMap<string, ScRepoLite> | null>(null);
  useEffect(() => {
    setRepos(null);
    if (!enabled) return;
    const ctrl = new AbortController();
    // данные каталога не нужны – `entries=0` их не собирает
    fetchJson<{ repos: ScRepoLite[] }>("/api/me/sourcecraft-repos?entries=0", ctrl.signal)
      .then((d) => setRepos(new Map(d.repos.map((r) => [repoKey(r.org, r.slug), r]))))
      .catch(() => {
        if (!ctrl.signal.aborted) setRepos(new Map());
      });
    return () => ctrl.abort();
  }, [enabled]);
  return repos;
}
