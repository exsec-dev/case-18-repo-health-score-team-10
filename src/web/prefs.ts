// prefs.ts — пользовательские настройки вида, которые живут в браузере:
// тема и узкий/широкий rail. Удобство одного зрителя, не данные,
// поэтому localStorage; любой сбой хранилища (приватное окно, блок
// cookies) молча откатывает к умолчанию, а не роняет приложение.
import { useSyncExternalStore } from "react";

export type AppTheme = "light" | "dark" | "system";

const THEME_KEY = "rh:theme";
const RAIL_KEY = "rh:rail-compact";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно — настройка живёт до перезагрузки */
  }
}

/** Мини-стор: одно значение, подписчики, снимок — для useSyncExternalStore. */
function createPref<T extends string>(key: string, parse: (raw: string | null) => T) {
  let value = parse(read(key));
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      write(key, next);
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const themePref = createPref<AppTheme>(THEME_KEY, (raw) => (raw === "light" || raw === "dark" ? raw : "system"));
const railPref = createPref<"0" | "1">(RAIL_KEY, (raw) => (raw === "1" ? "1" : "0"));

/** Тема до первого переключения — системная; переключатель фиксирует явную. */
export function useAppTheme(): [AppTheme, (next: AppTheme) => void] {
  const theme = useSyncExternalStore(themePref.subscribe, themePref.get, () => "system" as AppTheme);
  return [theme, themePref.set];
}

/** Узкий rail (только иконки); по умолчанию развёрнут — разделы с подписями. */
export function useRailCompact(): [boolean, (next: boolean) => void] {
  const raw = useSyncExternalStore(railPref.subscribe, railPref.get, () => "0" as const);
  return [raw === "1", (next) => railPref.set(next ? "1" : "0")];
}

/** Медиа-запрос как состояние: раскладка меняется при повороте/ресайзе. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
