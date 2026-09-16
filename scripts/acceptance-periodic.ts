// acceptance-periodic.ts — приёмка периодики В4/Б3 живым прогоном в
// ИЗОЛИРОВАННОЙ БД (env DATA_DIR ведёт в tmp): два живых обхода каталога
// по 2 страницы (бюджет приёмки «каталог ≤4 страницы»), второй прогон с
// неизменным last_updated НЕ ставит ничего в очередь; форс-тогл — на
// мок-клиенте (ноль живых запросов). Сканы не исполняются: проверяется
// механика диффа очереди, не коллекторы (они покрыты своими тестами и
// rescan-m2). Живая эвикция не ищется (репо из каталога не удалить) —
// фикстурный тест + пометка «живая проверка на стенде в В6».
const DATA_DIR = "/tmp/rh-periodic-acceptance";
process.env.DATA_DIR = DATA_DIR;

import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { makeScClient, type ScClient } from "../src/collectors/http";
import { nightlyCatalog, finishJob, claimNext } from "../src/jobs/scheduler";

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#")) continue;
  const idx = s.indexOf("=");
  if (idx > 0) env[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
}

const config = loadConfig();
const db = openDb(config);
const live = () => makeScClient({ token: env.SOURCECRAFT_TOKEN ?? null, minIntervalMs: config.scan.rest.minIntervalMs, maxRequests: 4 });

console.log("=== прогон 1 (живой, 2 страницы): новые репо → очередь");
const r1 = await nightlyCatalog(db, live(), { maxPages: 2 });
console.log(`pages=${r1.pages} seen=${r1.entriesSeen} enqueued=${r1.enqueued.length} (new: ${r1.enqueued.filter((e) => e.reason === "new").length}) evicted=${r1.evicted.length} complete=${r1.catalogComplete}`);
if (!r1.ok) {
  console.error("каталог упал:", r1.error);
  process.exit(1);
}

// заявляем и «закрываем» без скана — механика диффа, не коллекция
let drained = 0;
for (;;) {
  const job = claimNext(db);
  if (!job) break;
  finishJob(db, job.id, job.claimedAt, "done");
  drained++;
}
console.log(`очередь после прогона 1: ${drained} jobs закрыты (без исполнения сканов)`);

console.log("=== прогон 2 (живой, 2 страницы): неизменный last_updated → очередь пуста");
const r2 = await nightlyCatalog(db, live(), { maxPages: 2 });
console.log(`pages=${r2.pages} seen=${r2.entriesSeen} enqueued=${r2.enqueued.length} evicted=${r2.evicted.length} returned=${r2.returned.length}`);
const queued2 = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued'").get() as { c: number }).c;
console.log(`осталось queued: ${queued2}`);
console.log(queued2 === 0 ? "ИНВАРИАНТ ДЕРЖИТСЯ: неизменный каталог не ставит ничего в очередь" : "НАРУШЕНИЕ: очередь не пуста");

console.log("=== прогон 3 (мок-клиент, 0 живых запросов): форс-полный тогл");
const repos = db.query("SELECT org_slug, repo_slug, last_activity_at FROM repos").all() as {
  org_slug: string;
  repo_slug: string;
  last_activity_at: string | null;
}[];
const fake: ScClient = {
  async get() {
    return {
      status: 200,
      json: {
        repositories: repos.map((r) => ({ organization: { slug: r.org_slug }, slug: r.repo_slug, last_updated: r.last_activity_at, visibility: "public" })),
        next_page_token: "",
      },
      bodyText: "",
    };
  },
  requestCount: () => 0,
};
const r3 = await nightlyCatalog(db, fake, { fullRescan: true });
console.log(`forced=${r3.enqueued.filter((e) => e.reason === "forced").length}/${r3.enqueued.length} enqueued`);
console.log(r3.enqueued.length === repos.length && r3.enqueued.every((e) => e.reason === "forced") ? "ФОРС-ТОГЛ РАБОТАЕТ" : "ФОРС-ТОГЛ НАРУШЕН");

db.close();
rmSync(DATA_DIR, { recursive: true, force: true });
console.log("done (БД изолированная, удалена)");
