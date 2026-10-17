// router.ts — мини-роутер на History API. Свой, а не react-router: экранов
// мало, а зависимость тянула бы контекст, матчер и Outlet ради одного switch.
// Состояние фильтров рейтинга живёт в query-строке, поэтому «маршрут» —
// это pathname + search целиком: ссылкой можно поделиться.
import { useSyncExternalStore, type MouseEvent } from "react";

export type Route =
  | { kind: "rating"; search: string }
  | { kind: "repo"; org: string; repo: string }
  | { kind: "me" }
  // «Мои репозитории» — живой список SourceCraft по токену
  | { kind: "repos" }
  | { kind: "settings" }
  // набор сравнения — в query (`?r=org/a&r=org/b`), ссылкой можно поделиться
  | { kind: "compare"; search: string }
  // страница документации: `method/scores`; начало раздела – пустая строка
  | { kind: "docs"; slug: string }
  | { kind: "not-found" };

/** Событие своей навигации: popstate браузер шлёт только на назад/вперёд. */
const NAV_EVENT = "rh:navigate";

export function parseRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts.length === 0) return { kind: "rating", search };
  if (parts[0] === "me" && parts.length === 1) return { kind: "me" };
  if (parts[0] === "repos" && parts.length === 1) return { kind: "repos" };
  if (parts[0] === "settings" && parts.length === 1) return { kind: "settings" };
  if (parts[0] === "compare" && parts.length === 1) return { kind: "compare", search };
  if (parts[0] === "docs") return { kind: "docs", slug: parts.slice(1).map(safeDecode).join("/") };
  if (parts[0] === "repo" && parts.length === 3) {
    return { kind: "repo", org: safeDecode(parts[1]!), repo: safeDecode(parts[2]!) };
  }
  return { kind: "not-found" };
}

/** Кривой percent-encoding в адресной строке не должен ронять приложение. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function navigate(url: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Адрес входа: с карточки репозитория — с возвратом на нее (`next`), с прочих
 * экранов — в кабинет. Сервер пропускает только путь своего сайта (`safeNextPath`).
 */
export function loginHref(pathname: string, search: string): string {
  return pathname.startsWith("/repo/") ? `/auth/ya?next=${encodeURIComponent(pathname + search)}` : "/auth/ya";
}

export function repoHref(org: string, repo: string): string {
  return `/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
}

/** Пропсы ссылки: обычный href (Ctrl+click и «открыть в новой вкладке» работают). */
export function linkProps(url: string): { href: string; onClick: (e: MouseEvent) => void } {
  return {
    href: url,
    onClick: (e: MouseEvent) => {
      // модификаторы и не-левая кнопка — пусть браузер делает своё
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      navigate(url);
    },
  };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const snapshot = (): string => `${window.location.pathname}${window.location.search}`;

/**
 * Один параметр query как состояние — для таба карточки (`?tab=recommendations`).
 * Ветка `repo` в `Route` без `search`: нужен ровно один параметр и та же
 * подписка, что у маршрута (popstate + своё событие навигации), чтобы
 * «назад» переключал таб.
 */
export function useQueryParam(name: string): string | null {
  // снимок — строка, не объект: useSyncExternalStore сравнивает по ссылке
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  return new URLSearchParams(search).get(name);
}

export function useRoute(): Route {
  // строка-снимок, а не объект: useSyncExternalStore сравнивает ссылку,
  // новый объект на каждый вызов дал бы бесконечный ре-рендер
  const href = useSyncExternalStore(subscribe, snapshot, () => "/");
  const qIndex = href.indexOf("?");
  return qIndex === -1 ? parseRoute(href, "") : parseRoute(href.slice(0, qIndex), href.slice(qIndex + 1));
}
