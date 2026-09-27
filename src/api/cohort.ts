// cohort.ts — В5.9 Б (идея №11): «индекс лучше, чем у X% похожих». Чистый
// модуль без БД и React: выборку когорты читает `repos.ts` (`repoCohort`),
// здесь — определение процента, порог малой когорты и причины его отсутствия.
// Его же может брать бандл web (типы и подписи причин).
//
// Когорта = тот же язык + та же корзина размера рейтинга (`rating-filters.ts`),
// только ПУБЛИЧНЫЕ репо с местом в рейтинге (тот же набор, что `rank`:
// rating_active, public, последний пригодный скан текущей MODEL_VERSION,
// индекс не NULL), без самого репозитория.
//
// Определение процента (одно на индекс и категории):
//   X = floor(100 · |{ m ∈ когорта : round(m) < round(self) }| / |когорта|)
// — доля когорты (без самого репо) со СТРОГО меньшим округленным показателем
// (`roundScore`, то же округление, что на экране). Равные не считаются «хуже»:
// при равенстве репо не «лучше» соседа, и процент не завышается. Округление
// процента — вниз (floor): «лучше, чем у X%» не обещает больше, чем есть.
import type { IndexCategoryKey } from "../score/model";
import { roundScore } from "../web/format";
import type { SizeBucket } from "./rating-filters";

/**
 * Порог малой когорты: процент считается, только если в когорте (без самого
 * репо) не меньше COHORT_MIN репозиториев. 30 — шаг процента не грубее 3,3
 * п.п. (1/30), а на копии БД 27.09 порог 30 против 20 отнимает процент лишь у
 * 1,3% карточек с когортой (17 936 против 18 183 из 18 666) — отчет воркера Б.
 */
export const COHORT_MIN = 30;

/** Четыре публичные категории индекса — у каждой свой процент. */
export const COHORT_CATEGORIES: readonly IndexCategoryKey[] = ["documentation", "activity", "issues", "code"];

/**
 * Почему процента нет. Каждая причина — своя ветка (правило 22.09):
 * - `small-cohort` — похожих меньше COHORT_MIN (процент на горстке шумит);
 * - `no-cohort` — у репо нет языка или корзины размера (факта нет) — это
 *   незнание, не 0%;
 * - `code-empty` — «без кода» (Q&A №13): индекс 0 по определению, сравнивать
 *   нечего;
 * - `no-data` — (только категория) у самого репо балла категории нет.
 */
export type CohortReason = "small-cohort" | "no-cohort" | "code-empty" | "no-data";

export interface CohortIndexStat {
  /** 0-100, целое; null — см. reason */
  percentile: number | null;
  reason: CohortReason | null;
}

export interface CohortCategoryStat {
  percentile: number | null;
  /** похожих с баллом этой категории (без самого репо); null — когорта не строилась */
  size: number | null;
  reason: CohortReason | null;
}

export interface RepoCohort {
  language: string | null;
  sizeBucket: SizeBucket | null;
  /** похожих (без самого репо); null — когорта не строилась (no-cohort, code-empty) */
  size: number | null;
  index: CohortIndexStat;
  categories: Record<IndexCategoryKey, CohortCategoryStat>;
}

/** Репо, чей процент считается: его показатели и признаки когорты. */
export interface CohortSelf {
  language: string | null;
  sizeBucket: SizeBucket | null;
  codeEmpty: boolean;
  index: number;
  categories: Record<IndexCategoryKey, number | null>;
}

/** Член когорты: показатели похожего репо (он уже отобран по языку и корзине). */
export interface CohortMember {
  index: number;
  categories: Record<IndexCategoryKey, number | null>;
}

/**
 * Процент по определению модуля: доля `others` со строго меньшим округленным
 * значением, вниз до целого. Пустая выборка — null (делить не на что).
 */
export function percentileBelow(value: number, others: readonly number[]): number | null {
  if (others.length === 0) return null;
  const self = roundScore(value);
  let below = 0;
  for (const o of others) if (roundScore(o) < self) below++;
  return Math.floor((100 * below) / others.length);
}

function allCategories(stat: CohortCategoryStat): Record<IndexCategoryKey, CohortCategoryStat> {
  const out = {} as Record<IndexCategoryKey, CohortCategoryStat>;
  for (const key of COHORT_CATEGORIES) out[key] = { ...stat };
  return out;
}

/**
 * Когорта репо из уже отобранных похожих (`members` — тот же язык и корзина,
 * публичные с местом, БЕЗ самого репо). `min` — порог малой когорты
 * (параметр для тестов и настройки; по умолчанию COHORT_MIN).
 */
export function buildCohort(self: CohortSelf, members: readonly CohortMember[], min = COHORT_MIN): RepoCohort {
  const base = { language: self.language, sizeBucket: self.sizeBucket };
  // «без кода» главнее языка и размера: у такого репо корзина — «none», индекс 0
  if (self.codeEmpty) {
    const reason: CohortReason = "code-empty";
    return { ...base, size: null, index: { percentile: null, reason }, categories: allCategories({ percentile: null, size: null, reason }) };
  }
  if (self.language === null || self.sizeBucket === null) {
    const reason: CohortReason = "no-cohort";
    return { ...base, size: null, index: { percentile: null, reason }, categories: allCategories({ percentile: null, size: null, reason }) };
  }
  const size = members.length;
  const index: CohortIndexStat =
    size < min ? { percentile: null, reason: "small-cohort" } : { percentile: percentileBelow(self.index, members.map((m) => m.index)), reason: null };
  const categories = {} as Record<IndexCategoryKey, CohortCategoryStat>;
  for (const key of COHORT_CATEGORIES) {
    // когорта категории — те же похожие, у кого балл категории есть (NULL — незнание, не 0)
    const values = members.map((m) => m.categories[key]).filter((v): v is number => v !== null && v !== undefined);
    const own = self.categories[key];
    // своего балла нет — процента нет при любой когорте (незнание главнее размера выборки)
    if (own === null || own === undefined) categories[key] = { percentile: null, size: values.length, reason: "no-data" };
    else if (values.length < min) categories[key] = { percentile: null, size: values.length, reason: "small-cohort" };
    else categories[key] = { percentile: percentileBelow(own, values), size: values.length, reason: null };
  }
  return { ...base, size, index, categories };
}
