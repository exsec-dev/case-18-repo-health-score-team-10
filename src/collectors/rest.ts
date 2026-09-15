// rest.ts — REST-коллекторы (Б3, план В1): fetchResource (пагинация ≤5
// стр, классификация ошибок access/bad-channel/other, инвентаризационный
// колбэк) + collectRestFacts → факты issues/activity/cicd + мета репо.
// Живые формы заземлены зондом 15.09 (scripts/probe-rest.ts): списки в
// ключах issues/issue_comments/pull_requests/contributors/releases/runs,
// закрытие issue = completed_at, статус — объект {slug}, counters — строки.
import { Fact, badChannelFact, noDataFact, okFact } from "./facts";
import { ScClient } from "./http";

export type RestResourceName =
  | "repo"
  | "issues-open"
  | "issues-closed"
  | "pulls-open"
  | "contributors"
  | "releases"
  | "cicd-runs"
  | "rating"
  | "issue-comments";

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
}

function resourcePath(resource: RestResourceName, slug: string, args: PathArgs): { path: string; list: boolean } {
  const ps = args.pageSize;
  switch (resource) {
    case "repo":
      return { path: `/repos/${slug}`, list: false };
    case "issues-open":
      return { path: `/repos/${slug}/issues?filter=status%3Dopen&sort_by=-created_at&page_size=${ps}`, list: true };
    case "issues-closed":
      return { path: `/repos/${slug}/issues?filter=status%3Dclosed&sort_by=-updated_at&page_size=${ps}`, list: true };
    case "pulls-open":
      return { path: `/repos/${slug}/pulls?filter=status%3Dopen&page_size=${ps}`, list: true };
    case "contributors":
      return { path: `/repos/${slug}/contributors?page_size=${ps}`, list: true };
    case "releases":
      return { path: `/repos/${slug}/releases?sort_by=-released_at&page_size=${ps}`, list: true };
    case "cicd-runs":
      return { path: `/repos/${slug}/cicd/runs?page_size=${ps}`, list: true };
    case "rating":
      return { path: `/repos/${slug}/rating`, list: false };
    case "issue-comments":
      return { path: `/repos/${slug}/issues/${args.issueSlug}/comments?sort_by=created_at&page_size=${ps}`, list: true };
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
  opts: FetchResourceOptions & { issueSlug?: string } = {},
): Promise<ResourceOutcome> {
  const maxPages = opts.maxPages ?? 5;
  const pageSize = opts.pageSize ?? 50;
  const spec = resourcePath(resource, slug, { pageSize, issueSlug: opts.issueSlug });
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
    if (typeof next !== "string" || next.length === 0) break;
    token = next;
  }
  return { resource, kind: "ok", status: 200, pages, items, firstPage };
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

function issueStatusSlug(issue: Record<string, unknown>): string | null {
  const st = issue["status"];
  if (st && typeof st === "object") return asString((st as Record<string, unknown>)["slug"]);
  return asString(st);
}

// ---------- мета репо (repos-таблица) ----------

export interface RepoMeta {
  org: string;
  repo: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  lastActivityAt: string | null;
}

function repoMetaFrom(slug: string, body: Record<string, unknown>): RepoMeta {
  const [org, repo] = slug.split("/");
  const language = body["language"];
  const langName =
    typeof language === "string" ? language : language && typeof language === "object" ? asString((language as Record<string, unknown>)["name"]) : null;
  const rating = body["rating"] as Record<string, unknown> | undefined;
  const ratingValue = typeof rating?.["value"] === "number" ? rating["value"] : null;
  return {
    org: org ?? "",
    repo: repo ?? "",
    title: asString(body["name"]),
    language: langName,
    likes: ratingValue !== null ? Math.round(ratingValue) : null,
    lastActivityAt: asString(body["last_updated"]),
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
 * issues.comments_sample (топ-N свежих issues) + activity.rest + cicd.runs.
 * 401/403 → no-data reason=access; 429/5xx/сеть → bad-channel факт
 * (риск-факт скана, скан не валится). rating запрашивается для
 * инвентаризации (мой реактив — непокорректный источник рейтинга репо).
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

  // rating: только инвентаризация (мой реактив — не рейтинг репо)
  const ratingRes = await fetchResource(client, slug, "rating", { ...frOpts, pageSize: 1, maxPages: 1 });
  if (ratingRes.kind !== "ok") {
    channelErrors.push({ resource: "rating", kind: ratingRes.kind, status: ratingRes.status, detail: ratingRes.detail });
  }

  // issues: открытые (сортировка -created_at — топ свежих для comments)
  const openRes = await fetchResource(client, slug, "issues-open", frOpts);
  // issues: закрытые (для median_close_days)
  const closedRes = await fetchResource(client, slug, "issues-closed", frOpts);

  if (openRes.kind === "ok" && closedRes.kind === "ok") {
    const staleMs = 90 * 24 * 3600 * 1000;
    const openIssues = openRes.items;
    const closedIssues = closedRes.items;
    const stale90 = openIssues.filter((i) => {
      const u = isoMs(i["updated_at"]);
      return u !== null && now.getTime() - u > staleMs;
    }).length;
    // completed_at есть не у всех закрытых (manytask: НЕТ ни у одного,
    // dozzle-plus: есть) — fallback на updated_at с пометкой в факте
    let fallbackCloses = 0;
    const closeDays = closedIssues
      .map((i) => {
        let c = isoMs(i["completed_at"]);
        if (c === null) {
          c = isoMs(i["updated_at"]);
          if (c !== null) fallbackCloses++;
        }
        const a = isoMs(i["created_at"]);
        return c !== null && a !== null && c >= a ? (c - a) / 86400000 : null;
      })
      .filter((x): x is number => x !== null);
    facts.push(
      okFact(
        "issues.stats",
        {
          open: openIssues.length,
          closed: closedIssues.length,
          median_close_days: median(closeDays.map((d) => Math.round(d * 10) / 10)),
          stale_90d: stale90,
          fetched_count: openIssues.length + closedIssues.length,
          ...(fallbackCloses > 0
            ? { close_date_note: `completed_at missing on ${fallbackCloses}/${closedIssues.length} closed — used updated_at fallback` }
            : {}),
        },
        "rest:issues",
        nowIso,
      ),
    );

    // comments топ-N свежих issues (issues-open уже отсортированы -created_at)
    const top = openIssues.slice(0, topN);
    const delaysHours: number[] = [];
    let commentsErrors = 0;
    for (const issue of top) {
      const issueSlug = asString(issue["slug"]);
      if (!issueSlug) continue;
      const cRes = await fetchResource(client, slug, "issue-comments", { pageSize: 5, maxPages: 1, issueSlug });
      if (cRes.kind === "ok") {
        // первая страница при sort_by=created_at (asc) — берём минимум из
        // полученного: устойчиво и к игнору сортировки, и к desc
        const created = cRes.items.map((c) => isoMs(c["created_at"])).filter((x): x is number => x !== null);
        if (created.length > 0) {
          const first = Math.min(...created);
          const issueCreated = isoMs(issue["created_at"]);
          if (issueCreated !== null && first >= issueCreated) {
            delaysHours.push(Math.round(((first - issueCreated) / 3600000) * 10) / 10);
          }
        }
      } else {
        commentsErrors++;
        if (cRes.kind === "bad-channel" && commentsErrors === 1) {
          channelErrors.push({ resource: "issue-comments", kind: cRes.kind, status: cRes.status, detail: cRes.detail });
        }
      }
    }
    if (commentsErrors > 0 && commentsErrors === top.length && top.length > 0) {
      // ВСЕ комментарии легли в bad-channel — канал мёртв
      facts.push(badChannelFact("issues.comments_sample", "rest:comments", `all ${top.length} comment fetches failed`, nowIso));
    } else {
      facts.push(
        okFact(
          "issues.comments_sample",
          {
            issues: top.length,
            with_comments: delaysHours.length,
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
    for (const kind of ["issues.stats", "issues.comments_sample"]) {
      if (openRes.kind === "access" || closedRes.kind === "access") {
        facts.push(noDataFact(kind, "access", "rest:issues", `status ${openRes.status}/${closedRes.status}`, nowIso));
      } else {
        facts.push(badChannelFact(kind, "rest:issues", `status ${openRes.status}/${closedRes.status}`, nowIso));
      }
    }
  }

  // activity.rest: contributors / releases / pulls_open
  const contribRes = await fetchResource(client, slug, "contributors", frOpts);
  const relRes = await fetchResource(client, slug, "releases", frOpts);
  const pullsRes = await fetchResource(client, slug, "pulls-open", frOpts);
  if (contribRes.kind === "ok" && relRes.kind === "ok" && pullsRes.kind === "ok") {
    const latest = relRes.items.find((r) => r["is_latest"] === true) ?? relRes.items[0];
    const latestAt = latest ? asString(latest["released_at"]) : null;
    const notes: string[] = [];
    if (contribRes.pages >= (opts.maxPagesPerResource ?? 5)) notes.push(`contributors capped at ${contribRes.items.length}`);
    facts.push(
      okFact(
        "activity.rest",
        {
          contributors: contribRes.items.length,
          releases: relRes.items.length,
          pulls_open: pullsRes.items.length,
          latest_release_at: latestAt,
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
    const runs = runsRes.items;
    const durations = runs
      .map((r) => {
        const d = r["dates"] as Record<string, unknown> | undefined;
        const f = isoMs(d?.["finished_at"]);
        const s = isoMs(d?.["started_at"]);
        return f !== null && s !== null && f >= s ? (f - s) / 1000 : null;
      })
      .filter((x): x is number => x !== null);
    const success = runs.filter((r) => r["status"] === "success").length;
    facts.push(
      okFact(
        "cicd.runs",
        {
          // первая страница по умолчанию — свежие прогоны (зонд 15.09: slug 9 первым)
          last_status: runs.length ? asString(runs[0]!["status"]) : null,
          success_rate: runs.length ? Math.round((success / runs.length) * 100) / 100 : null,
          duration_p50: durations.length ? Math.round((median(durations) ?? 0) * 10) / 10 : null,
          runs_count: runs.length,
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

  return { facts, repoMeta, channelErrors };
}
