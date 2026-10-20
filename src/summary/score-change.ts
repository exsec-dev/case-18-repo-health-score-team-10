// Почему изменилась оценка между двумя соседними анализами — разбивка разницы
// по категориям. Модуль БЕЗ серверных зависимостей: считает сервер
// (api/history), тип читает веб.
//
// Итог показателя — среднее баллов категорий с данными по их весам. Разница
// раскладывается точно:
//   общие категории (данные в обоих анализах): w·(b − a) / W(общих);
//   категория получила данные: w·(b − T') / W(с данными в новом), где T' —
//     итог нового анализа по общим категориям;
//   категория потеряла данные: w·(T'' − a) / W(с данными в прошлом), где T'' —
//     итог прошлого анализа по общим категориям.
// Сумма вкладов равна разнице итогов. На экране баллы целые, поэтому вклады
// округляются методом наибольшего остатка: сумма целых вкладов равна разнице
// показанных чисел («+9», а не «+9,3 при +9»).

import { INDEX_WEIGHTS, PUBLIC_CATEGORIES, SCORE_WEIGHTS, SUBWEIGHTS, type CategoryKey } from "../score/model";
import { displayOnly, plural, submetricContext, submetricShownParts, submetricTitle, subweightKey } from "../report/submetrics";

export interface ScoreSubChange {
  key: string;
  /** название подметрики по словарю карточки */
  title: string;
  /** значение в прошлом и в этом анализе — как на карточке («нет» → «есть») */
  from: string;
  to: string;
  /** балл подметрики вырос */
  better: boolean;
}

export interface ScoreCategoryChange {
  key: CategoryKey;
  /** балл категории в прошлом и в этом анализе; null — данных не было */
  from: number | null;
  to: number | null;
  kind: "changed" | "appeared" | "gone";
  /** вклад в разницу HealthCraft Index, целые баллы; null — категория не входит в индекс */
  index: number | null;
  /** вклад в разницу Repo Health Score, целые баллы; null — показатель закрыт или ограничен капом */
  full: number | null;
  /** самые заметные изменения подметрик (до 3) */
  subs: ScoreSubChange[];
}

export interface ScoreChange {
  /** с каким анализом сравнение — предыдущая точка истории */
  fromScanId: number;
  fromFinishedAt: string | null;
  index: { from: number | null; to: number | null };
  /** Repo Health Score — только зрителю с правами */
  full: { from: number | null; to: number | null } | null;
  /**
   * переход, который разбивкой не объясняется: появился или пропал код
   * (у репозитория без кода оценка 0), оценка появилась или пропала (мало данных)
   */
  special: "code-appeared" | "code-gone" | "score-appeared" | "score-gone" | null;
  /** Repo Health Score ограничен капом находок AppSec — его вклады не считаются */
  fullCapped: boolean;
  /** категории с ненулевым вкладом или сменой наличия данных; по убыванию вклада */
  categories: ScoreCategoryChange[];
}

/** Снимок анализа для сравнения: баллы категорий с подметриками и итоги, как показаны. */
export interface ScoreSnapshot {
  scanId: number;
  finishedAt: string | null;
  categories: Record<string, { score: number | null; submetrics?: Record<string, unknown> }>;
  codeEmpty: boolean;
  healthcraftIndex: number | null;
  /** null — показатель закрыт зрителю или не рассчитан */
  repoHealthScore: number | null;
  /** кап полного итога в этом анализе (секреты 49, критичные находки 69); null — нет */
  fullCap: number | null;
}

const ALL_CATEGORIES: CategoryKey[] = ["documentation", "activity", "issues", "code", "cicd", "security"];

/** Шаг подметрики, ниже которого изменение не называем (2 п.п. балла подметрики). */
const SUB_STEP = 0.02;
const SUBS_SHOWN = 3;

/** Показанное целое балла — как `roundScore` карточки (без двоичного шума). */
function shown(value: number): number {
  return Math.round(Math.round(value * 1e9) / 1e9);
}

/**
 * Точные вклады категорий в разницу итогов (см. шапку). null — общих
 * категорий нет: разбивка не определена.
 */
export function decompose(a: Partial<Record<CategoryKey, number | null>>, b: Partial<Record<CategoryKey, number | null>>, weights: Partial<Record<CategoryKey, number>>): Map<CategoryKey, number> | null {
  const keys = Object.keys(weights) as CategoryKey[];
  const has = (r: Partial<Record<CategoryKey, number | null>>, k: CategoryKey): boolean => typeof r[k] === "number";
  const common = keys.filter((k) => has(a, k) && has(b, k));
  if (common.length === 0) return null;
  const w = (k: CategoryKey): number => weights[k]!;
  const sum = (ks: CategoryKey[], f: (k: CategoryKey) => number): number => ks.reduce((acc, k) => acc + f(k), 0);
  const wCommon = sum(common, w);
  const midB = sum(common, (k) => w(k) * b[k]!) / wCommon;
  const midA = sum(common, (k) => w(k) * a[k]!) / wCommon;
  const wB = sum(keys.filter((k) => has(b, k)), w);
  const wA = sum(keys.filter((k) => has(a, k)), w);
  const out = new Map<CategoryKey, number>();
  for (const k of keys) {
    if (has(a, k) && has(b, k)) out.set(k, (w(k) * (b[k]! - a[k]!)) / wCommon);
    else if (has(b, k)) out.set(k, (w(k) * (b[k]! - midB)) / wB);
    else if (has(a, k)) out.set(k, (w(k) * (midA - a[k]!)) / wA);
  }
  return out;
}

/**
 * Целые вклады с суммой `target` — наибольший остаток: сначала вниз, затем
 * недостающие единицы получают доли с большим остатком (лишние снимаются с
 * меньшего).
 */
export function apportion(values: Map<CategoryKey, number>, target: number): Map<CategoryKey, number> {
  const entries = [...values.entries()].map(([k, v]) => ({ k, base: Math.floor(v + 1e-9), rest: v - Math.floor(v + 1e-9) }));
  let left = target - entries.reduce((acc, e) => acc + e.base, 0);
  const byRest = [...entries].sort((x, y) => y.rest - x.rest);
  for (let i = 0; left > 0 && byRest.length > 0; i++, left--) byRest[i % byRest.length]!.base++;
  for (let i = 0; left < 0 && byRest.length > 0; i++, left++) byRest[byRest.length - 1 - (i % byRest.length)]!.base--;
  return new Map(entries.map((e) => [e.k, e.base]));
}

/** Балл подметрики (число или `{score}`); null — без балла. */
function subScore(entry: unknown): number | null {
  if (typeof entry === "number") return entry;
  if (entry !== null && typeof entry === "object" && typeof (entry as { score?: unknown }).score === "number") return (entry as { score: number }).score;
  return null;
}

function subEntry(entry: unknown): { score?: number | null; value?: unknown; note?: string | null } {
  return entry !== null && typeof entry === "object" ? (entry as { score?: number | null; value?: unknown; note?: string | null }) : { score: subScore(entry) };
}

/** Поправка балла категории (`CategoryScore.adjustment`) — поля, которые читает разбивка. */
interface Adjustment {
  kind: string;
  raw?: number;
  n?: number;
  full?: number;
  days?: number;
  daysFull?: number;
  loc?: number;
  limit?: number;
}

/** Поправка строкой изменения: название по виду и значение («28 из 200 строк»); без поправки — «достаточно»/«нет». */
function adjustmentShown(adj: Adjustment | undefined, kind: string): string {
  if (!adj || adj.kind !== kind) return kind === "open-findings-cap" ? "нет" : "достаточно";
  if (kind === "small-code") return `${adj.loc} из ${adj.full} ${plural(adj.full ?? 0, "строки", "строк", "строк")}`;
  if (kind === "small-sample") return adj.days !== undefined ? `${adj.days} из ${adj.daysFull} дней` : `${adj.n} из ${adj.full}`;
  return `не выше ${adj.limit}`;
}

const ADJUSTMENT_TITLE: Record<string, string> = {
  "small-code": "Объем кода для надежной оценки",
  "small-sample": "Закрытые задачи для надежной оценки",
  "open-findings-cap": "Потолок за открытые находки AppSec",
};

/**
 * Поправка малой выборки или потолок сдвигают балл категории без смены
 * подметрик (код дорос с 28 до 69 строк) — такая смена тоже строка изменения.
 */
function adjustmentChange(key: CategoryKey, prev: ScoreSnapshot, next: ScoreSnapshot): (ScoreSubChange & { impact: number }) | null {
  const ca = prev.categories[key] as { score: number | null; adjustment?: Adjustment } | undefined;
  const cb = next.categories[key] as { score: number | null; adjustment?: Adjustment } | undefined;
  const kind = cb?.adjustment?.kind ?? ca?.adjustment?.kind;
  if (kind === undefined || ADJUSTMENT_TITLE[kind] === undefined) return null;
  const from = adjustmentShown(ca?.adjustment, kind);
  const to = adjustmentShown(cb?.adjustment, kind);
  if (from === to) return null;
  // сколько поправка снимала с балла категории: балл − взвешенное среднее
  const cut = (c: typeof ca): number => (c?.adjustment?.kind === kind && typeof c.adjustment.raw === "number" && typeof c.score === "number" ? c.score - c.adjustment.raw : 0);
  const delta = cut(cb) - cut(ca);
  // «больше кода» — лучше даже при нулевом сдвиге: для потолка лучше, когда он снят
  const byDays = kind === "small-sample" && (cb?.adjustment?.days ?? ca?.adjustment?.days) !== undefined;
  return { key: `adjustment.${kind}`, title: byDays ? "Дни закрытия задач для надежной оценки" : ADJUSTMENT_TITLE[kind]!, from, to, better: delta >= 0, impact: Math.abs(delta) / 100 };
}

/** Самые заметные изменения подметрик категории: по вкладу в балл категории (шаг × вес). */
function subChanges(key: CategoryKey, prev: ScoreSnapshot, next: ScoreSnapshot): ScoreSubChange[] {
  const a = prev.categories[key]?.submetrics ?? {};
  const b = next.categories[key]?.submetrics ?? {};
  const weights = SUBWEIGHTS[key] as Record<string, number>;
  const ctxA = submetricContext(prev.finishedAt);
  const ctxB = submetricContext(next.finishedAt);
  const out: (ScoreSubChange & { impact: number })[] = [];
  const adj = adjustmentChange(key, prev, next);
  if (adj !== null) out.push(adj);
  for (const sub of Object.keys(b)) {
    if (displayOnly(key, sub)) continue;
    const sa = subScore(a[sub]);
    const sb = subScore(b[sub]);
    if (sa === null || sb === null || Math.abs(sb - sa) < SUB_STEP) continue;
    const from = submetricShownParts(key, sub, subEntry(a[sub]), ctxA).value;
    const to = submetricShownParts(key, sub, subEntry(b[sub]), ctxB).value;
    // значение то же (округление показа) — изменение не читается, не называем
    if (from === to) continue;
    out.push({ key: sub, title: submetricTitle(key, sub), from, to, better: sb > sa, impact: Math.abs(sb - sa) * (weights[subweightKey(sub)] ?? 0) });
  }
  return out
    .sort((x, y) => y.impact - x.impact)
    .slice(0, SUBS_SHOWN)
    .map(({ impact: _impact, ...s }) => s);
}

/**
 * Разница двух соседних анализов. `fullOpen` — зрителю виден Repo Health
 * Score: тогда в разбивке и CI/CD с Безопасностью; иначе только 4 открытые
 * категории (закрытые каналы не протекают ни числом, ни подметрикой).
 */
export function scoreChange(prev: ScoreSnapshot, next: ScoreSnapshot, fullOpen: boolean): ScoreChange {
  const base: ScoreChange = {
    fromScanId: prev.scanId,
    fromFinishedAt: prev.finishedAt,
    index: { from: prev.healthcraftIndex, to: next.healthcraftIndex },
    full: fullOpen ? { from: prev.repoHealthScore, to: next.repoHealthScore } : null,
    special: null,
    fullCapped: false,
    categories: [],
  };
  if (prev.codeEmpty !== next.codeEmpty) return { ...base, special: next.codeEmpty ? "code-gone" : "code-appeared" };
  if (prev.codeEmpty && next.codeEmpty) return base;
  if (prev.healthcraftIndex === null || next.healthcraftIndex === null) {
    return prev.healthcraftIndex === next.healthcraftIndex ? base : { ...base, special: next.healthcraftIndex === null ? "score-gone" : "score-appeared" };
  }
  const scoresOf = (s: ScoreSnapshot): Partial<Record<CategoryKey, number | null>> =>
    Object.fromEntries(ALL_CATEGORIES.map((k) => [k, s.categories[k]?.score ?? null]));
  const a = scoresOf(prev);
  const b = scoresOf(next);
  const indexParts = decompose(a, b, INDEX_WEIGHTS);
  const index = indexParts === null ? null : apportion(indexParts, next.healthcraftIndex - prev.healthcraftIndex);
  let full: Map<CategoryKey, number> | null = null;
  let fullCapped = false;
  if (fullOpen && prev.repoHealthScore !== null && next.repoHealthScore !== null) {
    // кап срезает итог сверху: разница уже не сумма категорий — вклады не считаем
    const uncapped = (r: Partial<Record<CategoryKey, number | null>>): number => {
      const ks = ALL_CATEGORIES.filter((k) => typeof r[k] === "number");
      const w = ks.reduce((acc, k) => acc + SCORE_WEIGHTS[k], 0);
      return w > 0 ? ks.reduce((acc, k) => acc + SCORE_WEIGHTS[k] * r[k]!, 0) / w : 0;
    };
    fullCapped = (prev.fullCap !== null && uncapped(a) > prev.fullCap) || (next.fullCap !== null && uncapped(b) > next.fullCap);
    const fullParts = fullCapped ? null : decompose(a, b, SCORE_WEIGHTS);
    full = fullParts === null ? null : apportion(fullParts, shown(next.repoHealthScore) - shown(prev.repoHealthScore));
  }
  const keys = fullOpen ? ALL_CATEGORIES : PUBLIC_CATEGORIES;
  const categories: ScoreCategoryChange[] = [];
  for (const key of keys) {
    const from = a[key] ?? null;
    const to = b[key] ?? null;
    if (from === null && to === null) continue;
    const kind = from === null ? "appeared" : to === null ? "gone" : "changed";
    const ix = (PUBLIC_CATEGORIES as CategoryKey[]).includes(key) ? (index?.get(key) ?? 0) : null;
    const fx = full?.get(key) ?? null;
    // сдвинула индекс или Repo Health Score: вклад в индекс мог округлиться до 0,
    // а в полный показатель — нет, и без строки его мостик не сошелся бы
    const moved = (ix ?? 0) !== 0 || (fx ?? 0) !== 0;
    if (kind === "changed" && !moved) continue;
    categories.push({ key, from, to, kind, index: ix, full: fx, subs: kind === "changed" ? subChanges(key, prev, next) : [] });
  }
  const weight = (c: ScoreCategoryChange): number => Math.abs(c.index ?? c.full ?? 0);
  categories.sort((x, y) => weight(y) - weight(x));
  return { ...base, fullCapped, categories };
}
