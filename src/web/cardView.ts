// cardView.ts — view-модель страницы репозитория (В4.9, часть 2 гейта, круг 1).
//
// Страница читается сверху вниз одной линией, как PDF: насколько здоров → из
// чего сложилось → почему по каждой категории → что сделать → чему не верить.
// Все, что страница утверждает о данных (вклады, основания категорий,
// ограничения, фразы закрытых категорий, путь к полной оценке, номера и
// эффекты рекомендаций), собирается здесь из тех же функций, что модель
// документа (`src/report/sections.ts`), — поэтому поведенческий тест сравнивает
// поля этой модели с `buildReportModel` на фикстурах отчета (инвариант 1).
// Модуль чистый: без React и uikit, его импортирует `bun test`.
import type { CardEvidence, CardRecommendation, RepoCard } from "../api/repos";
import { CATEGORY_ORDER, CATEGORY_TITLES } from "../report/categories";
import {
  FULL,
  INDEX,
  RULE_SUBMETRIC,
  analysisDate,
  categoryWhy,
  contributionBars,
  noRecommendationsKind,
  noRecommendationsText,
  limitationItems,
  recommendationEffect,
  sourceWord,
  type ContributionBar,
} from "../report/sections";
import { submetricContext, submetricShownValue, submetricTitle } from "../report/submetrics";
import type { CategoryKey } from "../score/model";
import { SIZE_TITLES } from "../api/rating-filters";
import type { RankLeague } from "../api/rank-badge";
import { COHORT_MIN } from "../api/cohort";
import {
  fmtCount,
  fmtScore,
  fmtSigned,
  fullScorePath,
  roundScore,
  noDataReason,
  scoreLabelTheme,
  scoreWord,
  sentence,
  type PathPart,
} from "./format";

// ---------- цвет категории: один на карточке и в панели рейтинга (А3) ----------

/**
 * Ключ категории → класс цвета (`layout.css`, `.rh-cat-color_*`). До круга 1
 * рейтинг красил сегмент по ИНДЕКСУ в массиве (`rh-contrib__seg_${i + 1}`), и
 * одна категория на двух экранах получила бы разные цвета. Четыре тона
 * остались за теми же категориями (порядок `meta.categories`), CI/CD и
 * Безопасность — два новых тона той же системы (только в полосе Repo Health
 * Score).
 */
export const CATEGORY_COLOR: Record<CategoryKey, string> = {
  documentation: "rh-cat-color_documentation",
  cicd: "rh-cat-color_cicd",
  security: "rh-cat-color_security",
  activity: "rh-cat-color_activity",
  issues: "rh-cat-color_issues",
  code: "rh-cat-color_code",
};

export function categoryColorClass(key: string): string {
  return CATEGORY_COLOR[key as CategoryKey] ?? "rh-cat-color_none";
}

// ---------- видимость SourceCraft (А7, В2) ----------

export type Visibility = "public" | "internal" | "private" | "unknown";

/**
 * Плашка видимости у имени репозитория — одна функция на карточку и
 * избранное (у каждого экрана свой источник значения). Все 3 значения
 * `Repository.Visibility` — своя ветка; `unknown` — явная ветка без плашки
 * (правило AGENTS.md 22.09).
 */
export function visibilityPill(value: Visibility | string | null | undefined): { kind: "public" | "internal" | "private"; text: string; title: string } | null {
  switch (value) {
    case "public":
      return { kind: "public", text: "Публичный", title: "Публичный репозиторий: виден всем" };
    case "internal":
      return { kind: "internal", text: "Внутренний", title: "Внутренний репозиторий: виден всем, кто вошел в SourceCraft" };
    case "private":
      return { kind: "private", text: "Приватный", title: "Приватный репозиторий" };
    default:
      return null;
  }
}

// ---------- модель страницы ----------

export interface CategoryView {
  key: CategoryKey;
  title: string;
  score: number | null;
  /** число или глиф «нет данных» — как колонка «Балл» отчета */
  scoreText: string;
  chip: { theme: "success" | "warning" | "danger" | "unknown"; text: string };
  /** основание — тот же текст, что колонка «Основание» PDF */
  why: string;
  stale: boolean;
  /** примечание частичной нехватки данных у оцененной категории — внутри раскрытия */
  partialNote: string | null;
  /** В5.9: процент среди похожих по категории — первой строкой раскрытия; null — не показываем */
  cohortNote: string | null;
}

export interface LockedView {
  /** одно предложение без заголовка (круг 2, Т3): кто видит и что открывает доступ */
  text: string;
}

export interface RecommendationView {
  n: number;
  rec: CardRecommendation;
  /** эффект — текст отчета; `effectNote` («ожидаемый эффект») только у числового */
  effect: string;
  effectNote: string | null;
  /** ярлык основания словами: подметрика и ее значение либо «Исходные данные» */
  label: string;
  facts: { key: string; missing: boolean; fact: CardEvidence | null }[];
}

/** Полоса вклада карточки: сегменты отчета с классом цвета категории. */
export interface ContributionView extends Omit<ContributionBar, "segments"> {
  segments: (ContributionBar["segments"][number] & { colorClass: string })[];
}

export interface CardView {
  contributions: ContributionView[];
  categories: CategoryView[];
  worstKey: CategoryKey | null;
  locked: LockedView | null;
  limitations: string[];
  /** предупреждения наверху — только те, которых нет в «Ограничениях данных» (А6) */
  topMarkers: "ci-cap"[];
  /** строка пути к полной оценке (закрытый Repo Health Score); null — показатель открыт */
  fullPath: PathPart[] | null;
  /** под строкой пути — кнопка входа (зритель не вошел) */
  signIn: boolean;
  recommendations: RecommendationView[];
  /** В5.9: режим «По шагам» раздела рекомендаций; null — переключателя нет */
  ladder: LadderView | null;
  /** В5.9: строка позиции в плашке индекса и плашка лиги; null — места нет */
  position: PositionView | null;
  /** фраза вместо пустого раздела рекомендаций (В-1, одна копия с отчетом) и ее вид (R3) */
  noRecommendations: string;
  noRecommendationsKind: "healthy" | "weak" | "nodata";
  analysisAt: string | null;
  visibility: Visibility;
}

export const SOURCE_DATA_LABEL = "Исходные данные";

/** Шаг лестницы в режиме «По шагам»: строка рекомендации и индекс после нее (накопительно). */
export interface LadderStepView {
  item: RecommendationView;
  /** «52 (+5,8)»: индекс после шага и прирост именно этого шага */
  effect: string;
}

/**
 * В5.9 (§2 «В5.9 — выбор вариантов», п.1, вариант Б): режим списка «По шагам».
 * Шаги — в порядке лестницы, номера — позиция в показанном списке; остальные
 * рекомендации (без числа, канальные) — ниже, в прежнем виде.
 */
export interface LadderView {
  steps: LadderStepView[];
  rest: RecommendationView[];
  /** итог под последним шагом: «до 70 не хватит N» или «зона „Здоров“» */
  summary: string;
}

/**
 * В5.9 (§2 «В5.9 — выбор вариантов», п.3-5): строка позиции в плашке индекса — «#87 из
 * 28 285, лучше 91% похожих ⓘ», под ней — плашка лиги (золото ТОП-10, серебро ТОП-100,
 * бронза ТОП-1000). Числа — поля карточки как есть (правило 21.09: место, доля и размер
 * выборки проверяются тестом на данных).
 */
export interface PositionView {
  /** «#87 из 28 285» */
  rank: string;
  /** «лучше 91% похожих» и т.п.; null — про похожих ни слова (нет когорты, без кода) */
  cohort: string | null;
  /** подсказка ⓘ к фразе о похожих: кто похожие и сколько их */
  cohortHelp: string | null;
  league: { tier: RankLeague; label: string; hint: string } | null;
}

const LEAGUE_WORDS: Record<RankLeague, string> = { gold: "первую десятку", silver: "первую сотню", bronze: "первую тысячу" };

/** «репозиторий на Go размером 1-10 тыс. строк» → кто такие похожие, словами. */
function cohortWho(language: string, bucket: keyof typeof SIZE_TITLES): string {
  return `открытые репозитории на ${language} размером ${SIZE_TITLES[bucket]}`;
}

const reposWord = (n: number): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "репозиторий" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "репозитория" : "репозиториев";
};

export function positionView(card: RepoCard): PositionView | null {
  const score = card.score;
  if (!score || score.rank === null || score.rank === undefined || !score.rankedTotal) return null;
  const rank = `#${fmtCount(score.rank)} из ${fmtCount(score.rankedTotal)}`;
  let cohort: string | null = null;
  let cohortHelp: string | null = null;
  const c = score.cohort;
  if (c && c.language !== null && c.sizeBucket !== null && c.size !== null) {
    const who = cohortWho(c.language, c.sizeBucket);
    const p = c.index.percentile;
    if (p !== null) {
      cohort = p === 0 ? "у всех похожих индекс не ниже" : p === 100 ? `лучший среди ${fmtCount(c.size)} похожих` : `лучше ${p}% похожих`;
      cohortHelp = `Похожие – ${who} с местом в рейтинге: ${fmtCount(c.size)}. Процент – доля похожих, у кого индекс ниже; равные не считаются.`;
    } else if (c.index.reason === "small-cohort") {
      cohort = "похожих мало для сравнения";
      cohortHelp = `Похожие – ${who}: в рейтинге ${fmtCount(c.size)} ${reposWord(c.size)}, процент считаем от ${COHORT_MIN}.`;
    }
  }
  const b = score.rankBadge;
  const league = b
    ? { tier: b.tier, label: b.label, hint: `Лига «${b.label}»: вместе со всеми равными по индексу репозиторий входит в ${LEAGUE_WORDS[b.tier]} рейтинга по HealthCraft Index.` }
    : null;
  return { rank, cohort, cohortHelp, league };
}

/** Процент среди похожих по категории — строкой раскрытия; null — строки нет. */
export function categoryCohortNote(card: RepoCard, key: CategoryKey): string | null {
  const c = card.score?.cohort;
  const stat = c ? (c.categories as Record<string, { percentile: number | null; reason: string | null } | undefined>)[key] : undefined;
  if (!stat) return null;
  if (stat.percentile !== null) return stat.percentile === 0 ? "Среди похожих – у всех балл не ниже" : `Среди похожих – лучше ${stat.percentile}%`;
  if (stat.reason === "small-cohort") return "Похожих с данными по категории мало для сравнения";
  return null;
}

export const LADDER_HELP =
  "Каждый шаг пересчитан моделью поверх предыдущих, поэтому прирост шага может отличаться от эффекта рекомендации по отдельности. Порядок – по наибольшему приросту на каждом шаге. Это расчет по текущим данным, а не оценка: индекс изменится после нового анализа.";


/**
 * Лестница карточки → вид режима «По шагам». null — переключателя нет: лестницы
 * нет, в ней нет шагов с числом, или шаг не находит своей рекомендации на
 * карточке (тогда номер и текст шага показать нечем — режим не выдумывает строк).
 */
export function ladderView(card: RepoCard, recommendations: RecommendationView[]): LadderView | null {
  const ladder = card.ladder;
  if (!ladder || ladder.steps.length === 0) return null;
  const byRule = new Map(recommendations.map((r) => [r.rec.ruleId, r]));
  const stepItems = ladder.steps.map((s) => byRule.get(s.ruleId));
  if (stepItems.some((i) => i === undefined)) return null;
  const inSteps = new Set(ladder.steps.map((s) => s.ruleId));
  const steps = ladder.steps.map((s, i) => ({
    item: { ...stepItems[i]!, n: i + 1 },
    effect: `${fmtScore(s.indexAfter)} (${fmtSigned(s.delta)})`,
  }));
  const rest = recommendations.filter((r) => !inSteps.has(r.rec.ruleId)).map((r, i) => ({ ...r, n: steps.length + i + 1 }));
  const last = roundScore(ladder.steps[ladder.steps.length - 1]!.indexAfter);
  const k = ladder.steps.length;
  const summary =
    last >= ladder.target
      ? `После шага №${k} индекс – ${last}: зона «Здоров»`
      : `После шага №${k} индекс – ${last}, до ${ladder.target} не хватит ${ladder.target - last}`;
  return { steps, rest, summary };
}


/** Хвост фразы о закрытых категориях у зрителя с токеном — по причине отказа (круг 4, 3). */
const LOCKED_WHY: Record<"denied" | "pat-expired" | "check-failed" | "no-pat", string> = {
  denied: ", а у вашего токена к ним нет доступа.",
  "pat-expired": ". SourceCraft отклонил ваш токен – обновите его в Настройках.",
  "check-failed": ". Проверить ваш доступ сейчас не удалось – откройте карточку позже.",
  "no-pat": " после добавления персонального токена доступа.",
};

/**
 * Закрытые зрителю CI/CD и Безопасность — одно предложение без заголовка
 * (круг 2 части 2, Т3, §2 23.09): путь по типу зрителя. Не вошел — «после
 * входа и добавления токена», вошел без токена — «после добавления токена»,
 * токен есть — «только участникам репозитория» и причина отказа (`LOCKED_WHY`).
 */
export function lockedView(card: RepoCard): LockedView | null {
  const cats = card.score?.categories;
  if (!cats) return null;
  const locked = CATEGORY_ORDER.filter((k) => cats[k]?.locked !== undefined);
  if (locked.length === 0) return null;
  const names = locked.map((k) => CATEGORY_TITLES[k]).join(" и ");
  const verb = locked.length > 1 ? "видны" : "видна";
  const auth = card.viewer?.auth;
  const reasons = locked.map((k) => cats[k]!.locked as string);
  if (auth === undefined || auth === "no-session") return { text: `${names} ${verb} участникам репозитория после входа и добавления персонального токена доступа.` };
  if (auth === "no-pat" || reasons.includes("no-pat")) return { text: `${names} ${verb} участникам репозитория после добавления персонального токена доступа.` };
  // Круг 4 части 2 (3): зрителю с токеном — не обрывок причины, а смысл:
  // категории доступны только участникам репозитория, затем почему именно ему нет
  const why = (r: string): string => LOCKED_WHY[r as keyof typeof LOCKED_WHY] ?? LOCKED_WHY["check-failed"];
  const same = reasons.every((r) => r === reasons[0]);
  const agree = (t: string): string => (locked.length > 1 ? t : t.replace("к ним", "к ней"));
  if (same) return { text: `${names} ${verb} только участникам репозитория${agree(why(reasons[0]!))}` };
  return { text: locked.map((k, i) => `${CATEGORY_TITLES[k]} видна только участникам репозитория${why(reasons[i]!).replace("к ним", "к ней")}`).join(" ") };
}

/** Ярлык основания рекомендации: подметрика правила и ее значение; без записи — «Исходные данные». */
export function recommendationLabel(card: RepoCard, rec: CardRecommendation): string {
  const target = RULE_SUBMETRIC[rec.ruleId];
  if (!target || !card.score) return SOURCE_DATA_LABEL;
  const [cat, sub] = target.split(".") as [CategoryKey, string];
  const category = card.score.categories[cat];
  const entry = category?.locked === undefined ? category?.submetrics[sub] : undefined;
  if (!entry) return SOURCE_DATA_LABEL;
  return `${submetricTitle(cat, sub)} – ${submetricShownValue(cat, sub, entry, submetricContext(card.score.computedAt), category!.submetrics)}`;
}

export function cardView(card: RepoCard): CardView {
  const score = card.score;
  const evidence = new Map(card.evidence.map((e) => [e.key, e]));
  const recommendations: RecommendationView[] = card.recommendations.map((rec, i) => {
    const { effect, note } = recommendationEffect(rec);
    return {
      n: i + 1,
      rec,
      effect,
      effectNote: note,
      label: recommendationLabel(card, rec),
      facts: rec.factRefs.map((ref) => ({ key: ref.key, missing: ref.missing === true, fact: evidence.get(ref.key) ?? null })),
    };
  });
  const limitations = limitationItems(card).map((l) => l.text);
  const topMarkers: CardView["topMarkers"] = [];
  // Ступень 4 (Ф8): «в репозитории нет кода» уже сказано в плашке индекса — сверху не повторяется
  if (card.markers.ciConfigOnlyCap) topMarkers.push("ci-cap");
  const base = {
    limitations,
    topMarkers,
    recommendations,
    ladder: ladderView(card, recommendations),
    position: positionView(card),
    noRecommendations: noRecommendationsText(card),
    noRecommendationsKind: noRecommendationsKind(card),
    analysisAt: analysisDate(card),
    visibility: card.repo.visibility,
  };
  if (!score) return { ...base, contributions: [], categories: [], worstKey: null, locked: null, fullPath: null, signIn: false };

  const ctx = submetricContext(score.computedAt);
  const categories: CategoryView[] = CATEGORY_ORDER.filter((k) => score.categories[k] !== undefined && score.categories[k]!.locked === undefined).map((key) => {
    const cat = score.categories[key]!;
    const why = categoryWhy(card, key, ctx);
    const partial = cat.score !== null && cat.no_data ? noDataReason(key, cat.no_data) : null;
    return {
      key,
      title: CATEGORY_TITLES[key],
      score: cat.score,
      scoreText: fmtScore(cat.score),
      chip: { theme: scoreLabelTheme(cat.score), text: cat.score === null ? "Нет данных" : sentence(scoreWord(cat.score)) },
      why,
      stale: cat.stale === true,
      partialNote: partial !== null && partial !== why ? partial : null,
      cohortNote: categoryCohortNote(card, key),
    };
  });
  // худшая категория раскрыта по умолчанию; «нет данных» не плохо — в расчет не идет
  const worst = categories.filter((c) => c.score !== null).sort((a, b) => a.score! - b.score!)[0];
  const auth = card.viewer?.auth;
  return {
    ...base,
    // круг 2 (Е3): на карточке вклад без «+» — это доля итога, а не прибавка (в PDF подпись над сегментом прежняя)
    contributions: contributionBars(card).map((bar) => ({ ...bar, segments: bar.segments.map((s) => ({ ...s, value: s.value.replace(/^\+/, ""), colorClass: categoryColorClass(s.key) })) })),
    categories,
    worstKey: worst?.key ?? null,
    locked: lockedView(card),
    fullPath: score.fullLocked ? fullScorePath(auth, [card.access.cicd, card.access.appsec]) : null,
    signIn: score.fullLocked && (auth === undefined || auth === "no-session"),
  };
}

export { FULL, INDEX };
