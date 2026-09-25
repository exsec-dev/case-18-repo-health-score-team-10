// v52-debts.test.ts — В5.2, Б7: долги аудита В5.1 (reports/2026-09-22-code-audit-v5-
// reliability.md «мелочь» 1, 2, 3, 6) закрываются поведенческими тестами.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { LlmError, makeLlm, retryAfterMsOf, type CallLlm } from "../src/llm";
import { generateWithTools } from "../src/summary/agent";
import { getRepoHistory } from "../src/api/history";
import { SECRETS_CRITICAL_TOTAL_CAP } from "../src/score/model";
import type { AccessResult } from "../src/auth/access";
import { seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi } from "./server-harness";

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-debts-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return { db, dir };
}

describe("Retry-After провайдера (мелочь 2)", () => {
  test("заголовок: секунды и HTTP-дата → мс; мусор и прошлое — null", () => {
    expect(retryAfterMsOf("3")).toBe(3000);
    expect(retryAfterMsOf(new Date(10_000 + 5000).toUTCString(), 10_000)).toBeGreaterThan(0);
    expect(retryAfterMsOf("soon")).toBeNull();
    expect(retryAfterMsOf(null)).toBeNull();
    expect(retryAfterMsOf(new Date(0).toUTCString(), 10_000)).toBeNull();
  });

  test("429 с Retry-After: повтор ждет запрошенную паузу, а не фиксированный бэкофф", async () => {
    let calls = 0;
    const callLlm = (async () => {
      calls++;
      if (calls === 1) throw new LlmError("429", "HTTP 429", null, 120);
      return { text: "ок", toolCalls: [], finish: "stop", usage: null };
    }) as unknown as CallLlm;
    const t0 = Date.now();
    const res = await generateWithTools({ callLlm, role: "documentation", executor: null, backoffMs: 0 }, [{ role: "user", content: "x" }]);
    expect(res.text).toBe("ок");
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  test("ответ провайдера 429 несет Retry-After в LlmError", async () => {
    const config = { ...loadConfig(), llm: { ...loadConfig().llm, provider: "zai" as const, zaiApiKey: "k", baseUrl: "http://127.0.0.1:1" } };
    const fetchImpl = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } })) as unknown as typeof fetch;
    const call = makeLlm(config, undefined, { fetchImpl });
    const err = (await call({ messages: [{ role: "user", content: "x" }], role: "documentation" }).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe("429");
    expect(err.retryAfterMs).toBe(2000);
  });
});

describe("обрыв в фазе стрима (мелочь 1)", () => {
  test("ошибка чтения стрима — LlmError network, а не сырой DOMException", async () => {
    const config = { ...loadConfig(), llm: { ...loadConfig().llm, provider: "zai" as const, zaiApiKey: "k", baseUrl: "http://127.0.0.1:1" } };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"пол"}}]}\n'));
        c.error(new Error("socket hang up"));
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const call = makeLlm(config, undefined, { fetchImpl });
    const err = (await call({ messages: [{ role: "user", content: "x" }], role: "documentation" }).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe("network");
    expect(err.message).toContain("socket hang up");
  });
});

describe("история: потолок критичных секретов одним запросом (мелочь 6)", () => {
  test("точка скана с secrets_critical — полный Score не выше потолка; соседняя — без потолка", () => {
    const { db } = freshDb();
    const wrap = { db, close: () => {} };
    const repoId = seedRepo(wrap, { org: "d", repo: "sec" });
    const high = { documentation: { score: 95, submetrics: {} }, activity: { score: 95, submetrics: {} }, issues: { score: 95, submetrics: {} }, code: { score: 95, submetrics: {} }, cicd: { score: 95, submetrics: {} }, security: { score: 95, submetrics: {} } };
    const clean = seedScan(wrap, repoId, { facts: [{ key: "appsec.findings", value: { total: 0, critical: 0, secrets_critical: false } }] });
    seedScore(wrap, repoId, clean, { total: 95, categories: high, noData: [] });
    const leaked = seedScan(wrap, repoId, { facts: [{ key: "appsec.findings", value: { total: 1, critical: 1, secrets_critical: true } }] });
    seedScore(wrap, repoId, leaked, { total: 95, categories: high, noData: [] });
    const open: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
    const h = getRepoHistory(db, "d", "sec", { access: open })!;
    const byScan = new Map(h.points.map((p) => [p.scanId, p.repoHealthScore]));
    expect(byScan.get(clean)!).toBeGreaterThan(SECRETS_CRITICAL_TOTAL_CAP);
    expect(byScan.get(leaked)!).toBeLessThanOrEqual(SECRETS_CRITICAL_TOTAL_CAP);
  });
});

describe("404 API не кэшируется (мелочь 3)", () => {
  test("несуществующий репо — 404 с cache-control: no-store", async () => {
    const { db, dir } = freshDb();
    dbs.splice(dbs.indexOf(db), 1);
    db.close();
    const mock = startMockApi();
    const server = await spawnServer({ dataDir: dir, mock });
    try {
      const res = await fetch(`${server.base}/api/repos/nope/missing/history`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await server.stop();
      mock.stop();
    }
  }, 120_000);
});

import { isDeniedPath } from "../src/summary/tools";

describe("список запрещенных файлов инструментов AI (хвосты аудита В5.1)", () => {
  test("SSH-ключи любого алгоритма вне .ssh/ и ключи Firebase — запрещены; обычные файлы — нет", () => {
    for (const p of ["deploy/id_ed25519", "deploy/id_ed25519.pub", "keys/id_ecdsa", "id_dsa", "ci/id_ed25519_sk", "config/my-app-firebase-adminsdk-x1y2z.json", "firebase-adminsdk.json"]) {
      expect(isDeniedPath(p)).toBe(true);
    }
    for (const p of ["src/identity.ts", "docs/id_generation.md", "firebase.json", "src/firebase/admin.ts"]) {
      expect(isDeniedPath(p)).toBe(false);
    }
  });
});

import { normalizeTypography, runSummary } from "../src/summary/pipeline";
import { cardFacts } from "./api-fixtures";

describe("типографика текстов модели (Б7): правило языка продукта до валидатора", () => {
  test("длинное тире → среднее, «ё» → «е»; числа и маркеры не трогаются", () => {
    expect(normalizeTypography("В нём — Ёлка {f:docs.presence} 0.5")).toBe("В нем – Елка {f:docs.presence} 0.5");
  });

  test("заметка пишется уже нормализованной", async () => {
    const { db } = freshDb();
    const wrap = { db, close: () => {} };
    const repoId = seedRepo(wrap, { org: "d", repo: "typo" });
    const scanId = seedScan(wrap, repoId, { facts: cardFacts() });
    seedScore(wrap, repoId, scanId, { total: 50 });
    const callLlm = (async (o: { role?: string }) => ({
      text: o.role === "documentation" ? "README в нём есть — установка описана {f:docs.presence}." : "",
      toolCalls: [],
      finish: "stop",
      usage: null,
    })) as unknown as CallLlm;
    await runSummary({ db, org: "d", repo: "typo", callLlm, agentBackoffMs: 0 }, { scanId, audience: "public" });
    const note = db.query("SELECT text FROM ai_notes WHERE role = 'documentation'").get() as { text: string };
    expect(note.text).toContain("в нем есть – установка");
    expect(note.text).not.toMatch(/[—ё]/);
  });
});
