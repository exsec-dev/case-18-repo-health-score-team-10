// Пересканирование всех 14 репо выборки docs/sample-repos.md одним клиентом:
// общий бюджет до 850 живых REST-запросов (M2_BUDGET), интервал ≥ 50 мс,
// каталог не обходится. Лимиты клонов — из Config.scan (divkit и
// openintegrations уходят в деградационный ярус). Оценки и рекомендации
// пишет хук раннера.
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
