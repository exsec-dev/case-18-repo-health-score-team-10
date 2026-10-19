// Лимиты AI по заявкам в БД, пароль неограниченного доступа, проверка на
// накрутку отдельной заявкой, автозапуск топа рейтинга за переключателем.
// Числа (лимит, остаток) проверяются на данных; механизм, зависящий от
// дефолта, – и на дефолте (переменная не задана).
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiConfigFromEnv, DEFAULT_AI, loadConfig, type AiConfig } from "../src/config";
import { openDb } from "../src/db";
import { AI_REJECTED_ERRORS, aiQuota, isUnlocked, mskDayStart, quotaRefusal, tryUnlock, unlockFingerprint } from "../src/jobs/ai-quota";
import { CHECK_JOB_ERRORS, enqueueCheck, enqueueSummary, processCheckJob, topAutoTick, type ClaimedJob } from "../src/jobs/scheduler";
import { getRepoCard } from "../src/api/repos";
import { NO_RHYTHM_REASON } from "../src/summary/pipeline";
import { NO_PAT_ACCESS } from "../src/auth/access";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi } from "./server-harness";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";

const NOW = new Date("2026-09-28T12:00:00Z"); // 15:00 МСК
const MIN = 60_000;
const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-quota-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return { db, dir };
}
const wrap = (db: Database) => ({ db, close: () => {} });

function user(db: Database, n: number): number {
  db.query("INSERT INTO users (id, ya_id, login, created_at, last_login_at) VALUES (?, ?, ?, '2026', '2026')").run(n, `ya-${n}`, `u${n}`);
  return n;
}
function job(db: Database, o: { user: number | null; kind?: string; at: Date; status?: string; error?: string | null; unlocked?: 0 | 1; repo?: number }): void {
  db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, error, ai_unlocked) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)").run(
    o.repo ?? 1,
    o.status ?? "done",
    o.user,
    o.kind ?? "summary",
    o.at.toISOString(),
    o.error ?? null,
    o.unlocked ?? 0,
  );
}
const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({ ...DEFAULT_AI, ...over });

describe("конфиг AI: дефолт — числа решения §2, автозапуск топа выключен", () => {
  test("переменные не заданы — лимиты 2/6/30 и 5/20/60, потолок пароля 100, пароля нет, топ выключен", () => {
    const c = aiConfigFromEnv({});
    expect(c.overview).toEqual({ perHour: 2, perDay: 6, globalPerDay: 30 });
    expect(c.check).toEqual({ perHour: 5, perDay: 20, globalPerDay: 60 });
    expect(c.unlockedOverviewPerDay).toBe(100);
    expect(c.unlockedCheckPerDay).toBe(100);
    expect(c.unlockPassword).toBeNull();
    expect(c.topAuto).toBe(false);
    expect(c.topAutoSize).toBe(10);
  });
  test("переменные читаются; мусор в числе — дефолт; пароль короче 20 — функция выключена", () => {
    const c = aiConfigFromEnv({ AI_OVERVIEW_PER_HOUR: "3", AI_CHECK_GLOBAL_PER_DAY: "abc", AI_UNLOCK_PASSWORD: " s3cret-long-enough-for-us ", AI_TOP_AUTO: "1", APP_SECRET: "k" });
    expect(c.overview.perHour).toBe(3);
    expect(c.check.globalPerDay).toBe(60);
    expect(c.unlockPassword).toBe("s3cret-long-enough-for-us");
    expect(c.unlockStatus).toBe("on");
    expect(c.unlockKey).toBe("k");
    const short = aiConfigFromEnv({ AI_UNLOCK_PASSWORD: "short" });
    expect(short.unlockPassword).toBeNull();
    expect(short.unlockStatus).toBe("too_short");
    expect(c.topAuto).toBe(true);
  });
});

describe("лимиты обзора: час, сутки МСК, общий", () => {
  test("2 в час: третий — отказ quota_hour до освобождения самой старой заявки окна", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    job(db, { user: u, at: new Date(NOW.getTime() - 50 * MIN) });
    expect(quotaRefusal(aiQuota(db, u, "overview", cfg(), NOW))).toBeNull();
    job(db, { user: u, at: new Date(NOW.getTime() - 10 * MIN) });
    const q = aiQuota(db, u, "overview", cfg(), NOW);
    expect(q.hour).toEqual({ used: 2, limit: 2 });
    const r = quotaRefusal(q)!;
    expect(r.code).toBe("quota_hour");
    expect(r.until).toBe(new Date(NOW.getTime() + 10 * MIN).toISOString());
  });

  test("6 в сутки считаются с 00:00 МСК: вчерашние 23:59 МСК не в счет", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    const dayStart = mskDayStart(NOW);
    expect(dayStart.toISOString()).toBe("2026-09-27T21:00:00.000Z");
    job(db, { user: u, at: new Date(dayStart.getTime() - MIN) });
    for (let i = 0; i < 5; i++) job(db, { user: u, at: new Date(dayStart.getTime() + (i + 1) * 60 * MIN) });
    expect(aiQuota(db, u, "overview", cfg(), NOW).day).toEqual({ used: 5, limit: 6 });
    job(db, { user: u, at: new Date(dayStart.getTime() + 7 * 60 * MIN) });
    const r = quotaRefusal(aiQuota(db, u, "overview", cfg(), NOW))!;
    expect(r.code).toBe("quota_day");
    expect(r.until).toBe("2026-09-28T21:00:00.000Z");
  });

  test("общий лимит: 5 организаторов по 6 не мешают друг другу; шестой пользователь упирается в 30", () => {
    const { db } = freshDb();
    for (let u = 1; u <= 5; u++) {
      user(db, u);
      for (let i = 0; i < 6; i++) job(db, { user: u, at: new Date(NOW.getTime() - (2 + i * 30) * MIN) });
    }
    const sixth = user(db, 6);
    const q = aiQuota(db, sixth, "overview", cfg(), NOW);
    expect(q.global).toEqual({ used: 30, limit: 30 });
    expect(quotaRefusal(q)!.code).toBe("quota_global");
  });

  test("не списываются: провайдер не ответил, сбой до модели; списывается отказ валидатора", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    job(db, { user: u, at: new Date(NOW.getTime() - 5 * MIN), status: "failed", error: "AI-провайдер недоступен: описание не сформировано (сеть или лимиты провайдера)" });
    job(db, { user: u, at: new Date(NOW.getTime() - 4 * MIN), status: "failed", error: "нет завершённого скана для генерации" });
    expect(aiQuota(db, u, "overview", cfg(), NOW).hour!.used).toBe(0);
    job(db, { user: u, at: new Date(NOW.getTime() - 3 * MIN), status: "failed", error: AI_REJECTED_ERRORS.overview });
    job(db, { user: u, at: new Date(NOW.getTime() - 2 * MIN), status: "queued" });
    expect(aiQuota(db, u, "overview", cfg(), NOW).hour!.used).toBe(2);
  });

  test("отказ валидатора прежним текстом (до смены формулировки) тоже списывается", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    expect(AI_REJECTED_ERRORS.overview).not.toMatch(/[ёЁ]/);
    const legacy = `AI-описание не сформировано: ни один блок не прош${String.fromCharCode(0x451)}л проверку`;
    job(db, { user: u, at: new Date(NOW.getTime() - 3 * MIN), status: "failed", error: legacy });
    expect(aiQuota(db, u, "overview", cfg(), NOW).hour!.used).toBe(1);
  });

  test("обзор и проверка считаются раздельно; автозаявки топа (user_id NULL) — ни в чей лимит", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    job(db, { user: u, kind: "check", at: new Date(NOW.getTime() - MIN) });
    job(db, { user: null, kind: "summary", at: new Date(NOW.getTime() - MIN) });
    expect(aiQuota(db, u, "overview", cfg(), NOW).hour!.used).toBe(0);
    expect(aiQuota(db, u, "overview", cfg(), NOW).global!.used).toBe(0);
    expect(aiQuota(db, u, "check", cfg(), NOW).hour).toEqual({ used: 1, limit: 5 });
  });
});

describe("пароль неограниченного доступа", () => {
  test("неверный — нет отметки; верный — отметка-отпечаток, а не пароль; смена пароля отзывает", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    const c = cfg({ unlockPassword: "very-long-secret", unlockKey: "server-secret" });
    expect(tryUnlock(db, u, "wrong", c)).toBe(false);
    expect(isUnlocked(db, u, c)).toBe(false);
    expect(tryUnlock(db, u, "very-long-secret", c)).toBe(true);
    const stored = (db.query("SELECT ai_unlock FROM users WHERE id = ?").get(u) as { ai_unlock: string }).ai_unlock;
    // HMAC с ключом сервера: без APP_SECRET отпечаток не воспроизводится
    expect(stored).toBe(unlockFingerprint("very-long-secret", "server-secret"));
    expect(stored).not.toBe(unlockFingerprint("very-long-secret", null));
    expect(stored).not.toContain("very-long-secret");
    expect(isUnlocked(db, u, c)).toBe(true);
    expect(isUnlocked(db, u, cfg({ unlockPassword: "rotated", unlockKey: "server-secret" }))).toBe(false);
    expect(isUnlocked(db, u, cfg({ unlockPassword: "very-long-secret", unlockKey: "other-secret" }))).toBe(false);
    expect(isUnlocked(db, u, cfg({ unlockPassword: null }))).toBe(false);
  });

  test("с паролем: личных окон нет, общий лимит не расходуется, действует аварийный потолок 100", () => {
    const { db } = freshDb();
    const vip = user(db, 1);
    const other = user(db, 2);
    const c = cfg({ unlockPassword: "p" });
    tryUnlock(db, vip, "p", c);
    for (let i = 0; i < 40; i++) job(db, { user: vip, at: new Date(NOW.getTime() - (i + 1) * MIN), unlocked: 1 });
    const q = aiQuota(db, vip, "overview", c, NOW);
    expect(q.hour).toBeNull();
    expect(q.day).toBeNull();
    expect(q.global).toEqual({ used: 40, limit: 100 });
    expect(quotaRefusal(q)).toBeNull();
    expect(aiQuota(db, other, "overview", c, NOW).global).toEqual({ used: 0, limit: 30 });
    for (let i = 0; i < 60; i++) job(db, { user: vip, at: new Date(NOW.getTime() - (i + 41) * MIN), unlocked: 1 });
    expect(quotaRefusal(aiQuota(db, vip, "overview", c, NOW))!.code).toBe("quota_global");
    // проверки оценки с паролем – свой потолок 100 в сутки
    expect(aiQuota(db, vip, "check", c, NOW).global).toEqual({ used: 0, limit: 100 });
  });
});

function seedScanned(db: Database, repo: string, index = 70): { repoId: number; scanId: number } {
  const repoId = seedRepo(wrap(db), { org: "q", repo });
  const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
  seedScore(wrap(db), repoId, scanId, { total: index });
  return { repoId, scanId };
}

describe("постановка: кэш и дедуп бесплатны, лимит — последним", () => {
  test("проверка: нет скана → no_scan; есть проверка скана → cached; живая → active; лимит — quota", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    const bare = seedRepo(wrap(db), { org: "q", repo: "bare" });
    expect(enqueueCheck(db, bare, { userId: u }).kind).toBe("no_scan");
    const { repoId, scanId } = seedScanned(db, "c");
    const first = enqueueCheck(db, repoId, { userId: u, quota: () => null });
    expect(first.kind).toBe("ok");
    expect(enqueueCheck(db, repoId, { userId: u, quota: () => null }).kind).toBe("active");
    db.query("UPDATE jobs SET status = 'done'").run();
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'flagger', '{}', '[]', '7', 'm', '2026', 'public')").run(repoId, scanId);
    expect(enqueueCheck(db, repoId, { userId: u, quota: () => ({ code: "quota_hour", message: "x", until: "t" }) }).kind).toBe("cached");
    const { repoId: r2 } = seedScanned(db, "d");
    expect(enqueueCheck(db, r2, { userId: u, quota: () => ({ code: "quota_hour", message: "x", until: "t" }) }).kind).toBe("quota");
    const row = db.query("SELECT kind, audience FROM jobs WHERE id = ?").get((first as { jobId: number }).jobId) as { kind: string; audience: string };
    expect(row).toEqual({ kind: "check", audience: "public" });
  });

  test("обзор: аудитория и отметка пароля пишутся в заявку; публичный и полный — разные дедупы", () => {
    const { db } = freshDb();
    const u = user(db, 1);
    const { repoId } = seedScanned(db, "s");
    const pub = enqueueSummary(db, repoId, { userId: u, audience: "public", unlocked: true, quota: () => null });
    expect(pub.kind).toBe("ok");
    const full = enqueueSummary(db, repoId, { userId: u, audience: "full", quota: () => null, activeMax: 5 });
    expect(full.kind).toBe("ok");
    const rows = db.query("SELECT audience, ai_unlocked FROM jobs WHERE kind = 'summary' ORDER BY id").all();
    expect(rows).toEqual([
      { audience: "public", ai_unlocked: 1 },
      { audience: "full", ai_unlocked: 0 },
    ]);
  });
});

describe("исполнение проверки и состояние на карточке", () => {
  const claimed = (repoId: number): ClaimedJob => ({ id: 1, repoId, slug: "q/x", userId: 1, triggerKind: "user", kind: "check", audience: "public", claimedAt: "t", attempts: 1 });
  test("причины отказа проверки — языком продукта; ленты нет — «проверять нечего»", async () => {
    const { db } = freshDb();
    const { repoId } = seedScanned(db, "x");
    const config = loadConfig();
    const run = (res: { ok: boolean; reason?: string }) =>
      processCheckJob({ db, config, serverClient: () => null, runFraudCheck: async () => ({ scanId: 1, flag: null, signals: null, ...res }) } as never, claimed(repoId));
    expect(await run({ ok: true })).toBeNull();
    expect(await run({ ok: false, reason: NO_RHYTHM_REASON })).toBe(CHECK_JOB_ERRORS.noRhythm);
    expect(await run({ ok: false, reason: "модель: timeout" })).toBe(CHECK_JOB_ERRORS.providerDown);
    expect(await run({ ok: false, reason: "валидатор: не JSON" })).toBe(CHECK_JOB_ERRORS.rejected);
  });

  test("карточка: не проверялось → проверено → новый анализ делает проверку устаревшей; отказ новее — failure", () => {
    const { db } = freshDb();
    const { repoId, scanId } = seedScanned(db, "st");
    const card = () => getRepoCard(db, "q", "st", { access: NO_PAT_ACCESS })!.ai!.check;
    expect(card()).toEqual({ active: false, scanId: null, checkedAt: null, failure: null, retryable: false, latestScanId: scanId, oldRules: false });
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'flagger', ?, '[]', '7', 'm', '2026-09-28T10:00:00Z', 'public')").run(
      repoId,
      scanId,
      JSON.stringify({ flag: false, factors: [], signals: {} }),
    );
    expect(card()).toMatchObject({ scanId, checkedAt: "2026-09-28T10:00:00Z", failure: null });
    const newer = seedScan(wrap(db), repoId, { facts: cardFacts() });
    expect(card()).toMatchObject({ scanId, latestScanId: newer });
    db.query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, 'flagger', ?, '2026-09-28T11:00:00Z', 'public')").run(repoId, newer, NO_RHYTHM_REASON);
    // причина — языком продукта; ленты нет — повторять нечего
    expect(card()).toMatchObject({ scanId: newer, failure: "в анализе нет истории коммитов – проверять нечего", retryable: false });
    db.query("INSERT INTO ai_fails (repo_id, scan_id, role, reason, created_at, audience) VALUES (?, ?, 'flagger', ?, '2026-09-28T11:30:00Z', 'public')").run(repoId, newer, "модель: сеть: Unable to connect");
    expect(card()).toMatchObject({ failure: "AI-провайдер не ответил – попробуйте позже", retryable: true });
  });
});

describe("автозапуск топа рейтинга (topAutoTick)", () => {
  test("выключен по умолчанию — заявок нет", () => {
    const { db } = freshDb();
    seedScanned(db, "a", 90);
    expect(topAutoTick(db, { ai: aiConfigFromEnv({}) }, NOW)).toEqual({ summaries: 0, checks: 0 });
    expect((db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c).toBe(0);
  });

  test("включен: только топ-N, публичные заявки полосы рейтинга без автора; повтор такта в сутки — без дублей", () => {
    const { db } = freshDb();
    const a = seedScanned(db, "a", 90);
    const b = seedScanned(db, "b", 80);
    seedScanned(db, "c", 10);
    const on = { ai: { ...aiConfigFromEnv({}), topAuto: true, topAutoSize: 2 } };
    expect(topAutoTick(db, on, NOW)).toEqual({ summaries: 2, checks: 2 });
    const rows = db.query("SELECT repo_id, kind, audience, user_id, trigger_kind FROM jobs ORDER BY id").all() as { repo_id: number }[];
    expect(new Set(rows.map((r) => r.repo_id))).toEqual(new Set([a.repoId, b.repoId]));
    expect(rows[0]).toMatchObject({ kind: "summary", audience: "public", user_id: null, trigger_kind: "periodic" });
    db.query("UPDATE jobs SET status = 'failed'").run();
    expect(topAutoTick(db, on, new Date(NOW.getTime() + 60 * MIN))).toEqual({ summaries: 0, checks: 0 });
    expect(topAutoTick(db, on, new Date(NOW.getTime() + 25 * 60 * MIN))).toEqual({ summaries: 2, checks: 2 });
  });

  test("у скана уже есть публичный обзор и проверка — заявок нет", () => {
    const { db } = freshDb();
    const a = seedScanned(db, "a", 90);
    for (const [role, text] of [["overview", "x"], ["flagger", "{}"]]) {
      db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, ?, ?, '[]', '1', 'm', '2026', 'public')").run(a.repoId, a.scanId, role, text);
    }
    expect(topAutoTick(db, { ai: { ...aiConfigFromEnv({}), topAuto: true, topAutoSize: 1 } }, NOW)).toEqual({ summaries: 0, checks: 0 });
  });
});

describe("маршруты на живом сервере", () => {
  test("POST /check, GET /api/me/ai-quota, POST/DELETE /api/me/ai-unlock", async () => {
    const { db, dir } = freshDb();
    const { repoId } = seedScanned(db, "live");
    db.query("UPDATE repos SET visibility = 'public' WHERE id = ?").run(repoId);
    const uid = upsertUser(db, "ya-live", "live");
    const cookie = `${SESSION_COOKIE}=${createSession(db, "x".repeat(32), uid)}`;
    dbs.splice(dbs.indexOf(db), 1);
    db.close();
    const mock = startMockApi((_req, url) => (url.pathname.endsWith("/repos/q/live") ? Response.json({ id: "9", visibility: "public", slug: "live", organization: { slug: "q" } }) : null));
    const server = await spawnServer({ dataDir: dir, mock, appSecret: "x".repeat(32), env: { AI_UNLOCK_PASSWORD: "correct-horse-battery-staple" } });
    try {
      const h = { cookie, "content-type": "application/json" };
      const check = await fetch(`${server.base}/api/repos/q/live/check`, { method: "POST", headers: h });
      expect(check.status).toBe(200);
      expect(((await check.json()) as { jobId: number }).jobId).toBeGreaterThan(0);
      const again = await fetch(`${server.base}/api/repos/q/live/check`, { method: "POST", headers: h });
      expect(((await again.json()) as { queued: boolean }).queued).toBe(true);
      const quota = (await (await fetch(`${server.base}/api/me/ai-quota`, { headers: h })).json()) as {
        unlockAvailable: boolean;
        unlocked: boolean;
        check: { hour: { used: number; limit: number } };
      };
      expect(quota.unlockAvailable).toBe(true);
      expect(quota.unlocked).toBe(false);
      expect(quota.check.hour).toEqual({ used: 1, limit: 5 });
      const wrong = await fetch(`${server.base}/api/me/ai-unlock`, { method: "POST", headers: h, body: JSON.stringify({ password: "nope" }) });
      expect(wrong.status).toBe(403);
      const right = await fetch(`${server.base}/api/me/ai-unlock`, { method: "POST", headers: h, body: JSON.stringify({ password: "correct-horse-battery-staple" }) });
      expect(right.status).toBe(200);
      const after = (await (await fetch(`${server.base}/api/me/ai-quota`, { headers: h })).json()) as { unlocked: boolean; check: { hour: unknown } };
      expect(after.unlocked).toBe(true);
      expect(after.check.hour).toBeNull();
      // проверка выше поставлена ДО пароля — в потолок по паролю она не входит
      expect((after.check as unknown as { global: unknown }).global).toEqual({ used: 0, limit: 100 });
      const off = await fetch(`${server.base}/api/me/ai-unlock`, { method: "DELETE", headers: h });
      expect(off.status).toBe(200);
      expect(((await (await fetch(`${server.base}/api/me/ai-quota`, { headers: h })).json()) as { unlocked: boolean }).unlocked).toBe(false);
      const anon = await fetch(`${server.base}/api/repos/q/live/check`, { method: "POST" });
      expect(anon.status).toBe(401);
    } finally {
      await server.stop();
      mock.stop();
    }
  }, 120_000);
});

describe("Б7 (задержка Б1): заявка обзора не клонирует, если заметки аудитории уже есть", () => {
  test("заметки есть — null без клона (адрес клона заведомо битый); нет — честная ошибка клона", async () => {
    const { db } = freshDb();
    const { repoId, scanId } = seedScanned(db, "noclone");
    const base = loadConfig();
    const config = { ...base, api: { ...base.api, gitBase: "file:///definitely/not/here" }, queue: { ...base.queue, summaryCooldownMs: 3_600_000 } };
    const job = (audience: "public" | "full"): ClaimedJob => ({ id: 7, repoId, slug: "q/noclone", userId: null, triggerKind: "periodic", kind: "summary", audience, claimedAt: "t", attempts: 1 });
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'overview', 'x', '[]', '1', 'm', '2026', 'public')").run(repoId, scanId);
    const { processSummaryJob } = await import("../src/jobs/scheduler");
    // итог «текст уже был» – done с пометкой, лимит его не считает
    const { AI_CACHED_NOTE } = await import("../src/jobs/ai-quota");
    expect(await processSummaryJob({ db, config, serverClient: () => null } as never, job("public"))).toBe(AI_CACHED_NOTE);
    // у полной версии заметок нет — дошло до клона и честно упало на нем
    expect(await processSummaryJob({ db, config, serverClient: () => null } as never, job("full"))).toContain("не удалось клонировать");
  }, 60_000);
});
