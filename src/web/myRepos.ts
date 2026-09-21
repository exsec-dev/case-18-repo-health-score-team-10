// myRepos.ts — данные списка «Мои репозитории» (В4.8): полосы шкалы для
// плиток сводки, поиск и сортировка. Чистые функции без React: числа на
// плитках и порядок строк закрываются поведенческим тестом на данных
// (tests/v48-me.test.ts), а не чтением исходника (правило 21.09, AGENTS.md).
import type { MyReposResponse } from "./api";
import { fmtDate, scoreTheme, slugOf } from "./format";

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

/**
 * История «Заданий» лентой по дням (исследование панели, выбор 4c, 21.09):
 * группы и строки — по времени от новых к старым (ревью закрытия: сервер
 * сортирует по id, а `claimed_at` перезаписывается при повторном захвате
 * по истекшей аренде — порядок id и времени может расходиться),
 * заголовок — «Сегодня», «Вчера» или дата (`fmtDate`), у
 * строки — время `HH:mm`. Время — `claimedAt` (взято в работу; времени
 * завершения API не отдает). Задание без времени (отклоненное предпроверкой
 * в работу не бралось) и с нечитаемой датой — в последней группе без
 * времени, а не в «сегодня»: неизвестное не выдается за свежее.
 */
export interface JobDayGroup<T> {
  label: string;
  rows: { job: T; time: string | null }[];
}

export const NO_TIME_GROUP = "Без времени";

export function groupJobsByDay<T extends { claimedAt: string | null }>(jobs: T[], now: Date = new Date()): JobDayGroup<T>[] {
  const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: JobDayGroup<T>[] = [];
  const byKey = new Map<string, JobDayGroup<T>>();
  const untimed: JobDayGroup<T> = { label: NO_TIME_GROUP, rows: [] };
  const timed: { job: T; d: Date }[] = [];
  for (const job of jobs) {
    const d = job.claimedAt ? new Date(job.claimedAt) : null;
    if (!d || Number.isNaN(d.getTime())) untimed.rows.push({ job, time: null });
    else timed.push({ job, d });
  }
  timed.sort((x, y) => y.d.getTime() - x.d.getTime());
  for (const { job, d } of timed) {
    const key = dayKey(d);
    let group = byKey.get(key);
    if (!group) {
      group = { label: key === today ? "Сегодня" : key === yesterday ? "Вчера" : fmtDate(job.claimedAt), rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push({ job, time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` });
  }
  if (untimed.rows.length > 0) groups.push(untimed);
  return groups;
}
