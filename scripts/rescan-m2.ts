// rescan-m2.ts — приёмочный прогон В2 (Б5): re-scan всех 14 репо
// выборки docs/sample-repos.md ОДНИМ клиентом — глобальный бюджет
// ≤850 живых REST-запросов (лимит промпта), интервал ≥50мс, catalog
// не обходится, rating не запрашивается. Клоны по Config.scan
// (divkit/openintegrations — деградационный ярус 2000МБ/20мин).
// Score/recommendations пишет hook раннера автоматически.
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { makeScClient } from "../src/collectors/http";
import { runScan, scanCloneLimitsOf } from "../src/jobs/runner";

// деградационные кейсы — в конце, чтобы остальной прогон не ждал их
const REPOS = [
  "manytask/manytask",
  "k-5-45mm/dozzle-plus",
  "hex21h/datahint",
  "yandex-cloud-examples/cloudapp-hugo",
  "sourcecraft/yc-ci-cd-serverless",
  "sourcecraft/appsec",
  "a13xp0p0v/kernel-hardening-checker",
  "gravity-ui/uikit",
  "testplane/testplane",
  "mairamscpsl/parser-tekstov-osetinskogo-iazyka",
  "plusovichki/priplusnutaya-laba-1",
  "raph/its-wednesday-my-dudes",
  "divkit/divkit",
  "bayselonarrend/openintegrations",
];

const BUDGET = Number(process.env.M2_BUDGET ?? 850);
const config = loadConfig();
const db = openDb(config);
const client = makeScClient({
  token: config.sourcecraftToken,
  // П3 (В4.2-port-fix): адрес REST — из конфига, а не дефолт модуля
  baseUrl: config.api.restBase,
  minIntervalMs: config.scan.rest.minIntervalMs,
  maxRequests: BUDGET,
});

console.log(`re-scan M2: ${REPOS.length} repos, budget ${BUDGET} requests, dataDir ${config.dataDir}`);
for (const slug of REPOS) {
  const t0 = Date.now();
  try {
    const res = await runScan(
      {
        db,
        scClient: client,
        cloneLimits: scanCloneLimitsOf(config.scan),
        gitBase: config.api.gitBase,
        restBase: config.api.restBase,
        appsecBase: config.api.appsecBase,
        appsecMinIntervalMs: config.scan.rest.appsecMinIntervalMs,
      },
      slug,
      { trigger: "user" },
    );
    const score = res.score ? `index=${res.score.healthcraftIndex ?? "NULL"} cov=${res.score.indexCoverage.toFixed(2)}` : "score=HOOK-FAIL";
    console.log(
      `[ok] ${slug} scan=${res.scanId} ${res.status} git=${res.channels.git} facts=${res.counts.ok}/${res.counts.noData}/${res.counts.bad} ${score} req=${client.requestCount()} ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  } catch (e) {
    console.error(`[fail] ${slug}: ${String((e as Error).message).slice(0, 300)}`);
  }
}
console.log(`TOTAL live REST requests: ${client.requestCount()}/${BUDGET}`);
db.close();
