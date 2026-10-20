// Калькулятор специалистов: арифметика долей — инструментом, а не в уме;
// security получает ТОЛЬКО calculate (файловые инструменты ей запрещены:
// безопасность — только данные AppSec, своего сканирования нет).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateArithmetic, GREP_MATCH_CHARS, GREP_PATTERN_MAX, makeCalculatorExecutor, makeToolExecutor } from "../src/summary/tools";

describe("evaluateArithmetic: безопасная арифметика", () => {
  test("четыре действия, скобки, унарный минус, запятая-разделитель", () => {
    expect(evaluateArithmetic("0.866*100")).toBe(86.6);
    expect(evaluateArithmetic("2+2*2")).toBe(6);
    expect(evaluateArithmetic("(1-0.2)/4")).toBe(0.2);
    expect(evaluateArithmetic("-3+5")).toBe(2);
    expect(evaluateArithmetic("0,866*100")).toBe(86.6);
    expect(evaluateArithmetic("10/4")).toBe(2.5);
  });

  test("не арифметика — null: буквы, инъекции, деление на ноль, пустота", () => {
    expect(evaluateArithmetic("")).toBeNull();
    expect(evaluateArithmetic("process.exit(1)")).toBeNull();
    expect(evaluateArithmetic("1/0")).toBeNull();
    expect(evaluateArithmetic("drop table users")).toBeNull();
    expect(evaluateArithmetic("(0.5+")).toBeNull();
  });
});

describe("makeCalculatorExecutor: только calculate, без доступа к репо", () => {
  const ex = makeCalculatorExecutor();

  test("процент из доли считается инструментом", async () => {
    const res = JSON.parse(await ex.execute("calculate", { expression: "0.866*100" })) as { ok: boolean; result: number };
    expect(res.ok).toBe(true);
    expect(res.result).toBe(86.6);
  });

  test("файловые инструменты отказом; не-арифметика — ошибкой; бюджет тикает", async () => {
    const denied = JSON.parse(await ex.execute("grep", { pattern: "x" })) as { ok: boolean };
    expect(denied.ok).toBe(false);
    const bad = JSON.parse(await ex.execute("calculate", { expression: "читай README" })) as { ok: boolean };
    expect(bad.ok).toBe(false);
    expect(ex.specs.map((s) => s.function.name)).toEqual(["calculate"]);
    expect(ex.budgetLeft()).toBeLessThan(6);
  });
});

// Паттерн grep задает модель: длина паттерна и проверяемой строки ограничены (ReDoS)
describe("grep: границы паттерна", () => {
  test("паттерн длиннее предела отклоняется до компиляции; длинная строка проверяется только по началу", async () => {
    const root = mkdtempSync(join(tmpdir(), "rh-grep-bounds-"));
    try {
      writeFileSync(join(root, "a.txt"), `${"a".repeat(GREP_MATCH_CHARS)}NEEDLE\nNEEDLE early\n`);
      const ex = makeToolExecutor({ root, gitDir: null }, 6);
      const long = JSON.parse(await ex.execute("grep", { pattern: "a".repeat(GREP_PATTERN_MAX + 1) })) as { ok: boolean; error?: string };
      expect(long.ok).toBe(false);
      const hits = JSON.parse(await ex.execute("grep", { pattern: "NEEDLE" })) as { matches: number; lines: string[] };
      expect(hits.matches).toBe(1);
      expect(hits.lines[0]).toContain("a.txt:2:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
