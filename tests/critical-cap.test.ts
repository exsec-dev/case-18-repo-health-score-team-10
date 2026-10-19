// Модель 4.5.0: открытые критичные находки AppSec ограничивают Repo Health Score
// значением 69 (верх зоны «требует внимания»). Без капа «2 критические уязвимости
// в зависимостях» у здорового репозитория давали Безопасность 40 и итог 75 – «здоров».
import { describe, expect, test } from "bun:test";
import { computeFromFacts, totalCapFlags, totalCapOf } from "../src/score/compute";
import { CRITICAL_FINDINGS_TOTAL_CAP, MODEL_VERSION, SECRETS_CRITICAL_TOTAL_CAP } from "../src/score/model";
import { factsDeltaEvaluator, recommendationText } from "../src/score/recommend";
import { categoryContributions, contributionsNote, cappedReason } from "../src/web/format";

const now = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Здоровый выдуманный репозиторий (как my-team/backend в документации): индекс 81, полный 82. */
function healthyFacts(appsec: Record<string, unknown>): Map<string, unknown> {
  const events = [];
  for (let i = 0; i < 36; i++) {
    const who = i % 4;
    const e = `dev${who}@example.org`;
    const date = iso(now.getTime() - 3 * DAY - i * 2.3 * DAY);
    events.push({ sha: `s${i}`, author: { name: `Dev ${who}`, email: e, date }, committer: { name: `Dev ${who}`, email: e, date } });
  }
  for (let i = 0; i < 200; i++) {
    const who = i % 4;
    const e = `dev${who}@example.org`;
    const date = iso(now.getTime() - 100 * DAY - i * 3 * DAY);
    events.push({ sha: `o${i}`, author: { name: `Dev ${who}`, email: e, date }, committer: { name: `Dev ${who}`, email: e, date } });
  }
  const ok = new Map<string, unknown>();
  ok.set("activity.git.timeline", { events });
  ok.set("activity.rest", {
    pulls_created_at: Array.from({ length: 8 }, (_, i) => iso(now.getTime() - (5 + i * 9) * DAY)),
    releases_released_at: Array.from({ length: 3 }, (_, i) => iso(now.getTime() - (20 + i * 100) * DAY)),
  });
  ok.set("docs.presence", { readme: true, license: true, contributing: true, codeowners: false, content_checked: true });
  ok.set("docs.readme", { bytes: 6000, sections: 5, flags: { install: true, build: true, test: false } });
  const top = Array.from({ length: 14 }, (_, i) => ({ name: i === 0 ? "src" : `f${i}.txt`, type: i === 0 ? "tree" : "blob" }));
  ok.set("tree.stats", { top_level: top, file_count: 300, loc: 20000, source_loc: 18000, source_files: 150, test_files: 30, source_unread: 0 });
  ok.set("code.todo", { count: 20, fixme: 4, older_180d: 6, todo_files: 10, blamed_files: 10 });
  ok.set("issues.stats", { open: 12, closed: 60, closed_counted: 60, median_close_days: 6, stale_90d: 1 });
  ok.set("issues.comments_sample", { median_first_comment_delay_hours: 65.6 });
  ok.set("cicd.configs", { has_ci_yaml: true, has_steps: true });
  ok.set("cicd.runs", { runs_count: 40, runs_total: 40, success_rate: 0.95, weighted_success_rate: 0.95, duration_p50: 358, last_status: "success" });
  ok.set("appsec.findings", { severity_counts: { critical: 0, high: 0, medium: 2, low: 3 }, resolved_share: 0.8, secrets_critical: false, ...appsec });
  return ok;
}

const input = { scanId: 1, repoId: 1 };

describe("кап Repo Health Score за открытые критичные находки (4.5.0)", () => {
  test("версия модели поднята", () => {
    expect(MODEL_VERSION).toBe("4.6.0-hci");
    expect(CRITICAL_FINDINGS_TOTAL_CAP).toBe(69);
  });

  test("без критичных находок – здоров, кап не действует", () => {
    const s = computeFromFacts(healthyFacts({}), input, now);
    expect(s.repoHealthScore!).toBeGreaterThan(CRITICAL_FINDINGS_TOTAL_CAP);
  });

  test("2 открытые критичные – итог не выше 69, индекс не меняется", () => {
    const clean = computeFromFacts(healthyFacts({}), input, now);
    const crit = computeFromFacts(healthyFacts({ severity_counts: { critical: 2, high: 0, medium: 2, low: 3 } }), input, now);
    expect(crit.categories.security.score).toBe(40);
    expect(crit.repoHealthScore).toBe(CRITICAL_FINDINGS_TOTAL_CAP);
    // публичный индекс AppSec не видит – кап его не касается
    expect(crit.healthcraftIndex).toBe(clean.healthcraftIndex);
  });

  test("утекшие секреты сильнее: кап 49", () => {
    const s = computeFromFacts(healthyFacts({ severity_counts: { critical: 2 }, secrets_critical: true }), input, now);
    expect(s.repoHealthScore).toBe(SECRETS_CRITICAL_TOTAL_CAP);
    expect(totalCapOf(totalCapFlags({ secrets_critical: true, severity_counts: { critical: 1 } }))).toBe(49);
    expect(totalCapOf(totalCapFlags({ severity_counts: { critical: 1 } }))).toBe(69);
    expect(totalCapOf(totalCapFlags({ severity_counts: { high: 3 } }))).toBeNull();
    expect(totalCapOf(totalCapFlags(undefined))).toBeNull();
  });

  test("исправление, которое упирается в кап, объяснено причиной cap-critical", () => {
    const ok = healthyFacts({ severity_counts: { critical: 2, high: 0, medium: 2, low: 3 } });
    const delta = factsDeltaEvaluator(ok, input, now);
    // «добавить CODEOWNERS» поднимает категории, но итог остается на капе 69
    const r = delta("cicd", (f) => f.set("docs.presence", { readme: true, license: true, contributing: true, codeowners: true, content_checked: true }));
    expect(r).toEqual({ delta: 0, reason: "cap-critical" });
  });

  test("текст рекомендации называет оба потолка", () => {
    const t = recommendationText("appsec-critical", { secrets: false, capLimit: 40, gain: true })!;
    expect(t.problem).toContain("не выше 40");
    // 19.10.2026: потолок итога 69 — в эффекте («снимет потолок 69 у Repo Health Score»), а не повтором в причине
    expect(t.expectedImpact).toContain("снимет потолок 69 у Repo Health Score");
    expect(t.expectedImpact).toBe("снимет потолок 40 с категории «Безопасность» и снимет потолок 69 у Repo Health Score");
  });

  test("полоса вкладов: причина потолка по значению", () => {
    const c = categoryContributions(
      [
        { key: "security", title: "Безопасность", score: 40, weight: 20 },
        { key: "code", title: "Состояние кода", score: 95, weight: 80 },
      ],
      69,
    )!;
    expect(c.kind).toBe("capped");
    expect(contributionsNote(c)).toContain("в AppSec открыты критичные находки");
    expect(cappedReason(49)).toBe("AppSec нашел утекшие секреты");
  });
});
