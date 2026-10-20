// Модель 4.7.0: худший конец каждой шкалы — 0, баллов за отсутствие практики нет.
// Новые ветки расчета: авторы-люди 0, автор без адреса, длительность CI без
// успешных запусков и ее подписи.
import { describe, expect, test } from "bun:test";
import * as model from "../src/score/model";
import { compute, computeFromFacts, type Scores } from "../src/score/compute";
import { recommend } from "../src/score/recommend";
import { APPSEC_NEVER_SCANNED } from "../src/collectors/appsec";
import { submetricContext, submetricNote, submetricShownValue } from "../src/report/submetrics";
import { adjustmentText } from "../src/report/sections";
import { healthyFacts, makeDb, seedScan } from "./score-fixtures";
import { cardFacts, makeApiDb, seedRepo, seedScan as apiSeedScan, seedScore } from "./api-fixtures";
import { getRepoCard } from "../src/api/repos";
import { appsecNoDataFact } from "../src/jobs/runner";
import { categoriesSummary } from "../src/web/cardView";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;
const score = (ok: Map<string, unknown>): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0 }, NOW);
const ctx = submetricContext(NOW.toISOString());

function timeline(authors: { name: string; email: string }[]) {
  const events = Array.from({ length: 12 }, (_, i) => {
    const a = authors[i % authors.length]!;
    const date = new Date(NOW.getTime() - (2 + i * 5) * DAY).toISOString();
    return { sha: `c${i}`, author: { ...a, date }, committer: { ...a, date } };
  });
  return new Map<string, unknown>([["activity.git.timeline", { events }]]);
}

const ci = (runs: Record<string, unknown>) =>
  score(
    new Map<string, unknown>([
      ["cicd.configs", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true }],
      ["cicd.runs", runs],
    ]),
  ).categories.cicd;

describe("4.7.0: худший конец шкал", () => {
  test("у каждой таблицы порогов минимум 0", () => {
    const tables = Object.entries(model).filter(
      ([, v]) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "object" && a !== null && "x" in a && "y" in a),
    ) as [string, model.Anchor[]][];
    expect(tables.length).toBeGreaterThanOrEqual(15);
    for (const [name, anchors] of tables) expect([name, Math.min(...anchors.map((a) => a.y))]).toEqual([name, 0]);
    expect(model.contributorsScore(1)).toBe(0);
    expect(model.commitsPerMonthScore(0)).toBe(0);
    expect(model.ISSUES_TRACKER_UNUSED).toBe(0);
  });
});

describe("4.7.0: авторы", () => {
  test("история прочитана, людей нет — число авторов 0 входит в балл, а не выпадает", () => {
    const s = score(timeline([{ name: "dependabot[bot]", email: "dependabot[bot]@users.noreply.github.com" }]));
    expect(s.categories.activity.submetrics.contributors).toMatchObject({ score: 0, value: 0 });
    expect(s.categories.activity.score).toBe(0);
  });

  test("автор без адреса считается по имени, как в bus factor", () => {
    const s = score(timeline([{ name: "Ann", email: "" }, { name: "Bob", email: "" }]));
    expect(s.categories.activity.submetrics.contributors!.value).toBe(2);
    expect(s.derived.busFactor).toBe(1);
  });
});

describe("4.7.0: длительность CI без успешных запусков", () => {
  test("CI не запускался — длительность 0 и та же подпись, что у доли успешных", () => {
    const c = ci({ last_status: null, success_rate: null, duration_p50: null, runs_count: 0, runs_total: 0, weighted_success_rate: null });
    expect(c.score).toBeCloseTo(30, 9);
    expect(c.submetrics.duration).toEqual({ score: 0, value: null, note: "no runs" });
    expect(submetricShownValue("cicd", "duration", c.submetrics.duration!, ctx, c.submetrics)).toBe("CI не запускался");
  });

  test("запуски есть, успешных нет — длительность 0, «успешных запусков нет»", () => {
    const c = ci({ last_status: "failure", success_rate: 0, duration_p50: null, runs_count: 6, runs_total: 6, weighted_success_rate: 0 });
    expect(c.submetrics.duration).toEqual({ score: 0, value: null, note: "no successful runs" });
    expect(submetricShownValue("cicd", "duration", c.submetrics.duration!, ctx, c.submetrics)).toBe("успешных запусков нет");
  });

  test("успешные есть, но без дат — длительность вне расчета, а не 0", () => {
    const c = ci({ last_status: "success", success_rate: 0.5, duration_p50: null, runs_count: 6, runs_total: 6, weighted_success_rate: 0.5 });
    expect(c.submetrics.duration!.score).toBeNull();
  });

  test("итог раздела «Категории» не пишет «сборка идет долго», если успешных сборок нет", () => {
    const c = ci({ last_status: "failure", success_rate: 0, duration_p50: null, runs_count: 6, runs_total: 6, weighted_success_rate: 0 });
    const card = {
      markers: { codeEmpty: false },
      score: { computedAt: NOW.toISOString(), categories: { documentation: { score: 90, submetrics: {} }, cicd: c } },
    };
    const text = categoriesSummary(card as never)!;
    expect(text).toContain("CI/CD: сборки часто завершаются ошибкой.");
    expect(text).not.toContain("идет долго");
  });
});

const issues = (stats: Record<string, unknown>) => score(new Map<string, unknown>([["issues.stats", stats]])).categories.issues;

describe("4.7.0: выборка задач во времени", () => {
  const ten = { open: 0, closed: 10, closed_counted: 10, median_close_days: 0.05, stale_90d: 0 };

  test("10 задач, закрытых за один день, дают треть балла, а не 100", () => {
    const burst = issues({ ...ten, closed_days: 1 });
    expect(burst.score).toBeCloseTo(100 / 3, 6);
    expect(burst.adjustment).toMatchObject({ kind: "small-sample", n: 10, days: 1, daysFull: 3 });
    expect(adjustmentText(burst as never)).toBe("Задачи закрывали только за 1 день, а для надежной оценки нужно 3 разных дня – балл снижен с 100 до 33,3.");
  });

  test("закрытия в 3 разных дня — полный балл; у старых фактов без поля поправки нет", () => {
    expect(issues({ ...ten, closed_days: 3 }).score).toBeCloseTo(100, 6);
    expect(issues(ten).score).toBeCloseTo(100, 6);
  });

  test("больше дней закрытия — не ниже балл; числом задач и днями держится меньшее", () => {
    const by = [1, 2, 3, 4].map((d) => issues({ ...ten, closed_days: d }).score!);
    for (let i = 1; i < by.length; i++) expect(by[i]!).toBeGreaterThanOrEqual(by[i - 1]! - 1e-9);
    const five = issues({ open: 0, closed: 5, closed_counted: 5, median_close_days: 1, stale_90d: 0, closed_days: 1 });
    expect(five.score).toBeCloseTo(100 / 3, 6);
    expect(issues({ open: 0, closed: 2, closed_counted: 2, median_close_days: 1, stale_90d: 0, closed_days: 2 }).adjustment).not.toHaveProperty("days");
  });
});

describe("4.7.0: релизы засчитываются у живого проекта", () => {
  const withReleases = (lastHumanDaysAgo: number) => {
    const ok = timeline([{ name: "Ann", email: "ann@example.org" }]);
    const events = (ok.get("activity.git.timeline") as { events: { author: { date: string }; committer: { date: string } }[] }).events;
    for (const e of events) {
      const d = new Date(new Date(e.author.date).getTime() - lastHumanDaysAgo * DAY).toISOString();
      e.author.date = d;
      e.committer.date = d;
    }
    ok.set("activity.rest", { pulls_created_at: [], releases_released_at: Array.from({ length: 6 }, (_, i) => new Date(NOW.getTime() - (10 + i * 20) * DAY).toISOString()) });
    return score(ok).categories.activity.submetrics.releases_12m!;
  };

  test("коммит человека за год есть — релизы считаются", () => {
    expect(withReleases(0).score).toBe(1);
  });

  test("за год нет коммитов людей — автоматические релизы не засчитаны", () => {
    const r = withReleases(500);
    expect(r).toMatchObject({ score: 0, value: 6 });
    expect(submetricNote("activity", "releases_12m", r.note)).toEqual({ remark: "Релизы не засчитаны: за год нет коммитов людей." });
  });
});

describe("4.7.0: AppSec ни разу не запускался", () => {
  test("подтвержденное отсутствие: Безопасность 0, совет «Запустите проверку AppSec»", () => {
    const t = makeDb();
    try {
      const facts = healthyFacts().filter((f) => f.key !== "appsec.findings");
      const never = seedScan(t, [...facts, { key: "appsec.findings", value: { reason: "no-scan", detail: APPSEC_NEVER_SCANNED }, status: "no-data" }]);
      const s = compute(t.db, never, { now: NOW });
      expect(s.categories.security).toMatchObject({ score: 0, submetrics: { scan_missing: { score: 0 } } });
      const rec = recommend(t.db, never, { scores: s }).find((r) => r.ruleId === "connect-appsec")!;
      expect(rec.action).toBe("Запустите проверку AppSec");
      // нет прав или скан не завершен — по-прежнему «нет данных»
      for (const value of [{ reason: "access" }, { reason: "no-scan", detail: "latest scan is not finished yet (timeFinished is null)" }]) {
        const id = seedScan(t, [...facts, { key: "appsec.findings", value, status: "no-data" }]);
        expect(compute(t.db, id, { now: NOW }).categories.security.score).toBeNull();
      }
    } finally {
      t.close();
    }
  });
});

describe("4.7.0: ci.yaml не разобран, запуски видны", () => {
  test("CI оценивается по запускам, конфигурация вне расчета", () => {
    const c = score(
      new Map<string, unknown>([
        ["cicd.configs", { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: null, steps_note: "yaml parse error" }],
        ["cicd.runs", { last_status: "success", success_rate: 1, duration_p50: 60, runs_count: 10, runs_total: 10, weighted_success_rate: 1 }],
      ]),
    ).categories.cicd;
    expect(c.score).toBeCloseTo(100, 6);
    expect(c.submetrics.config!.score).toBeNull();
    expect(submetricShownValue("cicd", "config", c.submetrics.config!, ctx, c.submetrics)).toBe("ci.yaml не удалось разобрать");
    expect(submetricNote("cicd", "config", c.submetrics.config!.note)).toEqual({ remark: "Файл ci.yaml не удалось разобрать – CI оценен по запускам." });
  });
});

describe("4.7.0: риски называются рисками", () => {
  test("один автор, без предложений изменений и релизов — итог карточки называет риск", () => {
    const sub = (score: number) => ({ score, value: 0 });
    const card = {
      markers: { codeEmpty: false },
      score: {
        computedAt: NOW.toISOString(),
        categories: {
          documentation: { score: 90, submetrics: {} },
          activity: { score: 35, submetrics: { fresh: sub(1), freq: sub(0.5), contributors: { score: 0, value: 1 }, pulls_90d: sub(0), releases_12m: sub(0) } },
        },
      },
    };
    expect(categoriesSummary(card as never)).toBe("Сильнее всего – документация. Слабее всего – активность: проект держится на одном человеке и изменения вносятся без предложений изменений и ревью.");
  });
});

describe("4.7.0: ревью 2 — AppSec не запускался на карточке и при 404 без прав", () => {
  test("карточка показывает тот же 0, что сохраненная оценка, и совет «Запустите проверку AppSec»", () => {
    const t = makeApiDb();
    try {
      const id = seedRepo(t, { org: "ns", repo: "never" });
      const facts = cardFacts().filter((f) => f.key !== "appsec.findings");
      const scan = apiSeedScan(t, id, { facts: [...facts, { key: "appsec.findings", value: { reason: "no-scan", detail: APPSEC_NEVER_SCANNED }, status: "no-data" }] });
      seedScore(t, id, scan, { total: 60 });
      const card = getRepoCard(t.db, "ns", "never", { access: { cicd: "granted", appsec: "granted", repo: "granted" } })!;
      expect(card.score!.categories.security).toMatchObject({ score: 0, submetrics: { scan_missing: { score: 0 } } });
      expect(card.recommendations.some((r) => r.action === "Запустите проверку AppSec")).toBe(true);
    } finally {
      t.close();
    }
  });

  test("404 «проверка не запускалась» засчитывается, только если права подтверждает CI или приватный репо", () => {
    const never = { reason: "no-scan", detail: APPSEC_NEVER_SCANNED };
    const runsOk = [{ key: "cicd.runs", category: "cicd", value: {}, status: "ok", source: "rest", collectedAt: "" }] as never[];
    const reasonOf = (f: { value: unknown }) => (f.value as { reason: string }).reason;
    expect(reasonOf(appsecNoDataFact(never, [], "public", ""))).toBe("access");
    expect(reasonOf(appsecNoDataFact(never, runsOk, "public", ""))).toBe("no-scan");
    expect(reasonOf(appsecNoDataFact(never, [], "private", ""))).toBe("no-scan");
    // скан не завершен — как было
    expect(reasonOf(appsecNoDataFact({ reason: "no-scan", detail: "latest scan is not finished yet" }, [], "public", ""))).toBe("no-scan");
  });
});

describe("4.7.0: ревью 2 — CI и задачи на границах", () => {
  const ciWith = (configs: Record<string, unknown>, runs: Record<string, unknown>) =>
    score(new Map<string, unknown>([["cicd.configs", configs], ["cicd.runs", runs]])).categories.cicd;
  const parsed = { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true };
  const broken = { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: null, steps_note: "yaml parse error" };

  test("незнакомые статусы запусков — «нет данных», а не 30", () => {
    expect(ciWith(parsed, { runs_count: 0, runs_total: 3, status_note: "unknown run statuses: weird" }).score).toBeNull();
  });

  test("неразобранный ci.yaml без завершенных запусков — «нет данных», а не 0", () => {
    expect(ciWith(broken, { runs_count: 0, runs_total: 0, weighted_success_rate: null }).score).toBeNull();
    expect(ciWith(broken, { runs_count: 0, runs_total: 2 }).score).toBeNull();
  });

  test("0 дней закрытия при засчитанных задачах — дни неизвестны, поправки нет", () => {
    expect(issues({ open: 0, closed: 10, closed_counted: 10, median_close_days: 1, stale_90d: 0, closed_days: 0 }).score).toBeCloseTo(100, 6);
  });

  test("фразы итога по значению: CI без запусков, нет людей, релизы не засчитаны", () => {
    const c = ciWith(parsed, { runs_count: 0, runs_total: 0, weighted_success_rate: null });
    const ciCard = { markers: { codeEmpty: false }, score: { computedAt: NOW.toISOString(), categories: { documentation: { score: 90, submetrics: {} }, cicd: c } } };
    expect(categoriesSummary(ciCard as never)).toContain("CI/CD: CI не запускается.");
    const act = {
      score: 10,
      submetrics: { fresh: { score: 1, value: null }, freq: { score: 1, value: 30 }, contributors: { score: 0, value: 0 }, releases_12m: { score: 0, value: 6, note: "releases not counted — no human commits within a year" } },
    };
    const actCard = { markers: { codeEmpty: false }, score: { computedAt: NOW.toISOString(), categories: { documentation: { score: 90, submetrics: {} }, activity: act } } };
    const text = categoriesSummary(actCard as never)!;
    expect(text).toContain("в истории нет коммитов людей");
    expect(text).not.toContain("нет выпусков");
  });
});
