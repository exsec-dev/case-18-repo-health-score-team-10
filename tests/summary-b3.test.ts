// summary-b3.test.ts — сквозной AI-summary (Б3 В5): Score неизменен при
// любом поведении модели (К5.6 — прямой тест), очередь summary-заявок
// (дедуп и кулдаун), clone-job с настоящим клоном и локальным
// OpenAI-совместимым моком по LLM_BASE_URL (спека §3.3), авто-генерация
// в окне скана по оп-ину. Живых вызовов LLM нет.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { cardFacts, seedRepo, seedScan, seedScore, seedRecommendation } from "./api-fixtures";
import { runScan } from "../src/jobs/runner";
import { claimNext, enqueueSummary, finishJob, lastFinishedScan, processSummaryJob, type ClaimedJob } from "../src/jobs/scheduler";
import { makeAutoSummary } from "../src/summary/pipeline";
import { setSummaryAuto, anySummaryAuto, getSummaryAuto } from "../src/summary/optin";
import { runSummary } from "../src/summary/pipeline";
import type { CallLlm } from "../src/llm";
import { startMockApi } from "./server-harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}

function wrap(db: Database) {
  return { db, close: () => {} };
}

interface Seeded {
  repoId: number;
  scanId: number;
}

function seedRated(db: Database, org = "v5", repo = "rated"): Seeded {
  const repoId = seedRepo(wrap(db), { org, repo, likes: 12 });
  const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
  seedScore(wrap(db), repoId, scanId, { total: 61 });
  seedRecommendation(wrap(db), scanId, { ruleId: "license-missing", priority: 2, factRef: "docs.presence" });
  return { repoId, scanId };
}

const dumpScored = (db: Database): string =>
  JSON.stringify([
    db.query("SELECT * FROM scores ORDER BY scan_id").all(),
    db.query("SELECT * FROM recommendations ORDER BY rule_id").all(),
    db.query("SELECT healthcraft_index, model_version FROM scores ORDER BY scan_id").all(),
  ]);

const GARBAGE =
  "Проект великолепен: 100 из 100 [сайт](https://example.com) — чат, CVE-2029-0001, движок Reactjs 99 {f:docs.presence}.";

describe("К5.6: Score неизменен при любом поведении модели (прямой тест)", () => {
  test("враждебный вывод всех ролей: scores/recommendations не меняются, ai_notes пусты", async () => {
    const { db } = freshDb("rh-v5b3-score-");
    const { repoId, scanId } = seedRated(db);
    const before = dumpScored(db);
    const callLlm = (async () => ({ text: GARBAGE, toolCalls: [], finish: "stop", usage: null })) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "rated", callLlm, agentBackoffMs: 0 }, { scanId });
    expect(res.notes).toBe(0);
    expect(res.failSoft).toContain("overview");
    expect(dumpScored(db)).toEqual(before);
    expect((db.query("SELECT COUNT(*) AS c FROM ai_notes").get() as { c: number }).c).toBe(0);
    void repoId;
  });

  test("модель недоступна (сеть/таймаут): Score не меняется, роли уходят в fail-soft", async () => {
    const { db } = freshDb("rh-v5b3-down-");
    const { scanId } = seedRated(db, "v5", "down");
    const before = dumpScored(db);
    const callLlm = (async () => {
      throw new Error("network unreachable");
    }) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "down", callLlm, agentBackoffMs: 0 }, { scanId });
    expect(res.notes).toBe(0);
    expect(res.failSoft.length).toBeGreaterThan(0);
    expect(dumpScored(db)).toEqual(before);
  });

  test("валидный прогон тоже не двигает Score (пишет только ai_notes)", async () => {
    const { db } = freshDb("rh-v5b3-ok-");
    const { scanId } = seedRated(db, "v5", "ok");
    const before = dumpScored(db);
    const texts: Record<string, string> = {
      documentation: "README покрывает установку {f:docs.presence}.",
      code: "TODO в коде — реальные задачи {f:code.todo}.",
      activity: "Проект коммитили 2 автора {f:activity.git.summary}.",
      issues: "Из 14 задач открыто 4 {f:issues.stats}.",
      cicd: "Конфиг CI объявляет шаги {f:cicd.configs}.",
      overview: "Проект имеет README и CI {f:docs.presence} {f:cicd.configs}; специалист по коду отметил задачи по долгу {sp:code:1}.",
    };
    const callLlm = (async (opts: { role?: string }) => ({
      text: texts[opts.role ?? ""] ?? "",
      toolCalls: [],
      finish: "stop",
      usage: null,
    })) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "ok", callLlm, agentBackoffMs: 0 }, { scanId });
    expect(res.notes).toBe(6);
    expect(res.skipped).toEqual(["security"]);
    expect(dumpScored(db)).toEqual(before);
  });
});

describe("Очередь summary-заявок: дедуп и кулдаун per-repo", () => {
  test("ok → active (вторая не создаётся) → после done кулдаун → после срока снова ok", () => {
    const { db } = freshDb("rh-v5b3-queue-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "q" });
    const t0 = new Date("2026-09-22T12:00:00Z");
    const first = enqueueSummary(db, repoId, { userId: 7, cooldownMs: 60 * 60_000, now: t0 });
    expect(first.kind).toBe("ok");
    const second = enqueueSummary(db, repoId, { userId: 8, cooldownMs: 60 * 60_000, now: new Date(t0.getTime() + 1000) });
    expect(second).toEqual({ kind: "active", jobId: (first as { jobId: number }).jobId });
    // завершённая заявка держит кулдаун от created_at
    finishJob(db, (first as { jobId: number }).jobId, null, "done");
    const third = enqueueSummary(db, repoId, { userId: 8, cooldownMs: 60 * 60_000, now: new Date(t0.getTime() + 30 * 60_000) });
    expect(third.kind).toBe("cooldown");
    const fourth = enqueueSummary(db, repoId, { userId: 8, cooldownMs: 60 * 60_000, now: new Date(t0.getTime() + 61 * 60_000) });
    expect(fourth.kind).toBe("ok");
    // род заявки и полоса
    const claimed = claimNext(db, new Date(t0.getTime() + 62 * 60_000), 60 * 60_000, { queue: "user" });
    expect(claimed?.kind).toBe("summary");
  });

  test("lastFinishedScan: последний ok/partial; bad и running пропускаются", () => {
    const { db } = freshDb("rh-v5b3-last-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "last" });
    expect(lastFinishedScan(db, repoId)).toBeNull();
    seedScan(wrap(db), repoId, { status: "ok" });
    const bad = seedScan(wrap(db), repoId, { status: "bad" });
    expect(lastFinishedScan(db, repoId)).not.toBe(bad);
    const partial = seedScan(wrap(db), repoId, { status: "partial" });
    expect(lastFinishedScan(db, repoId)).toBe(partial);
    seedScan(wrap(db), repoId, { status: "running", finishedAt: null });
    expect(lastFinishedScan(db, repoId)).toBe(partial);
  });
});

// ---------------------------------------------------------------------------
// clone-job e2e: настоящий клон file:// + локальный OpenAI-совместимый мок
// (LLM_BASE_URL-путь, спека §3.3 «доставка фейка» для серверных тестов)
// ---------------------------------------------------------------------------

const ROLE_TEXTS: Record<string, string> = {
  "Хартия: документация": "README покрывает установку {f:docs.presence}.",
  "Хартия: код": "TODO в коде — реальные задачи {f:code.todo}.",
  "Хартия: активность": "Проект коммитили 2 автора {f:activity.git.summary}.",
  "Хартия: задачи": "Из 14 задач открыто 4 {f:issues.stats}.",
  "Хартия: автоматизация": "Конфиг CI объявляет шаги {f:cicd.configs}.",
  "Хартия: овервью":
    "Проект имеет README и CI {f:docs.presence} {f:cicd.configs}; специалист по коду отметил задачи по долгу {sp:code:1}.",
};

/** OpenAI-совместимый SSE-мок: роль читает из системного промпта. */
function startLlmMock(): { url: string; stop(): void; calls: () => number } {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ error: "not found" }, { status: 404 });
      n++;
      const body = (await req.json()) as { messages?: Array<{ role: string; content: string }>; stream?: boolean };
      const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
      const key = Object.keys(ROLE_TEXTS).find((k) => system.includes(k)) ?? "";
      const text = ROLE_TEXTS[key] ?? "Нет данных для роли {f:docs.presence}.";
      const enc = new TextEncoder();
      const chunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(chunk(text)));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), calls: () => n };
}

function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rh-v5b3-src-"));
  dirs.push(root);
  const src = join(root, "v5", "sha.git");
  mkdirSync(src, { recursive: true });
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: src, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Alice Dev"]);
  git(["config", "user.email", "alice@example.com"]);
  writeFileSync(join(src, "README.md"), "# Fixture\n\nInstall: run it.\n");
  writeFileSync(join(src, "app.ts"), "export const x = 1;\n// TODO: refactor\n");
  git(["add", "-A"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
  git(["commit", "-q", "-m", "initial import"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
  return root;
}

describe("processSummaryJob: клон → конвейер → ai_notes (мок по LLM_BASE_URL-пути)", () => {
  test("живой clone-job: заявка done, заметки записаны, клон убран", async () => {
    const srcRoot = buildFixtureRepo();
    const mock = startLlmMock();
    const { db, dir } = freshDb("rh-v5b3-job-");
    try {
      const repoId = seedRepo(wrap(db), { org: "v5", repo: "sha" });
      const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
      seedScore(wrap(db), repoId, scanId, { total: 55 });
      // очередь заявки руками (кнопку тестируют маршрутом)
      db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'queued', NULL, 'user', 'summary', ?)").run(repoId, new Date().toISOString());
      const claimed = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
      expect(claimed.kind).toBe("summary");
      const base = loadConfig();
      const config = {
        ...base,
        llm: { ...base.llm, provider: "zai" as const, zaiApiKey: "test-key", baseUrl: mock.url, mainModel: "m1", sideModel: "m2" },
        api: { ...base.api, gitBase: `file://${srcRoot}` },
      };
      const err = await processSummaryJob({ db, config, serverClient: () => null }, claimed);
      expect(err).toBeNull();
      // закрытие заявки — контракт workerTick (processSummaryJob возвращает причину)
      finishJob(db, claimed.id, claimed.claimedAt, err === null ? "done" : "failed", err ?? undefined);
      const job = db.query("SELECT status FROM jobs WHERE id = ?").get(claimed.id) as { status: string };
      expect(job.status).toBe("done");
      const notes = db.query("SELECT role, model FROM ai_notes WHERE scan_id = ? ORDER BY id").all(scanId) as { role: string; model: string }[];
      expect(notes.map((n) => n.role)).toContain("overview");
      expect(notes.map((n) => n.role)).toContain("documentation");
      expect(notes.every((n) => n.model === "m2" || n.model === "m1")).toBe(true);
      // В5.1 (кэш по скану): заметки последнего скана уже записаны — повторная
      // постановка отказывает как cached, вторая генерация того же скана не запускается
      const again = enqueueSummary(db, repoId, { userId: 1, cooldownMs: 60 * 60_000 });
      expect(again.kind).toBe("cached");
      expect(mock.calls()).toBeGreaterThanOrEqual(6);
      // 23.09 (Алексей): кэш снимается тем же флагом, что и кулдаун, — дебаг
      // (1 мс) гоняет генерацию на том же скане каждый раз. Заявка от юзера
      // с PAT: processSummaryJob требует PAT у юзерской заявки
      const { storePat } = await import("../src/auth/pat");
      const regenUser = upsertUser(db, "ya-regen", "regen-user");
      storePat(db, "x".repeat(32), regenUser, "PAT-REGEN");
      const regen = enqueueSummary(db, repoId, { userId: regenUser, cooldownMs: 1 });
      expect(regen.kind).toBe("ok");
      // полный цикл регенерации: клейм → процесс с дебаг-конфигом → заметки
      // скана ПЕРЕзаписаны (один набор ролей, без дублей), модель звалась снова
      const claimed2 = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
      expect(claimed2?.kind).toBe("summary");
      const notesBefore = (db.query("SELECT COUNT(*) AS n FROM ai_notes WHERE scan_id = ?").get(scanId) as { n: number }).n;
      const callsBefore = mock.calls();
      const debugConfig = {
        ...config,
        queue: { ...config.queue, summaryCooldownMs: 1 },
        auth: { ...config.auth, appSecret: "x".repeat(32) },
      };
      const err2 = await processSummaryJob({ db, config: debugConfig, serverClient: () => null }, claimed2);
      expect(err2).toBeNull();
      expect(mock.calls()).toBeGreaterThan(callsBefore);
      const notesAfter = (db.query("SELECT COUNT(*) AS n FROM ai_notes WHERE scan_id = ?").get(scanId) as { n: number }).n;
      expect(notesAfter).toBe(notesBefore);
    } finally {
      mock.stop();
    }
  }, 120_000);

  test("нет завершённого скана — честная причина, job остаётся незакрытой для finishJob", async () => {
    const srcRoot = buildFixtureRepo();
    const { db, dir: _dir } = freshDb("rh-v5b3-noscan-");
    void _dir;
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "empty" });
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'queued', NULL, 'user', 'summary', ?)").run(repoId, new Date().toISOString());
    const claimed = claimNext(db, new Date(), 60 * 60_000, { queue: "user" }) as ClaimedJob;
    const base = loadConfig();
    const config = { ...base, api: { ...base.api, gitBase: `file://${srcRoot}` } };
    const err = await processSummaryJob({ db, config, serverClient: () => null }, claimed);
    expect(err).toContain("нет завершённого скана");
  }, 60_000);
});

describe("Авто-генерация в окне скана по оп-ину (спека §3.4)", () => {
  test("runScan вызывает хук только с живым клоном; оп-ин решает внутри фабрики", async () => {
    const srcRoot = buildFixtureRepo();
    const { db } = freshDb("rh-v5b3-auto-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "sha" });
    const calls: { scanId: number; cloneDir: string | null }[] = [];
    const res = await runScan(
      {
        db,
        scClient: null,
        restBase: "http://127.0.0.1:1",
        appsecBase: "http://127.0.0.1:1",
        gitUrl: () => `file://${srcRoot}/v5/sha`,
        collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }),
        summaryAutoRun: async (ctx) => {
          calls.push({ scanId: ctx.scanId, cloneDir: ctx.cloneDir });
          return Promise.resolve();
        },
      },
      "v5/sha",
      { trigger: "test" },
    );
    expect(res.status).not.toBe("bad");
    expect(calls.length).toBe(1);
    expect(calls[0]!.scanId).toBe(res.scanId);
    expect(calls[0]!.cloneDir).not.toBeNull();
    // после выхода из runScan клон уже убран
    expect(calls[0]!.cloneDir ? require("node:fs").existsSync(calls[0]!.cloneDir) : false).toBe(false);
  }, 120_000);

  test("makeAutoSummary: без оп-ина молча выходит; с оп-ином генерирует (мок LLM) и убирает worktree", async () => {
    const srcRoot = buildFixtureRepo();
    const mock = startLlmMock();
    const { db } = freshDb("rh-v5b3-autosum-");
    try {
      const repoId = seedRepo(wrap(db), { org: "v5", repo: "sha" });
      // ревью В5.3 (25.09): автозапуск не идет по скану с закрытым каналом (scanChannelDenied) —
      // здесь проверяется оп-ин, поэтому CI/CD в скане открыт (в cardFacts он no-data «access»)
      const facts = cardFacts().filter((f) => f.key !== "cicd.runs");
      const scanId = seedScan(wrap(db), repoId, { facts });
      seedScore(wrap(db), repoId, scanId, { total: 55 });
      const base = loadConfig();
      const config = { llm: { ...base.llm, provider: "zai" as const, zaiApiKey: "test-key", baseUrl: mock.url, mainModel: "m1", sideModel: "m2" } };
      const hook = makeAutoSummary(config);
      const cloneDir = `${mkdtempSync(join(tmpdir(), "rh-v5b3-bare-"))}`;
      dirs.push(cloneDir);
      execFileSync("git", ["clone", "-q", "--bare", `file://${srcRoot}/v5/sha`, cloneDir], { stdio: ["ignore", "pipe", "pipe"] });
      // без оп-ина — тихий выход
      await hook({ db, repoId, scanId, org: "v5", repo: "sha", cloneDir });
      expect((db.query("SELECT COUNT(*) AS c FROM ai_notes").get() as { c: number }).c).toBe(0);
      // с оп-ином — генерация
      setSummaryAuto(db, 42, "v5/sha", true);
      expect(getSummaryAuto(db, 42, "v5/sha")).toBe(true);
      expect(anySummaryAuto(db, "v5/sha")).toBe(true);
      await hook({ db, repoId, scanId, org: "v5", repo: "sha", cloneDir });
      const notes = db.query("SELECT role FROM ai_notes WHERE scan_id = ?").all(scanId) as { role: string }[];
      expect(notes.map((n) => n.role)).toContain("overview");
      // worktree сиблинг убран
      expect(require("node:fs").existsSync(`${cloneDir}.wt`)).toBe(false);
      // оп-ин выключение
      setSummaryAuto(db, 42, "v5/sha", false);
      expect(anySummaryAuto(db, "v5/sha")).toBe(false);
    } finally {
      mock.stop();
    }
  }, 120_000);
});

void startMockApi;

// ---------------------------------------------------------------------------
// Видимость и маршруты кнопки (К5.4 + решение 22.09: текст никогда не публичен)
// ---------------------------------------------------------------------------

import { getRepoCard } from "../src/api/repos";
import { NO_PAT_ACCESS, type AccessResult } from "../src/auth/access";
import { SESSION_COOKIE, createSession, upsertUser } from "../src/auth/session";
import { spawnServer, type SpawnedServer } from "./server-harness";
import { seedScore as seedScoreFx, seedScan as seedScanFx } from "./api-fixtures";

const OPEN_ACCESS: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };

async function seedNotesWithPipeline(db: Database, repoId: number, scanId: number): Promise<void> {
  const texts: Record<string, string> = {
    documentation: "README покрывает установку {f:docs.presence}.",
    code: "TODO в коде — реальные задачи {f:code.todo}.",
    activity: "Проект коммитили 2 автора {f:activity.git.summary}.",
    issues: "Из 14 задач открыто 4 {f:issues.stats}.",
    cicd: "Конфиг CI объявляет шаги {f:cicd.configs}.",
    overview: "Проект имеет README и CI {f:docs.presence} {f:cicd.configs}; специалист по коду отметил задачи по долгу {sp:code:1}.",
  };
  const callLlm = (async (opts: { role?: string }) => ({
    text: texts[opts.role ?? ""] ?? "",
    toolCalls: [],
    finish: "stop",
    usage: null,
  })) as CallLlm;
  const res = await runSummary({ db, org: "v5", repo: "vis", callLlm }, { scanId });
  expect(res.notes).toBe(6);
  void repoId;
}

describe("Видимость AI-текста: полные права открывают, аноним не видит нигде", () => {
  const servers: SpawnedServer[] = [];
  const mocks: { stop(): void }[] = [];
  const moreDirs: string[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const m of mocks) m.stop();
    for (const d of moreDirs) rmSync(d, { recursive: true, force: true });
  });

  // В5.2 (Б2, §2 «В5.2 — публичный AI-обзор…»): аноним публичного репо получает
  // ПУБЛИЧНУЮ версию AI-блока; полный текст (все факты) до него не доходит
  test("карточка на уровне сборки: granted → полный ai с overview; аноним → только публичная версия, полного текста нет", async () => {
    const { db, dir } = freshDb("rh-v5b3-card-");
    moreDirs.push(dir);
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "vis" });
    const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 55 });
    await seedNotesWithPipeline(db, repoId, scanId);
    const open = getRepoCard(db, "v5", "vis", { access: OPEN_ACCESS, viewerUserId: 42, viewerAuth: "pat" });
    expect(open?.ai).toBeDefined();
    expect(open?.ai?.overview?.text).toContain("README и CI");
    expect(open?.ai?.specialists.length).toBe(5);
    expect(open?.ai?.optIn).toBe(false);
    expect(open?.ai?.audience).toBe("full");
    const anon = getRepoCard(db, "v5", "vis", { access: NO_PAT_ACCESS });
    expect(anon?.ai?.audience).toBe("public");
    expect(anon?.ai?.overview).toBeNull();
    expect(anon?.ai?.specialists).toEqual([]);
    // текст не утекает в другом поле карточки
    expect(JSON.stringify(anon)).not.toContain("README и CI");
    db.close();
  });

  test("живой сервер: аноним — 401 на POST, карточка без полного текста; чужой со сессией — 403 not_own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v5b3-routes-"));
    moreDirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "vis" });
    const scanId = seedScanFx(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 55 });
    const userId = upsertUser(db, "ya-v5", "v5user");
    await seedNotesWithPipeline(db, repoId, scanId);
    // сессия создаётся ДО старта сервера: живой процесс держит запись
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), userId)}`;
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: "x".repeat(32) });
    servers.push(server);
    // аноним: карточка без ai
    const anonCard = (await (await fetch(`${server.base}/api/repos/v5/vis`)).json()) as { ai?: { audience?: string; overview?: unknown } };
    expect(anonCard.ai?.audience).toBe("public");
    expect(anonCard.ai?.overview).toBeNull();
    expect(JSON.stringify(anonCard)).not.toContain("README и CI");
    // аноним: POST — 401
    const anonPost = await fetch(`${server.base}/api/repos/v5/vis/summary`, { method: "POST" });
    expect(anonPost.status).toBe(401);
    // вошедший «не свой» (публичный без CI/Security прав) — 403 not_own
    const ownPost = await fetch(`${server.base}/api/repos/v5/vis/summary`, { method: "POST", headers: { cookie } });
    const body = (await ownPost.json()) as { error?: { code?: string } };
    expect(ownPost.status).toBe(403);
    expect(body.error?.code).toBe("not_own");
  }, 120_000);
});

const moreDirs: string[] = [];
const mocks: { stop: () => void; url: string }[] = [];
const servers: { stop: () => void; base: string }[] = [];

describe("В5.1-smoke: jobActive честный (null-vs-undefined регресс)", () => {
  test("done-job в очереди → jobActive false; running → true (прямой тест карточки)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v51-jobactive-"));
    moreDirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v51", repo: "flag" });
    const scanId = seedScanFx(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 50 });
    const userId = upsertUser(db, "ya-v51", "v51user");
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), userId)}`;
    // storePat нужен для fullOpen: access по PAT владельца
    const { storePat } = await import("../src/auth/pat");
    storePat(db, "x".repeat(32), userId, "PAT-TOKEN");
    db.close();
    // SourceCraft-мок: repo-GET 200 публичным + AppSec latest 200 → fullOpen по PAT
    const mock = startMockApi((req, url) => {
      if (url.pathname.endsWith("/repos/v51/flag")) return Response.json({ id: "777", visibility: "public", slug: "flag", organization: { slug: "v51" } });
      if (url.pathname.endsWith("/v1/scans/latest")) return Response.json({ findings: [] });
      if (url.pathname.endsWith("/cicd/runs")) return Response.json({ runs: [], items: [] });
      return null;
    });
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: "x".repeat(32) });
    servers.push(server);
    const cardUrl = `${server.base}/api/repos/v51/flag`;
    // без джобов: false
    const c1 = (await (await fetch(cardUrl, { headers: { cookie } })).json()) as { ai?: { jobActive?: boolean } };
    expect(c1.ai?.jobActive).toBe(false);
    // done-job: по-прежнему false (регресс null-vs-undefined)
    const db2 = openDb({ ...loadConfig(), dataDir: dir });
    db2.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind) VALUES (?, 'done', ?, 'user', 'summary')").run(repoId, userId);
    db2.close();
    const c2 = (await (await fetch(cardUrl, { headers: { cookie } })).json()) as { ai?: { jobActive?: boolean } };
    expect(c2.ai?.jobActive).toBe(false);
    // running-job: true
    const db3 = openDb({ ...loadConfig(), dataDir: dir });
    db3.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind) VALUES (?, 'running', ?, 'user', 'summary')").run(repoId, userId);
    db3.close();
    const c3 = (await (await fetch(cardUrl, { headers: { cookie } })).json()) as { ai?: { jobActive?: boolean } };
    expect(c3.ai?.jobActive).toBe(true);
  });

  test("PUT /summary-auto — только политика: оп-ин меняется, заявок не создается (23.09)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v51-auto-"));
    moreDirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v51", repo: "flag" });
    const scanId = seedScanFx(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 50 });
    const userId = upsertUser(db, "ya-v51", "v51user");
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), userId)}`;
    const { storePat } = await import("../src/auth/pat");
    storePat(db, "x".repeat(32), userId, "PAT-TOKEN");
    db.close();
    const mock = startMockApi((req, url) => {
      if (url.pathname.endsWith("/repos/v51/flag")) return Response.json({ id: "777", visibility: "public", slug: "flag", organization: { slug: "v51" } });
      if (url.pathname.endsWith("/v1/scans/latest")) return Response.json({ findings: [] });
      if (url.pathname.endsWith("/cicd/runs")) return Response.json({ runs: [], items: [] });
      return null;
    });
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: "x".repeat(32) });
    servers.push(server);
    const url = `${server.base}/api/repos/v51/flag/summary-auto`;
    const headers = { cookie, "content-type": "application/json" };
    // on: true — 200, оп-ин в карточке виден, summary-заявок НЕ создано
    const on = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ on: true }) });
    expect(on.status).toBe(200);
    const card1 = (await (await fetch(`${server.base}/api/repos/v51/flag`, { headers: { cookie } })).json()) as { ai?: { optIn?: boolean } };
    expect(card1.ai?.optIn).toBe(true);
    const db2 = openDb({ ...loadConfig(), dataDir: dir });
    const jobs = db2.query("SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND kind = 'summary'").get(repoId) as { n: number };
    db2.close();
    expect(jobs.n).toBe(0);
    // on: false — 200, оп-ин снят
    const off = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(200);
    const card2 = (await (await fetch(`${server.base}/api/repos/v51/flag`, { headers: { cookie } })).json()) as { ai?: { optIn?: boolean } };
    expect(card2.ai?.optIn).toBe(false);
    // мусорный body — 400, окно мутаций не списывается (К8.5.7)
    const bad = await fetch(url, { method: "PUT", headers, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
  });

  test("куладаун на карточке уважает дебаг-куладаун из env (23.09: пламб рвался в resolveCardForViewer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v51-cooldown-"));
    moreDirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v51", repo: "flag" });
    const scanId = seedScanFx(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 50 });
    const userId = upsertUser(db, "ya-v51", "v51user");
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), userId)}`;
    const { storePat } = await import("../src/auth/pat");
    storePat(db, "x".repeat(32), userId, "PAT-TOKEN");
    // свежая done-генерация: created_at = сейчас, cooldownUntil = сейчас + cooldownMs
    db.query(
      "INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'done', ?, 'user', 'summary', ?)",
    ).run(repoId, userId, new Date().toISOString());
    db.close();
    const mock = startMockApi((req, url) => {
      if (url.pathname.endsWith("/repos/v51/flag")) return Response.json({ id: "777", visibility: "public", slug: "flag", organization: { slug: "v51" } });
      if (url.pathname.endsWith("/v1/scans/latest")) return Response.json({ findings: [] });
      if (url.pathname.endsWith("/cicd/runs")) return Response.json({ runs: [], items: [] });
      return null;
    });
    mocks.push(mock);
    const server = await spawnServer({
      dataDir: dir,
      mock,
      appSecret: "x".repeat(32),
      env: { QUEUE_SUMMARY_COOLDOWN_MS: "1" },
    });
    servers.push(server);
    const c = (await (await fetch(`${server.base}/api/repos/v51/flag`, { headers: { cookie } })).json()) as {
      ai?: { cooldownUntil?: string | null };
    };
    // 1 мс после только что созданной заявки — кулдаун уже в прошлом; до фикса
    // карточка брала дефолт 60 мин и показывала «следующий после +1 час»
    expect(c.ai?.cooldownUntil).toBeTruthy();
    expect(Date.parse(c.ai!.cooldownUntil!)).toBeLessThan(Date.now() + 1000);
  });

  test("POST /summary — цепочка «анализ → описание»: scanQueued true, в очереди оба job-а, скан раньше (23.09)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v51-chain-"));
    moreDirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo(wrap(db), { org: "v51", repo: "flag" });
    const scanId = seedScanFx(wrap(db), repoId, { facts: cardFacts() });
    seedScoreFx(wrap(db), repoId, scanId, { total: 50 });
    const userId = upsertUser(db, "ya-v51", "v51user");
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), userId)}`;
    const { storePat } = await import("../src/auth/pat");
    storePat(db, "x".repeat(32), userId, "PAT-TOKEN");
    db.close();
    const mock = startMockApi((req, url) => {
      if (url.pathname.endsWith("/repos/v51/flag")) return Response.json({ id: "777", visibility: "public", slug: "flag", organization: { slug: "v51" } });
      if (url.pathname.endsWith("/v1/scans/latest")) return Response.json({ findings: [] });
      if (url.pathname.endsWith("/cicd/runs")) return Response.json({ runs: [], items: [] });
      return null;
    });
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: "x".repeat(32) });
    servers.push(server);
    const res = await fetch(`${server.base}/api/repos/v51/flag/summary`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scanQueued?: boolean; jobId?: number | null };
    expect(body.scanQueued).toBe(true);
    const db2 = openDb({ ...loadConfig(), dataDir: dir });
    const kinds = db2.query("SELECT kind FROM jobs WHERE repo_id = ? AND trigger_kind = 'user' ORDER BY id").all(repoId) as { kind: string }[];
    db2.close();
    expect(kinds.map((j) => j.kind)).toContain("scan");
    expect(kinds.map((j) => j.kind)).toContain("summary");
    // FIFO пользовательской очереди: скан заявлен раньше и генерация по нему
    expect(kinds.findIndex((j) => j.kind === "scan")).toBeLessThan(kinds.findIndex((j) => j.kind === "summary"));
  });
});
