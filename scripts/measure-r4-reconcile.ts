// Замер: сколько INSERT/UPDATE в repos делает часовая сверка на неизмененном
// каталоге размером с живой публичный каталог SourceCraft. Считают SQL-триггеры
// на временной БД, плюс время прохода. Ожидание — 0 записей: неизмененный
// каталог не должен ничего переписывать.
//
// Запуск: bun scripts/measure-r4-reconcile.ts
// Живой БД и сети не касается: каталог — фейковый клиент, отдающий ровно
// засеянные строки; БД — во временном каталоге.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { nightlyCatalog } from "../src/jobs/scheduler";
import type { ScClient, ScResponse } from "../src/collectors/http";

const N = 27_446; // замеренный размер живого каталога
const PAGE = 100; // page_size сверки
const dir = mkdtempSync(join(tmpdir(), "rh-r4-measure-"));
const db = openDb({ ...loadConfig(), dataDir: dir });

try {
  // сид: 27 446 строк repos с метой, которую каталог «отдаёт» без изменений
  const seed = db.query(
    "INSERT INTO repos (org_slug, repo_slug, title, language, likes, visibility, logo_url, language_color, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      seed.run(`m${i}`, `r${i}`, `title-${i}`, i % 5 === 0 ? "TypeScript" : null, i % 97, "public", `https://logo.example/${i}.png`, i % 5 === 0 ? "#3178c6" : null, "2026-09-10T00:00:00Z");
    }
  })();

  // триггеры-счётчики ПОСЛЕ сида: посев в замер не попадает
  db.exec("CREATE TABLE measure_audit (kind TEXT NOT NULL)");
  db.exec("CREATE TRIGGER measure_after_ins AFTER INSERT ON repos BEGIN INSERT INTO measure_audit VALUES ('insert'); END");
  db.exec("CREATE TRIGGER measure_after_upd AFTER UPDATE ON repos BEGIN INSERT INTO measure_audit VALUES ('update'); END");

  // фейковый каталог: те же записи постранично (275 страниц), курсор — номер
  const totalPages = Math.ceil(N / PAGE);
  let page = 0;
  const client: ScClient = {
    async get(path: string): Promise<ScResponse> {
      if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
      const start = page * PAGE;
      const count = Math.min(PAGE, N - start);
      const repositories = Array.from({ length: count }, (_, k) => {
        const i = start + k;
        return {
          organization: { slug: `m${i}` },
          slug: `r${i}`,
          name: `title-${i}`,
          visibility: "public",
          last_updated: "2026-09-10T00:00:00Z",
          language: i % 5 === 0 ? { name: "TypeScript", color: "#3178c6" } : null,
          rating: { value: i % 97 },
          logo: i % 2 === 0 ? { url: `https://logo.example/${i}.png` } : null,
        };
      });
      page++;
      return { status: 200, json: { repositories, next_page_token: page < totalPages ? `t${page}` : "" }, bodyText: "" };
    },
    requestCount: () => page,
  };

  // часовая сверка: фаза reconcile (ночную волну не исполняем — измеряется
  // именно путь сверки, который и ходит 24 раза в сутки)
  const t0 = Date.now();
  const out = await nightlyCatalog(db, client, { maxPages: 1000, phases: { reconcile: true, nightly: false }, now: new Date("2026-09-18T00:00:00Z") });
  const elapsedMs = Date.now() - t0;

  const rows = db.query("SELECT kind, COUNT(*) AS c FROM measure_audit GROUP BY kind").all() as { kind: string; c: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.c])) as { insert?: number; update?: number };
  console.log(`[measure-r4] catalog: entries=${out.entriesSeen} pages=${out.pages} ok=${out.ok} complete=${out.catalogComplete} enqueued=${out.enqueued.length}`);
  console.log(`[measure-r4] repos writes: inserts=${by.insert ?? 0} updates=${by.update ?? 0} TOTAL=${(by.insert ?? 0) + (by.update ?? 0)} elapsedMs=${elapsedMs}`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
