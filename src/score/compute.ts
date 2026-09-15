// compute.ts — детерминированный расчёт Score из фактов (§1, §4, §5):
// compute(db, scan_id, mode) → Scores. Tri-state: no-data субметрика
// → перенормировка внутри категории; категория целиком no-data → вес
// выбрасывается; coverage = Σ весов с данными / режимный максимум
// (публично 0.8 — Security no-data у всех); coverage < 0.4 → total
// NULL. Bad-channel (статус bad, §5.6): факты канала НЕ выбрасываются
// — берутся последние успешные того же kind (гранулярность по kind) +
// маркер stale; успешной истории нет → no-data. Robot-флаги v1 в
// фактах игнорируются — истина robot2 (derived). Критичные secrets →
// кап total ≤ 49 (§5/В2-8). Все числа — константы model.ts.
import type { Database } from "bun:sqlite";
import { categoryOf } from "../collectors/facts";
import { DerivedMetrics, deriveMetrics } from "./derived";
import {
  CI_CONFIG_ONLY_FACTOR,
  CLOSE_DAYS,
  COVERAGE_MODE_MAX,
  COVERAGE_NULL_BELOW,
  CATEGORY_WEIGHTS,
  CategoryKey,
  DURATION_MIN,
  FIRST_COMMENT_H,
  FRESH_MONTHS,
  ISSUES_TRACKER_UNUSED,
  MODEL_VERSION,
  OLD_SHARE,
  PASS_RATE,
  PULLS_90D,
  README_BYTES,
  README_QUALITY_SPLIT,
  README_SPLIT,
  RELEASES_12M,
  RESOLVED_SHARE,
  ROOT_ENTRIES,
  SECRETS_CRITICAL_TOTAL_CAP,
  SEVERITY_PER_10K,
  SEVERITY_WEIGHTS,
  STALE_SHARE,
  SUBWEIGHTS,
  TODO_PER_KLOC,
  anchorScore,
  anchorScoreLog,
  commitsPerMonthScore,
  contributorsScore,
} from "./model";

export type ScoreMode = "public" | "own";

export interface SubmetricScore {
  score: number | null;
  value?: unknown;
  note?: string;
}

export interface CategoryScore {
  /** 0..100 | null = категория no-data */
  score: number | null;
  no_data?: string;
  stale?: boolean;
  submetrics: Record<string, SubmetricScore>;
}

export interface Scores {
  scanId: number;
  repoId: number;
  modelVersion: string;
  mode: ScoreMode;
  /** NULL = недостаточно данных (coverage < 0.4) — не «плохо» */
  total: number | null;
  coverage: number;
  categories: Record<CategoryKey, CategoryScore>;
  /** derived-показатели (§7.3) — для отображения, не в БД */
  derived: DerivedMetrics;
  noData: string[];
  stale: string[];
  computedAt: string;
}

/** Kinds, которые читает compute (для bad-channel замещения историей). */
const READ_KINDS = [
  "activity.git.timeline",
  "activity.git.summary",
  "docs.presence",
  "docs.readme",
  "tree.stats",
  "cicd.configs",
  "cicd.runs",
  "code.todo",
  "issues.stats",
  "issues.comments_sample",
  "activity.rest",
  "appsec.findings",
];

const MONTH_MS = 30.44 * 24 * 3600_000;

/** Взвешенное среднее с перенормировкой no-data (sw=0 → null). */
function weighted(subs: [number, number | null][]): number | null {
  let sw = 0;
  let acc = 0;
  for (const [w, v] of subs) {
    if (v === null) continue;
    sw += w;
    acc += w * v;
  }
  return sw > 0 ? acc / sw : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function compute(
  db: Database,
  scanId: number,
  mode: ScoreMode,
  opts: { now?: Date } = {},
): Scores {
  const now = opts.now ?? new Date();
  const scan = db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number } | null;
  if (!scan) throw new Error(`scan ${scanId} not found`);
  const repoId = scan.repo_id;

  // факты скана + bad-channel → последние успешные того же kind (§5.6)
  const rows = db.query("SELECT key, value, status FROM facts WHERE scan_id = ?").all(scanId) as {
    key: string;
    value: string;
    status: string;
  }[];
  const ok = new Map<string, unknown>();
  const stale: string[] = [];
  const staleCats = new Set<string>();
  for (const kind of READ_KINDS) {
    const row = rows.find((r) => r.key === kind);
    if (!row) continue;
    if (row.status === "ok") {
      ok.set(kind, JSON.parse(row.value));
      continue;
    }
    if (row.status === "bad") {
      const prev = db
        .query(
          `SELECT f.value FROM facts f JOIN scans s ON s.id = f.scan_id
           WHERE f.key = ? AND f.status = 'ok' AND s.repo_id = ? AND f.scan_id < ?
           ORDER BY f.scan_id DESC LIMIT 1`,
        )
        .get(kind, repoId, scanId) as { value: string } | null;
      if (prev) {
        ok.set(kind, JSON.parse(prev.value));
        stale.push(kind);
        staleCats.add(categoryOf(kind));
      }
    }
    // no-data / bad без истории → kind отсутствует в ok → no-data субметрик
  }

  const derived = deriveMetrics(ok, now);
  const categories = {
    documentation: scoreDocumentation(ok, derived),
    cicd: scoreCicd(ok),
    security: scoreSecurity(ok),
    activity: scoreActivity(derived, now),
    issues: scoreIssues(ok, derived),
    code: scoreCode(derived),
  };
  for (const [k, cat] of Object.entries(categories)) {
    if (staleCats.has(k)) cat.stale = true;
  }

  let dataWeight = 0;
  let acc = 0;
  const noData: string[] = [];
  for (const key of Object.keys(categories) as CategoryKey[]) {
    const cat = categories[key]!;
    if (cat.score === null) {
      noData.push(`${key}: ${cat.no_data ?? "no data"}`);
      continue;
    }
    dataWeight += CATEGORY_WEIGHTS[key];
    acc += (cat.score / 100) * CATEGORY_WEIGHTS[key];
  }
  const coverage = Math.min(1, dataWeight / 100 / COVERAGE_MODE_MAX[mode]);
  let total: number | null = null;
  if (coverage >= COVERAGE_NULL_BELOW && dataWeight > 0) {
    total = (acc / dataWeight) * 100;
    const appsec = ok.get("appsec.findings") as { secrets_critical?: unknown } | undefined;
    if (appsec?.secrets_critical === true) {
      total = Math.min(total, SECRETS_CRITICAL_TOTAL_CAP);
    }
  }

  return {
    scanId,
    repoId,
    modelVersion: MODEL_VERSION,
    mode,
    total,
    coverage,
    categories,
    derived,
    noData,
    stale,
    computedAt: now.toISOString(),
  };
}

// ---------- категории ----------

function scoreDocumentation(ok: Map<string, unknown>, _derived: DerivedMetrics): CategoryScore {
  const presence = ok.get("docs.presence") as
    | { readme?: unknown; license?: unknown; contributing?: unknown; codeowners?: unknown }
    | undefined;
  const readme = ok.get("docs.readme") as
    | { bytes?: unknown; flags?: { install?: unknown; build?: unknown; test?: unknown }; present?: undefined }
    | { present?: boolean; bytes?: undefined; flags?: undefined }
    | undefined;
  if (!presence) {
    return { score: null, no_data: "git channel no-data", submetrics: {} };
  }
  const hasReadme = presence.readme === true;
  let quality = 0;
  if (hasReadme && readme && !("present" in readme)) {
    const bytesScore = anchorScore(README_BYTES, num(readme.bytes) ?? 0);
    const flags = (readme as { flags?: { install?: unknown; build?: unknown; test?: unknown } }).flags ?? {};
    const sectionsScore =
      ((flags.install === true ? 1 : 0) + (flags.build === true ? 1 : 0) + (flags.test === true ? 1 : 0)) / 3;
    quality = README_QUALITY_SPLIT.bytes * bytesScore + README_QUALITY_SPLIT.sections * sectionsScore;
  }
  const readmeSub = README_SPLIT.presence * (hasReadme ? 1 : 0) + README_SPLIT.quality * quality;
  const w = SUBWEIGHTS.documentation;
  const subs: [number, number | null][] = [
    [w.readme, readmeSub],
    [w.license, presence.license === true ? 1 : 0],
    [w.contributing, presence.contributing === true ? 1 : 0],
    [w.codeowners, presence.codeowners === true ? 1 : 0],
  ];
  const score = weighted(subs);
  return {
    score: score !== null ? score * 100 : null,
    submetrics: {
      readme: { score: readmeSub, value: readme },
      license: { score: presence.license === true ? 1 : 0 },
      contributing: { score: presence.contributing === true ? 1 : 0 },
      codeowners: { score: presence.codeowners === true ? 1 : 0 },
    },
  };
}

function scoreCicd(ok: Map<string, unknown>): CategoryScore {
  const configs = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown } | undefined;
  const runs = ok.get("cicd.runs") as { runs_count?: unknown; success_rate?: unknown; duration_p50?: unknown } | undefined;
  const configSub = configs ? (configs.has_ci_yaml === true && configs.has_steps === true ? 1 : 0) : null;
  if (configSub === null) {
    return { score: null, no_data: "git channel no-data", submetrics: {} };
  }
  if (configSub === 0) {
    // §5.1: нет ci.yaml / ci.yaml без шагов = CI нет = 0 (данные) —
    // даже если раны каким-то образом видны (раны без конфига — шум)
    return {
      score: 0,
      submetrics: {
        config: { score: 0, value: configs },
        pass_rate: { score: null, note: "no declared CI" },
        duration: { score: null, note: "no declared CI" },
      },
    };
  }
  const runsAvailable = runs !== undefined && (num(runs.runs_count) ?? 0) > 0;
  if (!runsAvailable) {
    // §5.1: конфиг без прогонов — потолок 50 (конфиг-скор × 0.5)
    return {
      score: configSub * CI_CONFIG_ONLY_FACTOR * 100,
      no_data: "ci runs no-data (access/absent) — config-only cap 50",
      submetrics: {
        config: { score: configSub, value: configs },
        pass_rate: { score: null, note: "runs no-data" },
        duration: { score: null, note: "runs no-data" },
      },
    };
  }
  const passSub = num(runs!.success_rate) !== null ? anchorScore(PASS_RATE, num(runs!.success_rate)!) : null;
  const durSub = num(runs!.duration_p50) !== null ? anchorScore(DURATION_MIN, num(runs!.duration_p50)! / 60) : null;
  const w = SUBWEIGHTS.cicd;
  const subs: [number, number | null][] = [
    [w.config, configSub],
    [w.pass_rate, passSub],
    [w.duration, durSub],
  ];
  const score = weighted(subs);
  return {
    score: score !== null ? score * 100 : null,
    submetrics: {
      config: { score: configSub, value: configs },
      pass_rate: { score: passSub, value: num(runs!.success_rate) },
      duration: { score: durSub, value: num(runs!.duration_p50) },
    },
  };
}

function scoreSecurity(ok: Map<string, unknown>): CategoryScore {
  const appsec = ok.get("appsec.findings") as
    | { severity_counts?: Record<string, unknown>; resolved_share?: unknown; secrets_critical?: unknown }
    | undefined;
  if (!appsec) {
    return { score: null, no_data: "AppSec data unavailable (public mode; own-repo scenario — В4)", submetrics: {} };
  }
  const tree = ok.get("tree.stats") as { loc?: unknown } | undefined;
  const loc = num(tree?.loc);
  const sc = appsec.severity_counts ?? {};
  const weightedDensity =
    SEVERITY_WEIGHTS.critical * (num(sc.critical) ?? 0) +
    SEVERITY_WEIGHTS.high * (num(sc.high) ?? 0) +
    SEVERITY_WEIGHTS.medium * (num(sc.medium) ?? 0) +
    SEVERITY_WEIGHTS.low * (num(sc.low) ?? 0);
  const per10k = loc !== null && loc > 0 ? weightedDensity / (loc / 10_000) : null;
  const densitySub = per10k !== null ? anchorScore(SEVERITY_PER_10K, per10k) : null;
  const resolvedSub = num(appsec.resolved_share) !== null ? anchorScore(RESOLVED_SHARE, num(appsec.resolved_share)!) : null;
  const secretsSub = appsec.secrets_critical === true ? 0 : 1;
  const w = SUBWEIGHTS.security;
  const score = weighted([
    [w.density, densitySub],
    [w.resolved, resolvedSub],
    [w.secrets, secretsSub],
  ]);
  return {
    score: score !== null ? score * 100 : null,
    submetrics: {
      density: { score: densitySub, value: per10k },
      resolved: { score: resolvedSub, value: num(appsec.resolved_share) },
      secrets: { score: secretsSub, value: appsec.secrets_critical === true },
    },
  };
}

function scoreActivity(derived: DerivedMetrics, now: Date): CategoryScore {
  const freshSub =
    derived.lastHumanCommitTs !== null
      ? anchorScore(FRESH_MONTHS, Math.max(0, (now.getTime() - derived.lastHumanCommitTs) / MONTH_MS))
      : null;
  const freqSub = derived.commitsPerMonth !== null ? commitsPerMonthScore(derived.commitsPerMonth) : null;
  const contribSub = derived.contributorsTotal !== null && derived.contributorsTotal > 0 ? contributorsScore(derived.contributorsTotal) : null;
  const pullsSub = derived.pulls90d !== null ? anchorScoreLog(PULLS_90D, derived.pulls90d) : null;
  const relSub = derived.releases12m !== null ? anchorScoreLog(RELEASES_12M, derived.releases12m) : null;
  const w = SUBWEIGHTS.activity;
  const score = weighted([
    [w.fresh, freshSub],
    [w.freq, freqSub],
    [w.contributors, contribSub],
    [w.pulls, pullsSub],
    [w.releases, relSub],
  ]);
  return {
    score: score !== null ? score * 100 : null,
    no_data: score === null ? "git+rest channels no-data" : undefined,
    submetrics: {
      fresh: { score: freshSub, value: derived.lastHumanCommitTs },
      freq: { score: freqSub, value: derived.commitsPerMonth },
      contributors: { score: contribSub, value: derived.contributorsTotal },
      pulls_90d: { score: pullsSub, value: derived.pulls90d },
      releases_12m: { score: relSub, value: derived.releases12m },
      // показ-без-веса (§2): mirror-likeness и динамика двух окон
      mirror_likeness: { score: null, value: derived.mirrorLikeness },
      commits_90d: { score: null, value: derived.commits90d },
      commits_365d: { score: null, value: derived.commits365d },
      sync_bursts: { score: null, value: derived.syncBursts },
    },
  };
}

function scoreIssues(ok: Map<string, unknown>, derived: DerivedMetrics): CategoryScore {
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown; median_close_days?: unknown } | undefined;
  if (!stats) {
    return { score: null, no_data: "issues channel no-data", submetrics: {} };
  }
  const open = num(stats.open) ?? 0;
  const closed = num(stats.closed) ?? 0;
  if (open === 0 && closed === 0) {
    // §5.3: 0/0 = данные «трекер не ведётся» — скор = вычислимый минимум
    return {
      score: ISSUES_TRACKER_UNUSED,
      submetrics: { tracker_unused: { score: ISSUES_TRACKER_UNUSED / 100, value: { open: 0, closed: 0 }, note: "tracker not maintained — category minimum (Q14)" } },
    };
  }
  const staleSub = derived.staleShare !== null ? anchorScore(STALE_SHARE, derived.staleShare) : null;
  const closeSub = num(stats.median_close_days) !== null ? anchorScore(CLOSE_DAYS, num(stats.median_close_days)!) : null;
  const resSub = derived.resolutionRatio !== null ? anchorScore(RESOLVED_SHARE, derived.resolutionRatio) : null;
  const comments = ok.get("issues.comments_sample") as { median_first_comment_delay_hours?: unknown } | undefined;
  const firstSub = num(comments?.median_first_comment_delay_hours) !== null ? anchorScore(FIRST_COMMENT_H, num(comments!.median_first_comment_delay_hours)!) : null;
  const w = SUBWEIGHTS.issues;
  const score = weighted([
    [w.stale, staleSub],
    [w.close_days, closeSub],
    [w.resolution, resSub],
    [w.first_resp, firstSub],
  ]);
  return {
    score: score !== null ? score * 100 : null,
    submetrics: {
      stale: { score: staleSub, value: derived.staleShare },
      close_days: { score: closeSub, value: num(stats.median_close_days) },
      resolution: { score: resSub, value: derived.resolutionRatio },
      first_resp: { score: firstSub, value: num(comments?.median_first_comment_delay_hours) },
    },
  };
}

function scoreCode(derived: DerivedMetrics): CategoryScore {
  const densitySub = derived.todoDensityPerKloc !== null ? anchorScore(TODO_PER_KLOC, derived.todoDensityPerKloc) : null;
  const oldSub = derived.oldShare !== null ? anchorScore(OLD_SHARE, derived.oldShare) : null;
  const rootSub = derived.rootEntries !== null ? anchorScore(ROOT_ENTRIES, derived.rootEntries) : null;
  const w = SUBWEIGHTS.code;
  const score = weighted([
    [w.density, densitySub],
    [w.old_share, oldSub],
    [w.root, rootSub],
  ]);
  return {
    score: score !== null ? score * 100 : null,
    no_data: score === null ? "git channel no-data" : undefined,
    submetrics: {
      density: { score: densitySub, value: derived.todoDensityPerKloc },
      old_share: { score: oldSub, value: derived.oldShare },
      root: { score: rootSub, value: derived.rootEntries },
      todo_total: { score: null, value: derived.todoTotal },
    },
  };
}

// ---------- запись (immutable: PK scan_id+model_version, идемпотентно) ----------

export function writeScores(db: Database, s: Scores): void {
  db.query(
    `INSERT OR REPLACE INTO scores
       (scan_id, model_version, repo_id, mode, total, coverage, categories, no_data, stale, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.scanId,
    s.modelVersion,
    s.repoId,
    s.mode,
    s.total === null ? null : Math.round(s.total),
    Math.round(s.coverage * 1000) / 1000,
    JSON.stringify(s.categories),
    JSON.stringify(s.noData),
    JSON.stringify(s.stale),
    s.computedAt,
  );
}
