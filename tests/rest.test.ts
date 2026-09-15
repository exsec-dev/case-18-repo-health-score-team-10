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
    [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
    [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
    [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
    [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
    [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
    [(p) => get(p).includes("/comments"), ok(commentsFx)],
  ];
  return routerClient(table);
}

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

    expect(by.size).toBe(4);
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
    expect(v("cicd.runs").duration_p50).toBeGreaterThan(20); // фиксстура: ~22-24с ран

    // метa: title/language/likes/last_activity
    expect(out.repoMeta).not.toBeNull();
    expect(out.repoMeta!.title).toBe("dozzle-plus");
    expect(out.repoMeta!.likes).toBe(25); // rating.value 25
    expect(out.channelErrors.length).toBe(0);
    // comments: 3 issues × 1 запрос
    const commentCalls = client.calls.filter((p) => p.includes("/comments")).length;
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
      [(p) => get(p) === "/repos/o/r/contributors", ok(contributorsFx)],
      [(p) => get(p) === "/repos/o/r/releases", ok(releasesFx)],
      [(p) => get(p) === "/repos/o/r/pulls", ok(pullsFx)],
      [(p) => get(p) === "/repos/o/r/cicd/runs", ok(runsOwnFx)],
      [(p) => get(p) === "/repos/o/r/rating", ok(ratingFx)],
      [(p) => p.includes("/comments"), ok(synth)],
    ]);
    const out = await collectRestFacts(patched, "o/r", { commentsTopN: 1 });
    const sample = out.facts.find((f) => f.key === "issues.comments_sample")!;
    const val = sample.value as { issues: number; with_comments: number; delays_hours: number[] };
    expect(val.issues).toBe(1);
    expect(val.with_comments).toBe(1);
    expect(val.delays_hours[0]).toBe(2);
  });
});
