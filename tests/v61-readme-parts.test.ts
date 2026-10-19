// Части README в раскрытии «Документации» (19.10.2026, ревью): наличие файла — по
// баллу показателя, как в расчете, а не по факту README; части всегда сходятся с баллом.
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard } from "../src/api/repos";
import { README_SPLIT } from "../src/score/model";
import { categoryBreakdown } from "../src/web/categoryBreakdown";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const dbs: ApiTestDb[] = [];
afterAll(() => {
  for (const t of dbs) {
    try {
      t.close();
    } catch {}
  }
});

function readmeRow(readme: { score: number; value: unknown }) {
  const t = makeApiDb();
  dbs.push(t);
  const id = seedRepo(t, { org: "rp", repo: "r" });
  const documentation = { score: 50, submetrics: { readme, license: { score: 1, value: true }, contributing: { score: 0, value: false }, codeowners: { score: 0, value: false } } };
  seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 70, categories: { documentation } });
  const card = getRepoCard(t.db, "rp", "r", {})!;
  return categoryBreakdown(card, "documentation")!.rows.find((r) => r.sub === "readme")!;
}

const sum = (row: ReturnType<typeof readmeRow>) => row.parts!.reduce((a, p) => a + p.earned, 0);

describe("части README: наличие по баллу", () => {
  test("файл засчитан, а факт README не собран — «Файл – есть», объем и шаги — прочерком", () => {
    const row = readmeRow({ score: README_SPLIT.presence, value: null });
    const [file, size, steps] = row.parts!;
    expect(file!.value).toBe("есть");
    expect(file!.earned).toBeCloseTo(file!.weight, 6);
    expect(size!.value).toBe("–");
    expect(steps!.value).toBe("–");
    expect(sum(row)).toBeCloseTo(row.earned!, 6);
  });

  test("файла нет по баллу, хотя факт README с объемом есть — части не больше набранного", () => {
    const row = readmeRow({ score: 0, value: { bytes: 4096, flags: { install: true, build: true, test: true } } });
    expect(row.parts![0]!.value).toBe("нет");
    expect(sum(row)).toBeCloseTo(0, 6);
  });

  test("обычный README — части сходятся с баллом показателя", () => {
    const row = readmeRow({ score: 0.8, value: { bytes: 13_400, flags: { install: true, build: true, test: false } } });
    expect(row.parts![0]!.value).toBe("есть");
    expect(row.parts![2]!.value).toBe("описаны: установка, сборка");
    expect(sum(row)).toBeCloseTo(row.earned!, 6);
  });
});
