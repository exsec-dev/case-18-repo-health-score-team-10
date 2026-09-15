// Read-only probe for the documented SourceCraft AppSec PR-comment surface.
// It deliberately never prints comment bodies, hunks, identifiers, paths, or
// the authorization token: only aggregate counters are emitted.

const [repoSlug, pullRequestSlug] = process.argv.slice(2);
if (!repoSlug || !pullRequestSlug || !repoSlug.includes("/")) {
  console.error(
    "usage: bun scripts/probe-appsec.ts <org/repo> <pull-request-slug>",
  );
  process.exit(2);
}

const token = process.env.SOURCECRAFT_TOKEN;
if (!token) throw new Error("SOURCECRAFT_TOKEN is required");

interface PullRequestComment {
  type?: string;
  resolution_state?: string;
  iteration?: string;
  is_outdated?: boolean;
  anchor?: { path?: string };
}

interface PullRequestCommentsPage {
  pull_request_comments: PullRequestComment[];
  next_page_token?: string;
}

const [org, repo, ...extra] = repoSlug.split("/");
if (!org || !repo || extra.length > 0) throw new Error("repo must be org/repo");

const endpoint = new URL(
  `https://api.sourcecraft.tech/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(pullRequestSlug)}/comments`,
);
endpoint.searchParams.set("page_size", "100");

const comments: PullRequestComment[] = [];
let pageToken = "";
let pages = 0;

do {
  if (pageToken) endpoint.searchParams.set("page_token", pageToken);
  else endpoint.searchParams.delete("page_token");

  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`SourceCraft API returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("pull_request_comments" in payload) ||
    !Array.isArray(payload.pull_request_comments)
  ) {
    throw new Error("Unexpected SourceCraft response shape");
  }
  const page = payload as PullRequestCommentsPage;
  comments.push(...page.pull_request_comments);
  pageToken = typeof page.next_page_token === "string"
    ? page.next_page_token
    : "";
  pages += 1;
  if (pages > 100) throw new Error("Pagination safety limit reached");
} while (pageToken);

const appsecComments = comments.filter((comment) => comment.type === "appsec");
const countBy = (items: PullRequestComment[], key: keyof PullRequestComment) => Object.fromEntries(
  [...new Set(items.map((item) => String(item[key] ?? "missing")))]
    .sort()
    .map((value) => [value, items.filter((item) => String(item[key] ?? "missing") === value).length]),
);

console.log(JSON.stringify({
  repo: repoSlug,
  pullRequest: pullRequestSlug,
  pages,
  comments: comments.length,
  appsecComments: appsecComments.length,
  appsecFiles: new Set(
    appsecComments.map((comment) => comment.anchor?.path).filter(Boolean),
  ).size,
  appsecOutdated: appsecComments.filter((comment) => comment.is_outdated === true).length,
  appsecTypes: countBy(appsecComments, "type"),
  appsecResolutionStates: countBy(appsecComments, "resolution_state"),
  appsecIterations: [...new Set(
    appsecComments.map((comment) => String(comment.iteration ?? "missing")),
  )].sort(),
}, null, 2));
