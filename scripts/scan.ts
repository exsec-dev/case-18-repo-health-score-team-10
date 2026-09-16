// scan.ts — точка входа скана (Б4): bun scripts/scan.ts <org/repo>
// Вызывает runScan НАПРЯМУЮ (очередь-механика — В4). Печатает
// scan_id, статус, счётчики фактов — приёмочный прогон HQ.
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { makeScClient } from "../src/collectors/http";
import { runScan, scanCloneLimitsOf } from "../src/jobs/runner";

const slug = process.argv[2];
if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) {
  console.error("usage: bun scripts/scan.ts <org/repo>");
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config);
const client = makeScClient({
  token: config.sourcecraftToken,
  minIntervalMs: config.scan.rest.minIntervalMs,
  maxRequests: config.scan.rest.budget,
});

const result = await runScan(
  { db, scClient: client, cloneLimits: scanCloneLimitsOf(config.scan), appsecMinIntervalMs: config.scan.rest.appsecMinIntervalMs },
  slug,
  { trigger: process.env.SCAN_TRIGGER ?? "user" },
);

console.log(`scan_id=${result.scanId} repo_id=${result.repoId} status=${result.status}`);
console.log(`  facts: ok=${result.counts.ok} no-data=${result.counts.noData} bad=${result.counts.bad}`);
console.log(`  channels: git=${result.channels.git} rest=${result.channels.rest}`);
console.log(`  ${result.startedAt} → ${result.finishedAt} (${result.elapsedMs} ms, rest-requests=${client.requestCount()})`);
db.close();
process.exit(result.status === "bad" ? 1 : 0);
