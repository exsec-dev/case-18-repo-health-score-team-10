// Окно бейджа с чипами: части бейджа (`show=`, `cats` – шкалы категорий под
// шапкой), бейдж одной категории (`category=`), бейдж закрытого репо по ключу
// (`key=`) и код для README.
//   - прежние адреса (`badge.svg`, `?style=rank`) отвечают как раньше;
//   - закрытый репо – только с верным ключом, неверный ключ = тот же 404;
//   - кнопка бейджа – только у своих репо (в списке «Мои репозитории»).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { badgeKey, badgeSubject, parseBadgeOptions, renderBadgeFor, renderBadgeSvg, renderCategoryBadgeSvg } from "../src/api/public";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { badgeCode } from "../src/web/slots";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type MockApi, type SpawnedServer } from "./server-harness";

const ROOT = join(import.meta.dir, "..");
const SECRET = "s".repeat(40);
const dirs: string[] = [];
const mocks: MockApi[] = [];
const servers: SpawnedServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Открытый с двумя оценками, закрытый с двумя, internal, выбывший открытый. */
function seed(t: ApiTestDb): void {
  const open = seedRepo(t, { org: "bb", repo: "open" });
  seedScore(t, open, seedScan(t, open), { total: 60 });
  seedScore(t, open, seedScan(t, open), { total: 72 });
  const priv = seedRepo(t, { org: "bb", repo: "priv" });
  seedScore(t, priv, seedScan(t, priv), { total: 50 });
  seedScore(t, priv, seedScan(t, priv), { total: 45 });
  const int = seedRepo(t, { org: "bb", repo: "int" });
  seedScore(t, int, seedScan(t, int), { total: 30 });
  const gone = seedRepo(t, { org: "bb", repo: "gone" });
  seedScore(t, gone, seedScan(t, gone), { total: 90 });
  t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
  t.db.query("UPDATE repos SET visibility = 'internal' WHERE id = ?").run(int);
  t.db.query("UPDATE repos SET rating_active = 0 WHERE id = ?").run(gone);
}

describe("параметры badge.svg", () => {
  const parse = (q: string) => {
    const o = parseBadgeOptions(new URLSearchParams(q));
    return o === null ? null : { parts: [...o.parts].sort(), category: o.category };
  };

  test("show, прежний style=rank и category", () => {
    expect(parse("")).toEqual({ parts: [], category: null });
    expect(parse("style=rank")).toEqual({ parts: ["rank"], category: null });
    expect(parse("show=delta,rank,word")).toEqual({ parts: ["delta", "rank", "word"], category: null });
    expect(parse("show=cats,word")).toEqual({ parts: ["cats", "word"], category: null });
    expect(parse("show=rank&style=rank")).toEqual({ parts: ["rank"], category: null });
    expect(parse("category=issues")).toEqual({ parts: [], category: "issues" });
    // посторонние параметры (key разбирает маршрут) не мешают
    expect(parse("show=word&key=abc")).toEqual({ parts: ["word"], category: null });
  });

  test("ошибки: чужое значение, повтор, пустая часть, категория с частями", () => {
    for (const q of ["show=cats,cats", "category=code&show=cats", "style=flat", "style=rank&style=rank", "show=rank,rank", "show=rank,", "show=", "show=place", "show=a&show=b", "category=cicd", "category=code&show=rank", "category=code&style=rank", "category=code&category=issues"]) {
      expect({ q, parsed: parse(q) }).toEqual({ q, parsed: null });
    }
  });
});

describe("SVG", () => {
  test("без частей – прежний бейдж байт в байт; зона – в сегменте числа, динамика – серым треугольником", () => {
    expect(renderBadgeSvg(74, null, {})).toBe(renderBadgeSvg(74));
    expect(renderBadgeSvg(74, null, { delta: null, word: false })).toBe(renderBadgeSvg(74));
    const svg = renderBadgeSvg(74, null, { delta: 3, word: true });
    // зона через пробел, без разделителя-точки
    expect(svg).toContain(">74 здоров<");
    expect(svg).not.toContain("·");
    // рост: треугольник вершиной вверх и сдвиг серым, как место в рейтинге
    expect(svg).toMatch(/<path d="M\d+ 13h7l-3\.5-6z" fill="#c2c2c2"\/>/);
    expect(svg).toMatch(/fill="#c2c2c2">3<\/text>/);
    expect(svg).toContain('aria-label="HealthCraft Index: 74 здоров, +3 с прошлого анализа"');
    const down = renderBadgeSvg(55, null, { delta: -2 });
    expect(down).toMatch(/<path d="M\d+ 7h7l-3\.5 6z"/);
    expect(down).toMatch(/fill="#c2c2c2">2<\/text>/);
    // без сдвига динамики нет, как в рейтинге
    expect(renderBadgeSvg(20, null, { delta: 0, word: true })).toBe(renderBadgeSvg(20, null, { word: true }));
    expect(renderBadgeSvg(20, null, { word: true })).toContain(">20 в зоне риска<");
    // без оценки частей нет: «n/a» серым, как раньше
    expect(renderBadgeSvg(null, null, { delta: 3, word: true })).toBe(renderBadgeSvg(null));
    const width = (s: string) => Number(/width="(\d+)"/.exec(s)![1]);
    expect(width(svg)).toBeGreaterThan(width(renderBadgeSvg(74)));
    expect(/[—ё]/.test(svg)).toBe(false);
  });

  test("с категориями – карточка: число вправо, под шапкой 4 шкалы зоны с баллами", () => {
    const cats = { documentation: 35.4, activity: 82, issues: null, code: 99.6 };
    const svg = renderBadgeSvg(79, null, { categories: cats });
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    expect(width).toBeGreaterThanOrEqual(232);
    expect(/height="(\d+)"/.exec(svg)![1]).toBe("92");
    // число – у правого края шапки
    const valueX = Number(/<rect x="(\d+)" width="(\d+)" height="20" fill="#2da44e"\/>/.exec(svg)![1]);
    const valueW = Number(/<rect x="\d+" width="(\d+)" height="20" fill="#2da44e"\/>/.exec(svg)![1]);
    expect(valueX + valueW).toBe(width);
    for (const t of [">Документация<", ">Активность<", ">Задачи<", ">Состояние кода<", ">35<", ">82<", ">n/a<", ">100<"]) expect(svg).toContain(t);
    expect(svg).toContain('aria-label="HealthCraft Index: 79, Документация 35, Активность 82, Задачи n/a, Состояние кода 100"');
    // шкала зоны: красная у 35, без заливки у «нет данных»
    expect(svg).toContain('fill="#cf222e"');
    expect(svg.match(/rx="2\.5"/g)).toHaveLength(4 + 3);
    // с местом – место тоже у правого края, после числа
    const ranked = renderBadgeSvg(79, { tier: "silver", label: "TOP-100" }, { categories: cats });
    expect(ranked).toContain(">TOP-100<");
    expect(/[—ё]/.test(ranked)).toBe(false);
  });

  test("бейдж категории: название, округленный балл, цвет зоны", () => {
    const svg = renderCategoryBadgeSvg("code", 79.72);
    expect(svg).toContain(">Состояние кода<");
    expect(svg).toContain(">80<");
    expect(svg).toContain('fill="#2da44e"');
    expect(renderCategoryBadgeSvg("issues", null)).toContain(">n/a<");
    expect(/https?:\/\/(?!www\.w3\.org)/.test(svg)).toBe(false);
  });
});

describe("бейдж закрытого репо по ключу", () => {
  test("открытый – без ключа; закрытый – только с верным ключом; выбывший – никогда", () => {
    const t = makeApiDb();
    try {
      seed(t);
      const get = (repo: string, key?: string | null, appSecret: string | null = SECRET) => badgeSubject(t.db, "bb", repo, { key, appSecret });
      expect(get("open")?.index).toBe(72);
      expect(get("priv")).toBeNull();
      expect(get("priv", "x".repeat(22))).toBeNull();
      expect(get("priv", badgeKey(SECRET, "bb", "int"))).toBeNull(); // ключ другого репо
      expect(get("priv", badgeKey(SECRET, "bb", "priv"), null)).toBeNull(); // без APP_SECRET ключей нет
      expect(get("priv", badgeKey(SECRET, "bb", "priv"))?.index).toBe(45);
      expect(get("int", badgeKey(SECRET, "bb", "int"))?.index).toBe(30);
      expect(get("gone", badgeKey(SECRET, "bb", "gone"))).toBeNull();
      expect(get("nope", badgeKey(SECRET, "bb", "nope"))).toBeNull();
    } finally {
      t.close();
    }
  });

  test("изменение – с прошлой оценкой того же ряда; у закрытого места нет", () => {
    const t = makeApiDb();
    try {
      seed(t);
      const open = badgeSubject(t.db, "bb", "open", { withRank: true })!;
      expect(open.previousIndex).toBe(60);
      expect(renderBadgeFor(open, { parts: new Set(["delta"]), category: null })).toContain(", +12 с прошлого анализа");
      const priv = badgeSubject(t.db, "bb", "priv", { key: badgeKey(SECRET, "bb", "priv"), appSecret: SECRET, withRank: true })!;
      expect(priv.rank).toBeNull();
      expect(renderBadgeFor(priv, { parts: new Set(["delta", "rank"]), category: null })).toContain(": 45, −5 с прошлого анализа");
      // первая оценка – сравнивать не с чем, части «изменение» нет
      const int = badgeSubject(t.db, "bb", "int", { key: badgeKey(SECRET, "bb", "int"), appSecret: SECRET })!;
      expect(renderBadgeFor(int, { parts: new Set(["delta"]), category: null })).toBe(renderBadgeSvg(30));
      expect(renderBadgeFor(priv, { parts: new Set(), category: "code" })).toContain(">Состояние кода<");
      expect(renderBadgeFor(priv, { parts: new Set(["cats"]), category: null })).toContain(">Состояние кода<");
    } finally {
      t.close();
    }
  });

  test("маршрут: прежние адреса как раньше, ключ открывает закрытый, иное – 404 и 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-badge-builder-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    seed({ db, close: () => {} });
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET });
    servers.push(server);
    const get = async (path: string) => {
      const res = await fetch(`${server.base}/api/v1/repos/bb/${path}`);
      return { status: res.status, body: await res.text() };
    };
    const plain = await get("open/badge.svg");
    expect(plain.body).toBe(renderBadgeSvg(72));
    expect((await get("open/badge.svg?style=rank")).status).toBe(200);
    expect((await get("open/badge.svg?show=word,delta")).body).toContain("HealthCraft Index: 72 здоров, +12 с прошлого анализа");
    expect((await get("open/badge.svg?category=documentation")).body).toContain(">Документация<");
    expect((await get("open/badge.svg?show=cats")).body).toContain(">Состояние кода<");

    const key = badgeKey(SECRET, "bb", "priv");
    const privRes = await fetch(`${server.base}/api/v1/repos/bb/priv/badge.svg?key=${key}&show=delta`);
    expect(privRes.headers.get("cache-control")).toBe("private, max-age=300");
    const priv = { status: privRes.status, body: await privRes.text() };
    expect(priv.status).toBe(200);
    expect((await fetch(`${server.base}/api/v1/repos/bb/open/badge.svg`)).headers.get("cache-control")).toBe("public, max-age=300");
    expect(priv.body).toContain("HealthCraft Index: 45, −5 с прошлого анализа");
    expect((await get(`priv/badge.svg?key=${key}&category=issues`)).status).toBe(200);
    // без ключа, с чужим ключом, выбывший и несуществующий – одинаковый 404
    const missing = await get("nope/badge.svg");
    expect(missing.status).toBe(404);
    for (const path of ["priv/badge.svg", `priv/badge.svg?key=${badgeKey(SECRET, "bb", "int")}`, `gone/badge.svg?key=${badgeKey(SECRET, "bb", "gone")}`]) {
      expect(await get(path)).toEqual(missing);
    }
    // ключ открывает только бейдж, не JSON
    expect((await get(`priv?key=${key}`)).status).toBe(404);
    expect((await get(`priv/badge.svg?key=${key}&key=${key}`)).status).toBe(400);
    expect((await get("open/badge.svg?show=place")).status).toBe(400);
  }, 120_000);
});

describe("код для README", () => {
  const base = { publicBaseUrl: "https://hc.example.ru/", org: "org", repo: "my.repo" };

  test("без частей – прежний код; части и категории – в адресе одного бейджа", () => {
    expect(badgeCode({ ...base, chips: new Set() }, "md")).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg)](https://hc.example.ru/repo/org/my.repo)");
    expect(badgeCode({ ...base, chips: new Set(["delta", "rank"]) }, "url")).toBe("https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg?show=rank,delta");
    expect(badgeCode({ ...base, chips: new Set(["cats", "word"]) }, "url")).toBe("https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg?show=word,cats");
    expect(badgeCode({ ...base, chips: new Set() }, "html")).toBe('<a href="https://hc.example.ru/repo/org/my.repo"><img src="https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg" alt="HealthCraft Index"></a>');
    expect(badgeCode({ ...base, chips: new Set(["word"]) }, "json")).toBe("https://hc.example.ru/api/v1/repos/org/my.repo");
  });

  test("ключ закрытого репо – в адресе картинки", () => {
    expect(badgeCode({ ...base, chips: new Set(["word", "cats"]), key: "k-1_x" }, "url")).toBe("https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg?show=word,cats&key=k-1_x");
  });

  test("кнопка – только у своего репо: из списка по токену и с бейджем или ключом", () => {
    const page = readFileSync(join(ROOT, "src", "web", "RepoPage.tsx"), "utf8");
    expect(page).toContain("badge={(ownRepo || listed !== null) && (card.repo.badge || card.repo.badgeKey !== undefined)}");
    const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
    // ключ кладет только маршрут карточки и только закрытому репо
    expect(server.match(/badgeKey\(config\.auth\.appSecret/g)).toHaveLength(1);
  });
});
