// Справочные показатели динамики: ТП-1 «стабильность CI в динамике» и ТП-9
// «динамика создания и закрытия задач» (ТЗ §3.1, «рекомендуется»). Оба – БЕЗ
// веса: индекс, полный Score, покрытие и рекомендации не меняются. Тесты
// поведенческие на данных: числа на фикстурах с известным ответом, каждое
// значение перечисления `Run.Status` спеки, малая выборка – «нет данных», права
// канала CI, старые факты, мутационный инвариант «новое поле не меняет
// оценку», отрисованный MD. Сборщик – на фейковом клиенте, без сети.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTOR_VERSION } from "../src/collectors/facts";
import { collectRestFacts, issueFlow, stabilityOutcome } from "../src/collectors/rest";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { runOutcome } from "../src/collectors/run-status";
import { compute, computeFromFacts, writeScores } from "../src/score/compute";
import { DYNAMICS_OLD_COLLECTOR, DYNAMICS_TRACKER_UNUSED, DYNAMICS_TRUNCATED, backlogValue, ciStabilityValue, issueDynamics } from "../src/score/dynamics";
import { MODEL_VERSION } from "../src/score/model";
import { recommend } from "../src/score/recommend";
import { DISPLAY_ONLY, formatSubmetricValue, submetricShownValue, submetricContext } from "../src/report/submetrics";
import { renderRepoReport } from "../src/report/markdown";
import { getRepoCard } from "../src/api/repos";
import type { AccessResult } from "../src/auth/access";
import { makeApiDb, seedRepo, seedScan, cardFacts, type FactSpec } from "./api-fixtures";
import { fixtureCard } from "./report-fixtures";
import { healthyFacts } from "./score-fixtures";

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0): string => new Date(NOW.getTime() - days * DAY + extraMs).toISOString();
const AT = submetricContext(NOW.toISOString());
const shown = (key: string, entry: { score?: number | null; value?: unknown; note?: string }): string => {
  const [cat, sub] = key.split(".") as [string, string];
  return submetricShownValue(cat, sub, entry, AT);
};

// ---------- фейковый REST-клиент (как в tests/v53m-collectors) ----------

const ok = (json: unknown): ScResponse => ({ status: 200, json, bodyText: "" });
const pathOf = (p: string): string => (p.includes("?") ? p.slice(0, p.indexOf("?")) : p);
type Pages = unknown[] | unknown[][];
/** Список ресурса: массив — одна страница; массив страниц — пагинация next_page_token (бесконечная — `endless`). */
function paged(p: string, key: string, pages: Pages, endless = false): ScResponse {
  if (pages.length === 0 || !Array.isArray(pages[0])) return ok({ [key]: pages });
  const book = pages as unknown[][];
  const m = /page_token=(\d+)/.exec(p);
  const i = m ? Number(m[1]) : 0;
  const more = endless || i + 1 < book.length;
  return ok({ [key]: book[Math.min(i, book.length - 1)], ...(more ? { next_page_token: String(i + 1) } : {}) });
}
function restClient(over: { open?: Pages; progress?: Pages; closed?: Pages; closedEndless?: boolean; runs?: Pages; runsStatus?: number }): ScClient {
  return {
    async get(p: string): Promise<ScResponse> {
      const base = pathOf(p);
      if (base === "/repos/o/r") return ok({ id: "1", name: "r", visibility: "public" });
      if (base === "/repos/o/r/issues" && p.includes("status%3Dopen")) return paged(p, "issues", over.open ?? []);
      if (base === "/repos/o/r/issues" && p.includes("status%3Din_progress")) return paged(p, "issues", over.progress ?? []);
      if (base === "/repos/o/r/issues" && p.includes("status%3Dclosed")) return paged(p, "issues", over.closed ?? [], over.closedEndless);
      if (base.includes("/comments")) return ok({ issue_comments: [] });
      if (base === "/repos/o/r/contributors") return ok({ contributors: [] });
      if (base === "/repos/o/r/releases") return ok({ releases: [] });
      if (base === "/repos/o/r/pulls") return ok({ pull_requests: [] });
      if (base === "/repos/o/r/cicd/runs") return over.runsStatus ? { status: over.runsStatus, json: null, bodyText: "denied" } : paged(p, "runs", over.runs ?? []);
      return { status: 404, json: null, bodyText: "no route" };
    },
    requestCount: () => 0,
  };
}
async function restFacts(client: ScClient, maxPages = 5): Promise<Map<string, { status: string; value: Record<string, unknown> }>> {
  const out = await collectRestFacts(client, "o/r", { commentsTopN: 0, now: NOW, maxPagesPerResource: maxPages });
  return new Map(out.facts.map((f) => [f.key, { status: f.status, value: f.value as Record<string, unknown> }]));
}
const run = (status: string, startedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
  id: `r${startedDaysAgo}-${status}`,
  slug: String(startedDaysAgo),
  status,
  dates: { created_at: ago(startedDaysAgo, -60_000), started_at: ago(startedDaysAgo), finished_at: ago(startedDaysAgo, 120_000) },
  workflows: [{ slug: "build", status }],
  error_messages: status === "failed" ? ["boom: secret path /home/user"] : [],
  user: { slug: "alice", id: "u1" },
  ...extra,
});
const issue = (slug: string, created: string, extra: Record<string, unknown> = {}) => ({ id: slug, slug, created_at: created, updated_at: created, ...extra });

test("версии тура 2: модель 4.5.0-hci, сборщик 6", () => {
  expect(MODEL_VERSION).toBe("4.5.0-hci");
  expect(COLLECTOR_VERSION).toBe(6);
});

// ---------- стабильность CI в динамике ----------

describe("Д1 сборщик: лента recent_runs по перечню Run.Status спеки", () => {
  test("каждое значение enum спеки – своя ветка; незнакомый статус – явная ветка вне ленты", () => {
    const spec = JSON.parse(readFileSync(join(import.meta.dir, "..", "docs", "api-spec", "sourcecraft.swagger.json"), "utf8")) as { definitions: Record<string, { enum?: string[] }> };
    const values = spec.definitions["Run.Status"]!.enum!;
    expect(values.length).toBe(10);
    const expected: Record<string, "success" | "failure" | null> = {
      success: "success",
      failed: "failure",
      timeout: "failure",
      canceled: null,
      skipped: null,
      rejected: null,
      created: null,
      prepared: null,
      processing: null,
      awaiting_approval: null,
    };
    // перечень спеки покрыт целиком, без «прочего» среди известных значений
    expect([...values].sort()).toEqual(Object.keys(expected).sort());
    for (const v of values) {
      expect({ v, outcome: stabilityOutcome(v), cls: runOutcome(v) !== "unknown" }).toEqual({ v, outcome: expected[v]!, cls: true });
    }
    for (const v of ["running", "", null]) expect({ v, outcome: stabilityOutcome(v), cls: runOutcome(v) }).toEqual({ v, outcome: null, cls: "unknown" });
  });

  test("в ленту идут только завершенные с результатом кода, свежие первыми; без сообщений и имен", async () => {
    const all = ["success", "failed", "timeout", "canceled", "skipped", "rejected", "created", "prepared", "processing", "awaiting_approval", "mystery"];
    // статус i стартовал i дней назад; ответ API — в обратном порядке (порядок не доверяем)
    const f = await restFacts(restClient({ runs: all.map((s, i) => run(s, i + 1)).reverse() }));
    const runs = f.get("cicd.runs")!.value;
    expect(runs.recent_runs).toEqual([
      { outcome: "success", at: ago(1, 120_000) },
      { outcome: "failure", at: ago(2, 120_000) },
      { outcome: "failure", at: ago(3, 120_000) },
    ]);
    expect(runs.status_note).toBe("unknown run statuses: mystery");
    const text = JSON.stringify(runs.recent_runs);
    for (const leak of ["boom", "alice", "build", "/home"]) expect(text.includes(leak)).toBe(false);
  });

  test("лента – не больше 20 завершенных; момент – завершение, иначе начало, иначе создание", async () => {
    const many = Array.from({ length: 30 }, (_, i) => run(i % 3 === 0 ? "failed" : "success", i + 1));
    const noFinish = { id: "x", status: "success", dates: { created_at: ago(0.5, -1000), started_at: ago(0.5) } };
    const onlyCreated = { id: "y", status: "failed", dates: { created_at: ago(0.25) } };
    const f = await restFacts(restClient({ runs: [...many, noFinish, onlyCreated] }));
    const trail = f.get("cicd.runs")!.value.recent_runs as { outcome: string; at: string }[];
    expect(trail.length).toBe(20);
    expect(trail[0]).toEqual({ outcome: "failure", at: ago(0.25) });
    expect(trail[1]).toEqual({ outcome: "success", at: ago(0.5) });
    expect(trail[2]).toEqual({ outcome: "failure", at: ago(1, 120_000) });
  });

  test("CI не виден (403) – факта ленты нет, no-data access, как у категории", async () => {
    const f = await restFacts(restClient({ runsStatus: 403 }));
    expect(f.get("cicd.runs")).toEqual({ status: "no-data", value: { reason: "access", detail: "status 403" } });
  });
});

describe("Д1 показатель: доля успешных последних N против предыдущих N", () => {
  const trail = (outcomes: string): { outcome: string; at: string }[] => [...outcomes].map((c, i) => ({ outcome: c === "s" ? "success" : "failure", at: ago(i) }));

  test("числа на фикстурах с известным ответом (окно 10, порог 15 п.п.)", () => {
    expect(ciStabilityValue(trail("sssssssssf" + "ssssssffff"))).toEqual({ trend: "better", recent_share: 0.9, previous_share: 0.6, window: 10 });
    expect(ciStabilityValue(trail("ssssssffff" + "sssssssssf"))).toEqual({ trend: "worse", recent_share: 0.6, previous_share: 0.9, window: 10 });
    // 80% против 70% — 10 п.п., ниже порога: одна смена исхода не тренд
    expect(ciStabilityValue(trail("ssssssssff" + "sssssssfff"))).toEqual({ trend: "same", recent_share: 0.8, previous_share: 0.7, window: 10 });
    // ровно 15 п.п. при окне 10 недостижимо; 20 п.п. — тренд
    expect(ciStabilityValue(trail("ssssssssff" + "ssssssffff"))!.trend).toBe("better");
  });

  test("меньше 20 завершенных – окно пополам; 10 – минимум (окно 5, одна смена – 20 п.п.)", () => {
    expect(ciStabilityValue(trail("ssssss" + "sssss" + "f"))).toEqual({ trend: "better", recent_share: 1, previous_share: 5 / 6, window: 6 });
    expect(ciStabilityValue(trail("sssss" + "ssssf"))).toEqual({ trend: "better", recent_share: 1, previous_share: 0.8, window: 5 });
    // нечетное число: лишний самый старый запуск в сравнение не идет
    expect(ciStabilityValue(trail("sssss" + "sssss" + "f"))).toEqual({ trend: "same", recent_share: 1, previous_share: 1, window: 5 });
  });

  test("малая выборка – «нет данных» с причиной «мало запусков» (незнание), не «без изменений»", () => {
    expect(ciStabilityValue(trail("sssssssss"))).toEqual({ trend: null, few_runs: true, completed: 9, needed: 10 });
    expect(ciStabilityValue([])).toEqual({ trend: null, few_runs: true, completed: 0, needed: 10 });
    expect(shown("cicd.stability", { score: null, value: ciStabilityValue(trail("sssssss")) })).toBe("нет данных, мало запусков (7 завершенных, нужно от 10)");
    expect(shown("cicd.stability", { score: null, value: ciStabilityValue(trail("s")) })).toBe("нет данных, мало запусков (1 завершенный, нужно от 10)");
  });

  test("показ словами по правилам языка UI", () => {
    expect(shown("cicd.stability", { score: null, value: { trend: "better", recent_share: 0.9, previous_share: 0.6, window: 10 } })).toBe(
      "стабильнее, 90% успешных у последних 10 запусков против 60% у 10 до них",
    );
    expect(shown("cicd.stability", { score: null, value: { trend: "same", recent_share: 1, previous_share: 1, window: 5 } })).toBe(
      "без изменений, 100% успешных у последних 5 запусков против 100% у 5 до них",
    );
    expect(shown("cicd.stability", { score: null, value: { trend: "worse", recent_share: 0.5, previous_share: 0.8, window: 10 } })).toBe(
      "хуже, 50% успешных у последних 10 запусков против 80% у 10 до них",
    );
  });

  test("в расчете: справочно, балл null, во всех ветках CI с видимыми запусками", () => {
    const base = new Map(healthyFacts().map((f) => [f.key, f.value]));
    const withTrail = new Map(base).set("cicd.runs", { ...(base.get("cicd.runs") as object), recent_runs: trail("ssssssssss" + "ssssssffff") });
    const cicd = computeFromFacts(withTrail, { scanId: 0, repoId: 0 }, NOW).categories.cicd;
    expect(cicd.submetrics.stability).toEqual({ score: null, value: { trend: "better", recent_share: 1, previous_share: 0.6, window: 10 } });
    expect(DISPLAY_ONLY.has("cicd.stability")).toBe(true);
    // ci.yaml нет — «CI не настроен», а не «нет данных» и не тренд
    const noCi = new Map(withTrail).set("cicd.configs", { paths: [], has_ci_yaml: false, has_steps: false });
    const s = computeFromFacts(noCi, { scanId: 0, repoId: 0 }, NOW).categories.cicd.submetrics.stability!;
    expect(shown("cicd.stability", s)).toBe("CI не настроен");
    // все запуски идут — лента пуста: «мало запусков»
    const pending = new Map(withTrail).set("cicd.runs", { runs_count: 0, runs_total: 3, recent_runs: [] });
    expect(computeFromFacts(pending, { scanId: 0, repoId: 0 }, NOW).categories.cicd.submetrics.stability!.value).toEqual({ trend: null, few_runs: true, completed: 0, needed: 10 });
    // запуски не видны — «запуски недоступны»
    const hidden = new Map(withTrail);
    hidden.delete("cicd.runs");
    expect(shown("cicd.stability", computeFromFacts(hidden, { scanId: 0, repoId: 0 }, NOW).categories.cicd.submetrics.stability!)).toBe("запуски недоступны");
  });
});

// ---------- динамика создания и закрытия задач ----------

describe("Д2 сборщик: поток задач по 30-дневным окнам", () => {
  // окно k (0 — самое старое) покрывает [NOW − 180 + 30k, NOW − 150 + 30k) дней
  const lists = {
    open: [issue("o1", ago(5)), issue("o2", ago(40)), issue("o3", ago(200))],
    progress: [issue("p1", ago(70))],
    closed: [
      issue("a", ago(100), { completed_at: ago(40) }),
      // completed_at нет — дата изменения (как у медианы закрытия)
      issue("b", ago(70), { updated_at: ago(5) }),
      // мгновенно закрытая (30 мин) — ни в созданных, ни в закрытых
      issue("c", ago(40), { completed_at: ago(40, 30 * 60_000) }),
      issue("d", ago(300), { completed_at: ago(130) }),
    ],
  };

  test("числа окон на фикстуре с известным ответом; мгновенно закрытые – отдельно", async () => {
    const f = await restFacts(restClient(lists));
    const flow = f.get("issues.stats")!.value.flow as { window_days: number; windows: { from: string; created: number; closed: number; instant: number }[]; complete_since?: string };
    expect(flow.window_days).toBe(30);
    expect(flow.complete_since).toBeUndefined();
    expect(flow.windows.map((w) => [w.created, w.closed, w.instant])).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [2, 0, 0],
      [1, 1, 1],
      [1, 1, 0],
    ]);
    expect(flow.windows[0]!.from).toBe(ago(180).slice(0, 10));
    expect(flow.windows[5]!.from).toBe(ago(30).slice(0, 10));
    // за 90 дней: создано 4, закрыто 2 — баланс +2 в полосе max(2, 10%) — стабилен
    expect(backlogValue(flow.windows)).toEqual({ created: 4, closed: 2, balance: 2, direction: "stable" });
  });

  test("список уперся в кап страниц – окна раньше границы null, баланс «нет данных» (пометка, не занижение)", async () => {
    const closedPages = [
      [issue("n1", ago(20), { completed_at: ago(10), updated_at: ago(10) })],
      [issue("n2", ago(80), { completed_at: ago(60), updated_at: ago(60) })],
    ];
    const f = await restFacts(restClient({ open: [issue("o", ago(5))], closed: closedPages, closedEndless: true }), 2);
    const flow = f.get("issues.stats")!.value.flow as { windows: { created: number | null; closed: number | null }[]; complete_since?: string };
    expect(flow.complete_since).toBe(ago(60));
    // окна начинаются 180/150/120/90/60/30 дней назад: покрыты только два последних
    expect(flow.windows.map((w) => w.created)).toEqual([null, null, null, null, 0, 2]);
    expect(flow.windows.map((w) => w.closed)).toEqual([null, null, null, null, 1, 1]);
    const d = issueDynamics(f.get("issues.stats")!.value);
    expect(d.backlog_trend).toEqual({ score: null, value: null, note: DYNAMICS_TRUNCATED });
    expect(shown("issues.backlog_trend", d.backlog_trend)).toBe("нет данных, список задач обрезан и 90 дней не покрыты");
    expect(shown("issues.monthly_flow", d.monthly_flow)).toBe("–, –, –, –, 0/1, 2/1 (создано/закрыто за 30 дней, от старых к новым)");
  });

  test("сервер не обещал продолжения – список не обрезан, даже если страниц ровно кап", async () => {
    const f = await restFacts(restClient({ open: [issue("o", ago(5))], closed: [[issue("n1", ago(20), { completed_at: ago(10) })], [issue("n2", ago(80), { completed_at: ago(60) })]] }), 2);
    expect((f.get("issues.stats")!.value.flow as { complete_since?: string }).complete_since).toBeUndefined();
  });

  test("чистая функция: задача вне 180 дней и без дат в окна не попадает", () => {
    const flow = issueFlow({ open: [issue("x", "not a date"), issue("y", ago(181))], closed: [issue("z", ago(10), { completed_at: "bad", updated_at: "bad" })] }, [], NOW);
    expect(flow.windows.map((w) => [w.created, w.closed])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [1, 0],
    ]);
  });
});

describe("Д2 показатель: баланс за 90 дней и направление", () => {
  const w = (created: number, closed: number) => ({ from: "2026-01-01", created, closed, instant: 0 });
  const flow = (...last: [number, number][]) => [w(9, 9), w(9, 9), w(9, 9), ...last.map(([c, d]) => w(c, d))];

  test("числа и направление на фикстурах с известным ответом", () => {
    expect(backlogValue(flow([4, 1], [3, 1], [3, 1]))).toEqual({ created: 10, closed: 3, balance: 7, direction: "growing" });
    expect(backlogValue(flow([1, 4], [1, 3], [0, 3]))).toEqual({ created: 2, closed: 10, balance: -8, direction: "shrinking" });
    // полоса «стабилен»: max(2, 10% оборота): 30 создано, 27 закрыто — +3 при полосе 5,7
    expect(backlogValue(flow([10, 9], [10, 9], [10, 9]))).toEqual({ created: 30, closed: 27, balance: 3, direction: "stable" });
    expect(backlogValue(flow([2, 0], [1, 0], [0, 0]))).toEqual({ created: 3, closed: 0, balance: 3, direction: "growing" });
    expect(backlogValue(flow([0, 0], [0, 0], [0, 0]))).toEqual({ created: 0, closed: 0, balance: 0, direction: "stable" });
  });

  test("показ: знак баланса, слова направления, помесячные числа", () => {
    const d = issueDynamics({ open: 3, closed: 5, flow: { window_days: 30, windows: flow([4, 1], [3, 1], [3, 1]) } });
    expect(shown("issues.backlog_trend", d.backlog_trend)).toBe("бэклог растет, +7 за 90 дней (создано 10, закрыто 3)");
    expect(shown("issues.monthly_flow", d.monthly_flow)).toBe("9/9, 9/9, 9/9, 4/1, 3/1, 3/1 (создано/закрыто за 30 дней, от старых к новым)");
    const s = issueDynamics({ open: 3, closed: 5, flow: { window_days: 30, windows: flow([1, 4], [1, 3], [0, 3]) } });
    expect(shown("issues.backlog_trend", s.backlog_trend)).toBe("бэклог разбирается, −8 за 90 дней (создано 2, закрыто 10)");
    const idle = issueDynamics({ open: 3, closed: 5, flow: { window_days: 30, windows: flow([0, 0], [0, 0], [0, 0]) } });
    // подтвержденное «ничего не происходило» — данные, а не «нет данных»
    expect(shown("issues.backlog_trend", idle.backlog_trend)).toBe("без движения, за 90 дней задачи не создавались и не закрывались");
    const stable = issueDynamics({ open: 3, closed: 5, flow: { window_days: 30, windows: flow([10, 9], [10, 9], [10, 9]) } });
    expect(shown("issues.backlog_trend", stable.backlog_trend)).toBe("бэклог стабилен, +3 за 90 дней (создано 30, закрыто 27)");
  });

  // UX 17.10: «трекер не ведется» → «задачи не ведутся»
  test("задачи не ведутся – тот же статус, что у категории, а не «0 динамики»", () => {
    const d = issueDynamics({ open: 0, closed: 0, flow: { window_days: 30, windows: flow([0, 0], [0, 0], [0, 0]) } });
    expect(d.backlog_trend).toEqual({ score: null, value: null, note: DYNAMICS_TRACKER_UNUSED });
    expect(shown("issues.backlog_trend", d.backlog_trend)).toBe("задачи не ведутся");
    expect(shown("issues.monthly_flow", d.monthly_flow)).toBe("задачи не ведутся");
    const cat = computeFromFacts(new Map([["issues.stats", { open: 0, closed: 0 }]]), { scanId: 0, repoId: 0 }, NOW).categories.issues;
    expect(cat.score).toBe(6);
    expect(Object.keys(cat.submetrics).sort()).toEqual(["backlog_trend", "monthly_flow", "tracker_unused"]);
  });

  test("канал задач недоступен – показателя нет вовсе (категория «нет данных»)", () => {
    const cat = computeFromFacts(new Map(), { scanId: 0, repoId: 0 }, NOW).categories.issues;
    expect(cat).toEqual({ score: null, no_data: "issues channel no-data", submetrics: {} });
  });
});

// ---------- старые факты, пересчет ----------

describe("старые факты (сборщик до 5): «нет данных», пересчет не падает", () => {
  test("без новых полей – оба показателя «нет данных» (незнание), не «без изменений» и не 0", () => {
    const s = computeFromFacts(new Map(healthyFacts().map((f) => [f.key, f.value])), { scanId: 0, repoId: 0 }, NOW);
    expect(s.categories.cicd.submetrics.stability).toEqual({ score: null, value: null, note: DYNAMICS_OLD_COLLECTOR });
    expect(s.categories.issues.submetrics.backlog_trend).toEqual({ score: null, value: null, note: DYNAMICS_OLD_COLLECTOR });
    for (const key of ["cicd.stability", "issues.backlog_trend", "issues.monthly_flow"]) {
      const [cat, sub] = key.split(".") as [string, string];
      const entry = (s.categories as Record<string, { submetrics: Record<string, { score: number | null; value?: unknown; note?: string }> }>)[cat]!.submetrics[sub]!;
      expect({ key, text: shown(key, entry) }).toEqual({ key, text: "появится после следующего анализа" });
    }
  });

  test("пересчет из БД со старыми фактами пишет строку 4.4.0 и не падает; мусорные новые поля – тоже", () => {
    const t = makeApiDb();
    try {
      const garbage: FactSpec[] = cardFacts().map((f) =>
        f.key === "issues.stats" ? { ...f, value: { ...(f.value as object), flow: { windows: [null, 5, { created: "x" }] } } } : f,
      );
      for (const [i, facts] of [cardFacts(), garbage].entries()) {
        const repoId = seedRepo(t, { org: "o", repo: `old${i}` });
        const scanId = seedScan(t, repoId, { facts });
        const scores = compute(t.db, scanId, { now: NOW });
        writeScores(t.db, scores);
        const row = t.db.query("SELECT model_version, categories FROM scores WHERE scan_id = ?").get(scanId) as { model_version: string; categories: string };
        expect(row.model_version).toBe("4.5.0-hci");
        expect(Object.keys(JSON.parse(row.categories).issues.submetrics)).toContain("backlog_trend");
      }
    } finally {
      t.close();
    }
  });
});

// ---------- права: CI виден только участникам ----------

describe("права: стабильность CI подчиняется правам категории CI/CD (Q&A №1)", () => {
  const NO_PAT: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };
  const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
  const trail = Array.from({ length: 20 }, (_, i) => ({ outcome: i % 4 === 0 ? "failure" : "success", at: ago(i) }));

  function cardFor(access: AccessResult, auth: "no-session" | "pat") {
    const t = makeApiDb();
    const facts = cardFacts().map((f) =>
      f.key === "cicd.runs" ? { key: "cicd.runs", source: "rest:cicd", value: { last_status: "success", success_rate: 0.75, duration_p50: 60, runs_count: 20, recent_runs: trail } } : f,
    );
    const repoId = seedRepo(t, { org: "o", repo: "ci" });
    const scanId = seedScan(t, repoId, { facts });
    writeScores(t.db, compute(t.db, scanId, { now: NOW }));
    const card = getRepoCard(t.db, "o", "ci", { access, viewerAuth: auth })!;
    t.close();
    return card;
  }

  test("участник видит показатель с числами", () => {
    const card = cardFor(GRANTED, "pat");
    expect(card.score!.categories.cicd.submetrics.stability).toEqual({ score: null, value: { trend: "same", recent_share: 0.7, previous_share: 0.8, window: 10 } });
  });

  test("без прав – ни показателя, ни ленты запусков в карточке", () => {
    const card = cardFor(NO_PAT, "no-session");
    expect(card.score!.categories.cicd.locked).toBeDefined();
    expect(card.score!.categories.cicd.submetrics).toEqual({});
    const json = JSON.stringify(card);
    expect(json.includes("recent_runs")).toBe(false);
    expect(json.includes("stability")).toBe(false);
    // задачи — публичная категория: динамика видна без прав
    expect(Object.keys(card.score!.categories.issues.submetrics)).toContain("backlog_trend");
  });
});

// ---------- мутационный инвариант: справочные поля не меняют оценку ----------

describe("инвариант: новые поля фактов не меняют индекс, полный Score, покрытие и рекомендации", () => {
  const variants: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["лента из одних успехов и растущий бэклог", { recent_runs: Array.from({ length: 20 }, (_, i) => ({ outcome: "success", at: ago(i) })) }, { flow: { window_days: 30, windows: Array.from({ length: 6 }, () => ({ from: "2026-01-01", created: 9, closed: 0, instant: 0 })) } }],
    ["лента из одних провалов и разбор бэклога", { recent_runs: Array.from({ length: 20 }, (_, i) => ({ outcome: "failure", at: ago(i) })) }, { flow: { window_days: 30, windows: Array.from({ length: 6 }, () => ({ from: "2026-01-01", created: 0, closed: 9, instant: 3 })) } }],
    ["ухудшение CI и обрезанный список", { recent_runs: Array.from({ length: 20 }, (_, i) => ({ outcome: i < 10 ? "failure" : "success", at: ago(i) })) }, { flow: { window_days: 30, windows: Array.from({ length: 6 }, () => ({ from: "2026-01-01", created: null, closed: null, instant: null })), complete_since: ago(1) } }],
    ["малая выборка и пустые окна", { recent_runs: [{ outcome: "success", at: ago(1) }] }, { flow: { window_days: 30, windows: [] } }],
    ["мусор", { recent_runs: "garbage" }, { flow: 42 }],
  ];

  function scored(runsExtra: Record<string, unknown>, statsExtra: Record<string, unknown>) {
    const t = makeApiDb();
    try {
      const facts = healthyFacts().map((f) => ({
        ...f,
        source: f.key.startsWith("cicd.runs") ? "rest:cicd" : f.key.startsWith("issues") ? "rest:issues" : "git",
        value: f.key === "cicd.runs" ? { ...(f.value as object), ...runsExtra } : f.key === "issues.stats" ? { ...(f.value as object), ...statsExtra } : f.value,
      }));
      const repoId = seedRepo(t, { org: "o", repo: "m" });
      const scanId = seedScan(t, repoId, { facts });
      const s = compute(t.db, scanId, { now: NOW });
      const recs = recommend(t.db, scanId, { now: NOW, scores: s });
      const cats = Object.fromEntries(Object.entries(s.categories).map(([k, c]) => [k, c.score]));
      return { index: s.healthcraftIndex, indexCoverage: s.indexCoverage, full: s.repoHealthScore, fullCoverage: s.repoHealthCoverage, cats, noData: s.noData, recs };
    } finally {
      t.close();
    }
  }

  test("все варианты новых полей – те же числа и тот же набор рекомендаций, что без них", () => {
    const base = scored({}, {});
    expect(base.index).not.toBeNull();
    expect(base.full).not.toBeNull();
    for (const [name, runs, stats] of variants) {
      expect({ name, ...scored(runs, stats) }).toEqual({ name, ...base });
    }
  });
});

// ---------- отрисованный MD ----------

describe("отрисованный MD: справочные строки в разделах категорий и приложении Б", () => {
  test("полная карточка: числа, слова, «справочно, в балл не входит»; правила языка", () => {
    const { card, close } = fixtureCard("full");
    try {
      const md = renderRepoReport(card);
      expect(md).toContain(
        "Справочно, в балл не входит: Стабильность CI в динамике – стабильнее, 90% успешных у последних 10 запусков против 70% у 10 до них.",
      );
      expect(md).toContain("Динамика бэклога за 90 дней – бэклог растет, +4 за 90 дней (создано 6, закрыто 2)");
      expect(md).toContain("Поток задач по 30-дневным окнам – 2/1, 1/2, 2/2, 3/1, 2/1, 1/0 (создано/закрыто за 30 дней, от старых к новым)");
      expect(md).toContain("| Стабильность CI в динамике: стабильнее, 90% успешных у последних 10 запусков против 70% у 10 до них | справочно, в балл не входит |");
      expect(md).toContain("| Версия методики | 4.5.0-hci |");
      // новые строки: без длинного тире и без «ё»
      const fresh = md.split("\n").filter((l) => /Стабильность CI|Динамика бэклога|Поток задач по 30-дневным окнам/.test(l));
      expect(fresh.length).toBeGreaterThanOrEqual(5);
      for (const l of fresh) {
        expect({ l, long: l.includes("—"), yo: /ё/i.test(l) }).toEqual({ l, long: false, yo: false });
      }
    } finally {
      close();
    }
  });

  test("без прав на CI – строки стабильности в MD нет; старый сборщик – «нет данных» словами", () => {
    const anon = fixtureCard("anon");
    const fullNull = fixtureCard("full-null");
    try {
      expect(renderRepoReport(anon.card).includes("Стабильность CI")).toBe(false);
      expect(renderRepoReport(fullNull.card)).toContain("Стабильность CI в динамике – появится после следующего анализа.");
    } finally {
      anon.close();
      fullNull.close();
    }
  });

  test("форматтер: пустое значение – «–» (tri-state)", () => {
    for (const key of ["cicd.stability", "issues.backlog_trend", "issues.monthly_flow"]) {
      const [cat, sub] = key.split(".") as [string, string];
      expect(formatSubmetricValue(cat, sub, null, AT)).toBe("–");
    }
  });
});
