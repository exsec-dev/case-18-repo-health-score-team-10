// История оценки и история взглядов: публичная проекция points (индекс и покрытие
// всем, полный Score по правам), tri-state NULL-точки, обрыв на MODEL_VERSION,
// привязка head_sha, append-история ai_notes и её видимость (текст не публичен).
import { MODEL_VERSION } from "../src/score/model";
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getAiNotesHistory, getRepoHistory } from "../src/api/history";
import { getRepoCard } from "../src/api/repos";
import { NO_PAT_ACCESS, type AccessResult } from "../src/auth/access";
import { runSummary } from "../src/summary/pipeline";
import type { CallLlm } from "../src/llm";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };

const dirs: string[] = [];
const servers: SpawnedServer[] = [];
const mocks: { stop(): void }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of mocks) m.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}

const wrap = (db: Database) => ({ db, close: () => {} });

describe("getRepoHistory: проекция, tri-state, версия модели, head_sha", () => {
  test("точки по возрастанию, полный Score только по правам, head_sha из сканов", async () => {
    const { db } = freshDb("rh-v5b5-hist-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "h" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-01T00:00:00Z" });
    seedScore(wrap(db), repoId, s1, { total: 40 });
    db.query("UPDATE scans SET head_sha = ? WHERE id = ?").run("aaa111", s1);
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-20T00:00:00Z" });
    seedScore(wrap(db), repoId, s2, { total: 61 });
    db.query("UPDATE scans SET head_sha = ? WHERE id = ?").run("bbb222", s2);

    const anon = getRepoHistory(db, "v5", "h")!;
    expect(anon.points.map((p) => p.scanId)).toEqual([s1, s2]);
    expect(anon.points.map((p) => p.healthcraftIndex)).toEqual([40, 61]);
    expect(anon.points.every((p) => p.repoHealthScore === null)).toBe(true); // полный итог не публичен
    expect(anon.points.map((p) => p.headSha)).toEqual(["aaa111", "bbb222"]);
    expect(anon.modelVersion).toBe(MODEL_VERSION);

    const open = getRepoHistory(db, "v5", "h", { access: OPEN })!;
    expect(open.fullOpen).toBe(true);
    for (const p of open.points) {
      expect(p.repoHealthScore).not.toBeNull();
      expect(typeof p.indexCoverage).toBe("number");
    }
  });

  test("tri-state: скан без числа — NULL-точка; чужая версия модели не попадает", () => {
    const { db } = freshDb("rh-v5b5-tri-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "t" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s1, { total: null, coverage: 0.5 });
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s2, { total: 55 });
    seedScore(wrap(db), repoId, s2, { total: 77, modelVersion: "3.0.0-old" });
    const hist = getRepoHistory(db, "v5", "t")!;
    expect(hist.points.length).toBe(2); // старая версия отфильтрована
    expect(hist.points[0]!.healthcraftIndex).toBeNull();
    expect(hist.points[0]!.indexCoverage).toBe(0.5);
    expect(hist.points[1]!.healthcraftIndex).toBe(55);
  });

  test("эвицтированный публичный и приватный без прав — 404 (null)", () => {
    const { db } = freshDb("rh-v5b5-404-");
    const evicted = seedRepo(wrap(db), { org: "v5", repo: "gone" });
    db.query("UPDATE repos SET rating_active = 0, evict_reason = 'test' WHERE id = ?").run(evicted);
    seedScan(wrap(db), evicted, { facts: cardFacts() });
    const priv = seedRepo(wrap(db), { org: "v5", repo: "priv" });
    seedScan(wrap(db), priv, { facts: cardFacts() });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    expect(getRepoHistory(db, "v5", "gone")).toBeNull();
    expect(getRepoHistory(db, "v5", "priv")).toBeNull();
    expect(getRepoHistory(db, "v5", "priv", { access: OPEN })).not.toBeNull();
    expect(getRepoHistory(db, "v5", "nope")).toBeNull();
  });
});

describe("getAiNotesHistory: append-история взглядов и её видимость", () => {
  async function seedTwoGenerations(db: Database): Promise<number> {
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "n" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s1, { total: 50 });
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s2, { total: 58 });
    const texts: Record<string, string> = {
      documentation: "README покрывает установку {f:docs.presence}.",
      overview: "Проект имеет README {f:scores.summary}; специалист по коду отметил задачи по долгу {sp:code:1}.",
    };
    const callLlm = (async (opts: { role?: string }) => ({
      text: texts[opts.role ?? ""] ?? "",
      toolCalls: [],
      finish: "stop",
      usage: null,
    })) as CallLlm;
    await runSummary({ db, org: "v5", repo: "n", callLlm, agentBackoffMs: 0 }, { scanId: s1 });
    await runSummary({ db, org: "v5", repo: "n", callLlm, agentBackoffMs: 0 }, { scanId: s2 });
    return s2;
  }

  // аноним публичного репо — публичная версия (здесь публичных текстов
  // нет, только полные) — пустой список, полного текста нет; закрытый — 404/locked
  test("оба скана в истории по порядку; аноним — публичная версия без полного текста", async () => {
    const { db } = freshDb("rh-v5b5-notes-");
    await seedTwoGenerations(db);
    const open = getAiNotesHistory(db, "v5", "n", { access: OPEN })!;
    expect(open.locked).toBe(false);
    if (!open.locked) {
      const scanIds = [...new Set(open.notes.map((n) => n.scanId))];
      expect(scanIds.length).toBe(2);
      expect(open.notes.every((n) => n.text.length > 0)).toBe(true);
      expect(open.notes.every((n) => n.charterVersion.length > 0)).toBe(true);
    }
    if (!open.locked) expect(open.audience).toBe("full");
    const anon = getAiNotesHistory(db, "v5", "n")!;
    expect(anon).toEqual({ locked: false, audience: "public", notes: [] });
    // приватный без прав — как карточка: 404
    const priv = seedRepo(wrap(db), { org: "v5", repo: "p" });
    db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
    expect(getAiNotesHistory(db, "v5", "p")).toBeNull();
  });

  test("карточка и /ai-notes не дублируют утечки: публичный ответ без полного текста", async () => {
    const { db } = freshDb("rh-v5b5-leak-");
    await seedTwoGenerations(db);
    const anon = getAiNotesHistory(db, "v5", "n")!;
    expect(JSON.stringify(anon)).not.toContain("README");
  });
});

describe("Маршруты истории на живом сервере", () => {
  test("GET /history анониму отдаёт публичную проекцию; /ai-notes анониму — публичная версия", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v5b5-routes-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "h" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s1, { total: 44 });
    db.query("UPDATE scans SET head_sha = 'f00d' WHERE id = ?").run(s1);
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock });
    servers.push(server);
    const hist = await fetch(`${server.base}/api/repos/v5/h/history`);
    expect(hist.status).toBe(200);
    const body = (await hist.json()) as { points: { healthcraftIndex: number; repoHealthScore: number | null; headSha: string }[] };
    expect(body.points[0]).toMatchObject({ healthcraftIndex: 44, repoHealthScore: null, headSha: "f00d" });
    const notes = await fetch(`${server.base}/api/repos/v5/h/ai-notes`);
    expect(notes.status).toBe(200);
    expect(await notes.json()).toEqual({ locked: false, audience: "public", notes: [] });
    // несуществующий — 404
    expect((await fetch(`${server.base}/api/repos/v5/nope/history`)).status).toBe(404);
  }, 120_000);
});
