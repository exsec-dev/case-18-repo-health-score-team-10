// probe-rest.ts — живой зонд-инвентаризация REST-ресурсов (Б3, план В1):
// что реально приходит vs vendored OpenAPI (у спеки response-схем нет —
// инвентаризация обязательна). Сохраняет живые фиксстуры
// (tests/fixtures/rest/*.json, списки обрезаны до 2-3 записей с
// сохранением формы). Токен из .env, не печатается. ~12 запросов.
// Usage: bun scripts/probe-rest.ts [--fixtures]
import { loadConfig } from "../src/config";

const API = "https://api.sourcecraft.tech";
const config = loadConfig();
if (!config.sourcecraftToken) {
  console.error("SOURCECRAFT_TOKEN отсутствует в .env");
  process.exit(1);
}
const DOZZLE = "k-5-45mm/dozzle-plus";
const OWN = "lct-hackaton-2026/case-18-repo-health-score-team-10";

let lastAt = 0;
async function get(label: string, path: string): Promise<{ status: number; json: unknown }> {
  const wait = 50 - (Date.now() - lastAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${config.sourcecraftToken}` } });
  lastAt = Date.now();
  let json: unknown = null;
  try {
    json = JSON.parse(await r.text());
  } catch {
    /* ok */
  }
  console.log(`\n### ${label}`);
  console.log(`${r.status} GET ${path.slice(0, 110)}`);
  return { status: r.status, json };
}

function keys(x: unknown): string {
  return x && typeof x === "object" ? Object.keys(x as object).join(", ") : String(x);
}
function firstItem(json: unknown): { listKey: string; item: Record<string, unknown> | null; n: number; next: string } {
  const o = json as Record<string, unknown> | null;
  if (!o) return { listKey: "?", item: null, n: 0, next: "" };
  const listKey = Object.keys(o).find((k) => Array.isArray(o[k])) ?? "?";
  const arr = (o[listKey] as unknown[]) ?? [];
  return { listKey, item: (arr[0] as Record<string, unknown>) ?? null, n: arr.length, next: JSON.stringify(o["next_page_token"] ?? null).slice(0, 60) };
}

const fixtures: Record<string, unknown> = {};

// 1) repo-объект
const repo = await get("repo", `/repos/${DOZZLE}`);
if (repo.status === 200) {
  console.log("  ключи:", keys(repo.json));
  const r = repo.json as Record<string, unknown>;
  console.log("  rating:", JSON.stringify(r["rating"])?.slice(0, 160));
  console.log("  counters:", JSON.stringify(r["counters"])?.slice(0, 200));
  fixtures["repo.json"] = repo.json;
}

// 2) issues: свежие, sort_by=-created_at
const issues = await get("issues (open, sort -created_at)", `/repos/${DOZZLE}/issues?filter=status%3Dopen&sort_by=-created_at&page_size=3`);
const ii = firstItem(issues.json);
console.log("  список в ключе:", ii.listKey, "| записей:", ii.n, "| next:", ii.next);
if (ii.item) {
  console.log("  поля issue:", keys(ii.item));
  for (const k of ["slug", "status", "created_at", "updated_at", "closed_at", "author", "comments_count", "last_comment_at"]) {
    if (k in ii.item) console.log(`    ${k} =`, JSON.stringify(ii.item[k]).slice(0, 100));
  }
}
const arr = issues.status === 200 ? ((issues.json as Record<string, unknown>)[ii.listKey] as Record<string, unknown>[]) : [];
if (arr.length >= 2) {
  const desc = String(arr[0]!["created_at"]) >= String(arr[1]!["created_at"]);
  console.log("  сортировка реально desc по created_at:", desc);
  fixtures["issues-open.json"] = { [ii.listKey]: arr.slice(0, 3), next_page_token: (issues.json as Record<string, unknown>)["next_page_token"] ?? null };
}

// 3) issues closed (форма closed_at)
const issuesClosed = await get("issues (closed)", `/repos/${DOZZLE}/issues?filter=status%3Dclosed&sort_by=-updated_at&page_size=2`);
const ic = firstItem(issuesClosed.json);
if (ic.item) {
  console.log("  поля closed-issue:", keys(ic.item));
  for (const k of ["created_at", "closed_at", "completed_at", "updated_at"]) console.log(`    ${k} =`, JSON.stringify(ic.item[k] ?? null)?.slice(0, 60));
  fixtures["issues-closed.json"] = issuesClosed.json;
}

// 4) comments первого issue
if (ii.item && typeof ii.item["slug"] === "string") {
  const slug = ii.item["slug"];
  const comments = await get("issue comments", `/repos/${DOZZLE}/issues/${slug}/comments?page_size=3`);
  const cm = firstItem(comments.json);
  console.log("  список в ключе:", cm.listKey, "| записей:", cm.n);
  if (cm.item) {
    console.log("  поля comment:", keys(cm.item));
    const c0 = (comments.json as Record<string, unknown>)[cm.listKey] as Record<string, unknown>[];
    if (c0.length >= 2) console.log("  первый комментарий старее второго (asc):", String(c0[0]!["created_at"]) <= String(c0[1]!["created_at"]));
    fixtures["issue-comments.json"] = comments.json;
  } else {
    console.log("  (у свежего issue комментариев нет — пустой список)");
    fixtures["issue-comments.json"] = comments.json;
  }
}

// 5) pulls open
const pulls = await get("pulls (open)", `/repos/${DOZZLE}/pulls?filter=status%3Dopen&page_size=2`);
const pi = firstItem(pulls.json);
console.log("  список в ключе:", pi.listKey, "| записей:", pi.n);
if (pi.item) {
  console.log("  поля pull:", keys(pi.item));
  fixtures["pulls-open.json"] = pulls.json;
}

// 6) contributors
const contribs = await get("contributors", `/repos/${DOZZLE}/contributors?page_size=2`);
const ci = firstItem(contribs.json);
console.log("  список в ключе:", ci.listKey, "| записей:", ci.n);
if (ci.item) {
  console.log("  поля contributor:", keys(ci.item));
  console.log("    sample:", JSON.stringify(ci.item).slice(0, 200));
  fixtures["contributors.json"] = contribs.json;
}

// 7) releases
const releases = await get("releases", `/repos/${DOZZLE}/releases?page_size=2&sort_by=-released_at`);
const ri = firstItem(releases.json);
console.log("  список в ключе:", ri.listKey, "| записей:", ri.n);
if (ri.item) {
  console.log("  поля release:", keys(ri.item));
  fixtures["releases.json"] = releases.json;
}

// 8) rating (мой реактив — спека: GetMyRatingReaction)
const rating = await get("rating (my reaction)", `/repos/${DOZZLE}/rating`);
console.log("  тело:", JSON.stringify(rating.json)?.slice(0, 200));
fixtures["rating.json"] = rating.json;

// 9) cicd/runs чужого (ожидание 403)
const runs403 = await get("cicd/runs ЧУЖОГО репо (dozzle-plus)", `/repos/${DOZZLE}/cicd/runs?page_size=2`);
console.log("  тело:", JSON.stringify(runs403.json)?.slice(0, 200));
fixtures["cicd-runs-403.json"] = runs403.json;

// 10) cicd/runs СВОЕГО репо (права токена)
const runsOwn = await get("cicd/runs СВОЕГО репо", `/repos/${OWN}/cicd/runs?page_size=2`);
const oi = firstItem(runsOwn.json);
if (runsOwn.status === 200 && oi.item) {
  console.log("  список в ключе:", oi.listKey, "| записей:", oi.n);
  console.log("  поля run:", keys(oi.item));
  console.log("    sample:", JSON.stringify(oi.item).slice(0, 300));
  fixtures["cicd-runs-own.json"] = runsOwn.json;
}

if (process.argv.includes("--fixtures")) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("tests/fixtures/rest", { recursive: true });
  for (const [name, json] of Object.entries(fixtures)) {
    writeFileSync(`tests/fixtures/rest/${name}`, JSON.stringify(json, null, 1));
    console.log(`\nфикстура tests/fixtures/rest/${name} записана`);
  }
}
export {};
