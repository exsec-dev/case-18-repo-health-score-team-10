// v53-compare.test.ts — В5.3 круг 4 (К-1): «Сравнение репозиториев».
// Поведенческие тесты на данных (AGENTS.md 21.09 и 23.09): поле ответа, которое
// рисует экран, равно источнику — карточке того же зрителя; без прав не
// раскрывается (недоступное неотличимо от несуществующего); «нет данных» не 0;
// лидер строки, заметки сопоставимости и видимость строк полной оценки — на
// данных, а не текстом исходника; лимит — на дефолте конфигурации.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPARE_MAX, buildCompare, compareCardOf, parseCompareQuery, type CompareItem } from "../src/api/compare";
import { getRepoCard, resolveCardForViewer } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import { NO_PAT_ACCESS } from "../src/auth/access";
import { SESSION_COOKIE, createSession, upsertUser } from "../src/auth/session";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { MODEL_VERSION } from "../src/score/model";
import {
  COMPARE_FULL_PARTIAL,
  DATE_GAP_DAYS,
  comparabilityNotes,
  compareHref,
  compareSlugsOf,
  commonYear,
  exceptionLabel,
  COMPARE_FULL_LINE,
  COMPARE_REFERENCE,
  fullRows,
  indexCategoriesCounted,
  rowLeaders,
  unavailableText,
} from "../src/web/compareView";
import { middleEllipsis } from "../src/web/format";
import { parseRoute } from "../src/web/router";
import { SLOT_EMPTY } from "../src/web/slots";
import { cardFacts, makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";
import { spawnServer, startMockApi, type MockApi, type SpawnedServer } from "./server-harness";

const dbs: ApiTestDb[] = [];
const dirs: string[] = [];
const mocks: MockApi[] = [];
const servers: SpawnedServer[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
  for (const m of mocks) m.stop();
  for (const t of dbs) {
    try {
      t.close();
    } catch {}
  }
  // Windows держит файл БД за процессом сервера (EBUSY) — уборка tmp не проверка
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const GRANTED: AccessResult = { repo: "granted", cicd: "granted", appsec: "granted" };

function fixture() {
  const t = makeApiDb();
  dbs.push(t);
  const seed = (org: string, repo: string, opts: { visibility?: string; ratingActive?: 0 | 1; total?: number | null; categories?: Record<string, unknown>; computedAt?: string; score?: boolean } = {}) => {
    const id = seedRepo(t, { org, repo, language: "TypeScript" });
    t.db.query("UPDATE repos SET visibility = ?, rating_active = ? WHERE id = ?").run(opts.visibility ?? "public", opts.ratingActive ?? 1, id);
    if (opts.score !== false) {
      const scan = seedScan(t, id, { facts: cardFacts(), startedAt: opts.computedAt });
      seedScore(t, id, scan, { total: opts.total === undefined ? 70 : opts.total, categories: opts.categories as never, computedAt: opts.computedAt });
    }
    return id;
  };
  return { t, seed };
}

const resolveWith = (t: ApiTestDb, access: AccessResult, provenRights = false) => (org: string, repo: string) =>
  resolveCardForViewer(t.db, org, repo, async () => access, { provenRights: () => provenRights });

const slugsOf = (...s: string[]) => s.map((slug) => ({ org: slug.split("/")[0]!, repo: slug.split("/")[1]!, slug }));

// ---------- разбор запроса ----------

describe("К-1: параметры запроса (П12)", () => {
  test("нет r — отказ; больше 3 уникальных — отказ; дубли схлопнуты с порядком первого вхождения", () => {
    expect(parseCompareQuery(new URLSearchParams("")).ok).toBe(false);
    expect(parseCompareQuery(new URLSearchParams("r=a/1&r=a/2&r=a/3&r=a/4")).ok).toBe(false);
    const q = parseCompareQuery(new URLSearchParams("r=a/2&r=a/1&r=a/2&r=a/3"));
    expect(q.ok && q.slugs.map((s) => s.slug)).toEqual(["a/2", "a/1", "a/3"]);
    expect(COMPARE_MAX).toBe(3);
  });

  test("слаг не вида org/repo, точки и мусорный charset — отказ", () => {
    for (const bad of ["a", "a/b/c", "../b", "a/..", "a b/c", "a/%zz", ""]) {
      expect(parseCompareQuery(new URLSearchParams([["r", bad]])).ok).toBe(false);
    }
  });
});

// ---------- равно источнику ----------

describe("К-1: элемент сравнения равен карточке того же зрителя (П1, П2)", () => {
  test("аноним и зритель с правами: карточка сравнения = карточка без AI, рекомендаций и фактов", async () => {
    const { t, seed } = fixture();
    seed("cmp", "alpha", { total: 83 });
    seed("cmp", "beta", { total: 64 });
    for (const access of [NO_PAT_ACCESS, GRANTED]) {
      const res = await buildCompare(slugsOf("cmp/alpha", "cmp/beta"), resolveWith(t, access));
      expect(res.modelVersion).toBe(MODEL_VERSION);
      for (const [i, repo] of ["alpha", "beta"].entries()) {
        const item = res.items[i]!;
        expect(item.status).toBe("ok");
        const card = getRepoCard(t.db, "cmp", repo, { access })!;
        expect(item.status === "ok" && item.card).toEqual(compareCardOf(card));
        // поля, которые рисует экран, — те же числа, что у карточки
        if (item.status !== "ok") throw new Error("unreachable");
        expect(item.card.score!.healthcraftIndex).toBe(card.score!.healthcraftIndex);
        expect(item.card.score!.rank).toBe(card.score!.rank);
        expect(item.card.score!.categories.documentation.submetrics).toEqual(card.score!.categories.documentation.submetrics);
      }
    }
  });

  test("в ответе нет AI, рекомендаций, фактов и производных — даже у зрителя с полным доступом (П6)", async () => {
    const { t, seed } = fixture();
    seed("cmp", "alpha");
    const res = await buildCompare(slugsOf("cmp/alpha"), resolveWith(t, GRANTED));
    const item = res.items[0]!;
    if (item.status !== "ok") throw new Error("ожидался ok");
    expect("ai" in item.card).toBe(false);
    expect(item.card.recommendations).toEqual([]);
    expect(item.card.evidence).toEqual([]);
    expect(item.card.derived).toBeNull();
    expect(item.card.job).toBeNull();
  });

  test("аноним: CI/CD и Безопасность закрыты, Repo Health Score не раскрыт (П6)", async () => {
    const { t, seed } = fixture();
    seed("cmp", "alpha");
    const item = (await buildCompare(slugsOf("cmp/alpha"), resolveWith(t, NO_PAT_ACCESS))).items[0]!;
    if (item.status !== "ok") throw new Error("ожидался ok");
    expect(item.card.score!.fullLocked).toBe(true);
    expect(item.card.score!.repoHealthScore).toBeNull();
    expect(item.card.score!.categories.cicd.locked).toBe("no-pat");
    expect(item.card.score!.categories.cicd.score).toBeNull();
    expect(item.card.score!.categories.cicd.submetrics).toEqual({});
  });
});

// ---------- без прав не раскрывается ----------

describe("К-1: недоступное неотличимо от несуществующего (П3-П5, П7)", () => {
  test("аноним: приватный, internal, выселенный публичный и несуществующий — один и тот же элемент", async () => {
    const { t, seed } = fixture();
    seed("cmp", "private", { visibility: "private" });
    seed("cmp", "internal", { visibility: "internal" });
    seed("cmp", "evicted", { ratingActive: 0 });
    const res = await buildCompare(slugsOf("cmp/private", "cmp/internal", "cmp/evicted"), resolveWith(t, NO_PAT_ACCESS));
    const ghost = (await buildCompare(slugsOf("cmp/nope"), resolveWith(t, NO_PAT_ACCESS))).items[0]!;
    const strip = (i: CompareItem) => JSON.stringify({ ...i, slug: "_" });
    for (const item of res.items) expect(strip(item)).toBe(strip(ghost));
    expect(Object.keys(ghost).sort()).toEqual(["slug", "status"]);
    expect(ghost.status).toBe("unavailable");
  });

  test("эхо слага — как ввел зритель, не из БД", async () => {
    const { t, seed } = fixture();
    seed("cmp", "private", { visibility: "private" });
    const res = await buildCompare(slugsOf("CMP/Private"), resolveWith(t, NO_PAT_ACCESS));
    expect(res.items[0]).toEqual({ slug: "CMP/Private", status: "unavailable" });
  });

  test("приватный: токену отказано — недоступен; доступ есть — оценка, места в рейтинге нет", async () => {
    const { t, seed } = fixture();
    seed("cmp", "private", { visibility: "private" });
    const denied = await buildCompare(slugsOf("cmp/private"), resolveWith(t, { repo: "denied", cicd: "denied", appsec: "denied" }));
    expect(denied.items[0]).toEqual({ slug: "cmp/private", status: "unavailable" });
    const granted = (await buildCompare(slugsOf("cmp/private"), resolveWith(t, GRANTED))).items[0]!;
    if (granted.status !== "ok") throw new Error("ожидался ok");
    expect(granted.card.score!.healthcraftIndex).toBe(70);
    expect(granted.card.score!.rank).toBeNull();
    expect(granted.card.score!.rankedTotal).toBeNull();
  });

  test("internal с доступом — оценка без места; публичный из рейтинга — место есть; unknown — гейт не-публичного", async () => {
    const { t, seed } = fixture();
    seed("cmp", "internal", { visibility: "internal" });
    seed("cmp", "public", { total: 90 });
    seed("cmp", "unknown", { visibility: "garbage" });
    const res = await buildCompare(slugsOf("cmp/internal", "cmp/public", "cmp/unknown"), resolveWith(t, GRANTED));
    const [internal, pub, unknown] = res.items;
    if (internal!.status !== "ok" || pub!.status !== "ok" || unknown!.status !== "ok") throw new Error("ожидались ok");
    expect(internal!.card.repo.visibility).toBe("internal");
    expect(internal!.card.score!.rank).toBeNull();
    expect(pub!.card.score!.rank).toBe(1);
    expect(pub!.card.score!.rankedTotal).toBe(1);
    expect(unknown!.card.repo.visibility).toBe("unknown");
    // тот же unknown анониму — недоступен
    const anon = await buildCompare(slugsOf("cmp/unknown"), resolveWith(t, NO_PAT_ACCESS));
    expect(anon.items[0]!.status).toBe("unavailable");
  });

  test("сбой проверки прав: без доказанных прав — недоступен; с доказанными — свой статус", async () => {
    const { t, seed } = fixture();
    seed("cmp", "private", { visibility: "private" });
    const failed: AccessResult = { repo: "check-failed", cicd: "check-failed", appsec: "check-failed" };
    expect((await buildCompare(slugsOf("cmp/private"), resolveWith(t, failed, false))).items[0]!.status).toBe("unavailable");
    expect((await buildCompare(slugsOf("cmp/private"), resolveWith(t, failed, true))).items[0]!.status).toBe("check_failed");
    const expired: AccessResult = { repo: "pat-expired", cicd: "pat-expired", appsec: "pat-expired" };
    expect((await buildCompare(slugsOf("cmp/private"), resolveWith(t, expired, true))).items[0]!.status).toBe("token_rejected");
  });

  test("репо в каталоге без оценки — столбец с оценкой null, а не недоступный", async () => {
    const { t, seed } = fixture();
    seed("cmp", "fresh", { score: false });
    const item = (await buildCompare(slugsOf("cmp/fresh"), resolveWith(t, NO_PAT_ACCESS))).items[0]!;
    if (item.status !== "ok") throw new Error("ожидался ok");
    expect(item.card.score).toBeNull();
  });
});

// ---------- презентация над числами (compareView) ----------

describe("К-1: лидер строки (П9)", () => {
  test("лидер — по показанному целому; ничья наверху — все делящие; все равны — нет", () => {
    expect(rowLeaders([83, 84, 72])).toEqual([false, true, false]);
    expect(rowLeaders([90, 90, 72])).toEqual([true, true, false]);
    expect(rowLeaders([80, 80, 80])).toEqual([false, false, false]);
    // 39,5 и 40 показаны как 40 — ничья, лидера нет
    expect(rowLeaders([39.5, 40])).toEqual([false, false]);
  });

  test("«нет данных» не выигрывает и не проигрывает; одно число — лидера нет", () => {
    expect(rowLeaders([null, 50, null])).toEqual([false, false, false]);
    expect(rowLeaders([null, 50, 60])).toEqual([false, false, true]);
    expect(rowLeaders([undefined, 50, 60])).toEqual([false, false, true]);
  });

  test("закрытая зрителю ячейка — лидера нет вовсе", () => {
    expect(rowLeaders([90, "closed", 40])).toEqual([false, false, false]);
  });
});

describe("К-1: заметки сопоставимости и «по N категориям» (П8, П10)", () => {
  const cardWith = async (cats: Record<string, unknown>[], dates?: string[]) => {
    const { t, seed } = fixture();
    const slugs: string[] = [];
    cats.forEach((c, i) => {
      seed("cmp", `r${i}`, { categories: c, computedAt: dates?.[i] });
      slugs.push(`cmp/r${i}`);
    });
    return (await buildCompare(slugsOf(...slugs), resolveWith(t, NO_PAT_ACCESS))).items;
  };

  test("одинаковая основа и близкие даты — заметок нет (утверждения «все сопоставимо» нет)", async () => {
    const items = await cardWith([{}, {}]);
    expect(comparabilityNotes(items)).toEqual([]);
  });

  test("NULL-категория — «нет данных», не 0: число категорий индекса меньше, заметка о разной основе", async () => {
    const items = await cardWith([{}, { issues: { score: null, no_data: "issues channel no-data", submetrics: {} } }]);
    const [a, b] = items;
    if (a!.status !== "ok" || b!.status !== "ok") throw new Error("ожидались ok");
    expect(b!.card.score!.categories.issues.score).toBeNull();
    expect(indexCategoriesCounted(a!.card)).toBe(4);
    expect(indexCategoriesCounted(b!.card)).toBe(3);
    const notes = comparabilityNotes(items);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("cmp/r0 – по 4 категориям");
    expect(notes[0]).toContain("cmp/r1 – по 3 категориям");
  });

  test("3 столбца, у одного другая основа — «остальных», длинное имя сокращено в середине с хвостом", async () => {
    const noIssues = { issues: { score: null, no_data: "issues channel no-data", submetrics: {} } };
    const { t, seed } = fixture();
    seed("cmp", "a");
    seed("cmp", "b");
    seed("cmp", `case-13-field-engineer-routing-and-dispatch-platform-team-112`, { categories: noIssues });
    const res = await buildCompare(slugsOf("cmp/a", "cmp/b", "cmp/case-13-field-engineer-routing-and-dispatch-platform-team-112"), resolveWith(t, NO_PAT_ACCESS));
    const [note] = comparabilityNotes(res.items);
    expect(note).toStartWith("Индекс cmp/");
    expect(note).toContain("…");
    expect(note).toContain("…orm-team-112 посчитан по 3 категориям из 4, остальных – по 4. Вес категории без данных переходит к остальным");
  });

  test(`разрыв дат ≥ ${DATE_GAP_DAYS} дней — заметка с числом дней; ${DATE_GAP_DAYS - 1} — нет`, async () => {
    const far = await cardWith([{}, {}], ["2026-08-01T12:00:00Z", "2026-09-10T12:00:00Z"]);
    const near = await cardWith([{}, {}], ["2026-08-01T12:00:00Z", `2026-08-${String(1 + DATE_GAP_DAYS - 1).padStart(2, "0")}T12:00:00Z`]);
    expect(comparabilityNotes(far)).toEqual([expect.stringContaining("Анализы разнесены на 40 дней")]);
    expect(comparabilityNotes(near)).toEqual([]);
  });

  test("столбцы без оценки и недоступные в заметках не участвуют", async () => {
    const { t, seed } = fixture();
    seed("cmp", "a", { computedAt: "2026-01-01T00:00:00Z" });
    seed("cmp", "fresh", { score: false });
    const res = await buildCompare(slugsOf("cmp/a", "cmp/fresh", "cmp/nope"), resolveWith(t, NO_PAT_ACCESS));
    expect(comparabilityNotes(res.items)).toEqual([]);
  });
});

describe("К-1: блок «Полная оценка» (П11)", () => {
  test("строки — только если открыты у всех оцененных; у части — пояснение", async () => {
    const { t, seed } = fixture();
    seed("cmp", "a");
    seed("cmp", "b");
    const both = await buildCompare(slugsOf("cmp/a", "cmp/b"), resolveWith(t, GRANTED));
    expect(fullRows(both.items)).toEqual({ rows: ["repoHealthScore", "cicd", "security"], partial: false });
    const anon = await buildCompare(slugsOf("cmp/a", "cmp/b"), resolveWith(t, NO_PAT_ACCESS));
    expect(fullRows(anon.items)).toEqual({ rows: [], partial: false });
    // смешанный набор: у первого открыто, у второго нет
    const mixed = { ...both, items: [both.items[0]!, anon.items[1]!] };
    expect(fullRows(mixed.items)).toEqual({ rows: [], partial: true });
    expect(COMPARE_FULL_PARTIAL).toContain("у всех выбранных");
  });
});

describe("К-1: адрес набора, маршрут, тексты", () => {
  test("набор в адресе: дубли и мусор отброшены, не больше 3, круг адрес → слаги → адрес", () => {
    expect(compareSlugsOf("r=a/1&r=a/1&r=bad&r=a/2&r=a/3&r=a/4")).toEqual(["a/1", "a/2", "a/3"]);
    expect(compareSlugsOf(compareHref(["org-x/repo.y", "o/r"]).split("?")[1]!)).toEqual(["org-x/repo.y", "o/r"]);
    expect(compareHref([])).toBe("/compare");
    expect(parseRoute("/compare", "r=a/b")).toEqual({ kind: "compare", search: "r=a/b" });
    expect(parseRoute("/compare/x")).toEqual({ kind: "not-found" });
  });

  test("длинное имя — многоточие в середине, различающий хвост виден", () => {
    const long = "case-13-field-engineer-routing-and-dispatch-platform-for-regions-team-112";
    const shown = middleEllipsis(long, 20, 10);
    expect(shown.length).toBe(20);
    expect(shown.endsWith("s-team-112")).toBe(true);
    expect(middleEllipsis("short", 20)).toBe("short");
  });

  test("Д8 Б: общий год дат — только если он один; мусор и пустые даты не мешают", () => {
    expect(commonYear(["2026-09-23T10:00:00Z", "2026-09-24T10:00:00Z", null])).toBe(2026);
    expect(commonYear(["2025-12-31T10:00:00Z", "2026-01-02T10:00:00Z"])).toBeNull();
    expect(commonYear([null, "garbage"])).toBeNull();
  });

  test("Д7: метка столбца-исключения — своя на каждый статус (enum элемента целиком)", () => {
    const labels = (["noscore", "unavailable", "check_failed", "token_rejected"] as const).map(exceptionLabel);
    expect(new Set(labels).size).toBe(4);
    for (const l of [...labels, COMPARE_FULL_LINE, COMPARE_REFERENCE]) {
      expect(l).not.toContain("ё");
      expect(l).not.toContain("—");
    }
    expect(COMPARE_REFERENCE).toBe("Справочно, в балл не входит");
  });

  test("текст недоступного — по зрителю, не по репозиторию; тексты по правилу языка", () => {
    expect(unavailableText(false)).toContain("после входа");
    expect(unavailableText(true)).toContain("ваш токен");
    for (const text of [unavailableText(false), unavailableText(true), SLOT_EMPTY.compare.title, SLOT_EMPTY.compare.text, COMPARE_FULL_PARTIAL]) {
      expect(text).not.toContain("ё");
      expect(text).not.toContain("—");
    }
  });
});

// ---------- маршрут ----------

describe("К-1: маршрут /api/compare (П12, П13)", () => {
  test("400 на плохой запрос, 200 без кэша; залогиненный — N открытий карточки на запрос, окно по умолчанию 30", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v53-cmp-"));
    dirs.push(dir);
    const SECRET = "y".repeat(32);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const wrap = { db, close: () => {} };
    for (const repo of ["a", "b", "c"]) {
      const id = seedRepo(wrap, { org: "cmp", repo });
      seedScore(wrap, id, seedScan(wrap, id, { facts: cardFacts() }), { total: 70 });
    }
    const userId = upsertUser(db, "ya-cmp", "cmpuser");
    const cookie = `${SESSION_COOKIE}=${createSession(db, SECRET, userId)}`;
    db.close();
    const mock = startMockApi(() => null);
    mocks.push(mock);
    // дефолт окна: переменная не задана (правило 22.09 — хотя бы один тест на дефолте)
    const server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { QUEUE_CARD_PER_MINUTE: "" } });
    servers.push(server);

    expect((await fetch(`${server.base}/api/compare`)).status).toBe(400);
    expect((await fetch(`${server.base}/api/compare?r=a/1&r=a/2&r=a/3&r=a/4`)).status).toBe(400);
    const anon = await fetch(`${server.base}/api/compare?r=cmp/a&r=cmp/nope`);
    expect(anon.status).toBe(200);
    expect(anon.headers.get("cache-control")).toBe("private, no-store");
    const body = (await anon.json()) as { items: { status: string }[] };
    expect(body.items.map((i) => i.status)).toEqual(["ok", "unavailable"]);

    // 10 запросов по 3 репо = 30 открытий; 11-й — 429 с Retry-After
    const q = `${server.base}/api/compare?r=cmp/a&r=cmp/b&r=cmp/c`;
    for (let i = 0; i < 10; i++) expect((await fetch(q, { headers: { cookie } })).status).toBe(200);
    const limited = await fetch(q, { headers: { cookie } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // и окно общее с карточкой: карточка тоже упирается
    expect((await fetch(`${server.base}/api/repos/cmp/a`, { headers: { cookie } })).status).toBe(429);
  }, 30_000);
});
