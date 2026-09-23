// v485-round2.test.ts — В4.8.5, ступень 3, круг 2: дефекты приемки круга 1
// (`reports/m485-acceptance-hq.md`, «Дефекты приемки»). Каждый пункт —
// поведенческий тест, красный на `6363003` и зеленый после правки. Временные
// БД и фейки ввода-вывода; живых запросов нет.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import type { ProbeIo } from "../src/auth/access";
import { addFavorite, checkFavoriteAccess, listFavorites, myJobs, staleFavoriteSlugs } from "../src/api/me";
import { makeRecheckPump } from "../src/api/recheck";
import { upsertUser } from "../src/auth/session";
import * as format from "../src/web/format";
import * as analysis from "../src/web/analysis";
import type { MyJob } from "../src/api/me";
import { seedRepo, seedScan, type ApiTestDb } from "./api-fixtures";

// круг 2: хелперы П2/П3 — через пространство имен, чтобы красный «до» был
// падением ассерта, а не импорта
const failedAnalysisHint = (canAnalyze: boolean): string =>
  (format as unknown as { failedAnalysisHint?: (c: boolean) => string }).failedAnalysisHint?.(canAnalyze) ?? "<нет хелпера>";
const lockReasonShort = (accesses: (string | undefined)[], auth: string | undefined): string | null => {
  const fn = (format as unknown as { lockReasonShort?: (a: (string | undefined)[], u: string | undefined) => string | null }).lockReasonShort;
  return fn ? fn(accesses, auth) : "<нет хелпера>";
};

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDb(): { db: Database; t: ApiTestDb } {
  const dir = mkdtempSync(join(tmpdir(), "rh-v485-r2-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return { db, t: { db, close: () => {} } };
}

/** Фейк ввода-вывода проверки прав: статусы repo-GET, CI и AppSec; считает запросы. */
function fakeIo(s: { repo: number; cicd?: number; appsec?: number; visibility?: string }): ProbeIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    restGet: async (path) => {
      calls.push(path);
      if (path.includes("/cicd/runs")) return { status: s.cicd ?? 200, json: {} };
      return { status: s.repo, json: s.repo === 200 ? { visibility: s.visibility ?? "public", id: "uuid-r2" } : null };
    },
    appsecLatest: async () => {
      calls.push("appsec");
      return { status: s.appsec ?? 404 };
    },
  };
}

// ---------------------------------------------------------------------------
// П1 (К8.5.6, К8.5.14): сбой каналов CI/AppSec — не вердикт «не свой»
// ---------------------------------------------------------------------------

describe("П1: сбой каналов при видимом репо — «свой» неизвестен, а не «не свой»", () => {
  test("сохраненный own:true: CI 429 + AppSec 503 — права и время проверки прежние, заявка не not_own", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-p1a", "p1a");
    addFavorite(db, uid, "o", "pub");
    const first = await checkFavoriteAccess(db, uid, "o", "pub", { ...fakeIo({ repo: 200, cicd: 200 }), cooldownMs: 0 }, null);
    const before = listFavorites(db, uid)[0]!;
    let enqueued = 0;
    const out = await checkFavoriteAccess(db, uid, "o", "pub", { ...fakeIo({ repo: 200, cicd: 429, appsec: 503 }), cooldownMs: 0 }, async () => {
      enqueued++;
      return { status: "queued", code: null };
    });
    const after = listFavorites(db, uid)[0]!;
    expect({
      firstOwn: first.access.own,
      result: out.result,
      enqueue: out.enqueue,
      enqueued,
      ownKept: after.access?.own,
      ciKept: after.access?.ci,
      checkedAtKept: after.lastCheckedAt === before.lastCheckedAt,
    }).toEqual({
      firstOwn: true,
      result: "failed",
      enqueue: { status: "skipped", code: "check_failed" },
      enqueued: 0,
      ownKept: true,
      ciKept: true,
      checkedAtKept: true,
    });
  });

  test("с чистого листа: сбой каналов — запись «не проверена» и остается кандидатом насоса перепроверки", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-p1b", "p1b");
    addFavorite(db, uid, "o", "fresh");
    const out = await checkFavoriteAccess(db, uid, "o", "fresh", { ...fakeIo({ repo: 200, cicd: 503, appsec: 429 }), cooldownMs: 0 }, async () => ({
      status: "queued",
      code: null,
    }));
    const row = listFavorites(db, uid)[0]!;
    expect({
      result: out.result,
      code: out.enqueue.code,
      lastCheckedAt: row.lastCheckedAt,
      stale: staleFavoriteSlugs(db, uid).map((s) => s.repo),
    }).toEqual({ result: "failed", code: "check_failed", lastCheckedAt: null, stale: ["fresh"] });
  });

  test("вердикт «не свой» остается, когда каналы ответили отказом (403/404), а не сбоем", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-p1c", "p1c");
    addFavorite(db, uid, "o", "foreign");
    const out = await checkFavoriteAccess(db, uid, "o", "foreign", { ...fakeIo({ repo: 200, cicd: 403, appsec: 404 }), cooldownMs: 0 }, async () => ({
      status: "queued",
      code: null,
    }));
    expect({ result: out.result, enqueue: out.enqueue, own: listFavorites(db, uid)[0]!.access?.own }).toEqual({
      result: "checked",
      enqueue: { status: "skipped", code: "not_own" },
      own: false,
    });
  });

  test("приватный и видимый — свой и при сбое каналов (правило «свой» не зависит от каналов)", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-p1d", "p1d");
    addFavorite(db, uid, "o", "priv");
    const out = await checkFavoriteAccess(db, uid, "o", "priv", { ...fakeIo({ repo: 200, visibility: "private", cicd: 503, appsec: 503 }), cooldownMs: 0 }, null);
    expect({ result: out.result, own: out.access.own }).toEqual({ result: "checked", own: true });
  });
});

// ---------------------------------------------------------------------------
// Н3: насос перепроверки не застревает после синхронного завершения прохода
// ---------------------------------------------------------------------------

describe("Н3: насос перепроверки", () => {
  test("проход закончился синхронно (токена нет) — насос не «идет», следующий enqueue запускает проверку", async () => {
    const { db } = freshDb();
    const uid = upsertUser(db, "ya-n3", "n3");
    addFavorite(db, uid, "o", "a");
    let io: ProbeIo | null = null;
    const pump = makeRecheckPump({ db, probeIo: () => io, pauseMs: 0 });
    pump.enqueue(uid, [{ org: "o", repo: "a" }]);
    await pump.idle(uid);
    const stuck = pump.running(uid);
    io = fakeIo({ repo: 200, cicd: 200 });
    pump.enqueue(uid, [{ org: "o", repo: "a" }]);
    await pump.idle(uid);
    expect({ stuck, checked: listFavorites(db, uid)[0]!.lastCheckedAt !== null, runningAfter: pump.running(uid) }).toEqual({
      stuck: false,
      checked: true,
      runningAfter: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Н4: скан задания не берется у следующего задания того же пользователя
// ---------------------------------------------------------------------------

describe("Н4: связь задания со сканом", () => {
  test("задание упало до скана — scanId null; скан следующего задания на том же репо ему не приписан", () => {
    const { db, t } = freshDb();
    const uid = upsertUser(db, "ya-n4", "n4");
    const repoId = seedRepo(t, { org: "o", repo: "n4" });
    const insJob = db.query("INSERT INTO jobs (repo_id, status, claimed_at, user_id, trigger_kind, attempts, created_at) VALUES (?, ?, ?, ?, 'user', 1, ?)");
    const j1 = Number(insJob.run(repoId, "failed", "2026-09-22T10:00:00.000Z", uid, "2026-09-22T09:59:00.000Z").lastInsertRowid);
    const j2 = Number(insJob.run(repoId, "done", "2026-09-22T10:05:00.000Z", uid, "2026-09-22T10:04:00.000Z").lastInsertRowid);
    const scan2 = seedScan(t, repoId, { startedAt: "2026-09-22T10:05:01.000Z", finishedAt: "2026-09-22T10:06:00.000Z", status: "ok", userId: uid });
    const byId = new Map(myJobs(db, uid).recent.map((j) => [j.jobId, j]));
    expect({
      j1: { scanId: byId.get(j1)!.scanId, outcome: byId.get(j1)!.outcome },
      j2: { scanId: byId.get(j2)!.scanId, outcome: byId.get(j2)!.outcome },
    }).toEqual({ j1: { scanId: null, outcome: null }, j2: { scanId: scan2, outcome: "ok" } });
  });

  test("скан задания, начатый после взятия и до следующего задания, остается за ним", () => {
    const { db, t } = freshDb();
    const uid = upsertUser(db, "ya-n4b", "n4b");
    const repoId = seedRepo(t, { org: "o", repo: "n4b" });
    const insJob = db.query("INSERT INTO jobs (repo_id, status, claimed_at, user_id, trigger_kind, attempts, created_at) VALUES (?, ?, ?, ?, 'user', 1, ?)");
    const j1 = Number(insJob.run(repoId, "done", "2026-09-22T10:00:00.000Z", uid, "2026-09-22T09:59:00.000Z").lastInsertRowid);
    const scan1 = seedScan(t, repoId, { startedAt: "2026-09-22T10:00:01.000Z", status: "partial", userId: uid });
    insJob.run(repoId, "queued", null, uid, "2026-09-22T11:00:00.000Z");
    const job = myJobs(db, uid).recent.find((j) => j.jobId === j1)!;
    expect({ scanId: job.scanId, outcome: job.outcome }).toEqual({ scanId: scan1, outcome: "partial" });
  });
});

// ---------------------------------------------------------------------------
// П2 (К8.5.14 (ж)): призыв «запустите еще раз» — только тому, кто может запустить
// П3 (остаток С1-3, К8.5.8): причина замка анониму и при истекшей сессии — вход
// ---------------------------------------------------------------------------

const webSrc = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "web", f), "utf8");

describe("П2: подсказки состояния строки «Моих репозиториев»", () => {
  test("ошибка анализа: своему — призыв запустить, чужому — нейтрально, без призыва", () => {
    expect({ own: failedAnalysisHint(true), foreign: failedAnalysisHint(false) }).toEqual({
      own: "Анализ завершился ошибкой – запустите его еще раз",
      foreign: "Последний анализ завершился ошибкой",
    });
  });

  test("строка берет подсказку ошибки по canAnalyze; других призывов запустить в строке нет", () => {
    const me = webSrc("MePage.tsx");
    expect(me).toContain("title={failedAnalysisHint(canAnalyze)}");
    expect(me).not.toMatch(/запустите/i);
  });
});

describe("П3: причина замка — одно правило для полного Score и строки под категориями", () => {
  test("нет сессии — «войти через Я ID» для любого закрытого канала; с сессией — причина канала", () => {
    expect({
      anonCategory: lockReasonShort(["no-pat"], "no-session"),
      anonFull: lockReasonShort(["no-pat", "no-pat"], "no-session"),
      noPat: lockReasonShort(["no-pat"], "no-pat"),
      denied: lockReasonShort(["denied"], "pat"),
      failedFirst: lockReasonShort(["granted", "check-failed"], "pat"),
      nothing: lockReasonShort(["granted"], "pat"),
    }).toEqual({
      anonCategory: "Нужно войти через Я ID и добавить персональный токен доступа SourceCraft.",
      anonFull: "Нужно войти через Я ID и добавить персональный токен доступа SourceCraft.",
      noPat: "Персональный токен доступа SourceCraft не добавлен.",
      denied: "У вашего токена нет прав на эти данные репозитория.",
      failedFirst: "Не удалось проверить доступ к этим данным.",
      nothing: null,
    });
  });

  // ПЕРЕНОС С ЗАМЕНОЙ (В4.9 ч.2, А2 и А4): у закрытого Repo Health Score —
  // строка пути `fullScorePath` (одна копия с отчетом), она берет причину
  // зрителя с токеном тем же `lockReasonShort`; плашка закрытых категорий —
  // `ACCESS_LOCK_SHORT` по причине, основание категории в отчете —
  // `lockedCategoryText` (sections.ts). Поведение — v49-ui-r1-card.
  test("карточка зовет общий хелпер в обоих местах (проводка)", () => {
    const view = webSrc("cardView.ts");
    const format = webSrc("format.ts");
    expect(view).toContain("fullScorePath(auth, [card.access.cicd, card.access.appsec])");
    expect(format).toMatch(/export function fullScorePath[\s\S]{0,700}lockReasonShort\(accesses, auth\)/);
    // круг 2 (Т3): причина зрителя с токеном — тот же `ACCESS_LOCK_SHORT`
    // круг 4 (3): у зрителя с токеном — «только участникам репозитория» и причина (`LOCKED_WHY`)
    expect(view).toContain("LOCKED_WHY[r as keyof typeof LOCKED_WHY]");
    expect(readFileSync(join(import.meta.dir, "..", "src", "report", "sections.ts"), "utf8")).toContain("lockedCategoryText(cat.locked, card.viewer?.auth)");
    expect(webSrc("RepoPage.tsx")).not.toContain("accessLockShort(cat.locked)");
  });
});

// ---------------------------------------------------------------------------
// Н5: опросы — пауза в скрытой вкладке, перезапуск после 401, базовая линия
// ---------------------------------------------------------------------------

type Tracker = analysis.AnalysisTracker;
type Ext = {
  haltOnLost?: (t: Tracker) => Tracker;
  resumeOnSession?: (t: Tracker) => { tracker: Tracker; resume: boolean };
  expectJob?: (t: Tracker, jobId: number) => Tracker;
};
// через пространство имен: красный «до» — падение ассерта, а не импорта
const ext = analysis as unknown as Ext;
const doneJob = (jobId: number): MyJob => ({
  jobId,
  slug: `o/r${jobId}`,
  status: "done",
  phase: "done",
  queueAhead: null,
  claimedAt: null,
  error: null,
  logoUrl: null,
  stalled: false,
  scanId: jobId,
  outcome: "ok",
  scoreChanged: true,
});

describe("Н5: опрос заданий", () => {
  test("401 останавливает опрос; подтверждение сессии через /api/me перезапускает его ровно один раз", () => {
    const halted = ext.haltOnLost ? ext.haltOnLost(analysis.newTracker()) : analysis.newTracker();
    const first = ext.resumeOnSession ? ext.resumeOnSession(halted) : { tracker: halted, resume: false };
    const second = ext.resumeOnSession ? ext.resumeOnSession(first.tracker) : { tracker: halted, resume: false };
    const idle = ext.resumeOnSession ? ext.resumeOnSession(analysis.newTracker()) : { tracker: halted, resume: true };
    expect({ first: first.resume, second: second.resume, notHalted: idle.resume }).toEqual({ first: true, second: false, notHalted: false });
  });

  test("первый опрос не удался, а анализ из этой вкладки успел закончиться — первый удачный ответ дает тост о нем, но не о прошлом", () => {
    // первый опрос упал: trackJobs не звали; вкладка запустила задание 7
    let t = analysis.newTracker();
    if (ext.expectJob) t = ext.expectJob(t, 7);
    const out = analysis.trackJobs(t, { active: [], recent: [doneJob(7), doneJob(3)] });
    const again = analysis.trackJobs(out.tracker, { active: [], recent: [doneJob(7), doneJob(3)] });
    expect({ first: out.finished.map((j) => j.jobId), again: again.finished.length }).toEqual({ first: [7], again: 0 });
  });

  test("проводка: 401 — haltOnLost, подтвержденная сессия — resumeOnSession, запуск — announceJobStarted", () => {
    const session = webSrc("session.tsx");
    expect(session).toContain("tracker.current = haltOnLost(tracker.current);");
    expect(session).toContain("const r = resumeOnSession(tracker.current);");
    expect(session).toContain("window.addEventListener(JOB_STARTED, onStarted)");
    for (const f of ["RepoPage.tsx", "MePage.tsx"]) expect(webSrc(f)).toContain("announceJobStarted(res?.jobId)");
  });
});

describe("Н5: опрос чужого идущего скана на карточке", () => {
  test("в скрытой вкладке — пауза (проводка useVisible)", () => {
    const page = webSrc("RepoPage.tsx");
    expect(page).toContain("const visible = useVisible();");
    expect(page).toContain("if (!foreignRunning || !visible) return;");
    expect(page).toContain("}, [foreignRunning, visible, reload]);");
  });
});
