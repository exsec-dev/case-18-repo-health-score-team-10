// rating-filters.ts — В5.5 тур 2 (W3, ТЗ §7 ЗН-1): дополнительные фильтры
// рейтинга — размер кода и наличие CI. Чистый модуль без БД и React: его
// значения берут и сервер (`repos.ts`: разбор адреса, фильтр, фасеты), и
// бандл web (`Rating.tsx`, `ratingParams.ts`), и тесты.
//
// Тематика и security status — НАЗВАННЫЕ ОГРАНИЧЕНИЯ, а не фильтры:
// тематик/топиков у репозитория в API SourceCraft нет (схема `Repository`:
// язык, описание), а данные AppSec видны только участникам репозитория
// (Q&A №1) — в публичном рейтинге их нет ни у одного репо.

/**
 * Корзина размера по строкам кода (`tree.stats`: `source_loc`, у фактов до
 * сборщика 3 — `loc`). `none` — «без кода»: репо, которому модель поставила
 * «проекта нет» (`scores.code_empty`, Q&A №13; в рейтинге с индексом 0) —
 * подтвержденный факт, поэтому своя корзина, а не «до 1 тыс.» и не «нет данных».
 */
export type SizeBucket = "none" | "small" | "medium" | "large" | "huge";

/** Порядок корзин в выборе — по возрастанию размера, «без кода» первым. */
export const SIZE_BUCKETS: readonly SizeBucket[] = ["none", "small", "medium", "large", "huge"];

/** Границы корзин (строк кода): [0, 1000) small, [1000, 10000) medium, [10000, 100000) large, 100000+ huge. */
export const SIZE_LIMITS = { medium: 1_000, large: 10_000, huge: 100_000 } as const;

export const SIZE_TITLES: Record<SizeBucket, string> = {
  none: "без кода",
  small: "до 1 тыс. строк",
  medium: "1-10 тыс. строк",
  large: "10-100 тыс. строк",
  huge: "больше 100 тыс. строк",
};

/**
 * Корзина размера. `codeEmpty` — признак модели «кода нет» (он главнее
 * счетчика строк); `loc` — строки кода или null (факта нет, чтение оборвалось,
 * строки файлов кода не прочитаны) — тогда корзины нет: это незнание (закон 2),
 * а не «маленький репозиторий».
 */
export function sizeBucketOf(codeEmpty: boolean, loc: number | null): SizeBucket | null {
  if (codeEmpty) return "none";
  if (loc === null || !Number.isFinite(loc) || loc < 0) return null;
  if (loc < SIZE_LIMITS.medium) return "small";
  if (loc < SIZE_LIMITS.large) return "medium";
  if (loc < SIZE_LIMITS.huge) return "large";
  return "huge";
}

/** Фильтр CI: `yes` — в клоне есть `.sourcecraft/ci.yaml` (`cicd.configs.has_ci_yaml`), `no` — подтвержденно нет. */
export type CiFilter = "yes" | "no";

export const CI_VALUES: readonly CiFilter[] = ["yes", "no"];

export const CI_TITLES: Record<CiFilter, string> = { yes: "есть CI", no: "нет CI" };

/**
 * Подсказка у фильтров рейтинга: почему нет фильтров по тематике и
 * security status (ТЗ §7 называет их, закрыты названным ограничением).
 */
export const FILTER_LIMITS_NOTE =
  "Фильтра по тематике нет: SourceCraft не отдает тематики репозиториев, ближе всего – фильтр по языку. " +
  "Фильтра по статусу безопасности нет: данные AppSec видны только участникам репозитория, в публичном рейтинге их нет.";
