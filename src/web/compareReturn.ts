// compareReturn.ts — последний набор сравнения во вкладке.
//
// Источник набора — адрес `/compare?r=…`; здесь только подстановка последнего
// набора, когда пункт rail открывает раздел без параметров.
// sessionStorage, а не localStorage: слаги закрытых репозиториев не должны
// переживать сессию на общем компьютере. Хранилище бывает недоступно
// (приватный режим, запрет сайта) — тогда раздел просто открывается пустым.
import { compareSlugsOf } from "./compareView";

const KEY = "rh:lastCompare";

export function rememberCompareSet(slugs: string[]): void {
  try {
    sessionStorage.setItem(KEY, slugs.join("\n"));
  } catch {
    /* без хранилища набор не восстанавливается */
  }
}

export function forgetCompareSet(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* нечего забывать */
  }
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
