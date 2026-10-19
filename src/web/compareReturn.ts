// compareReturn.ts — последний набор сравнения во вкладке.
//
// Источник набора — адрес `/compare?r=…`; здесь только подстановка последнего
// набора, когда пункт rail открывает раздел без параметров.
// sessionStorage, а не localStorage: слаги закрытых репозиториев не должны
// переживать сессию на общем компьютере. Хранилище бывает недоступно
// (приватный режим, запрет сайта) — тогда раздел просто открывается пустым.
import { compareSlugsOf } from "./compareView";

const KEY = "rh:lastCompare";

/**
 * Набор изменился в этой вкладке – счетчик у пункта rail перечитывает его.
 * Событие `storage` в той же вкладке не приходит, поэтому свое.
 */
export const COMPARE_SET_EVENT = "rh:compare-set";

function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COMPARE_SET_EVENT));
}

export function rememberCompareSet(slugs: string[]): void {
  try {
    sessionStorage.setItem(KEY, slugs.join("\n"));
  } catch {
    /* без хранилища набор не восстанавливается */
  }
  announce();
}

export function forgetCompareSet(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* нечего забывать */
  }
  announce();
}

/** Последний набор вкладки; мусор в хранилище отбрасывается тем же разбором, что адрес. */
export function lastCompareSet(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const params = new URLSearchParams();
    for (const s of raw.split("\n")) params.append("r", s);
    return compareSlugsOf(params.toString());
  } catch {
    return [];
  }
}
