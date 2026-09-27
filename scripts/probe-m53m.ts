// Живой зонд (3-4 запроса) двух форм запросов, которые сборщик фактов версии 3
// шлет впервые и которые без сети не проверить:
//   1) задачи с фильтром `status=in_progress` (enum спеки open | in_progress | closed);
//   2) AppSec `/v1/defect-groups` с повтором ключа `status` (открытые статусы групп).
// Только чтение, без записи в БД; токен из .env не печатается; ответы — сводно
// (статус, ключи, счетчики), без содержимого задач и находок.
// Usage: bun scripts/probe-m53m.ts <публичный org/repo с задачами> <свой org/repo с AppSec>
import { loadConfig } from "../src/config";

const [issuesRepo, appsecRepo] = process.argv.slice(2);
if (!issuesRepo?.includes("/") || !appsecRepo?.includes("/")) {
  console.error("usage: bun scripts/probe-m53m.ts <org/repo issues> <org/repo appsec>");
  process.exit(2);
}
const config = loadConfig();
const token = config.sourcecraftToken;
if (!token) {
  console.error("SOURCECRAFT_TOKEN отсутствует в .env");
  process.exit(1);
}
const API = "https://api.sourcecraft.tech";
const APPSEC = config.api.appsecBase;
const enc = (slug: string) => slug.split("/").map(encodeURIComponent).join("/");
let calls = 0;

async function get(label: string, url: string): Promise<{ status: number; json: unknown }> {
  if (calls > 0) await new Promise((r) => setTimeout(r, 200));
  calls++;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  const safeUrl = url.replace(/scanUuid=[^&]+/, "scanUuid=<uuid>").replace(/gitRepo=[^&]+/, "gitRepo=<id>");
  console.log(`\n### ${label}\n${r.status} GET ${safeUrl}`);
  if (r.status !== 200) console.log(`тело ошибки (начало): ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  return { status: r.status, json };
}

const listOf = (json: unknown): unknown[] => {
  const o = json as Record<string, unknown> | null;
  if (!o) return [];
  const k = Object.keys(o).find((key) => Array.isArray(o[key]));
  return k ? (o[k] as unknown[]) : [];
};

// 1. задачи in_progress — тот же запрос, что шлет `rest.ts` (issues-in-progress)
const ip = await get("issues status=in_progress", `${API}/repos/${enc(issuesRepo)}/issues?filter=status%3Din_progress&sort_by=-created_at&page_size=5`);
const ipItems = listOf(ip.json) as Record<string, unknown>[];
console.log(`задач в ответе: ${ipItems.length}; статусы: ${JSON.stringify([...new Set(ipItems.map((i) => JSON.stringify(i["status"] ?? null)))])}`);

// 2. AppSec: repo id → scans/latest → defect-groups с повтором status
const repo = await get("repo GET (id для AppSec)", `${API}/repos/${enc(appsecRepo)}`);
const gitRepo = (repo.json as { id?: unknown } | null)?.id;
if (typeof gitRepo !== "string" && typeof gitRepo !== "number") {
  console.log("\nid репозитория не получен — AppSec не проверен");
  console.log(`\nзапросов: ${calls}`);
  process.exit(0);
}
const latest = await get("AppSec scans/latest", `${APPSEC}/v1/scans/latest?gitRepo=${encodeURIComponent(String(gitRepo))}`);
const scanUuid = (latest.json as { uuid?: unknown; scan?: { uuid?: unknown } } | null);
const uuid = typeof scanUuid?.uuid === "string" ? scanUuid.uuid : typeof scanUuid?.scan?.uuid === "string" ? scanUuid.scan.uuid : null;
if (uuid === null) {
  console.log(`\nскан AppSec не найден (ключи ответа: ${scanUuid ? Object.keys(scanUuid).join(", ") : "—"}) — фильтр status не проверен`);
  console.log(`\nзапросов: ${calls}`);
  process.exit(0);
}
const qs = new URLSearchParams();
qs.append("gitRepo", String(gitRepo));
qs.append("scanUuid", uuid);
for (const st of ["OPEN", "TRIAGE_IN_PROGRESS", "TRIAGED_TP", "FIX_IN_PROGRESS"]) qs.append("status", st);
qs.append("pageSize", "50");
const dg = await get("AppSec defect-groups, status повтором ключа", `${APPSEC}/v1/defect-groups?${qs.toString()}`);
const groups = listOf(dg.json) as Record<string, unknown>[];
const byStatus: Record<string, number> = {};
for (const g of groups) byStatus[String(g["status"])] = (byStatus[String(g["status"])] ?? 0) + 1;
console.log(`групп в ответе: ${groups.length}; по статусам: ${JSON.stringify(byStatus)}`);
console.log(`\nзапросов: ${calls}`);
