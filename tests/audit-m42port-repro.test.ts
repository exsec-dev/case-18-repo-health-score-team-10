// audit-m42port-repro.test.ts — воспроизведение регрессий портов
// hq-parallel (слияние `fdeb923`), найденных аудит-парой круга 2 В4.1-fix
// (reports/2026-09-17-m41fix-r2-audit-pair.md). Закон вехи В4.2-port-fix —
// reports/2026-09-17-fix-plan.md ревизия 4, Часть 2 «В4.2-port-fix = П» и
// Часть 3 «К-П». Круг 1 — позиции П1, П2, П4, П5, П6, П9; круг 2 (Б8, после
// reports/2026-09-18-m42port-audit-pair.md) — П10, П11, П13. Каждый тест
// описывает ПРАВИЛЬНОЕ поведение и ассертит конкретное значение.
//
// На Б0-коммите тесты стоят под обёрткой `repro` (в строгом режиме — красные);
// она снимается в блоке, закрывшем находку, сами утверждения при этом не
// меняются. Строгий режим — для команды приёмки:
// AUDIT_STRICT=1 bun test tests/audit-m42port-repro.test.ts
//
// Живых запросов нет: временный DATA_DIR, SOURCECRAFT_TOKEN="" (задаёт
// харнесс), все адреса API — локальный мок. Мок repo-GET НЕ отдаёт `id`:
// на неисправленном коде `makeAppsecClient` строится без `baseUrl`, и
// запрос ушёл бы с PAT на боевой appsec.sourcecraft.tech (П3/Н2).
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

// Обёртка строгого режима (Т1, круг 2). Тест, стоящий под `repro`, —
// ПРИПАРКОВАННАЯ находка: в обычном режиме `test.failing` (набор зелёный,
// красноты в CI нет), под `AUDIT_STRICT=1` — обычный `test`, то есть
// красный, пока находка не закрыта. Когда блок её закрывает, тест
// переводится в обычный `test` (иначе `test.failing` упал бы на «прошёл»).
// Круг 1 держал константу с `void repro` — обёртка была декоративной, и
// «AUDIT_STRICT=1 зелёный» не значил ничего сверх обычного прогона; круг 2
// исполняет её по-настоящему (Б8) и добавляет самопроверку строгого режима
// в конце файла.
const repro = process.env.AUDIT_STRICT ? test : test.failing;

/**
 * Ключ канального дерева в `evidence` (П13). Литерал повторён здесь намеренно:
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
// П1 (К1 CRITICAL). Справедливость между полосами очереди.
// ---------------------------------------------------------------------------

describe("П1 (К1): роль all — полоса rating не голодает при непустой полосе user", () => {
  test("6 вызовов claimAny(['user','rating']) при непустых обеих полосах дают ≥ 2 периодических", () => {
    const t = tempDb("rh-m42-p1-");
    const db = t.db;
    // курсор round-robin модульный — тесты обязаны быть герметичны (К-П П1)
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
    // ассерт «≥ 2 из 6» устойчив к чётности курсора; точный порядок ассертить запрещено (К-П П1)
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
// П5 (С2 r2). Гард дубля периодики в ночном обходе.
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
// П9 (С1 r2). Плотность Security доказывается tree.stats СВОЕГО скана.
// ---------------------------------------------------------------------------

const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;

describe("П9 (С1 r2): число плотности Security и tree.stats в доказательствах — из одного скана", () => {
  // Форму доказательства поправил круг 2 (П13, решение владельца (1) 18.09):
  // канальное дерево едет СВОИМ ключом, публичный `tree.stats` скана P не
  // вытесняется. Утверждение позиции П9 то же — число плотности и факт, из
  // которого оно посчитано, из одного скана; изменился ключ, под которым
  // канальный факт лежит в evidence.
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
      // публичный факт скана P остаётся на месте и своим статусом (П13)
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
// КРУГ 2. П11 (Н-2 MAJOR). Бэкфилл `trigger_kind` при миграции: у строк,
// созданных ДО появления колонки, `user_id IS NOT NULL` соседствует с
// `trigger_kind = 'periodic'` (ensureColumn поставил DEFAULT). Круг 1 поставил
// на эквивалентность «trigger_kind != 'user' ⇔ user_id IS NULL» два предиката
// полосы — гард П5 и retry-failed; для legacy-строк она неверна.
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
  // Ф2.18 (В4.2a): бэкфилл — одноразовая миграция при переходе версии, а не
  // работа каждого openDb. Фикстура обязана быть ДОВЕРСИОННОЙ: 1.7 —
  // историческая версия, при которой такие строки и появлялись (это не копия
  // текущей константы, а точка отсчёта миграции)
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
// КРУГ 2. П13 (Н-4 MAJOR). `tree.stats` — публичный факт (PUBLIC_KINDS): он
// кормит и плотность Security, и публичные derived. Круг 1 (П9) вытеснил
// публичный факт канальным — публичная половина карточки стала зависеть от
// прав зрителя, хотя К-Ф1.1 требует одного скана для всех. Канальное дерево
// едет своим ключом; публичный `tree.stats` не трогается.
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
// П2 (Н1 HIGH), П4 (MAJOR №1), П6 (С4) — через HTTP настоящего сервера.
// Портовая поверхность (favorites / checkFavoriteAccess / merge-ветка
// listMyRepos) не покрыта тестами вовсе — фикстура пишется с нуля.
// ---------------------------------------------------------------------------

const SECRET = "m42port-repro-secret-0123456789abcdef";
const httpDir = mkdtempSync(join(tmpdir(), "rh-m42-http-"));

// Мок платформы: repo-GET БЕЗ поля `id` (иначе неисправленный код ушёл бы
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
  // --- П4: свои репо без namespace-выдачи (PAT у «own» нет) ---
  // публичный репо со своим сканом и заявкой (источник own-scan)
  const pub = seedRepo(t, { org: "own", repo: "pub", title: "Мой публичный", language: "Go" });
  seedScore(t, pub, seedScan(t, pub, { facts: cardFacts(), userId: ids.own!, ratingEligible: true }), { total: 71 });
  db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, 'done', ?, 'user', '2026-09-17T00:00:00Z')").run(pub, ids.own!);
  // приватный репо владельца: в списке только через избранное, права — по own-скану
  const priv = seedRepo(t, { org: "own", repo: "priv", title: "Мой приватный", language: "Rust" });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
  seedScore(t, priv, seedScan(t, priv, { facts: cardFacts(), userId: ids.own!, ratingEligible: true }), { total: 64 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'own', 'priv', '2026-09-17T00:00:00Z')").run(ids.own!);
  // --- П6: посторонний добавил в избранное чужой приватный слаг ---
  const secret = seedRepo(t, { org: "secret", repo: "repo", title: "Секретный проект", language: "Kotlin", lastActivityAt: "2026-09-12T00:00:00Z" });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(secret);
  seedScore(t, secret, seedScan(t, secret, { facts: cardFacts(), userId: null, ratingEligible: true }), { total: 88 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'secret', 'repo', '2026-09-17T00:00:00Z')").run(ids.peek!);
  // --- П10 (круг 2): публичный репо, ВЫТЕСНЕННЫЙ из рейтинга. `evictRepo`
  // ставит rating_active = 0 и не трогает visibility; карточка и MD отдают
  // такому репо 404 всем, а признак прав круга 1 смотрел только на visibility
  const evicted = seedRepo(t, { org: "evicted", repo: "pub", title: "Вытесненный", language: "Go", lastActivityAt: "2026-08-01T00:00:00Z" });
  db.query("UPDATE repos SET rating_active = 0, evict_reason = 'gone' WHERE id = ?").run(evicted);
  // скан авторства «own» — у владельца права доказаны own-сканом и остаются
  seedScore(t, evicted, seedScan(t, evicted, { facts: cardFacts(), userId: ids.own!, ratingEligible: true, startedAt: "2026-08-02T00:00:00Z" }), { total: 55 });
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'evicted', 'pub', '2026-09-17T00:00:00Z')").run(ids.peek!);
  db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'evicted', 'pub', '2026-09-17T00:00:00Z')").run(ids.own!);
  // --- П2: восемь своих избранных у пользователя с PAT (строки repos есть:
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
      // «активных юзерских job» замеряется без гонки с воркер-лупом
      PROCESS_ROLE: "rating",
      QUEUE_USER_ACTIVE_MAX: "2",
      QUEUE_USER_SCANS_PER_HOUR: "50",
      // лимит частоты эндпоинта поднят через env: иначе вызовы 7–8 получат
      // 429 до проверки прав (прецедент routes-me.test.ts:54)
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
  // Ф2.20 (решение 18.09): кабинет favorites-only — поле `sources` удалено
  entries: { org: string; repo: string; title: string | null; language: string | null; lastScanAt: string | null; healthcraftIndex: number | null }[];
}

// ПЕРЕНОС (В4.8.5, К8.5.14 (г), §2-В1): маршрута «Проверить доступ» (`/check`)
// больше нет — тот же инвариант (постановка ЦЕЛИКОМ через requestUserScan,
// капы, «отказ по капу не роняет права») держит автопроверка при явном
// добавлении в избранное (звезда, `PUT /api/me/favorites/:org/:repo`);
// утверждения прежние, меняется только путь и форма ответа (исход — в `check`)
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
  // Ф2.20 (решение 18.09): кабинет favorites-only — union-запись own/pub
  // (источник own-scan) из списка ушла; контракт П4 «число, а не null» для
  // записи с правами проверяется на избранном приватном (права — own-скан)
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

  // вторая половина контракта П10 («остальные два дизъюнкта не трогаются»)
  // зелена и до исправления — это охрана от пере-затягивания признака, не репро.
  // ПЕРЕВОРОТ (В4.8.5, К8.5.9, С6-2 — строже, не слабее): «права строки = права
  // карточки». Выбывший из рейтинга публичный репозиторий карточка и MD отдают
  // 404 ВСЕМ, включая автора своего скана, — строка кабинета его больше не
  // раскрывает и автору (раньше строка показывала мету и оценку, а по клику
  // открывался 404). Для НЕ выбывшего репо own-скан по-прежнему доказывает права
  // (tests/v485-access.test.ts)
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
// Т1 (круг 2). Самопроверка строгого режима. Без неё «AUDIT_STRICT=1 зелёный»
// — тавтология: набор зелён и в обычном режиме, потому что незакрытые находки
// стоят под `test.failing`. Здесь строгий прогон утверждает то, ради чего его
// запускают: в файле не осталось НИ ОДНОЙ находки, припаркованной под
// обёрткой, — значит зелёный означает «закрыто», а не «помечено красным».
// На Б0-коммите этот тест красный вместе с самими репро-тестами.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
