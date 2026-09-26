// rest.test.ts — Б3: REST-коллекторы на живых фиксстурах (зонд 15.09,
// tests/fixtures/rest/*) + фейковый клиент для три-state каналов
// (403 access / 429 bad-channel / сеть). Сети нет.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectRestFacts, fetchResource } from "../src/collectors/rest";
import { Fact } from "../src/collectors/facts";
import { ScClient, ScResponse } from "../src/collectors/http";

const load = (name: string): unknown => JSON.parse(readFileSync(`tests/fixtures/rest/${name}`, "utf8"));
const repoFx = load("repo.json");
const issuesOpenFx = load("issues-open.json");
const issuesClosedFx = load("issues-closed.json");
const commentsFx = load("issue-comments-nonempty.json");
const contributorsFx = load("contributors.json");
const releasesFx = load("releases.json");
const pullsFx = load("pulls.json");
const runsOwnFx = load("cicd-runs-own.json");
const runs403Fx = load("cicd-runs-403.json");
const ratingFx = load("rating.json");

interface Call {
  path: string;
  res: ScResponse;
}

/** Клиент с роутингом по path-префиксу (фейк живого API). */
function routerClient(routes: Array<[match: (p: string) => boolean, res: ScResponse | ((p: string) => ScResponse)]>): ScClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<ScResponse> {
      calls.push(path);
      for (const [match, res] of routes) {
        if (match(path)) return typeof res === "function" ? res(path) : res;
      }
      return { status: 404, json: null, bodyText: "no route" };
    },
    requestCount: () => calls.length,
  };
}

const ok = (json: unknown): ScResponse => ({ status: 200, json, bodyText: "" });
const get = (p: string): string => (p.includes("?") ? p.slice(0, p.indexOf("?")) : p);

function fullOkClient(overrides: Array<[string, ScResponse]> = []): ScClient & { calls: string[] } {
  const table: Array<[(p: string) => boolean, ScResponse]> = [
    // оверрайды ПЕРВЫМИ — перекрывают дефолтные маршруты
    ...overrides.map(([path, res]) => [(p: string) => get(p) === path, res] as [(p: string) => boolean, ScResponse]),
    [(p) => get(p) === "/repos/o/r", ok(repoFx)],
    [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dopen"), ok(issuesOpenFx)],
    [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dclosed"), ok(issuesClosedFx)],
    // В5.3-М (Н6): задачи в работе — третий запрос фильтра status
    [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Din_progress"), ok({ issues: [] })],
    [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
    [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
    [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
    [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
    [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
    [(p) => get(p).includes("/comments"), ok(commentsFx)],
    // В5.5 тур 2 (W4): ревьюеры PR — выборка review (activity.pr_review)
    [(p) => get(p).endsWith("/reviewers"), ok({ reviewers: [] })],
  ];
  return routerClient(table);
}

test("cicd.runs: green_streak — серия зелёных с конца; идущий запуск серию не рвёт и в долю не входит; events/errors собираются (23.09, М2.5)", async () => {
  const runs = [
    {
      status: "failed",
      event_type: "push",
      dates: { started_at: "2026-09-15T10:00:00Z", finished_at: "2026-09-15T10:00:30Z" },
      workflows: [{ slug: "check", status: "failed" }],
      error_messages: ["Step build exited 1"],
    },
    { status: "success", event_type: "push", dates: { started_at: "2026-09-15T09:00:00Z", finished_at: "2026-09-15T09:00:25Z" } },
    // М2.5: `processing` — идущий запуск по перечню Run.Status спеки
    { status: "processing", event_type: "manual", dates: { started_at: "2026-09-15T08:00:00Z", finished_at: "2026-09-15T08:00:20Z" } },
    { status: "success", event_type: "push", dates: { started_at: "2026-09-15T07:00:00Z", finished_at: "2026-09-15T07:00:22Z" } },
    { status: "success", event_type: "push", dates: { started_at: "2026-09-15T06:00:00Z", finished_at: "2026-09-15T06:00:24Z" } },
  ];
  const client = fullOkClient([["/repos/o/r/cicd/runs", ok({ runs })]]);
  const out = await collectRestFacts(client, "o/r", { commentsTopN: 3 });
  const v = (k: string) => new Map(out.facts.map((f) => [f.key, f])).get(k)!.value as Record<string, unknown>;
  // самый свежий failed → серия с конца нулевая, хотя 3 из 5 зелёные
  expect(v("cicd.runs").green_streak).toBe(0);
  expect(v("cicd.runs").last_status).toBe("failed");
  // М2.5: доля — по завершенным (3 зеленых из 4), идущий запуск не провал
  expect(v("cicd.runs").success_rate).toBe(0.75);
  expect(v("cicd.runs").runs_count).toBe(4);
  expect(v("cicd.runs").runs_total).toBe(5);
  expect(v("cicd.runs").status_note).toBeUndefined();
  // событийный разрез и разбор красного прогона: виновник и текст ошибки
  expect(v("cicd.runs").events).toEqual({ push: 4, manual: 1 });
  expect(v("cicd.runs").failed_workflows).toEqual(["check"]);
  expect(v("cicd.runs").error_top).toEqual(["Step build exited 1"]);
});

test("cicd.runs: weighted_success_rate — ленты свежести Алексея (свежие прогоны весомее, старше года — 0)", async () => {
  const runs = [
    // свежий красный (1 день) и старые зелёные (60-100 дней, вес 10 и 5)
    { status: "failed", dates: { started_at: "2026-09-15T10:00:00Z", finished_at: "2026-09-15T10:00:30Z" } },
    { status: "success", dates: { started_at: "2026-09-15T09:00:00Z", finished_at: "2026-09-15T09:00:25Z" } },
    { status: "success", dates: { started_at: "2026-09-14T09:00:00Z", finished_at: "2026-09-14T09:00:25Z" } },
    { status: "success", dates: { started_at: "2026-07-01T09:00:00Z", finished_at: "2026-07-01T09:00:25Z" } },
  ];
  const client = fullOkClient([["/repos/o/r/cicd/runs", ok({ runs })]]);
  const out = await collectRestFacts(client, "o/r", { commentsTopN: 3, now: new Date("2026-09-16T09:00:00Z") });
  const v = (k: string) => new Map(out.facts.map((f) => [f.key, f])).get(k)!.value as Record<string, unknown>;
  // веса: красный (1д) = 30, зелёные (1д, 2д, 76д) = 30+30+10 → 70/100 = 0.7
  // против простой доли 0.75 — свежий провал тянет вниз сильнее старого успеха
  expect(v("cicd.runs").weighted_success_rate).toBe(0.68);
});

describe("fetchResource: классификация ошибок канала", () => {
  test("403 → access, 429 → bad-channel, 500 → bad-channel, сеть → bad-channel", async () => {
    const mk = (res: ScResponse) => routerClient([[(p) => p.includes("/cicd/runs"), res]]);
    expect((await fetchResource(mk({ status: 403, json: runs403Fx, bodyText: "" }), "o/r", "cicd-runs")).kind).toBe("access");
    expect((await fetchResource(mk({ status: 429, json: null, bodyText: "" }), "o/r", "cicd-runs")).kind).toBe("bad-channel");
    expect((await fetchResource(mk({ status: 503, json: null, bodyText: "" }), "o/r", "cicd-runs")).kind).toBe("bad-channel");
    expect((await fetchResource(mk({ status: 0, json: null, bodyText: "", error: "ECONNRESET" }), "o/r", "cicd-runs")).kind).toBe("bad-channel");
    expect((await fetchResource(mk({ status: 404, json: null, bodyText: "" }), "o/r", "cicd-runs")).kind).toBe("other");
  });

  test("пагинация ≤5 страниц по next_page_token", async () => {
    let n = 0;
    const client = routerClient([
      [
        () => true,
        () => {
          n++;
          return n < 8 ? ok({ issues: [{ slug: `i${n}` }], next_page_token: `t${n}` }) : ok({ issues: [{ slug: `i${n}` }] });
        },
      ],
    ]);
    const out = await fetchResource(client, "o/r", "issues-open", { pageSize: 1, maxPages: 5 });
    expect(out.kind).toBe("ok");
    expect(out.pages).toBe(5);
    expect(out.items.length).toBe(5);
  });

  test("инвентаризационный колбэк получает наблюдаемые ключи", async () => {
    const notes: string[] = [];
    const client = routerClient([[(p) => get(p) === "/repos/o/r/issues", ok(issuesOpenFx)]]);
    await fetchResource(client, "o/r", "issues-open", {
      onDivergence: (n) => notes.push(`${n.resource}:${n.observedTopKeys.join("/")}:${n.observedItemKeys?.length ?? 0}поля`),
    });
    expect(notes[0]).toContain("issues-open:issues/");
  });
});

describe("collectRestFacts: факты из живых форм", () => {
  test("happy path: все kinds ok, мета репо извлечена", async () => {
    const client = fullOkClient();
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 3 });
    const by = new Map(out.facts.map((f) => [f.key, f]));
    const v = (k: string) => by.get(k)!.value as Record<string, unknown>;

    // В5.5 тур 2 (W4): + activity.pr_review (справочный факт ЗН-2)
    expect(by.size).toBe(5);
    expect([...by.values()].every((f) => f.status === "ok")).toBe(true);
    expect(v("issues.stats").open).toBe(3); // фиксстура issues-open: 3 записи
    expect(v("issues.stats").closed).toBe(2);
    expect(v("issues.stats").stale_90d).toBeGreaterThanOrEqual(0);
    // фиксстура issues-closed: completed_at есть → медиана считается без fallback
    expect(v("issues.stats").median_close_days).toBeGreaterThanOrEqual(0);
    expect(v("issues.stats").close_date_note).toBeUndefined();
    expect(v("activity.rest").contributors).toBe(1);
    expect(v("activity.rest").releases).toBe(2);
    expect(v("cicd.runs").last_status).toBe("success");
    expect(v("cicd.runs").success_rate).toBe(1);
    expect(v("cicd.runs").runs_count).toBe(2);
    expect(v("cicd.runs").green_streak).toBe(2); // обе зелёные подряд с конца
    expect(v("cicd.runs").duration_p50).toBeGreaterThan(20); // фиксстура: ~22-24с ран

    // метa: title/language/likes/last_activity
    expect(out.repoMeta).not.toBeNull();
    expect(out.repoMeta!.title).toBe("dozzle-plus");
    expect(out.repoMeta!.likes).toBe(25); // rating.value 25
    expect(out.channelErrors.length).toBe(0);
    // comments: 3 issues × 1 запрос (комментарии PR — своя выборка W4)
    const commentCalls = client.calls.filter((p) => p.includes("/issues/") && p.includes("/comments")).length;
    expect(commentCalls).toBe(3);
  });

  test("cicd/runs 403 → no-data reason=access (acceptance-кейс)", async () => {
    const client = fullOkClient([[("/repos/o/r/cicd/runs") as string, { status: 403, json: runs403Fx, bodyText: "" } as ScResponse]]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    const runs = out.facts.find((f) => f.key === "cicd.runs")!;
    expect(runs.status).toBe("no-data");
    expect((runs.value as { reason: string }).reason).toBe("access");
    // скан не валится: остальные факты на месте
    expect(out.facts.find((f) => f.key === "issues.stats")!.status).toBe("ok");
  });

  test("429 на issues → bad-channel факт, остальное собирается", async () => {
    const client = fullOkClient([
      ["/repos/o/r/issues", { status: 429, json: null, bodyText: "" } as ScResponse],
    ]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    const stats = out.facts.find((f) => f.key === "issues.stats")!;
    const sample = out.facts.find((f) => f.key === "issues.comments_sample")!;
    expect(stats.status).toBe("bad");
    expect(sample.status).toBe("bad");
    expect(out.facts.find((f) => f.key === "cicd.runs")!.status).toBe("ok");
    expect(out.channelErrors.length).toBeGreaterThan(0);
  });

  test("сеть мертва на issues+activity+cicd → все bad, но функция завершается", async () => {
    const client = routerClient([
      [(p) => get(p) === "/repos/o/r", ok(repoFx)],
      [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
      [(p) => true, { status: 0, json: null, bodyText: "", error: "ENETDOWN" } as ScResponse],
    ]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    expect(out.facts.every((f: Fact) => f.status === "bad")).toBe(true);
  });

  test("comments: расчёт first_comment_delay от created_at issue", async () => {
    // issues-open фиксстура: 1-я issue создана 2026-09-15T04:00:31;
    // comments фиксстура (testplane): created_at 2026-03-05... — старее
    // issue ⇒ delay отрицательный и отбрасывается; проверяем сам расчёт
    // на синтетике: комментарий ровно через 2ч
    const issue = (issuesOpenFx as { issues: Record<string, unknown>[] }).issues[0]!;
    const issueCreated = String(issue["created_at"]);
    const at = new Date(issueCreated);
    const cAt = new Date(at.getTime() + 2 * 3600_000).toISOString();
    const synth = { issue_comments: [{ id: "c1", body: "x", created_at: cAt }] };
    // подмена comments-роута
    const patched = routerClient([
      [(p) => get(p) === "/repos/o/r", ok(repoFx)],
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dopen"), ok(issuesOpenFx)],
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dclosed"), ok(issuesClosedFx)],
      // В5.3-М (Н6): задачи в работе — третий запрос фильтра status
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Din_progress"), ok({ issues: [] })],
      [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
      [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
      [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
      [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
      [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
      [(p) => p.includes("/comments"), ok(synth)],
    ]);
    const out = await collectRestFacts(patched, "o/r", { commentsTopN: 1 });
    const sample = out.facts.find((f) => f.key === "issues.comments_sample")!;
    const val = sample.value as { issues: number; answered: number; censored: number; delays_hours: number[] };
    expect(val.issues).toBe(1);
    expect(val.answered).toBe(1);
    expect(val.delays_hours[0]).toBe(2);
  });
});

describe("круг 2 (LOW-4): частичный сбой выборки комментариев", () => {
  test("один из комментарийных запросов 429 → issues.comments_sample bad, а не урезанный ok", async () => {
    let n = 0;
    const client = routerClient([
      [(p) => get(p) === "/repos/o/r", ok(repoFx)],
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dopen"), ok(issuesOpenFx)],
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dclosed"), ok(issuesClosedFx)],
      // В5.3-М (Н6): задачи в работе — третий запрос фильтра status
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Din_progress"), ok({ issues: [] })],
      [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
      [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
      [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
      [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
      [(p) => p.includes("/comments"), () => (++n === 1 ? { status: 429, json: null, bodyText: "" } : ok(commentsFx))],
    ]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 3 });
    const sample = out.facts.find((f) => f.key === "issues.comments_sample")!;
    expect(n).toBeGreaterThan(1);
    expect(sample.status).toBe("bad");
  });
});

describe("В2/Б1: расширения — событийные даты, forks/reaction_counts, без rating", () => {
  test("activity.rest несёт pulls_created_at / releases_released_at (топ-N desc)", async () => {
    const client = fullOkClient();
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    const act = out.facts.find((f) => f.key === "activity.rest")!.value as Record<string, unknown>;
    const pullsDates = act.pulls_created_at as string[];
    const relDates = act.releases_released_at as string[];
    expect(Array.isArray(pullsDates) && pullsDates.length).toBeGreaterThan(0);
    expect(Array.isArray(relDates) && relDates.length).toBeGreaterThan(0);
    // desc-порядок (клиентская сортировка поверх серверной)
    expect([...pullsDates].sort((a, b) => (a < b ? 1 : -1))).toEqual(pullsDates);
    // фиксстура releases: released_at 2026-09-03 / 2026-09-01
    expect(relDates[0]).toMatch(/^2026-09-03/);
  });

  test("repoMeta: forks из counters (строка→int), reaction_counts с count-строкой", async () => {
    const client = fullOkClient();
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    expect(out.repoMeta!.forks).toBe(0); // фиксстура repo.json: counters.forks = "0"
    expect(out.repoMeta!.reactionCounts).toEqual([{ type: "positive_high", count: 5 }]); // count = "5"
  });

  test("rating-эндпоинт сканом НЕ запрашивается (В2, экономия)", async () => {
    const client = fullOkClient();
    await collectRestFacts(client, "o/r", { commentsTopN: 0 });
    expect(client.calls.some((p) => p.includes("/rating"))).toBe(false);
  });
});

test("М2.5: неизвестный статус запуска — отдельная ветка: в долю не входит и назван в status_note", async () => {
  const runs = [
    { status: "success", dates: { started_at: "2026-09-15T09:00:00Z", finished_at: "2026-09-15T09:00:25Z" } },
    { status: "exploded", dates: { started_at: "2026-09-15T08:00:00Z", finished_at: "2026-09-15T08:00:25Z" } },
    { status: "canceled", dates: { started_at: "2026-09-15T07:00:00Z", finished_at: "2026-09-15T07:00:25Z" } },
  ];
  const client = fullOkClient([["/repos/o/r/cicd/runs", ok({ runs })]]);
  const out = await collectRestFacts(client, "o/r", { commentsTopN: 3 });
  const v = new Map(out.facts.map((f) => [f.key, f])).get("cicd.runs")!.value as Record<string, unknown>;
  expect(v.success_rate).toBe(1);
  expect(v.runs_count).toBe(1);
  expect(v.status_note).toBe("unknown run statuses: exploded");
});

describe("В5.3 аудит методики: MR всех статусов (М2.4) и цензура первого ответа (М2.6)", () => {
  test("М2.4: поток MR — созданные запросы любого статуса; открытые считаются по статусу", async () => {
    const pulls = [
      { status: "merged", created_at: "2026-09-10T00:00:00Z" },
      { status: "open", created_at: "2026-09-12T00:00:00Z" },
      { status: "discarded", created_at: "2026-08-01T00:00:00Z" },
    ];
    const client = fullOkClient([["/repos/o/r/pulls", ok({ pull_requests: pulls })]]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 3, now: new Date("2026-09-15T00:00:00Z") });
    const pullCalls = client.calls.filter((p) => get(p) === "/repos/o/r/pulls");
    expect(pullCalls.length).toBeGreaterThan(0);
    for (const p of pullCalls) expect(p).not.toContain("filter=");
    const rest = out.facts.find((f) => f.key === "activity.rest")!;
    expect(rest.status).toBe("ok");
    const v = rest.value as { pulls_open: number; pulls_created_at: string[] };
    expect(v.pulls_open).toBe(1);
    expect(v.pulls_created_at).toHaveLength(3);
  });

  test("М2.6: задача без ответа дольше 30 дней — задержка 720 ч; свежая без ответа — вне выборки", async () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const open = [
      { slug: "old", created_at: "2026-07-01T00:00:00Z" },
      { slug: "fresh", created_at: "2026-09-14T00:00:00Z" },
    ];
    const client = routerClient([
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dopen"), ok({ issues: open })],
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Dclosed"), ok({ issues: [] })],
      // В5.3-М (Н6): задачи в работе — третий запрос фильтра status
      [(p) => get(p) === "/repos/o/r/issues" && p.includes("status%3Din_progress"), ok({ issues: [] })],
      [(p) => get(p).includes("/comments"), ok({ comments: [] })],
      [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
      [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
      [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
      [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
      [(p) => get(p) === "/repos/o/r", ok(repoFx)],
      [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
    ]);
    const out = await collectRestFacts(client, "o/r", { commentsTopN: 3, now });
    const sample = out.facts.find((f) => f.key === "issues.comments_sample")!;
    expect(sample.status).toBe("ok");
    const v = sample.value as { delays_hours: number[]; median_first_comment_delay_hours: number | null };
    expect(v.delays_hours).toEqual([720]);
    expect(v.median_first_comment_delay_hours).toBe(720);
  });
});
