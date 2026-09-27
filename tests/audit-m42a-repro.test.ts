// Репро-тесты на найденные аудитом дефекты: ложный `code_empty` в `compute`,
// неполный обход каталога и корректность AppSec.
// Живых запросов нет: каталог и AppSec — фейковые клиенты по фикстурам,
// compute — временная БД во временном каталоге.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCAN } from "../src/config";
import { enumerateCatalog } from "../src/collectors/catalog";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { collectAppsec, type AppsecClient, type AppsecGet } from "../src/collectors/appsec";
import { compute } from "../src/score/compute";
import { healthyFacts, makeDb, seedScan, withFacts, type TestDb } from "./score-fixtures";

// Обертка репро: в обычном прогоне — `test.failing` (набор зеленый, пока
// дефект жив), под AUDIT_STRICT=1 — обычный `test`, красный до исправления.
const repro = process.env.AUDIT_STRICT ? test : test.failing;

const dbs: TestDb[] = [];
afterAll(() => {
  for (const t of dbs.reverse()) t.close();
});

function tempDb(): TestDb {
  const t = makeDb();
  dbs.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// Ложный `code_empty` дает жесткий Score 0 при живом коде.
// Контракт: `code_empty` только при `tree.stats.file_count === 0`.
// ---------------------------------------------------------------------------

describe("Ф2.3 (M5): code_empty — только по file_count, не по loc", () => {
  test("tree.stats {file_count: 5, loc: 0} → codeEmpty=false и Score не занулён", () => {
    const t = tempDb();
    const facts = withFacts(healthyFacts(), {
      key: "tree.stats",
      value: { top_level: [{ name: "src", type: "tree" }], file_count: 5, bytes: 4096, loc: 0 },
    });
    const scanId = seedScan(t, facts);
    const scores = compute(t.db, scanId);
    expect({ codeEmpty: scores.codeEmpty, ratingIsZero: scores.healthcraftIndex === 0 }).toEqual({
      codeEmpty: false,
      ratingIsZero: false,
    });
  });

  test("настоящее без-кодовое репо (file_count = 0) остаётся code_empty со Score 0", () => {
    const t = tempDb();
    const facts = withFacts(healthyFacts(), {
      key: "tree.stats",
      value: { top_level: [], file_count: 0, bytes: 0, loc: 0 },
    });
    const scanId = seedScan(t, facts);
    const scores = compute(t.db, scanId);
    expect({ codeEmpty: scores.codeEmpty, healthcraftIndex: scores.healthcraftIndex }).toEqual({ codeEmpty: true, healthcraftIndex: 0 });
  });
});

// ---------------------------------------------------------------------------
// Полный каталог: page_size=100, sort_by=created_at, потолок страниц —
// предохранитель (1000), 200 без массива repositories = сбой.
// ---------------------------------------------------------------------------

/** Фейковый клиент каталога: отдаёт заготовленные ответы, пишет пути. */
function fakeCatalogClient(responses: ScResponse[], paths: string[]): ScClient {
  let i = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      paths.push(path);
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
    requestCount: () => i,
  };
}

const okPage = (json: unknown): ScResponse => ({ status: 200, json, bodyText: JSON.stringify(json) });

describe("Ф2.5 (M7): полный каталог 27 446 репо", () => {
  test("обход просит page_size=100 и sort_by=created_at (275 запросов вместо 1373)", async () => {
    const paths: string[] = [];
    const client = fakeCatalogClient([okPage({ repositories: [{ organization: { slug: "o" }, slug: "r", visibility: "public" }] })], paths);
    await enumerateCatalog(client);
    const first = new URL(`http://x${paths[0]}`).searchParams;
    expect({ pageSize: first.get("page_size"), sortBy: first.get("sort_by") }).toEqual({
      pageSize: "100",
      sortBy: "created_at",
    });
  });

  test("потолок страниц — предохранитель: дефолт 1000 (27 446 репо = 275 страниц)", () => {
    expect(DEFAULT_SCAN.catalog.maxPages).toBe(1000);
  });

  test("200 без массива repositories = сбой канала, а не дочитанный пустой каталог", async () => {
    const paths: string[] = [];
    const client = fakeCatalogClient([okPage({ items: [], next_page_token: "" })], paths);
    const res = await enumerateCatalog(client);
    expect({ ok: res.ok, truncated: res.truncated, entries: res.entries.length }).toEqual({
      ok: false,
      truncated: true,
      entries: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Корректность AppSec: завершенность скана = timeFinished И isLatest;
// secrets_critical — фильтром type=SECRETS платформы.
// ---------------------------------------------------------------------------

const FIX = join(import.meta.dir, "fixtures/appsec");
const loadFixture = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIX, name), "utf8"));

function fakeRest(repoId: string): ScClient {
  return {
    async get(path: string): Promise<ScResponse> {
      if (path.startsWith("/repos/")) return { status: 200, json: { id: repoId }, bodyText: "" };
      return { status: 404, json: null, bodyText: "" };
    },
    requestCount: () => 1,
  };
}

/**
 * AppSec-фейк: severity-корзины и корзина `type=SECRETS`. Имена движков НЕ
 * содержат подстроки «secret» — живые движки платформы зовутся KICS/Opengrep,
 * и регулярка `/secret/i` по имени движка их не ловит.
 */
function fakeAppsec(opts: { scansLatest: unknown; criticalTotal: number; secretsTotal: number }, log: string[]): AppsecClient {
  return {
    async get(path: string, params: Record<string, string>): Promise<AppsecGet> {
      log.push(`${path}?${new URLSearchParams(params).toString()}`);
      if (path === "/v1/scans/latest") return { status: 200, json: opts.scansLatest };
      if (path === "/v1/defect-groups") {
        const severity = params["severity"];
        const type = params["type"];
        if (type === "SECRETS") return { status: 200, json: { data: [], nextPageToken: "", totalSize: opts.secretsTotal } };
        if (severity !== undefined) {
          const total = severity === "CRITICAL" ? opts.criticalTotal : 0;
          const data = severity === "CRITICAL" ? Array.from({ length: total }, (_, i) => ({ engine: "KICS", publicId: i + 1 })) : [];
          return { status: 200, json: { data, nextPageToken: "", totalSize: total } };
        }
        return { status: 200, json: { data: [], nextPageToken: "", totalSize: 0 } };
      }
      return { status: 404, json: null };
    },
    requestCount: () => 0,
  };
}

const NOW = new Date("2026-09-18T12:00:00Z");

describe("Ф2.6 (M8): корректность AppSec", () => {
  test("isLatest=false → no-data no-scan (unknown-enum.json): устаревший скан не выдаётся за результат", async () => {
    const f = loadFixture("unknown-enum.json");
    const log: string[] = [];
    const out = await collectAppsec(
      fakeRest(f.repoId as string),
      fakeAppsec({ scansLatest: f.scansLatest, criticalTotal: 0, secretsTotal: 0 }, log),
      "org/repo",
      { now: NOW },
    );
    expect({ fact: out.fact, reason: out.noData?.reason }).toEqual({ fact: null, reason: "no-scan" });
  });

  test("secrets_critical — фильтр type=SECRETS&severity=CRITICAL, а не /secret/i по имени движка", async () => {
    const log: string[] = [];
    const scansLatest = {
      uuid: "scan-uuid-secrets",
      status: 2,
      timeStarted: 1789570159277,
      timeFinished: 1789570610046,
      isLatest: true,
      commitHash: "abc",
      openDefectGroups: 2,
      totalDefectGroups: 4,
    };
    const out = await collectAppsec(fakeRest("42"), fakeAppsec({ scansLatest, criticalTotal: 1, secretsTotal: 1 }, log), "org/repo", { now: NOW });
    const value = out.fact?.value as { secrets_critical?: boolean } | undefined;
    const secretsQuery = log.find((l) => l.includes("type=SECRETS"));
    expect({
      secretsCritical: value?.secrets_critical,
      askedSeverity: secretsQuery !== undefined && new URLSearchParams(secretsQuery.split("?")[1]).get("severity") === "CRITICAL",
      askedPageSize: secretsQuery !== undefined && new URLSearchParams(secretsQuery.split("?")[1]).get("pageSize") === "1",
    }).toEqual({ secretsCritical: true, askedSeverity: true, askedPageSize: true });
  });

  // Охрана от пере-затягивания, не репро: критичные находки других движков
  // не делают секреты критичными, пока корзина `type=SECRETS` пуста.
  test("type=SECRETS с totalSize=0 → secrets_critical=false даже при критичных находках других движков", async () => {
    const log: string[] = [];
    const scansLatest = {
      uuid: "scan-uuid-no-secrets",
      status: 2,
      timeStarted: 1789570159277,
      timeFinished: 1789570610046,
      isLatest: true,
      commitHash: "abc",
      openDefectGroups: 1,
      totalDefectGroups: 1,
    };
    const out = await collectAppsec(fakeRest("42"), fakeAppsec({ scansLatest, criticalTotal: 3, secretsTotal: 0 }, log), "org/repo", { now: NOW });
    const value = out.fact?.value as { secrets_critical?: boolean; severity_counts?: { critical: number } } | undefined;
    expect({ secretsCritical: value?.secrets_critical, critical: value?.severity_counts?.critical }).toEqual({
      secretsCritical: false,
      critical: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» — тавтология,
// потому что неисправленные дефекты стоят под `test.failing`.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
