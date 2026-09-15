// server.ts — health-check + фронтенд (React + Gravity UI, бандлит Bun
// из HTML-импорта; dev — HMR, NODE_ENV=production — бандл без HMR).
// Роуты растут по вехам.
import { loadConfig } from "./config";
import { openDb } from "./db";
import index from "./web/index.html";

const config = loadConfig();
const db = openDb(config);

const server = Bun.serve({
  port: config.port,
  routes: {
    "/": index,
    "/api/health": () => {
      const n = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
      return Response.json({ ok: true, repos: n, llmProvider: config.llm.provider });
    },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
