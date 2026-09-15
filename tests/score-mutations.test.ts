// score-mutations.test.ts — Б5: контрольные сценарии-инварианты §9
// (мутации фактов на JSON-фикстурах, без сети и клонов). ε=1e-9 на
// монотонности; шкала каждой мутации — как в таблице §9 (категория
// для CI/CD, total для остальных) — см. комментарии.
import { afterAll, describe, expect, test } from "bun:test";
import { compute } from "../src/score/compute";
import { NOW, TestDb, healthyFacts, makeDb, seedScan, withFacts, FactSpec } from "./score-fixtures";

const t: TestDb = makeDb();
afterAll(() => t.close());

const totalOf = (facts: FactSpec[]): number | null => compute(t.db, seedScan(t, facts), "public", { now: NOW }).total;
const catOf = (facts: FactSpec[], key: string): number | null => compute(t.db, seedScan(t, facts), "public", { now: NOW }).categories[key as keyof ReturnType<typeof compute>["categories"]].score;

describe("§9 Security", () => {
  test("+критичная SAST/secrets-находка → Security ↓ заметно, total капится 49", () => {
    const base = totalOf(healthyFacts())!;
    const attacked = compute(
      t.db,
      seedScan(t, withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 5, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true } })),
      "public",
      { now: NOW },
    );
    expect(attacked.categories.security.score!).toBeLessThan(30); // ↓ заметно
    expect(attacked.total!).toBeLessThanOrEqual(49); // жёсткий кап (В2-8)
    expect(attacked.total!).toBeLessThan(base);
  });

  test("SAST crit → resolved → Security ↑, Score ↑", () => {
    const dirty = totalOf(withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 5, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: false } }))!;
    const clean = totalOf(withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 5, high: 0, medium: 0, low: 0 }, resolved_share: 0.95, secrets_critical: false } }))!;
    expect(clean).toBeGreaterThan(dirty);
    const catDirty = catOf(withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 5, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: false } }), "security")!;
    const catClean = catOf(withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 5, high: 0, medium: 0, low: 0 }, resolved_share: 0.95, secrets_critical: false } }), "security")!;
    expect(catClean).toBeGreaterThan(catDirty);
  });
});

describe("§9 Issues: монотонность (ε=1e-9, Q14)", () => {
  // «гнилой трекер» = все субметрики на худших анкерах:
  // stale 100%, resolution≈0, close 180д, первый ответ 30д
  const rottenWorst: FactSpec[] = withFacts(
    healthyFacts(),
    { key: "issues.stats", value: { open: 1e12, closed: 1, median_close_days: 180, stale_90d: 1e12, fetched_count: 1e12 } },
    { key: "issues.comments_sample", value: { issues: 1, with_comments: 1, median_first_comment_delay_hours: 720, delays_hours: [720] } },
  );
  const trackerUnused: FactSpec[] = withFacts(healthyFacts(), { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } });

  test("0/0 → максимально гнилой трекер: Score НЕ растёт (честный = min по построению)", () => {
    const before = totalOf(trackerUnused)!;
    const after = totalOf(rottenWorst)!;
    expect(after).toBeLessThanOrEqual(before + 1e-9);
  });

  test("максимально гнилой трекер → 0/0: Score НЕ растёт", () => {
    const before = totalOf(rottenWorst)!;
    const after = totalOf(trackerUnused)!;
    expect(after).toBeLessThanOrEqual(before + 1e-9);
  });

  test("5 зависших открытых → 0/0 тоже не прибыльно (удаление не поднимает Score)", () => {
    const fiveRotten = withFacts(healthyFacts(), { key: "issues.stats", value: { open: 5, closed: 0, median_close_days: null, stale_90d: 5, fetched_count: 5 } });
    expect(totalOf(trackerUnused)!).toBeLessThanOrEqual(totalOf(fiveRotten)! + 1e-9);
    // и ведение ≥ пустоты: гнилой трекер ≥ минимума категории
    expect(totalOf(fiveRotten)!).toBeGreaterThanOrEqual(totalOf(trackerUnused)! - 1e-9);
  });
});

describe("§9 CI/CD", () => {
  test("cicd.runs 403 (no-data) = отсутствию поля: Score совпадает", () => {
    const with403 = totalOf(withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }))!;
    const withoutRuns = totalOf(healthyFacts().filter((f) => f.key !== "cicd.runs"))!;
    expect(with403).toBe(withoutRuns);
  });

  test("зелёные прогоны → 50% красные: CI/CD ↓ ≥ 15 пунктов", () => {
    const green = catOf(withFacts(healthyFacts(), { key: "cicd.runs", value: { last_status: "success", success_rate: 1.0, duration_p50: 120, runs_count: 20 } }), "cicd")!;
    const red = catOf(withFacts(healthyFacts(), { key: "cicd.runs", value: { last_status: "failed", success_rate: 0.5, duration_p50: 120, runs_count: 20 } }), "cicd")!;
    expect(green - red).toBeGreaterThanOrEqual(15);
  });

  test("ci.yaml с echo-шагом добавлен: CI = 50 ровно; total +9.375 публично (номинал 7.5 × перенормировку 1/0.8)", () => {
    // драфт §9 обещает «total +7.5» — это НОМИНАЛЬНЫЙ вектор (15%×50);
    // фактический публичный сдвиг = 15×50/80 = 9.375 из-за выброшенного
    // веса Security (§4 перенормировка) — см. отчёт воркера: отклонение числа,
    // не семантики; recommend обещает номинальные +7.5 по §8
    const runs403: FactSpec = { key: "cicd.runs", value: { reason: "access" }, status: "no-data" };
    const before = totalOf(withFacts(healthyFacts(), runs403, { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } }))!;
    const afterFacts = withFacts(
      healthyFacts(),
      runs403,
      { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
    );
    const s = compute(t.db, seedScan(t, afterFacts), "public", { now: NOW });
    expect(s.categories.cicd.score!).toBe(50);
    expect(s.total! - before).toBeCloseTo(9.375, 10);
  });
});

describe("§9 анти-накрутка", () => {
  test("+1000 пустых коммитов одной секундой (burst-коллапс): Score Δ ≤ +1", () => {
    const base = healthyFacts();
    const burstTimeline = { events: [...(base[0]!.value as { events: unknown[] }).events] };
    for (let i = 0; i < 1000; i++) {
      burstTimeline.events.push({
        sha: `fake-${i}`,
        author: { name: "alice", email: "alice@example.com", date: "2026-09-01T00:00:00Z" },
        committer: { name: "alice", email: "alice@example.com", date: "2026-09-01T00:00:00Z" },
      });
    }
    const boosted = withFacts(base, { key: "activity.git.timeline", value: burstTimeline }, { key: "activity.git.summary", value: { commits: 1019, authors: 3, committers: 3, robot_commits: 0, robot_ratio: 0, first_committed_at: "2025-10-30T00:00:00Z", last_committed_at: "2026-09-13T00:00:00Z" } });
    const before = totalOf(base)!;
    const after = totalOf(boosted)!;
    expect(after - before).toBeLessThanOrEqual(1);
    expect(after - before).toBeGreaterThanOrEqual(-1e-9); // частота не упала — это не штраф
  });

  test("likes ×100: Score не меняется", () => {
    const scanId = seedScan(t, healthyFacts());
    const before = compute(t.db, scanId, "public", { now: NOW }).total;
    t.db.exec(`UPDATE repos SET likes = likes * 100 WHERE id = ${t.repoId}`);
    const after = compute(t.db, scanId, "public", { now: NOW }).total;
    expect(after).toBe(before);
  });

  test("README 2КБ → 60КБ воды без секций: total Δ ≤ +2 (кап 20КБ; категория +6.3)", () => {
    const thin = withFacts(healthyFacts(), { key: "docs.readme", value: { bytes: 2048, sections: 0, flags: { install: false, build: false, test: false } } });
    const watery = withFacts(healthyFacts(), { key: "docs.readme", value: { bytes: 61_440, sections: 0, flags: { install: false, build: false, test: false } } });
    const dCat = catOf(watery, "documentation")! - catOf(thin, "documentation")!;
    expect(dCat).toBeCloseTo(6.3, 1); // в категории кап держит: 0.45·0.7·0.5·(1.0−0.6)·100
    expect(totalOf(watery)! - totalOf(thin)!).toBeLessThanOrEqual(2);
  });

  test("README удалить: Доки ↓, категория остаётся ок-данными", () => {
    const withReadme = healthyFacts();
    const without = withFacts(
      healthyFacts(),
      { key: "docs.presence", value: { readme: false, license: true, contributing: true, codeowners: false } },
      { key: "docs.readme", value: { present: false } },
    );
    expect(catOf(without, "documentation")!).toBeLessThan(catOf(withReadme, "documentation")!);
    expect(catOf(without, "documentation")!).not.toBeNull();
  });
});

describe("§9 устойчивость канала", () => {
  test("issues-канал 429 (bad-channel) со историей: Score не меняется, stale-маркер", () => {
    const scan1 = seedScan(t, healthyFacts(), 3);
    const base = compute(t.db, scan1, "public", { now: NOW });
    const scan2 = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "issues.stats", value: { reason: "bad-channel" }, status: "bad" },
        { key: "issues.comments_sample", value: { reason: "bad-channel" }, status: "bad" },
      ),
    );
    const s2 = compute(t.db, scan2, "public", { now: NOW });
    expect(s2.total!).toBeCloseTo(base.total!, 9);
    expect(s2.categories.issues.stale).toBe(true);
    expect(new Set(s2.stale)).toEqual(new Set(["issues.stats", "issues.comments_sample"]));
  });

  test("coverage < 0.4 → Score NULL + объяснение каких данных не хватило", () => {
    const s = compute(t.db, seedScan(t, [{ key: "activity.rest", value: { contributors: 1, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] } }]), "public", { now: NOW });
    expect(s.total).toBeNull();
    expect(s.noData.length).toBeGreaterThanOrEqual(4); // каких данных не хватило
  });
});
