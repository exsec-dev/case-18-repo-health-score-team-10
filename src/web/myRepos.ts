// myRepos.ts — данные списка «Мои репозитории» (В4.8): полосы шкалы для
// плиток сводки, поиск и сортировка. Чистые функции без React: числа на
// плитках и порядок строк закрываются поведенческим тестом на данных
// (tests/v48-me.test.ts), а не чтением исходника (правило 21.09, AGENTS.md).
import type { MyReposResponse } from "./api";
import { scoreTheme, slugOf } from "./format";

export type RepoEntry = MyReposResponse["entries"][number];

/**
 * Полоса шкалы строки — те же пороги, что у рейтинга и карточки
 * (`scoreTheme`, по показанному округленному числу). `none` — оценки нет:
 * отдельная группа, а не «плохо» (tri-state, закон 2).
 */
export type Band = "success" | "warning" | "danger" | "none";

export function bandOf(entry: Pick<RepoEntry, "healthcraftIndex">): Band {
  const theme = scoreTheme(entry.healthcraftIndex);
  return theme === "misc" ? "none" : theme;
}

export const BANDS: { key: Band; title: string; hint: string }[] = [
  { key: "success", title: "Здоровы", hint: "HealthCraft Index 70-100" },
  { key: "warning", title: "Требуют внимания", hint: "HealthCraft Index 40-69" },
  { key: "danger", title: "В зоне риска", hint: "HealthCraft Index 0-39" },
  { key: "none", title: "Без оценки", hint: "Анализ еще не проводился, идет или данных для оценки не хватило" },
];

/** Число строк в каждой полосе; сумма всегда равна длине списка. */
export function countBands(entries: Pick<RepoEntry, "healthcraftIndex">[]): Record<Band, number> {
  const counts: Record<Band, number> = { success: 0, warning: 0, danger: 0, none: 0 };
  for (const e of entries) counts[bandOf(e)] += 1;
  return counts;
}

/**
 * Поиск подстрокой без учета регистра по org, repo и названию; `band` —
 * выбранная плитка. Слаг сверяется в ОБЕИХ записях: `org/repo` (как в ссылке)
 * и `org / repo` (как его рисует `RepoSlug` на экране) — скопированное со
 * страницы имя обязано находиться.
 */
export function filterEntries<T extends Pick<RepoEntry, "org" | "repo" | "title" | "healthcraftIndex">>(entries: T[], query: string, band: Band | null): T[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (band === null || bandOf(e) === band) &&
      (q === "" ||
        slugOf(e.org, e.repo).toLowerCase().includes(q) ||
        `${e.org} / ${e.repo}`.toLowerCase().includes(q) ||
        (e.title ?? "").toLowerCase().includes(q)),
  );
}

export type SortKey = "index" | "name" | "scan";

export const SORT_OPTIONS: { value: SortKey; content: string }[] = [
  { value: "index", content: "По индексу" },
  { value: "name", content: "По названию" },
  { value: "scan", content: "По дате анализа" },
];

/** Направление по умолчанию — «естественное» для ключа: индекс и дата от больших, название по алфавиту. */
export const SORT_DEFAULT_DESC: Record<SortKey, boolean> = { index: true, name: false, scan: true };

/**
 * Порядок строк. Пустое значение (нет оценки, не было анализа) ВСЕГДА в конце,
 * в обе стороны: «нет данных» не лучше и не хуже числа (закон 2), и переворот
 * направления не должен поднимать его наверх. Сортировка устойчивая: равные
 * остаются в порядке ответа сервера.
 */
export function sortEntries<T extends Pick<RepoEntry, "org" | "repo" | "healthcraftIndex" | "lastScanAt">>(entries: T[], key: SortKey, desc: boolean): T[] {
  const valueOf = (e: T): number | string | null => {
    if (key === "name") return slugOf(e.org, e.repo).toLowerCase();
    // нечитаемая дата — тоже «нет значения», а не NaN, ломающий сравнение
    const v = key === "index" ? e.healthcraftIndex : e.lastScanAt ? Date.parse(e.lastScanAt) : null;
    return v === null || Number.isNaN(v) ? null : v;
  };
  return [...entries].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb as string, "ru") : va - (vb as number);
    return desc ? -cmp : cmp;
  });
}
