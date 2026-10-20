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

const RATING_HIDDEN_KEY = "rh:rating-hidden-columns";

/**
 * Скрытые колонки рейтинга переживают перезагрузку и возврат.
 * Хранится JSON-массив id; битое или неизвестное значение —
 * умолчание страницы; id колонки, которой больше нет, просто ни на что не влияет.
 */
export function readRatingHidden(fallback: string[]): string[] {
  const raw = read(RATING_HIDDEN_KEY);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return fallback;
    return parsed as string[];
  } catch {
    return fallback;
  }
}

export function writeRatingHidden(hidden: string[]): void {
  write(RATING_HIDDEN_KEY, JSON.stringify(hidden));
}

/** Медиа-запрос как состояние: раскладка меняется при повороте/ресайзе. */
/** Прокрутка по ссылкам и кнопкам — без плавности при «уменьшить движение» в системе. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

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

const COLLAPSED_ORGS_KEY = "rh:my-repos-collapsed-orgs";

/** Свернутые организации «Моих репозиториев» — JSON-массив имен; битое значение — все развернуты. */
export function readCollapsedOrgs(): string[] {
  const raw = read(COLLAPSED_ORGS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function writeCollapsedOrgs(orgs: string[]): void {
  write(COLLAPSED_ORGS_KEY, JSON.stringify(orgs));
}
