// server.ts — фронтенд (React + Gravity UI, бандлит Bun из HTML-импорта;
// dev — HMR, NODE_ENV=production — бандл без HMR) + read-API В3.
// Сервер ТОЛЬКО разбирает запрос, валидирует и сериализует: вся логика
// чтения — чистые функции src/api/repos.ts (тестируются без HTTP).
// Живых вызовов наружу здесь нет: данные появляются исключительно сканом.
import { loadConfig } from "./config";
import { openDb } from "./db";
import { getMeta, getRepoCard, listRepos, parseReposQuery } from "./api/repos";
import { renderRepoReport } from "./report/markdown";
import index from "./web/index.html";

const config = loadConfig();
const db = openDb(config);

const badQuery = (message: string): Response =>
  Response.json({ error: { code: "bad_query", message } }, { status: 400 });
const notFound = (message: string): Response =>
  Response.json({ error: { code: "not_found", message } }, { status: 404 });

const server = Bun.serve({
  port: config.port,
  routes: {
    "/api/health": () => {
      const n = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
      return Response.json({ ok: true, repos: n, llmProvider: config.llm.provider });
    },
    "/api/meta": () => Response.json(getMeta(db)),
    "/api/repos": (req) => {
      const parsed = parseReposQuery(new URL(req.url).searchParams);
      if (!parsed.ok) return badQuery(parsed.message);
      return Response.json(listRepos(db, parsed.query));
    },
    "/api/repos/:org/:repo": (req) => {
      const card = getRepoCard(db, req.params.org, req.params.repo);
      if (!card) return notFound(`репозиторий ${req.params.org}/${req.params.repo} не найден в каталоге`);
      return Response.json(card);
    },
    "/api/repos/:org/:repo/report.md": (req) => {
      const { org, repo } = req.params;
      const card = getRepoCard(db, org, repo);
      if (!card) return notFound(`репозиторий ${org}/${repo} не найден в каталоге`);
      return new Response(renderRepoReport(card), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          // отчёт открывают как файл, а не читают в браузере
          "content-disposition": `attachment; filename="${org}-${repo}-health.md"`,
        },
      });
    },
    // неизвестный /api/* обязан остаться JSON-404, а не отдать HTML
    "/api/*": () => notFound("неизвестный endpoint"),
    // catch-all фронтенда: маршруты /repo/{org}/{repo} живут в History API,
    // прямая ссылка и F5 на карточке должны отдавать тот же бандл
    "/*": index,
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`repo-health слушает http://127.0.0.1:${server.port}`);
console.log(`  llm: ${config.llm.provider} (main=${config.llm.mainModel}, side=${config.llm.sideModel})`);
console.log(`  sourcecraft token: ${config.sourcecraftToken ? "есть" : "НЕТ (зонд 401)"}`);
