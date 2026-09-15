// probe-api.ts — живой зонд SourceCraft (В0): что доступно без токена,
// где живёт каталог открытых репо (вопрос 1 канвы), реальная форма
// ответов. Печатает находки — топливо для коллекторов В1.
// Usage: bun scripts/probe-api.ts [SOURCECRAFT_TOKEN]
const TOKEN = process.argv[2] ?? process.env.SOURCECRAFT_TOKEN ?? "";
const API = "https://api.sourcecraft.tech";

async function probe(label: string, url: string, headers: Record<string, string> = {}) {
  try {
    const r = await fetch(url, { headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers } });
    const text = await r.text();
    console.log(`${r.status} ${label} — ${text.slice(0, 160).replace(/\n/g, " ")}`);
    return r.status;
  } catch (e) {
    console.log(`ERR ${label} — ${String(e).slice(0, 120)}`);
    return 0;
  }
}

// 1) API без токена (ожидаем 401) и с токеном
await probe("GET /user (без/с токеном)", `${API}/user`);

// 2) каталог открытых репо: веб-страница (там же живёт её внутренний API?)
const cat = await fetch("https://sourcecraft.dev/find/repositories", { headers: { "Accept": "text/html" } });
const html = await cat.text();
console.log(`\n${cat.status} каталог: ${html.length} байт html`);
// ищем слаги org/repo прямо в разметке и ссылки на api
const slugs = [...new Set((html.match(/["']([a-z0-9-_.]+\/[a-z0-9-_.]+)["']/gi) ?? []).map((s) => s.slice(1, -1)))].slice(0, 10);
console.log("  кандидаты слагов в разметке:", slugs.join(", ") || "нет");
const apiRefs = [...new Set(html.match(/api\.sourcecraft[^"'\s)]+/g) ?? [])].slice(0, 5);
console.log("  ссылки на api внутри:", apiRefs.join(", ") || "нет");

// 3) sitemap — самый честный энумератор
await probe("sitemap.xml", "https://sourcecraft.dev/sitemap.xml");

// 4) один репозиторий по слагу (если нашли)
if (slugs[0]) {
  const [org, repo] = slugs[0]!.split("/");
  await probe(`GET /repos/${slugs[0]}`, `${API}/repos/${org}/${repo}`);
  await probe(`GET .../cicd/runs`, `${API}/repos/${org}/${repo}/cicd/runs`);
  await probe(`GET .../issues`, `${API}/repos/${org}/${repo}/issues`);
  await probe(`GET .../contributors`, `${API}/repos/${org}/${repo}/contributors`);
  await probe(`GET .../rating`, `${API}/repos/${org}/${repo}/rating`);
}
export {};
