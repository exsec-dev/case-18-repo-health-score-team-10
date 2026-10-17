// Значок места в API и SVG (лиги золото / серебро / бронза, равные – strict).
// Источник места один: значок карточки = значок строки рейтинга =
// rankBadge(ratingPlace) — от индекса в выборке, поэтому у равных индексов
// значок одинаков независимо от их порядка по org/repo;
// фильтры место не меняют — значок тоже; приватный и без места — null; SVG —
// со значком и без (без значка — прежний бейдж байт в байт, не пустой).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { RANK_BADGE_COLORS, getPublicRepo, parseBadgeStyle, publicRankBadge, renderBadgeSvg } from "../src/api/public";
import { DEFAULT_QUERY, getRepoCard, listRepos, ratingPlace, type RatingItem } from "../src/api/repos";
import { rankBadge, type RankLeague } from "../src/api/rank-badge";
import type { AccessResult } from "../src/auth/access";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const GRANTED: AccessResult = { repo: "granted", cicd: "granted", appsec: "granted" };

const dirs: string[] = [];
const servers: SpawnedServer[] = [];
const mocks: { stop(): void }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function add(t: ApiTestDb, repo: string, total: number | null, opts: { language?: string; loc?: number; visibility?: string } = {}): number {
  const id = seedRepo(t, { org: "top", repo, language: opts.language ?? "Go" });
  const facts = [{ key: "tree.stats", source: "git", value: { top_level: [], file_count: 3, bytes: 100, source_loc: opts.loc ?? 5000 } }];
  seedScore(t, id, seedScan(t, id, { facts }), { total });
  if (opts.visibility) t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(opts.visibility, id);
  return id;
}

/**
 * 25 публичных оцененных: места 1-25 (индексы 99, 98, …), на границе TOP-10
 * пара РАВНЫХ индексов «tie-a»/«tie-b» (места 10 и 11 — по org/repo); плюс
 * приватный с высшим индексом (в рейтинг не входит, мест не сдвигает) и
 * репо без индекса. По лигам по умолчанию при 25 репо: №1-9 — золото
 * «TOP-10»; равные на местах 10-11 при strict — оба без значка (не ниже их
 * 11 > 10), при inclusive — оба золото (выше их 9 < 10); серебра и бронзы
 * нет (в рейтинге не больше 100 и 1 000 репо), дальше — null.
 */
function seedTop(t: ApiTestDb): void {
  for (let i = 1; i <= 9; i++) add(t, `r${String(i).padStart(2, "0")}`, 100 - i, { language: i % 2 === 0 ? "Go" : "Rust", loc: i % 3 === 0 ? 500 : 5000 });
  add(t, "tie-b", 90);
  add(t, "tie-a", 90);
  for (let i = 12; i <= 25; i++) add(t, `r${i}`, 100 - i);
  add(t, "secret", 100, { visibility: "private" });
  add(t, "unscored", null);
}

const rowsOf = (t: ApiTestDb, q: Partial<typeof DEFAULT_QUERY> = {}): RatingItem[] => {
  const res = listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100, ...q });
  return [...res.items, ...res.nullItems];
};

describe("значок места: один источник у карточки и строки рейтинга", () => {
  test("карточка = строка = rankBadge(ratingPlace) у каждого репо, включая равные индексы", () => {
    const t = makeApiDb();
    try {
      seedTop(t);
      const rows = rowsOf(t);
      expect(rows.length).toBe(26); // 25 оцененных + без индекса; приватного нет
      for (const row of rows) {
        const score = getRepoCard(t.db, "top", row.repo)!.score!;
        expect(score.rank).toBe(row.rank);
        expect(score.rankBadge).toEqual(row.rankBadge);
        const place = score.healthcraftIndex === null ? null : ratingPlace(t.db, "top", row.repo, score.healthcraftIndex);
        expect(score.rankBadge).toEqual(rankBadge(place));
        if (place !== null) expect([place.rank, place.rankedTotal] as (number | null)[]).toEqual([score.rank, score.rankedTotal]);
      }
      const by = new Map(rows.map((r) => [r.repo, r]));
      for (const repo of ["r01", "r02", "r09"]) expect(by.get(repo)!.rankBadge).toEqual({ tier: "gold", label: "TOP-10" });
      // равные индексы: место по org/repo (tie-a 10-е, tie-b 11-е), а значок — один на обоих:
      // strict (по умолчанию) — оба без значка, хотя tie-a стоит 10-м
      expect([by.get("tie-a")!.rank, by.get("tie-b")!.rank]).toEqual([10, 11]);
      expect(by.get("tie-a")!.rankBadge).toBeNull();
      expect(by.get("tie-b")!.rankBadge).toBeNull();
      expect(by.get("r25")!.rankBadge).toBeNull();
      expect(by.get("unscored")!.rankBadge).toBeNull();
    } finally {
      t.close();
    }
  });

  test("серебро на 120 репо: карточка = строка на границах 10/11 и 100/101 (равные на 100-101 — оба без значка)", () => {
    const t = makeApiDb();
    try {
      // индексы 200-i: места 1-120 без равных, кроме пары «w-tie-b»/«w-tie-a» на местах 100-101
      for (let i = 1; i <= 120; i++) {
        if (i === 100 || i === 101) continue;
        add(t, `w${String(i).padStart(3, "0")}`, 200 - i);
      }
      add(t, "w-tie-b", 100);
      add(t, "w-tie-a", 100);
      const by = new Map([...rowsOf(t), ...rowsOf(t, { page: 2 })].map((r) => [r.repo, r]));
      expect(by.size).toBe(120);
      const expected: Record<string, RankLeague | null> = {
        w001: "gold", w010: "gold", w011: "silver", w099: "silver", "w-tie-a": null, "w-tie-b": null, w102: null, w120: null,
      };
      for (const [repo, tier] of Object.entries(expected)) {
        const row = by.get(repo)!;
        const score = getRepoCard(t.db, "top", repo)!.score!;
        expect(row.rankBadge?.tier ?? null).toBe(tier);
        expect(score.rankBadge).toEqual(row.rankBadge);
        expect(score.rank).toBe(row.rank);
      }
      expect([by.get("w-tie-a")!.rank, by.get("w-tie-b")!.rank]).toEqual([100, 101]);
      // inclusive отдал бы серебро обоим равным
      expect(rankBadge(ratingPlace(t.db, "top", "w-tie-b", 100), { ties: "inclusive" })?.tier).toBe("silver");
    } finally {
      t.close();
    }
  });

  test("положение равных на временной БД: inclusive — оба золото, strict — оба без значка", () => {
    const t = makeApiDb();
    try {
      seedTop(t);
      const a = ratingPlace(t.db, "top", "tie-a", 90)!;
      const b = ratingPlace(t.db, "top", "tie-b", 90)!;
      expect(a).toEqual({ rank: 10, rankedTotal: 25, above: 9, atOrAbove: 11 });
      expect(b).toEqual({ rank: 11, rankedTotal: 25, above: 9, atOrAbove: 11 });
      for (const place of [a, b]) {
        expect(rankBadge(place, { ties: "inclusive" })).toEqual({ tier: "gold", label: "TOP-10" });
        expect(rankBadge(place, { ties: "strict" })).toBeNull();
      }
    } finally {
      t.close();
    }
  });

  test("фильтры, поиск и сортировка место не меняют — значок тоже", () => {
    const t = makeApiDb();
    try {
      seedTop(t);
      const base = new Map(rowsOf(t).map((r) => [r.repo, r.rankBadge]));
      const variants = [
        rowsOf(t, { lang: ["Rust"] }),
        rowsOf(t, { size: ["small"] }),
        rowsOf(t, { q: "tie" }),
        rowsOf(t, { sort: "name", order: "asc" }),
        rowsOf(t, { perPage: 3, page: 2 }),
      ];
      for (const rows of variants) {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.rankBadge).toEqual(base.get(row.repo)!);
      }
      // фильтр оставил №9 – у него по-прежнему значок всего рейтинга, а не «первого из Rust»; tie-a – по-прежнему без значка,
      // хотя в выдаче «tie» он первый
      expect(rowsOf(t, { lang: ["Rust"] }).find((r) => r.repo === "r09")!.rankBadge!.tier).toBe("gold");
      expect(rowsOf(t, { q: "tie" }).map((r) => r.rankBadge)).toEqual([null, null]);
    } finally {
      t.close();
    }
  });

  test("приватный и internal без места — значка нет, даже с высшим индексом", () => {
    const t = makeApiDb();
    try {
      seedTop(t);
      add(t, "inner", 100, { visibility: "internal" });
      for (const repo of ["secret", "inner"]) {
        const score = getRepoCard(t.db, "top", repo, { access: GRANTED })!.score!;
        expect(score.healthcraftIndex).toBe(100);
        expect(score.rank).toBeNull();
        expect(score.rankBadge).toBeNull();
      }
    } finally {
      t.close();
    }
  });
});

describe("SVG: вариант со значком места", () => {
  test("без значка — прежний бейдж байт в байт; со значком — третий сегмент с подписью", () => {
    expect(renderBadgeSvg(74, null)).toBe(renderBadgeSvg(74));
    const plain = renderBadgeSvg(74);
    const ranked = renderBadgeSvg(74, { tier: "gold", label: "TOP-10" });
    expect(ranked).toContain(">TOP-10<");
    expect(ranked).toContain(`fill="${RANK_BADGE_COLORS.gold.bg}"`);
    expect(renderBadgeSvg(74, { tier: "silver", label: "TOP-100" })).toContain(`fill="${RANK_BADGE_COLORS.silver.bg}"`);
    expect(renderBadgeSvg(74, { tier: "bronze", label: "TOP-1000" })).toContain(`fill="${RANK_BADGE_COLORS.bronze.bg}"`);
    expect(ranked).toContain('aria-label="HealthCraft Index: 74, TOP-10 рейтинга"');
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)![1]);
    expect(width(ranked)).toBeGreaterThan(width(plain));
    expect(/https?:\/\/(?!www\.w3\.org)/.test(ranked)).toBe(false);
    expect(/[—ё]/.test(ranked)).toBe(false);
  });

  test("«металл» лиги: контраст текста и фона по WCAG не ниже 4,5:1", () => {
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(Object.keys(RANK_BADGE_COLORS).sort()).toEqual(["bronze", "gold", "silver"]);
    for (const { bg, fg } of Object.values(RANK_BADGE_COLORS)) expect(ratio(bg, fg)).toBeGreaterThanOrEqual(4.5);
    // белый текст на этих фонах не проходит — поэтому текст темный
    for (const { bg } of Object.values(RANK_BADGE_COLORS)) expect(ratio(bg, "#ffffff")).toBeLessThan(4.5);
  });

  test("параметр style: нет — обычный, rank — со значком, иное — ошибка", () => {
    expect(parseBadgeStyle(new URLSearchParams(""))).toBe("plain");
    expect(parseBadgeStyle(new URLSearchParams("style=rank"))).toBe("rank");
    expect(parseBadgeStyle(new URLSearchParams("style=flat"))).toBeNull();
    expect(parseBadgeStyle(new URLSearchParams("style=rank&style=rank"))).toBeNull();
  });

  test("значок бейджа = значок карточки (тот же подсчет места)", () => {
    const t = makeApiDb();
    try {
      seedTop(t);
      for (const repo of ["r01", "r05", "r09", "tie-a", "tie-b", "r20", "unscored"]) {
        const proj = getPublicRepo(t.db, "top", repo)!;
        expect(publicRankBadge(t.db, proj)).toEqual(getRepoCard(t.db, "top", repo)!.score!.rankBadge);
      }
    } finally {
      t.close();
    }
  });

  test("маршрут badge.svg?style=rank: значок у места, обычный без значка, 400 на чужой стиль, 404 приватному", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v59b-badge-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    seedTop({ db, close: () => {} });
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock });
    servers.push(server);
    const get = (path: string) => fetch(`${server.base}/api/v1/repos/top/${path}`);

    const top = await get("r02/badge.svg?style=rank");
    expect(top.status).toBe(200);
    expect(top.headers.get("content-type")).toContain("image/svg+xml");
    expect(top.headers.get("cache-control")).toContain("max-age=");
    const topSvg = await top.text();
    expect(topSvg).toContain(">TOP-10<");
    expect(topSvg).toContain(RANK_BADGE_COLORS.gold.bg);

    // без значка — обычный бейдж, тот же, что без параметра (не пустой)
    const noBadge = await (await get("r20/badge.svg?style=rank")).text();
    expect(noBadge).toBe(await (await get("r20/badge.svg")).text());
    expect(noBadge).toContain(">80<");

    expect((await get("r02/badge.svg?style=flat")).status).toBe(400);

    // приватный: тот же неотличимый 404, что у обычного бейджа и несуществующего
    const priv = await get("secret/badge.svg?style=rank");
    const missing = await get("nope/badge.svg?style=rank");
    expect(priv.status).toBe(404);
    expect(await priv.text()).toBe(await missing.text());
  }, 120_000);
});
