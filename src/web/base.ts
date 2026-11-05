// base.ts — путь сервиса под общим доменом и режим демо.
//
// Сервер, запущенный с BASE_PATH (например `/healthcraft`) или DEMO_MODE, кладет в
// <head> метки `hc-base` и `hc-demo` (src/frontend-build.ts). Интерфейс везде
// оперирует путями от корня сервиса (`/repo/org/repo`, `/api/meta`), а префикс
// добавляется здесь, в одном месте: fetch, история браузера, window.open и
// атрибуты href/src ссылок и картинок. Без метки (обычный запуск) ничего не меняется.

function metaContent(name: string): string {
  if (typeof document === "undefined") return "";
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
}

/** Путь сервиса без завершающего «/»; "" – сервис в корне домена. */
export const BASE = metaContent("hc-base").replace(/\/+$/, "");

/** Демо: только просмотр, без входа и личных разделов. */
export const DEMO = metaContent("hc-demo") === "1";

/** Путь от корня сервиса → путь от корня домена. Внешние и уже префиксованные адреса – как есть. */
export function withBase(url: string): string {
  if (BASE === "" || !url.startsWith("/") || url.startsWith("//")) return url;
  if (url === BASE || url.startsWith(`${BASE}/`) || url.startsWith(`${BASE}?`)) return url;
  return `${BASE}${url}`;
}

/** Путь из адресной строки → путь от корня сервиса. */
export function stripBase(pathname: string): string {
  if (BASE === "") return pathname;
  if (pathname === BASE) return "/";
  return pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : pathname;
}

/** Текущий путь от корня сервиса. */
export function currentPath(): string {
  return stripBase(window.location.pathname);
}

const LINK_ATTRS: Record<string, string> = { A: "href", IMG: "src", LINK: "href", SOURCE: "src" };

function fixElement(el: Element): void {
  const attr = LINK_ATTRS[el.tagName];
  if (attr === undefined) return;
  const value = el.getAttribute(attr);
  if (value === null) return;
  const fixed = withBase(value);
  if (fixed !== value) el.setAttribute(attr, fixed);
}

function fixTree(root: Element): void {
  fixElement(root);
  for (const el of root.querySelectorAll("a[href^='/'], img[src^='/'], link[href^='/'], source[src^='/']")) fixElement(el);
}

/** Подменить адресные API браузера под путь сервиса. Вызывается один раз до отрисовки. */
export function installBasePath(): void {
  if (BASE === "") return;
  const fetchOrig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchOrig(typeof input === "string" ? withBase(input) : input, init)) as typeof window.fetch;
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) =>
    push(data, unused, typeof url === "string" ? withBase(url) : url);
  window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) =>
    replace(data, unused, typeof url === "string" ? withBase(url) : url);
  const open = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => open(typeof url === "string" ? withBase(url) : url, target, features);
  // ссылки и картинки рисуют React и компоненты Gravity UI: адрес правится в DOM
  // после вставки или смены атрибута
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") fixElement(r.target as Element);
      else for (const node of r.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) fixTree(node as Element);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "src"] });
}
