// Демо и путь сервиса: BASE_PATH, таблица маршрутов под путем, сборка интерфейса с метками.
import { describe, expect, test } from "bun:test";
import { basePathFromEnv } from "../src/config";
import { buildFrontend, underBasePath } from "../src/frontend-build";

describe("BASE_PATH", () => {
  test("пусто – корень; путь нормализуется без завершающего «/»", () => {
    expect(basePathFromEnv({})).toBe("");
    expect(basePathFromEnv({ BASE_PATH: "" })).toBe("");
    expect(basePathFromEnv({ BASE_PATH: "/healthcraft/" })).toBe("/healthcraft");
    expect(basePathFromEnv({ BASE_PATH: "/a/b" })).toBe("/a/b");
  });

  test("не путь – ошибка на старте, а не тихий корень", () => {
    expect(() => basePathFromEnv({ BASE_PATH: "healthcraft" })).toThrow();
    expect(() => basePathFromEnv({ BASE_PATH: "/health craft" })).toThrow();
  });
});

describe("маршруты под путем", () => {
  test("ключи получают префикс, сам путь ведет на путь со «/»", () => {
    const h = () => new Response("ok");
    const out = underBasePath({ "/api/meta": h, "/*": h }, "/healthcraft");
    expect(Object.keys(out).sort()).toEqual(["/healthcraft", "/healthcraft/*", "/healthcraft/api/meta"]);
    const res = (out["/healthcraft"] as () => Response)();
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/healthcraft/");
  });

  test("без пути таблица не меняется", () => {
    const table = { "/api/meta": () => new Response("ok") };
    expect(underBasePath(table, "")).toBe(table);
  });
});

describe("сборка интерфейса", () => {
  test("файлы – под путем, в <head> метки пути и демо", async () => {
    const built = await buildFrontend("/healthcraft", true);
    expect(built.html).toContain('<meta name="hc-base" content="/healthcraft">');
    expect(built.html).toContain('<meta name="hc-demo" content="1">');
    const refs = [...built.html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("/healthcraft/")).toBe(true);
      expect(built.assets.has(ref.slice("/healthcraft".length))).toBe(true);
    }
  }, 60_000);
});
