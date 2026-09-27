// Репро-тесты на найденные аудитом регрессии слияния портов: справедливость
// полос очереди, гард дубля периодики, происхождение доказательств на
// карточке, миграция trigger_kind и права в кабинете. Каждый тест описывает
// правильное поведение и проверяет конкретное значение.
//
// Живых запросов нет: временный DATA_DIR, SOURCECRAFT_TOKEN="" (задаёт
// харнесс), все адреса API — локальный мок. Мок repo-GET НЕ отдаёт `id`:
// если `makeAppsecClient` построен без `baseUrl`, запрос ушёл бы с PAT на
// боевой appsec.sourcecraft.tech.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb, setMetaValue } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { getRepoCard } from "../src/api/repos";
import type { ScClient, ScResponse } from "../src/collectors/http";
import * as scheduler from "../src/jobs/scheduler";
import { cardFacts, seedRepo, seedScan, seedScore, type ApiTestDb, type FactSpec } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

// Обертка репро: тест под `repro` — неисправленный дефект. В обычном прогоне
// это `test.failing` (набор зеленый), под `AUDIT_STRICT=1` — обычный `test`,
// красный до исправления. Исправленный тест переводится в обычный `test`,
// иначе `test.failing` упал бы на «прошел».
const repro = process.env.AUDIT_STRICT ? test : test.failing;

/**
 * Ключ канального дерева в `evidence`. Литерал повторён здесь намеренно:
 * репро-тест пиннит контракт, а не следует за константой реализации.
 */
const CHANNEL_TREE_KEY = "tree.stats@channel";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

function tempDb(prefix: string): ApiTestDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t: ApiTestDb = { db, close: () => db.close() };
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return t;
}

// ---------------------------------------------------------------------------
// Справедливость между полосами очереди.
// ---------------------------------------------------------------------------

describe("П1 (К1): роль all — полоса rating не голодает при непустой полосе user", () => {
  test("6 вызовов claimAny(['user','rating']) при непустых обеих полосах дают ≥ 2 периодических", () => {
    const t = tempDb("rh-m42-p1-");
    const db = t.db;
    // курсор round-robin модульный — без сброса тесты не герметичны
    (scheduler as unknown as { __resetRoundRobin?: () => void }).__resetRoundRobin?.();
    const uid = upsertUser(db, "ya-p1", "p1");
    const repoOf = (slug: string) =>
      Number(db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('p1', ?, 'public')").run(slug).lastInsertRowid);
    // ≥ 6 юзерских job: иначе вызовы 4–6 сами возьмут периодику и тест позеленеет вхолостую
    const userJobs = new Set<number>();
    for (let i = 0; i < 8; i++) userJobs.add(scheduler.enqueueScan(db, repoOf(`u${i}`), { userId: uid, triggerKind: "user" }));
    for (let i = 0; i < 8; i++) scheduler.enqueueScan(db, repoOf(`p${i}`), { triggerKind: "periodic" });

    let t0 = Date.parse("2026-09-18T00:00:00Z");
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) {
      const job = scheduler.claimAny(db, ["user", "rating"], new Date((t0 += 1000)), 60 * 60_000);
      taken.push(job === null ? "none" : job.triggerKind === "user" ? "user" : "periodic");
    }
    const periodic = taken.filter((x) => x === "periodic").length;
    // ассерт «≥ 2 из 6» устойчив к чётности курсора; точный порядок — деталь реализации
    expect({ periodicOf6: periodic >= 2 ? "≥2" : `${periodic} (взято: ${taken.join(" ")})` }).toEqual({ periodicOf6: "≥2" });
    expect(userJobs.size).toBe(8);
  });

  test("пустая полоса user — все 6 вызовов берут периодику (курсор не теряет прогресс)", () => {
    const t = tempDb("rh-m42-p1b-");
    const db = t.db;
    (scheduler as unknown as { __resetRoundRobin?: () => void }).__resetRoundRobin?.();
    const repoOf = (slug: string) =>
      Number(db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('p1b', ?, 'public')").run(slug).lastInsertRowid);
    for (let i = 0; i < 8; i++) scheduler.enqueueScan(db, repoOf(`p${i}`), { triggerKind: "periodic" });
    let t0 = Date.parse("2026-09-18T00:00:00Z");
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) {
      const job = scheduler.claimAny(db, ["user", "rating"], new Date((t0 += 1000)), 60 * 60_000);
      taken.push(job === null ? "none" : job.triggerKind);
    }
    expect(taken).toEqual(["periodic", "periodic", "periodic", "periodic", "periodic", "periodic"]);
    // шов сброса курсора обязан существовать — иначе соседние тесты не герметичны
    expect(typeof (scheduler as unknown as { __resetRoundRobin?: unknown }).__resetRoundRobin).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Гард дубля периодики в ночном обходе.
// ---------------------------------------------------------------------------

/** Фейк-клиент каталога: одна страница, повторяется на каждом обходе. */
function catalogClient(repos: Record<string, unknown>[]): ScClient {
  return {
    async get(path: string): Promise<ScResponse> {
      if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
      return { status: 200, json: { repositories: repos, next_page_token: "" }, bodyText: "" };
    },
    requestCount: () => 1,
  };
}

describe("П5 (С2 r2): три обхода при неизменном каталоге ставят ровно одну job", () => {
  test("непригодный последний периодический скан — retry-ineligible не дублируется, пока job жива", async () => {
    const t = tempDb("rh-m42-p5-");
    const db = t.db;
    const repoId = seedRepo(t, { org: "nc5", repo: "ineligible", lastActivityAt: "2026-09-01T00:00:00Z" });
    // завершённый периодический скан, непригодный для рейтинга
    seedScan(t, repoId, { status: "ok", trigger: "periodic", ratingEligible: false, userId: null });
    const page = [
      {
        organization: { slug: "nc5" },
        slug: "ineligible",
        name: "ineligible",
        visibility: "public",
        last_updated: "2026-09-01T00:00:00Z",
        language: null as unknown,
        rating: null,
      },
    ];
    const reasons: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await scheduler.nightlyCatalog(db, catalogClient(page), { now: new Date() });
      reasons.push(out.enqueued.map((e) => e.reason).join(",") || "-");
    }
    const jobs = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE repo_id = ?").get(repoId) as { c: number }).c;
    expect({ reasons, jobs }).toEqual({ reasons: ["retry-ineligible", "-", "-"], jobs: 1 });
  });
});

// ---------------------------------------------------------------------------
// Плотность Security доказывается tree.stats СВОЕГО скана.
// ---------------------------------------------------------------------------

const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;

describe("П9 (С1 r2): число плотности Security и tree.stats в доказательствах — из одного скана", () => {
  // Канальное дерево едет СВОИМ ключом, публичный `tree.stats` скана P не
  // вытесняется; число плотности и факт, из которого оно посчитано, — из
  // одного скана.
  test("канальный скан с ok tree.stats(loc=20000) — его дерево в evidence под канальным ключом", () => {
    const t = tempDb("rh-m42-p9-");
    const repoId = seedRepo(t, { org: "dens", repo: "repo", language: "Go" });
    // скан A: Security-канал (appsec.findings ok + tree.stats ok) — по нему считается плотность
    const secScan = seedScan(t, repoId, {
      startedAt: "2026-09-10T00:00:00Z",
      status: "ok",
      ratingEligible: false,
      facts: [
        { key: "appsec.findings", source: "appsec:api", value: { severity_counts: { critical: 0, high: 2, medium: 4, low: 6 }, resolved_share: 0.5, secrets_critical: false } },
        { key: "tree.stats", source: "git", value: { top_level: [{ name: "src", type: "tree" }], file_count: 42, bytes: 900_000, loc: 20_000 } },
      ],
    });
    // скан B (последний пригодный, P): дерево не собралось — tree.stats no-data
    const publicFacts: FactSpec[] = cardFacts().map((f) =>
      f.key === "tree.stats" ? { key: "tree.stats", source: "git", status: "no-data" as const, value: { reason: "limits", detail: "clone budget" } } : f,
    );
    const pScan = seedScan(t, repoId, { startedAt: "2026-09-16T00:00:00Z", status: "ok", ratingEligible: true, facts: publicFacts });
    seedScore(t, repoId, pScan, { total: 60 });

    const card = getRepoCard(t.db, "dens", "repo", { access: { ...GRANTED } })!;
    const density = card.score!.categories.security.submetrics.density as { score: number | null; value: number | null } | undefined;
    const tree = card.evidence.filter((e) => e.key === CHANNEL_TREE_KEY);
    const appsec = card.evidence.find((e) => e.key === "appsec.findings");
    expect({
      densityValue: typeof density?.value === "number" ? Math.round(density!.value! * 1000) / 1000 : density?.value ?? null,
      treeCount: tree.length,
      treeStatus: tree[0]?.status ?? null,
      treeLoc: (tree[0]?.value as { loc?: unknown } | undefined)?.loc ?? null,
      appsecPresent: appsec !== undefined,
      sameScan: appsec !== undefined && tree[0] !== undefined && appsec.collectedAt === tree[0].collectedAt,
      // публичный факт скана P остаётся на месте и своим статусом
      publicTreeStatus: card.evidence.find((e) => e.key === "tree.stats")?.status ?? null,
    }).toEqual({
      // SEVERITY_WEIGHTS: 0*8 + 2*4 + 4*2 + 6*1 = 22 на 20 000 LOC → 11 на 10k LOC
      densityValue: 11,
      treeCount: 1,
      treeStatus: "ok",
      treeLoc: 20_000,
      appsecPresent: true,
      sameScan: true,
      publicTreeStatus: "no-data",
    });
    // ни одна ссылка показанного правила на факт канала не «повисает»
    const dangling = card.recommendations.flatMap((r) => r.factRefs).filter((ref) => ref.missing && (ref.key === "tree.stats" || ref.key === "appsec.findings"));
    expect(dangling).toEqual([]);
    expect(secScan).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Бэкфилл `trigger_kind` при миграции: у строк, созданных ДО появления колонки,
// `user_id IS NOT NULL` соседствует с `trigger_kind = 'periodic'` (ensureColumn
// поставил DEFAULT). На эквивалентности «trigger_kind != 'user' ⇔ user_id IS
// NULL» стоят два предиката полосы — гард дубля периодики и retry-failed; без
// бэкфилла для legacy-строк она неверна.
// ---------------------------------------------------------------------------

/** Каталог из одной записи с заданной датой — вход ночного обхода. */
const catalogPage = (org: string, repo: string, lastUpdated: string) => [
  { organization: { slug: org }, slug: repo, name: repo, visibility: "public", last_updated: lastUpdated, language: null as unknown, rating: null },
];

/** Временная БД с legacy-строкой jobs (user_id задан, trigger_kind='periodic') и повторным openDb. */
function legacyJobDb(prefix: string, status: string): { db: Database; repoId: number; jobId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const first = openDb({ ...loadConfig(), dataDir: dir });
  const uid = upsertUser(first, `ya-${prefix}`, prefix);
  const repoId = Number(
    first.query("INSERT INTO repos (org_slug, repo_slug, visibility, last_activity_at) VALUES ('legacy', 'row', 'public', '2026-09-01T00:00:00Z')").run().lastInsertRowid,
  );
  // строка старого вида: колонка trigger_kind досталась ей от DEFAULT миграции
  const jobId = Number(
    first
      .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, ?, ?, 'periodic', '2026-09-01T00:00:00Z')")
      .run(repoId, status, uid).lastInsertRowid,
  );
  // бэкфилл — одноразовая миграция при переходе версии, а не работа каждого
  // openDb. Фикстура обязана быть ДОВЕРСИОННОЙ: 1.7 — историческая версия,
  // при которой такие строки и появлялись (это не копия текущей константы,
  // а точка отсчёта миграции)
  setMetaValue(first, "schema_version", "1.7");
  first.close();
  // второй openDb = миграция на новом коде: бэкфилл обязан привести признак в порядок
  const db = openDb({ ...loadConfig(), dataDir: dir });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, repoId, jobId, dir };
}

describe("П11 (Н-2): миграция бэкфиллит trigger_kind — предикаты полосы согласованы на старых БД", () => {
  test("живая legacy-юзерская job не читается как периодическая и не блокирует периодику по своему репо", async () => {
    const { db, repoId, jobId } = legacyJobDb("rh-m42-p11a-", "queued");
    const kind = (db.query("SELECT trigger_kind FROM jobs WHERE id = ?").get(jobId) as { trigger_kind: string }).trigger_kind;
    // каталог отдаёт другую дату активности → «изменившийся» репо, периодика должна встать
    const out = await scheduler.nightlyCatalog(db, catalogClient(catalogPage("legacy", "row", "2026-09-17T00:00:00Z")), { now: new Date() });
    const periodic = (
      db.query("SELECT COUNT(*) AS c FROM jobs WHERE repo_id = ? AND trigger_kind = 'periodic' AND user_id IS NULL AND status = 'queued'").get(repoId) as { c: number }
    ).c;
    expect({ kind, reasons: out.enqueued.map((e) => e.reason), periodic }).toEqual({ kind: "user", reasons: ["changed"], periodic: 1 });
  });

  test("завершённая legacy-юзерская job не читается как последняя периодическая (retry-failed)", async () => {
    const { db } = legacyJobDb("rh-m42-p11b-", "failed");
    // каталог не менялся: единственная причина перескана была бы retry-failed
    // по legacy-строке, прочитанной как «последняя периодическая»
    const out = await scheduler.nightlyCatalog(db, catalogClient(catalogPage("legacy", "row", "2026-09-01T00:00:00Z")), { now: new Date() });
    expect(out.enqueued.map((e) => e.reason)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `tree.stats` — публичный факт (PUBLIC_KINDS): он кормит и плотность Security,
// и публичные derived. Если канальный факт вытесняет публичный, публичная
// половина карточки начинает зависеть от прав зрителя, а она строится из
// одного скана для всех. Поэтому канальное дерево едет своим ключом.
// ---------------------------------------------------------------------------

const DENIED = { cicd: "denied", appsec: "denied", repo: "denied" } as const;

/** Репо, у которого tree.stats скана P и канального скана оба ok и РАЗНЫЕ. */
function twoTreesRepo(prefix: string): { t: ApiTestDb; secScan: number } {
  const t = tempDb(prefix);
  const repoId = seedRepo(t, { org: "twotrees", repo: "repo", language: "Go" });
  const secScan = seedScan(t, repoId, {
    startedAt: "2026-09-10T00:00:00Z",
    status: "ok",
    ratingEligible: false,
    facts: [
      { key: "appsec.findings", source: "appsec:api", value: { severity_counts: { critical: 0, high: 2, medium: 4, low: 6 }, resolved_share: 0.5, secrets_critical: false } },
      { key: "tree.stats", source: "git", value: { top_level: [{ name: "src", type: "tree" }], file_count: 42, bytes: 900_000, loc: 20_000 } },
    ],
  });
  // скан P: tree.stats собран ok, но ДРУГОЙ (loc 5000 из cardFacts)
  const pScan = seedScan(t, repoId, { startedAt: "2026-09-16T00:00:00Z", status: "ok", ratingEligible: true, facts: cardFacts() });
  seedScore(t, repoId, pScan, { total: 60 });
  return { t, secScan };
}

describe("П13 (Н-4): публичный tree.stats не вытесняется канальным — публичная половина карточки одна для всех", () => {
  test("оба скана ok и значения разные: публичный tree.stats идентичен для зрителя с правами и без", () => {
    const { t } = twoTreesRepo("rh-m42-p13a-");
    const open = getRepoCard(t.db, "twotrees", "repo", { access: { ...GRANTED } })!;
    const closed = getRepoCard(t.db, "twotrees", "repo", { access: { ...DENIED } })!;
    const publicTree = (card: typeof open) => {
      const rows = card.evidence.filter((e) => e.key === "tree.stats");
      return {
        count: rows.length,
        loc: (rows[0]?.value as { loc?: unknown } | undefined)?.loc ?? null,
        status: rows[0]?.status ?? null,
        collectedAt: rows[0]?.collectedAt ?? null,
      };
    };
    expect({
      open: publicTree(open),
      closed: publicTree(closed),
      // канальный ключ — только зрителю с правами на Security
      channelKeyOpen: open.evidence.filter((e) => e.key === CHANNEL_TREE_KEY).length,
      channelKeyClosed: closed.evidence.filter((e) => e.key === CHANNEL_TREE_KEY).length,
      channelLoc: (open.evidence.find((e) => e.key === CHANNEL_TREE_KEY)?.value as { loc?: unknown } | undefined)?.loc ?? null,
    }).toEqual({
      open: { count: 1, loc: 5_000, status: "ok", collectedAt: "2026-09-16T00:00:00Z" },
      closed: { count: 1, loc: 5_000, status: "ok", collectedAt: "2026-09-16T00:00:00Z" },
      channelKeyOpen: 1,
      channelKeyClosed: 0,
      channelLoc: 20_000,
    });
  });

  test("плотность Security доказывается канальным ключом: его collectedAt — скана, давшего число", () => {
    const { t } = twoTreesRepo("rh-m42-p13b-");
    const card = getRepoCard(t.db, "twotrees", "repo", { access: { ...GRANTED } })!;
    const density = card.score!.categories.security.submetrics.density as { value: number | null } | undefined;
    const channelTree = card.evidence.find((e) => e.key === CHANNEL_TREE_KEY);
    const appsec = card.evidence.find((e) => e.key === "appsec.findings");
    expect({
      // SEVERITY_WEIGHTS: 0*8 + 2*4 + 4*2 + 6*1 = 22 на 20 000 LOC → 11 на 10k LOC
      density: typeof density?.value === "number" ? Math.round(density.value * 1000) / 1000 : null,
      channelStatus: channelTree?.status ?? null,
      channelCategory: channelTree?.category ?? null,
      sameScanAsNumber: channelTree !== undefined && appsec !== undefined && channelTree.collectedAt === appsec.collectedAt,
      collectedAt: channelTree?.collectedAt ?? null,
    }).toEqual({ density: 11, channelStatus: "ok", channelCategory: "code", sameScanAsNumber: true, collectedAt: "2026-09-10T00:00:00Z" });
  });
});

// ---------------------------------------------------------------------------
// Кабинет через HTTP настоящего сервера: избранное, checkFavoriteAccess и
// listMyRepos.
// ---------------------------------------------------------------------------

const SECRET = "m42port-repro-secret-0123456789abcdef";
const httpDir = mkdtempSync(join(tmpdir(), "rh-m42-http-"));

// Мок платформы: repo-GET БЕЗ поля `id` (иначе клиент без `baseUrl` ушёл бы
// в боевой AppSec с PAT зрителя), visibility private → «свой» репозиторий.
const mock = startMockApi((req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "favuser" });
  if (/^\/repos\/[^/]+\/[^/]+\/cicd\/runs$/.test(p)) return Response.json({ runs: [] });
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repo) return Response.json({ name: repo[2], visibility: "private" });
  return null;
});

let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
let probe: Database | null = null;

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: httpDir });
  const t: ApiTestDb = { db, close: () => db.close() };
  for (const name of ["fav", "own", "peek"]) {
    ids[name] = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, ids[name]!);
  }
  // --- свои репо без namespace-выдачи (PAT у «own» нет) ---
  // публичный репо со своим сканом и заявкой (источник own-scan)
  const pub = seedRepo(t, { org: "own", repo: "pub", title: "Мой публичный", language: "Go" });
  seedScore(t, pub, seedScan(t, pub, { facts: cardFacts(), userId: ids.own!, ratingEligible: true }), { total: 71 });
  db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, 'done', ?, 'user', '2026-09-17T00:00:00Z')").run(pub, ids.own!);
  // приватный репо владельца: в списке только через избранное, права — по own-скану
  const priv = seedRepo(t, { org: "own", repo: "priv", title: "Мой приватный", language: "Rust" });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
  seedScore(t, priv, seedScan(t, priv, { facts: cardFacts(), userId: ids.own!, ratingEligible: true }), { total: 64 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'own', 'priv', '2026-09-17T00:00:00Z')").run(ids.own!);
  // --- посторонний добавил в избранное чужой приватный слаг ---
  const secret = seedRepo(t, { org: "secret", repo: "repo", title: "Секретный проект", language: "Kotlin", lastActivityAt: "2026-09-12T00:00:00Z" });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(secret);
  seedScore(t, secret, seedScan(t, secret, { facts: cardFacts(), userId: null, ratingEligible: true }), { total: 88 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'secret', 'repo', '2026-09-17T00:00:00Z')").run(ids.peek!);
  // --- публичный репо, ВЫТЕСНЕННЫЙ из рейтинга. `evictRepo` ставит
  // rating_active = 0 и не трогает visibility; карточка и MD отдают такому
  // репо 404 всем, поэтому признак прав не может смотреть только на visibility
  const evicted = seedRepo(t, { org: "evicted", repo: "pub", title: "Вытесненный", language: "Go", lastActivityAt: "2026-08-01T00:00:00Z" });
  db.query("UPDATE repos SET rating_active = 0, evict_reason = 'gone' WHERE id = ?").run(evicted);
  // скан авторства «own» — у владельца права доказаны own-сканом и остаются
  seedScore(t, evicted, seedScan(t, evicted, { facts: cardFacts(), userId: ids.own!, ratingEligible: true, startedAt: "2026-08-02T00:00:00Z" }), { total: 55 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'evicted', 'pub', '2026-09-17T00:00:00Z')").run(ids.peek!);
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'evicted', 'pub', '2026-09-17T00:00:00Z')").run(ids.own!);
  // --- восемь своих избранных у пользователя с PAT (строки repos есть:
  // иначе портовый колбэк отсеет их до капов и обход капа не воспроизведётся) ---
  for (let i = 1; i <= 8; i++) {
    const r = seedRepo(t, { org: "fav", repo: `f${i}` });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(r);
    db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'fav', ?, '2026-09-17T00:00:00Z')").run(ids.fav!, `f${i}`);
  }
  db.close();
  server = await spawnServer({
    dataDir: httpDir,
    mock,
    appSecret: SECRET,
    env: {
      // роль rating: HTTP работает, но юзерскую полосу никто не разбирает —
      // «активных юзерских job» замеряется без гонки с циклом разбора очереди
      PROCESS_ROLE: "rating",
      QUEUE_USER_ACTIVE_MAX: "2",
      QUEUE_USER_SCANS_PER_HOUR: "50",
      // лимит частоты эндпоинта поднят через env: иначе вызовы 7–8 получат
      // 429 до проверки прав (так же в routes-me.test.ts)
      QUEUE_FAVORITE_CHECKS_PER_MINUTE: "100",
    },
  });
  probe = new Database(join(httpDir, "repo-health.db"));
}, 60_000);

afterAll(async () => {
  probe?.close();
  if (server) await server.stop();
  mock.stop();
  rmSync(httpDir, { recursive: true, force: true });
});

const as = (name: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers ?? {}), cookie: `${SESSION_COOKIE}=${cookies[name]}` } });
const at = (path: string) => `${server!.base}${path}`;

interface CheckBody {
  access?: { clone?: boolean; own?: boolean } | null;
  enqueue?: { status?: string; code?: string | null };
}

interface MyReposBody {
  // кабинет показывает только избранное — поля `sources` нет
  entries: { org: string; repo: string; title: string | null; language: string | null; lastScanAt: string | null; healthcraftIndex: number | null }[];
}

// Постановку ЦЕЛИКОМ через requestUserScan (капы, «отказ по капу не роняет
// права») делает автопроверка при явном добавлении в избранное (звезда,
// `PUT /api/me/favorites/:org/:repo`); исход проверки — в поле `check`.
describe("П2 (Н1): проверка избранного ставит сканы через requestUserScan — со всеми капами", () => {
  test("8 своих избранных → активных юзерских job ровно userActiveMax, остальные — enqueue.refused/too_many_active", async () => {
    const put = await fetch(at("/api/me/pat"), as("fav", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "pat-fav-000000000" }) }));
    expect(put.status).toBe(200);
    const outcomes: CheckBody[] = [];
    for (let i = 1; i <= 8; i++) {
      const res = await fetch(at(`/api/me/favorites/fav/f${i}`), as("fav", { method: "PUT" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access?: CheckBody["access"]; check?: { enqueue?: CheckBody["enqueue"] } };
      outcomes.push({ access: body.access, enqueue: body.check?.enqueue ?? undefined });
    }
    const active = (probe!.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued','running')").get(ids.fav!) as { c: number }).c;
    expect({
      statuses: outcomes.map((o) => o.enqueue?.status ?? null),
      codes: outcomes.slice(2).map((o) => o.enqueue?.code ?? null),
      // отказ по капу НЕ роняет проверку прав — её результат зритель видит всё равно
      accessKept: outcomes.every((o) => o.access?.clone === true),
      activeUserJobs: active,
    }).toEqual({
      statuses: ["queued", "queued", "refused", "refused", "refused", "refused", "refused", "refused"],
      codes: ["too_many_active", "too_many_active", "too_many_active", "too_many_active", "too_many_active", "too_many_active"],
      accessKept: true,
      activeUserJobs: 2,
    });
  }, 60_000);
});

describe("П4 (MAJOR №1): listMyRepos считает score правилом круга 2", () => {
  // кабинет показывает только избранное — запись own/pub (свой скан без
  // звезды) в список не попадает; «число, а не null» для записи с правами
  // проверяется на избранном приватном (права — own-скан)
  test("без PAT: своё избранное приватное отдаёт число, а не null; union-запись больше не показывается", async () => {
    const res = await fetch(at("/api/me/repos"), as("own"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const priv = body.entries.find((e) => e.org === "own" && e.repo === "priv");
    expect({
      privScore: priv?.healthcraftIndex ?? null,
      unionGone: body.entries.some((e) => e.org === "own" && e.repo === "pub"),
    }).toEqual({ privScore: 64, unionGone: false });
  }, 30_000);
});

describe("П6 (С4): мета репо не отдаётся зрителю без прав", () => {
  test("посторонний добавил приватный слаг в избранное → ни названия, ни языка, ни времени скана, score === null", async () => {
    const res = await fetch(at("/api/me/repos"), as("peek"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const entry = body.entries.find((e) => e.org === "secret" && e.repo === "repo");
    expect(entry).toBeDefined();
    expect({
      title: entry!.title,
      language: entry!.language,
      lastScanAt: entry!.lastScanAt,
      healthcraftIndex: entry!.healthcraftIndex,
    }).toEqual({ title: null, language: null, lastScanAt: null, healthcraftIndex: null });
  }, 30_000);
});

describe("П10 (Н-1, круг 2): признак прав читает пару visibility + rating_active", () => {
  test("эвиктированный публичный репо в избранном постороннего: ни меты, ни Score", async () => {
    const res = await fetch(at("/api/me/repos"), as("peek"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const entry = body.entries.find((e) => e.org === "evicted" && e.repo === "pub");
    expect(entry).toBeDefined();
    expect({
      title: entry!.title,
      language: entry!.language,
      lastScanAt: entry!.lastScanAt,
      healthcraftIndex: entry!.healthcraftIndex,
    }).toEqual({ title: null, language: null, lastScanAt: null, healthcraftIndex: null });
  }, 30_000);

  // права строки кабинета = права карточки. Выбывший из рейтинга публичный
  // репозиторий карточка и MD отдают 404 ВСЕМ, включая автора своего скана, —
  // значит, строка кабинета не раскрывает его и автору (иначе строка показала
  // бы мету и оценку, а по клику открылся бы 404). Для НЕ выбывшего репо
  // own-скан доказывает права (tests/v485-access.test.ts)
  test("тот же репо владельцу (own-скан): выбывший не раскрывается и ему — строка равна карточке (404)", async () => {
    const res = await fetch(at("/api/me/repos"), as("own"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const entry = body.entries.find((e) => e.org === "evicted" && e.repo === "pub");
    expect(entry).toBeDefined();
    expect({ title: entry!.title, language: entry!.language, healthcraftIndex: entry!.healthcraftIndex, mayRead: (entry as { mayRead?: boolean }).mayRead }).toEqual({
      title: null,
      language: null,
      healthcraftIndex: null,
      mayRead: false,
    });
    const card = await fetch(at("/api/repos/evicted/pub"), as("own"));
    expect(card.status).toBe(404);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима. Без неё «AUDIT_STRICT=1 зелёный» — тавтология:
// набор зелён и в обычном режиме, потому что неисправленные дефекты стоят под
// `test.failing`. Строгий прогон утверждает, что в файле не осталось НИ ОДНОГО
// теста под обёрткой, — зелёный означает «исправлено», а не «помечено».
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
