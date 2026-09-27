// Энумерация каталога на живой фикстуре (page-1.json — сохраненный ответ
// GET /repos) и фейковый клиент для пагинации и ошибок. Сети нет.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enumerateCatalog } from "../src/collectors/catalog";
import { ScClient, ScResponse } from "../src/collectors/http";

const page1 = JSON.parse(readFileSync("tests/fixtures/catalog/page-1.json", "utf8")) as {
  repositories: Record<string, unknown>[];
  next_page_token: string;
};

/** Фейковый клиент: последовательность заготовленных ответов. */
function fakeClient(responses: ScResponse[], opts: { paths?: string[] } = {}): ScClient {
  let i = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      opts.paths?.push(path);
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
    requestCount: () => i,
  };
}

const ok = (json: unknown): ScResponse => ({ status: 200, json, bodyText: JSON.stringify(json) });

describe("catalog: parse (живая фиксстура стр.1)", () => {
  test("первая запись divkit распарсена: org/slug/language/likes/clone_url", async () => {
    const client = fakeClient([ok({ repositories: [page1.repositories[0]], next_page_token: undefined })]);
    const res = await enumerateCatalog(client);
    expect(res.ok && res.entries.length === 1 && res.pages === 1 && !res.truncated).toBe(true);
    if (!res.ok) return;
    const e = res.entries[0]!;
    expect(e.org).toBe("divkit");
    expect(e.repo).toBe("divkit");
    expect(e.language).toBe("Kotlin"); // language — объект {name,color}, беру name
    expect(e.likes).toBe(4062); // rating.value 4061.5 → round
    expect(e.clone_url_https).toBe("https://git@git.sourcecraft.dev/divkit/divkit.git");
    expect(e.visibility).toBe("public");
  });

  test("все 20 записей страницы → entries, клиентский фильтр public работает", async () => {
    const withPrivate = [
      ...page1.repositories,
      { ...page1.repositories[0]!, organization: { slug: "x" }, slug: "hidden", visibility: "private" },
    ];
    const client = fakeClient([ok({ repositories: withPrivate })]);
    const res = await enumerateCatalog(client);
    expect(res.entries.length).toBe(20);
    expect(res.entries.some((e) => e.repo === "hidden")).toBe(false);
  });
});

describe("catalog: обход и ошибки", () => {
  test("курсор: 3 страницы → stop на пустом next_page_token", async () => {
    const mk = (n: number, next?: string) =>
      ok({
        repositories: [{ organization: { slug: "o" }, slug: `r${n}`, visibility: "public" }],
        next_page_token: next,
      });
    const client = fakeClient([mk(1, "t2"), mk(2, "t3"), mk(3)]);
    const res = await enumerateCatalog(client);
    expect(res.ok).toBe(true);
    expect(res.pages).toBe(3);
    expect(res.entries.map((e) => e.repo)).toEqual(["r1", "r2", "r3"]);
    expect(res.truncated).toBe(false);
  });

  test("потолок maxPages=2 → truncated=true", async () => {
    const mk = (n: number) => ok({ repositories: [{ organization: { slug: "o" }, slug: `r${n}`, visibility: "public" }], next_page_token: `t${n}` });
    const client = fakeClient([mk(1), mk(2), mk(3)]);
    const res = await enumerateCatalog(client, { maxPages: 2 });
    expect(res.ok).toBe(true);
    expect(res.pages).toBe(2);
    expect(res.truncated).toBe(true);
  });

  test("401 на первой странице → ok=false с ошибкой канала", async () => {
    const client = fakeClient([{ status: 401, json: null, bodyText: "unauthenticated" }]);
    const res = await enumerateCatalog(client);
    expect(res.ok).toBe(false);
    expect(res.error?.status).toBe(401);
    expect(res.entries.length).toBe(0);
  });

  test("сбой сети (status 0) → ok=false, деталь ошибки", async () => {
    const client = fakeClient([{ status: 0, json: null, bodyText: "", error: "connect ECONNREFUSED" }]);
    const res = await enumerateCatalog(client);
    expect(res.ok).toBe(false);
    expect(res.error?.detail).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Charset-гард слагов каталога — невалидная запись
// пропускается и считается (счётчик едет в health/лог через nightlyCatalog).
// ---------------------------------------------------------------------------

describe("В4.4: гард слагов каталога", () => {
  test("слаг с путёвыми/управляющими символами пропускается; счётчик растёт; валидные записи проходят", async () => {
    const page = ok({
      repositories: [
        { organization: { slug: "good" }, slug: "repo", visibility: "public" },
        { organization: { slug: "evil/../other-host" }, slug: "repo", visibility: "public" },
        { organization: { slug: "dots" }, slug: ".", visibility: "public" },
        { organization: { slug: "ok" }, slug: "repo two", visibility: "public" },
        { organization: { slug: "space​" }, slug: "repo", visibility: "public" },
      ],
    });
    const res = await enumerateCatalog(fakeClient([page]));
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => `${e.org}/${e.repo}`)).toEqual(["good/repo"]);
    expect(res.skippedBadEntries).toBe(4);
    // пустой каталог без мусора — счётчик ноль
    const clean = await enumerateCatalog(fakeClient([ok({ repositories: [] })]));
    expect(clean.skippedBadEntries).toBe(0);
  });
});
