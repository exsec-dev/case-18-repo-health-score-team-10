// В5.3-М — модель 4.3.0-hci (workers/V5.3-method-oneshot.md, §2 «Расчет» и
// «Тексты»): поведенческие тесты на данных по каждому пункту. Номер пункта —
// в имени теста. Правило AGENTS.md 21.09/23.09: число, доля, место и
// утверждение пустого состояния — тестом на данных, не source-assert.
import { describe, expect, test } from "bun:test";
import { computeFromFacts, codeEmptyKind, licensePresent, type Scores } from "../src/score/compute";
import { recommendFromFacts, orderRecommendations, type Recommendation } from "../src/score/recommend";
import { burstSyncFlags, robot2Flags } from "../src/score/robot2";
import {
  CODE_MIN_LOC,
  ISSUES_ANCHOR_MIN,
  ISSUES_TRACKER_UNUSED,
  MODEL_VERSION,
  SECURITY_OPEN_CAPS,
  SUBWEIGHTS,
  TEST_SHARE,
  anchorScore,
  contributorsScore,
} from "../src/score/model";
import { categoryContributions, contributionsNote, fmtScore, noDataReason, roundScore, scoreTheme, scoreWord, CI_RUNS_CAP_TEXT } from "../src/web/format";
import { adjustmentText, whyText } from "../src/report/sections";
import { submetricContext, submetricNote, submetricShownValue } from "../src/report/submetrics";
import { NOW, healthyFacts } from "./score-fixtures";

const DAY = 24 * 3600_000;
const iso = (t: number): string => new Date(t).toISOString();
type Patch = Record<string, unknown | undefined>;

function facts(patch: Patch = {}): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}
const score = (ok: Map<string, unknown>, extra: { emptyRepo?: boolean } = {}): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0, ...extra }, NOW);
const tree = (over: Record<string, unknown> = {}) => ({ top_level: [{ name: "src", type: "tree" }], file_count: 40, bytes: 50_000, loc: 5000, source_files: 30, source_loc: 4000, test_files: 0, ...over });
const ctx = submetricContext(NOW.toISOString());
const noDelta = () => ({ delta: 0, reason: null });
const ids = (recs: Recommendation[]) => recs.map((r) => r.ruleId);

test("модель — 4.3.0-hci", () => {
  expect(MODEL_VERSION).toBe("4.3.0-hci");
});

describe("Н3: «кода нет» — и «Состояние кода» без числа", () => {
  test("Н3: README-репо — индекс 0, «Состояние кода» не 100, а нет данных с причиной «кода нет»", () => {
    const s = score(facts({ "tree.stats": { top_level: [{ name: "README.md", type: "blob" }], file_count: 1, bytes: 300, loc: 10, source_files: 0, source_loc: 0 } }));
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
    expect(s.categories.code.score).toBeNull();
    expect(s.categories.code.no_data).toBe("no source code — only non-code files");
  });

  test("Н3 (F16): пустой файл кода не снимает «кода нет» — source_loc = 0", () => {
    const s = score(facts({ "tree.stats": tree({ source_files: 1, source_loc: 0, loc: 3 }) }));
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
    expect(s.categories.code.no_data).toBe("no source code — no lines of code");
    // обрыв чтения (source_loc = null) — незнание, не «кода нет»
    expect(codeEmptyKind(facts({ "tree.stats": tree({ source_loc: null, loc: null, loc_note: "incomplete" }) }), { empty: false })).toBeNull();
  });
});

describe("Н4: причины «нет данных» по виду", () => {
  test("Н4: пустой репо — «нет ни одного коммита» во всех git-категориях, не «не удалось скачать»", () => {
    const ok = facts({ "activity.git.timeline": undefined, "activity.git.summary": undefined, "docs.presence": undefined, "docs.readme": undefined, "tree.stats": undefined, "code.todo": undefined, "cicd.configs": undefined });
    const s = score(ok, { emptyRepo: true });
    for (const k of ["documentation", "cicd", "activity"] as const) expect(noDataReason(k, s.categories[k].no_data)).toBe("В репозитории нет ни одного коммита – оценивать нечего.");
    expect(noDataReason("code", s.categories.code.no_data)).toBe("В репозитории нет ни одного коммита – оценивать нечего.");
    // тот же набор без признака пустоты — «не удалось прочитать»
    const unread = score(ok);
    expect(noDataReason("activity", unread.categories.activity.no_data)).toContain("Репозиторий не удалось прочитать");
    expect(noDataReason("documentation", unread.categories.documentation.no_data)).toContain("Репозиторий не удалось прочитать");
  });

  test("Н4: строки не прочитаны (loc = null) против «мало кода» — разные причины", () => {
    const unread = score(facts({ "tree.stats": tree({ source_loc: null, loc: null, loc_note: "incomplete" }) }));
    expect(noDataReason("code", unread.categories.code.no_data)).toBe("Строки кода прочитать не удалось – категорию не оцениваем.");
    const little = score(facts({ "tree.stats": tree({ source_loc: 12 }) }));
    expect(noDataReason("code", little.categories.code.no_data)).toBe("Мало кода: меньше 50 строк – категорию не оцениваем.");
  });

  test("Н4 (D4): строка вместо полосы вкладов — по виду; «нет ни одного файла» только без файлов", () => {
    const note = (reason: string) => contributionsNote(categoryContributions([{ key: "code", title: "Код", score: null, weight: 31 }], 0, { codeEmpty: true, codeEmptyReason: reason })!)!;
    expect(note("no source code — only non-code files")).toContain("нет файлов кода – только документы");
    expect(note("no source code — only non-code files")).not.toContain("ни одного файла");
    expect(note("no source code — no files")).toContain("нет ни одного файла");
    expect(note("no source code — repository empty")).toContain("нет ни одного коммита");
    expect(note("no source code — no lines of code")).toContain("строк кода нет");
  });
});

describe("Р4б: «Состояние кода» — от 50 строк кода", () => {
  test("Р4б: 49 строк — нет данных «мало кода»; 50 — оценка есть; старые факты — по loc", () => {
    expect(CODE_MIN_LOC).toBe(50);
    expect(score(facts({ "tree.stats": tree({ source_loc: 49 }) })).categories.code.score).toBeNull();
    expect(score(facts({ "tree.stats": tree({ source_loc: 50 }) })).categories.code.score).not.toBeNull();
    const legacy = { top_level: [{ name: "src", type: "tree" }], file_count: 3, bytes: 100, loc: 20 };
    expect(score(facts({ "tree.stats": legacy })).categories.code.no_data).toBe("too little data — less than 50 lines of code");
  });

  test("Р4б (J5): README + однострочный main.py больше не дает индекс выше медианы — «Код» без числа", () => {
    const ok = facts({ "tree.stats": tree({ source_files: 1, source_loc: 1, loc: 5 }), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } });
    const s = score(ok);
    expect(s.categories.code.score).toBeNull();
    expect(s.codeEmpty).toBe(false);
  });
});

describe("Р1: подметрика «Тесты» в «Состоянии кода»", () => {
  test("Р1: анкеры 0 → 0, 0,05 → 0,5, 0,15 → 0,8, 0,3 → 1; веса 0,35/0,25/0,3/0,1", () => {
    expect([0, 0.05, 0.15, 0.3, 0.6].map((x) => anchorScore(TEST_SHARE, x))).toEqual([0, 0.5, 0.8, 1, 1]);
    expect(SUBWEIGHTS.code).toEqual({ density: 0.35, old_share: 0.25, tests: 0.3, root: 0.1 });
  });

  test("Р1: 0 тестов при коде — данные (0), не no-data; тесты повышают балл; старые факты — перенормировка", () => {
    const none = score(facts({ "tree.stats": tree({ test_files: 0 }) }));
    const some = score(facts({ "tree.stats": tree({ test_files: 6 }) })); // 20% файлов
    expect(none.categories.code.submetrics.tests!.score).toBe(0);
    expect(some.categories.code.score!).toBeGreaterThan(none.categories.code.score!);
    const legacy = score(facts());
    expect(legacy.categories.code.submetrics.tests!.score).toBeNull();
    expect(legacy.categories.code.score).not.toBeNull();
  });
});

describe("Р2: сжатие малой выборки — по закрытым, прожившим ≥ 1 ч", () => {
  const trackerEmpty = { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 };
  test("Р2 (J2, S8a): 10 задач «открыл-закрыл» за минуту — балл трекера не растет", () => {
    const empty = score(facts({ "issues.stats": trackerEmpty }));
    const fake = score(facts({ "issues.stats": { open: 0, closed: 10, closed_instant: 10, closed_counted: 0, median_close_days: null, stale_90d: 0, fetched_count: 10 } }));
    expect(fake.categories.issues.score!).toBeCloseTo(ISSUES_TRACKER_UNUSED, 9);
    expect(fake.healthcraftIndex!).toBeCloseTo(empty.healthcraftIndex!, 9);
  });

  test("Р2 (F1): спам открытыми задачами не увеличивает размер выборки", () => {
    const one = score(facts({ "issues.stats": { open: 0, closed: 1, closed_counted: 1, median_close_days: 1, stale_90d: 0, fetched_count: 1 } }));
    const spam = score(facts({ "issues.stats": { open: 9, closed: 1, closed_counted: 1, median_close_days: 1, stale_90d: 0, fetched_count: 10 } }));
    expect(spam.categories.issues.score!).toBeLessThanOrEqual(one.categories.issues.score! + 1e-9);
    expect(spam.categories.issues.adjustment).toEqual({ kind: "small-sample", n: 1, full: 10, raw: expect.any(Number), floor: 6 });
  });

  test("Р2: мгновенно закрытые не входят в долю решенных; у старых фактов — все закрытые", () => {
    const counted = score(facts({ "issues.stats": { open: 10, closed: 40, closed_instant: 20, closed_counted: 20, median_close_days: 5, stale_90d: 1, fetched_count: 50 } }));
    expect(counted.derived.resolutionRatio).toBeCloseTo(20 / 30, 9);
    const legacy = score(facts());
    expect(legacy.derived.resolutionRatio).toBeCloseTo(40 / 50, 9);
  });
});

describe("Н5: сжатие объяснено и таблица сходится с итогом", () => {
  test("Н5 (J16, D8): whyText — не «на максимуме» при сжатом балле; строка поправки сводит таблицу", () => {
    const s = score(facts({ "issues.stats": { open: 0, closed: 3, closed_counted: 3, median_close_days: 1, stale_90d: 0, fetched_count: 3 }, "issues.comments_sample": { issues: 0, answered: 0, censored: 0, median_first_comment_delay_hours: null, delays_hours: [] } }));
    const cat = { ...s.categories.issues, weight: 15 };
    const why = whyText("issues", cat, ctx);
    expect(why).not.toContain("на максимуме");
    expect(why).toContain("3 закрытые задачи из 10");
    expect(why).toContain("сжат к минимуму 6");
    const adj = cat.adjustment!;
    expect(adj.kind).toBe("small-sample");
    // сумма строк таблицы (сырой балл) + строка поправки = итог
    expect(adj.raw + (cat.score! - adj.raw)).toBeCloseTo(cat.score!, 9);
    expect(cat.score!).toBeCloseTo(6 + (adj.raw - 6) * 0.3, 9);
  });
});

describe("Н9: «ни одна не закрыта» — данные, худший анкер", () => {
  test("Н9 (F4): первое закрытие старой задачи больше не снижает балл", () => {
    const none = score(facts({ "issues.stats": { open: 270, closed: 0, median_close_days: null, stale_90d: 74, fetched_count: 270 } }));
    const first = score(facts({ "issues.stats": { open: 269, closed: 1, closed_counted: 1, median_close_days: 164, stale_90d: 73, fetched_count: 270 } }));
    expect(none.categories.issues.submetrics.close_days!.score).toBe(0);
    expect(submetricShownValue("issues", "close_days", none.categories.issues.submetrics.close_days!, ctx)).toBe("ни одна задача не закрыта");
    expect(first.categories.issues.score!).toBeGreaterThanOrEqual(none.categories.issues.score! - 1e-9);
  });
});

describe("Н8: CI без видимых запусков — «нет данных» при любом конфиге", () => {
  const runs403 = undefined;
  test("Н8 (J11, F10): заглушка ci.yaml без видимых запусков не поднимает полный Score над «CI нет»", () => {
    const noYaml = score(facts({ "cicd.runs": runs403, "cicd.configs": { paths: [], has_ci_yaml: false, has_steps: false } }));
    const stub = score(facts({ "cicd.runs": runs403, "cicd.configs": { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } }));
    expect(noYaml.categories.cicd.score).toBeNull();
    expect(stub.categories.cicd.score).toBeNull();
    expect(stub.repoHealthScore).toBe(noYaml.repoHealthScore);
    expect(noDataReason("cicd", noYaml.categories.cicd.no_data)).toBe(CI_RUNS_CAP_TEXT);
  });

  test("Н8: запуски видны — «нет ci.yaml» по-прежнему 0 (данные)", () => {
    const s = score(facts({ "cicd.configs": { paths: [], has_ci_yaml: false, has_steps: false } }));
    expect(s.categories.cicd.score).toBe(0);
  });

  test("Н8: эффект ci-missing при невидимых запусках — текстом, без числа", () => {
    const ok = facts({ "cicd.runs": runs403, "cicd.configs": { paths: [], has_ci_yaml: false, has_steps: false } });
    const rec = recommendFromFacts(ok, { delta: noDelta, issuesScore: 50 }).find((r) => r.ruleId === "ci-missing")!;
    expect(rec.deltaScore).toBeNull();
    expect(rec.expectedImpact).toBe("CI/CD: оценка появится с запусками");
  });
});

describe("Н14б: тексты CI и AppSec", () => {
  test("Н14б (D11): «не запускался» и «за год не запускался» — словами, а не «0%»", () => {
    const never = score(facts({ "cicd.runs": { runs_count: 0, runs_total: 0, last_status: null, success_rate: null, duration_p50: null, weighted_success_rate: null } }));
    const pass = never.categories.cicd.submetrics.pass_rate!;
    expect(submetricShownValue("cicd", "pass_rate", pass, ctx)).toBe("CI не запускался");
    const old = score(facts({ "cicd.runs": { runs_count: 5, runs_total: 5, last_status: "success", success_rate: 1, duration_p50: 60, weighted_success_rate: null } }));
    expect(submetricShownValue("cicd", "pass_rate", old.categories.cicd.submetrics.pass_rate!, ctx)).toBe("за год не запускался");
    expect(CI_RUNS_CAP_TEXT).not.toContain("запусков не было");
  });

  test("Н14б: запуски идут, завершенных нет — своя причина, не «не видны»", () => {
    const s = score(facts({ "cicd.runs": { runs_count: 0, runs_total: 2, last_status: null, success_rate: null, duration_p50: null } }));
    expect(s.categories.cicd.score).toBeNull();
    expect(noDataReason("cicd", s.categories.cicd.no_data)).toBe("Запуски CI идут, завершенных пока нет – категорию не оцениваем.");
  });

  test("Н14б (D12): «Находки AppSec есть…» — только при находках; без находок категория оценена", () => {
    const clean = score(facts({ "appsec.findings": { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: null, secrets_critical: false }, "tree.stats": { top_level: [], file_count: 10, bytes: 10 } }));
    expect(clean.categories.security.score).not.toBeNull();
    const dirty = score(facts({ "appsec.findings": { severity_counts: { critical: 0, high: 0, medium: 3, low: 0 }, resolved_share: null, secrets_critical: false }, "tree.stats": { top_level: [], file_count: 10, bytes: 10 } }));
    expect(dirty.categories.security.score).toBeNull();
    expect(noDataReason("security", dirty.categories.security.no_data)).toContain("Находки AppSec есть");
  });

  test("Н14б (D13): доля старых TODO при 1-4 пометках — с оговоркой «от не менее 5 пометок»", () => {
    const s = score(facts({ "tree.stats": tree(), "code.todo": { count: 1, fixme: 0, older_180d: 1, todo_files: 1, blamed_files: 1 } }));
    const code = s.categories.code;
    expect(submetricShownValue("code", "old_share", code.submetrics.old_share!, ctx, code.submetrics)).toBe("20% (доля от не менее 5 пометок)");
    const many = score(facts({ "tree.stats": tree(), "code.todo": { count: 10, fixme: 0, older_180d: 2, todo_files: 1, blamed_files: 1 } }));
    expect(submetricShownValue("code", "old_share", many.categories.code.submetrics.old_share!, ctx)).toBe("20%");
  });
});

describe("Н11: плотность находок Security — по строкам кода", () => {
  test("Н11 (F21): документация не разбавляет плотность; старые факты — по loc", () => {
    const appsec = { severity_counts: { critical: 0, high: 0, medium: 2, low: 0 }, resolved_share: 0.5, secrets_critical: false };
    const lean = score(facts({ "appsec.findings": appsec, "tree.stats": tree({ loc: 10_000, source_loc: 10_000 }) }));
    const docs = score(facts({ "appsec.findings": appsec, "tree.stats": tree({ loc: 20_000, source_loc: 10_000 }) }));
    expect(docs.categories.security.submetrics.density!.value).toBe(lean.categories.security.submetrics.density!.value);
    const legacy = score(facts({ "appsec.findings": appsec, "tree.stats": { top_level: [], file_count: 3, bytes: 1, loc: 20_000 } }));
    expect(legacy.categories.security.submetrics.density!.value).toBeCloseTo(4 / 2, 9);
  });
});

describe("Р3: потолок «Безопасности» при открытых находках и порядок рекомендаций", () => {
  const big = tree({ loc: 600_000, source_loc: 500_000 });
  test("Р3 (J7): 2 открытые critical на 500 тыс. строк — Безопасность не выше 40; high — не выше 69", () => {
    expect(SECURITY_OPEN_CAPS).toEqual({ critical: 40, high: 69 });
    const crit = score(facts({ "tree.stats": big, "appsec.findings": { severity_counts: { critical: 2, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false } }));
    expect(crit.categories.security.score).toBe(40);
    expect(crit.categories.security.adjustment).toMatchObject({ kind: "open-findings-cap", level: "critical", limit: 40 });
    expect(adjustmentText({ ...crit.categories.security })).toBe("Есть открытые критичные находки AppSec – балл категории не выше 40.");
    const high = score(facts({ "tree.stats": big, "appsec.findings": { severity_counts: { critical: 0, high: 1, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false } }));
    expect(high.categories.security.score).toBe(69);
    // потолок не поднимает: балл ниже потолка остается как есть
    const low = score(facts({ "tree.stats": tree({ source_loc: 1000 }), "appsec.findings": { severity_counts: { critical: 3, high: 0, medium: 0, low: 0 }, resolved_share: 0, secrets_critical: false } }));
    expect(low.categories.security.score!).toBeLessThan(40);
    expect(low.categories.security.adjustment).toBeUndefined();
  });

  test("Р3 (J8, S17): критичные находки — первыми, выше «Добавьте CODEOWNERS»", () => {
    const ok = facts({
      "docs.presence": { readme: true, license: false, contributing: false, codeowners: false },
      "appsec.findings": { severity_counts: { critical: 3, high: 0, medium: 0, low: 0 }, resolved_share: 0.5, secrets_critical: false },
    });
    const recs = recommendFromFacts(ok, { delta: () => ({ delta: 1, reason: null }), issuesScore: 50, categoryScores: { security: 40, cicd: 100, code: 80, issues: 80 } });
    expect(ids(recs)[0]).toBe("appsec-critical");
    const reds = orderRecommendations([{ ruleId: "codeowners-missing", kind: "presence", deltaScore: 5, opensCategory: null, priority: 0 }, { ruleId: "fix-red-runs", kind: "score", deltaScore: null, opensCategory: null, priority: 0 }, { ruleId: "resolve-old-todos", kind: "score", deltaScore: null, opensCategory: null, priority: 0 }]);
    expect(reds.map((r) => r.ruleId)).toEqual(["fix-red-runs", "codeowners-missing", "resolve-old-todos"]);
  });
});

describe("Н7: рекомендации — те же условия, что балл", () => {
  test("Н7 (F7): COPYING в корне у фактов до Р4в — лицензия засчитана, совета «добавьте лицензию» нет", () => {
    const ok = facts({ "docs.presence": { readme: true, license: false, contributing: true, codeowners: true }, "tree.stats": { ...tree(), top_level: [{ name: "COPYING", type: "blob" }, { name: "src", type: "tree" }] } });
    expect(licensePresent(ok)).toBe(true);
    expect(ids(recommendFromFacts(ok, { delta: noDelta, issuesScore: 50 }))).not.toContain("license-missing");
    // сборщик 3 проверил содержимое: пустой COPYING — не лицензия, совет есть
    const checked = facts({ "docs.presence": { readme: true, license: false, contributing: true, codeowners: true, content_checked: true }, "tree.stats": { ...tree(), top_level: [{ name: "COPYING", type: "blob" }] } });
    expect(licensePresent(checked)).toBe(false);
    expect(ids(recommendFromFacts(checked, { delta: noDelta, issuesScore: 50 }))).toContain("license-missing");
  });

  test("Н7 (F8): скор-правило у неоцененной категории не срабатывает", () => {
    const ok = facts({ "code.todo": { count: 0, fixme: 6, older_180d: 6, todo_files: 1, blamed_files: 1 } });
    const scored = recommendFromFacts(ok, { delta: noDelta, issuesScore: 50, categoryScores: { code: 60 } });
    const unscored = recommendFromFacts(ok, { delta: noDelta, issuesScore: 50, categoryScores: { code: null } });
    expect(ids(scored)).toContain("resolve-old-todos");
    expect(ids(unscored)).not.toContain("resolve-old-todos");
  });

  test("Н7 (F9): CI-правила — только при ci.yaml со шагами и оцененной CI", () => {
    const red = { last_status: "failed", success_rate: 0.2, weighted_success_rate: 0.2, duration_p50: 3527, runs_count: 5 };
    const noYaml = facts({ "cicd.configs": { paths: [], has_ci_yaml: false, has_steps: false }, "cicd.runs": red });
    expect(ids(recommendFromFacts(noYaml, { delta: noDelta, issuesScore: 50, categoryScores: { cicd: 0 } })).filter((x) => x === "fix-red-runs" || x === "speed-up-pipeline")).toEqual([]);
    const withYaml = facts({ "cicd.runs": red });
    expect(ids(recommendFromFacts(withYaml, { delta: noDelta, issuesScore: 50, categoryScores: { cicd: 30 } }))).toEqual(expect.arrayContaining(["fix-red-runs", "speed-up-pipeline"]));
  });

  test("Н7 (D11): CI заявлен, запуски видны, их 0 — совет «Запустите CI»", () => {
    const ok = facts({ "cicd.runs": { runs_count: 0, runs_total: 0, last_status: null, success_rate: null, duration_p50: null, weighted_success_rate: null } });
    const s = score(ok);
    const recs = recommendFromFacts(ok, { delta: noDelta, issuesScore: 50, categoryScores: { cicd: s.categories.cicd.score } });
    const rec = recs.find((r) => r.ruleId === "ci-never-ran")!;
    expect(rec.action).toBe("Запустите CI");
    expect(rec.channel).toBe("cicd");
    // идущие запуски — не «не запускался»
    const pending = facts({ "cicd.runs": { runs_count: 0, runs_total: 3 } });
    expect(ids(recommendFromFacts(pending, { delta: noDelta, issuesScore: 50, categoryScores: { cicd: null } }))).not.toContain("ci-never-ran");
  });
});

describe("Н10: burst-коллапс и зеркала", () => {
  const events = (n: number, author: (i: number) => string, committer: (i: number) => string, authorDate: (i: number) => number, committerDate: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({
      sha: `c${i}`,
      author: { name: author(i), email: `${author(i)}@x.io`, date: iso(authorDate(i)) },
      committer: { name: committer(i), email: `${committer(i)}@x.io`, date: iso(committerDate(i)) },
    }));
  const t0 = NOW.getTime() - 5 * DAY;

  test("Н10 (F12, J13): ребейз 12 коммитов одного автора — не синк, считается по author-датам", () => {
    const ev = events(12, () => "dev", () => "dev", (i) => NOW.getTime() - (60 - i * 5) * DAY, (i) => t0 + i * 100);
    expect(robot2Flags(ev).flags.every((f) => !f.sync)).toBe(true);
    const s = score(facts({ "activity.git.timeline": { events: ev } }));
    expect(s.categories.activity.score!).toBeGreaterThan(50);
  });

  test("Н10: окно с двумя авторами или чужим коммиттером у большинства — синк", () => {
    const two = events(12, (i) => (i % 2 ? "a" : "b"), (i) => (i % 2 ? "a" : "b"), (i) => NOW.getTime() - (60 - i) * DAY, (i) => t0 + i * 100);
    expect(robot2Flags(two).flags.every((f) => f.sync)).toBe(true);
    const mirror = events(12, () => "dev", () => "mirror-bot-sync", (i) => NOW.getTime() - (60 - i) * DAY, (i) => t0 + i * 100);
    expect(robot2Flags(mirror).flags.every((f) => f.sync)).toBe(true);
    // сгенерированный всплеск одного автора (author-даты в том же окне) — синк (S6a)
    const spam = events(20, () => "dev", () => "dev", () => t0, () => t0);
    expect(robot2Flags(spam).flags.every((f) => f.sync)).toBe(true);
    // без сведений об авторах — прежнее поведение
    expect(burstSyncFlags(Array.from({ length: 10 }, () => t0)).flags.every(Boolean)).toBe(true);
  });

  test("Н10 (Q&A №10): история целиком из синков — Активность «нет данных», а не 0; только роботы — 0", () => {
    const sync = events(12, (i) => `u${i}`, () => "mirror", (i) => NOW.getTime() - (400 + i) * DAY, (i) => t0 + i * 10);
    const s = score(facts({ "activity.git.timeline": { events: sync } }));
    expect(s.categories.activity.score).toBeNull();
    expect(noDataReason("activity", s.categories.activity.no_data)).toContain("только синхронизации");
    const bots = Array.from({ length: 3 }, (_, i) => ({ sha: `b${i}`, author: { name: "dependabot[bot]", email: "bot@x.io", date: iso(NOW.getTime() - (i + 1) * DAY) }, committer: { name: "dependabot[bot]", email: "bot@x.io", date: iso(NOW.getTime() - (i + 1) * DAY) } }));
    const robots = score(facts({ "activity.git.timeline": { events: bots } }));
    expect(robots.categories.activity.submetrics.fresh!.score).toBe(0);
    expect(robots.categories.activity.score).not.toBeNull();
  });
});

describe("Н13: зона — от устойчиво округленного балла", () => {
  test("Н13 (F20): 39.49999999999999 → 40 → «требует внимания» на карточке, в рейтинге и отчете", () => {
    const x = 0.35 * 0.8 + 0.25 * 0.46; // 0.395 в двоичной арифметике — 0.39499999999999996
    expect(x * 100).toBeLessThan(39.5);
    expect(roundScore(x * 100)).toBe(40);
    expect(fmtScore(x * 100)).toBe("40");
    expect(scoreTheme(x * 100)).toBe("warning");
    expect(scoreWord(x * 100)).toBe("требует внимания");
    expect(roundScore(39.4)).toBe(39);
    expect(roundScore(69.5)).toBe(70);
  });
});

describe("Н15: мертвые ветки и точные константы", () => {
  test("Н15: ISSUES_TRACKER_UNUSED — точное 6, равное вычислимому минимуму анкеров", () => {
    expect(ISSUES_TRACKER_UNUSED).toBe(6);
    expect(ISSUES_ANCHOR_MIN).toBeCloseTo(6, 12);
  });

  test("Н15: anchorScore и contributorsScore без недостижимых веток — значения прежние", () => {
    const a = [{ x: 0, y: 1 }, { x: 10, y: 0.5 }, { x: 20, y: 0 }];
    expect([-1, 0, 5, 10, 15, 20, 25].map((x) => anchorScore(a, x))).toEqual([1, 1, 0.75, 0.5, 0.25, 0, 0]);
    expect(contributorsScore(1)).toBeCloseTo(0.2, 12);
    expect(contributorsScore(0)).toBeCloseTo(0.2, 12);
  });

  test("Н15: заметка «0 пометок» — число 0%, отдельной ветки «пометок нет» нет", () => {
    const s = score(facts({ "tree.stats": tree(), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } }));
    expect(submetricShownValue("code", "old_share", s.categories.code.submetrics.old_share!, ctx, s.categories.code.submetrics)).toBe("0%");
    expect(submetricNote("code", "old_share", undefined)).toBeNull();
  });
});

describe("Свойство: улучшение факта не снижает оценку (правило AGENTS.md 24.09)", () => {
  test("мутации 4.3.0: +тесты, +строки кода до порога, закрыть задачу, снять открытую critical", () => {
    const base = facts({ "tree.stats": tree({ test_files: 2 }) });
    const cases: [string, Map<string, unknown>, Map<string, unknown>][] = [
      ["+тесты", base, facts({ "tree.stats": tree({ test_files: 8 }) })],
      ["закрыть задачу (≥ 1 ч)", facts({ "issues.stats": { open: 5, closed: 4, closed_counted: 4, median_close_days: 10, stale_90d: 2, fetched_count: 9 } }), facts({ "issues.stats": { open: 4, closed: 5, closed_counted: 5, median_close_days: 10, stale_90d: 2, fetched_count: 9 } })],
      ["снять critical", facts({ "appsec.findings": { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false } }), facts({ "appsec.findings": { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 0.9, secrets_critical: false } })],
    ];
    for (const [name, before, after] of cases) {
      const b = score(before);
      const a = score(after);
      expect({ name, index: a.healthcraftIndex! >= b.healthcraftIndex! - 1e-9, full: a.repoHealthScore! >= b.repoHealthScore! - 1e-9 }).toEqual({ name, index: true, full: true });
    }
  });
});
