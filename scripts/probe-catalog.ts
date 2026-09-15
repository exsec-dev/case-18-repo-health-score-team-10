// probe-catalog.ts — зонд-фиксация механизма каталога (Б2, план В1):
// недокументированный GET /repos?page_token= — форма ответа, курсор,
// фильтр visibility (query-параметр или клиентски), живые фиксстуры
// для тестов (tests/fixtures/catalog/). Токен из .env, значение не
// печатается. Бюджет: ~5 запросов, интервал ≥50мс.
// Usage: bun scripts/probe-catalog.ts [--fixtures]
import { loadConfig } from "../src/config";

const API = "https://api.sourcecraft.tech";
const config = loadConfig();
if (!config.sourcecraftToken) {
  console.error("SOURCECRAFT_TOKEN отсутствует в .env — каталог без токена отдаёт 401");
  process.exit(1);
}

let lastRequestAt = 0;
async function get(path: string): Promise<{ status: number; json: unknown; raw: string }> {
  const wait = 50 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${config.sourcecraftToken}` } });
  lastRequestAt = Date.now();
  const raw = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* не json */
  }
  return { status: r.status, json, raw };
}

function keysOf(obj: unknown): string[] {
  return obj && typeof obj === "object" ? Object.keys(obj as Record<string, unknown>) : [];
}

// 1) первая страница: форма
const p1 = await get("/repos");
console.log(`GET /repos → ${p1.status}`);
const page1 = p1.json as Record<string, unknown> | null;
if (page1) {
  console.log("  верхнеуровневые ключи:", keysOf(page1).join(", "));
  const listKey = keysOf(page1).find((k) => Array.isArray((page1 as Record<string, unknown>)[k]));
  console.log("  ключ списка:", listKey ?? "НЕТ");
  const list = listKey ? ((page1[listKey] as unknown[]) ?? []) : [];
  console.log(`  записей на странице: ${list.length}`);
  if (list[0]) {
    const e = list[0] as Record<string, unknown>;
    console.log("  поля записи:", keysOf(e).join(", "));
    console.log("  запись-образец (обрезан):", JSON.stringify(e).slice(0, 400));
    for (const k of ["org", "counters", "rating", "visibility", "clone_url", "last_updated"]) {
      if (k in e) console.log(`    ${k} =`, JSON.stringify(e[k]).slice(0, 120));
    }
  }
  console.log("  next_page_token:", JSON.stringify(page1["next_page_token"] ?? null).slice(0, 80));
}

// 2) фильтр visibility как query-параметр (один запрос)
const pf = await get("/repos?visibility=public");
console.log(`\nGET /repos?visibility=public → ${pf.status}`);
const pageF = pf.json as Record<string, unknown> | null;
if (pageF) {
  const listKey = keysOf(pageF).find((k) => Array.isArray(pageF[k]));
  const list = listKey ? ((pageF[listKey] as unknown[]) ?? []) : [];
  const vis = new Set(list.map((x) => String((x as Record<string, unknown>)["visibility"] ?? "?")));
  console.log(`  записей: ${list.length}, значения visibility: ${[...vis].join(",")}`);
  console.log("  вердикт: фильтр", list.length === 20 ? "ПРИНИМАЕТСЯ сервером? (нужно сравнить состав)" : "скорее игнорируется/ошибка");
}

// 3) курсор: вторая страница
if (page1?.["next_page_token"]) {
  const p2 = await get(`/repos?page_token=${encodeURIComponent(String(page1["next_page_token"]))}`);
  console.log(`\nGET /repos?page_token=<next> → ${p2.status}`);
  const page2 = p2.json as Record<string, unknown> | null;
  if (page2) {
    const listKey = keysOf(page2).find((k) => Array.isArray(page2[k]));
    const l1 = page1[listKeyOf(page1)] as unknown[];
    const l2 = (page2[listKey ?? ""] as unknown[]) ?? [];
    const slug = (x: unknown) => {
      const e = x as Record<string, unknown>;
      return `${e["org"]}/${e["slug"]}`;
    };
    const overlap = l1.filter((x) => l2.some((y) => slug(x) === slug(y))).length;
    console.log(`  записей: ${l2.length}, пересечение со стр.1: ${overlap} (0 = курсор работает)`);
    console.log("  next_page_token:", JSON.stringify(page2["next_page_token"] ?? null).slice(0, 80));
  }
}

function listKeyOf(page: Record<string, unknown> | null): string {
  return keysOf(page).find((k) => Array.isArray(page?.[k])) ?? "?";
}

// 4) живые фиксстуры для тестов
if (process.argv.includes("--fixtures")) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("tests/fixtures/catalog", { recursive: true });
  if (page1) writeFileSync("tests/fixtures/catalog/page-1.json", JSON.stringify(page1, null, 1));
  console.log("\nфикстура tests/fixtures/catalog/page-1.json записана");
}
export {};
