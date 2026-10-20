// Поведенческие тесты на исправления по аудиту кода (безопасность и надежность).
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { aiFailureText, getRepoCard } from "../src/api/repos";
import { AI_CACHED_NOTE, aiQuota } from "../src/jobs/ai-quota";
import { claimNext, processCheckJob, purgeOldJobs, summaryCloneToken, summaryEmptyErrorOf, SUMMARY_JOB_ERRORS, type ClaimedJob } from "../src/jobs/scheduler";
import { runFraudCheck, runSummary, scopedFacts } from "../src/summary/pipeline";
import { validateFlagOutput } from "../src/summary/validator";
import { rhythmSignals } from "../src/summary/rhythm";
import { fraudCheckStale, fraudFactorValue } from "../src/web/format";
import { liveFor } from "../src/web/analysis";
import { DEFAULT_AI } from "../src/config";
import type { CallLlm } from "../src/llm";
import type { AccessResult } from "../src/auth/access";
import { NO_PAT_ACCESS } from "../src/auth/access";
import { cardFacts, cardFactsWeakRhythm, seedRepo, seedScan, seedScore } from "./api-fixtures";

const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-fix-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}
const wrap = (db: Database) => ({ db, close: () => {} });
function seeded(db: Database, repo: string): { repoId: number; scanId: number } {
  const repoId = seedRepo(wrap(db), { org: "f", repo });
  const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
  seedScore(wrap(db), repoId, scanId, { total: 60 });
  return { repoId, scanId };
}
const user = (db: Database, n: number) => db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, '2026', '2026')").run(n, `y${n}`, `u${n}`);

describe("безопасность S1: публичная версия клонируется без токена", () => {
  test("public → без токена даже при PAT автора; full → токен автора", () => {
    expect(summaryCloneToken("public", "PAT")).toBeNull();
    expect(summaryCloneToken("full", "PAT")).toBe("PAT");
  });
});

describe("безопасность М1: причины отказа блоков — языком продукта", () => {
  test("модель, валидатор, прочее — русские формулировки; честные пропуски — как есть", () => {
    expect(aiFailureText("модель: HTTP 500: {\"error\":\"internal\"}")).toBe("AI-провайдер не ответил");
    expect(aiFailureText("валидатор: маркер {f:x} вне входа")).toBe("текст не прошел проверку фактами");
    expect(aiFailureText("TypeError: boom")).toBe("блок не сформирован");
    expect(aiFailureText("нет фактов категории — вызова не было")).toBe("нет фактов категории — вызова не было");
  });
  test("карточка анонима не несет технический текст отказа", () => {
    const db = freshDb();
    const { repoId, scanId } = seeded(db, "fails");
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'overview', 'ok', '[]', '1', 'm', '2026', 'public')").run(repoId, scanId);
    db.query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, 'code', 'модель: HTTP 503: upstream secret-host.internal', '2026', 'public')").run(repoId, scanId);
    const card = getRepoCard(db, "f", "fails", { access: NO_PAT_ACCESS })!;
    expect(card.ai?.failures).toEqual([{ role: "code", reason: "AI-провайдер не ответил" }]);
    expect(JSON.stringify(card)).not.toContain("secret-host");
  });
});

describe("безопасность М3 / надежность М1: списание — по ответам модели", () => {
  test("обзор: ни одного ответа — провайдер недоступен (не списывается); хоть один — отказ проверки (списывается)", () => {
    expect(summaryEmptyErrorOf({ outcomes: [], answered: 0 })).toBe(SUMMARY_JOB_ERRORS.providerDown);
    expect(summaryEmptyErrorOf({ outcomes: [], answered: 3 })).toBe(SUMMARY_JOB_ERRORS.empty);
  });

  test("runSummary и runFraudCheck считают ответы; кэш — 0", async () => {
    const db = freshDb();
    // лента с двумя слабыми сигналами: проверку на накрутку решает модель, а не код
    const repoId = seedRepo(wrap(db), { org: "f", repo: "count" });
    const scanId = seedScan(wrap(db), repoId, { facts: cardFactsWeakRhythm() });
    seedScore(wrap(db), repoId, scanId, { total: 60 });
    const answering = (async () => ({ text: "мусор", toolCalls: [], finish: "stop", usage: null })) as unknown as CallLlm;
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as CallLlm;
    const r1 = await runSummary({ db, org: "f", repo: "count", callLlm: answering, agentBackoffMs: 0 }, { scanId, audience: "public" });
    expect(r1.answered).toBeGreaterThan(0);
    expect(r1.notes).toBe(0);
    const c1 = await runFraudCheck({ db, org: "f", repo: "count", callLlm: failing, agentBackoffMs: 0 }, { scanId });
    expect(c1.answered).toBe(0);
    const c2 = await runFraudCheck({ db, org: "f", repo: "count", callLlm: answering, agentBackoffMs: 0 }, { scanId });
    expect(c2.ok).toBe(false);
    expect(c2.answered).toBeGreaterThan(0);
  });

  test("заявка, закрытая «текст уже был», — done, но лимит ее не считает", async () => {
    const db = freshDb();
    user(db, 1);
    const { repoId } = seeded(db, "cachenote");
    const now = new Date();
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, error) VALUES (?, 'done', 1, 'user', 'check', ?, ?)").run(repoId, now.toISOString(), AI_CACHED_NOTE);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'done', 1, 'user', 'check', ?)").run(repoId, now.toISOString());
    expect(aiQuota(db, 1, "check", DEFAULT_AI, now).hour!.used).toBe(1);
    const job: ClaimedJob = { id: 9, repoId, slug: "f/cachenote", userId: 1, triggerKind: "user", kind: "check", audience: "public", claimedAt: "t", attempts: 1 };
    const cached = await processCheckJob({ db, config: loadConfig(), serverClient: () => null, runFraudCheck: async () => ({ scanId: 1, ok: true, flag: null, signals: null, cached: true, answered: 0 }) } as never, job);
    expect(cached).toBe(AI_CACHED_NOTE);
  });
});

describe("безопасность М7: в публичный вход не идут адреса почты", () => {
  test("лента публичной аудитории — без email, имена и даты на месте; полная — как есть", () => {
    const db = freshDb();
    const { scanId } = seeded(db, "mail");
    const pub = scopedFacts(db, scanId, "activity", "public").find((f) => f.key === "activity.git.timeline")!;
    expect(JSON.stringify(pub.value)).not.toContain("@e.com");
    expect(JSON.stringify(pub.value)).toContain("alice");
    const full = scopedFacts(db, scanId, "activity", "full").find((f) => f.key === "activity.git.timeline")!;
    expect(JSON.stringify(full.value)).toContain("a@e.com");
  });
});

describe("безопасность М8: note флаггера без управляющих и bidi-символов", () => {
  test("bidi-переключатель — отказ; обычный текст — принят", () => {
    const keys = new Set(["activity.rhythm"]);
    expect(validateFlagOutput(JSON.stringify({ flag: true, factors: [{ key: "activity.rhythm", note: "ровный ритм‮" }] }), keys).ok).toBe(false);
    expect(validateFlagOutput(JSON.stringify({ flag: true, factors: [{ key: "activity.rhythm", note: "ровный ритм" }] }), keys).ok).toBe(true);
  });
});

describe("надежность С1: кнопка обзора — состояние версии, которую поставит сервер", () => {
  test("живая публичная заявка: не-владельцу — «формируется», владельцу с полными правами — нет", () => {
    const db = freshDb();
    user(db, 1);
    const { repoId } = seeded(db, "run");
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'running', 1, 'user', 'summary', ?, 'public')").run(repoId, new Date().toISOString());
    expect(getRepoCard(db, "f", "run", { access: NO_PAT_ACCESS })!.ai!.jobActive).toBe(true);
    // «свой» публичный с правами на оба канала — isOwnRepo по доступу к коду и каналам
    const own = getRepoCard(db, "f", "run", { access: OPEN, viewerUserId: 2, viewerAuth: "pat" })!;
    expect(own.viewer?.own).toBe(true);
    expect(own.ai!.jobActive).toBe(false);
  });
});

describe("надежность С2: AI-заявки — не «идет анализ»", () => {
  test("карточка: живая проверка зрителя не job анализа; веб: liveFor пропускает AI-заявки", () => {
    const db = freshDb();
    user(db, 5);
    const { repoId } = seeded(db, "live");
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 5, 'user', 'check', ?, 'public')").run(repoId, new Date().toISOString());
    expect(getRepoCard(db, "f", "live", { access: NO_PAT_ACCESS, viewerUserId: 5 })!.job).toBeNull();
    const jobs = { active: [{ jobId: 1, slug: "f/live", phase: "queued", kind: "check" }] } as never;
    expect(liveFor(jobs, "f/live")).toBeNull();
    const scan = { active: [{ jobId: 2, slug: "f/live", phase: "running", kind: "scan" }] } as never;
    expect(liveFor(scan, "f/live")).toMatchObject({ jobId: 2 });
  });
});

describe("надежность С3: в полосе рейтинга AI-заявки топа — раньше волны сканов", () => {
  test("скан поставлен раньше, но первой берется AI-заявка", () => {
    const db = freshDb();
    const { repoId } = seeded(db, "lane");
    const t = new Date().toISOString();
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, kind, created_at) VALUES (?, 'queued', 'periodic', 'scan', ?)").run(repoId, t);
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 'periodic', 'summary', ?, 'public')").run(repoId, t);
    expect(claimNext(db, new Date(), 60_000, { queue: "rating" })!.kind).toBe("summary");
    expect(claimNext(db, new Date(), 60_000, { queue: "rating" })!.kind).toBe("scan");
  });
});

describe("надежность М2/М3: флаг прошлого анализа и вход проверки", () => {
  test("фактор activity.rest — из заметки проверки, не из фактов нового анализа; устаревание распознается", () => {
    expect(fraudFactorValue("activity.rest", null, [{ key: "activity.rest", value: { contributors: 9 } }], { "activity.rest": { contributors: 2 } })).toEqual({ contributors: 2 });
    expect(fraudCheckStale({ scanId: 3, latestScanId: 5 })).toBe(true);
    expect(fraudCheckStale({ scanId: 5, latestScanId: 5 })).toBe(false);
    expect(fraudCheckStale(undefined)).toBe(false);
  });
});

describe("надежность М8: ретеншен не обнуляет лимиты", () => {
  test("QUEUE_RETENTION_DAYS=0: сканы удаляются, сегодняшние AI-заявки остаются", () => {
    const db = freshDb();
    const { repoId } = seeded(db, "ret");
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, kind, created_at) VALUES (?, 'done', 'periodic', 'scan', ?)").run(repoId, hourAgo);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at) VALUES (?, 'done', 1, 'user', 'summary', ?)").run(repoId, hourAgo);
    purgeOldJobs(db, { retentionDays: 0, now });
    expect(db.query("SELECT kind FROM jobs").all()).toEqual([{ kind: "summary" }]);
  });
});

describe("надежность М10: детектор ровных серий не квадратичен на длинной ленте", () => {
  test("20 000 почти ровных коммитов — быстрее 1 с", () => {
    const events = Array.from({ length: 20_000 }, (_, i) => {
      const at = new Date(Date.UTC(2025, 0, 1) + i * 30 * 60_000 + (i % 7) * 1000).toISOString();
      return { author: { name: "a", email: "a@x", date: at }, committer: { name: "a", email: "a@x", date: at } };
    });
    const t0 = performance.now();
    const s = rhythmSignals(events, new Date(Date.UTC(2026, 0, 1)))!;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(s.regular_share).toBeGreaterThan(0.9);
  });
});

import { aiProgressText } from "../src/web/RepoV5";

describe("UX-1 (б): подпись под скелетоном обзора по фазе", () => {
  test("идет анализ / анализ готов, обзор дописывается / публичная генерация", () => {
    expect(aiProgressText(true, true)).toBe("Идет анализ – затем обзор обновится сам.");
    expect(aiProgressText(false, true)).toBe("Анализ готов, обзор дописывается – раздел обновится сам.");
    expect(aiProgressText(false, false)).toBe("Обзор формируется – раздел обновится сам.");
  });
});

import { workerTick } from "../src/jobs/scheduler";

describe("легкий цикл проверок (решение 25.09): проверка не ждет текущий скан", () => {
  test("claim с kind='check' берет только проверку; общий цикл занят сканом — проверка все равно исполняется", async () => {
    const db = freshDb();
    const { repoId } = seeded(db, "loop");
    const t = new Date().toISOString();
    db.query("INSERT INTO jobs (repo_id, status, trigger_kind, kind, created_at) VALUES (?, 'queued', 'periodic', 'scan', ?)").run(repoId, t);
    db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', 1, 'user', 'check', ?, 'public')").run(repoId, t);
    // общий цикл «занят» сканом: берем его как running
    expect(claimNext(db, new Date(), 60_000, { queue: "rating" })!.kind).toBe("scan");
    // фильтр рода: из полосы рейтинга проверок нет — null; из полосы user — проверка
    expect(claimNext(db, new Date(), 60_000, { queue: "rating", kind: "check" })).toBeNull();
    db.query("UPDATE jobs SET status = 'queued', claimed_at = NULL, lease_until = NULL, attempts = 0 WHERE kind = 'check'").run();
    let ran = 0;
    const deps = {
      db,
      config: loadConfig(),
      serverClient: () => null,
      runFraudCheck: async () => {
        ran++;
        return { scanId: 1, ok: true, flag: null, signals: null, answered: 1 };
      },
    } as never;
    const out = await workerTick(deps, ["user", "rating"], { busy: false }, { kind: "check" });
    expect(out).toBe("done");
    expect(ran).toBe(1);
    expect((db.query("SELECT status FROM jobs WHERE kind = 'check'").get() as { status: string }).status).toBe("done");
    expect((db.query("SELECT status FROM jobs WHERE kind = 'scan'").get() as { status: string }).status).toBe("running");
  });
});
