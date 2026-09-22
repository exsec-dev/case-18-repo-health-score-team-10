// v485-ui.test.ts — В4.8.5, блок Б6: слой данных UI. К8.5.3 (перечитывание
// без мигания и без потери экрана), К8.5.1 (итог анализа — по заданию: один
// опрос на вкладку, событие итога ровно одно, базовая линия «уже видел»,
// «затянулось» — признак сервера, тост из любого экрана), К8.5.8 (сессия —
// одно состояние: 401 любого /api/me/* — «вы вышли», смена аккаунта в соседней
// вкладке замечается по `login`). Чистые модули и source-assert вёрстки
// (AGENTS.md: число и итог — на данных, вёрстка — строкой).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MyJob } from "../src/api/me";
import { dataOf, fetchJson, SESSION_LOST, stateOnError, stateOnReload, type AsyncState } from "../src/web/api";
import { finishedToast, identityChanged, liveFor, newTracker, pollDelay, POLL_ACTIVE_MS, POLL_IDLE_MS, trackJobs, type JobsResponse } from "../src/web/analysis";

const src = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

const job = (over: Partial<MyJob> & { jobId: number }): MyJob => ({
  slug: "o/r",
  status: "queued",
  phase: "queued",
  queueAhead: null,
  claimedAt: null,
  error: null,
  logoUrl: null,
  stalled: false,
  scanId: null,
  outcome: null,
  scoreChanged: null,
  ...over,
});

describe("К8.5.3: перечитывание без мигания и без потери экрана", () => {
  test("ok → перечитывание → сбой: «данные + ошибка», а не экран ошибки; без keepPrevious — прежнее поведение", () => {
    const ok: AsyncState<{ n: number }> = { kind: "ok", data: { n: 1 } };
    const reloading = stateOnReload(ok, true);
    expect(dataOf(reloading)).toEqual({ n: 1 });
    expect(stateOnError(reloading, "сбой", true)).toEqual({ kind: "ok", data: { n: 1 }, refreshError: "сбой" });
    expect(stateOnError(stateOnReload(ok, false), "сбой", false)).toEqual({ kind: "error", message: "сбой" });
    // первая загрузка без данных — честная ошибка
    expect(stateOnError({ kind: "loading" }, "сбой", true)).toEqual({ kind: "error", message: "сбой" });
  });

  test("карточка, «Мои репозитории» и сессия перечитываются с keepPrevious; карточка показывает пометку «данные могли устареть»", () => {
    expect(src("RepoPage.tsx")).toContain("useJson<Card>(cardUrl, { keepPrevious: true })");
    expect(src("RepoPage.tsx")).toContain("Данные могли устареть: обновить карточку не удалось");
    expect(src("MePage.tsx")).toContain('useJson<MyReposResponse>("/api/me/repos", { keepPrevious: true })');
    expect(src("session.tsx")).toContain('useJson<MeResponse>("/api/me", { keepPrevious: true })');
  });
});

describe("К8.5.1: итог анализа — по заданию", () => {
  test("базовая линия: первый ответ итогов не объявляет (после F5 старых тостов нет)", () => {
    const first = trackJobs(newTracker(), { active: [], recent: [job({ jobId: 1, phase: "done", status: "done" })] });
    expect(first.finished).toEqual([]);
  });

  test("итог объявляется ровно один раз — и у задания, которое закончилось между опросами", () => {
    let t = trackJobs(newTracker(), { active: [job({ jobId: 2, phase: "running", status: "running" })], recent: [] }).tracker;
    const done2 = job({ jobId: 2, phase: "done", status: "done", outcome: "ok", scoreChanged: true });
    const fast3 = job({ jobId: 3, phase: "failed", status: "failed", error: "сбор данных не удался: git" });
    const second = trackJobs(t, { active: [], recent: [fast3, done2] });
    t = second.tracker;
    const third = trackJobs(t, { active: [], recent: [fast3, done2] });
    expect({ second: second.finished.map((j) => j.jobId).sort(), third: third.finished }).toEqual({ second: [2, 3], third: [] });
  });

  test("отказ предпроверки итогом анализа не считается; прерванный перезапуском — тоже (задание снова в очереди)", () => {
    const t = trackJobs(newTracker(), { active: [], recent: [] }).tracker;
    const out = trackJobs(t, {
      active: [job({ jobId: 5, phase: "queued", status: "queued", outcome: "interrupted" })],
      recent: [job({ jobId: 4, phase: "refused", status: "refused" })],
    });
    expect(out.finished).toEqual([]);
  });

  test("тост об итоге: оценка обновлена / публичная оценка не изменилась (С4-10) / ошибка с причиной", () => {
    expect(finishedToast(job({ jobId: 1, slug: "a/b", phase: "done", outcome: "ok", scoreChanged: true }))).toEqual({
      theme: "success",
      title: "Анализ завершен",
      content: "a/b: оценка обновлена",
    });
    expect(finishedToast(job({ jobId: 1, slug: "a/b", phase: "done", outcome: "partial", scoreChanged: false }))).toEqual({
      theme: "info",
      title: "Анализ завершен",
      content: "a/b: публичная оценка не изменилась, данные собраны не полностью",
    });
    expect(finishedToast(job({ jobId: 1, slug: "a/b", phase: "failed", error: "нет действующего токена" }))).toEqual({
      theme: "danger",
      title: "Анализ завершился ошибкой",
      content: "a/b: нет действующего токена",
    });
  });

  test("фаза строки и «затянулось» — из ответа сервера; задание ушло из active — анализа нет", () => {
    const res: JobsResponse = { active: [job({ jobId: 7, slug: "x/y", phase: "running", status: "running", stalled: true })], recent: [] };
    expect(liveFor(res, "x/y")).toEqual({ jobId: 7, phase: "running", stalled: true });
    expect(liveFor({ active: [], recent: [] }, "x/y")).toBeNull();
    expect(liveFor(null, "x/y")).toBeNull();
  });

  test("опрос: чаще, пока идет анализ; реже в покое", () => {
    expect(pollDelay({ active: [job({ jobId: 1 })], recent: [] })).toBe(POLL_ACTIVE_MS);
    expect(pollDelay({ active: [], recent: [] })).toBe(POLL_IDLE_MS);
    expect(pollDelay(null)).toBe(POLL_IDLE_MS);
  });

  test("один опрос на вкладку в корне приложения — тост и из любого экрана; карточка с key по слагу; «обычно до N минут» нет", () => {
    const app = src("App.tsx");
    expect(app).toContain("<AppState>");
    expect(app).toContain("<RepoPage key={`${route.org}/${route.repo}`}");
    const session = src("session.tsx");
    expect((session.match(/fetch\("\/api\/me\/jobs"\)/g) ?? []).length).toBe(1);
    expect(session).toContain("if (login === null || !visible) return;");
    expect(session).toContain("toaster.add({ name: `analysis-finished:${job.jobId}`");
    // С9-13: сбой опроса заданий не молчит — «Задания» показывают, что список мог устареть
    expect(session).toContain("setFailing(next === null);");
    expect(src("MePage.tsx")).toContain("{failing && (");
    for (const f of ["MePage.tsx", "RepoPage.tsx"]) {
      expect(src(f)).not.toContain('fetch("/api/me/jobs")');
      expect(src(f)).not.toMatch(/обычно до/);
    }
  });
});

describe("К8.5.8: сессия — одно состояние", () => {
  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
  });

  test("401 любого /api/me/* — событие «сессии нет»; 401 прочих адресов — нет", async () => {
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    let lost = 0;
    target.addEventListener(SESSION_LOST, () => lost++);
    globalThis.fetch = (async () => Response.json({ error: { code: "unauthorized", message: "требуется вход" } }, { status: 401 })) as unknown as typeof fetch;
    await fetchJson("/api/me/repos").catch(() => undefined);
    await fetchJson("/api/repos/o/r").catch(() => undefined);
    expect(lost).toBe(1);
  });

  test("смена аккаунта в соседней вкладке: login ответа заданий расходится с показанным", () => {
    expect(identityChanged("alice", { login: "bob", active: [], recent: [] })).toBe(true);
    expect(identityChanged("alice", { login: "alice", active: [], recent: [] })).toBe(false);
    expect(identityChanged(null, { login: "bob", active: [], recent: [] })).toBe(false);
  });

  test("страницы читают сессию из одного источника; 401 и возврат во вкладку перечитывают /api/me", () => {
    for (const f of ["MePage.tsx", "RepoPage.tsx"]) expect(src(f)).not.toContain('useJson<MeResponse>("/api/me")');
    const session = src("session.tsx");
    expect(session).toContain("window.addEventListener(SESSION_LOST, reloadMe)");
    expect(session).toContain("if (visible && !wasVisible.current) reloadMe();");
  });
});

describe("поверхности без отдельной растяжки (source-assert вёрстки и проводки)", () => {
  test("С6-4: ссылка под замком полного Score — по причине: нет сессии — вход, нет токена — Настройки, токен есть — без ссылки", () => {
    const page = src("RepoPage.tsx");
    expect(page).toContain('card.viewer?.auth === "pat" ? null : card.viewer?.auth === "no-session" ? (');
    expect(page).toContain('<Link href="/auth/ya">Войти через Я ID</Link>');
    // ПЕРЕНОС (В4.8.5 круг 2, П3): причина замка — общим хелпером, тот же текст «войти»
    expect(page).toContain("lockReasonShort([card.access.cicd, card.access.appsec], card.viewer?.auth)");
    expect(page).toContain('card.viewer?.auth === "no-session" ? SIGN_IN_LOCK_SHORT');
    expect(src("format.ts")).toContain('SIGN_IN_LOCK_SHORT = "Нужно войти через Я ID и добавить персональный токен доступа SourceCraft."');
  });

  test("С9-15/С6-6: звезда до ответа /api/me — «неизвестно», а не «войдите»; «Повторить» нет на 404/400", () => {
    const page = src("RepoPage.tsx");
    expect(page).toContain("starLoggedIn={meData === null ? null : loggedIn}");
    expect(page).toContain("if (loggedIn === null) {");
    expect(page).toContain('state.kind === "error" && (state.status === 404 || state.status === 400) ? undefined');
  });

  test("С9-16: после запуска анализа (и при потерянном ответе) состояние берется у сервера; повтор — «уже идет»", () => {
    const page = src("RepoPage.tsx");
    expect(page).toMatch(/\.finally\(\(\) => \{\s*setSending\(false\);[\s\S]{0,120}announceJobsChanged\(\);\s*analysis\.refresh\(\);/);
    expect(page).toContain('res.deduplicated ? "Анализ уже идет" : "Анализ в очереди"');
  });

  test("С10-4: часовое обслуживание запускается и в роли web", () => {
    const server = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");
    expect(server).toMatch(/if \(role === "web"\) \{\s*stopWorkerLoops\.push\(startMaintenance\(db, config\)\);/);
  });
});