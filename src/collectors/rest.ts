// rest.ts — REST-коллекторы (Б3 план В1 + расширения В2/Б1): fetchResource
// (пагинация ≤5 стр, классификация ошибок access/bad-channel/other,
// инвентаризационный колбэк) + collectRestFacts → факты issues/activity/
// cicd + мета репо. В2: activity.rest несёт событийные даты (pulls
// created_at, releases released_at — источник pulls_90d/releases_12m),
// мета — forks + reaction_counts; rating-эндпоинт сканом НЕ запрашивается
// (мой реактив, экономия 14 запросов на выборку).
// Живые формы заземлены зондом 15.09 (scripts/probe-rest.ts): списки в
// ключах issues/issue_comments/pull_requests/contributors/releases/runs,
// закрытие issue = completed_at, статус — объект {slug}, counters — строки.
import { Fact, badChannelFact, noDataFact, okFact } from "./facts";
import { CI_RECENCY_BANDS, CI_STABILITY_WINDOW, ISSUE_FLOW_WINDOWS, ISSUE_FLOW_WINDOW_DAYS } from "../score/model";
import { hexColor } from "./catalog";
import { runOutcome } from "./run-status";
import { PR_COMMENTS_PAGE, PR_REVIEWERS_PAGE, collectPrReview } from "./pr-review";

/** М2.6: худший анкер первого ответа (FIRST_COMMENT_H, 30 дней) — порог цензуры. */
const UNANSWERED_CENSOR_H = 720;
import { ScClient } from "./http";

/** кап событийных дат в activity.rest (анкеры pulls ≥30 / releases ≥6 — выше бесполезно) */
const RECENT_DATES_TOP_N = 50;

export type RestResourceName =
  | "repo"
  | "issues-open"
  | "issues-in-progress"
  | "issues-closed"
  | "pulls"
  | "contributors"
  | "releases"
  | "cicd-runs"
  | "rating"
  | "issue-comments"
  // В5.5 тур 2 (W4, ЗН-2): выборка review PR — 1 страница на PR
  | "pull-comments"
  | "pull-reviewers";

export type ChannelKind = "ok" | "access" | "bad-channel" | "other";

export interface ResourceOutcome {
  resource: RestResourceName;
  kind: ChannelKind;
  status: number;
  pages: number;
  /** items из списочного ключа (для списочных ресурсов) */
  items: Record<string, unknown>[];
  /** первая страница целиком (инвентаризация: ключи/структура) */
  firstPage: unknown;
  detail?: string;
  /** сборщик 5: выборка уперлась в кап страниц, а сервер обещал еще (next_page_token) — список обрезан */
  capped?: boolean;
}

export interface DivergenceNote {
  resource: RestResourceName;
  path: string;
  status: number;
  observedTopKeys: string[];
  observedItemKeys: string[] | null;
  truncated: boolean;
}

export interface FetchResourceOptions {
  maxPages?: number;
  pageSize?: number;
  onDivergence?: (note: DivergenceNote) => void;
}

interface PathArgs {
  pageSize: number;
  /** slug issue для ресурса issue-comments */
  issueSlug?: string;
  /** slug PR для ресурсов pull-comments / pull-reviewers (В5.5 тур 2, W4) */
  pullSlug?: string;
}

/** Ф2.8: сегменты слага/issue в URL — encodeURIComponent (вход может быть извне). */
const encSegment = (raw: string): string => encodeURIComponent(raw);
const encSlugPath = (slug: string): string => slug.split("/").map(encSegment).join("/");

function resourcePath(resource: RestResourceName, slug: string, args: PathArgs): { path: string; list: boolean } {
  const ps = args.pageSize;
  const s = encSlugPath(slug);
  switch (resource) {
    case "repo":
      return { path: `/repos/${s}`, list: false };
    case "issues-open":
      return { path: `/repos/${s}/issues?filter=status%3Dopen&sort_by=-created_at&page_size=${ps}`, list: true };
    case "issues-in-progress":
      // В5.3-М (Н6): третье значение фильтра `status` спеки (open | in_progress |
      // closed) — задачи в работе открыты: зависшие, выборка первого ответа
      return { path: `/repos/${s}/issues?filter=status%3Din_progress&sort_by=-created_at&page_size=${ps}`, list: true };
    case "issues-closed":
      return { path: `/repos/${s}/issues?filter=status%3Dclosed&sort_by=-updated_at&page_size=${ps}`, list: true };
    case "pulls":
      // sort_by=-created_at: недавние первыми (для pulls_90d); даты ещё
      // раз сортируются клиентски — устойчиво к игнору сервером.
      // М2.4 аудита В5.3: ВСЕ статусы (draft, open, discarded, merging,
      // merged — enum спеки PullRequest.Status): поток MR за 90 дней — это
      // созданные запросы, а не только еще открытые (смерженные раньше
      // пропадали — у 110 из 124 активных командных репо поток был 0)
      return { path: `/repos/${s}/pulls?sort_by=-created_at&page_size=${ps}`, list: true };
    case "contributors":
      return { path: `/repos/${s}/contributors?page_size=${ps}`, list: true };
    case "releases":
      return { path: `/repos/${s}/releases?sort_by=-released_at&page_size=${ps}`, list: true };
    case "cicd-runs":
      return { path: `/repos/${s}/cicd/runs?page_size=${ps}`, list: true };
    case "rating":
      return { path: `/repos/${s}/rating`, list: false };
    case "issue-comments":
      return { path: `/repos/${s}/issues/${encSegment(args.issueSlug ?? "")}/comments?sort_by=created_at&page_size=${ps}`, list: true };
    case "pull-comments":
      // у `sort_by` комментариев PR в спеке нет created_at — порядок сервера, минимум страницы
      return { path: `/repos/${s}/pulls/${encSegment(args.pullSlug ?? "")}/comments?page_size=${ps}`, list: true };
    case "pull-reviewers":
      return { path: `/repos/${s}/pulls/${encSegment(args.pullSlug ?? "")}/reviewers?page_size=${ps}`, list: true };
  }
}

function classify(status: number, error?: string): ChannelKind {
  if (status === 0) return "bad-channel";
  if (status === 401 || status === 403) return "access";
  if (status === 429 || status >= 500) return "bad-channel";
  if (status === 200) return "ok";
  return "other";
}

function extractList(json: unknown): { listKey: string; items: Record<string, unknown>[] } {
  const o = json as Record<string, unknown> | null;
  if (!o) return { listKey: "", items: [] };
  const listKey = Object.keys(o).find((k) => Array.isArray(o[k])) ?? "";
  const items = (listKey ? (o[listKey] as unknown[]) : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object",
  );
  return { listKey, items };
}

/**
 * Один ресурс с пагинацией (контракт плана: fetchResource(slug, resource)
 * → RawJson + классификация ошибок). Пагинация ≤maxPages (5 по умолчанию),
 * интервал/бюджет — на клиенте (http.ts), инвентаризация — колбэком.
 */

export async function fetchResource(
  client: ScClient,
  slug: string,
  resource: RestResourceName,
  opts: FetchResourceOptions & { issueSlug?: string; pullSlug?: string } = {},
): Promise<ResourceOutcome> {
  const maxPages = opts.maxPages ?? 5;
  const pageSize = opts.pageSize ?? 50;
  const spec = resourcePath(resource, slug, { pageSize, issueSlug: opts.issueSlug, pullSlug: opts.pullSlug });
  const items: Record<string, unknown>[] = [];
  let token: string | null = null;
  let pages = 0;
  let firstPage: unknown = null;
  while (pages < maxPages) {
    const path = token ? `${spec.path}${spec.path.includes("?") ? "&" : "?"}page_token=${encodeURIComponent(token)}` : spec.path;
    const res = await client.get(path);
    const kind = classify(res.status, res.error);
    if (pages === 0) {
      opts.onDivergence?.({
        resource,
        path,
        status: res.status,
        observedTopKeys: res.json && typeof res.json === "object" ? Object.keys(res.json as object) : [],
        observedItemKeys: spec.list ? (extractList(res.json).items[0] ? Object.keys(extractList(res.json).items[0]!) : null) : null,
        truncated: false,
      });
    }
    if (kind !== "ok") {
      return { resource, kind, status: res.status, pages, items, firstPage, detail: res.error ?? res.bodyText.slice(0, 160) };
    }
    pages++;
    const body = res.json as Record<string, unknown> | null;
    if (pages === 1) firstPage = res.json;
    if (spec.list) items.push(...extractList(res.json).items);
    const next = body?.["next_page_token"];
    if (typeof next !== "string" || next.length === 0) {
      token = null;
      break;
    }
    token = next;
  }
  // цикл вышел по капу страниц с непустым токеном — сервер отдал бы еще
  return { resource, kind: "ok", status: 200, pages, items, firstPage, capped: token !== null };
}

// ---------- вычислители ----------

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

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Р2: закрытая задача, прожившая меньше часа, — «мгновенно закрытая» (фейковые открыл-закрыл, J2). */
export const ISSUE_INSTANT_CLOSE_MS = 3600_000;

/**
 * В5.3-М (Н6): статус релиза по перечню спеки `Release.Status` (draft,
 * published, discarded). В потоке релизов — только опубликованные; черновики и
 * отмененные — своей веткой (токен владельца их видит), неизвестное — явной.
 */
export function releaseStatusClass(status: unknown): "published" | "draft" | "discarded" | "unknown" {
  switch (status) {
    case "published":
      return "published";
    case "draft":
      return "draft";
    case "discarded":
      return "discarded";
    default:
      return "unknown";
  }
}

/**
 * 4.4.0 (ТП-1): исход запуска для ленты стабильности `recent_runs` — каждое
 * значение `Run.Status` спеки своей веткой через `runOutcome` (правило 22.09).
 * В ленту идут только завершенные с результатом кода (успех, провал/таймаут);
 * отмена, пропуск, отклонение — не результат кода (neutral), идущие — результата
 * еще нет (pending), незнакомый статус — явная ветка: в ленту не идет и назван
 * в `status_note` факта.
 */
export function stabilityOutcome(status: string | null): "success" | "failure" | null {
  switch (runOutcome(status)) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "neutral":
      return null;
    case "pending":
      return null;
    case "unknown":
      return null;
  }
}

/** 4.4.0 (ТП-1): момент исхода запуска — завершение, иначе начало, иначе создание. */
function runFinishedIso(r: Record<string, unknown>): string | null {
  const d = r["dates"] as Record<string, unknown> | undefined;
  for (const v of [d?.["finished_at"], d?.["started_at"], d?.["created_at"], r["created_at"]]) {
    if (isoMs(v) !== null) return v as string;
  }
  return null;
}

/** Окно потока задач: начало (дата UTC), создано, закрыто, мгновенно закрыто; null — окно не покрыто выборкой. */
export interface IssueFlowWindow {
  from: string;
  created: number | null;
  closed: number | null;
  instant: number | null;
}

/**
 * 4.4.0 (ТП-9): поток задач по 30-дневным окнам за 180 дней (от старых к
 * новым), из уже полученных списков — без новых запросов. Создана — по
 * `created_at` открытых, в работе и закрытых; закрыта — по `completed_at`
 * (иначе `updated_at`, как у медианы закрытия). Мгновенно закрытые (прожили
 * меньше часа, правило 4.3.0) в бэклог не входили: не считаются ни созданными,
 * ни закрытыми, их число — отдельно (`instant`, по дате создания).
 * Список, упершийся в кап страниц, теряет самые старые записи: окна раньше
 * `complete_since` (самая старая дата обрезанного списка по его сортировке)
 * не покрыты и получают null — пометка, а не тихое занижение.
 */
export function issueFlow(
  lists: { open: Record<string, unknown>[]; closed: Record<string, unknown>[] },
  /** по обрезанному списку — его самая старая дата сортировки; null — список полный */
  cutoffs: (string | null)[],
  now: Date,
): { window_days: number; windows: IssueFlowWindow[]; complete_since?: string } {
  const windowMs = ISSUE_FLOW_WINDOW_DAYS * 86_400_000;
  const end = now.getTime();
  const start = end - ISSUE_FLOW_WINDOWS * windowMs;
  const idx = (t: number | null): number | null => (t === null || t < start || t > end ? null : Math.min(ISSUE_FLOW_WINDOWS - 1, Math.floor((t - start) / windowMs)));
  const created = new Array<number>(ISSUE_FLOW_WINDOWS).fill(0);
  const closed = new Array<number>(ISSUE_FLOW_WINDOWS).fill(0);
  const instant = new Array<number>(ISSUE_FLOW_WINDOWS).fill(0);
  for (const i of lists.open) {
    const w = idx(isoMs(i["created_at"]));
    if (w !== null) created[w]! += 1;
  }
  for (const i of lists.closed) {
    const a = isoMs(i["created_at"]);
    const c = isoMs(i["completed_at"]) ?? isoMs(i["updated_at"]);
    const wa = idx(a);
    if (c !== null && a !== null && c >= a && c - a < ISSUE_INSTANT_CLOSE_MS) {
      if (wa !== null) instant[wa]! += 1;
      continue;
    }
    if (wa !== null) created[wa]! += 1;
    const wc = idx(c);
    if (wc !== null) closed[wc]! += 1;
  }
  const since = cutoffs.map(isoMs).filter((x): x is number => x !== null);
  const completeSince = since.length ? Math.max(...since) : null;
  const windows: IssueFlowWindow[] = created.map((n, k) => {
    const from = start + k * windowMs;
    const covered = completeSince === null || from >= completeSince;
    return { from: new Date(from).toISOString().slice(0, 10), created: covered ? n : null, closed: covered ? closed[k]! : null, instant: covered ? instant[k]! : null };
  });
  return { window_days: ISSUE_FLOW_WINDOW_DAYS, windows, ...(completeSince !== null ? { complete_since: new Date(completeSince).toISOString() } : {}) };
}

/** Самая старая дата поля в списке (ISO) — граница полноты обрезанного списка. */
function oldestIso(items: Record<string, unknown>[], field: string): string | null {
  let min: number | null = null;
  for (const i of items) {
    const t = isoMs(i[field]);
    if (t !== null && (min === null || t < min)) min = t;
  }
  return min === null ? null : new Date(min).toISOString();
}

/** Н6 (D15): момент запуска CI для клиентской сортировки — started_at, иначе created_at. */
function runStartedMs(r: Record<string, unknown>): number | null {
  const d = r["dates"] as Record<string, unknown> | undefined;
  return isoMs(d?.["started_at"]) ?? isoMs(d?.["created_at"]) ?? isoMs(r["created_at"]);
}

// ---------- мета репо (repos-таблица) ----------

export interface RepoMeta {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  lastActivityAt: string | null;
  /** counters.forks — строка в API, parseInt (В2/Б1, дисплей) */
  forks: number | null;
  /** rating.reaction_counts[{type,count}] — count строка, нормализуем (дисплей) */
  reactionCounts: { type: string; count: number }[] | null;
  /** visibility из repo-GET (public|private) — изоляция рейтинга (В4/Б4) */
  visibility: string | null;
  /** logo.url из repo-GET (дисплей: аватар репозитория) */
  logoUrl?: string | null;
  /** language.color из repo-GET (дисплей) */
  languageColor?: string | null;
}

function repoMetaFrom(slug: string, body: Record<string, unknown>): RepoMeta {
  const [org, repo] = slug.split("/");
  const language = body["language"];
  const langName =
    typeof language === "string" ? language : language && typeof language === "object" ? asString((language as Record<string, unknown>)["name"]) : null;
  const rating = body["rating"] as Record<string, unknown> | undefined;
  const ratingValue = typeof rating?.["value"] === "number" ? rating["value"] : null;
  const counters = body["counters"] as Record<string, unknown> | undefined;
  const forksRaw = counters?.["forks"];
  const forks = typeof forksRaw === "string" ? parseInt(forksRaw, 10) : typeof forksRaw === "number" ? forksRaw : null;
  const rcRaw = rating?.["reaction_counts"];
  const reactionCounts = Array.isArray(rcRaw)
    ? rcRaw
        .map((x): { type: string; count: number } | null => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const type = asString(o["type"]);
          const cnt = typeof o["count"] === "string" ? parseInt(o["count"], 10) : typeof o["count"] === "number" ? o["count"] : NaN;
          if (type === null || !Number.isFinite(cnt)) return null;
          return { type, count: cnt };
        })
        .filter((x): x is { type: string; count: number } => x !== null)
    : null;
  return {
    org: org ?? "",
    repo: repo ?? "",
    title: asString(body["name"]),
    language: langName,
    likes: ratingValue !== null ? Math.round(ratingValue) : null,
    lastActivityAt: asString(body["last_updated"]),
    forks: forks !== null && Number.isFinite(forks) ? forks : null,
    reactionCounts: reactionCounts && reactionCounts.length > 0 ? reactionCounts : null,
    visibility: asString(body["visibility"]),
    logoUrl: asString((body["logo"] as Record<string, unknown> | null | undefined)?.["url"]),
    languageColor: language && typeof language === "object" ? hexColor((language as Record<string, unknown>)["color"]) : null,
  };
}

// ---------- главный вход ----------

export interface RestCollectOptions {
  commentsTopN?: number;
  pageSize?: number;
  maxPagesPerResource?: number;
  now?: Date;
  onDivergence?: (note: DivergenceNote) => void;
}

export interface RestCollectResult {
  facts: Fact[];
  repoMeta: RepoMeta | null;
  /** ошибки каналов (kind + resource) — скан-статус partial/bad решает раннер */
  channelErrors: { resource: RestResourceName; kind: ChannelKind; status: number; detail?: string }[];
}

/**
 * REST-коллектор одного репо: repo-мета + issues.stats +
 * issues.comments_sample (топ-N свежих issues) + activity.rest
 * (событийные даты pulls/releases, §7.4) + cicd.runs.
 * 401/403 → no-data reason=access; 429/5xx/сеть → bad-channel факт
 * (риск-факт скана, скан не валится). rating-эндпоинт НЕ запрашивается
 * (мой реактив — не рейтинг репо; В2, экономия запросов).
 */
export async function collectRestFacts(
  client: ScClient,
  slug: string,
  opts: RestCollectOptions = {},
): Promise<RestCollectResult> {
  const topN = opts.commentsTopN ?? 50;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const frOpts: FetchResourceOptions = {
    pageSize: opts.pageSize ?? 100,
    maxPages: opts.maxPagesPerResource ?? 5,
    onDivergence: opts.onDivergence,
  };
  const facts: Fact[] = [];
  const channelErrors: RestCollectResult["channelErrors"] = [];

  // мета репо
  const repoRes = await fetchResource(client, slug, "repo", { ...frOpts, pageSize: 1, maxPages: 1 });
  let repoMeta: RepoMeta | null = null;
  if (repoRes.kind === "ok" && repoRes.firstPage && typeof repoRes.firstPage === "object") {
    repoMeta = repoMetaFrom(slug, repoRes.firstPage as Record<string, unknown>);
  } else {
    channelErrors.push({ resource: "repo", kind: repoRes.kind, status: repoRes.status, detail: repoRes.detail });
  }

  // issues: открытые (сортировка -created_at — топ свежих для comments)
  const openRes = await fetchResource(client, slug, "issues-open", frOpts);
  // Н6: задачи в работе (status=in_progress) — тоже открытые
  const progressRes = await fetchResource(client, slug, "issues-in-progress", frOpts);
  // issues: закрытые (для median_close_days)
  const closedRes = await fetchResource(client, slug, "issues-closed", frOpts);

  // В5.3-М круг 2 (К4, E1): сбой одного запроса `in_progress` не делает факт
  // задач `bad` (иначе скан непригоден для рейтинга): задачи считаются по
  // `open` + `closed`, в факте — `in_progress: null` и пометка причины
  const progressOk = progressRes.kind === "ok";
  if (openRes.kind === "ok" && closedRes.kind === "ok") {
    if (!progressOk) channelErrors.push({ resource: progressRes.resource, kind: progressRes.kind, status: progressRes.status, detail: progressRes.detail });
    const staleMs = 90 * 24 * 3600 * 1000;
    // открытые = open + in_progress, свежие первыми (выборка первого ответа)
    const seenIssue = new Set<string>();
    const openIssues = [...openRes.items, ...(progressOk ? progressRes.items : [])]
      .filter((i) => {
        const key = asString(i["id"]) ?? asString(i["slug"]);
        if (key === null) return true;
        if (seenIssue.has(key)) return false;
        seenIssue.add(key);
        return true;
      })
      .sort((a, b) => (isoMs(b["created_at"]) ?? 0) - (isoMs(a["created_at"]) ?? 0));
    const closedIssues = closedRes.items;
    const stale90 = openIssues.filter((i) => {
      const u = isoMs(i["updated_at"]);
      return u !== null && now.getTime() - u > staleMs;
    }).length;
    // completed_at есть не у всех закрытых (manytask: НЕТ ни у одного,
    // dozzle-plus: есть) — fallback на updated_at с пометкой в факте
    let fallbackCloses = 0;
    // В5.3-М (Р2): время жизни закрытой задачи; прожившие меньше часа —
    // «мгновенно закрытые» (фейковые открыл-закрыл, J2): в медиану закрытия и
    // долю решенных они не входят. Время жизни не восстановилось — задача
    // засчитывается (мгновенность не доказана).
    let closedInstant = 0;
    const closeDays = closedIssues
      .map((i) => {
        let c = isoMs(i["completed_at"]);
        if (c === null) {
          c = isoMs(i["updated_at"]);
          if (c !== null) fallbackCloses++;
        }
        const a = isoMs(i["created_at"]);
        const life = c !== null && a !== null && c >= a ? c - a : null;
        if (life !== null && life < ISSUE_INSTANT_CLOSE_MS) {
          closedInstant++;
          return null;
        }
        return life !== null ? life / 86400000 : null;
      })
      .filter((x): x is number => x !== null);
    // 4.4.0 (ТП-9): поток по окнам; список, упершийся в кап страниц, обрезан по
    // своей сортировке (открытые и в работе — -created_at, закрытые — -updated_at)
    const cappedAt = (r: ResourceOutcome, field: string): string | null => (r.capped === true ? oldestIso(r.items, field) : null);
    const flow = issueFlow(
      { open: openIssues, closed: closedIssues },
      [cappedAt(openRes, "created_at"), progressOk ? cappedAt(progressRes, "created_at") : null, cappedAt(closedRes, "updated_at")],
      now,
    );
    facts.push(
      okFact(
        "issues.stats",
        {
          open: openIssues.length,
          // Н6: из них в работе (in_progress) — разрез, в балл идут как открытые
          in_progress: progressOk ? progressRes.items.length : null,
          ...(progressOk ? {} : { in_progress_note: `in_progress fetch failed (status ${progressRes.status}) — open counted without in_progress` }),
          closed: closedIssues.length,
          closed_instant: closedInstant,
          closed_counted: closedIssues.length - closedInstant,
          median_close_days: median(closeDays.map((d) => Math.round(d * 10) / 10)),
          stale_90d: stale90,
          fetched_count: openIssues.length + closedIssues.length,
          ...(fallbackCloses > 0
            ? { close_date_note: `completed_at missing on ${fallbackCloses}/${closedIssues.length} closed — used updated_at fallback` }
            : {}),
          // сборщик 5 (ТП-9): создано/закрыто по 30-дневным окнам за 180 дней
          flow,
        },
        "rest:issues",
        nowIso,
      ),
    );

    // comments топ-N свежих issues (issues-open уже отсортированы -created_at)
    const top = openIssues.slice(0, topN);
    const delaysHours: number[] = [];
    // Н14а: задачи с ответом и задачи без ответа дольше порога цензуры — раздельно
    let answered = 0;
    let censored = 0;
    let commentsErrors = 0;
    for (const issue of top) {
      const issueSlug = asString(issue["slug"]);
      if (!issueSlug) continue;
      const cRes = await fetchResource(client, slug, "issue-comments", { pageSize: 5, maxPages: 1, issueSlug });
      if (cRes.kind === "ok") {
        // первая страница при sort_by=created_at (asc) — берём минимум из
        // полученного: устойчиво и к игнору сортировки, и к desc
        const created = cRes.items.map((c) => isoMs(c["created_at"])).filter((x): x is number => x !== null);
        const issueCreated = isoMs(issue["created_at"]);
        if (created.length > 0) {
          const first = Math.min(...created);
          if (issueCreated !== null && first >= issueCreated) {
            delaysHours.push(Math.round(((first - issueCreated) / 3600000) * 10) / 10);
            answered++;
          }
        } else if (issueCreated !== null && now.getTime() - issueCreated >= UNANSWERED_CENSOR_H * 3600000) {
          // М2.6 аудита В5.3: без ответа дольше худшего анкера — задержка не
          // меньше анкера (цензура); раньше такая задача выпадала, и «никто не
          // ответил» оценивалось выше, чем «ответили поздно». Свежая задача без
          // ответа в выборку не входит — ответа еще можно ждать
          delaysHours.push(UNANSWERED_CENSOR_H);
          censored++;
        }
      } else {
        commentsErrors++;
        if (cRes.kind === "bad-channel" && commentsErrors === 1) {
          channelErrors.push({ resource: "issue-comments", kind: cRes.kind, status: cRes.status, detail: cRes.detail });
        }
      }
    }
    if (commentsErrors > 0) {
      // круг 2 (LOW-4): любой сбой выборки — урезанная выборка не выдаётся за данные
      facts.push(badChannelFact("issues.comments_sample", "rest:comments", `${commentsErrors} of ${top.length} comment fetches failed`, nowIso));
    } else {
      facts.push(
        okFact(
          "issues.comments_sample",
          {
            issues: top.length,
            // Н14а (правило 23.09 об имени поля): `with_comments` считал и
            // цензурированные задачи без ответа — имя не совпадало со смыслом.
            // Теперь раздельно; факты прежнего сборщика несут `with_comments`
            answered,
            censored,
            median_first_comment_delay_hours: median(delaysHours),
            delays_hours: delaysHours,
          },
          "rest:comments",
          nowIso,
        ),
      );
    }
  } else {
    for (const r of [openRes, closedRes]) {
      if (r.kind !== "ok") {
        channelErrors.push({ resource: r.resource, kind: r.kind, status: r.status, detail: r.detail });
      }
    }
    const statuses = `status ${openRes.status}/${progressRes.status}/${closedRes.status}`;
    for (const kind of ["issues.stats", "issues.comments_sample"]) {
      if (openRes.kind === "access" || closedRes.kind === "access") {
        facts.push(noDataFact(kind, "access", "rest:issues", statuses, nowIso));
      } else {
        facts.push(badChannelFact(kind, "rest:issues", statuses, nowIso));
      }
    }
  }

  // activity.rest: contributors / releases / pulls_open + событийные даты
  const contribRes = await fetchResource(client, slug, "contributors", frOpts);
  const relRes = await fetchResource(client, slug, "releases", frOpts);
  const pullsRes = await fetchResource(client, slug, "pulls", frOpts);
  if (contribRes.kind === "ok" && relRes.kind === "ok" && pullsRes.kind === "ok") {
    // Н6 (D16): только опубликованные релизы; черновики и отмененные — своей
    // веткой в разрезе, неизвестный статус — явной (в поток не идет, назван)
    const releaseStatuses: Record<string, number> = {};
    const unknownRelease = new Set<string>();
    const published = relRes.items.filter((r) => {
      const cls = releaseStatusClass(r["status"]);
      releaseStatuses[cls] = (releaseStatuses[cls] ?? 0) + 1;
      if (cls === "unknown") unknownRelease.add(String(r["status"] ?? "missing"));
      return cls === "published";
    });
    const latest = published.find((r) => r["is_latest"] === true) ?? published[0];
    const latestAt = latest ? asString(latest["released_at"]) : null;
    // событийные даты (§7.4): топ-N недавних pulls created_at и релизов
    // released_at desc — источник pulls_90d/releases_12m в score-слое
    const pullsCreatedAt = pullsRes.items
      .map((p) => asString(p["created_at"]))
      .filter((x): x is string => x !== null)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, RECENT_DATES_TOP_N);
    const releasesReleasedAt = published
      .map((r) => asString(r["released_at"]))
      .filter((x): x is string => x !== null)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, RECENT_DATES_TOP_N);
    const notes: string[] = [];
    if (contribRes.pages >= (opts.maxPagesPerResource ?? 5)) notes.push(`contributors capped at ${contribRes.items.length}`);
    if (pullsRes.items.length >= (opts.maxPagesPerResource ?? 5) * (opts.pageSize ?? 100)) notes.push(`pulls capped at ${pullsRes.items.length}`);
    facts.push(
      okFact(
        "activity.rest",
        {
          contributors: contribRes.items.length,
          releases: published.length,
          release_statuses: releaseStatuses,
          ...(unknownRelease.size ? { release_status_note: `unknown release statuses: ${[...unknownRelease].slice(0, 3).join(", ")}` } : {}),
          pulls_open: pullsRes.items.filter((p) => asString(p["status"]) === "open").length,
          latest_release_at: latestAt,
          pulls_created_at: pullsCreatedAt,
          releases_released_at: releasesReleasedAt,
          ...(notes.length ? { fetched_note: notes.join("; ") } : {}),
        },
        "rest:activity",
        nowIso,
      ),
    );
  } else {
    for (const r of [contribRes, relRes, pullsRes]) {
      if (r.kind !== "ok") channelErrors.push({ resource: r.resource, kind: r.kind, status: r.status, detail: r.detail });
    }
    const anyAccess = [contribRes, relRes, pullsRes].some((r) => r.kind === "access");
    const fact = anyAccess
      ? noDataFact("activity.rest", "access", "rest:activity", "401/403 on contributors/releases/pulls", nowIso)
      : badChannelFact("activity.rest", "rest:activity", "bad channel on contributors/releases/pulls", nowIso);
    facts.push(fact);
  }

  // cicd.runs: чужие → 403 (no-data access), свои → окна статусов
  const runsRes = await fetchResource(client, slug, "cicd-runs", frOpts);
  if (runsRes.kind === "ok") {
    // В5.3-М (Н6, D15): у `/cicd/runs` в спеке нет `sort_by` — «последний
    // запуск», серия зеленых и ленты свежести не полагаются на порядок ответа:
    // запуски сортируются по дате начала на клиенте, свежие первыми (без даты — в хвост)
    const all = runsRes.items
      .map((r, i) => ({ r, i, t: runStartedMs(r) }))
      .sort((a, b) => (b.t ?? -Infinity) - (a.t ?? -Infinity) || a.i - b.i)
      .map((x) => x.r);
    // М2.5 аудита В5.3: доля успеха — по ЗАВЕРШЕННЫМ запускам (успех или
    // провал); идущие и нейтральные (отмена, пропуск, отклонение) в нее не
    // входят. «Последний запуск» — последний завершенный.
    const runs = all.filter((r) => {
      const o = runOutcome(asString(r["status"]));
      return o === "success" || o === "failure";
    });
    const unknownStatuses = [...new Set(all.map((r) => asString(r["status"]) ?? "").filter((st) => runOutcome(st) === "unknown"))];
    // В5.3-М (Н8б, F11): длительность — по УСПЕШНЫМ запускам: быстрый провал
    // не лучше медленного успеха
    const durations = runs
      .filter((r) => runOutcome(asString(r["status"])) === "success")
      .map((r) => {
        const d = r["dates"] as Record<string, unknown> | undefined;
        const f = isoMs(d?.["finished_at"]);
        const s = isoMs(d?.["started_at"]);
        return f !== null && s !== null && f >= s ? (f - s) / 1000 : null;
      })
      .filter((x): x is number => x !== null);
    const success = runs.filter((r) => r["status"] === "success").length;
    // 23.09 (Алексей): доля за окно не отличает «навели порядок» от «сломали» —
    // серия зелёных с конца даёт тренд; running серию не рвёт (статус не финальный)
    let greenStreak = 0;
    for (const r of runs) {
      if (asString(r["status"]) === "success") greenStreak += 1;
      else break;
    }
    // 23.09 (Алексей): ВЗВЕШЕННАЯ доля успеха по лентам свежести — свежие
    // прогоны весомее; старше года вес 0. Для скоринга pass_rate.
    let weightTotal = 0;
    let greenWeight = 0;
    for (const r of runs) {
      const d = r["dates"] as Record<string, unknown> | undefined;
      const started = isoMs(d?.["started_at"]);
      if (started === null) continue;
      const ageDays = (now.getTime() - started) / 86_400_000;
      let w = 0;
      for (const band of CI_RECENCY_BANDS) {
        if (ageDays < band.days) {
          w = band.w;
          break;
        }
      }
      weightTotal += w;
      if (asString(r["status"]) === "success") greenWeight += w;
    }
    const weightedSuccessRate = weightTotal > 0 ? Math.round((greenWeight / weightTotal) * 100) / 100 : null;
    // 23.09 (Алексей: «собрать больше полезной информации»): разрез по событиям,
    // повторно падающие workflow и тексты ошибок недавних красных прогонов
    const events: Record<string, number> = {};
    const failingWorkflows = new Set<string>();
    const errors: string[] = [];
    // разрез по событиям — по всем запускам страницы, провалы — по завершенным
    for (const r of all) {
      const et = asString(r["event_type"]);
      if (et) events[et] = (events[et] ?? 0) + 1;
      if (runOutcome(asString(r["status"])) !== "failure") continue;
      const wfs = Array.isArray(r["workflows"]) ? (r["workflows"] as Array<Record<string, unknown>>) : [];
      for (const w of wfs) {
        const slug = asString(w["slug"]);
        if (slug && runOutcome(asString(w["status"])) === "failure") failingWorkflows.add(slug);
      }
      const em = r["error_messages"];
      if (Array.isArray(em)) {
        for (const e of em) {
          const s = (asString(e) ?? "").trim();
          if (s && !errors.some((x) => x === s)) errors.push(s);
        }
      }
    }
    // 4.4.0 (ТП-1): лента для сравнения двух окон — 2 × окно завершенных
    const recentRuns: { outcome: "success" | "failure"; at: string | null }[] = [];
    for (const r of all) {
      if (recentRuns.length >= 2 * CI_STABILITY_WINDOW) break;
      const outcome = stabilityOutcome(asString(r["status"]));
      if (outcome !== null) recentRuns.push({ outcome, at: runFinishedIso(r) });
    }
    facts.push(
      okFact(
        "cicd.runs",
        {
          // первая страница по умолчанию — свежие прогоны (зонд 15.09: slug 9 первым)
          last_status: runs.length ? asString(runs[0]!["status"]) : null,
          success_rate: runs.length ? Math.round((success / runs.length) * 100) / 100 : null,
          duration_p50: durations.length ? Math.round((median(durations) ?? 0) * 10) / 10 : null,
          runs_count: runs.length,
          // М2.5: все запуски страницы, включая идущие и нейтральные; 0
          // завершенных при runs_total > 0 — «результата еще нет», не «не запускался»
          runs_total: all.length,
          ...(unknownStatuses.length ? { status_note: `unknown run statuses: ${unknownStatuses.slice(0, 3).join(", ")}` } : {}),
          green_streak: runs.length ? greenStreak : null,
          weighted_success_rate: weightedSuccessRate,
          events,
          failed_workflows: [...failingWorkflows].slice(0, 5),
          error_top: errors.slice(0, 3).map((e) => e.slice(0, 140)),
          // сборщик 5 (ТП-1): исход и момент последних завершенных запусков,
          // свежие первыми — лента стабильности CI; без сообщений и имен
          recent_runs: recentRuns,
        },
        "rest:cicd",
        nowIso,
      ),
    );
  } else if (runsRes.kind === "access") {
    facts.push(noDataFact("cicd.runs", "access", "rest:cicd", `status ${runsRes.status}`, nowIso));
    channelErrors.push({ resource: "cicd-runs", kind: runsRes.kind, status: runsRes.status, detail: runsRes.detail });
  } else {
    facts.push(badChannelFact("cicd.runs", "rest:cicd", `status ${runsRes.status}`, nowIso));
    channelErrors.push({ resource: "cicd-runs", kind: runsRes.kind, status: runsRes.status, detail: runsRes.detail });
  }

  // В5.5 тур 2 (W4, ЗН-2): review и bottlenecks PR — справочный факт
  // `activity.pr_review` (pr-review.ts) по уже полученному списку PR; бюджет —
  // PR_REQUEST_BUDGET запросов на репо (0 без PR). Список PR не получен —
  // факт повторяет причину activity.rest (права или сбой канала).
  if (pullsRes.kind === "ok") {
    const pr = await collectPrReview(
      pullsRes.items,
      async (resource, pullSlug) => {
        const res = await fetchResource(client, slug, resource, {
          pageSize: resource === "pull-comments" ? PR_COMMENTS_PAGE : PR_REVIEWERS_PAGE,
          maxPages: 1,
          pullSlug,
        });
        const next = (res.firstPage as Record<string, unknown> | null)?.["next_page_token"];
        return { kind: res.kind, status: res.status, items: res.items, hasMore: typeof next === "string" && next.length > 0 };
      },
      now,
    );
    facts.push(pr.fact);
    if (pr.failure && pr.failure.kind === "bad-channel") channelErrors.push({ resource: pr.failure.resource, kind: pr.failure.kind, status: pr.failure.status });
  } else {
    facts.push(
      pullsRes.kind === "access"
        ? noDataFact("activity.pr_review", "access", "rest:pulls", `status ${pullsRes.status}`, nowIso)
        : badChannelFact("activity.pr_review", "rest:pulls", `status ${pullsRes.status}`, nowIso),
    );
  }

  return { facts, repoMeta, channelErrors };
}
