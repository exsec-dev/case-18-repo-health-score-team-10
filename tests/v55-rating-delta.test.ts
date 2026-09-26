// v55-rating-delta.test.ts — В5.5 тур 1 (W2): поведенческие тесты динамики
// позиции (Р1), плашки фрода (Р2) и внешней ссылки (Р3) в строке рейтинга.
// Числа (место, delta, ранг снимка) — на данных временной БД, не source-assert
// (правила 21.09/23.09). Сиды — tests/api-fixtures.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { listRepos, DEFAULT_QUERY, getRepoCard } from "../src/api/repos";
import { maybeTakeDailySnapshot, purgeOldRatingSnapshots, takeRatingSnapshot, utcDayOf } from "../src/jobs/rating-snapshot";
import { maintenanceTick, workerTick } from "../src/jobs/scheduler";
import { setMetaValue } from "../src/db";
import { SCHED_META } from "../src/api/health";
import { loadConfig } from "../src/config";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const DAY = new Date("2026-09-26T08:00:00Z");

/** репо с одним сканом и оценкой `total` (HealthCraft Index) */
function seedRated(t: ApiTestDb, org: string, repo: string, total: number): number {
  const repoId = seedRepo(t, { org, repo });
  const scanId = seedScan(t, repoId);
  seedScore(t, repoId, scanId, { total });
  return repoId;
}

/** перескан с новым итогом: «последний пригодный» — по scan_id, он и двигает место */
function rescan(t: ApiTestDb, repoId: number, total: number): void {
  const scanId = seedScan(t, repoId);
  seedScore(t, repoId, scanId, { total });
}

function seedFlaggerNote(t: ApiTestDb, repoId: number, scanId: number, text: string): void {
  t.db
    .query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at) VALUES (?, ?, 'flagger', ?, '[]', '1', 'test', ?)")
    .run(repoId, scanId, text, DAY.toISOString());
}

const FLAG_TRUE = JSON.stringify({ flag: true, factors: [{ key: "activity.rhythm", note: "роботы" }], signals: {}, inputs: {} });
const FLAG_FALSE = JSON.stringify({ flag: false, factors: [], signals: {}, inputs: {} });

const itemOf = (t: ApiTestDb, repo: string) => listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100 }).items.find((i) => i.repo === repo);

// ---------- Р1: снимок мест ----------

describe("Р1: снимок мест рейтинга", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("снимок пишется один раз за UTC-дату (идемпотентно)", () => {
    seedRated(t, "o1", "alpha", 90);
    seedRated(t, "o1", "beta", 80);
    const first = takeRatingSnapshot(t.db, { now: DAY });
    expect(first).toEqual({ taken: true, rows: 2, day: "2026-09-26" });
    // повтор за ту же дату — пропуск, строк не добавляется
    const again = takeRatingSnapshot(t.db, { now: new Date("2026-09-26T23:59:00Z") });
    expect(again.taken).toBe(false);
    expect((t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots").get() as { c: number }).c).toBe(2);
    // следующая дата — новый снимок
    const nextDay = takeRatingSnapshot(t.db, { now: new Date("2026-09-27T00:30:00Z") });
    expect(nextDay).toEqual({ taken: true, rows: 2, day: "2026-09-27" });
  });

  test("ранг снимка совпадает с порядком выдачи рейтинга", () => {
    // выдача: alpha 90 (место 1), beta 80 (место 2) — сверяем снимок 26-го
    const items = listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100 }).items;
    const snap = t.db.query("SELECT repo_id, rank, score_index FROM rating_snapshots WHERE taken_at = ?").all("2026-09-26") as {
      repo_id: number;
      rank: number;
      score_index: number;
    }[];
    const byRepoId = new Map(snap.map((s) => [s.repo_id, s]));
    for (const item of items) {
      const row = t.db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(item.org, item.repo) as { id: number };
      expect(byRepoId.get(row.id)?.rank ?? null).toBe(item.rank);
      expect(byRepoId.get(row.id)?.score_index ?? null).toBe(item.healthcraftIndex);
    }
  });

  test("ленивая точка: без ночной волны сегодня снимок не пишется, с волной — пишется", () => {
    const lazy = makeApiDb();
    try {
      seedRated(lazy, "o2", "gamma", 70);
      // метки ночной волны нет вовсе
      expect(maybeTakeDailySnapshot(lazy.db, { now: DAY }).taken).toBe(false);
      // волна была ВЧЕРА по UTC — снимок за сегодня не пишется (delta честно смотрит в прошлый снимок)
      setMetaValue(lazy.db, SCHED_META.nightlyOkAt, "2026-09-25T22:00:00Z");
      expect(maybeTakeDailySnapshot(lazy.db, { now: DAY }).taken).toBe(false);
      // волна сегодня — снимок пишется
      setMetaValue(lazy.db, SCHED_META.nightlyOkAt, "2026-09-26T03:00:00Z");
      expect(maybeTakeDailySnapshot(lazy.db, { now: DAY })).toEqual({ taken: true, rows: 1, day: "2026-09-26" });
    } finally {
      lazy.close();
    }
  });

  test("ретеншен: снимки старше 35 суток удаляются обслуживанием", async () => {
    const old1 = utcDayOf(new Date(DAY.getTime() - 40 * 24 * 3600_000));
    const old2 = utcDayOf(new Date(DAY.getTime() - 36 * 24 * 3600_000));
    const fresh = utcDayOf(new Date(DAY.getTime() - 34 * 24 * 3600_000));
    const repoId = (t.db.query("SELECT id FROM repos LIMIT 1").get() as { id: number }).id;
    const ins = t.db.query("INSERT INTO rating_snapshots (taken_at, repo_id, rank, score_index) VALUES (?, ?, 1, 50)");
    ins.run(old1, repoId);
    ins.run(old2, repoId);
    ins.run(fresh, repoId);
    expect(purgeOldRatingSnapshots(t.db, { now: DAY })).toBe(2);
    const left = (t.db.query("SELECT taken_at FROM rating_snapshots WHERE taken_at IN (?, ?, ?)").all(old1, old2, fresh) as { taken_at: string }[]).map(
      (r) => r.taken_at,
    );
    expect(left).toEqual([fresh]);
    // и ретеншен встроен в часовое обслуживание (рядом с purgeOldJobs)
    ins.run(old1, repoId);
    const out = await maintenanceTick(t.db, loadConfig(), { now: DAY, cloneDir: t.db.filename.replace(/\/[^/]+$/, "/no-clones-here") });
    expect(out.snapshots).toBe(1);
  });
});

// ---------- Р1: rankDelta в выдаче ----------

describe("Р1: rankDelta строки рейтинга", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("вырос / упал / без изменения / новый / без снимка", () => {
    const a = seedRated(t, "d", "aaa", 90);
    const b = seedRated(t, "d", "bbb", 80);
    const c = seedRated(t, "d", "ccc", 70);
    // без снимка — delta null у всех
    expect(itemOf(t, "aaa")?.rankDelta).toBeNull();

    takeRatingSnapshot(t.db, { now: DAY }); // места: aaa 1, bbb 2, ccc 3
    // ccc вырос на 1-е место, новый репо ddd втискивается в середину
    rescan(t, c, 95);
    const d = seedRated(t, "d", "ddd", 85);
    void a;
    void b;
    void d;
    // выдача: ccc 95 (1), aaa 90 (2), ddd 85 (3), bbb 80 (4)
    expect(itemOf(t, "ccc")?.rank).toBe(1);
    expect(itemOf(t, "ccc")?.rankDelta).toBe(2); // 3 − 1: вырос
    expect(itemOf(t, "aaa")?.rankDelta).toBe(-1); // 1 − 2: упал
    expect(itemOf(t, "bbb")?.rankDelta).toBe(-2); // 2 − 4: упал
    expect(itemOf(t, "ddd")?.rankDelta).toBeNull(); // новый: в снимке его нет
  });

  test("delta считается к ПОСЛЕДНЕМУ снимку, не к вчерашнему вообще", () => {
    // снимок следующего дня отражает текущий порядок — delta обнуляется
    takeRatingSnapshot(t.db, { now: new Date("2026-09-27T01:00:00Z") });
    expect(itemOf(t, "ccc")?.rankDelta).toBe(0);
    expect(itemOf(t, "ddd")?.rankDelta).toBe(0);
  });
});

// ---------- Р2: плашка фрода ----------

describe("Р2: флаг фрода в строке рейтинга", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("fraud true только при flag:true ПОСЛЕДНЕЙ заметки flagger", () => {
    const flagged = seedRated(t, "f", "flagged", 90);
    const scan1 = seedScan(t, flagged);
    seedFlaggerNote(t, flagged, scan1, FLAG_TRUE);

    const clean = seedRated(t, "f", "clean", 80);
    seedFlaggerNote(t, clean, seedScan(t, clean), FLAG_FALSE);

    const broken = seedRated(t, "f", "broken", 70);
    seedFlaggerNote(t, broken, seedScan(t, broken), "{не json");

    const recleaned = seedRated(t, "f", "recleaned", 60);
    const old = seedScan(t, recleaned);
    seedFlaggerNote(t, recleaned, old, FLAG_TRUE);
    // более новая проверка (scan_id больше) сняла флаг — решает она
    seedFlaggerNote(t, recleaned, seedScan(t, recleaned), FLAG_FALSE);

    const noNote = seedRated(t, "f", "no-note", 50);
    void noNote;

    expect(itemOf(t, "flagged")?.fraud).toBe(true);
    expect(itemOf(t, "clean")?.fraud).toBe(false);
    expect(itemOf(t, "broken")?.fraud).toBe(false);
    expect(itemOf(t, "recleaned")?.fraud).toBe(false);
    expect(itemOf(t, "no-note")?.fraud).toBe(false);
  });

  test("флаг НЕ влияет на место, сортировку и фильтры", () => {
    const res = listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100 });
    // порядок — по индексу: flagged(90) первым, несмотря на флаг
    expect(res.items.map((i) => i.repo)).toEqual(["flagged", "clean", "broken", "recleaned", "no-note"]);
    expect(res.total).toBe(5);
  });
});

// ---------- Р3: внешняя ссылка ----------

describe("Р3: внешняя ссылка на SourceCraft", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("webUrl строки рейтинга = webUrl шапки карточки (один источник)", () => {
    seedRated(t, "e", "linked", 77);
    const item = itemOf(t, "linked");
    expect(item?.webUrl).toBe("https://sourcecraft.dev/e/linked");
    expect(item?.webUrl).toBe(getRepoCard(t.db, "e", "linked")?.repo.webUrl);
  });
});

// ---------- интеграция с воркер-лупом ----------

describe("Р1: снимок из тика воркера (роль rating)", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("пустая очередь рейтинг-полосы после сегодняшней волны → снимок; полоса user → нет", async () => {
    seedRated(t, "w", "wave", 66);
    const today = utcDayOf(new Date());
    setMetaValue(t.db, SCHED_META.nightlyOkAt, `${today}T04:00:00Z`);
    const deps = { db: t.db, config: loadConfig(), serverClient: () => null };
    // цикл сканов полосы user снимок не пишет
    expect(await workerTick(deps, ["user"], { busy: false }, { kind: "scan" })).toBe("idle");
    expect((t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots").get() as { c: number }).c).toBe(0);
    // цикл сканов полосы rating при пустой очереди — точка снимка
    expect(await workerTick(deps, ["rating"], { busy: false }, { kind: "scan" })).toBe("idle");
    expect((t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots").get() as { c: number }).c).toBe(1);
    // повторный тик — идемпотентно
    expect(await workerTick(deps, ["rating"], { busy: false }, { kind: "scan" })).toBe("idle");
    expect((t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots").get() as { c: number }).c).toBe(1);
  });
});
