// summary-tools.test.ts — калькулятор специалистов (23.09, Алексей):
// арифметика долей — инструментом, а не в уме; security получает ТОЛЬКО
// calculate (файловые инструменты ей запрещены законом 5).
import { describe, expect, test } from "bun:test";
import { evaluateArithmetic, makeCalculatorExecutor } from "../src/summary/tools";

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
