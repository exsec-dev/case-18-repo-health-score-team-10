// В5.3, модель 4.2.0-hci (аудит методики 24.09 — reports/2026-09-24-m53-method-audit.md):
// поведенческие тесты на каждый контрпример аудита. Правило AGENTS.md 21.09:
// число, названное оценкой, закрывается тестом на данных, а не source-assert.
import { describe, expect, test } from "bun:test";
import { computeFromFacts, type Scores } from "../src/score/compute";
import { isRobotAuthor } from "../src/score/robot2";
import { recommendFromFacts } from "../src/score/recommend";
import { noDataReason } from "../src/web/format";
import { NOW, healthyFacts } from "./score-fixtures";

const DAY = 24 * 3600_000;
const iso = (t: number): string => new Date(t).toISOString();

type Patch = Record<string, unknown | undefined>;

/** Здоровые факты с заменой по ключу; `undefined` — факта нет (no-data). */
function facts(patch: Patch = {}): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}

const score = (ok: Map<string, unknown>, extra: { emptyRepo?: boolean } = {}): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0, ...extra }, NOW);
const GIT_KEYS = ["activity.git.timeline", "activity.git.summary", "docs.presence", "docs.readme", "tree.stats", "code.todo", "cicd.configs"];
const noGit = (): Patch => Object.fromEntries(GIT_KEYS.map((k) => [k, undefined]));

describe("М1.1: репозиторий без единого коммита — оценка 0 (Q&A №13)", () => {
  test("git подтвердил пустоту: индекс 0, а не 13 из счетчиков REST и пустого трекера", () => {
    const ok = facts({ ...noGit(), "issues.stats": { open: 0, closed: 0 }, "activity.rest": { contributors: 0, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] } });
    const before = score(ok);
    expect(before.healthcraftIndex).toBeNull(); // без признака пустоты — мало данных, но не 13
    const s = score(ok, { emptyRepo: true });
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
  });

  test("пустому репо — один совет «добавьте код»", () => {
    const recs = recommendFromFacts(facts({ ...noGit(), "issues.stats": { open: 0, closed: 0 } }), {
      delta: () => ({ delta: 0, reason: null }),
      issuesScore: 6,
      codeEmpty: true,
    });
    expect(recs.map((r) => r.ruleId)).toEqual(["add-code"]);
  });
});

describe("М1.2: категория получает число только при якорной подметрике", () => {
  test("Активность без истории коммитов — нет данных, а не 100 по одним MR и релизам", () => {
    const s = score(facts(noGit()));
    expect(s.categories.activity.score).toBeNull();
    // 4.3.0 (Н4, D6): причина — из git-факта: не прочитан (а не «истории нет»)
    expect(noDataReason("activity", s.categories.activity.no_data)).toContain("Репозиторий не удалось прочитать");
  });

  test("git недоступен (таймаут клона): индекс не считается по одним задачам", () => {
    expect(score(facts(noGit())).healthcraftIndex).toBeNull();
  });

  test("Состояние кода без строк кода — нет данных, а не 100 за порядок в корне", () => {
    const s = score(facts({ "tree.stats": { top_level: [{ name: "README.md", type: "blob" }], file_count: 1, bytes: 10, loc: 0 }, "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } }));
    expect(s.categories.code.score).toBeNull();
    // 4.3.0 (Н3, Н4): в корне один README — «кода нет», причина по виду
    expect(noDataReason("code", s.categories.code.no_data)).toContain("нет файлов кода");
  });

  test("Безопасность при критичных находках без LOC и без доли закрытых — нет данных, а не 100", () => {
    const appsec = { severity_counts: { critical: 40, high: 100, medium: 0, low: 0 }, resolved_share: null, secrets_critical: false };
    const s = score(facts({ "appsec.findings": appsec, "tree.stats": { top_level: [], file_count: 10, bytes: 10 } }));
    expect(s.categories.security.score).toBeNull();
    expect(noDataReason("security", s.categories.security.no_data)).toContain("размер кода неизвестен");
  });

  test("история прочитана, людей нет — свежесть худшая (данные), категория считается", () => {
    const bots = Array.from({ length: 5 }, (_, i) => ({
      sha: `b${i}`,
      author: { name: "dependabot[bot]", email: "bot@x.example", date: iso(NOW.getTime() - (i + 1) * DAY) },
      committer: { name: "GitHub", email: "noreply@github.com", date: iso(NOW.getTime() - (i + 1) * DAY) },
    }));
    const s = score(facts({ "activity.git.timeline": { events: bots } }));
    expect(s.categories.activity.submetrics.fresh!.score).toBe(0);
    expect(s.categories.activity.score).not.toBeNull();
  });
});

describe("монотонность: улучшение факта не снижает оценку", () => {
  test("М1.3: закрыли последнюю открытую задачу — Задачи и индекс не падают", () => {
    const before = score(facts({ "issues.stats": { open: 1, closed: 9, median_close_days: 30, stale_90d: 0, fetched_count: 10 } }));
    const after = score(facts({ "issues.stats": { open: 0, closed: 10, median_close_days: 30, stale_90d: 0, fetched_count: 10 } }));
    expect(after.categories.issues.score!).toBeGreaterThanOrEqual(before.categories.issues.score!);
    expect(after.healthcraftIndex!).toBeGreaterThanOrEqual(before.healthcraftIndex!);
  });

  test("М1.4: добавили свежий TODO — Состояние кода не растет", () => {
    const zero = score(facts({ "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } }));
    const one = score(facts({ "code.todo": { count: 1, fixme: 0, older_180d: 0, todo_files: 1, blamed_files: 1 } }));
    expect(one.categories.code.score!).toBeLessThanOrEqual(zero.categories.code.score!);
  });

  test("М1.5: одна старая пометка не обрушивает категорию (доля от не меньше 5 пометок)", () => {
    const one = score(facts({ "code.todo": { count: 1, fixme: 0, older_180d: 1, todo_files: 1, blamed_files: 1 } }));
    expect(one.categories.code.submetrics.old_share!.value).toBeCloseTo(0.2, 6);
    expect(one.categories.code.score!).toBeGreaterThan(85);
  });

  test("М1.12: закрыть все находки AppSec — максимум, не 98,5", () => {
    const s = score(facts({ "appsec.findings": { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 1, secrets_critical: false } }));
    expect(s.categories.security.submetrics.resolved!.score).toBe(1);
  });

  test("М1.10: пустой README ниже README на 499 байт", () => {
    const readme = (bytes: number) => score(facts({ "docs.readme": { bytes, sections: 0, flags: {} } })).categories.documentation.score!;
    expect(readme(0)).toBeLessThan(readme(499));
  });
});

describe("анти-накрутка", () => {
  test("М1.6: бурст из 100 коммитов с разными адресами не добавляет авторов", () => {
    const base = facts();
    const tl = base.get("activity.git.timeline") as { events: unknown[] };
    const burstAt = iso(NOW.getTime() - DAY);
    const burst = Array.from({ length: 100 }, (_, i) => ({
      sha: `s${i}`,
      author: { name: `u${i}`, email: `u${i}@spam.example`, date: burstAt },
      committer: { name: "sync", email: "sync@spam.example", date: burstAt },
    }));
    const before = score(base);
    const after = score(facts({ "activity.git.timeline": { events: [...tl.events, ...burst] } }));
    expect(after.categories.activity.submetrics.contributors!.value).toBe(before.categories.activity.submetrics.contributors!.value);
    expect(after.healthcraftIndex! - before.healthcraftIndex!).toBeLessThanOrEqual(1);
  });

  test("М1.9: одна закрытая задача не дает трекеру 97,5 — балл сжат к минимуму", () => {
    const s = score(facts({ "issues.stats": { open: 0, closed: 1, median_close_days: 0, stale_90d: 0, fetched_count: 1 }, "issues.comments_sample": { issues: 0, with_comments: 0, median_first_comment_delay_hours: null, delays_hours: [] } }));
    expect(s.categories.issues.score!).toBeLessThan(20);
    expect(s.categories.issues.score!).toBeGreaterThanOrEqual(6);
  });

  test("М1.9 → Р2: от 10 закрытых задач сжатия нет", () => {
    // 4.3.0 (Р2): размер выборки — закрытые задачи, открытые в него не входят
    const stats = { open: 2, closed: 10, median_close_days: 5, stale_90d: 0, fetched_count: 12 };
    const s = score(facts({ "issues.stats": stats }));
    expect(s.categories.issues.score!).toBeGreaterThan(80);
  });

  test("М1.11: дата автора из будущего не делает репо свежим", () => {
    const future = [{ sha: "f", author: { name: "h", email: "h@x.example", date: "2037-04-25T00:00:00Z" }, committer: { name: "h", email: "h@x.example", date: "2037-04-25T00:00:00Z" } }];
    const s = score(facts({ "activity.git.timeline": { events: future } }));
    expect(s.categories.activity.submetrics.fresh!.score).toBe(0);
  });
});

describe("М1.7: приватная почта GitHub — человек", () => {
  test("users.noreply.github.com без маркера бота — не робот; бот на нем — робот", () => {
    expect(isRobotAuthor("Иван", "123+ivan@users.noreply.github.com")).toBe(false);
    expect(isRobotAuthor("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBe(true);
  });
});

describe("М1.8: CI с видимыми запусками", () => {
  const ci = (runs: unknown, configs: unknown = { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true }) =>
    score(facts({ "cicd.runs": runs, "cicd.configs": configs, "appsec.findings": { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 1, secrets_critical: false } }));

  test("заглушка ci.yaml и 0 запусков при доступе — данные «не запускался», ниже настоящего CI с 50% зеленых", () => {
    const stub = ci({ last_status: null, success_rate: null, duration_p50: null, runs_count: 0, weighted_success_rate: null });
    const half = ci({ last_status: "failed", success_rate: 0.5, duration_p50: 300, runs_count: 10, weighted_success_rate: 0.5 });
    const none = ci({ last_status: null, success_rate: null, duration_p50: null, runs_count: 0, weighted_success_rate: null }, { paths: [], has_ci_yaml: false, has_steps: false });
    expect(stub.categories.cicd.score).toBeCloseTo(40, 6);
    expect(stub.repoHealthScore!).toBeLessThan(half.repoHealthScore!);
    expect(stub.repoHealthScore!).toBeGreaterThanOrEqual(none.repoHealthScore!);
  });

  test("запуски невидимы (нет прав) — нет данных, как решено 23.09", () => {
    expect(ci(undefined).categories.cicd.score).toBeNull();
  });

  test("все запуски старше года — pass_rate 0 («за год не запускался»), не 100 по старым зеленым", () => {
    const s = ci({ last_status: "success", success_rate: 1, duration_p50: 60, runs_count: 5, weighted_success_rate: null });
    expect(s.categories.cicd.submetrics.pass_rate!.score).toBe(0);
  });

  test("легаси-факт без поля взвешенной доли — простая доля, как раньше", () => {
    const s = ci({ last_status: "success", success_rate: 1, duration_p50: 60, runs_count: 5 });
    expect(s.categories.cicd.submetrics.pass_rate!.score).toBe(1);
  });

  test("М2.1: ci.yaml не разобран — нет данных, а не «CI без шагов = 0»", () => {
    const s = ci(undefined, { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: false, steps_note: "ci.yaml parse failed: bad mapping line" });
    expect(s.categories.cicd.score).toBeNull();
    expect(noDataReason("cicd", s.categories.cicd.no_data)).toContain("не удалось разобрать");
  });
});

describe("М1.13: лицензия под иным именем", () => {
  test.each(["COPYING", "LICENSE-MIT", "License.Apache", "UNLICENSE", "LICENSES"])("%s — лицензия есть", (name) => {
    const s = score(facts({
      "docs.presence": { readme: true, license: false, contributing: true, codeowners: false },
      "tree.stats": { top_level: [{ name, type: "blob" }], file_count: 300, bytes: 2_000_000, loc: 50_000 },
    }));
    expect(s.categories.documentation.submetrics.license!.score).toBe(1);
  });

  test("LICENSING.md и NOTICE — не лицензия", () => {
    for (const name of ["LICENSING.md", "NOTICE"]) {
      const s = score(facts({
        "docs.presence": { readme: true, license: false, contributing: true, codeowners: false },
        "tree.stats": { top_level: [{ name, type: "blob" }], file_count: 300, bytes: 2_000_000, loc: 50_000 },
      }));
      expect(s.categories.documentation.submetrics.license!.score).toBe(0);
    }
  });
});
