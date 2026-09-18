// config.test.ts — В2/Б1: ScanConfig (консолидация лимитов 15.09):
// дефолты в коде, env-override чистой функцией scanFromEnv (инъекция,
// не файлы), fail-soft на мусорных значениях.
import { describe, expect, test } from "bun:test";
import { apiBaseFromEnv, DEFAULT_SCAN, defaultLeaseMs, loadConfig, scanFromEnv } from "../src/config";

describe("очередь, лиз и доступ (В4.1, К2/К4)", () => {
  test("дефолты: лиз = клон + деградация + 15 мин (60 мин); 10 заявок/час; 3 попытки; кэш доступа 15 мин", () => {
    expect(defaultLeaseMs(DEFAULT_SCAN)).toBe(60 * 60_000);
    const keys = [
      "SCHEDULER_LEASE_MS",
      "QUEUE_USER_SCANS_PER_HOUR",
      "QUEUE_MAX_ATTEMPTS",
      "ACCESS_CACHE_TTL_MS",
      "SCAN_CLONE_TIMEOUT_MS",
      "SCAN_DEGRADE_TIMEOUT_MS",
      // В4.2-port-fix (П2): лимит проверок прав избранного и кулдаун автозаявки
      "QUEUE_FAVORITE_CHECKS_PER_MINUTE",
      "QUEUE_FAVORITE_OWN_COOLDOWN_MS",
      // В4.2a: ретеншен очереди (Ф2.13) и интервал сверки каталога (Ф2.5)
      "QUEUE_RETENTION_DAYS",
      "SCHEDULER_CATALOG_INTERVAL_MS",
      "SCAN_EXTRACT_TIMEOUT_MS",
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      // пустая строка env = «не задано» (fail-soft) — перекрывает и .env
      for (const k of keys) process.env[k] = "";
      const cfg = loadConfig();
      expect(cfg.scheduler.leaseMs).toBe(60 * 60_000);
      expect(cfg.queue).toEqual({ userScansPerHour: 10, maxAttempts: 3, userActiveMax: 2, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 21_600_000, retentionDays: 30 });
      expect(cfg.access.cacheTtlMs).toBe(15 * 60_000);
      process.env.QUEUE_USER_SCANS_PER_HOUR = "4";
      process.env.QUEUE_MAX_ATTEMPTS = "5";
      process.env.ACCESS_CACHE_TTL_MS = "1000";
      process.env.SCAN_CLONE_TIMEOUT_MS = String(60_000);
      process.env.QUEUE_FAVORITE_CHECKS_PER_MINUTE = "3";
      process.env.QUEUE_FAVORITE_OWN_COOLDOWN_MS = "1000";
      process.env.QUEUE_RETENTION_DAYS = "7";
      const env = loadConfig();
      expect(env.queue).toEqual({ userScansPerHour: 4, maxAttempts: 5, userActiveMax: 2, favoriteChecksPerMinute: 3, favoriteOwnCooldownMs: 1000, retentionDays: 7 });
      expect(env.access.cacheTtlMs).toBe(1000);
      expect(env.scheduler.leaseMs).toBe(60_000 + 25 * 60_000 + 15 * 60_000);
      process.env.SCHEDULER_LEASE_MS = "12345";
      expect(loadConfig().scheduler.leaseMs).toBe(12345);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("scanFromEnv: слои дефолты ← env", () => {
  test("дефолты без env", () => {
    expect(scanFromEnv({})).toEqual(DEFAULT_SCAN);
  });

  test("все 6 env-имён пробиваются", () => {
    const cfg = scanFromEnv({
      SCAN_CLONE_TIMEOUT_MS: "1000",
      SCAN_CLONE_MAX_BYTES: "2000",
      SCAN_DEGRADE_TIMEOUT_MS: "3000",
      SCAN_DEGRADE_MAX_BYTES: "4000",
      SCAN_BUDGET: "500",
      SCAN_CATALOG_MAX_PAGES: "7",
    });
    expect(cfg.clone.timeoutMs).toBe(1000);
    expect(cfg.clone.maxBytes).toBe(2000);
    expect(cfg.degrade.timeoutMs).toBe(3000);
    expect(cfg.degrade.maxBytes).toBe(4000);
    expect(cfg.rest.budget).toBe(500);
    expect(cfg.catalog.maxPages).toBe(7);
    // не-переопределяемое
    expect(cfg.degrade.sinceMonths).toBe(DEFAULT_SCAN.degrade.sinceMonths);
    expect(cfg.rest.minIntervalMs).toBe(DEFAULT_SCAN.rest.minIntervalMs);
  });

  test("мусор/ноль/отрицательные → дефолт (fail-soft)", () => {
    const cfg = scanFromEnv({ SCAN_BUDGET: "abc", SCAN_CLONE_TIMEOUT_MS: "-5", SCAN_CATALOG_MAX_PAGES: "0" });
    expect(cfg.rest.budget).toBe(DEFAULT_SCAN.rest.budget);
    expect(cfg.clone.timeoutMs).toBe(DEFAULT_SCAN.clone.timeoutMs);
    expect(cfg.catalog.maxPages).toBe(DEFAULT_SCAN.catalog.maxPages);
  });

  test("дефолты соответствуют RESOLVED 17.09 (1.5ГБ/20мин + деградация 2.5ГБ/25мин ВКЛ)", () => {
    expect(DEFAULT_SCAN.clone.maxBytes).toBe(1.5 * 1024 * 1024 * 1024);
    expect(DEFAULT_SCAN.clone.timeoutMs).toBe(20 * 60_000);
    expect(DEFAULT_SCAN.degrade.maxBytes).toBe(2.5 * 1024 * 1024 * 1024);
    expect(DEFAULT_SCAN.degrade.timeoutMs).toBe(25 * 60_000);
    expect(DEFAULT_SCAN.degrade.sinceMonths).toBe(13);
    expect(DEFAULT_SCAN.degrade.enabled).toBe(true);
    expect(DEFAULT_SCAN.rest.appsecMinIntervalMs).toBe(100);
    expect(DEFAULT_SCAN.extract).toEqual({ maxBlameFiles: 200, textCapBytes: 1_000_000, commentsTopN: 50 });
  });

  test("тогл деградации и appsec-интервал пробиваются env (В4)", () => {
    const cfg = scanFromEnv({ SCAN_DEGRADE_ENABLED: "false", SCAN_APPSEC_MIN_INTERVAL_MS: "250" });
    expect(cfg.degrade.enabled).toBe(false);
    expect(cfg.rest.appsecMinIntervalMs).toBe(250);
    expect(scanFromEnv({ SCAN_DEGRADE_ENABLED: "мусор" }).degrade.enabled).toBe(true);
  });
});

describe("круг 2 (LOW-11): адреса API только https (кроме localhost)", () => {
  test("https и http://localhost|127.0.0.1 принимаются; http на внешний хост и мусор — дефолт", () => {
    const d = "https://api.sourcecraft.tech";
    const v = (raw: string) => apiBaseFromEnv({ X: raw }, "X", d);
    expect(v("https://mirror.example/api/")).toBe("https://mirror.example/api");
    expect(v("http://127.0.0.1:4010")).toBe("http://127.0.0.1:4010");
    expect(v("http://localhost:4010")).toBe("http://localhost:4010");
    expect(v("http://evil.example")).toBe(d);
    expect(v("ftp://127.0.0.1")).toBe(d);
    expect(v("not a url")).toBe(d);
    expect(apiBaseFromEnv({}, "X", d)).toBe(d);
  });
});
