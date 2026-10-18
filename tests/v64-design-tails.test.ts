// Хвосты правок дизайна 18.10: пояснение порога в рейтинге держится на весах и
// пороге методики; свернутые организации «Моих репозиториев» переживают перезагрузку.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE_NULL_BELOW, INDEX_WEIGHTS, SCORE_WEIGHTS, type IndexCategoryKey } from "../src/score/model";

describe("порог оценки в рейтинге", () => {
  test("«хотя бы по 2 категориям из 4» – следствие весов и порога, а не совпадение", () => {
    const keys = Object.keys(INDEX_WEIGHTS) as IndexCategoryKey[];
    const total = keys.reduce((sum, k) => sum + SCORE_WEIGHTS[k], 0);
    const coverage = (ks: IndexCategoryKey[]) => ks.reduce((sum, k) => sum + SCORE_WEIGHTS[k], 0) / total;
    expect(keys.length).toBe(4);
    // одной категории не хватает никогда
    for (const k of keys) expect(coverage([k])).toBeLessThan(COVERAGE_NULL_BELOW);
    // любых двух хватает всегда
    for (const a of keys) for (const b of keys) if (a < b) expect(coverage([a, b])).toBeGreaterThanOrEqual(COVERAGE_NULL_BELOW);
    const src = readFileSync(join(import.meta.dir, "../src/web/Rating.tsx"), "utf8");
    expect(src).toContain("хотя бы по 2 категориям из 4");
  });
});

describe("свернутые организации «Моих репозиториев»", () => {
  test("пишутся и читаются; битое значение и недоступное хранилище – все развернуты", async () => {
    const store = new Map<string, string>();
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    g.window = {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
    try {
      const { readCollapsedOrgs, writeCollapsedOrgs } = await import("../src/web/prefs");
      expect(readCollapsedOrgs()).toEqual([]);
      writeCollapsedOrgs(["lct", "me"]);
      expect(readCollapsedOrgs()).toEqual(["lct", "me"]);
      store.set("rh:my-repos-collapsed-orgs", "{not json");
      expect(readCollapsedOrgs()).toEqual([]);
      store.set("rh:my-repos-collapsed-orgs", JSON.stringify(["ok", 1]));
      expect(readCollapsedOrgs()).toEqual([]);
      g.window = {};
      expect(readCollapsedOrgs()).toEqual([]);
      expect(() => writeCollapsedOrgs(["x"])).not.toThrow();
    } finally {
      g.window = prev;
    }
  });
});
