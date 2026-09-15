// web.test.ts — фронтенд собирается бандлером Bun из того же HTML-входа,
// что отдаёт server.ts: TSX, Gravity UI и его CSS резолвятся (сети нет).
import { describe, expect, test } from "bun:test";

describe("web", () => {
  test("bundle: index.html → js + css без ошибок", async () => {
    const result = await Bun.build({ entrypoints: ["src/web/index.html"], minify: false });
    expect(result.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(result.success).toBe(true);
    const kinds = result.outputs.map((o) => o.path.split(".").pop());
    expect(kinds).toContain("html");
    expect(kinds).toContain("js");
    expect(kinds).toContain("css");
  }, 60_000);
});
