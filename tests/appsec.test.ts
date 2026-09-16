// appsec.test.ts — В4/Б2: официальный AppSec API-коллектор на 7
// фикстурных ветках плана (ok / empty-scan / paginated / 401 / 403 /
// unfinished / unknown-enum) + живой клиент (интервал, ретрай только
// временный). Сети нет: REST и AppSec клиенты — фейки по фикстурам;
// ok.json — санитизированный живой снимок нашего репо (17.09).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScClient, ScResponse } from "../src/collectors/http";
import {
  collectAppsec,
  makeAppsecClient,
  type AppsecClient,
  type AppsecGet,
} from "../src/collectors/appsec";
import { categoryOf } from "../src/collectors/facts";

const FIX = join(import.meta.dir, "fixtures/appsec");
const load = (name: string): any => JSON.parse(readFileSync(join(FIX, name), "utf8"));

/** REST-фейк: только /repos/{slug} → {id}. */
function fakeRest(repoId: string | null, status = 200): ScClient {
  return {
    async get(path: string): Promise<ScResponse> {
      if (path.startsWith("/repos/")) {
        return { status, json: status === 200 ? { id: repoId } : null, bodyText: "" };
      }
      return { status: 404, json: null, bodyText: "" };
    },
    requestCount: () => 1,
  };
}

interface FixtureAppsec {
  scansLatestStatus?: number;
  scansLatestBody?: unknown;
  scansLatest?: unknown;
  defectGroupsPage?: { data: unknown[]; nextPageToken: string; totalSize: number };
  defectGroupsPages?: { data: unknown[]; nextPageToken: string; totalSize: number }[];
  severityFilterTotalSize?: Record<string, number>;
  severityFilterData?: Record<string, unknown[]>;
  groupsPageStatus?: number;
}

/** AppSec-фейк по фикстуре: scans/latest, страницы групп, severity-фильтры. */
function fakeAppsec(f: FixtureAppsec, log?: string[]): AppsecClient {
  return {
    async get(path: string, params: Record<string, string>): Promise<AppsecGet> {
      log?.push(`${path}?${new URLSearchParams(params).toString()}`);
      if (path === "/v1/scans/latest") {
        if (f.scansLatestStatus !== undefined && f.scansLatestStatus !== 200) {
          return { status: f.scansLatestStatus, json: f.scansLatestBody ?? null };
        }
        return { status: 200, json: f.scansLatest ?? null };
      }
      if (path === "/v1/defect-groups") {
        if (params["severity"] !== undefined) {
          const bucket = params["severity"];
          return {
            status: 200,
            json: {
              data: f.severityFilterData?.[bucket] ?? [],
              nextPageToken: "",
              totalSize: f.severityFilterTotalSize?.[bucket] ?? 0,
            },
          };
        }
        if (f.groupsPageStatus !== undefined) {
          return { status: f.groupsPageStatus, json: null, error: "channel" };
        }
        if (f.defectGroupsPages) {
          const token = params["pageToken"] ?? "";
          const page = f.defectGroupsPages.find((_, i) => (i === 0 ? token === "" : f.defectGroupsPages![i - 1]!.nextPageToken === token));
          return page ? { status: 200, json: page } : { status: 200, json: { data: [], nextPageToken: "", totalSize: 0 } };
        }
        return { status: 200, json: f.defectGroupsPage ?? { data: [], nextPageToken: "", totalSize: 0 } };
      }
      return { status: 404, json: null };
    },
    requestCount: () => 0,
  };
}

const NOW = new Date("2026-09-17T12:00:00Z");

describe("collectAppsec: 7 веток плана", () => {
  test("ok — живой снимок нашего репо: счётчики, provenance, НЕТ кода/путей", async () => {
    const f = load("ok.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "lct-hackaton-2026/case-18", { now: NOW });
    expect(out.noData).toBeNull();
    const fact = out.fact!;
    expect(fact.status).toBe("ok");
    expect(fact.key).toBe("appsec.findings");
    expect(categoryOf(fact.key)).toBe("security");
    expect(fact.source).toBe("appsec:api");
    const v = fact.value as any;
    expect(v.severity_counts).toEqual({ critical: 0, high: 1, medium: 6, low: 33 });
    expect(v.resolved_share).toBeCloseTo(1 - 538 / 3112, 3);
    expect(v.secrets_critical).toBe(false);
    expect(v.backlog.open_groups).toBe(40);
    expect(v.backlog.fetched_groups).toBe(40);
    expect(v.backlog.truncated).toBe(false);
    expect(v.backlog.engines["KICS"]).toBeGreaterThan(0);
    expect(v.provenance.scan_uuid).toBe(f.scansLatest.uuid);
    expect(v.provenance.time_finished).toBe(new Date(f.scansLatest.timeFinished).toISOString());
    expect(v.provenance.is_latest).toBe(true);
    expect(v.provenance.group_ids.length).toBe(40);
    expect(v.provenance.group_ids[0]).toEqual({ publicId: 32, uuid: expect.any(String), engine: "KICS" });
    // закон: код и пути не храним (санитизация фикстуры + коллектор не берёт их вообще)
    const json = JSON.stringify(v);
    expect(json).not.toContain("codeBlock");
    expect(json).not.toContain("fileName");
    expect(json).not.toContain("sanitized");
  });

  test("empty-scan — завершённый скан без находок = ok с нулями, не no-data", async () => {
    const f = load("empty-scan.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/empty", { now: NOW });
    expect(out.noData).toBeNull();
    const v = out.fact!.value as any;
    expect(v.severity_counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(v.secrets_critical).toBe(false);
    expect(v.backlog.open_groups).toBe(0);
    expect(v.resolved_share).toBeNull(); // total=0 — долю честно не считаем
  });

  test("paginated — страницы собираются, findings суммируются, group_ids капится", async () => {
    const f = load("paginated.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/pagi", { now: NOW, groupIdsCap: 10 });
    expect(out.noData).toBeNull();
    const v = out.fact!.value as any;
    expect(v.backlog.fetched_groups).toBe(300);
    expect(v.backlog.open_groups).toBe(300);
    expect(v.backlog.open_findings).toBe(300); // findingsCount=1 в каждой группе
    expect(v.backlog.truncated).toBe(false);
    expect(v.severity_counts).toEqual({ critical: 0, high: 20, medium: 100, low: 180 });
    expect(v.resolved_share).toBeCloseTo(0.25, 3);
    expect(v.provenance.group_ids.length).toBe(10);
    expect(v.provenance.group_ids_note).toContain("10 of 300");
  });

  test("401 — no-data reason=access (токен умер)", async () => {
    const f = load("401.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/x", { now: NOW });
    expect(out.fact).toBeNull();
    expect(out.noData?.reason).toBe("access");
    expect(out.noData?.detail).toContain("401");
  });

  test("403 — no-data reason=access (живая ветка examples: публичность права не даёт)", async () => {
    const f = load("403.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "examples/appsec-analysis", { now: NOW });
    expect(out.fact).toBeNull();
    expect(out.noData?.reason).toBe("access");
    expect(out.noData?.detail).toContain("403");
  });

  test("unfinished — timeFinished null → no-data no-scan, не «находок нет»", async () => {
    const f = load("unfinished.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/run", { now: NOW });
    expect(out.fact).toBeNull();
    expect(out.noData?.reason).toBe("no-scan");
    expect(out.noData?.detail).toContain("timeFinished");
  });

  test("unknown-enum — числовые/странные значения нормализуются, не падают и не декодируются", async () => {
    const f = load("unknown-enum.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/weird", { now: NOW });
    expect(out.noData).toBeNull();
    const v = out.fact!.value as any;
    expect(v.severity_counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    // сырая severity «HIGH» (строка) ушла в raw-счётчик как есть — без таблицы соответствия
    expect(v.backlog.severity_raw_counts).toEqual({ HIGH: 1 });
    expect(v.backlog.engines).toEqual({ FutureEngine: 1 });
    expect(v.provenance.commit_hash).toBeNull(); // commitHash null — живём
    expect(v.provenance.is_latest).toBe(false);
  });

  test("secrets_critical — критичная группа движка секретов зажигает флаг", async () => {
    const f = load("ok.json");
    f.severityFilterTotalSize.CRITICAL = 2;
    f.severityFilterData = { CRITICAL: [{ engine: "Secrets Scanner", publicId: 1, uuid: "s-1", severity: 4 }] };
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/sec", { now: NOW });
    const v = out.fact!.value as any;
    expect(v.severity_counts.critical).toBe(2);
    expect(v.secrets_critical).toBe(true);
  });

  test("REST repo-GET: 403 → access, 404 → no-scan", async () => {
    const f = load("ok.json");
    const a = await collectAppsec(fakeRest(f.repoId, 403), fakeAppsec(f), "o/y", { now: NOW });
    expect(a.noData?.reason).toBe("access");
    const b = await collectAppsec(fakeRest(f.repoId, 404), fakeAppsec(f), "o/z", { now: NOW });
    expect(b.noData?.reason).toBe("no-scan");
    expect(b.noData?.detail).toContain("not found");
  });

  test("неполный ответ групп → no-data incomplete (ошибка ≠ отсутствие уязвимостей)", async () => {
    const f = load("ok.json");
    f.groupsPageStatus = 502;
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/chan", { now: NOW });
    expect(out.fact).toBeNull();
    expect(out.noData?.reason).toBe("incomplete");
  });

  test("страницы сверх капа → truncated + open_findings null (честность)", async () => {
    const f = load("paginated.json");
    const out = await collectAppsec(fakeRest(f.repoId), fakeAppsec(f), "o/cap", { now: NOW, pagesCap: 1 });
    const v = out.fact!.value as any;
    expect(v.backlog.fetched_groups).toBe(250);
    expect(v.backlog.truncated).toBe(true);
    expect(v.backlog.open_findings).toBeNull();
    expect(v.backlog.open_groups).toBe(300); // totalSize первой страницы точен
  });
});

describe("makeAppsecClient: бережность живого клиента", () => {
  test("ретрай на 5xx (временный) приводит к успеху; 403 не ретраится", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    let latestStatus = 503;
    (globalThis as any).fetch = async () => {
      calls.push("call");
      if (latestStatus === 503) {
        latestStatus = 200;
        return new Response(JSON.stringify({ data: [], nextPageToken: "", totalSize: 0 }), { status: 503 });
      }
      return new Response(JSON.stringify({ uuid: "u", timeFinished: 1 }), { status: 200 });
    };
    try {
      const client = makeAppsecClient({ token: "secret-token", minIntervalMs: 1 });
      const ok = await client.get("/v1/scans/latest", { gitRepo: "g" });
      expect(ok.status).toBe(200);
      expect(calls.length).toBe(2);
      // 403 — постоянная ошибка, ретрая нет
      calls.length = 0;
      (globalThis as any).fetch = async () => {
        calls.push("call");
        return new Response("no", { status: 403 });
      };
      const denied = await client.get("/v1/scans/latest", { gitRepo: "g" });
      expect(denied.status).toBe(403);
      expect(calls.length).toBe(1);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  test("интервал между запросами (мин 1мс теста, счётчик растёт)", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response("{}", { status: 200 });
    try {
      const client = makeAppsecClient({ token: "t", minIntervalMs: 1, maxRequests: 2 });
      await client.get("/v1/scans/latest", { gitRepo: "g" });
      await client.get("/v1/scans/latest", { gitRepo: "g" });
      const third = await client.get("/v1/scans/latest", { gitRepo: "g" });
      expect(third.status).toBe(0);
      expect(third.error).toContain("budget");
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
