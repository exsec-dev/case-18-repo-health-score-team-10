// web.test.ts — фронтенд собирается бандлером Bun из того же HTML-входа,
// что отдаёт server.ts: TSX, Gravity UI и его CSS резолвятся (сети нет).
// Плюс разбор маршрутов мини-роутера — чистая функция, DOM не нужен.
import { describe, expect, test } from "bun:test";
import { parseRoute, repoHref } from "../src/web/router";

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

describe("router: разбор маршрутов", () => {
  test("корень — рейтинг, query сохраняется целиком (ссылка на фильтр)", () => {
    expect(parseRoute("/", "")).toEqual({ kind: "rating", search: "" });
    expect(parseRoute("/", "sort=likes&lang=Go")).toEqual({ kind: "rating", search: "sort=likes&lang=Go" });
  });

  test("/repo/{org}/{repo} — карточка, percent-encoding разбирается", () => {
    expect(parseRoute("/repo/divkit/divkit")).toEqual({ kind: "repo", org: "divkit", repo: "divkit" });
    expect(parseRoute(repoHref("k-5-45mm", "dozzle-plus"))).toEqual({ kind: "repo", org: "k-5-45mm", repo: "dozzle-plus" });
    expect(parseRoute("/repo/a%2Fb/c")).toEqual({ kind: "repo", org: "a/b", repo: "c" });
    // битый encoding не роняет приложение
    expect(parseRoute("/repo/%E0%A4%A/x")).toEqual({ kind: "repo", org: "%E0%A4%A", repo: "x" });
  });

  test("прочее — not-found; /me/repo/... удалён без перенаправления (В4.1, К2)", () => {
    expect(parseRoute("/me")).toEqual({ kind: "me" });
    expect(parseRoute("/me/repo/x/y")).toEqual({ kind: "not-found", path: "/me/repo/x/y" });
    expect(parseRoute("/repo/only-org")).toMatchObject({ kind: "not-found" });
    expect(parseRoute("/unknown/page")).toMatchObject({ kind: "not-found" });
  });
});
