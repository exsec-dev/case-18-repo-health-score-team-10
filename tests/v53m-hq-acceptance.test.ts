// Поведенческие тесты на данных для правок модели по повторному аудиту
// методики.
import { describe, expect, test } from "bun:test";
import { computeFromFacts } from "../src/score/compute";
import { isSourcePath, isTestPath, rootHasNoSource } from "../src/collectors/source-path";
import { noDataReason } from "../src/web/format";
import { adjustmentText } from "../src/report/sections";
import { NOW, healthyFacts } from "./score-fixtures";

function facts(patch: Record<string, unknown | undefined>): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}
const score = (ok: Map<string, unknown>) => computeFromFacts(ok, { scanId: 0, repoId: 0 }, NOW);
const tree = (lines: number, extra: Record<string, unknown> = {}) => ({
  top_level: [{ name: "src", type: "tree" }],
  file_count: 5,
  bytes: 5000,
  loc: lines,
  source_files: 3,
  source_loc: lines,
  test_files: 0,
  source_unread: 0,
  ...extra,
});
const todo = (count: number, older: number) => ({ count, fixme: 0, older_180d: older, todo_files: count ? 1 : 0, blamed_files: count ? 1 : 0 });

describe("уточнение В3: сжатие малого кода — только вниз", () => {
  test("плохой малый код не подтягивается к 50; хороший — сжимается к 50", () => {
    const bad = score(facts({ "tree.stats": tree(40), "code.todo": todo(5, 5) }));
    const badRaw = score(facts({ "tree.stats": tree(400), "code.todo": todo(50, 50) }));
    expect(bad.categories.code.score!).toBeLessThan(50);
    expect(bad.categories.code.adjustment).toBeUndefined();
    const good = score(facts({ "tree.stats": tree(40), "code.todo": todo(0, 0) }));
    expect(good.categories.code.score!).toBeLessThan(100);
    expect(good.categories.code.score!).toBeGreaterThanOrEqual(50);
    expect(good.categories.code.adjustment?.kind).toBe("small-code");
    void badRaw;
  });

  test("удалить чистые строки из плохого малого кода невыгодно; дописать чистый код — не снижает", () => {
    const at = (lines: number) => score(facts({ "tree.stats": tree(lines), "code.todo": todo(5, 5) })).healthcraftIndex!;
    for (const [from, to] of [
      [100, 20],
      [60, 30],
      [150, 50],
    ] as const) {
      expect(at(to)).toBeLessThanOrEqual(at(from));
      expect(at(from)).toBeGreaterThanOrEqual(at(to));
    }
    for (let l = 10; l < 300; l += 10) expect(at(l + 10)).toBeGreaterThanOrEqual(at(l) - 1e-9);
  });
});

describe("H1: бинарный файл — не код", () => {
  test("архивы, офисные документы, медиа — не код; README + app.zip — «кода нет»", () => {
    for (const p of ["app.zip", "slides.pptx", "report.docx", "build/app.apk", "lib/x.jar", "font.woff2"]) expect(isSourcePath(p)).toBe(false);
    expect(rootHasNoSource([{ name: "README.md", type: "blob" }, { name: "app.zip", type: "blob" }])).toBe(true);
    const s = score(facts({ "tree.stats": { top_level: [{ name: "README.md", type: "blob" }, { name: "app.zip", type: "blob" }], file_count: 2, bytes: 90_000, loc: 10 } }));
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
  });
});

describe("E15: старые факты с loc = 0 — своя причина", () => {
  test("факт до М2.3 (без source_loc) с loc = 0 — «посчитаны прежней версией сборщика», не «файлы не прочитаны»", () => {
    const s = score(facts({ "tree.stats": { top_level: [{ name: "main.py", type: "blob" }, { name: "README.md", type: "blob" }], file_count: 2, bytes: 40, loc: 0 } }));
    expect(s.categories.code.score).toBeNull();
    const text = noDataReason("code", s.categories.code.no_data);
    expect(text).toContain("прежней версией сборщика");
    expect(text).not.toContain("больше лимита");
  });

  test("новые факты: строки не прочитаны — прежний текст", () => {
    const s = score(facts({ "tree.stats": tree(0, { source_unread: 2 }) }));
    expect(noDataReason("code", s.categories.code.no_data)).toContain("прочитать не удалось");
  });
});

describe("E11: ни одной засчитанной закрытой задачи", () => {
  test("текст — «ни одна задача не закрыта», не «0 закрытых задач из 10»", () => {
    const t = adjustmentText({ score: 6, adjustment: { kind: "small-sample", n: 0, full: 10, raw: 6.7, floor: 6 } } as never)!;
    expect(t).toContain("Ни одна задача не закрыта");
    expect(t).not.toContain("0 закрытых");
  });
});

describe("E17: каталоги данных — не тесты только внутри каталога тестов", () => {
  test("данные внутри tests/ — не тесты; data/ вне тестов не мешает", () => {
    expect(isTestPath("tests/fixtures/big.py")).toBe(false);
    expect(isTestPath("tests/data/x.py")).toBe(false);
    expect(isTestPath("src/data/test_loader.py")).toBe(true);
    expect(isTestPath("app/mocks/api.test.ts")).toBe(true);
    expect(isTestPath("data/tests/test_x.py")).toBe(true);
    expect(isTestPath("tests/test_x.py")).toBe(true);
  });
});
