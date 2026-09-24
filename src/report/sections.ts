// sections.ts — содержательные части отчета, общие со страницей карточки
// (В4.9, часть 2 гейта, предпосылка круга 1; инвариант 1 «карточка = отчет по
// данным»).
//
// Основание категории, ограничения данных, вклады показателей, таблица
// «правило → подметрика» и слово источника жили в `build.ts`, который
// импортирует значения серверного `src/api/repos.ts`, — бандл web их взять не
// мог, и карточка собирала те же тексты своей копией. Модуль чистый: из API
// здесь только типы, значения — из `categories.ts`, `score/model.ts`,
// `web/format.ts` и словаря подметрик.
import type { CardCategory, CardRecommendation, RepoCard } from "../api/repos";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, SUBWEIGHTS, type CategoryKey } from "../score/model";
import {
  CONTRIBUTIONS_REST,
  CONTRIBUTIONS_TITLE,
  NOT_IN_SCORE,
  categoryContributions,
  contributionsNote,
  fmtContribution,
  closeDateText,
  fmtDate,
  fmtDecimal,
  gitLimitsText,
  lockedCategoryText,
  noDataReason,
  securityNoDataReason,
  type Contributions,
  roundScore,
} from "../web/format";
import { CATEGORY_ORDER, CATEGORY_TITLES } from "./categories";
import { displayOnly, plural, submetricNote, submetricShownValue, submetricTitle, subweightKey, type SubmetricContext } from "./submetrics";

export const INDEX = "HealthCraft Index";
export const FULL = "Repo Health Score";

/** Публичная четверка HealthCraft Index в порядке категорий. */
export const PUBLIC: CategoryKey[] = CATEGORY_ORDER.filter((k) => k in INDEX_WEIGHTS);

/**
 * Номинальные веса категорий показателя — подсказка к числу на карточке
 * (завершающие правки В4.9, пункт 2): пользователь сам проверяет расчет.
 * Та же пара словарей, что строка «Веса …» раздела «Как считается» отчета.
 */
export function metricWeights(name: typeof INDEX | typeof FULL): { key: CategoryKey; title: string; weight: string }[] {
  const keys = name === INDEX ? PUBLIC : CATEGORY_ORDER;
  const weightOf = (k: CategoryKey) => (name === INDEX ? INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS] : SCORE_WEIGHTS[k]);
  return keys.map((key) => ({ key, title: CATEGORY_TITLES[key], weight: `${weightOf(key)}%` }));
}

// ---------- показатели и вклады (К9.1, К9.12) ----------

export interface Metric {
  name: typeof INDEX | typeof FULL;
  value: number | null;
  keys: CategoryKey[];
  weight: (key: CategoryKey) => number;
}

/**
 * Показатели документа в порядке «сначала публичный, потом полный»
 * (решение владельца 22.09, круг 4 гейта): HealthCraft Index считается по
 * открытым данным и идет первым, Repo Health Score — вторым и только там,
 * где зрителю открыты CI/CD и Безопасность. Порядок один для ряда первого
 * экрана, полос вклада, приложений А и Б и раздела «Как считается».
 *
 * Index в списке есть всегда — даже когда его значение NULL: у зрителя с
 * полным доступом слева печатается «Оценки нет», а справа Score со своей
 * полосой (пункт 7 блока А круга 4). Считается и печатается в приложениях
 * только показатель со значением.
 */
export function metricsOf(card: RepoCard): Metric[] {
  const score = card.score!;
  const index: Metric = { name: INDEX, value: score.healthcraftIndex, keys: PUBLIC, weight: (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS] ?? 0 };
  if (score.fullLocked || score.repoHealthScore === null) return [index];
  return [index, { name: FULL, value: score.repoHealthScore, keys: CATEGORY_ORDER, weight: (k) => score.categories[k]?.weight ?? SCORE_WEIGHTS[k] }];
}

/** Показатели, у которых есть значение: только они получают полосу и столбцы приложений. */
export type ShownMetric = Metric & { value: number };

export const withValue = (metrics: Metric[]): ShownMetric[] => metrics.filter((m): m is ShownMetric => m.value !== null);

export function contributionsOf(card: RepoCard, metric: Metric): Contributions | null {
  const cats = card.score!.categories;
  return categoryContributions(
    metric.keys.map((key) => ({ key, title: CATEGORY_TITLES[key], score: cats[key]?.score ?? null, weight: metric.weight(key) })),
    metric.value,
    // 4.3.0 (Н4): вид «кода нет» — из причины «Состояния кода» той же оценки
    { codeEmpty: card.markers.codeEmpty, codeEmptyReason: cats.code?.no_data ?? null },
  );
}

/** Сегмент полосы вклада: `key` — категория (карточка красит сегмент по ключу). */
export interface BarSegment {
  key: string;
  title: string;
  value: string;
  share: number;
}

/** Полоса «Вклад категорий в <показатель>»: сегменты и остаток либо строка вместо полосы. */
export interface ContributionBar {
  title: string;
  segments: BarSegment[];
  rest: { title: string; value: string; share: number } | null;
  note: string | null;
}

/**
 * Полоса вклада — ОДНА сборка для отчета и карточки (А3, инвариант 1):
 * заголовок называет показатель, строка вместо полосы — у потолка 49, пустого
 * репозитория и показателя без категорий с данными.
 */
export function contributionBar(c: Contributions | null, metricName?: string): ContributionBar {
  // п.6 круга 2: в отчете к заголовку добавлен показатель — полоса строится то
  // по Repo Health Score, то по HealthCraft Index, и по ней это должно быть видно
  // п.3 круга 5: показатель прямо в заголовке, без «в оценку – …»
  const title = metricName ? `Вклад категорий в ${metricName}` : CONTRIBUTIONS_TITLE;
  if (c === null) return { title, segments: [], rest: null, note: "Вклады категорий не рассчитаны: у показателя нет категорий с данными." };
  const note = contributionsNote(c);
  if (c.kind !== "bar") return { title, segments: [], rest: null, note };
  return {
    title,
    segments: c.segments.map((s) => ({ key: s.key, title: s.title, value: fmtContribution(s.tenths), share: s.tenths / 1000 })),
    rest: { title: CONTRIBUTIONS_REST, value: String(c.missing), share: c.missing / 100 },
    note: null,
  };
}

/** Полосы вклада показателей со значением — в порядке «сначала публичный». */
export function contributionBars(card: RepoCard): ContributionBar[] {
  return withValue(metricsOf(card)).map((m) => contributionBar(contributionsOf(card, m), m.name));
}

/** Момент анализа — дата шапки отчета и «анализ …» в шапке карточки (А7): расчет оценки, иначе скан. */
export function analysisDate(card: RepoCard): string | null {
  return card.score?.computedAt ?? card.scan?.finishedAt ?? card.scan?.startedAt ?? null;
}

// ---------- основание категории (колонка «Основание») ----------

/**
 * «Почему» у оцененной категории: 1-2 показателя с наименьшим баллом словами
 * словаря подметрик (название – значение); примечание расчета, если оно
 * объясняет балл (трекер пуст); потолок CI — причиной. Без новой методики.
 */
export function whyText(key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): string {
  if (key === "cicd" && cat.no_data) return noDataReason(key, cat.no_data);
  // 4.3.0 (Н5, Р3): поправка к среднему (сжатие малой выборки, потолок) —
  // первая причина балла; «Все показатели на максимуме» при сжатом балле — ложь
  const adjusted = adjustmentText(cat);
  if (adjusted) return adjusted;
  const subs = Object.entries(cat.submetrics);
  for (const [sub, entry] of subs) {
    const remark = submetricNote(key, sub, entry.note)?.remark;
    if (remark) return remark;
  }
  const weakest = subs
    .map(([sub, entry], i) => ({ sub, entry, i }))
    .filter(({ sub, entry }) => !displayOnly(key, sub) && typeof entry.score === "number" && entry.score < 0.995)
    .sort((a, b) => a.entry.score! - b.entry.score! || a.i - b.i)
    .slice(0, 2);
  if (weakest.length === 0) return "Все показатели категории на максимуме.";
  return weakest.map(({ sub, entry }) => `${submetricTitle(key, sub)} – ${submetricShownValue(key, sub, entry, ctx)}.`).join(" ");
}

/**
 * В5.3-М (Н5, Р3, Н14б): поправка к взвешенному среднему категории словами —
 * одна копия для карточки («почему»), разбора категории и приложения А.
 * Сжатие малой выборки задач и потолок «Безопасности» при открытых находках.
 */
export function adjustmentText(cat: Pick<CardCategory, "adjustment" | "score">): string | null {
  const a = cat.adjustment;
  if (!a) return null;
  if (a.kind === "small-sample") {
    const tasks = plural(a.n, "закрытая задача", "закрытые задачи", "закрытых задач");
    return `Малая выборка: ${a.n} ${tasks} из ${a.full} – балл сжат к минимуму ${fmtDecimal(a.floor, 0)}: ${fmtDecimal(a.raw, 1, { trim: true })} → ${fmtDecimal(cat.score ?? a.floor, 1, { trim: true })}.`;
  }
  const what = a.level === "critical" ? "критичные находки AppSec" : "находки AppSec высокой важности";
  return `Есть открытые ${what} – балл категории не выше ${a.limit}.`;
}

/**
 * Основание ЛЮБОЙ категории — колонка «Основание» PDF и вторая строка
 * категории на карточке: закрытая — фраза по доступу зрителя, без данных —
 * причина и опорная фраза, оцененная — `whyText`.
 */
export function categoryWhy(card: RepoCard, key: CategoryKey, ctx: SubmetricContext): string {
  const cat = card.score!.categories[key]!;
  if (cat.locked !== undefined) return lockedCategoryText(cat.locked, card.viewer?.auth);
  if (cat.score === null) {
    const reason = key === "security" ? securityNoDataReason(card.evidence.find((e) => e.key === "appsec.findings")) : noDataReason(key, cat.no_data);
    return `${reason} ${NOT_IN_SCORE}`;
  }
  return whyText(key, cat, ctx);
}

// ---------- ограничения данных (Д4, Д5) ----------

export function closeDateNote(card: RepoCard): string | null {
  const stats = card.evidence.find((e) => e.key === "issues.stats" && e.status === "ok");
  return closeDateText((stats?.value as { close_date_note?: unknown } | null)?.close_date_note);
}

/** Значение факта по ключу — только у факта со статусом «данные есть». */
export function factValue(card: RepoCard, key: string): Record<string, unknown> | null {
  const fact = card.evidence.find((e) => e.key === key && e.status === "ok");
  return fact && fact.value !== null && typeof fact.value === "object" ? (fact.value as Record<string, unknown>) : null;
}

/**
 * А11 аудита: оговорка про обрезанную историю печаталась и там, где обрезки
 * не было. Дата отсечения раньше первого коммита репозитория означает, что
 * окно сбора накрыло всю историю и ничего не потеряно (`fx-anon`: отсечение
 * 16 авг. 2025 при первом коммите 2 окт. 2025). Первый коммит берется из
 * итога истории в самих данных.
 */
export function historyTruncatedSince(card: RepoCard): string | null {
  const since = card.markers.historyTruncatedSince;
  if (!since) return null;
  const first = factValue(card, "activity.git.timeline")?.first;
  if (typeof first === "string" && first !== "" && since < first.slice(0, 10)) return null;
  return since;
}

/**
 * А3 аудита: «Релизы за 12 месяцев – 0» и «Предложения изменений за 90 дней
 * – 0» стоят рядом со счетчиками API, где релизы и предложения есть. Окна
 * считаются по ДАТАМ событий, и когда API их не передал, окно пусто. Балл от
 * этого не становится неверным — это ограничение данных, как `closeDateNote`.
 */
function restDatesNote(card: RepoCard): string | null {
  const rest = factValue(card, "activity.rest");
  if (!rest) return null;
  const gaps: string[] = [];
  const empty = (dates: unknown, counter: unknown): boolean => Array.isArray(dates) && dates.length === 0 && typeof counter === "number" && counter > 0;
  if (empty(rest.releases_released_at, rest.releases)) gaps.push(`релизов по счетчику ${rest.releases}`);
  if (empty(rest.pulls_created_at, rest.pulls_open)) gaps.push(`открытых предложений изменений по счетчику ${rest.pulls_open}`);
  if (gaps.length === 0) return null;
  return `Дат событий SourceCraft не передал: ${gaps.join(", ")}, но без дат в окна «за 90 дней» и «за 12 месяцев» не попадает ничего, поэтому в разборе у них 0.`;
}

/** Вид ограничения — чтобы карточка не повторяла его наверху отдельным предупреждением (А6). */
export type LimitationKind = "close-date" | "rest-dates" | "history" | "stale" | "git-limits";

/** «Ограничения данных» с видом каждого пункта (порядок и текст — как в отчете). */
export function limitationItems(card: RepoCard): { kind: LimitationKind; text: string }[] {
  const out: { kind: LimitationKind; text: string }[] = [];
  const close = closeDateNote(card);
  if (close) out.push({ kind: "close-date", text: close });
  const rest = restDatesNote(card);
  if (rest) out.push({ kind: "rest-dates", text: rest });
  const since = historyTruncatedSince(card);
  if (since) {
    // Г1.7 гейта: причина не в размере репозитория — сервис читает окно истории
    out.push({ kind: "history", text: `История коммитов загружена частично: сервис читает только недавнюю историю – с ${fmtDate(since)}.` });
  }
  if (card.markers.staleFacts) out.push({ kind: "stale", text: "Часть данных взята из прошлого анализа: источник не ответил. Оценка от этого не выросла и не снизилась." });
  if (card.markers.gitLimits) out.push({ kind: "git-limits", text: gitLimitsText(card.markers.gitLimits) });
  return out;
}

/** «Ограничения данных» — только ограничения данных (закрытые категории сюда не входят). */
export function limitations(card: RepoCard): string[] {
  return limitationItems(card).map((l) => l.text);
}

// ---------- рекомендации ----------

/** Правило → показатель разбора, к которому ведет ссылка «действие N». */
export const RULE_SUBMETRIC: Record<string, string> = {
  "license-missing": "documentation.license",
  "contributing-missing": "documentation.contributing",
  "codeowners-missing": "documentation.codeowners",
  "readme-missing": "documentation.readme",
  "readme-sections-missing": "documentation.readme",
  "ci-missing": "cicd.config",
  "ci-no-steps": "cicd.config",
  "grant-ci-runs": "cicd.pass_rate",
  "fix-red-runs": "cicd.pass_rate",
  "speed-up-pipeline": "cicd.duration",
  "appsec-critical": "security.density",
  "start-tracker": "issues.tracker_unused",
  "reduce-stale-issues": "issues.stale",
  "speed-up-issue-close": "issues.close_days",
  "resolve-old-todos": "code.old_share",
};

/** Эффект действия без числа — словами правила (как `actionItem` отчета). */
export function recommendationEffect(rec: CardRecommendation): { effect: string; note: string | null } {
  return { effect: rec.expectedImpact ?? "повысит балл категории", note: rec.deltaScore !== null ? "ожидаемый эффект" : null };
}

const SOURCE_WORDS: [RegExp, string][] = [
  [/^git$/, "история git"],
  [/^rest:/, "API SourceCraft"],
  [/^appsec/, "AppSec SourceCraft"],
];

/** Источник факта словами читателя (сырое имя канала — только если оно не узнано). */
export function sourceWord(source: string): string {
  return SOURCE_WORDS.find(([re]) => re.test(source))?.[1] ?? source;
}

/**
 * Вес показателя внутри категории — колонка «Вес» разбора PDF и таблицы
 * подметрик карточки (круг 2 части 2, Е6): одна копия. Балл категории один
 * для обоих показателей, поэтому и вес подметрики один. Справочные
 * (`displayOnly`) и неизвестные — «—».
 */
export function submetricWeightText(key: CategoryKey, sub: string): string {
  if (displayOnly(key, sub)) return "—";
  const weight = (SUBWEIGHTS[key] as Record<string, number>)[subweightKey(sub)];
  return weight === undefined ? "—" : `${Math.round(weight * 100)}%`;
}

/**
 * Ступень 4 (В-1, §2 23.09): «рекомендаций нет» — по ситуации, одна фраза для
 * карточки и отчета. «Улучшать нечего» — только когда все показанные категории
 * здоровы; есть слабые — рекомендаций для них у движка нет; закрыты CI/CD и
 * Безопасность — их рекомендации видны участникам репозитория.
 */
export function noRecommendationsKind(card: RepoCard): "healthy" | "weak" | "nodata" {
  const shown = Object.values(card.score?.categories ?? {}).filter((c) => c && c.locked === undefined);
  // ревью кода R2: слабость — по ОКРУГЛЕННОМУ баллу, как шкала (69,6 — это «70, здоров»)
  if (shown.some((c) => c!.score !== null && roundScore(c!.score) < 70)) return "weak";
  // нехватка данных — не «улучшать нечего» (tri-state: нет данных ≠ хорошо)
  if (shown.length === 0 || shown.some((c) => c!.score === null)) return "nodata";
  return "healthy";
}

export function noRecommendationsText(card: RepoCard): string {
  const kind = noRecommendationsKind(card);
  const head =
    kind === "healthy"
      ? "Рекомендаций нет – по собранным данным улучшать нечего."
      : kind === "weak"
        ? "Автоматических рекомендаций для этих данных нет."
        : "Автоматических рекомендаций для собранных данных нет: часть данных не собрана.";
  return card.score?.fullLocked === true ? `${head} Рекомендации по CI/CD и Безопасности видны участникам репозитория.` : head;
}
