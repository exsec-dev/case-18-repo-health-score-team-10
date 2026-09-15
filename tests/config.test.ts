// config.test.ts — В2/Б1: ScanConfig (консолидация лимитов 15.09):
// дефолты в коде, env-override чистой функцией scanFromEnv (инъекция,
// не файлы), fail-soft на мусорных значениях.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SCAN, scanFromEnv } from "../src/config";

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

  test("дефолты соответствуют решениям канвы (500МБ/10мин + 2000МБ/20мин/13мес)", () => {
    expect(DEFAULT_SCAN.clone.maxBytes).toBe(500 * 1024 * 1024);
    expect(DEFAULT_SCAN.clone.timeoutMs).toBe(10 * 60_000);
    expect(DEFAULT_SCAN.degrade.maxBytes).toBe(2000 * 1024 * 1024);
    expect(DEFAULT_SCAN.degrade.timeoutMs).toBe(20 * 60_000);
    expect(DEFAULT_SCAN.degrade.sinceMonths).toBe(13);
    expect(DEFAULT_SCAN.extract).toEqual({ maxBlameFiles: 200, textCapBytes: 1_000_000, commentsTopN: 50 });
  });
});
