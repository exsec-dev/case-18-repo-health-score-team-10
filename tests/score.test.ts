// score.test.ts — Б3: модель (анкеры §3, формулы, ISSUES floor) +
// compute (категории, tri-state перенормировка, coverage/NULL, CI-cap,
// secrets-кап, bad-channel stale-замещение, идемпотентность записи).
// Ручная арифметика ожиданий — в комментариях против проверок.
import { afterAll, describe, expect, test } from "bun:test";
import {
  CLOSE_DAYS,
  FRESH_MONTHS,
  ISSUES_TRACKER_UNUSED,
  commitsPerMonthScore,
  contributorsScore,
  anchorScore,
  anchorScoreLog,
  PULLS_90D,
} from "../src/score/model";
import { compute, writeScores } from "../src/score/compute";
import { NOW, TestDb, healthyFacts, makeDb, seedScan, withFacts } from "./score-fixtures";

describe("модель: анкерные таблицы и формулы (§3)", () => {
  test("кусочно-линейная интерполяция + плоские края", () => {
    expect(anchorScore(FRESH_MONTHS, 1)).toBe(1.0);
    expect(anchorScore(FRESH_MONTHS, 0.2)).toBe(1.0); // плоско ниже первого
    expect(anchorScore(FRESH_MONTHS, 3.5)).toBeCloseTo(0.85, 10); // середина 1..6
    expect(anchorScore(FRESH_MONTHS, 36)).toBe(0.1); // плоско выше последнего
    expect(anchorScore(CLOSE_DAYS, 2)).toBe(1.0);
    expect(anchorScore(CLOSE_DAYS, 180)).toBe(0);
    expect(anchorScore(CLOSE_DAYS, 1000)).toBe(0);
  });

  test("commits/мес: узлы сходятся с формулой (0→0, 1→0.20, 5→0.52, 30→1.0, выше плоско)", () => {
    expect(commitsPerMonthScore(0)).toBe(0);
    expect(commitsPerMonthScore(1)).toBeCloseTo(0.2018, 3);
    expect(commitsPerMonthScore(5)).toBeCloseTo(0.5217, 3);
    expect(commitsPerMonthScore(30)).toBeCloseTo(1.0, 10);
    expect(commitsPerMonthScore(500)).toBe(1.0);
  });

  test("contributors: 1→0.2 (соло-пол), 10→0.6, 100→1.0, выше плоско", () => {
    expect(contributorsScore(1)).toBeCloseTo(0.2, 10);
    expect(contributorsScore(10)).toBeCloseTo(0.6, 10);
    expect(contributorsScore(100)).toBe(1.0);
    expect(contributorsScore(5000)).toBe(1.0);
  });

  test("лог-анкеры: x=0 → первый y (pulls 0→0.2)", () => {
    expect(anchorScoreLog(PULLS_90D, 0)).toBe(0.2);
    expect(anchorScoreLog(PULLS_90D, 5)).toBe(0.6);
    expect(anchorScoreLog(PULLS_90D, 30)).toBe(1.0);
    expect(anchorScoreLog(PULLS_90D, 100)).toBe(1.0);
  });

  test("ISSUES_TRACKER_UNUSED выводится из анкеров (≈6, §5.3)", () => {
    // 0.3·0.1(stale) + 0.3·0(close) + 0.3·0.1(resolution) + 0.1·0(first) = 0.06
    expect(ISSUES_TRACKER_UNUSED).toBeCloseTo(6.0, 10);
  });
});

describe("compute: здоровое репо (ручная арифметика)", () => {
  const t: TestDb = makeDb();
  afterAll(() => t.close());

  test("категории/coverage/total", () => {
    const scanId = seedScan(t, healthyFacts());
    const s = compute(t.db, scanId, "public", { now: NOW });
    // документация: readme 0.3+0.7·(0.5·0.72917+0.5·1)=0.90521; (0.45·0.90521+0.25+0.15)/0.85→0.80734
    expect(s.categories.documentation.score!).toBeCloseTo(80.734, 2);
    expect(s.categories.cicd.score!).toBeCloseTo(100, 10);
    // активность: 0.35·1 + 0.25·0.48756 + 0.2·0.39085 + 0.1·0.63755 + 0.1·0.84115 = 0.69793
    expect(s.categories.activity.score!).toBeCloseTo(69.793, 2);
    // issues: 0.3·0.9 + 0.3·0.91 + 0.3·0.85 + 0.1·0.9625 = 0.89425
    expect(s.categories.issues.score!).toBeCloseTo(89.425, 2);
    // code: 0.4·0.976 + 0.35·0.75 + 0.25·1 = 0.9029
    expect(s.categories.code.score!).toBeCloseTo(90.29, 2);
    expect(s.categories.security.score).toBeNull();
    expect(s.coverage).toBe(1.0); // (15+15+15+15+20)/100 / 0.8
    // (15·80.734 + 15·100 + 15·69.793 + 15·89.425 + 20·90.29)/80 = 86.31
    expect(s.total!).toBeCloseTo(86.31, 1);
    expect(s.modelVersion).toBe("2.0.0-m2");
    expect(s.stale).toEqual([]);
  });

  test("Issues 0/0 = данные: скор = вычислимый минимум (≈6), coverage не страдает", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } }));
    const s = compute(t.db, scanId, "public", { now: NOW });
    expect(s.categories.issues.score!).toBeCloseTo(ISSUES_TRACKER_UNUSED, 10);
    expect(s.coverage).toBe(1.0);
    expect(s.noData.some((x) => x.startsWith("issues:"))).toBe(false);
  });

  test("CI конфиг без прогонов: потолок 50 (§5.1); без ci.yaml → 0", () => {
    const capped = seedScan(t, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const s1 = compute(t.db, capped, "public", { now: NOW });
    expect(s1.categories.cicd.score!).toBe(50);
    // (6905.08 − 1500 + 750)/80 = 76.94
    expect(s1.total!).toBeCloseTo(76.94, 1);

    const noYaml = seedScan(t, withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } }));
    const s2 = compute(t.db, noYaml, "public", { now: NOW });
    expect(s2.categories.cicd.score!).toBe(0);
  });

  test("Security с AppSec-фактом: критичные secrets → кап total ≤ 49; resolved → Score ↑", () => {
    const crit = seedScan(
      t,
      withFacts(healthyFacts(), {
        key: "appsec.findings",
        value: { severity_counts: { critical: 2, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true },
      }),
    );
    const s1 = compute(t.db, crit, "public", { now: NOW });
    expect(s1.categories.security.score!).toBeCloseTo(39, 1); // 0.5·0.72 + 0.3·0.1 + 0.2·0
    expect(s1.total!).toBeLessThanOrEqual(49);
    expect(s1.coverage).toBe(1.0); // 100/80 → clamp

    const fixed = seedScan(
      t,
      withFacts(healthyFacts(), {
        key: "appsec.findings",
        value: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false },
      }),
    );
    const s2 = compute(t.db, fixed, "public", { now: NOW });
    expect(s2.categories.security.score!).toBeCloseTo(98.5, 1); // 0.5 + 0.3·0.95 + 0.2
    expect(s2.total!).toBeGreaterThan(s1.total!);
  });

  test("bad-channel: stale-факты последнего успешного kind, Score не двигается (§5.6)", () => {
    const scan1 = seedScan(t, healthyFacts(), 5); // успешная история 5 дней назад
    const base = compute(t.db, scan1, "public", { now: NOW });

    // ночью 429: те же данные, но issues/cicd/activity.rest легли в bad
    const scan2 = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "issues.stats", value: { reason: "bad-channel" }, status: "bad" },
        { key: "cicd.runs", value: { reason: "bad-channel" }, status: "bad" },
        { key: "activity.rest", value: { reason: "bad-channel" }, status: "bad" },
      ),
    );
    const s2 = compute(t.db, scan2, "public", { now: NOW });
    expect(new Set(s2.stale)).toEqual(new Set(["issues.stats", "cicd.runs", "activity.rest"]));
    expect(s2.categories.issues.stale).toBe(true);
    expect(s2.total!).toBeCloseTo(base.total!, 9); // ε=1e-9 в тотал-масштабе
    expect(s2.coverage).toBe(base.coverage);

    // без истории bad = no-data: cicd уходит в конфиг-потолок, issues null
    const fresh = makeDb();
    try {
      const scan3 = seedScan(fresh, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "bad-channel" }, status: "bad" }));
      const s3 = compute(fresh.db, scan3, "public", { now: NOW });
      expect(s3.categories.cicd.score!).toBe(50); // конфиг-кап
      expect(s3.stale).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  test("coverage < 0.4 → total NULL + объяснение", () => {
    const scanId = seedScan(t, [{ key: "cicd.runs", value: { reason: "access" }, status: "no-data" }]);
    const s = compute(t.db, scanId, "public", { now: NOW });
    expect(s.coverage).toBeLessThan(0.4);
    expect(s.total).toBeNull();
    expect(s.noData.length).toBeGreaterThan(0);
  });

  test("лайки нейтральны: compute не читает repos.likes", () => {
    const scanId = seedScan(t, healthyFacts());
    const before = compute(t.db, scanId, "public", { now: NOW }).total;
    t.db.exec("UPDATE repos SET likes = 100 WHERE id = " + t.repoId);
    const after = compute(t.db, scanId, "public", { now: NOW }).total;
    expect(after).toBe(before);
  });

  test("writeScores: идемпотентно при том же model_version, новая версия = новая строка", () => {
    const scanId = seedScan(t, healthyFacts());
    const s = compute(t.db, scanId, "public", { now: NOW });
    writeScores(t.db, s);
    writeScores(t.db, s);
    const c1 = (t.db.query("SELECT COUNT(*) AS c FROM scores WHERE scan_id = ?").get(scanId) as { c: number }).c;
    expect(c1).toBe(1);
    writeScores(t.db, { ...s, modelVersion: "9.9.9-test" });
    const rows = t.db.query("SELECT model_version FROM scores WHERE scan_id = ? ORDER BY model_version").all(scanId) as { model_version: string }[];
    expect(rows.map((r) => r.model_version)).toEqual(["2.0.0-m2", "9.9.9-test"]);
    // immutable: старые строки не перезаписаны
    t.db.exec("DELETE FROM scores WHERE model_version = '9.9.9-test'");
  });
});
