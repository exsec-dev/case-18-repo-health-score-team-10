// Наши стили – после CSS компонентов в обоих режимах Bun (cssOrder.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CSS_ORDER_MARKER, stylesToMove } from "../src/web/cssOrder";

test("копия нужна только нашим ссылкам, стоящие перед чужими; порядок наших сохраняется", () => {
  // dev: наши первыми
  expect(stylesToMove([true, true, false, false])).toEqual([0, 1]);
  // production: наши уже последними — ничего
  expect(stylesToMove([false, false, true, true])).toEqual([]);
  // вперемешку
  expect(stylesToMove([false, true, false, true])).toEqual([1]);
  expect(stylesToMove([])).toEqual([]);
  expect(stylesToMove([true, true])).toEqual([]);
});

test("маркер есть в обоих наших файлах", () => {
  for (const f of ["theme.css", "layout.css"]) {
    expect(readFileSync(join(import.meta.dir, "../src/web", f), "utf8")).toContain(`${CSS_ORDER_MARKER} {`);
  }
});
