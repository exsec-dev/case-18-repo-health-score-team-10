// pr-review.ts — В5.5 тур 2, W4 (ТЗ §7, ЗН-2): review и bottlenecks
// предложений изменений (PR). Справочный показатель категории «Активность»
// (DISPLAY_ONLY, без веса): индекс, полный Score, покрытие и рекомендации от
// него не зависят (TASK.md §2 «В5.5 — тур 2», п.3).
//
// Выборка — по образцу `issues.comments_sample` (rest.ts): до
// PR_REVIEW_SAMPLE последних PR (не черновиков) из уже полученного списка
// `/pulls` (порядок -created_at, клиентская сортировка устойчива к игнору
// сервером); на PR — 1 страница комментариев и 1 страница ревьюеров.
// Бюджет запросов на репо — PR_REQUEST_BUDGET = 20 (0, если PR нет), меньше
// выборки комментариев задач (до 50 запросов при commentsTopN = 50).
// Любой сбой запроса выборки — урезанная выборка не выдается за данные:
// факт `bad` (или `no-data` access), как у `issues.comments_sample`.
// Нет PR — это данные «PR не используются» (`pulls: 0`), а не «нет данных».
//
// Перечисления спеки (правило AGENTS.md 22.09) — каждое значение своей веткой:
// `PullRequest.Status` (draft, open, discarded, merging, merged),
// `ReviewDecision` (approve, trust, block, abstain), `PullRequestComment.Type`
// (default, appsec); «прочее» — явная ветка `unknown`, названная в факте.
import { Fact, badChannelFact, noDataFact, okFact } from "./facts";
import type { ChannelKind } from "./rest";

/** Размер выборки PR для времени первого ответа и комментариев ревью. */
export const PR_REVIEW_SAMPLE = 10;
/** Страница комментариев PR (одна): у `sort_by` спеки нет `created_at`, берется минимум страницы. */
export const PR_COMMENTS_PAGE = 50;
/** Страница ревьюеров PR (одна). */
export const PR_REVIEWERS_PAGE = 50;
/** Бюджет запросов на репо: комментарии + ревьюеры на каждый PR выборки. */
export const PR_REQUEST_BUDGET = PR_REVIEW_SAMPLE * 2;
/** Порог bottleneck: открытый PR без ответа ревьюера дольше 72 ч (3 дня — рабочий день ревью с запасом на выходные). */
export const PR_BOTTLENECK_H = 72;
/** Кап слитых PR для медианы времени до слияния (как кап событийных дат activity.rest). */
export const PR_MERGE_TOP_N = 50;

export type PrStatus = "draft" | "open" | "merging" | "merged" | "discarded" | "unknown";

/** `PullRequest.Status` спеки — каждое значение своей веткой; иное — `unknown`. */
export function prStatusClass(status: unknown): PrStatus {
  switch (status) {
    case "draft":
      return "draft";
    case "open":
      return "open";
    case "merging":
      return "merging";
    case "merged":
      return "merged";
    case "discarded":
      return "discarded";
    default:
      return "unknown";
  }
}

export type ReviewDecisionClass = "approve" | "trust" | "block" | "abstain" | "pending" | "unknown";

/**
 * `ReviewDecision` спеки. Нет решения (поле опущено или null — «снят» в
 * событии `PullRequestReviewDecision`) — `pending`: ревьюер назначен, но не
 * ответил. Ответом ревьюера считаются approve, trust и block; abstain —
 * ревьюер отказался от ревью, PR по-прежнему ждет ответа (своя ветка).
 */
export function reviewDecisionClass(decision: unknown): ReviewDecisionClass {
  switch (decision) {
    case "approve":
      return "approve";
    case "trust":
      return "trust";
    case "block":
      return "block";
    case "abstain":
      return "abstain";
    case undefined:
    case null:
    case "":
      return "pending";
    default:
      return "unknown";
  }
}

export type PrCommentType = "default" | "appsec" | "unknown";

/**
 * `PullRequestComment.Type` спеки. Поле опущено — `default` (proto3 не печатает
 * значение перечисления по умолчанию). `appsec` — комментарий сканера
 * безопасности, не ответ человека-ревьюера: в ответы и счет ревью не идет.
 */
export function prCommentTypeClass(type: unknown): PrCommentType {
  switch (type) {
    case undefined:
    case null:
    case "":
    case "default":
      return "default";
    case "appsec":
      return "appsec";
    default:
      return "unknown";
  }
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Внешний пользователь спеки: id/slug = «<external-user>» у всех внешних — различить их нельзя. */
const EXTERNAL_USER = "<external-user>";

/** Ключ пользователя (`UserEmbedded`): id, иначе slug; внешний и пустой — null (личность неизвестна). */
function userKey(user: unknown): string | null {
  const u = user as { id?: unknown; slug?: unknown } | null | undefined;
  const key = asString(u?.id) ?? asString(u?.slug);
  if (key === null || key === "" || key === EXTERNAL_USER) return null;
  return key;
}

/** Ответ не автора: оба известны и различны. Внешнего или безымянного автора ответа не отличить от автора PR — не засчитывается. */
function isOtherUser(user: unknown, prAuthor: string | null): boolean {
  const key = userKey(user);
  return key !== null && prAuthor !== null && key !== prAuthor;
}

/** Результат одной страницы ресурса выборки (минимум `ResourceOutcome` rest.ts). */
export interface PrPage {
  kind: ChannelKind;
  status: number;
  items: Record<string, unknown>[];
  /** в ответе есть следующая страница — счет комментариев «не меньше» */
  hasMore: boolean;
}

export type PrFetch = (resource: "pull-comments" | "pull-reviewers", pullSlug: string) => Promise<PrPage>;

/** Итог одного PR выборки — вход агрегатора (чистая функция, тестируется на данных). */
export interface PrSampleEntry {
  status: PrStatus;
  createdMs: number | null;
  /** первый ответ ревьюера (мс): комментарий или решение approve/trust/block не автора */
  firstResponseMs: number | null;
  reviewComments: number;
  commentsCapped: boolean;
  appsecComments: number;
  unknownCommentTypes: string[];
  decisions: Record<ReviewDecisionClass, number>;
  unknownDecisions: string[];
}

const emptyDecisions = (): Record<ReviewDecisionClass, number> => ({ approve: 0, trust: 0, block: 0, abstain: 0, pending: 0, unknown: 0 });

/** Разбор одного PR по страницам комментариев и ревьюеров. */
export function prSampleEntry(pr: Record<string, unknown>, comments: Record<string, unknown>[], reviewers: Record<string, unknown>[], commentsCapped: boolean): PrSampleEntry {
  const author = userKey(pr["author"]);
  const createdMs = isoMs(pr["created_at"]);
  const responses: number[] = [];
  let reviewComments = 0;
  let appsecComments = 0;
  const unknownTypes = new Set<string>();
  for (const c of comments) {
    // удаленные и неопубликованные (черновики ревью) — не ответ
    if (c["is_deleted"] === true || c["is_published"] === false) continue;
    const type = prCommentTypeClass(c["type"]);
    if (type === "appsec") {
      appsecComments++;
      continue;
    }
    if (type === "unknown") {
      unknownTypes.add(String(c["type"]));
      continue;
    }
    if (!isOtherUser(c["author"], author)) continue;
    reviewComments++;
    const t = isoMs(c["created_at"]);
    if (t !== null && (createdMs === null || t >= createdMs)) responses.push(t);
  }
  const decisions = emptyDecisions();
  const unknownDecisions = new Set<string>();
  for (const r of reviewers) {
    const d = reviewDecisionClass(r["review_decision"]);
    decisions[d]++;
    if (d === "unknown") unknownDecisions.add(String(r["review_decision"]));
    if (d !== "approve" && d !== "trust" && d !== "block") continue;
    if (!isOtherUser(r["user"], author)) continue;
    // момент решения: updated_at записи ревьюера (created_at — назначение)
    const t = isoMs(r["updated_at"]) ?? isoMs(r["created_at"]);
    if (t !== null && (createdMs === null || t >= createdMs)) responses.push(t);
  }
  return {
    status: prStatusClass(pr["status"]),
    createdMs,
    firstResponseMs: responses.length > 0 ? Math.min(...responses) : null,
    reviewComments,
    commentsCapped,
    appsecComments,
    unknownCommentTypes: [...unknownTypes],
    decisions,
    unknownDecisions: [...unknownDecisions],
  };
}

/** Выбор PR для выборки: не черновики известного статуса, свежие первыми. */
export function selectPrSample(pulls: Record<string, unknown>[]): { sample: Record<string, unknown>[]; statuses: Record<PrStatus, number>; unknownStatuses: string[] } {
  const statuses: Record<PrStatus, number> = { draft: 0, open: 0, merging: 0, merged: 0, discarded: 0, unknown: 0 };
  const unknown = new Set<string>();
  const candidates: Record<string, unknown>[] = [];
  for (const p of pulls) {
    const st = prStatusClass(p["status"]);
    statuses[st]++;
    if (st === "unknown") {
      unknown.add(String(p["status"] ?? "missing"));
      continue;
    }
    // черновик на ревью не отправлен — ответа ревьюера не ждет (явная ветка)
    if (st === "draft") continue;
    candidates.push(p);
  }
  const sample = candidates
    .map((p, i) => ({ p, i, t: isoMs(p["created_at"]) }))
    .sort((a, b) => (b.t ?? -Infinity) - (a.t ?? -Infinity) || a.i - b.i)
    .slice(0, PR_REVIEW_SAMPLE)
    .map((x) => x.p);
  return { sample, statuses, unknownStatuses: [...unknown] };
}

/**
 * Время до слияния — по ВСЕМ полученным слитым PR (без запросов): у
 * `PullRequest` спеки нет даты слияния, момент слияния приближается
 * `updated_at` (последнее изменение PR) — оговорка в факте (`merge_time_basis`).
 */
export function mergeHours(pulls: Record<string, unknown>[]): { merged: number; median: number | null } {
  const merged = pulls.filter((p) => prStatusClass(p["status"]) === "merged");
  const hours = merged
    .map((p) => ({ c: isoMs(p["created_at"]), u: isoMs(p["updated_at"]) }))
    .filter((x): x is { c: number; u: number } => x.c !== null && x.u !== null && x.u >= x.c)
    .sort((a, b) => b.c - a.c)
    .slice(0, PR_MERGE_TOP_N)
    .map((x) => (x.u - x.c) / 3_600_000);
  const m = median(hours);
  return { merged: merged.length, median: m === null ? null : round1(m) };
}

/** Значение факта `activity.pr_review` по разобранной выборке (чистая функция). */
export function aggregatePrReview(pulls: Record<string, unknown>[], entries: PrSampleEntry[], now: Date, requests: number): Record<string, unknown> {
  const { statuses, unknownStatuses } = selectPrSample(pulls);
  const answered = entries.filter((e) => e.firstResponseMs !== null && e.createdMs !== null);
  const delays = answered.map((e) => (e.firstResponseMs! - e.createdMs!) / 3_600_000);
  // bottleneck: открытый PR, ждущий ПЕРВОГО ответа дольше порога. merging —
  // уже сливается (решение принято), merged/discarded — закрыты
  const open = entries.filter((e) => e.status === "open");
  const waiting = open.filter((e) => e.firstResponseMs === null && e.createdMs !== null && now.getTime() - e.createdMs >= PR_BOTTLENECK_H * 3_600_000);
  const decisions = emptyDecisions();
  for (const e of entries) for (const [k, n] of Object.entries(e.decisions)) decisions[k as ReviewDecisionClass] += n;
  const unknownTypes = [...new Set(entries.flatMap((e) => e.unknownCommentTypes))];
  const unknownDecisions = [...new Set(entries.flatMap((e) => e.unknownDecisions))];
  const merge = mergeHours(pulls);
  const medianDelay = median(delays);
  const medianComments = median(entries.map((e) => e.reviewComments));
  return {
    pulls: pulls.length,
    statuses,
    ...(unknownStatuses.length ? { status_note: `unknown pull statuses: ${unknownStatuses.slice(0, 3).join(", ")}` } : {}),
    sampled: entries.length,
    answered: answered.length,
    median_first_response_hours: medianDelay === null ? null : round1(medianDelay),
    open_sampled: open.length,
    waiting_over_threshold: waiting.length,
    threshold_hours: PR_BOTTLENECK_H,
    review_comments_total: entries.reduce((s, e) => s + e.reviewComments, 0),
    median_review_comments: medianComments,
    // у PR с полной страницей комментариев счет — «не меньше»
    comments_capped: entries.filter((e) => e.commentsCapped).length,
    appsec_comments: entries.reduce((s, e) => s + e.appsecComments, 0),
    ...(unknownTypes.length ? { comment_type_note: `unknown comment types: ${unknownTypes.slice(0, 3).join(", ")}` } : {}),
    decisions,
    ...(unknownDecisions.length ? { decision_note: `unknown review decisions: ${unknownDecisions.slice(0, 3).join(", ")}` } : {}),
    merged: merge.merged,
    median_merge_hours: merge.median,
    merge_time_basis: "updated_at",
    requests,
  };
}

/**
 * Сбор `activity.pr_review` по уже полученному списку PR. `fetch` — шов
 * rest.ts (fetchResource на 1 страницу). Возвращает факт и первый сбой
 * канала (для `channelErrors`, как у выборки комментариев задач).
 */
export async function collectPrReview(
  pulls: Record<string, unknown>[],
  fetch: PrFetch,
  now: Date,
): Promise<{ fact: Fact; failure: { resource: "pull-comments" | "pull-reviewers"; kind: ChannelKind; status: number } | null }> {
  const nowIso = now.toISOString();
  const { sample } = selectPrSample(pulls);
  const entries: PrSampleEntry[] = [];
  let requests = 0;
  let failed = 0;
  let access = false;
  let failure: { resource: "pull-comments" | "pull-reviewers"; kind: ChannelKind; status: number } | null = null;
  for (const pr of sample) {
    const prSlug = asString(pr["slug"]);
    if (!prSlug) {
      // PR без слага не адресуется — выборка неполна (не выдается за данные)
      failed++;
      continue;
    }
    const comments = await fetch("pull-comments", prSlug);
    const reviewers = await fetch("pull-reviewers", prSlug);
    requests += 2;
    let bad = false;
    for (const [res, page] of [["pull-comments", comments], ["pull-reviewers", reviewers]] as const) {
      if (page.kind === "ok") continue;
      bad = true;
      if (page.kind === "access") access = true;
      if (failure === null) failure = { resource: res, kind: page.kind, status: page.status };
    }
    if (bad) {
      failed++;
      continue;
    }
    entries.push(prSampleEntry(pr, comments.items, reviewers.items, comments.hasMore));
  }
  if (failed > 0) {
    const detail = `${failed} of ${sample.length} pull request samples failed`;
    return {
      fact: access ? noDataFact("activity.pr_review", "access", "rest:pulls", detail, nowIso) : badChannelFact("activity.pr_review", "rest:pulls", detail, nowIso),
      failure,
    };
  }
  return { fact: okFact("activity.pr_review", aggregatePrReview(pulls, entries, now, requests), "rest:pulls", nowIso), failure: null };
}
