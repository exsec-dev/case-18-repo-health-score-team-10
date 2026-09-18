// audit-m42port-repro.test.ts — воспроизведение регрессий портов
// hq-parallel (слияние `fdeb923`), найденных аудит-парой круга 2 В4.1-fix
// (reports/2026-09-17-m41fix-r2-audit-pair.md). Закон вехи В4.2-port-fix —
// reports/2026-09-17-fix-plan.md ревизия 4, Часть 2 «В4.2-port-fix = П» и
// Часть 3 «К-П». Покрыты позиции П1, П2, П4, П5, П6, П9: каждый тест
// описывает ПРАВИЛЬНОЕ поведение и ассертит конкретное значение.
//
// Блок Б0: все тесты под `test.failing` (красные по существу в строгом
// режиме); пометка снимается в Б7, утверждения не меняются. Строгий режим
// для команды приёмки: AUDIT_STRICT=1 bun test tests/audit-m42port-repro.test.ts
//
// Живых запросов нет: временный DATA_DIR, SOURCECRAFT_TOKEN="" (задаёт
// харнесс), все адреса API — локальный мок. Мок repo-GET НЕ отдаёт `id`:
// на неисправленном коде `makeAppsecClient` строится без `baseUrl`, и
// запрос ушёл бы с PAT на боевой appsec.sourcecraft.tech (П3/Н2).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { getRepoCard } from "../src/api/repos";
import type { ScClient, ScResponse } from "../src/collectors/http";
import * as scheduler from "../src/jobs/scheduler";
import { cardFacts, seedRepo, seedScan, seedScore, type ApiTestDb, type FactSpec } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

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
  repro("6 вызовов claimAny(['user','rating']) при непустых обеих полосах дают ≥ 2 периодических", () => {
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

  repro("пустая полоса user — все 6 вызовов берут периодику (курсор не теряет прогресс)", () => {
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
  repro("непригодный последний периодический скан — retry-ineligible не дублируется, пока job жива", async () => {
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
  repro("канальный скан с ok tree.stats(loc=20000) — его же tree.stats в evidence, не вырезанный фильтром", () => {
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
    const tree = card.evidence.filter((e) => e.key === "tree.stats");
    const appsec = card.evidence.find((e) => e.key === "appsec.findings");
    expect({
      densityValue: typeof density?.value === "number" ? Math.round(density!.value! * 1000) / 1000 : density?.value ?? null,
      treeCount: tree.length,
      treeStatus: tree[0]?.status ?? null,
      treeLoc: (tree[0]?.value as { loc?: unknown } | undefined)?.loc ?? null,
      appsecPresent: appsec !== undefined,
      sameScan: appsec !== undefined && tree[0] !== undefined && appsec.collectedAt === tree[0].collectedAt,
    }).toEqual({
      // SEVERITY_WEIGHTS: 0*8 + 2*4 + 4*2 + 6*1 = 22 на 20 000 LOC → 11 на 10k LOC
      densityValue: 11,
      treeCount: 1,
      treeStatus: "ok",
      treeLoc: 20_000,
      appsecPresent: true,
      sameScan: true,
    });
    // ни одна ссылка показанного правила на факт канала не «повисает»
    const dangling = card.recommendations.flatMap((r) => r.factRefs).filter((ref) => ref.missing && (ref.key === "tree.stats" || ref.key === "appsec.findings"));
    expect(dangling).toEqual([]);
    expect(secScan).toBeGreaterThan(0);
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
  entries: { org: string; repo: string; title: string | null; language: string | null; lastScanAt: string | null; score: number | null; sources: string[] }[];
}

describe("П2 (Н1): проверка избранного ставит сканы через requestUserScan — со всеми капами", () => {
  repro("8 своих избранных → активных юзерских job ровно userActiveMax, остальные — enqueue.refused/too_many_active", async () => {
    const put = await fetch(at("/api/me/pat"), as("fav", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "pat-fav-000000000" }) }));
    expect(put.status).toBe(200);
    const outcomes: CheckBody[] = [];
    for (let i = 1; i <= 8; i++) {
      const res = await fetch(at(`/api/me/favorites/fav/f${i}/check`), as("fav", { method: "POST" }));
      expect(res.status).toBe(200);
      outcomes.push((await res.json()) as CheckBody);
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

describe("П4 (MAJOR №1): merge-ветка listMyRepos считает score правилом круга 2", () => {
  repro("без PAT: свой публичный репо (own-scan) и своё избранное приватное отдают число, а не null", async () => {
    const res = await fetch(at("/api/me/repos"), as("own"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const pub = body.entries.find((e) => e.org === "own" && e.repo === "pub");
    const priv = body.entries.find((e) => e.org === "own" && e.repo === "priv");
    expect({
      pubScore: pub?.score ?? null,
      pubSources: pub?.sources ?? [],
      privScore: priv?.score ?? null,
      privSources: priv?.sources ?? [],
    }).toEqual({ pubScore: 71, pubSources: ["own-scan"], privScore: 64, privSources: ["favorite"] });
  }, 30_000);
});

describe("П6 (С4): мета репо не отдаётся зрителю без прав", () => {
  repro("посторонний добавил приватный слаг в избранное → ни названия, ни языка, ни времени скана, score === null", async () => {
    const res = await fetch(at("/api/me/repos"), as("peek"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyReposBody;
    const entry = body.entries.find((e) => e.org === "secret" && e.repo === "repo");
    expect(entry).toBeDefined();
    expect({
      title: entry!.title,
      language: entry!.language,
      lastScanAt: entry!.lastScanAt,
      score: entry!.score,
      sources: entry!.sources,
    }).toEqual({ title: null, language: null, lastScanAt: null, score: null, sources: ["favorite"] });
  }, 30_000);
});
