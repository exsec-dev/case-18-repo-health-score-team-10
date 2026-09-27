// Ревью и узкие места PR (ТЗ §7) – справочный показатель категории
// «Активность» без веса: индекс, Score, покрытие и рекомендации от него не
// зависят.
//
// Выборка устроена как `issues.comments_sample` (rest.ts): до PR_REVIEW_SAMPLE
// последних PR (не черновиков) из уже полученного списка `/pulls`; сортируем
// сами, на случай если сервер порядок проигнорирует. На каждый PR – одна
// страница комментариев и одна страница ревьюеров, всего не больше
// PR_REQUEST_BUDGET запросов на репо.
// Сбой любого запроса – факт `bad` (или `no-data` при отказе в доступе):
// урезанная выборка за данные не выдается. Нет PR – это данные
// «PR не используются» (`pulls: 0`), а не «нет данных».
//
// Каждое значение перечислений спеки – своя ветка: `PullRequest.Status`,
// `ReviewDecision`, `PullRequestComment.Type`; незнакомое значение – явная
// ветка `unknown`, которая называется в факте.
import { Fact, badChannelFact, noDataFact, okFact } from "./facts";
import type { ChannelKind } from "./rest";

/** Размер выборки PR для времени первого ответа и комментариев ревью. */
export const PR_REVIEW_SAMPLE = 10;
/** Размер единственной страницы комментариев PR (сортировки по `created_at` спека не дает). */
export const PR_COMMENTS_PAGE = 50;
export const PR_REVIEWERS_PAGE = 50;
/** Комментарии + ревьюеры на каждый PR выборки. */
export const PR_REQUEST_BUDGET = PR_REVIEW_SAMPLE * 2;
/** Узкое место: открытый PR без ответа ревьюера дольше 72 ч – с запасом на выходные. */
export const PR_BOTTLENECK_H = 72;
/** Сколько последних слитых PR берется для медианы времени до слияния (как у дат activity.rest). */
export const PR_MERGE_TOP_N = 50;

export type PrStatus = "draft" | "open" | "merging" | "merged" | "discarded" | "unknown";

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
 * `ReviewDecision` спеки. Нет решения (поле опущено или null – так спека
 * обозначает снятое решение) – `pending`: ревьюер назначен, но не ответил.
 * Ответом считаются approve, trust и block; abstain – ревьюер отказался от
 * ревью, и PR по-прежнему ждет ответа.
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
 * `PullRequestComment.Type` спеки. Опущенное поле – `default`: proto3 не
 * печатает значение перечисления по умолчанию. `appsec` – комментарий сканера
 * безопасности, а не человека, поэтому в ответы и счет ревью не идет.
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

/** У всех внешних пользователей спеки id и slug равны «<external-user>» – различить их нельзя. */
const EXTERNAL_USER = "<external-user>";

/** Ключ пользователя (`UserEmbedded`): id, иначе slug; внешний или пустой – null. */
function userKey(user: unknown): string | null {
  const u = user as { id?: unknown; slug?: unknown } | null | undefined;
  const key = asString(u?.id) ?? asString(u?.slug);
  if (key === null || key === "" || key === EXTERNAL_USER) return null;
  return key;
}

/** Ответ не автора PR: оба известны и различны. Внешнего или безымянного не отличить от автора – не засчитываем. */
function isOtherUser(user: unknown, prAuthor: string | null): boolean {
  const key = userKey(user);
  return key !== null && prAuthor !== null && key !== prAuthor;
}

/** Одна страница ресурса выборки – подмножество `ResourceOutcome` из rest.ts. */
export interface PrPage {
  kind: ChannelKind;
  status: number;
  items: Record<string, unknown>[];
  /** есть следующая страница – счет комментариев «не меньше» */
  hasMore: boolean;
}

export type PrFetch = (resource: "pull-comments" | "pull-reviewers", pullSlug: string) => Promise<PrPage>;

/** Итог одного PR выборки – вход агрегатора. */
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

export function prSampleEntry(pr: Record<string, unknown>, comments: Record<string, unknown>[], reviewers: Record<string, unknown>[], commentsCapped: boolean): PrSampleEntry {
  const author = userKey(pr["author"]);
  const createdMs = isoMs(pr["created_at"]);
  const responses: number[] = [];
  let reviewComments = 0;
  let appsecComments = 0;
  const unknownTypes = new Set<string>();
  for (const c of comments) {
    // удаленные и неопубликованные (черновики ревью) – не ответ
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
    // момент решения – updated_at записи ревьюера (created_at – момент назначения)
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
    // черновик на ревью не отправлен – ответа ревьюера не ждет
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
 * Время до слияния – по уже полученным слитым PR, без запросов. Даты слияния
 * в `PullRequest` спеки нет, поэтому ее приближает `updated_at`; факт говорит
 * об этом в `merge_time_basis`.
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

/** Значение факта `activity.pr_review` по разобранной выборке. */
export function aggregatePrReview(pulls: Record<string, unknown>[], entries: PrSampleEntry[], now: Date, requests: number): Record<string, unknown> {
  const { statuses, unknownStatuses } = selectPrSample(pulls);
  const answered = entries.filter((e) => e.firstResponseMs !== null && e.createdMs !== null);
  const delays = answered.map((e) => (e.firstResponseMs! - e.createdMs!) / 3_600_000);
  // узкое место – открытый PR, который ждет первого ответа дольше порога;
  // merging уже сливается (решение принято), merged/discarded закрыты
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
    // у PR с полной страницей комментариев счет – «не меньше»
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
 * Сбор `activity.pr_review` по уже полученному списку PR. `fetch` – одна
 * страница ресурса через rest.ts. Возвращает факт и первый сбой канала (для
 * `channelErrors`, как у выборки комментариев задач).
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
      // PR без слага не адресуется – выборка неполна и за данные не выдается
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
