// Содержательные части отчета, общие со страницей карточки: карточка и отчет
// должны показывать по одним данным одно и то же. Основание категории,
// ограничения данных, вклады показателей, «правило → подметрика», слово источника.
// Модуль чистый, чтобы его мог взять web-бандл: из серверного API здесь только
// типы, значения — из `categories.ts`, `score/model.ts`, `web/format.ts` и
// словаря подметрик.
import type { CardCategory, CardRecommendation, RepoCard } from "../api/repos";
import { INDEX_WEIGHTS, SCORE_WEIGHTS, SUBWEIGHTS, type CategoryKey } from "../score/model";
import {
  CONTRIBUTIONS_REST,
  CONTRIBUTIONS_TITLE,
  NOT_IN_SCORE_LIST,
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
  type ContributionSegment,
  type Contributions,
  roundScore,
  scoreTheme,
  sentence,
} from "../web/format";
import { CATEGORY_ORDER, CATEGORY_TITLES } from "./categories";
import { displayOnly, plural, submetricNote, submetricShownValue, submetricTitle, subweightKey, type SubmetricContext } from "./submetrics";

export const INDEX = "HealthCraft Index";
export const FULL = "Repo Health Score";

/** Публичная четверка HealthCraft Index в порядке категорий. */
export const PUBLIC: CategoryKey[] = CATEGORY_ORDER.filter((k) => k in INDEX_WEIGHTS);

/**
 * Номинальные веса категорий показателя — подсказка к числу на карточке, чтобы
 * пользователь мог сам проверить расчет. Те же словари, что в строке «Веса …»
 * раздела «Как считается» отчета.
 */
export function metricWeights(name: typeof INDEX | typeof FULL): { key: CategoryKey; title: string; weight: string }[] {
  const keys = name === INDEX ? PUBLIC : CATEGORY_ORDER;
  const weightOf = (k: CategoryKey) => (name === INDEX ? INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS] : SCORE_WEIGHTS[k]);
  return keys.map((key) => ({ key, title: CATEGORY_TITLES[key], weight: `${weightOf(key)}%` }));
}

// ---------- показатели и вклады ----------

export interface Metric {
  name: typeof INDEX | typeof FULL;
  value: number | null;
  keys: CategoryKey[];
  weight: (key: CategoryKey) => number;
}

/**
 * Показатели документа в порядке «сначала публичный, потом полный»: HealthCraft
 * Index считается по открытым данным и идет первым, Repo Health Score — вторым и
 * только там, где зрителю открыты CI/CD и Безопасность. Порядок один для первого
 * экрана, полос вклада, приложений А и Б и раздела «Как считается».
 *
 * Index в списке есть всегда, даже со значением NULL: у зрителя с полным доступом
 * слева печатается «Оценки нет», а справа Score со своей полосой. Полосы и
 * столбцы приложений получает только показатель со значением.
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
    // вид «кода нет» — из причины «Состояния кода» той же оценки
    { codeEmpty: card.markers.codeEmpty, codeEmptyReason: cats.code?.no_data ?? null },
  );
}

/**
 * Сегмент полосы вклада: `key` — категория (карточка красит сегмент по ключу);
 * `hint` — подсказка карточки при наведении: только то, чего на экране нет.
 */
export interface BarSegment {
  key: string;
  title: string;
  value: string;
  share: number;
  hint: BarHint;
}

/**
 * Подсказка сегмента: заголовок (что это), строка значений и число тише нее (без
 * разделителя «·»). Читается без взгляда на легенду.
 */
export interface BarHint {
  title: string;
  main: string;
  muted: string | null;
}

/** Строка подсказки без заголовка — для имени пункта легенды у скринридера (заголовок там уже есть). */
export const hintText = (h: BarHint): string => (h.muted ? `${h.main}, ${h.muted}` : h.main);

/** Полоса «Вклад категорий в <показатель>»: сегменты и остаток либо строка вместо полосы. */
export interface ContributionBar {
  title: string;
  segments: BarSegment[];
  rest: { title: string; value: string; share: number; hint: BarHint | null } | null;
  note: string | null;
}

/**
 * Подсказка сегмента: категория, ее вклад из потолка (вес среди категорий с данными
 * × 100) и тише — доля в набранном: «Документация» / «12,5 из 23,0» «15% оценки».
 */
export function segmentHint(s: ContributionSegment, total: number, percent: number | null = total > 0 ? Math.round((s.tenths / (total * 10)) * 100) : null): BarHint {
  return {
    title: s.title,
    main: `${fmtDecimal(s.tenths / 10, 1)} из ${fmtDecimal(s.share * 100, 1)}`,
    muted: percent !== null ? `${percent}% оценки` : null,
  };
}

/**
 * Доли вкладов в оценке целыми процентами с суммой ровно 100 — методом наибольшего
 * остатка, как сами вклады: округление каждой доли отдельно давало 99% или 101%.
 */
export function sharePercents(segments: ContributionSegment[]): number[] {
  const sum = segments.reduce((acc, s) => acc + s.tenths, 0);
  if (sum === 0) return segments.map(() => 0);
  const raw = segments.map((s) => (s.tenths / sum) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]! += 1;
  return out;
}

/** Подсказка «не набрано»: «Не набрано 16» / «больше всего – Документация» «10,5». */
export function restHint(losses: ContributionSegment[], missing: number): BarHint | null {
  const top = losses[0];
  return top ? { title: `${sentence(CONTRIBUTIONS_REST)} ${missing}`, main: `больше всего – ${top.title}`, muted: fmtDecimal(top.loss, 1) } : null;
}

/**
 * Полоса вклада — одна сборка для отчета и карточки. Заголовок называет
 * показатель; строка вместо полосы — у потолка 49, пустого репозитория и
 * показателя без категорий с данными.
 */
export function contributionBar(c: Contributions | null, metricName?: string): ContributionBar {
  // полоса строится то по Repo Health Score, то по HealthCraft Index — заголовок
  // называет показатель, чтобы было видно, по какому
  const title = metricName ? `Вклад категорий в ${metricName}` : CONTRIBUTIONS_TITLE;
  if (c === null) return { title, segments: [], rest: null, note: "Вклады категорий не рассчитаны: у показателя нет категорий с данными." };
  const note = contributionsNote(c);
  if (c.kind !== "bar") return { title, segments: [], rest: null, note };
  const percents = c.total > 0 ? sharePercents(c.segments) : null;
  return {
    title,
    segments: c.segments.map((s, i) => ({ key: s.key, title: s.title, value: fmtContribution(s.tenths), share: s.tenths / 1000, hint: segmentHint(s, c.total, percents ? percents[i]! : null) })),
    rest: { title: CONTRIBUTIONS_REST, value: String(c.missing), share: c.missing / 100, hint: restHint(c.losses, c.missing) },
    note: null,
  };
}

/** Полосы вклада показателей со значением — в порядке «сначала публичный». */
export function contributionBars(card: RepoCard): ContributionBar[] {
  return withValue(metricsOf(card)).map((m) => contributionBar(contributionsOf(card, m), m.name));
}

/** Момент анализа — дата шапки отчета и «анализ …» в шапке карточки: расчет оценки, иначе скан. */
export function analysisDate(card: RepoCard): string | null {
  return card.score?.computedAt ?? card.scan?.finishedAt ?? card.scan?.startedAt ?? null;
}

// ---------- основание категории (колонка «Основание») ----------

/**
 * «Почему» у оцененной категории: 1-2 показателя с наименьшим баллом словами
 * словаря подметрик (название – значение); у здоровой категории перед ними —
 * сильная сторона; примечание расчета, если оно объясняет балл (трекер пуст);
 * потолок CI — причиной.
 */
export function whyText(key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): string {
  if (key === "cicd" && cat.no_data) return noDataReason(key, cat.no_data);
  // оцененная категория без подметрик — «кода нет» (балл 0 как факт о репо):
  // основание — причина пустоты, а не «все на максимуме»
  if (cat.no_data && Object.keys(cat.submetrics).length === 0) return noDataReason(key, cat.no_data);
  // поправка к среднему (сжатие малой выборки, потолок) — первая причина балла:
  // «Все показатели на максимуме» при сниженном балле было бы неправдой
  const adjusted = adjustmentText(cat);
  if (adjusted) return adjusted;
  const subs = Object.entries(cat.submetrics);
  for (const [sub, entry] of subs) {
    // оговорка справочного показателя (время слияния PR) — не основание балла
    if (displayOnly(key, sub)) continue;
    const remark = submetricNote(key, sub, entry.note)?.remark;
    if (remark) return remark;
  }
  const scored = subs.map(([sub, entry], i) => ({ sub, entry, i })).filter(({ sub, entry }) => !displayOnly(key, sub) && typeof entry.score === "number");
  const weakest = scored
    .filter(({ entry }) => entry.score! < 0.995)
    .sort((a, b) => a.entry.score! - b.entry.score! || a.i - b.i)
    .slice(0, 2);
  if (weakest.length === 0) return "Все показатели категории на максимуме.";
  const shown = ({ sub, entry }: (typeof scored)[number]): string => `${submetricTitle(key, sub)} – ${submetricShownValue(key, sub, entry, ctx)}`;
  // у здоровой категории основание из одних слабых показателей спорило бы с
  // зеленой плашкой, поэтому первой идет сильная сторона — показатель с
  // наибольшим баллом, строго выше слабых; если такого нет — только слабые
  if (scoreTheme(cat.score) === "success") {
    const ceiling = Math.max(...weakest.map(({ entry }) => entry.score!));
    const strongest = scored.filter((e) => !weakest.includes(e) && e.entry.score! > ceiling + 1e-9).sort((a, b) => b.entry.score! - a.entry.score! || a.i - b.i)[0];
    if (strongest) return `Сильная сторона: ${shown(strongest)}. Слабее: ${weakest.map(shown).join("; ")}.`;
  }
  return weakest.map((w) => `${shown(w)}.`).join(" ");
}

/** Короткая метка поправки балла для ячейки сравнения. */
export function adjustmentLabel(cat: Pick<CardCategory, "adjustment">): string {
  const a = cat.adjustment;
  if (a?.kind === "small-sample") return "Мало задач";
  if (a?.kind === "small-code") return "Мало кода";
  return "Есть находки";
}

/**
 * Причина поправки без чисел балла — вторая строка категории на карточке: балл
 * стоит рядом, а величина поправки — строкой в раскрытии.
 */
export function adjustmentReason(cat: Pick<CardCategory, "adjustment">): string | null {
  const a = cat.adjustment;
  if (!a) return null;
  if (a.kind === "small-sample") return a.n === 0 ? "Ни одна задача не закрыта" : `Мало закрытых задач: ${a.n} из ${a.full} нужных для надежной оценки`;
  if (a.kind === "small-code") return `Мало кода: ${a.loc} из ${a.full} ${plural(a.full, "строки", "строк", "строк")} для надежной оценки`;
  return `Есть открытые ${a.level === "critical" ? "критичные находки AppSec" : "находки AppSec высокой важности"} – балл категории не выше ${a.limit}`;
}

/**
 * Поправка к взвешенному среднему категории словами — одна копия для карточки
 * («почему»), разбора категории и приложения А: сжатие малой выборки задач,
 * сжатие малого кода к середине шкалы, потолок «Безопасности» при открытых находках.
 */
export function adjustmentText(cat: Pick<CardCategory, "adjustment" | "score">): string | null {
  const a = cat.adjustment;
  if (!a) return null;
  if (a.kind === "small-sample") {
    // ни одной засчитанной закрытой задачи — отдельная фраза, а не «0 из 10»
    if (a.n === 0) return `Ни одна задача не закрыта – балл категории минимальный: ${fmtDecimal(cat.score ?? a.floor, 0)}.`;
    return `Мало закрытых задач: ${a.n} из ${a.full} нужных для надежной оценки – балл снижен с ${fmtDecimal(a.raw, 1, { trim: true })} до ${fmtDecimal(cat.score ?? a.floor, 1, { trim: true })}.`;
  }
  if (a.kind === "small-code") {
    const lines = plural(a.full, "строки", "строк", "строк");
    return `Мало кода: ${a.loc} из ${a.full} ${lines} для надежной оценки – балл снижен с ${fmtDecimal(a.raw, 1, { trim: true })} до ${fmtDecimal(cat.score ?? a.center, 1, { trim: true })}, ближе к середине шкалы.`;
  }
  const what = a.level === "critical" ? "критичные находки AppSec" : "находки AppSec высокой важности";
  return `Есть открытые ${what} – балл категории не выше ${a.limit}.`;
}

/**
 * Основание любой категории — колонка «Основание» PDF и вторая строка
 * категории на карточке: закрытая — фраза по доступу зрителя, без данных —
 * причина, оцененная — `whyText`. Опорная фраза «не участвует и не снижает» —
 * одна на список (`notInScoreNote`), а не у каждой строки.
 */
export function categoryWhy(card: RepoCard, key: CategoryKey, ctx: SubmetricContext): string {
  const cat = card.score!.categories[key]!;
  if (cat.locked !== undefined) return lockedCategoryText(cat.locked, card.viewer?.auth);
  if (cat.score === null) {
    const reason = key === "security" ? securityNoDataReason(card.evidence.find((e) => e.key === "appsec.findings")) : noDataReason(key, cat.no_data);
    return reason;
  }
  return whyText(key, cat, ctx);
}

/**
 * «Категории без данных в оценке не участвуют» — один раз на список, если такие
 * категории есть. У пустого репозитория фразы нет: оценка 0 по правилу методики,
 * «не снижает» там было бы неправдой.
 */
export function notInScoreNote(card: RepoCard): string | null {
  if (card.markers.codeEmpty) return null;
  const cats = Object.values(card.score?.categories ?? {});
  return cats.some((c) => c.locked === undefined && c.score === null) ? NOT_IN_SCORE_LIST : null;
}

// ---------- ограничения данных ----------

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
 * Дата отсечения истории, если история действительно обрезана. Отсечение раньше
 * первого коммита репозитория означает, что окно сбора накрыло всю историю и
 * ничего не потеряно — тогда оговорка не нужна. Первый коммит берется из итога
 * истории в самих данных.
 */
export function historyTruncatedSince(card: RepoCard): string | null {
  const since = card.markers.historyTruncatedSince;
  if (!since) return null;
  const first = factValue(card, "activity.git.timeline")?.first;
  if (typeof first === "string" && first !== "" && since < first.slice(0, 10)) return null;
  return since;
}

/**
 * «Релизы за 12 месяцев – 0» рядом со счетчиком API, где релизы есть, выглядит
 * как ошибка: окна считаются по датам событий, и если API их не передал, окно
 * пусто. Балл от этого не становится неверным — это ограничение данных, как
 * `closeDateNote`.
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

/** Вид ограничения — чтобы карточка не повторяла его наверху отдельным предупреждением. */
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
    // причина не в размере репозитория: сервис читает только окно истории
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
  "appsec-high": "security.density",
  "add-tests": "code.tests",
  "start-tracker": "issues.tracker_unused",
  "reduce-stale-issues": "issues.stale",
  "speed-up-issue-close": "issues.close_days",
  "resolve-old-todos": "code.old_share",
};

/** Эффект действия без числа — словами правила (как `actionItem` отчета). */
export function recommendationEffect(rec: CardRecommendation): { effect: string; note: string | null } {
  return { effect: rec.expectedImpact ?? "повысит балл категории", note: rec.deltaScore !== null ? "Ожидаемый эффект" : null };
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
 * подметрик карточки, одна копия. Балл категории один
 * для обоих показателей, поэтому и вес подметрики один. Справочные
 * (`displayOnly`) и неизвестные — «–».
 */
export function submetricWeightText(key: CategoryKey, sub: string): string {
  if (displayOnly(key, sub)) return "–";
  const weight = (SUBWEIGHTS[key] as Record<string, number>)[subweightKey(sub)];
  return weight === undefined ? "–" : `${Math.round(weight * 100)}%`;
}

/**
 * «Рекомендаций нет» — по ситуации, одна фраза для карточки и отчета.
 * «Улучшать нечего» — только когда все показанные категории здоровы; есть
 * слабые — значит, у движка для них нет правил. О закрытых CI/CD и Безопасности
 * фраза не говорит: это сказано один раз под категориями.
 */
export function noRecommendationsKind(card: RepoCard): "healthy" | "weak" | "nodata" {
  const shown = Object.values(card.score?.categories ?? {}).filter((c) => c && c.locked === undefined);
  // слабость — по округленному баллу, как у шкалы (69,6 — это «70, здоров»)
  if (shown.some((c) => c!.score !== null && roundScore(c!.score) < 70)) return "weak";
  // нехватка данных — не «улучшать нечего» (tri-state: нет данных ≠ хорошо)
  if (shown.length === 0 || shown.some((c) => c!.score === null)) return "nodata";
  return "healthy";
}

/**
 * Сильные и слабые стороны одной короткой строкой под заголовком
 * «Категории», одна копия для карточки и MD/PDF. Участвуют только показанные
 * категории с данными (закрытые и «нет данных» — нет), по округленному баллу, как
 * у шкалы: сильные — до 2 лучших от 70, слабые — до 2 худших ниже 70 (не «требует
 * внимания»: шкала так называет только 40–69). Пустая часть не печатается. У
 * пустого репо (`codeEmpty`) строки нет — оценивать нечего.
 */
export function strengthsLine(card: RepoCard): string | null {
  const score = card.score;
  if (!score || card.markers.codeEmpty) return null;
  const shown = CATEGORY_ORDER.map((key) => ({ key, cat: score.categories[key] }))
    .filter((e): e is { key: CategoryKey; cat: CardCategory } => e.cat !== undefined && e.cat.locked === undefined && e.cat.score !== null)
    .map((e) => ({ key: e.key, value: roundScore(e.cat.score!) }));
  const name = (key: CategoryKey): string => {
    const t = CATEGORY_TITLES[key];
    // «CI/CD» — аббревиатура, регистр не меняется
    return t.length > 1 && t[1] === t[1]!.toUpperCase() && t[1] !== t[1]!.toLowerCase() ? t : t.charAt(0).toLowerCase() + t.slice(1);
  };
  const strong = shown.filter((e) => e.value >= 70).sort((a, b) => b.value - a.value).slice(0, 2);
  const weak = shown.filter((e) => e.value < 70).sort((a, b) => a.value - b.value).slice(0, 2);
  const parts: string[] = [];
  if (strong.length > 0) parts.push(`Сильные стороны: ${strong.map((e) => name(e.key)).join(", ")}.`);
  if (weak.length > 0) parts.push(`Слабые стороны: ${weak.map((e) => name(e.key)).join(", ")}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function noRecommendationsText(card: RepoCard): string {
  const kind = noRecommendationsKind(card);
  // закрытые зрителю CI/CD и Безопасность в «здоров» не входят — о них не утверждаем
  const which = card.score?.fullLocked === true ? "все открытые категории" : "все категории";
  return kind === "healthy"
    ? `Рекомендаций нет: ${which} в зоне «Здоров». Оставшиеся баллы не добрать разовым действием – они растут вместе с активностью проекта.`
    : kind === "weak"
      ? "Автоматических рекомендаций для этих данных нет."
      : "Автоматических рекомендаций для собранных данных нет: часть данных не собрана.";
}

// ---------- карта владельцев файлов ----------

/** Строка карты владельцев: каталог, главный автор (имя из git, без email), доля, авторов. */
export interface OwnershipRow {
  dir: string;
  owner: string;
  share: string;
  authors: string;
  /** главный автор сделал не меньше порога изменений каталога */
  single: boolean;
  /** изменений каталога за окно */
  changes: number;
  /** подкаталоги (ветви дерева на карточке); пусто — анализ старым сборщиком или подкаталогов нет */
  children: OwnershipRow[];
  /** доли главных авторов (до 3) по убыванию; у старого сборщика — только владелец */
  shares: { name: string; share: number }[];
}

export interface OwnershipView {
  caption: string;
  rows: OwnershipRow[];
  notes: string[];
  /** оговорки для карточки: полнота обхода, без определения порога и CODEOWNERS */
  cardNotes: string[];
  /** порог «единственного владельца», % */
  thresholdPct: number;
}

/** Подпись каталога: корзина файлов корня (`.`) — словами. */
export function ownershipDirTitle(dir: string): string {
  return dir === "." ? "(файлы в корне)" : dir;
}

/**
 * Карта владельцев — одна сборка для карточки и MD/PDF: значение справочной
 * подметрики `code.ownership` (агрегат факта и признак CODEOWNERS). Нет карты
 * (старый сборщик, изменений за год нет, данные не собраны) — null: строка
 * подметрики сама говорит почему.
 */
export function ownershipView(cat: CardCategory | undefined): OwnershipView | null {
  const value = cat?.submetrics?.["ownership"]?.value as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== "object") return null;
  const dirs = Array.isArray(value.dirs) ? (value.dirs as Record<string, unknown>[]) : [];
  if (dirs.length === 0) return null;
  const threshold = typeof value.threshold === "number" ? value.threshold : 0.8;
  const rowOf = (d: Record<string, unknown>): OwnershipRow => {
    const share = typeof d.owner_share === "number" ? d.owner_share : 0;
    const authors = typeof d.authors === "number" ? d.authors : 0;
    return {
      dir: ownershipDirTitle(String(d.dir ?? "")),
      owner: String(d.owner ?? ""),
      share: `${Math.round(share * 100)}%`,
      authors: String(authors),
      single: share >= threshold,
      changes: typeof d.changes === "number" ? d.changes : 0,
      children: Array.isArray(d.children) ? (d.children as Record<string, unknown>[]).map(rowOf) : [],
      shares: Array.isArray(d.top_authors)
        ? (d.top_authors as Record<string, unknown>[]).filter((a) => typeof a.share === "number").map((a) => ({ name: String(a.name ?? ""), share: a.share as number }))
        : [{ name: String(d.owner ?? ""), share }],
    };
  };
  const rows: OwnershipRow[] = dirs.map(rowOf);
  const total = typeof value.dirs_total === "number" ? value.dirs_total : rows.length;
  const singles = typeof value.dirs_single_owner === "number" ? value.dirs_single_owner : rows.filter((r) => r.single).length;
  const windowDays = typeof value.window_days === "number" ? value.window_days : 365;
  const notes: string[] = [
    `Единственный владелец – у ${singles} из ${total} ${plural(total, "каталога", "каталогов", "каталогов")}: главный автор сделал не меньше ${Math.round(threshold * 100)}% изменений каталога. Изменение – коммит человека за ${windowDays} ${plural(windowDays, "день", "дня", "дней")} без слияний, тронувший файл кода; коммиты роботов не учитываются.`,
  ];
  // карточке — только оговорки о полноте; определение порога и CODEOWNERS она не повторяет
  const cardNotes: string[] = [];
  if (total > rows.length) cardNotes.push(`Показаны ${rows.length} самых изменяемых каталогов из ${total}.`);
  if (value.truncated === "commits") cardNotes.push("Коммитов за год больше бюджета обхода – учтены только самые свежие.");
  if (value.truncated === "changes") cardNotes.push("Изменений за год больше бюджета обхода – учтена только часть.");
  if (typeof value.history_since === "string") cardNotes.push(`История загружена с ${fmtDate(value.history_since)} – окно короче года.`);
  if (total > rows.length) notes.push(`Показаны ${rows.length} самых изменяемых каталогов из ${total}.`);
  if (value.truncated === "commits") notes.push("Коммитов за год больше бюджета обхода – учтены только самые свежие.");
  if (value.truncated === "changes") notes.push("Изменений за год больше бюджета обхода – учтена только часть.");
  if (typeof value.history_since === "string") notes.push(`История загружена с ${fmtDate(value.history_since)} – окно короче года.`);
  if (value.codeowners === true) notes.push("В репозитории есть CODEOWNERS.");
  if (value.codeowners === false) notes.push("CODEOWNERS в репозитории нет.");
  return { caption: "Карта владельцев файлов (справочно, в балл не входит)", rows, notes, cardNotes, thresholdPct: Math.round(threshold * 100) };
}
