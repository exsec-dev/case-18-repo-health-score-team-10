// Подметрика «Уязвимые зависимости» (4.6.0) в «Безопасности» и совет
// «Обновите уязвимые зависимости»: инварианты на фикстурах без сети.
// Граф – настоящий package-lock.json тестового репо kibitkina-p/hc-sca-probe.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compute } from "../src/score/compute";
import { parseNpmLock } from "../src/collectors/lockgraph";
import { recommend, recommendationParams, recommendationText, SCORE_RULE_ORDER } from "../src/score/recommend";
import { DEPS_WEIGHTED, SEVERITY_WEIGHTS, SUBWEIGHTS, anchorScore } from "../src/score/model";
import { SUBMETRICS } from "../src/report/submetrics";
import { NOW, TestDb, healthyFacts, makeDb, seedScan, withFacts, FactSpec } from "./score-fixtures";
import { getRepoCard } from "../src/api/repos";
import { NO_PAT_ACCESS, type AccessResult } from "../src/auth/access";
import { cardFacts, seedRepo, seedScan as seedApiScan, seedScore } from "./api-fixtures";

const t: TestDb = makeDb();
afterAll(() => t.close());

const lockgraph = { graphs: [parseNpmLock("package-lock.json", readFileSync(join(import.meta.dir, "fixtures/lockgraph/hc-sca-probe.package-lock.json"), "utf8"))!] };

type Sev = "critical" | "high" | "medium" | "low";
const pkg = (name: string, version: string, severity: Sev) => ({ name, version, severity, advisories: 1, engines: ["Trivy"] });
const appsec = (packages: ReturnType<typeof pkg>[] | null, extra: Record<string, unknown> = {}) => ({
  key: "appsec.findings",
  value: {
    severity_counts: { critical: 0, high: 0, medium: 2, low: 3 },
    resolved_share: 0.8,
    secrets_critical: false,
    sca: packages === null ? null : { packages, groups: packages.length, unparsed: 0 },
    ...extra,
  },
});
const graphFact: FactSpec = { key: "tree.lockgraph", value: lockgraph };
const security = (facts: FactSpec[]) => compute(t.db, seedScan(t, facts), { now: NOW }).categories.security;

describe("подметрика security.deps", () => {
  test("веса категории: 0,4/0,24/0,16/0,2 — без графа перенормировка дает прежние 0,5/0,3/0,2", () => {
    const w = SUBWEIGHTS.security;
    expect(w.density + w.resolved + w.secrets + w.deps).toBeCloseTo(1, 9);
    const rest = w.density + w.resolved + w.secrets;
    expect(w.density / rest).toBeCloseTo(0.5, 9);
    expect(w.resolved / rest).toBeCloseTo(0.3, 9);
    expect(w.secrets / rest).toBeCloseTo(0.2, 9);
  });

  test("без lock-файла подметрика вне расчета, балл категории — как у модели без нее", () => {
    const cat = security(withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")])));
    expect(cat.submetrics.deps).toMatchObject({ score: null, value: null });
    expect(cat.submetrics.deps!.note).toContain("no lockfile graph");
    // прежняя формула: density 0,5 + resolved 0,3 + secrets 0,2
    const d = cat.submetrics.density!.score!;
    const r = cat.submetrics.resolved!.score!;
    expect(cat.score!).toBeCloseTo((0.5 * d + 0.3 * r + 0.2 * 1) * 100, 6);
  });

  test("старый факт без sca и факт с sca: null (корзины не ответили) — подметрика вне расчета даже при графе", () => {
    const old = security(withFacts(healthyFacts(), appsec(null), graphFact));
    expect(old.submetrics.deps!.score).toBeNull();
    expect(old.submetrics.deps!.note).toContain("no SCA package list");
    const legacy = withFacts(healthyFacts(), { key: "appsec.findings", value: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, resolved_share: 1, secrets_critical: false } }, graphFact);
    expect(security(legacy).submetrics.deps!.score).toBeNull();
  });

  test("граф есть, уязвимых пакетов нет — подтвержденное отсутствие, подметрика 1 и балл категории выше, чем без графа", () => {
    const clean = security(withFacts(healthyFacts(), appsec([]), graphFact));
    expect(clean.submetrics.deps!.score).toBe(1);
    expect((clean.submetrics.deps!.value as { vulnerable: number }).vulnerable).toBe(0);
    expect(SUBMETRICS["security.deps"]!.format(clean.submetrics.deps!.value, { at: null })).toBe("нет");
    const noGraph = security(withFacts(healthyFacts(), appsec([])));
    expect(clean.score!).toBeGreaterThan(noGraph.score!);
  });

  test("транзитивная уязвимость весит половину прямой: критичный qs через express мягче критичного lodash", () => {
    const direct = security(withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")]), graphFact));
    const transitive = security(withFacts(healthyFacts(), appsec([pkg("qs", "6.7.0", "critical")]), graphFact));
    const dv = direct.submetrics.deps!.value as { weighted: number; direct: number; transitive: number };
    const tv = transitive.submetrics.deps!.value as { weighted: number; direct: number; transitive: number };
    expect(dv).toMatchObject({ direct: 1, transitive: 0, weighted: SEVERITY_WEIGHTS.critical });
    expect(tv).toMatchObject({ direct: 0, transitive: 1, weighted: SEVERITY_WEIGHTS.critical / 2 });
    expect(transitive.submetrics.deps!.score!).toBeGreaterThan(direct.submetrics.deps!.score!);
    expect(transitive.score!).toBeGreaterThan(direct.score!);
    expect(direct.submetrics.deps!.score).toBeCloseTo(anchorScore(DEPS_WEIGHTED, 8), 9);
  });

  test("монотонность: больше уязвимых пакетов — не выше балл; несопоставленный пакет весит как прямой", () => {
    const one = security(withFacts(healthyFacts(), appsec([pkg("cookie", "0.4.0", "low")]), graphFact));
    const two = security(withFacts(healthyFacts(), appsec([pkg("cookie", "0.4.0", "low"), pkg("send", "0.17.1", "medium")]), graphFact));
    expect(two.submetrics.deps!.score!).toBeLessThanOrEqual(one.submetrics.deps!.score!);
    const unmatched = security(withFacts(healthyFacts(), appsec([pkg("left-pad", "1.0.0", "high")]), graphFact));
    const v = unmatched.submetrics.deps!.value as { unmatched: number; weighted: number };
    expect(v).toMatchObject({ unmatched: 1, weighted: SEVERITY_WEIGHTS.high });
    expect(SUBMETRICS["security.deps"]!.format(unmatched.submetrics.deps!.value, { at: null })).toBe("1: 0 прямых, 0 транзитивных, 1 не найдено в lock-файле");
  });

  test("потолки не смягчаются: открытая критичная находка держит 40 и при транзитивной уязвимости", () => {
    const facts = withFacts(healthyFacts(), appsec([pkg("qs", "6.7.0", "critical")], { severity_counts: { critical: 1, high: 0, medium: 0, low: 0 } }), graphFact);
    const cat = security(facts);
    expect(cat.score).toBe(40);
    expect(cat.adjustment).toMatchObject({ kind: "open-findings-cap", level: "critical" });
  });

  test("находки AppSec из истории (периодический скан без токена) – граф текущего скана с ними не сопоставляется", () => {
    const repoId = (t.db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('t', 'stale-deps') RETURNING id").get() as { id: number }).id;
    // скан 1: с токеном – находки и lock-файл; скан 2: без токена – находки no-data, lock-файл есть
    seedScan(t, withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")]), graphFact), 2, repoId);
    const scan2 = seedScan(t, withFacts(healthyFacts(), { key: "appsec.findings", value: { reason: "access" }, status: "no-data" }, graphFact), 0, repoId);
    const s = compute(t.db, scan2, { now: NOW });
    expect(s.stale).toContain("appsec.findings");
    expect(s.categories.security.score).not.toBeNull();
    expect(s.categories.security.submetrics.deps).toMatchObject({ score: null, value: null });
  });

  test("пакеты других экосистем совет не порождают сами по себе, но упоминаются рядом с пакетами графа", () => {
    const recs = (list: FactSpec[]) => recommend(t.db, seedScan(t, list), { now: NOW });
    const onlyGo = recs(withFacts(healthyFacts(), appsec([pkg("github.com/gin-gonic/gin", "1.9.0", "critical")]), graphFact));
    expect(onlyGo.map((r) => r.ruleId)).not.toContain("update-vulnerable-deps");
    const mixed = recs(withFacts(healthyFacts(), appsec([pkg("github.com/gin-gonic/gin", "1.9.0", "critical"), pkg("cookie", "0.4.0", "low")]), graphFact)).find((r) => r.ruleId === "update-vulnerable-deps")!;
    expect(mixed.problem).toContain("Критичных среди них нет.");
    expect(mixed.problem).toContain("Еще 1 уязвимый пакет другой экосистемы граф не покрывает, он учтен в плотности находок.");
  });

  test("HealthCraft Index не зависит от графа и пакетов SCA (публичный показатель без Безопасности)", () => {
    const base = compute(t.db, seedScan(t, healthyFacts()), { now: NOW }).healthcraftIndex;
    const withDeps = compute(t.db, seedScan(t, withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")]), graphFact)), { now: NOW }).healthcraftIndex;
    expect(withDeps).toBe(base);
  });
});

describe("карточка: граф lock-файлов хранится сжатым и читается карточкой", () => {
  const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };

  test("карточка открывается, подметрика видна зрителю с правами на AppSec, граф не отдается анониму", () => {
    const repoId = seedRepo({ db: t.db, close: () => {} }, { org: "deps", repo: "card" });
    const facts = cardFacts().filter((f) => f.key !== "appsec.findings").concat([appsec([pkg("lodash", "4.17.15", "critical"), pkg("qs", "6.7.0", "high")]) as never, graphFact as never]);
    const scanId = seedApiScan({ db: t.db, close: () => {} }, repoId, { facts, finishedAt: NOW.toISOString(), startedAt: NOW.toISOString() });
    seedScore({ db: t.db, close: () => {} }, repoId, scanId, { total: 55 });
    // в БД граф лежит с префиксом z: — ровно то, что ломало карточку голым JSON.parse
    const raw = t.db.query("SELECT value FROM facts WHERE scan_id = ? AND key = 'tree.lockgraph'").get(scanId) as { value: string };
    expect(raw.value.startsWith("z:")).toBe(true);
    const open = getRepoCard(t.db, "deps", "card", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    const deps = open.score!.categories.security.submetrics.deps!;
    expect(deps.score).not.toBeNull();
    expect(deps.value).toMatchObject({ vulnerable: 2, direct: 1, transitive: 1 });
    expect(open.evidence.some((e) => e.key === "tree.lockgraph")).toBe(true);
    expect(open.recommendations.some((r) => r.ruleId === "update-vulnerable-deps")).toBe(true);
    const anon = getRepoCard(t.db, "deps", "card", { access: NO_PAT_ACCESS })!;
    expect(anon.evidence.some((e) => e.key === "tree.lockgraph")).toBe(false);
    expect(anon.score?.categories.security.submetrics.deps).toBeUndefined();
  });
});

describe("совет «Обновите уязвимые зависимости»", () => {
  const facts = (packages: ReturnType<typeof pkg>[], graph = true) => {
    const list = withFacts(healthyFacts(), appsec(packages), ...(graph ? [graphFact] : []));
    const ok = new Map<string, unknown>(list.map((f) => [f.key, f.value]));
    return ok;
  };

  test("текст называет прямые, транзитивные через прямую и критичность; порядок — после appsec-high", () => {
    const ok = facts([pkg("lodash", "4.17.15", "critical"), pkg("minimist", "1.2.0", "critical"), pkg("qs", "6.7.0", "high"), pkg("body-parser", "1.19.0", "high"), pkg("left-pad", "1.0.0", "low")]);
    const p = recommendationParams("update-vulnerable-deps", ok);
    expect(p.depsDirect).toEqual(["lodash 4.17.15", "minimist 1.2.0"]);
    // пакеты одной критичности — по имени
    expect(p.depsVia).toEqual([{ through: "express", packages: ["body-parser 1.19.0", "qs 6.7.0"] }]);
    expect(p.depsUnmatched).toEqual(["left-pad 1.0.0"]);
    expect(p.depsCritical).toBe(true);
    const text = recommendationText("update-vulnerable-deps", p)!;
    expect(text.action).toBe("Обновите уязвимые зависимости");
    expect(text.problem).toBe(
      "AppSec нашел известные уязвимости в зависимостях: прямые зависимости lodash 4.17.15, minimist 1.2.0; через express в проект попадают body-parser 1.19.0, qs 6.7.0; left-pad 1.0.0 в lock-файле не найден и считается прямой. Среди них есть критичные. Обновите прямые зависимости до версий без известных уязвимостей – транзитивные обновятся вместе с ними.",
    );
    expect(text.expectedImpact).toContain("Безопасность");
    expect(SCORE_RULE_ORDER.indexOf("update-vulnerable-deps")).toBeGreaterThan(SCORE_RULE_ORDER.indexOf("appsec-high"));
  });

  test("без параметров текста нет (карточка покажет сохраненный); один пакет — формы единственного числа", () => {
    expect(recommendationText("update-vulnerable-deps", {})).toBeNull();
    const p = recommendationParams("update-vulnerable-deps", facts([pkg("cookie", "0.4.0", "low")]));
    expect(recommendationText("update-vulnerable-deps", p)!.problem).toContain("через express в проект попадает cookie 0.4.0. Критичных среди них нет.");
  });

  test("движок: правило есть при графе и уязвимых пакетах, нет без графа и без пакетов", () => {
    const recs = (list: FactSpec[]) => recommend(t.db, seedScan(t, list), { now: NOW });
    const withPkgs = recs(withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")]), graphFact));
    const rec = withPkgs.find((r) => r.ruleId === "update-vulnerable-deps")!;
    expect(rec).toBeDefined();
    expect(rec.channel).toBe("appsec");
    expect(rec.factRefs).toEqual(["appsec.findings", "tree.lockgraph"]);
    expect(rec.problem).toContain("lodash 4.17.15");
    const noGraph = recs(withFacts(healthyFacts(), appsec([pkg("lodash", "4.17.15", "critical")])));
    expect(noGraph.map((r) => r.ruleId)).not.toContain("update-vulnerable-deps");
    const clean = recs(withFacts(healthyFacts(), appsec([]), graphFact));
    expect(clean.map((r) => r.ruleId)).not.toContain("update-vulnerable-deps");
  });
});
