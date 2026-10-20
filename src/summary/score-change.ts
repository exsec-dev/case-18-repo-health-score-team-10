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
import { NO_VALUE, displayOnly, plural, submetricContext, submetricShownParts, submetricTitle, subweightKey } from "../report/submetrics";

/**
 * Сырые значения показателя, по которым слова выбирают фразу (строки показа
 * «нет файла», «ci.yaml с командами» не разбираются).
 */
export interface ScoreSubFacts {
  /** поправка балла: выборка задач (n из full или days дней), объем кода (loc из full), потолок AppSec (level); null — поправки нет */
  adjustment?: { n?: number; full?: number; days?: number; loc?: number; level?: "critical" | "high" } | null;
  /** признаки ci.yaml; hasSteps null — файл не удалось разобрать; null — признаков нет */
  ci?: { hasCiYaml: boolean; hasSteps: boolean | null } | null;
  /** README есть */
  present?: boolean;
  /** доля тестов вне расчета: тестов нет или доля не повышает балл */
  tests?: "none" | "idle";
  /** релизы не засчитаны: за год нет коммитов людей (число то же, балл 0) */
  releasesIdle?: boolean;
}

export interface ScoreSubChange {
  key: string;
  /** название подметрики по словарю карточки */
  title: string;
  /** значение в прошлом и в этом анализе — как на карточке («нет» → «есть») */
  from: string;
  to: string;
  /** балл подметрики вырос (у вошедшего или выпавшего показателя — балл категории вырос от этого) */
  better: boolean;
  /** показатель вошел в расчет (балла не было) или выпал из него; нет — балл есть в обоих анализах */
  counted?: "entered" | "left";
  /** сырые значения в прошлом и в этом анализе — у показателей, чьи слова от них зависят */
  was?: ScoreSubFacts;
  now?: ScoreSubFacts;
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
  /** только «Задачи»: в этом анализе задачи не ведутся или открытые есть, а не закрыта ни одна; null — закрытые есть */
  tracker?: "unused" | "none-closed" | null;
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
  level?: "critical" | "high";
}

type CategoryEntry = { score: number | null; submetrics?: Record<string, unknown>; adjustment?: Adjustment } | undefined;

/** Задачи не ведутся: 0/0 в трекере — подметрика `tracker_unused` с баллом. */
function trackerUnused(c: CategoryEntry): boolean {
  return subScore(c?.submetrics?.tracker_unused) !== null;
}

/** Поправка строкой изменения: название по виду и значение («28 из 200 строк»); без поправки — «достаточно»/«нет». */
function adjustmentShown(c: CategoryEntry, kind: string): string {
  const adj = c?.adjustment;
  if (!adj || adj.kind !== kind) return kind === "open-findings-cap" ? "нет" : kind === "small-sample" && trackerUnused(c) ? "задачи не ведутся" : "достаточно";
  if (kind === "small-code") return `${adj.loc} из ${adj.full} ${plural(adj.full ?? 0, "строки", "строк", "строк")}`;
  if (kind === "small-sample") return adj.days !== undefined ? `${adj.days} из ${adj.daysFull} дней` : `${adj.n} из ${adj.full}`;
  return `не выше ${adj.limit}`;
}

/** Поправка сырыми полями для слов; null — поправки этого вида нет. */
function adjustmentFacts(c: CategoryEntry, kind: string): ScoreSubFacts["adjustment"] {
  const adj = c?.adjustment;
  if (!adj || adj.kind !== kind) return null;
  if (kind === "open-findings-cap") return { level: adj.level ?? (typeof adj.limit === "number" && adj.limit <= 40 ? "critical" : "high") };
  return { n: adj.n, full: adj.full, days: adj.days, loc: adj.loc };
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
  const ca = prev.categories[key] as CategoryEntry;
  const cb = next.categories[key] as CategoryEntry;
  const kind = cb?.adjustment?.kind ?? ca?.adjustment?.kind;
  if (kind === undefined || ADJUSTMENT_TITLE[kind] === undefined) return null;
  const from = adjustmentShown(ca, kind);
  const to = adjustmentShown(cb, kind);
  if (from === to) return null;
  // сколько поправка снимала с балла категории: балл − взвешенное среднее
  const cut = (c: CategoryEntry): number => (c?.adjustment?.kind === kind && typeof c.adjustment.raw === "number" && typeof c.score === "number" ? c.score - c.adjustment.raw : 0);
  const delta = cut(cb) - cut(ca);
  // «больше кода» — лучше даже при нулевом сдвиге: для потолка лучше, когда он снят
  const byDays = kind === "small-sample" && (cb?.adjustment?.days ?? ca?.adjustment?.days) !== undefined;
  return {
    key: `adjustment.${kind}`,
    title: byDays ? "Дни закрытия задач для надежной оценки" : ADJUSTMENT_TITLE[kind]!,
    from,
    to,
    better: delta >= 0,
    was: { adjustment: adjustmentFacts(ca, kind) },
    now: { adjustment: adjustmentFacts(cb, kind) },
    impact: Math.abs(delta) / 100,
  };
}

/** Сырые значения показателя для слов: README есть, признаки ci.yaml, почему доля тестов вне расчета. */
function subFacts(key: CategoryKey, sub: string, entry: unknown): ScoreSubFacts | undefined {
  const e = subEntry(entry);
  const v = e.value !== null && typeof e.value === "object" ? (e.value as Record<string, unknown>) : null;
  if (key === "documentation" && sub === "readme") return v === null ? undefined : { present: v.present !== false };
  if (key === "cicd" && sub === "config") {
    if (v === null) return { ci: null };
    // тем же правилом, что расчет: шаги не булевы или есть заметка — не разобран
    const parsed = typeof v.has_steps === "boolean" && typeof v.steps_note !== "string";
    return { ci: { hasCiYaml: v.has_ci_yaml === true, hasSteps: parsed ? (v.has_steps as boolean) : null } };
  }
  // заметки расчета (compute.ts): «no tests — …», «tests bonus not applied — …»
  if (key === "code" && sub === "tests" && typeof e.note === "string") {
    if (e.note.startsWith("no tests")) return { tests: "none" };
    if (e.note.startsWith("tests bonus not applied")) return { tests: "idle" };
  }
  if (key === "activity" && sub === "releases_12m") return { releasesIdle: typeof e.note === "string" && e.note.startsWith("releases not counted") };
  return undefined;
}

/**
 * Показатели, чья смена меняет весь набор категории: задачи начали или
 * перестали вести, проверка AppSec запускалась или нет. Идут первыми — их
 * фраза объясняет и вошедшие вместе с ними показатели.
 */
const SET_ANCHORS = new Set(["issues.tracker_unused", "security.scan_missing"]);

/** Значение показателя вне расчета для подсказки: голый «–» читался бы «нет данных». */
function outsideShown(parts: { value: string; aside: string | null }): string {
  if (parts.aside !== null) return `${parts.value} (${parts.aside})`;
  if (parts.value === NO_VALUE) return "вне расчета";
  return parts.value.includes("в балл не входит") ? parts.value : `${parts.value}, вне расчета`;
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
  const catA = prev.categories[key]?.score ?? null;
  const catB = next.categories[key]?.score ?? null;
  for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (displayOnly(key, sub)) continue;
    const sa = subScore(a[sub]);
    const sb = subScore(b[sub]);
    if (sa === null && sb === null) continue;
    const partsA = submetricShownParts(key, sub, subEntry(a[sub]), ctxA);
    const partsB = submetricShownParts(key, sub, subEntry(b[sub]), ctxB);
    const was = subFacts(key, sub, a[sub]);
    const now = subFacts(key, sub, b[sub]);
    const facts = { ...(was !== undefined ? { was } : {}), ...(now !== undefined ? { now } : {}) };
    // смена набора — всегда в первых строках, выше любого показателя
    const anchor = SET_ANCHORS.has(`${key}.${sub}`);
    const weight = weights[subweightKey(sub)] ?? 0;
    if (sa === null || sb === null) {
      // показатель вошел в расчет или выпал из него: заметность — насколько его
      // балл отличается от балла категории без него
      const entered = sa === null;
      const s = (entered ? sb : sa)!;
      const rest = entered ? catA : catB;
      const from = entered ? outsideShown(partsA) : partsA.value;
      const to = entered ? partsB.value : outsideShown(partsB);
      const better = rest === null ? entered : entered ? s * 100 >= rest : s * 100 <= rest;
      const impact = anchor ? 2 : weight * Math.max(SUB_STEP, Math.abs(s - (rest ?? 0) / 100));
      out.push({ key: sub, title: submetricTitle(key, sub), from, to, better, counted: entered ? "entered" : "left", ...facts, impact });
      continue;
    }
    if (Math.abs(sb - sa) < SUB_STEP) continue;
    // релизы перестали или снова стали засчитываться при том же числе — подпись к числу
    const idle = (f: ScoreSubFacts | undefined, v: string): string => (f?.releasesIdle === true ? `${v}, не засчитаны` : v);
    const from = idle(was, partsA.value);
    const to = idle(now, partsB.value);
    // значение то же (округление показа) — изменение не читается, не называем
    if (from === to) continue;
    out.push({ key: sub, title: submetricTitle(key, sub), from, to, better: sb > sa, ...facts, impact: Math.abs(sb - sa) * weight });
  }
  return out
    .sort((x, y) => y.impact - x.impact)
    .slice(0, SUBS_SHOWN)
    .map(({ impact: _impact, ...s }) => s);
}

/**
 * «Задачи» без засчитанных закрытий: трекер пуст или открытые есть, а не
 * закрыта ни одна (выборка из 0 задач). null — закрытые задачи есть.
 */
function trackerState(c: CategoryEntry): "unused" | "none-closed" | null {
  if (c === undefined || c.score === null) return null;
  if (trackerUnused(c)) return "unused";
  const closeDays = subEntry(c.submetrics?.close_days);
  const noneClosed = (c.adjustment?.kind === "small-sample" && c.adjustment.n === 0) || (typeof closeDays.note === "string" && closeDays.note.startsWith("no issue closed"));
  return noneClosed ? "none-closed" : null;
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
    const subs = kind === "changed" ? subChanges(key, prev, next) : [];
    categories.push({ key, from, to, kind, index: ix, full: fx, subs, ...(key === "issues" ? { tracker: trackerState(next.categories.issues as CategoryEntry) } : {}) });
  }
  const weight = (c: ScoreCategoryChange): number => Math.abs(c.index ?? c.full ?? 0);
  categories.sort((x, y) => weight(y) - weight(x));
  return { ...base, fullCapped, categories };
}
