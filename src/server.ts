// server.ts — В0-скелет: health-check + статика. Роуты растут по вехам.
import { loadConfig } from "./config";
import { openDb } from "./db";

const config = loadConfig();
const db = openDb(config);

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") {
      const n = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
      return Response.json({ ok: true, repos: n, llmProvider: config.llm.provider });
    }
    if (url.pathname === "/") return new Response(Bun.file("static/index.html"));
    return new Response("not found", { status: 404 });
  },
});

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
