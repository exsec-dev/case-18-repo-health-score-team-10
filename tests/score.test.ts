// score.test.ts — Б3: модель (анкеры §3, формулы, ISSUES floor) +
// compute (категории, tri-state перенормировка, coverage/NULL, CI-cap,
// secrets-кап, bad-channel stale-замещение, идемпотентность записи).
// Ручная арифметика ожиданий — в комментариях против проверок.
import { MODEL_VERSION } from "../src/score/model";
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

  test("один скан — два показателя: HealthCraft Index из 4 категорий, Repo Health Score из 6 (4.1.0-hci, К1 В4.1 → Ф3.1)", () => {
    const scanId = seedScan(t, healthyFacts());
    const s = compute(t.db, scanId, { now: NOW });
    // документация: readme 0.3+0.7·(0.5·0.72917+0.5·1)=0.90521; (0.45·0.90521+0.25+0.15)/0.85→0.80734
    expect(s.categories.documentation.score!).toBeCloseTo(80.734, 2);
    // активность: 0.35·1 + 0.25·0.48756 + 0.2·0.39085 + 0.1·0.63755 + 0.1·0.84115 = 0.69793
    expect(s.categories.activity.score!).toBeCloseTo(69.793, 2);
    // issues: 0.3·0.9 + 0.3·0.91 + 0.3·0.85 + 0.1·0.9625 = 0.89425
    expect(s.categories.issues.score!).toBeCloseTo(89.425, 2);
    // code (4.3.0, Р1): веса 0.35/0.25/0.3(тесты)/0.1; у фактов без test_files
    // «Тесты» — no-data, перенормировка: (0.35·0.976 + 0.25·0.75 + 0.1·1)/0.7 = 0.89871
    expect(s.categories.code.score!).toBeCloseTo(89.871, 2);
    // CI/Security хранятся со своими данными: CI есть, AppSec-факта нет
    expect(s.categories.cicd.score!).toBeCloseTo(100, 10);
    expect(s.categories.security.score).toBeNull();
    expect(s.categories.security.no_data).toContain("AppSec data unavailable");
    // индекс: coverage = (15+15+15+20)/65 = 1.0 (масса SCORE_WEIGHTS с данными)
    expect(s.indexCoverage).toBe(1.0);
    // (23·80.734 + 23·69.793 + 23·89.425 + 31·89.871)/100 = 83.049 (INDEX_WEIGHTS)
    expect(s.healthcraftIndex!).toBeCloseTo(83.05, 1);
    // полный: coverage = 80/100 — Security no-data
    expect(s.repoHealthCoverage).toBeCloseTo(0.8, 10);
    // (15·80.734 + 15·100 + 15·69.793 + 15·89.425 + 20·89.871)/80 = 86.21
    expect(s.repoHealthScore!).toBeCloseTo(86.21, 1);
    expect(s.modelVersion).toBe(MODEL_VERSION);
    expect(s.codeEmpty).toBe(false);
    expect(s.stale).toEqual([]);
  });

  test("Issues 0/0 = данные: скор = вычислимый минимум (≈6), coverage не страдает", () => {
    const scanId = seedScan(t, withFacts(healthyFacts(), { key: "issues.stats", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } }));
    const s = compute(t.db, scanId, { now: NOW });
    expect(s.categories.issues.score!).toBeCloseTo(ISSUES_TRACKER_UNUSED, 10);
    expect(s.indexCoverage).toBe(1.0);
    expect(s.noData.some((x) => x.startsWith("issues:"))).toBe(false);
  });

  test("CI конфиг без прогонов: честное no-data (23.09, кап 50 удалён); без ci.yaml → 0; рейтинг не тронут", () => {
    const capped = seedScan(t, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "access" }, status: "no-data" }));
    const s1 = compute(t.db, capped, { now: NOW });
    // 23.09 (Алексей): «за что так много?» — конфиг без прогонов не оцениваем
    expect(s1.categories.cicd.score).toBeNull();
    expect(s1.categories.cicd.no_data).toContain("прогоны не видны");
    // вес cicd перенормировался (4.3.0: Код 89.871): (15·80.734+15·69.793+15·89.425+20·89.871)/65 = 83.03
    expect(s1.repoHealthScore!).toBeCloseTo(83.03, 1);

    const noYaml = seedScan(t, withFacts(healthyFacts(), { key: "cicd.configs", value: { paths: [], has_ci_yaml: false, has_steps: false } }));
    const s2 = compute(t.db, noYaml, { now: NOW });
    expect(s2.categories.cicd.score!).toBe(0);
    // рейтинг: CI не входит — потолки на него не влияют
    expect(s1.healthcraftIndex!).toBeCloseTo(83.05, 1);
    expect(s2.healthcraftIndex!).toBeCloseTo(83.05, 1);
  });

  test("code_empty (Q&A №13): file_count=0 при ok-фактах → оба итога 0 как данные", () => {
    const empty = seedScan(t, withFacts(healthyFacts(), { key: "tree.stats", value: { top_level: [], file_count: 0, bytes: 0, loc: 0 } }));
    const s = compute(t.db, empty, { now: NOW });
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0); // «проекта нет» — данные, не NULL
    expect(s.repoHealthScore).toBe(0);
    expect(s.noData.some((x) => x.startsWith("security"))).toBe(true);
    // Ф2.3 (M5, В4.2a): loc = 0 при живом дереве больше НЕ code_empty —
    // нулевой LOC даёт и обрыв cat-file, и репо из одних бинарных файлов
    const emptyLoc = seedScan(t, withFacts(healthyFacts(), { key: "tree.stats", value: { top_level: [{ name: "x", type: "tree" }], file_count: 3, bytes: 10, loc: 0 } }));
    const s2 = compute(t.db, emptyLoc, { now: NOW });
    expect(s2.codeEmpty).toBe(false);
    expect(s2.healthcraftIndex).toBeGreaterThan(0);
    // loc = null (обрыв извлечения) — тоже не «проекта нет»
    const locNull = seedScan(t, withFacts(healthyFacts(), { key: "tree.stats", value: { top_level: [{ name: "x", type: "tree" }], file_count: 3, bytes: 10, loc: null, loc_note: "incomplete" } }));
    expect(compute(t.db, locNull, { now: NOW }).codeEmpty).toBe(false);
    // no-data tree.stats (клон не удался) — это НЕ code_empty
    const nodata = seedScan(t, withFacts(healthyFacts(), { key: "tree.stats", value: { reason: "limits" }, status: "no-data" }));
    const s3 = compute(t.db, nodata, { now: NOW });
    expect(s3.codeEmpty).toBe(false);
  });

  test("Security с AppSec-фактом: критичные secrets → кап ТОЛЬКО полного итога ≤ 49; resolved → Score ↑", () => {
    const crit = seedScan(
      t,
      withFacts(healthyFacts(), {
        key: "appsec.findings",
        value: { severity_counts: { critical: 2, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: true },
      }),
    );
    const s1 = compute(t.db, crit, { now: NOW });
    expect(s1.categories.security.score!).toBeCloseTo(39, 1); // 0.5·0.72 + 0.3·0.1 + 0.2·0
    expect(s1.repoHealthScore!).toBeLessThanOrEqual(49);
    expect(s1.repoHealthCoverage).toBe(1.0); // 100/100 → clamp

    const fixed = seedScan(
      t,
      withFacts(healthyFacts(), {
        key: "appsec.findings",
        value: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false },
      }),
    );
    const s2 = compute(t.db, fixed, { now: NOW });
    expect(s2.categories.security.score!).toBeCloseTo(98.5, 1); // 0.5 + 0.3·0.95 + 0.2
    expect(s2.repoHealthScore!).toBeGreaterThan(s1.repoHealthScore!);
    // рейтинг: Security не входит, кап 49 не применяется
    expect(s1.healthcraftIndex!).toBeCloseTo(83.05, 1);
  });

  test("bad-channel: stale-факты последнего успешного kind, итоги не двигаются (§5.6)", () => {
    const scan1 = seedScan(t, healthyFacts(), 5); // успешная история 5 дней назад
    const repoId = (t.db.query("SELECT repo_id FROM scans WHERE id = ?").get(scan1) as { repo_id: number }).repo_id;
    const base = compute(t.db, scan1, { now: NOW });

    // ночью 429: те же данные, но issues/cicd/activity.rest легли в bad
    const scan2 = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "issues.stats", value: { reason: "bad-channel" }, status: "bad" },
        { key: "cicd.runs", value: { reason: "bad-channel" }, status: "bad" },
        { key: "activity.rest", value: { reason: "bad-channel" }, status: "bad" },
      ),
      0,
      repoId,
    );
    const s2 = compute(t.db, scan2, { now: NOW });
    expect(new Set(s2.stale)).toEqual(new Set(["issues.stats", "cicd.runs", "activity.rest"]));
    expect(s2.categories.issues.stale).toBe(true);
    expect(s2.healthcraftIndex!).toBeCloseTo(base.healthcraftIndex!, 9); // ε=1e-9 в тотал-масштабе
    expect(s2.repoHealthScore!).toBeCloseTo(base.repoHealthScore!, 9);
    expect(s2.indexCoverage).toBe(base.indexCoverage);

    // без истории bad = no-data: cicd — честное no-data (23.09, кап 50 удалён)
    const scan3 = seedScan(t, withFacts(healthyFacts(), { key: "cicd.runs", value: { reason: "bad-channel" }, status: "bad" }));
    const s3 = compute(t.db, scan3, { now: NOW });
    expect(s3.categories.cicd.score).toBeNull(); // прогоны не видны — не оцениваем
    expect(s3.stale).toEqual([]);
  });

  test("фолбэк каналов с правами (К1): cicd.runs/appsec.findings при no-data или без строки — из раннего скана, stale", () => {
    const appsec = { key: "appsec.findings", value: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false } };
    // скан участника с PAT: CI-раны и AppSec есть
    const withPat = seedScan(t, withFacts(healthyFacts(), appsec), 2);
    const repoId = (t.db.query("SELECT repo_id FROM scans WHERE id = ?").get(withPat) as { repo_id: number }).repo_id;
    const base = compute(t.db, withPat, { now: NOW });
    // периодика без PAT: раны no-data(access), AppSec no-data — данные не стираются
    const periodic = seedScan(
      t,
      withFacts(
        healthyFacts(),
        { key: "cicd.runs", value: { reason: "access" }, status: "no-data" },
        { key: "appsec.findings", value: { reason: "access" }, status: "no-data" },
      ),
      0,
      repoId,
    );
    const s = compute(t.db, periodic, { now: NOW });
    expect(new Set(s.stale)).toEqual(new Set(["cicd.runs", "appsec.findings"]));
    expect(s.categories.cicd.stale).toBe(true);
    expect(s.categories.security.stale).toBe(true);
    expect(s.repoHealthScore!).toBeCloseTo(base.repoHealthScore!, 9);
    expect(s.healthcraftIndex!).toBeCloseTo(base.healthcraftIndex!, 9);
    // строки AppSec нет вовсе — тоже фолбэк
    const noRow = seedScan(t, healthyFacts().filter((f) => f.key !== "cicd.runs"), 0, repoId);
    const s2 = compute(t.db, noRow, { now: NOW });
    expect(new Set(s2.stale)).toEqual(new Set(["cicd.runs", "appsec.findings"]));
    // прочие kinds при no-data НЕ замещаются (только bad, §5.6)
    const issuesNoData = seedScan(t, withFacts(healthyFacts(), { key: "issues.stats", value: { reason: "access" }, status: "no-data" }), 0, repoId);
    const s3 = compute(t.db, issuesNoData, { now: NOW });
    expect(s3.stale).not.toContain("issues.stats");
    expect(s3.categories.issues.score).toBeNull();
  });

  test("coverage < 0.4 → оба итога NULL + объяснение", () => {
    const scanId = seedScan(t, [{ key: "cicd.runs", value: { reason: "access" }, status: "no-data" }]);
    const s = compute(t.db, scanId, { now: NOW });
    expect(s.indexCoverage).toBeLessThan(0.4);
    expect(s.healthcraftIndex).toBeNull();
    expect(s.repoHealthScore).toBeNull();
    expect(s.noData.length).toBeGreaterThan(0);
  });

  test("лайки нейтральны: compute не читает repos.likes", () => {
    const scanId = seedScan(t, healthyFacts());
    const before = compute(t.db, scanId, { now: NOW });
    t.db.exec("UPDATE repos SET likes = 100");
    const after = compute(t.db, scanId, { now: NOW });
    expect(after.healthcraftIndex).toBe(before.healthcraftIndex);
    expect(after.repoHealthScore).toBe(before.repoHealthScore);
  });

  test("writeScores: одна строка на (скан, модель) — идемпотентно; новая версия = новая строка", () => {
    const scanId = seedScan(t, healthyFacts());
    const s = compute(t.db, scanId, { now: NOW });
    writeScores(t.db, s);
    writeScores(t.db, s);
    const rows1 = t.db.query("SELECT healthcraft_index FROM scores WHERE scan_id = ?").all(scanId) as { healthcraft_index: number }[];
    expect(rows1).toEqual([{ healthcraft_index: Math.round(s.healthcraftIndex!) }]); // полного итога в схеме нет (К-Ф3.3)
    writeScores(t.db, { ...s, modelVersion: "9.9.9-test" });
    const rows = t.db.query("SELECT model_version FROM scores WHERE scan_id = ? ORDER BY model_version").all(scanId) as { model_version: string }[];
    expect(rows.map((r) => r.model_version)).toEqual([MODEL_VERSION, "9.9.9-test"]);
    // immutable: старые строки не перезаписаны
    t.db.exec("DELETE FROM scores WHERE model_version = '9.9.9-test'");
  });
});
