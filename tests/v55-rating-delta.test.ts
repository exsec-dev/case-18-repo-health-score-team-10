// Динамика позиции, плашка накрутки и внешняя ссылка в строке рейтинга. Числа
// (место, delta, ранг снимка) проверяются на данных временной БД, а не по
// исходнику. Сиды – tests/api-fixtures.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { listRepos, DEFAULT_QUERY, getRepoCard } from "../src/api/repos";
import { purgeOldRatingSnapshots, takeRatingSnapshot, utcDayOf } from "../src/jobs/rating-snapshot";
import { catalogTick, enqueueScan, maintenanceTick, newCatalogTickState, workerTick, type CatalogTickState } from "../src/jobs/scheduler";
import { setMetaValue } from "../src/db";
import { SCHED_META } from "../src/api/health";
import { DEFAULT_SCAN, loadConfig, type Config } from "../src/config";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const DAY = new Date("2026-09-26T08:00:00Z");
const NEXT_DAY = new Date("2026-09-27T10:00:00Z");

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
    .query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at) VALUES (?, ?, 'flagger', ?, '[]', '7', 'test', ?)")
    .run(repoId, scanId, text, DAY.toISOString());
}

const FLAG_TRUE = JSON.stringify({ flag: true, factors: [{ key: "activity.rhythm", note: "роботы" }], signals: {}, inputs: {} });
const FLAG_FALSE = JSON.stringify({ flag: false, factors: [], signals: {}, inputs: {} });

// «сейчас» выдачи — явно: база динамики — снимок до текущих UTC-суток, часы
// теста не должны решать, какой снимок «вчерашний»
const itemOf = (t: ApiTestDb, repo: string, now: Date = NEXT_DAY) =>
  listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100 }, { now }).items.find((i) => i.repo === repo);

// ---------- снимок мест ----------

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

// ---------- rankDelta в выдаче ----------

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

  test("база — последний снимок ДО текущих суток: свой снимок дня стрелки не гасит", () => {
    // снимок 27-го пишется сразу после ночной волны и равен текущему порядку;
    // днем 27-го стрелки по-прежнему считаются к снимку 26-го
    takeRatingSnapshot(t.db, { now: new Date("2026-09-27T01:00:00Z") });
    expect(itemOf(t, "ccc", NEXT_DAY)?.rankDelta).toBe(2);
    expect(itemOf(t, "bbb", NEXT_DAY)?.rankDelta).toBe(-2);
    expect(itemOf(t, "ddd", NEXT_DAY)?.rankDelta).toBeNull();
    // на следующие сутки база — снимок 27-го: порядок не менялся — 0, ddd уже в снимке
    const day28 = new Date("2026-09-28T10:00:00Z");
    expect(itemOf(t, "ccc", day28)?.rankDelta).toBe(0);
    expect(itemOf(t, "ddd", day28)?.rankDelta).toBe(0);
    // в сутки единственного снимка базы нет — пустота, а не «0»
    expect(itemOf(t, "ccc", DAY)?.rankDelta).toBeNull();
  });
});

// ---------- плашка накрутки ----------

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

  test("флаг по правилу карточки: отказ новее заметки снимает флаг, заметка старше скана – «по прошлому анализу»", () => {
    const failed = seedRated(t, "g", "failed-after", 90);
    const s1 = seedScan(t, failed);
    seedFlaggerNote(t, failed, s1, FLAG_TRUE);
    const s2 = seedScan(t, failed);
    t.db
      .query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at) VALUES (?, ?, 'flagger', 'модель: сеть', ?)")
      .run(failed, s2, DAY.toISOString());

    const stale = seedRated(t, "g", "stale-flag", 80);
    seedFlaggerNote(t, stale, seedScan(t, stale), FLAG_TRUE);
    rescan(t, stale, 81);

    const fresh = seedRated(t, "g", "fresh-flag", 70);
    seedFlaggerNote(t, fresh, seedScan(t, fresh), FLAG_TRUE);

    expect(itemOf(t, "failed-after")?.fraud).toBe(false);
    expect(itemOf(t, "stale-flag")).toMatchObject({ fraud: true, fraudStale: true });
    expect(itemOf(t, "fresh-flag")).toMatchObject({ fraud: true, fraudStale: false });
  });
});

// ---------- внешняя ссылка ----------

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

// ---------- точка снимка – ночная фаза catalogTick ----------
// Снимок не ждет пустой очереди рейтинга: на стенде она не пустеет сутками
// (тысячи заявок через несколько часов после ночной фазы), и снимок не писался
// бы. Часы тестов – явный `now`, чтобы результат не зависел от времени прогона.

const HOUR = 60 * 60_000;

/** Конфиг обхода: ночная фаза раз в сутки, сверка раз в час (как на стенде). */
function tickConfig(overrides: Partial<Config["scheduler"]> = {}): Config {
  const base = loadConfig();
  return {
    ...base,
    scan: { ...DEFAULT_SCAN, catalog: { maxPages: 100 } },
    scheduler: { ...base.scheduler, catalogIntervalMs: HOUR, intervalMs: 24 * HOUR, fullRescan: false, ...overrides },
  };
}

/** Фейк-клиент каталога: одна страница из публичных репо `slugs` ("org/repo"). */
function catalogOf(slugs: string[], lastUpdated = "2026-09-20T00:00:00Z"): ScClient {
  let requests = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      requests++;
      if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
      const repositories = slugs.map((s) => {
        const [org, slug] = s.split("/");
        return { organization: { slug: org }, slug, name: slug, visibility: "public", last_updated: lastUpdated, language: null, rating: null };
      });
      return { status: 200, json: { repositories, next_page_token: "" }, bodyText: "" };
    },
    requestCount: () => requests,
  };
}

const snapCount = (t: ApiTestDb, day?: string): number =>
  day === undefined
    ? (t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots").get() as { c: number }).c
    : (t.db.query("SELECT COUNT(*) AS c FROM rating_snapshots WHERE taken_at = ?").get(day) as { c: number }).c;

const queuedRating = (t: ApiTestDb): number =>
  (t.db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued' AND user_id IS NULL AND kind = 'scan'").get() as { c: number }).c;

describe("Т2-А: снимок мест пишется ночной фазой обхода каталога", () => {
  test("непустая очередь рейтинга: ночная фаза пишет снимок; повтор в те же сутки — без дубля; сверка без ночной фазы — не пишет", async () => {
    const t = makeApiDb();
    try {
      const a = seedRated(t, "n", "a", 90);
      const b = seedRated(t, "n", "b", 80);
      // доочередь прошлой волны: очередь рейтинга НЕ пуста весь день (факт стенда)
      enqueueScan(t.db, a, { triggerKind: "periodic" });
      enqueueScan(t.db, b, { triggerKind: "periodic" });
      expect(queuedRating(t)).toBe(2);
      const client = () => catalogOf(["n/a", "n/b"]);
      const state: CatalogTickState = newCatalogTickState();
      const nightly = new Date("2026-09-26T12:16:00Z");
      const out = await catalogTick(t.db, client, tickConfig(), state, { now: nightly });
      expect(out?.phases.nightly).toBe(true);
      expect(snapCount(t, "2026-09-26")).toBe(2);
      // очередь по-прежнему не пуста — снимку она больше не нужна
      expect(queuedRating(t)).toBeGreaterThan(0);

      // часовая сверка тех же суток (ночная фаза не due) — снимок не трогает
      const hourly = await catalogTick(t.db, client, tickConfig(), state, { now: new Date(nightly.getTime() + HOUR) });
      expect(hourly?.phases).toEqual({ reconcile: true, nightly: false });
      expect(snapCount(t)).toBe(2);

      // ночная фаза повторно в те же UTC-сутки (рестарт после сбоя обхода, короткий
      // интервал) — идемпотентно: строк не добавилось, места не переписаны
      rescan(t, b, 99); // порядок сменился, но снимок дня уже есть
      const again = await catalogTick(t.db, client, tickConfig({ intervalMs: HOUR }), state, { now: new Date(nightly.getTime() + 3 * HOUR) });
      expect(again?.phases.nightly).toBe(true);
      expect(snapCount(t)).toBe(2);
      const rankOfA = (t.db.query("SELECT rank FROM rating_snapshots WHERE repo_id = ?").get(a) as { rank: number }).rank;
      expect(rankOfA).toBe(1);
    } finally {
      t.close();
    }
  });

  test("снимок — места ДО обхода: репо, эвиктированный этой ночной фазой, в снимке есть, в выдаче после — нет", async () => {
    const t = makeApiDb();
    try {
      const keep = seedRated(t, "e", "keep", 70);
      const gone = seedRated(t, "e", "gone", 95);
      void keep;
      const nightly = new Date("2026-09-26T12:16:00Z");
      // каталог уже без e/gone: обход эвиктит его (rating_active = 0)
      const out = await catalogTick(t.db, () => catalogOf(["e/keep"]), tickConfig(), newCatalogTickState(), { now: nightly });
      expect(out?.evicted).toContain("e/gone");
      const snap = t.db.query("SELECT repo_id, rank FROM rating_snapshots WHERE taken_at = '2026-09-26' ORDER BY rank").all() as { repo_id: number; rank: number }[];
      // места до обхода: gone 1-й, keep 2-й
      expect(snap.map((r) => r.repo_id)).toEqual([gone, keep]);
      // выдача после обхода — gone уже вне рейтинга, keep первый
      const items = listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100 }, { now: nightly }).items;
      expect(items.map((i) => i.repo)).toEqual(["keep"]);
      expect(items[0]?.rank).toBe(1);
    } finally {
      t.close();
    }
  });

  test("сбой снимка не валит обход: ночная фаза исполняется и отмечается", async () => {
    const t = makeApiDb();
    try {
      seedRated(t, "f", "x", 60);
      t.db.exec("DROP TABLE rating_snapshots");
      const state = newCatalogTickState();
      const nightly = new Date("2026-09-26T12:16:00Z");
      const out = await catalogTick(t.db, () => catalogOf(["f/x"]), tickConfig(), state, { now: nightly });
      expect(out?.ok).toBe(true);
      expect(out?.phases.nightly).toBe(true);
      expect(state.lastNightlyAt).toEqual(nightly);
    } finally {
      t.close();
    }
  });

  test("idle-тик воркера снимков больше не пишет (одна точка снимка)", async () => {
    const t = makeApiDb();
    try {
      seedRated(t, "w", "wave", 66);
      // ночная фаза сегодня исполнена – idle-тик все равно не пишет снимок
      setMetaValue(t.db, SCHED_META.nightlyOkAt, `${utcDayOf(new Date())}T04:00:00Z`);
      const deps = { db: t.db, config: loadConfig(), serverClient: () => null };
      expect(await workerTick(deps, ["rating"], { busy: false }, { kind: "scan" })).toBe("idle");
      expect(await workerTick(deps, ["rating"], { busy: false }, { kind: "scan", lightOnly: true })).toBe("idle");
      expect(await workerTick(deps, ["user", "rating"], { busy: false })).toBe("idle");
      expect(snapCount(t)).toBe(0);
    } finally {
      t.close();
    }
  });

  test("интеграция rankDelta: база — снимок ночной фазы прошлых суток, весь следующий день", async () => {
    const t = makeApiDb();
    try {
      const a = seedRated(t, "r", "aaa", 90);
      const b = seedRated(t, "r", "bbb", 80);
      const c = seedRated(t, "r", "ccc", 70);
      void a;
      void b;
      const client = () => catalogOf(["r/aaa", "r/bbb", "r/ccc"]);
      const state = newCatalogTickState();
      const at = (iso: string) => new Date(iso);
      const delta = (repo: string, now: Date) => itemOf(t, repo, now)?.rankDelta ?? null;

      // сутки 26: ночная фаза 12:16 — снимок 26 (aaa 1, bbb 2, ccc 3)
      await catalogTick(t.db, client, tickConfig(), state, { now: at("2026-09-26T12:16:00Z") });
      expect(snapCount(t, "2026-09-26")).toBe(3);
      // днем 26 волна двигает ccc на 1-е место; снимок единственный и сегодняшний — базы нет
      rescan(t, c, 95);
      expect(delta("ccc", at("2026-09-26T18:00:00Z"))).toBeNull();

      // сутки 27 до ночной фазы: база — снимок 26
      expect(delta("ccc", at("2026-09-27T06:00:00Z"))).toBe(2);
      expect(delta("aaa", at("2026-09-27T06:00:00Z"))).toBe(-1);
      // ночная фаза 27 — снимок 27 (ccc 1, aaa 2, bbb 3), места ДО новой волны
      await catalogTick(t.db, client, tickConfig(), state, { now: at("2026-09-27T12:16:00Z") });
      expect(snapCount(t, "2026-09-27")).toBe(3);
      // после ночной фазы 27 стрелки не гаснут: база по-прежнему снимок 26
      expect(delta("ccc", at("2026-09-27T20:00:00Z"))).toBe(2);
      expect(delta("bbb", at("2026-09-27T20:00:00Z"))).toBe(-1);

      // сутки 28: база — снимок 27; порядок с тех пор не менялся — 0
      expect(delta("ccc", at("2026-09-28T06:00:00Z"))).toBe(0);
      expect(delta("aaa", at("2026-09-28T06:00:00Z"))).toBe(0);
    } finally {
      t.close();
    }
  });
});

// ---------- снимок не пишется, пока идет пересчет после смены модели ----------
// Снимок посреди пересчета содержал бы только часть репозиториев (у остальных
// еще нет строк текущей модели), и завтрашние стрелки сравнивали бы с неполным
// списком. Снимок откладывается и дописывается следующим обходом каталога в те
// же сутки.

/** «Пересчет не закончен»: у скана есть оценка только прежней версии модели. */
function staleScoreRow(t: ApiTestDb, repoId: number): number {
  const scanId = seedScan(t, repoId);
  t.db
    .query(
      "INSERT INTO scores (scan_id, model_version, repo_id, healthcraft_index, index_coverage, categories, no_data, stale, computed_at) VALUES (?, 'old-model', ?, 50, 1, '{}', '[]', '[]', ?)",
    )
    .run(scanId, repoId, "2026-09-25T00:00:00Z");
  return scanId;
}

describe("тур 3: снимок отложен, пока идет пересчет после смены модели", () => {
  test("ночная фаза при идущем пересчете — снимка нет; следующий обход тех же суток после пересчета — снимок есть", async () => {
    const t = makeApiDb();
    try {
      seedRated(t, "r", "a", 90);
      const b = seedRated(t, "r", "b", 80);
      const staleScan = staleScoreRow(t, b);
      const client = () => catalogOf(["r/a", "r/b"]);
      const state: CatalogTickState = newCatalogTickState();
      const nightly = new Date("2026-09-26T12:16:00Z");
      const out = await catalogTick(t.db, client, tickConfig(), state, { now: nightly });
      expect(out?.phases.nightly).toBe(true);
      expect(snapCount(t, "2026-09-26")).toBe(0);

      // пересчет еще идет — часовая сверка тоже не пишет
      await catalogTick(t.db, client, tickConfig(), state, { now: new Date(nightly.getTime() + HOUR) });
      expect(snapCount(t, "2026-09-26")).toBe(0);

      // пересчет закончен: у скана появилась строка текущей модели
      seedScore(t, b, staleScan, { total: 80 });
      await catalogTick(t.db, client, tickConfig(), state, { now: new Date(nightly.getTime() + 2 * HOUR) });
      expect(snapCount(t, "2026-09-26")).toBe(2);
      // и больше не дублируется
      await catalogTick(t.db, client, tickConfig(), state, { now: new Date(nightly.getTime() + 3 * HOUR) });
      expect(snapCount(t)).toBe(2);
    } finally {
      t.close();
    }
  });

  test("часовая сверка ДО ночной фазы суток снимок не пишет (отложенный — только после ночной фазы)", async () => {
    const t = makeApiDb();
    try {
      seedRated(t, "s", "a", 90);
      const client = () => catalogOf(["s/a"]);
      const state: CatalogTickState = newCatalogTickState();
      await catalogTick(t.db, client, tickConfig(), state, { now: new Date("2026-09-26T12:16:00Z") });
      expect(snapCount(t, "2026-09-26")).toBe(1);
      // следующие сутки, 03:00 UTC: сверка есть, ночной фазы еще не было — снимка за 27-е нет
      await catalogTick(t.db, client, tickConfig(), state, { now: new Date("2026-09-27T03:00:00Z") });
      expect(snapCount(t, "2026-09-27")).toBe(0);
    } finally {
      t.close();
    }
  });
});
