// compute.ts — детерминированный расчёт Score из фактов (§1, §4, §5):
// compute(db, scan_id) → Scores с двумя итогами (В4.1/К1): «в рейтинге»
// (4 категории, максимум 0.65) и «полный» (6 категорий, максимум 1.0).
// Tri-state: no-data субметрика → перенормировка внутри категории;
// категория целиком no-data → вес выбрасывается; coverage = Σ весов с
// данными / максимум набора; coverage < 0.4 → итог NULL. Bad-channel
// (статус bad, §5.6): берутся последние успешные факты того же kind +
// маркер stale; для каналов с правами (cicd.runs, appsec.findings) — при
// любом не-ok. Robot-флаги v1 игнорируются — истина robot2 (derived).
// Критичные secrets → кап полного итога ≤ 49 (§5/В2-8). Все числа —
// константы model.ts.
import type { Database } from "bun:sqlite";
import { categoryOf } from "../collectors/facts";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import { DerivedMetrics, deriveMetrics } from "./derived";
import {
  CI_CONFIG_ONLY_FACTOR,
  CLOSE_DAYS,
  COVERAGE_NULL_BELOW,
  FULL_COVERAGE_BASE,
  INDEX_COVERAGE_BASE,
  INDEX_WEIGHTS,
  SCORE_WEIGHTS,
  CategoryKey,
  IndexCategoryKey,
  DURATION_MIN,
  FIRST_COMMENT_H,
  FRESH_MONTHS,
  ISSUES_TRACKER_UNUSED,
  MODEL_VERSION,
  OLD_SHARE,
  PASS_RATE,
  PULLS_90D,
  PUBLIC_CATEGORIES,
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

/**
 * Один анализ — одна оценка с ДВУМЯ показателями (В4.1, К1 → В4.3, Ф3.1):
 * HealthCraft Index (4 публичные категории, свой словарь весов, без капа)
 * и Repo Health Score (6 категорий, кап 49 за критичные secrets). Index —
 * прерассчитанное сохраняемое число (рейтинг сортирует по нему); полный
 * Score — дериватив показанных категорий, отдельным total НЕ хранится
 * (К-Ф3.3): здесь он считается для рекомендаций и скриптов, в хранении —
 * только индекс.
 */
export interface Scores {
  scanId: number;
  repoId: number;
  modelVersion: string;
  /** HealthCraft Index (4 категории); NULL = indexCoverage < 0.4 — не «плохо» */
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** Repo Health Score (6 категорий, кап 49); NULL = repoHealthCoverage < 0.4; в БД не хранится */
  repoHealthScore: number | null;
  repoHealthCoverage: number;
  /** все 6 категорий; CI/Security — со своими данными (или no-data) */
  categories: Record<CategoryKey, CategoryScore>;
  /** derived-показатели (§7.3) — для отображения; в БД с v1.3 (scores.derived) */
  derived: DerivedMetrics;
  noData: string[];
  stale: string[];
  /** без-кодовое репо (Q&A №13): file_count/loc = 0 при ok-фактах — Score 0 как данные («проекта нет»), не NULL */
  codeEmpty: boolean;
  computedAt: string;
}

/**
 * Kinds, которые читает compute (для bad-channel замещения историей).
 * Экспортируется: read-API строит по нему доказательную базу карточки —
 * дубль списка в API молча разошёлся бы при смене model_version.
 */
export const READ_KINDS = [
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

/**
 * Kinds каналов с правами зрителя (В4.1-fix, К-Ф1.1): CI (конфиг и прогоны)
 * и Security. Все фильтры карточки, рейтинга, stale, public_status и
 * пригодности скана строятся только от CHANNEL_KINDS / PUBLIC_KINDS.
 */
export const CHANNEL_KINDS = ["cicd.configs", "cicd.runs", "appsec.findings"];

/** Kinds публичных категорий (Score в рейтинге): READ_KINDS минус CHANNEL_KINDS. */
export const PUBLIC_KINDS = READ_KINDS.filter((k) => !CHANNEL_KINDS.includes(k));

/** Причины no-data, описывающие не репо, а права/сбой чтения — скан непригоден. */
const INELIGIBLE_NO_DATA_REASONS = ["access", "other"];

export interface EligibilityFact {
  key: string;
  status: string;
  /** git | rest:* | appsec:api — правило юзерского скана смотрит git-факты (круг 2, С5) */
  source: string;
  /** значение факта: объект или JSON-строка из БД */
  value: unknown;
}

/** Строка скана для правила пригодности: статус и автор. */
export interface EligibilityScan {
  status: string;
  /** автор (users.id); null — периодический скан серверным токеном */
  userId: number | null;
}

function noDataReason(value: unknown): unknown {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" ? (v as { reason?: unknown }).reason ?? null : null;
}

/**
 * Единое правило пригодности скана для рейтинга (К-Ф1.1; TASK.md §2
 * «Каталог, видимость и карточка» (4)): скан непригоден, если хоть один
 * факт PUBLIC_KINDS отсутствует, или status='bad', или no-data с причиной
 * access/other; no-data limits и причины, описывающие сам репо (пустой
 * репо), — пригоден. Одинаково для публичных и приватных.
 * Круг 2 (LOW-1, одно определение в хуке, rescoreAll и миграции): скан со
 * status bad (или незавершённый) непригоден; С5: юзерский скан (с автором)
 * с любым no-data git-фактом непригоден — медленный/узкий PAT не
 * выдаёт «репо больше лимита» за свойство репо. SQL-эквивалент —
 * ratingEligibleSql.
 */
export function ratingEligible(facts: EligibilityFact[], scan: EligibilityScan): boolean {
  if (scan.status === "bad" || scan.status === "running" || scan.status === "queued") return false;
  if (scan.userId !== null && facts.some((f) => f.source === "git" && f.status === "no-data")) return false;
  const byKey = new Map(facts.map((f) => [f.key, f]));
  for (const kind of PUBLIC_KINDS) {
    const f = byKey.get(kind);
    if (!f) return false;
    if (f.status === "bad") return false;
    if (f.status === "no-data" && INELIGIBLE_NO_DATA_REASONS.includes(String(noDataReason(f.value)))) return false;
  }
  return true;
}

const sqlList = (items: string[]) => items.map((k) => `'${k}'`).join(", ");

/** SQL-эквивалент ratingEligible: логическое выражение для строки scans с алиасом `scanAlias` (id, status, user_id). */
export function ratingEligibleSql(scanAlias: string): string {
  return `(${scanAlias}.status NOT IN ('bad', 'running', 'queued')
          AND (${scanAlias}.user_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM facts fg WHERE fg.scan_id = ${scanAlias}.id AND fg.source = 'git' AND fg.status = 'no-data'))
          AND (SELECT COUNT(*) FROM facts f
            WHERE f.scan_id = ${scanAlias}.id
              AND f.key IN (${sqlList(PUBLIC_KINDS)})
              AND f.status <> 'bad'
              AND NOT (f.status = 'no-data' AND COALESCE(json_extract(f.value, '$.reason'), '') IN (${sqlList(INELIGIBLE_NO_DATA_REASONS)}))
          ) = ${PUBLIC_KINDS.length})`;
}

/** Повторная миграция пригодности всех сканов одним UPDATE (круг 2: derived_version 2) + public_status следов старого процесса. */
export function migrateEligibility(db: Database): void {
  db.exec(`UPDATE scans SET rating_eligible = CASE WHEN ${ratingEligibleSql("scans")} THEN 1 ELSE 0 END`);
  db.exec(`UPDATE scans SET public_status = ${publicStatusSql("scans")} WHERE public_status IS NULL AND status NOT IN ('running', 'queued')`);
}

export interface StatusFact {
  key: string;
  status: string;
  source: string;
}

/**
 * Статус скана по фактам (runner): bad = фатал воркера или ни одного ok-факта
 * git/REST; ok = все факты ok; иначе partial. Тот же алгоритм на фактах
 * PUBLIC_KINDS даёт scans.public_status (Ф1.11).
 */
export function scanStatusOf(facts: StatusFact[], workerFatal: boolean): "ok" | "partial" | "bad" {
  const gitHasOk = facts.some((f) => f.source === "git" && f.status === "ok");
  const restHasOk = facts.some((f) => f.source.startsWith("rest:") && f.status === "ok");
  if (workerFatal) return "bad";
  if (!gitHasOk && !restHasOk) return "bad";
  if (facts.every((f) => f.status === "ok")) return "ok";
  return "partial";
}

/** SQL-эквивалент public_status для миграции (статус «bad» полного скана влечёт bad публичного). */
export function publicStatusSql(scanAlias: string): string {
  const pub = `f.scan_id = ${scanAlias}.id AND f.key IN (${sqlList(PUBLIC_KINDS)})`;
  return `CASE
    WHEN ${scanAlias}.status IN ('queued', 'running') THEN ${scanAlias}.status
    WHEN ${scanAlias}.status = 'bad' THEN 'bad'
    WHEN NOT EXISTS (SELECT 1 FROM facts f WHERE ${pub} AND f.status = 'ok' AND (f.source = 'git' OR f.source LIKE 'rest:%')) THEN 'bad'
    WHEN EXISTS (SELECT 1 FROM facts f WHERE ${pub} AND f.status <> 'ok') THEN 'partial'
    ELSE 'ok' END`;
}

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

/**
 * Каналы с правами зрителя (К1): для них факт «не ok» (no-data, bad или
 * отсутствие строки) замещается последним ok-фактом того же kind из
 * более раннего скана репо — скан без PAT (периодика) не стирает CI и
 * Security, собранные сканом с PAT участника. Показ защищён проверкой
 * доступа зрителя (К2): данные чужого PAT видит только тот, у кого есть
 * доступ к тому же каналу.
 */
export const CHANNEL_FALLBACK_KINDS = ["cicd.runs", "appsec.findings"];

export interface EffectiveFacts {
  ok: Map<string, unknown>;
  stale: string[];
  staleCats: Set<string>;
}

/**
 * Факты скана с замещением историей: bad → последний ok того же kind
 * (§5.6, все kinds); для CHANNEL_FALLBACK_KINDS — любой не-ok. Общая
 * точка compute и recommend (рекомендации не противоречат Score).
 */
export function effectiveFacts(db: Database, scanId: number, repoId: number): EffectiveFacts {
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
    if (row && row.status === "ok") {
      ok.set(kind, JSON.parse(row.value));
      continue;
    }
    const channel = CHANNEL_FALLBACK_KINDS.includes(kind);
    if (!channel && (!row || row.status !== "bad")) continue;
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
    // без истории → kind отсутствует в ok → no-data субметрик
  }
  return { ok, stale, staleCats };
}

export function compute(db: Database, scanId: number, opts: { now?: Date } = {}): Scores {
  const now = opts.now ?? new Date();
  const scan = db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number } | null;
  if (!scan) throw new Error(`scan ${scanId} not found`);
  const eff = effectiveFacts(db, scanId, scan.repo_id);
  return computeFromFacts(eff.ok, { scanId, repoId: scan.repo_id, stale: eff.stale, staleCats: eff.staleCats }, now);
}

/** Происхождение фактов для computeFromFacts: идентификаторы скана и маркеры замещения историей. */
export interface ComputeInput {
  scanId: number;
  repoId: number;
  /** kinds, взятые из истории (effectiveFacts) */
  stale?: string[];
  staleCats?: Set<string>;
}

/**
 * Чистый расчёт Score из эффективных фактов (В4.1-fix, К-Ф1.2): без БД.
 * compute = effectiveFacts + computeFromFacts; recommend считает реальный
 * прирост правила вторым вызовом на подменённых фактах.
 */
export function computeFromFacts(ok: Map<string, unknown>, input: ComputeInput, now: Date): Scores {
  const { scanId, repoId } = input;
  const stale = input.stale ?? [];
  const staleCats = input.staleCats ?? new Set<string>();

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

  // без-кодовое репо (Q&A №13): ok-факт говорит file_count=0 — «проекта нет»
  // = Score 0 как данные, не NULL и не no-data.
  // Ф2.3 (M5, В4.2a — явное исключение из «модель не трогать»): признаком
  // был ещё и `loc === 0`, а нулевой LOC при живом дереве штатно бывает у
  // обрыва `git cat-file` (теперь loc = null), у репо из одних бинарных
  // файлов и у файлов больше textCap. Жёсткий Score 0 по такому признаку —
  // нарушение закона 2 (отсутствие данных не ухудшает Score).
  const tree = ok.get("tree.stats") as { file_count?: unknown } | undefined | null;
  const codeEmpty = tree !== undefined && tree !== null && typeof tree.file_count === "number" && tree.file_count === 0;

  const allKeys = Object.keys(categories) as CategoryKey[];
  const noData: string[] = [];
  for (const key of allKeys) {
    const cat = categories[key]!;
    if (cat.score === null) noData.push(`${key}: ${cat.no_data ?? "no data"}`);
  }

  const appsecFact = ok.get("appsec.findings") as { secrets_critical?: unknown } | undefined | null;
  const totals = totalsFromCategories(categories, { codeEmpty, secretsCritical: appsecFact?.secrets_critical === true });

  return {
    scanId,
    repoId,
    modelVersion: MODEL_VERSION,
    healthcraftIndex: totals.healthcraftIndex,
    indexCoverage: totals.indexCoverage,
    repoHealthScore: totals.repoHealthScore,
    repoHealthCoverage: totals.repoHealthCoverage,
    categories,
    derived,
    noData,
    stale,
    codeEmpty,
    computedAt: now.toISOString(),
  };
}

/** Оба показателя из готовых категорий (В4.3, К-Ф1.2/К-Ф3.1). */
export interface Totals {
  /** HealthCraft Index — взвешенное среднее четвёрки со словарём INDEX_WEIGHTS */
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** Repo Health Score — взвешенное среднее шести со словарём SCORE_WEIGHTS, кап 49 */
  repoHealthScore: number | null;
  repoHealthCoverage: number;
}

/**
 * Оба показателя из готовых категорий (круга 2 → В4.3): взвешенное среднее
 * с перенормировкой no-data. Индекс четвёрки — свой словарь INDEX_WEIGHTS
 * (23/23/23/31), полный Score — SCORE_WEIGHTS (20/15/15/15/15/20); ни один
 * не является перенормировкой другого. Coverage обоих — доля номинальной
 * массы SCORE_WEIGHTS с данными: индекс от 65 (масса четвёрки), полный от
 * 100. compute и карточка (полный Score из показанных категорий) — одна
 * формула. Кап 49 применяется только полному Score.
 */
export function totalsFromCategories(
  categories: Record<CategoryKey, { score: number | null }>,
  flags: { codeEmpty: boolean; secretsCritical: boolean },
): Totals {
  const coverageOf = (keys: CategoryKey[], base: number): number => {
    let dataWeight = 0;
    for (const key of keys) {
      const cat = categories[key];
      if (cat && cat.score !== null) dataWeight += SCORE_WEIGHTS[key];
    }
    return Math.min(1, dataWeight / base);
  };
  const totalOf = (weightOf: (key: CategoryKey) => number, keys: CategoryKey[], coverage: number, capSecrets: boolean): number | null => {
    let dataWeight = 0;
    let acc = 0;
    for (const key of keys) {
      const cat = categories[key];
      if (!cat || cat.score === null) continue;
      dataWeight += weightOf(key);
      acc += (cat.score / 100) * weightOf(key);
    }
    let total: number | null = null;
    if (flags.codeEmpty) {
      total = 0;
    } else if (coverage >= COVERAGE_NULL_BELOW && dataWeight > 0) {
      total = (acc / dataWeight) * 100;
      if (capSecrets && flags.secretsCritical) total = Math.min(total, SECRETS_CRITICAL_TOTAL_CAP);
    }
    return total;
  };
  const indexWeightOf = (key: CategoryKey): number => INDEX_WEIGHTS[key as IndexCategoryKey];
  // порядок суммирования шести — как у compute до круга 2 (числа с плавающей точкой бит-в-бит)
  return {
    healthcraftIndex: totalOf(indexWeightOf, PUBLIC_CATEGORIES, coverageOf(PUBLIC_CATEGORIES, INDEX_COVERAGE_BASE), false),
    indexCoverage: coverageOf(PUBLIC_CATEGORIES, INDEX_COVERAGE_BASE),
    repoHealthScore: totalOf(
      (key) => SCORE_WEIGHTS[key],
      ["documentation", "cicd", "security", "activity", "issues", "code"],
      coverageOf(["documentation", "cicd", "security", "activity", "issues", "code"], FULL_COVERAGE_BASE),
      true,
    ),
    repoHealthCoverage: coverageOf(["documentation", "cicd", "security", "activity", "issues", "code"], FULL_COVERAGE_BASE),
  };
}

// ---------- категории ----------

function scoreDocumentation(ok: Map<string, unknown>, _derived: DerivedMetrics): CategoryScore {
  const presence = ok.get("docs.presence") as DocsPresenceValue | undefined;
  const readme = ok.get("docs.readme") as DocsReadmeValue | undefined;
  if (!presence) {
    return { score: null, no_data: "git channel no-data", submetrics: {} };
  }
  const hasReadme = presence.readme === true;
  let quality = 0;
  if (hasReadme && readme && !("present" in readme)) {
    const bytesScore = anchorScore(README_BYTES, num(readme.bytes) ?? 0);
    const flags = readme.flags ?? {};
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
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (!appsec) {
    return { score: null, no_data: "AppSec data unavailable (no AppSec access or no finished scan)", submetrics: {} };
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
      // К-Р14: неполная выборка TODO — причина no-data рядом со значением
      old_share: { score: oldSub, value: derived.oldShare, ...(derived.oldShareNoData ? { note: derived.oldShareNoData } : {}) },
      root: { score: rootSub, value: derived.rootEntries },
      todo_total: { score: null, value: derived.todoTotal },
    },
  };
}

// ---------- запись (immutable: PK scan_id+model_version, идемпотентно) ----------

const roundTotal = (x: number | null): number | null => (x === null ? null : Math.round(x));
const roundCoverage = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * В4.3 (Б1, переходный шаг): полное имя колонок прежнее — схема 1.8 ещё
 * живёт; Б2 поднимает схему до 1.9 (healthcraft_index/index_coverage без
 * полного итога) и эта вставка переезжает на новые колонки. Отдельного
 * хранимого полного total в актуальной схеме не будет (К-Ф3.3).
 */
export function writeScores(db: Database, s: Scores): void {
  db.query(
    `INSERT OR REPLACE INTO scores
       (scan_id, model_version, repo_id, total_rating, coverage_rating, total_full, coverage_full,
        categories, no_data, stale, computed_at, derived, code_empty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.scanId,
    s.modelVersion,
    s.repoId,
    roundTotal(s.healthcraftIndex),
    roundCoverage(s.indexCoverage),
    roundTotal(s.repoHealthScore),
    roundCoverage(s.repoHealthCoverage),
    JSON.stringify(s.categories),
    JSON.stringify(s.noData),
    JSON.stringify(s.stale),
    s.computedAt,
    JSON.stringify(s.derived),
    s.codeEmpty ? 1 : 0,
  );
}
