// ratingParams.ts — приведение URL рейтинга к допустимому состоянию.
// Чистый модуль без React (его проверяют тесты).
//  - Неизвестные `sort`/`order`/`per_page`/`page` (старая или чужая ссылка)
//    заменяются дефолтом и адрес исправляется — иначе экран ошибки и
//    «Повторить», повторяющий тот же 400.
//  - Страница за пределами выдачи — последняя существующая.
//  - Первый клик по колонке «Репозиторий» сортирует А→Я, по числам — по убыванию.
// Сервер (`parseReposQuery`) по-прежнему отвечает 400 на неверное значение.
import type { SortKey } from "../api/repos";
import { CI_TITLES, CI_VALUES, SIZE_BUCKETS, SIZE_SHORT, SIZE_TITLES, type CiFilter, type SizeBucket } from "../api/rating-filters";
import { plural } from "../report/submetrics";
import { fmtCount } from "./format";

const SORTS: ReadonlySet<string> = new Set(["index", "likes", "activity", "coverage", "name"]);

const validInt = (raw: string, min: number, max: number): boolean => {
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isInteger(n) && n >= min && n <= max;
};

/** Привести query рейтинга к допустимому: неверные значения известных параметров убираются (= дефолт). */
export function normalizeRatingSearch(search: string): { search: string; changed: boolean } {
  const params = new URLSearchParams(search);
  let changed = false;
  const drop = (key: string) => {
    params.delete(key);
    changed = true;
  };
  const sort = params.get("sort");
  if (sort !== null && !SORTS.has(sort)) drop("sort");
  const order = params.get("order");
  if (order !== null && order !== "asc" && order !== "desc") drop("order");
  const perPage = params.get("per_page");
  if (perPage !== null && !validInt(perPage, 1, 100)) drop("per_page");
  const page = params.get("page");
  if (page !== null && !validInt(page, 1, Number.MAX_SAFE_INTEGER)) drop("page");
  // фильтр «С AI-обзором» — только `ai=1`
  const ai = params.get("ai");
  if (ai !== null && ai !== "1") drop("ai");
  // размер — повторяемый: неизвестные значения убираются, верные остаются
  const sizes = params.getAll("size");
  const validSizes = sizes.filter((v, i) => (SIZE_BUCKETS as readonly string[]).includes(v) && sizes.indexOf(v) === i);
  if (validSizes.length !== sizes.length) {
    drop("size");
    for (const v of validSizes) params.append("size", v);
  }
  // CI — одно значение `yes`/`no`; иное (и повтор) — сброс фильтра
  const cis = params.getAll("ci");
  if (cis.length > 1 || (cis.length === 1 && !(CI_VALUES as readonly string[]).includes(cis[0]!))) drop("ci");
  return { search: changed ? params.toString() : search.replace(/^\?/, ""), changed };
}

/** Страница за пределами выдачи → последняя существующая; иначе null (адрес верный). */
export function pageBeyond(data: { page: number; totalPages: number; total: number; items: unknown[] }): number | null {
  if (data.total > 0 && data.items.length === 0 && data.page > data.totalPages) return Math.max(1, data.totalPages);
  return null;
}

/** Направление первого клика по колонке: имя — А→Я, числа и даты — по убыванию. */
export function firstSortOrder(key: SortKey): "asc" | "desc" {
  return key === "name" ? "asc" : "desc";
}

/**
 * Охват каталога одной строкой. Число неоцененных называется явно — иначе
 * «Без оценки 0» рядом читается ошибкой счета: в «Без оценки» стоят
 * проанализированные без оценки, а эти еще не оценены вовсе.
 */
export function coverageLine(repos: { scored: number; nullScore: number; catalog: number }): string {
  const rest = Math.max(0, repos.catalog - repos.scored - repos.nullScore);
  const head = `Оценено ${fmtCount(repos.scored)} из ${fmtCount(repos.catalog)} ${plural(repos.catalog, "репозитория", "репозиториев", "репозиториев")}.`;
  return rest > 0 ? `${head} Еще ${fmtCount(rest)} пока не ${plural(rest, "оценен", "оценены", "оценены")}.` : head;
}

/**
 * Какие фильтры выдачи включены — названия для пустого состояния «Под фильтр
 * ничего не подошло». Пусто — фильтров нет, и пустая выдача значит «рейтинг
 * еще пуст». Чистая функция адреса, чтобы пустое состояние проверялось тестом.
 */
export function activeRatingFilters(search: string): string[] {
  const params = new URLSearchParams(search);
  const active: string[] = [];
  if ((params.get("q") ?? "") !== "") active.push("поиск");
  if (params.has("lang")) active.push("язык");
  if (params.has("size")) active.push("размер");
  if (params.has("ci")) active.push("CI");
  if (params.get("ai") === "1") active.push("AI-обзор");
  return active;
}

/** Текст пустой выдачи при фильтрах: называет включенные фильтры. */
export function nothingFoundDescription(active: string[]): string {
  const head = active.length === 1 ? "с фильтром" : "с фильтрами";
  return `Ни один репозиторий выборки не совпал ${head}: ${active.join(", ")}. Данные при этом на месте – сброс фильтров вернет полный рейтинг.`;
}

/** Опция фильтра размера или CI: значение адреса, подпись и счетчик фасета (null — фасета нет). */
export interface FacetOption {
  value: string;
  title: string;
  count: number | null;
}

type FilterFacets = { size: { bucket: SizeBucket; count: number }[]; ci: { value: CiFilter; count: number }[] };

/**
 * Опции размера — все 5 корзин в порядке SIZE_BUCKETS, счетчик
 * из фасета ответа (0 — тоже число). Без ответа (первая загрузка) счетчиков нет.
 */
export function sizeOptions(facets: FilterFacets | null): FacetOption[] {
  return SIZE_BUCKETS.map((bucket) => ({
    value: bucket,
    title: SIZE_TITLES[bucket],
    count: facets?.size.find((f) => f.bucket === bucket)?.count ?? null,
  }));
}

/** Опции CI: «есть CI», «нет CI» со счетчиками фасета. */
export function ciOptions(facets: FilterFacets | null): FacetOption[] {
  return CI_VALUES.map((value) => ({ value, title: CI_TITLES[value], count: facets?.ci.find((f) => f.value === value)?.count ?? null }));
}

/** Сводка выбранных корзин в поле: одна — короткой подписью, несколько — «первая +N». */
export function sizeSummary(values: string[]): string {
  const first = values[0];
  if (first === undefined) return "";
  const title = SIZE_SHORT[first as SizeBucket] ?? first;
  return values.length === 1 ? title : `${title} +${values.length - 1}`;
}
