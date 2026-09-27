// Живой зонд формы SCA-данных AppSec: отдает ли API граф зависимостей (цепочки
// «код → пакет A → пакет B с уязвимостью») или только плоские находки. По
// разъяснению организаторов граф уязвимостей SCA должен входить в оценку.
// Не больше 5 GET-запросов, только чтение, без записи в БД; токен из .env не
// печатается; ответы — сводно: ключи, счетчики и признаки графа (path/parent/chain/
// transitive/depend), значения — усеченно.
// Usage: bun scripts/probe-appsec-sca.ts <свой org/repo с AppSec>
import { loadConfig } from "../src/config";

const [slug] = process.argv.slice(2);
if (!slug?.includes("/")) {
  console.error("usage: bun scripts/probe-appsec-sca.ts <org/repo>");
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
const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
let calls = 0;

async function get(label: string, url: string): Promise<{ status: number; json: unknown }> {
  if (calls >= 5) throw new Error("лимит зонда — 5 запросов");
  if (calls > 0) await new Promise((r) => setTimeout(r, 300));
  calls++;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  const safeUrl = url
    .replace(/scanUuid=[^&]+/, "scanUuid=<uuid>")
    .replace(/gitRepo=[^&]+/, "gitRepo=<id>")
    .replace(/defectGroupUuid=[^&]+/, "defectGroupUuid=<uuid>")
    .replace(/\/v1\/scans\/[0-9a-f-]{20,}/, "/v1/scans/<uuid>");
  console.log(`\n### ${label}\n${r.status} GET ${safeUrl}`);
  if (r.status !== 200) console.log(`тело ошибки (начало): ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  return { status: r.status, json };
}

const listOf = (json: unknown): Record<string, unknown>[] => {
  const o = json as Record<string, unknown> | null;
  if (!o) return [];
  const k = Object.keys(o).find((key) => Array.isArray(o[key]));
  return k ? (o[k] as Record<string, unknown>[]) : [];
};
const GRAPH = /path|parent|chain|transitiv|depend|introduc|direct|via|tree|graph|root/i;
/** Ключи объекта рекурсивно (до глубины 3) и признаки графа с усеченным значением. */
function shape(obj: unknown, prefix = "", depth = 0, out: string[] = [], hits: string[] = []): { keys: string[]; hits: string[] } {
  if (obj === null || typeof obj !== "object" || depth > 3) return { keys: out, hits };
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const kind = Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
    out.push(`${key}: ${kind}`);
    if (GRAPH.test(k)) hits.push(`${key} = ${JSON.stringify(v)?.slice(0, 160)}`);
    if (Array.isArray(v) && v.length > 0) shape(v[0], `${key}[0]`, depth + 1, out, hits);
    else if (v && typeof v === "object") shape(v, key, depth + 1, out, hits);
  }
  return { keys: out, hits };
}
const report = (title: string, obj: unknown) => {
  const s = shape(obj);
  console.log(`${title} — ключи:\n  ${s.keys.slice(0, 60).join("\n  ")}${s.keys.length > 60 ? `\n  … еще ${s.keys.length - 60}` : ""}`);
  console.log(`признаки графа: ${s.hits.length === 0 ? "нет" : `\n  ${s.hits.join("\n  ")}`}`);
};

// 1. id репозитория
const repo = await get("repo GET (id для AppSec)", `${API}/repos/${enc(slug)}`);
const gitRepo = (repo.json as { id?: unknown } | null)?.id;
if (typeof gitRepo !== "string" && typeof gitRepo !== "number") {
  console.log("\nid репозитория не получен — зонд остановлен");
  process.exit(0);
}
const gr = encodeURIComponent(String(gitRepo));

// 2. последний скан AppSec
const latest = await get("AppSec scans/latest", `${APPSEC}/v1/scans/latest?gitRepo=${gr}`);
const lj = latest.json as { uuid?: unknown; scan?: { uuid?: unknown } } | null;
const uuid = typeof lj?.uuid === "string" ? lj.uuid : typeof lj?.scan?.uuid === "string" ? lj.scan.uuid : null;
if (latest.status === 200) report("scans/latest", latest.json);

// 3. детали скана — есть ли зависимости (в спеке ScanDetailsDto их нет, у сущности Scan — есть плоским списком)
if (uuid !== null) {
  const det = await get("AppSec scans/{uuid} (детали скана)", `${APPSEC}/v1/scans/${encodeURIComponent(uuid)}?gitRepo=${gr}`);
  if (det.status === 200) report("scans/{uuid}", det.json);
}

// 4. группы дефектов SCA
const dg = await get("AppSec defect-groups type=SCA", `${APPSEC}/v1/defect-groups?gitRepo=${gr}&type=SCA&pageSize=5&pageToken=`);
const groups = listOf(dg.json);
console.log(`SCA-групп в ответе: ${groups.length}`);
if (groups[0]) report("первая SCA-группа", groups[0]);

// 5. находки первой SCA-группы — путь зависимости в properties?
const g0 = groups[0] as { uuid?: unknown; publicId?: unknown } | undefined;
if (g0 && typeof g0.uuid === "string") {
  const f = await get("AppSec findings первой SCA-группы", `${APPSEC}/v1/findings?gitRepo=${gr}&defectGroupUuid=${encodeURIComponent(g0.uuid)}&pageSize=3&pageToken=`);
  const items = listOf(f.json);
  console.log(`находок в ответе: ${items.length}`);
  if (items[0]) report("первая находка SCA", items[0]);
}
console.log(`\nзапросов: ${calls}`);
