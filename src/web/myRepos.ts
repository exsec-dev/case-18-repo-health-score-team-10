// myRepos.ts — данные списка «Мои репозитории»: полосы шкалы для плиток
// сводки, поиск и сортировка. Чистые функции без React, чтобы числа на
// плитках и порядок строк проверялись тестом на данных.
import type { MyReposResponse } from "./api";
import { fmtDate, scoreTheme, slugOf } from "./format";
import { plural } from "../report/submetrics";

export type RepoEntry = MyReposResponse["entries"][number];

/** Имена — с числами по значению: repo-2 раньше repo-10. */
const NAME_ORDER: Intl.CollatorOptions = { numeric: true };

/**
 * Полоса шкалы строки — те же пороги, что у рейтинга и карточки
 * (`scoreTheme`, по показанному округленному числу). `none` — оценки нет:
 * отдельная группа, а не «плохо» (tri-state).
 */
export type Band = "success" | "warning" | "danger" | "none";

export function bandOf(entry: Pick<RepoEntry, "healthcraftIndex"> & { codeEmpty?: boolean }): Band {
  // нет кода: 0 по правилу методики — «оценивать нечего», а не зона риска (как «нет кода» в рейтинге)
  if (entry.codeEmpty === true) return "none";
  const theme = scoreTheme(entry.healthcraftIndex);
  return theme === "misc" ? "none" : theme;
}

export const BANDS: { key: Band; title: string; hint: string }[] = [
  { key: "success", title: "Здоровы", hint: "HealthCraft Index 70-100" },
  { key: "warning", title: "Требуют внимания", hint: "HealthCraft Index 40-69" },
  { key: "danger", title: "В зоне риска", hint: "HealthCraft Index 0-39" },
  { key: "none", title: "Без оценки", hint: "Анализ еще не проводился, идет, данных для оценки не хватило или в репозитории нет кода" },
];

/** Число строк в каждой полосе; сумма всегда равна длине списка. */
export function countBands(entries: (Pick<RepoEntry, "healthcraftIndex"> & { codeEmpty?: boolean })[]): Record<Band, number> {
  const counts: Record<Band, number> = { success: 0, warning: 0, danger: 0, none: 0 };
  for (const e of entries) counts[bandOf(e)] += 1;
  return counts;
}

/**
 * Поиск подстрокой без учета регистра по org, repo и названию; `band` —
 * выбранная плитка. Слаг сверяется в ОБЕИХ записях: `org/repo` (как в ссылке
 * и на экране) и `org / repo` (прежняя экранная форма — скопированное раньше
 * имя тоже находится).
 */
export function filterEntries<T extends Pick<RepoEntry, "org" | "repo" | "title" | "healthcraftIndex"> & { codeEmpty?: boolean }>(entries: T[], query: string, band: Band | null): T[] {
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

export type SortKey = "change" | "index" | "name" | "scan";

export const SORT_OPTIONS: { value: SortKey; content: string }[] = [
  { value: "change", content: "По изменению" },
  { value: "index", content: "По индексу" },
  { value: "name", content: "По названию" },
  { value: "scan", content: "По дате анализа" },
];

/** Направление по умолчанию — «естественное» для ключа: изменение, индекс и дата от больших, название по алфавиту. */
export const SORT_DEFAULT_DESC: Record<SortKey, boolean> = { change: true, index: true, name: false, scan: true };

/** Изменение индекса к предыдущей оценке — по показанным (округленным) числам; null — сравнивать не с чем. */
export function scoreChange(e: Pick<RepoEntry, "healthcraftIndex"> & { previousIndex?: number | null }): number | null {
  if (e.healthcraftIndex === null || e.previousIndex == null) return null;
  return Math.round(e.healthcraftIndex) - Math.round(e.previousIndex);
}

/**
 * Порядок строк. Пустое значение (нет оценки, не было анализа) ВСЕГДА в конце,
 * в обе стороны: «нет данных» не лучше и не хуже числа (tri-state), и переворот
 * направления не должен поднимать его наверх. Сортировка устойчивая: равные
 * остаются в порядке ответа сервера.
 */
export function sortEntries<T extends Pick<RepoEntry, "org" | "repo" | "healthcraftIndex" | "lastScanAt"> & { previousIndex?: number | null }>(entries: T[], key: SortKey, desc: boolean): T[] {
  const valueOf = (e: T): number | string | null => {
    if (key === "name") return slugOf(e.org, e.repo).toLowerCase();
    // «что изменилось» — по величине сдвига в любую сторону; без сравнения — в конце
    if (key === "change") {
      const d = scoreChange(e);
      return d === null ? null : Math.abs(d);
    }
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
    const cmp = typeof va === "string" ? va.localeCompare(vb as string, "ru", NAME_ORDER) : va - (vb as number);
    return desc ? -cmp : cmp;
  });
}

/**
 * История «Заданий» лентой по дням. Группы и строки идут по времени от новых
 * к старым, а не по id: `claimed_at` перезаписывается при повторном захвате
 * по истекшей аренде, и порядок id и времени может расходиться.
 * Заголовок — «Сегодня», «Вчера» или дата, у строки — время `HH:mm`.
 * Время — `claimedAt` (взято в работу; времени завершения API не отдает).
 * Задание без времени (отклоненное предпроверкой) и с нечитаемой датой — в
 * последней группе, а не в «сегодня»: неизвестное не выдается за свежее.
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

/** Закрытые (private, internal) — свои по правилу `isOwnRepo`, если токен их видит. */
export const isClosed = (visibility: string | null): boolean => visibility === "private" || visibility === "internal";

/** Организации: пространство владельца токена первым, остальные по алфавиту. */
export function orderOrgs(orgs: Iterable<string>, owner: string | null = null): string[] {
  const own = owner?.toLowerCase() ?? null;
  return [...new Set(orgs)].sort((a, b) => Number(b.toLowerCase() === own) - Number(a.toLowerCase() === own) || a.localeCompare(b, "ru", NAME_ORDER));
}

/**
 * Список SourceCraft по организациям (своя первой, остальные по алфавиту). Внутри
 * — закрытые первыми, затем по имени; `within` задает свой порядок строк группы.
 */
export function groupByOrg<T extends { org: string; visibility: string | null }>(
  repos: readonly T[],
  nameOf: (r: T) => string,
  opts: { owner?: string | null; within?: (a: T, b: T) => number } = {},
): { org: string; items: T[] }[] {
  const byName = (a: T, b: T) => Number(isClosed(b.visibility)) - Number(isClosed(a.visibility)) || nameOf(a).localeCompare(nameOf(b), "ru", NAME_ORDER);
  return orderOrgs(
    repos.map((r) => r.org),
    opts.owner,
  ).map((org) => ({ org, items: repos.filter((r) => r.org === org).sort(opts.within ?? byName) }));
}

// ---------- «Мои репозитории»: фильтры и сортировка ----------

/** Состояние строки описи: зона оценки или что с анализом. */
export type TokenState = "success" | "warning" | "danger" | "nocode" | "unscored" | "never" | "failed" | "empty";

export const TOKEN_STATES: { key: TokenState; title: string }[] = [
  { key: "success", title: "Здоровы" },
  { key: "warning", title: "Требуют внимания" },
  { key: "danger", title: "В зоне риска" },
  { key: "nocode", title: "Нет кода" },
  { key: "unscored", title: "Оценки нет" },
  { key: "never", title: "Еще не анализировали" },
  { key: "failed", title: "Ошибка анализа" },
  { key: "empty", title: "Нет коммитов" },
];

export interface TokenRow {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  visibility: string | null;
  isEmpty: boolean;
  healthcraftIndex: number | null;
  /** оценка 0 у репо без кода — не зона риска */
  codeEmpty?: boolean;
  lastScanAt: string | null;
  lastScanStatus: string | null;
}

export function tokenStateOf(e: TokenRow): TokenState {
  if (e.healthcraftIndex !== null && e.codeEmpty !== true) return bandOf(e) as TokenState;
  if (e.isEmpty) return "empty";
  if (e.healthcraftIndex !== null) return "nocode";
  if (e.lastScanStatus === "bad") return "failed";
  return e.lastScanAt !== null ? "unscored" : "never";
}

/** Сводка группы организации для ее шапки: сколько оценено, закрыто и в каждой зоне. */
export interface OrgSummary {
  scored: number;
  closed: number;
  zones: Record<ZoneBand, number>;
}

type ZoneBand = Exclude<Band, "none">;

export function orgSummaryOf(items: readonly TokenRow[]): OrgSummary {
  const zones: Record<ZoneBand, number> = { success: 0, warning: 0, danger: 0 };
  let closed = 0;
  let scored = 0;
  for (const e of items) {
    if (isClosed(e.visibility)) closed++;
    // репо без кода оценен (0 по правилу), но ни в одну зону не входит
    if (e.healthcraftIndex !== null) scored++;
    const band = bandOf(e);
    if (band !== "none") zones[band]++;
  }
  return { scored, closed, zones };
}

/**
 * Строка под названием организации: слаг (если название с ним не совпадает),
 * сколько оценено и сколько закрытых. Разделитель — запятая: «·» в UI запрещен.
 */
export function orgMetaText(org: string, displayName: string | undefined, s: OrgSummary): string {
  const counts = [
    s.scored > 0 ? `оценено: ${s.scored}` : "еще не оценивались",
    ...(s.closed > 0 ? [`${s.closed} ${plural(s.closed, "закрытый", "закрытых", "закрытых")}`] : []),
  ].join(", ");
  // слаг пишется как есть; с прописной — только строка, начатая словами
  return displayName && displayName !== org ? `${org}, ${counts}` : counts.charAt(0).toUpperCase() + counts.slice(1);
}

export type TokenSort = "name" | "never" | "index" | "scan";

export const TOKEN_SORTS: { value: TokenSort; content: string }[] = [
  { value: "name", content: "По названию" },
  { value: "never", content: "Сначала без анализа" },
  { value: "index", content: "По индексу" },
  { value: "scan", content: "По дате анализа" },
];

/** Фильтры описи: мультивыбор организаций, состояний и языков (пустой список — все); видимость — одна из трех. */
export interface TokenFilter {
  q: string;
  orgs: string[];
  vis: "all" | "closed" | "public";
  states: TokenState[];
  /** языки; пустая строка — «не определен» */
  langs: string[];
}

export const TOKEN_FILTER_DEFAULT: TokenFilter = { q: "", orgs: [], vis: "all", states: [], langs: [] };

/** Поиск — по организации, имени и названию; остальные фильтры — точным совпадением с любым из выбранных. */
export function filterTokenRows<T extends TokenRow>(rows: readonly T[], f: TokenFilter): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (e) =>
      (q === "" || `${e.org}/${e.repo}`.toLowerCase().includes(q) || (e.title ?? "").toLowerCase().includes(q)) &&
      (f.orgs.length === 0 || f.orgs.includes(e.org)) &&
      (f.vis === "all" || (f.vis === "closed") === isClosed(e.visibility)) &&
      (f.states.length === 0 || f.states.includes(tokenStateOf(e))) &&
      (f.langs.length === 0 || f.langs.includes(e.language ?? "")),
  );
}

/** Порядок строк внутри организации: пустые значения — всегда в конце. */
export function tokenRowOrder<T extends TokenRow>(sort: TokenSort): (a: T, b: T) => number {
  const name = (a: T, b: T) => a.repo.localeCompare(b.repo, "ru", NAME_ORDER);
  if (sort === "never") return (a, b) => Number(tokenStateOf(b) === "never") - Number(tokenStateOf(a) === "never") || name(a, b);
  if (sort === "index") return (a, b) => (b.healthcraftIndex ?? -1) - (a.healthcraftIndex ?? -1) || name(a, b);
  if (sort === "scan") {
    const t = (e: T) => (e.lastScanAt ? Date.parse(e.lastScanAt) || 0 : 0);
    return (a, b) => t(b) - t(a) || name(a, b);
  }
  return (a, b) => Number(isClosed(b.visibility)) - Number(isClosed(a.visibility)) || name(a, b);
}

/** Фильтры описи в адресе (`?org=a&org=b&vis=&state=&lang=&sort=&q=`) — переживают переход в карточку и назад. */
export function tokenParamsOf(search: string): { filter: TokenFilter; sort: TokenSort } {
  const p = new URLSearchParams(search);
  const vis = p.get("vis");
  const sort = p.get("sort");
  const known = new Set<string>(TOKEN_STATES.map((s) => s.key));
  return {
    filter: {
      q: p.get("q") ?? "",
      orgs: p.getAll("org").filter((o) => o !== ""),
      vis: vis === "closed" || vis === "public" ? vis : "all",
      states: p.getAll("state").filter((s): s is TokenState => known.has(s)),
      langs: p.getAll("lang"),
    },
    sort: TOKEN_SORTS.some((s) => s.value === sort) ? (sort as TokenSort) : "name",
  };
}

export function tokenSearchOf(f: TokenFilter, sort: TokenSort): string {
  const p = new URLSearchParams();
  if (f.q.trim() !== "") p.set("q", f.q);
  for (const o of f.orgs) p.append("org", o);
  if (f.vis !== "all") p.set("vis", f.vis);
  for (const s of f.states) p.append("state", s);
  for (const l of f.langs) p.append("lang", l);
  if (sort !== "name") p.set("sort", sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Подпись мультивыбора в поле: до двух значений по имени, остальные — «+N». */
export function multiSummary(titles: string[]): string {
  if (titles.length <= 2) return titles.join(", ");
  return `${titles.slice(0, 2).join(", ")} +${titles.length - 2}`;
}
