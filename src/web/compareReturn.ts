// compareReturn.ts — последний набор сравнения во вкладке (В5.3 круг 4, Д2).
//
// Адрес `/compare?r=…` — единственный источник набора; здесь только
// подстановка последнего набора при клике по пункту rail без параметров.
// Хранилище сессии, не localStorage: закрытые слаги не переживают сессию на
// общем компьютере. Хранилище бывает недоступно (приватный режим, запрет
// сайта) — каждое обращение в try/catch, без него раздел открывается пустым.
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
