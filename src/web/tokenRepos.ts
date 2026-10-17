// Репозитории, доступные токену зрителя (`/api/me/sourcecraft-repos`, кэш сервера
// 10 минут), – подсказка интерфейсу, где показать запуск анализа. Решает сервер
// при запуске: анализ по кнопке доступен своему репозиторию и любому
// репозиторию из этого списка (публичные – с ограничением частоты), кроме пустого.
import { useCallback, useEffect, useState } from "react";
import type { ScRepoLite } from "../api/me";
import { fetchJson } from "./api";

/** Ключ репозитория: слаг точно в том виде, как его отдает SourceCraft, – так его сверяет и сервер. */
export const repoKey = (org: string, repo: string): string => `${org}/${repo}`;

/**
 * Список по токену, ключ – `repoKey`. `repos` null – список не нужен (`enabled`
 * false) или еще грузится; сбой (нет токена, SourceCraft не ответил) – пустой
 * список: запуск не обещаем. `recheck` перечитывает список из SourceCraft мимо
 * кэша сервера (например, в репозиторий только что пришли первые коммиты); пока
 * он идет, `checking` true, а `repos` – прежний список: экран не мигает.
 */
export function useTokenRepos(enabled: boolean): { repos: ReadonlyMap<string, ScRepoLite> | null; recheck: () => void; checking: boolean } {
  const [repos, setRepos] = useState<ReadonlyMap<string, ScRepoLite> | null>(null);
  const [checking, setChecking] = useState(false);
  // > 0 – перечитать из SourceCraft (`refresh=1`)
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setRepos(null);
      return;
    }
    if (nonce === 0) setRepos(null);
    else setChecking(true);
    const ctrl = new AbortController();
    // данные каталога не нужны – `entries=0` их не собирает
    fetchJson<{ repos: ScRepoLite[] }>(`/api/me/sourcecraft-repos?entries=0${nonce > 0 ? `&refresh=1&n=${nonce}` : ""}`, ctrl.signal)
      .then((d) => setRepos(new Map(d.repos.map((r) => [repoKey(r.org, r.slug), r]))))
      .catch(() => {
        // при перепроверке сбой оставляет прежний список
        if (!ctrl.signal.aborted && nonce === 0) setRepos(new Map());
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setChecking(false);
      });
    return () => ctrl.abort();
  }, [enabled, nonce]);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { repos, recheck, checking };
}
