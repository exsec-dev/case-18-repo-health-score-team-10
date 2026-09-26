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
import { categoryOf, parseFactValue } from "../collectors/facts";
import { rootHasNoSource } from "../collectors/source-path";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import { DerivedMetrics, deriveMetrics, issuesClosedCounted } from "./derived";
import { roundScore } from "../web/format";
import {
  CLOSE_DAYS,
  CODE_FULL_LOC,
  CODE_NEUTRAL,
  OLD_SHARE_MIN_BASE,
  SECURITY_OPEN_CAPS,
  TEST_SHARE,
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
  ISSUES_FULL_SAMPLE,
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

/**
 * 4.3.0 (Н5, Р3): поправка к взвешенному среднему категории — таблица
 * «Балл категории» приложения сходится с итогом, а карточка называет причину.
 * `raw` — балл до поправки (0..100).
 */
export type CategoryAdjustment =
  /** Задачи: закрытых (проживших ≥ 1 ч) меньше полной выборки — балл сжат к минимуму */
  | { kind: "small-sample"; n: number; full: number; raw: number; floor: number }
  /** Безопасность: открытые находки critical/high — потолок категории */
  | { kind: "open-findings-cap"; level: "critical" | "high"; limit: number; raw: number }
  /** Состояние кода (круг 2, В3): строк кода меньше `full` — балл сжат к нейтрали `center` */
  | { kind: "small-code"; loc: number; full: number; raw: number; center: number };

export interface CategoryScore {
  /** 0..100 | null = категория no-data */
  score: number | null;
  no_data?: string;
  stale?: boolean;
  submetrics: Record<string, SubmetricScore>;
  /** 4.3.0: поправка к взвешенному среднему (сжатие малой выборки, потолок) */
  adjustment?: CategoryAdjustment;
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
      // кодек-осознанно (круг 2 В4.4): строка может быть сжатой (z:-префикс,
      // легаси круга 1) — parseFactValue разворачивает её перед парсом;
      // JS- и SQL-правила пригодности обязаны видеть одну причину
      v = parseFactValue(v);
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

/** SQL-эквивалент ratingEligible: логическое выражение для строки scans с алиасом `scanAlias` (id, status, user_id).
 *  Круг 2 В4.4: причина no-data читается кодек-осознанно — json_extract по сжатой
 *  (z:) строке бросал `malformed JSON` и ронял migrateEligibility (крэш-луп
 *  стартового рескора). SQLite разворачивать zlib не умеет, поэтому сжатая
 *  no-data-строка читается как «причина неизвестна» (NULL — не дисквалификатор);
 *  после фикса write-side no-data значения не сжимаются вовсе, окно — только
 *  легаси-строки круга 1. Одна функция — фикс покрывает db.ts и migrateEligibility. */
export function ratingEligibleSql(scanAlias: string): string {
  return `(${scanAlias}.status NOT IN ('bad', 'running', 'queued')
          AND (${scanAlias}.user_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM facts fg WHERE fg.scan_id = ${scanAlias}.id AND fg.source = 'git' AND fg.status = 'no-data'))
          AND (SELECT COUNT(*) FROM facts f
            WHERE f.scan_id = ${scanAlias}.id
              AND f.key IN (${sqlList(PUBLIC_KINDS)})
              AND f.status <> 'bad'
              AND NOT (f.status = 'no-data' AND COALESCE(CASE WHEN f.value LIKE 'z:%' THEN NULL ELSE json_extract(f.value, '$.reason') END, '') IN (${sqlList(INELIGIBLE_NO_DATA_REASONS)}))
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
  /**
   * 4.2.0 (М1.1 аудита В5.3): git-канал подтвердил, что коммитов нет (no-data
   * с причиной `empty` у сканов до правки сборщика М2). Пустота — факт
   * «проекта нет» (Q&A №13), а не отсутствие данных.
   */
  emptyRepo: boolean;
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
  const treeRow = rows.find((r) => r.key === "tree.stats");
  const emptyRepo = treeRow?.status === "no-data" && (parseFactValue(treeRow.value) as { reason?: unknown } | null)?.reason === "empty";
  for (const kind of READ_KINDS) {
    const row = rows.find((r) => r.key === kind);
    if (row && row.status === "ok") {
      ok.set(kind, parseFactValue(row.value));
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
      ok.set(kind, parseFactValue(prev.value));
      stale.push(kind);
      staleCats.add(categoryOf(kind));
    }
    // без истории → kind отсутствует в ok → no-data субметрик
  }
  return { ok, stale, staleCats, emptyRepo };
}

export function compute(db: Database, scanId: number, opts: { now?: Date } = {}): Scores {
  const now = opts.now ?? new Date();
  const scan = db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number } | null;
  if (!scan) throw new Error(`scan ${scanId} not found`);
  const eff = effectiveFacts(db, scanId, scan.repo_id);
  return computeFromFacts(eff.ok, { scanId, repoId: scan.repo_id, stale: eff.stale, staleCats: eff.staleCats, emptyRepo: eff.emptyRepo }, now);
}

/** Происхождение фактов для computeFromFacts: идентификаторы скана и маркеры замещения историей. */
export interface ComputeInput {
  scanId: number;
  repoId: number;
  /** kinds, взятые из истории (effectiveFacts) */
  stale?: string[];
  staleCats?: Set<string>;
  /** git-канал подтвердил пустой репозиторий (EffectiveFacts.emptyRepo) */
  emptyRepo?: boolean;
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
  const git: GitState = { empty: input.emptyRepo === true };
  const emptyKind = codeEmptyKind(ok, git);
  const codeEmpty = emptyKind !== null;
  const categories: Record<CategoryKey, CategoryScore> = {
    documentation: scoreDocumentation(ok, git),
    cicd: scoreCicd(ok, git),
    security: scoreSecurity(ok),
    activity: scoreActivity(derived, now, git),
    issues: scoreIssues(ok, derived),
    // 4.3.1 (В5.5 тур 1, П-1 парковки В4.9): «кода нет» — явная ветка балла 0
    // с причиной, а не «нет данных»: код в репозитории ЗАВЕДОМО отсутствует
    // (это факт о репо, Q&A №13), tri-state «no-data не ухудшает» про незнание,
    // а не про подтвержденную пустоту. 4.3.0 (Н3) давала здесь null. Причина
    // остается в `no_data` — её читают карточка (partialNote) и полоса вкладов.
    code: emptyKind !== null ? { score: 0, no_data: `no source code — ${emptyKind}`, submetrics: {} } : scoreCode(derived, ok.has("tree.stats")),
  };
  for (const [k, cat] of Object.entries(categories)) {
    if (staleCats.has(k)) cat.stale = true;
  }

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

/** Что git-канал сказал о репозитории: пустой (нет коммитов) — факт, а не «не прочитан». */
interface GitState {
  empty: boolean;
}

/**
 * 4.3.0 (Н4): причина «нет данных» у git-категорий по виду — репозиторий пуст
 * (коммитов нет, данные) или не прочитан (лимит, ошибка — незнание).
 */
const gitNoData = (git: GitState): string => (git.empty ? "repository empty" : "git channel no-data");

/** Вид «кода нет» (Q&A №13: оценка 0 как данные) или null — код есть или неизвестно. */
export type CodeEmptyKind = "repository empty" | "no files" | "only non-code files" | "no lines of code";

/**
 * Без-кодовое репо (Q&A №13): «проекта нет» = Score 0 как данные, не NULL.
 * 4.2.0 (М1.1): и репо без единого коммита; (М2.3) и репо без файлов кода —
 * только README, лицензия, картинки; факты до правки сборщика — по корню
 * без каталогов. 4.3.0 (Н3): и файлы кода без единой строки (`source_loc = 0`
 * у новых фактов) — пустой `a.js` признак не снимает (F16). `source_loc = null`
 * (обрыв чтения) — не «кода нет»: это незнание (Ф2.3, закон 2).
 */
export function codeEmptyKind(ok: Map<string, unknown>, git: GitState): CodeEmptyKind | null {
  if (git.empty) return "repository empty";
  const tree = ok.get("tree.stats") as { file_count?: unknown; source_files?: unknown; source_loc?: unknown; source_unread?: unknown; top_level?: unknown } | undefined | null;
  if (tree === undefined || tree === null) return null;
  if (typeof tree.file_count === "number" && tree.file_count === 0) return "no files";
  if (tree.source_files === 0) return "only non-code files";
  if (!("source_files" in tree) && rootHasNoSource(tree.top_level)) return "only non-code files";
  // круг 2 (К3, E3): 0 строк при непрочитанных файлах кода (больше лимита
  // текста, бинарные) — строки не прочитаны (незнание), а не «кода нет»
  const unread = typeof tree.source_unread === "number" && tree.source_unread > 0;
  if (typeof tree.source_loc === "number" && tree.source_loc === 0 && !unread) return "no lines of code";
  return null;
}

/**
 * Лицензия засчитана — ОДНО выражение для расчета и рекомендации (Н7, F7):
 * признак сборщика; у фактов до Р4в (без `content_checked`) — и имя в корне
 * (М1.13: `LICENSE-MIT`, `COPYING`…). Сборщик 3 проверил содержимое — имя
 * пустого файла лицензию не дает.
 */
export function licensePresent(ok: Map<string, unknown>): boolean {
  const presence = ok.get("docs.presence") as (DocsPresenceValue & { content_checked?: unknown }) | undefined;
  if (!presence) return false;
  return presence.license === true || (presence.content_checked !== true && licenseInRoot(ok));
}

function scoreDocumentation(ok: Map<string, unknown>, git: GitState): CategoryScore {
  const presence = ok.get("docs.presence") as DocsPresenceValue | undefined;
  const readme = ok.get("docs.readme") as DocsReadmeValue | undefined;
  if (!presence) {
    return { score: null, no_data: gitNoData(git), submetrics: {} };
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
  const license = licensePresent(ok) ? 1 : 0;
  const subs: [number, number | null][] = [
    [w.readme, readmeSub],
    [w.license, license],
    [w.contributing, presence.contributing === true ? 1 : 0],
    [w.codeowners, presence.codeowners === true ? 1 : 0],
  ];
  // все четыре подметрики — числа: взвешенное среднее всегда есть
  const score = weighted(subs)!;
  return {
    score: score * 100,
    submetrics: {
      readme: { score: readmeSub, value: readme },
      license: { score: license },
      contributing: { score: presence.contributing === true ? 1 : 0 },
      codeowners: { score: presence.codeowners === true ? 1 : 0 },
    },
  };
}

/**
 * 4.2.0 (М1.13): лицензия под иным именем — `LICENSE-MIT`, `LICENSE.APACHE`,
 * `COPYING*`, `UNLICENSE`, каталог `LICENSES/` (сборщик до М2 искал только
 * `licen[cs]e*`); корень хранится в `tree.stats.top_level`.
 */
const LICENSE_NAME = /^(licen[cs]es?|copying|unlicense)([._-].*)?$/i;

function licenseInRoot(ok: Map<string, unknown>): boolean {
  const tree = ok.get("tree.stats") as { top_level?: unknown } | undefined;
  if (!Array.isArray(tree?.top_level)) return false;
  return tree!.top_level!.some((e) => {
    const name = typeof e === "string" ? e : (e as { name?: unknown } | null)?.name;
    return typeof name === "string" && LICENSE_NAME.test(name);
  });
}

function scoreCicd(ok: Map<string, unknown>, git: GitState): CategoryScore {
  const configs = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown; steps_note?: unknown } | undefined;
  const runs = ok.get("cicd.runs") as {
    runs_count?: unknown;
    success_rate?: unknown;
    weighted_success_rate?: unknown;
    duration_p50?: unknown;
  } | undefined;
  if (configs && configs.has_ci_yaml === true && (typeof configs.has_steps !== "boolean" || typeof configs.steps_note === "string")) {
    // 4.2.0 (М2.1 аудита): ci.yaml не разобран — неизвестно, есть ли шаги;
    // это не «CI без шагов = 0», а отсутствие данных
    return { score: null, no_data: "ci.yaml not parsed — steps unknown", submetrics: {} };
  }
  if (!configs) {
    return { score: null, no_data: gitNoData(git), submetrics: {} };
  }
  const configSub = configs.has_ci_yaml === true && configs.has_steps === true ? 1 : 0;
  if (runs === undefined) {
    // 4.3.0 (Н8, J11/F10): запуски не видны — «нет данных» НЕЗАВИСИМО от
    // ci.yaml. Раньше «нет ci.yaml» давало 0, а заглушка ci.yaml без видимых
    // запусков — «нет данных»: перенормировка поднимала полный Score на
    // +15,6 за конфиг без доказательства. Решение 23.09 (Алексей) о невидимых
    // запусках распространено и на репо без конфига: без запусков CI не оцениваем.
    return {
      score: null,
      no_data: CI_RUNS_INVISIBLE,
      submetrics: {
        config: { score: configSub, value: configs },
        pass_rate: { score: null, note: "runs no-data" },
        duration: { score: null, note: "runs no-data" },
      },
    };
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
  // 4.2.0 (М1.8): запуски ВИДНЫ и их 0 — данные «CI заявлен, но не запускался»
  // (заглушка ci.yaml не выгоднее настоящего CI); все запуски старше
  // последней ленты свежести (поле есть, значение null) — то же «за год не
  // запускался». Решение 23.09 о невидимых запусках (no-data) не меняется.
  const runsCount = num(runs.runs_count);
  // М2.5: запуски есть, но ни один не завершен (идут, отменены) — результата
  // еще нет: это не «не запускался», а отсутствие данных
  const pendingOnly = runsCount === 0 && (num((runs as { runs_total?: unknown }).runs_total) ?? 0) > 0;
  if (pendingOnly) {
    // 4.3.0 (Н14б, D11): своя причина — «не видны» здесь было бы ложью
    return {
      score: null,
      no_data: "ci runs pending — запуски идут, завершенных нет",
      submetrics: {
        config: { score: configSub, value: configs },
        pass_rate: { score: null, note: "runs pending" },
        duration: { score: null, note: "runs pending" },
      },
    };
  }
  const staleOnly = runsCount !== null && runsCount > 0 && "weighted_success_rate" in runs && runs.weighted_success_rate === null;
  if (runsCount === 0 || staleOnly) {
    const wn = SUBWEIGHTS.cicd;
    const s = weighted([
      [wn.config, configSub],
      [wn.pass_rate, 0],
      [wn.duration, null],
    ])!;
    return {
      score: s * 100,
      submetrics: {
        config: { score: configSub, value: configs },
        // Н14б: значения доли нет — «не запускался» словами, а не «0%» («все упали»)
        pass_rate: { score: 0, value: null, note: runsCount === 0 ? "no runs" : "no runs within a year" },
        duration: { score: null, note: "no recent runs" },
      },
    };
  }
  if (runsCount === null) {
    // факт запусков без счетчика — формы не знаем, оценки не даем
    return {
      score: null,
      no_data: CI_RUNS_INVISIBLE,
      submetrics: {
        config: { score: configSub, value: configs },
        pass_rate: { score: null, note: "runs no-data" },
        duration: { score: null, note: "runs no-data" },
      },
    };
  }
  // 23.09 (Алексей): pass_rate по ВЗВЕШЕННОЙ доле успеха (ленты свежести —
  // свежие прогоны весомее), fallback на простой агрегат старых фактов
  const passInput = num(runs.weighted_success_rate) ?? num(runs.success_rate);
  const passSub = passInput !== null ? anchorScore(PASS_RATE, passInput) : null;
  // Н8б: длительность нового сборщика — по успешным запускам
  const durSub = num(runs.duration_p50) !== null ? anchorScore(DURATION_MIN, num(runs.duration_p50)! / 60) : null;
  const w = SUBWEIGHTS.cicd;
  const subs: [number, number | null][] = [
    [w.config, configSub],
    [w.pass_rate, passSub],
    [w.duration, durSub],
  ];
  const score = weighted(subs)!;
  return {
    score: score * 100,
    submetrics: {
      config: { score: configSub, value: configs },
      pass_rate: { score: passSub, value: passInput },
      duration: { score: durSub, value: num(runs.duration_p50) },
    },
  };
}

/**
 * Причина «нет данных» CI без видимых запусков (23.09, Алексей; 4.3.0 — и без
 * ci.yaml). Подстрока «прогоны не видны» — маркер карточки (`ciConfigOnlyCap`).
 */
export const CI_RUNS_INVISIBLE = "ci runs no-data — прогоны не видны, автоматизацию не оцениваем";

function scoreSecurity(ok: Map<string, unknown>): CategoryScore {
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (!appsec) {
    return { score: null, no_data: "AppSec data unavailable (no AppSec access or no finished scan)", submetrics: {} };
  }
  // 4.3.0 (Н11, F21/J20): плотность — по строкам КОДА (`source_loc`), как у
  // TODO; факты до правки М2.3 — весь `loc`; обрыв чтения (`source_loc = null`) — неизвестно
  const tree = ok.get("tree.stats") as { loc?: unknown; source_loc?: unknown } | undefined;
  const loc = tree !== undefined && "source_loc" in tree ? num(tree.source_loc) : num(tree?.loc);
  const sc = appsec.severity_counts ?? {};
  const critical = num(sc.critical) ?? 0;
  const high = num(sc.high) ?? 0;
  const weightedDensity =
    SEVERITY_WEIGHTS.critical * critical +
    SEVERITY_WEIGHTS.high * high +
    SEVERITY_WEIGHTS.medium * (num(sc.medium) ?? 0) +
    SEVERITY_WEIGHTS.low * (num(sc.low) ?? 0);
  // 4.3.0: находок нет — плотность 0 и без числа строк (подтвержденное отсутствие — данные)
  const per10k = weightedDensity === 0 ? 0 : loc !== null && loc > 0 ? weightedDensity / (loc / 10_000) : null;
  const densitySub = per10k !== null ? anchorScore(SEVERITY_PER_10K, per10k) : null;
  const resolvedSub = num(appsec.resolved_share) !== null ? anchorScore(RESOLVED_SHARE, num(appsec.resolved_share)!) : null;
  const secretsSub = appsec.secrets_critical === true ? 0 : 1;
  if (densitySub === null && resolvedSub === null) {
    // 4.2.0 (М1.2): без плотности и доли закрытых категорию нес бы один
    // признак утечки — 100 при любом числе критичных находок. С 4.3.0 сюда
    // приходят только находки > 0 при неизвестном числе строк.
    return {
      score: null,
      no_data: "too little data — no finding density (LOC unknown) and no resolved share",
      submetrics: {
        density: { score: null, value: per10k },
        resolved: { score: null, value: num(appsec.resolved_share) },
        secrets: { score: secretsSub, value: appsec.secrets_critical === true },
      },
    };
  }
  const w = SUBWEIGHTS.security;
  // плотность или доля закрытых есть, признак утечки — всегда: среднее есть
  const raw =
    weighted([
      [w.density, densitySub],
      [w.resolved, resolvedSub],
      [w.secrets, secretsSub],
    ])! * 100;
  // 4.3.0 (Р3, J7): открытая critical — не выше 40, открытая high — не выше 69
  // (после взвешивания): на большом репо плотность пары критичных не видит
  const level: "critical" | "high" | null = critical > 0 ? "critical" : high > 0 ? "high" : null;
  const limit = level !== null ? SECURITY_OPEN_CAPS[level] : null;
  const capped = limit !== null && raw > limit;
  const capNote = level === "critical" ? "category capped — open critical findings" : "category capped — open high findings";
  return {
    score: capped ? limit : raw,
    submetrics: {
      density: { score: densitySub, value: per10k, ...(capped ? { note: capNote } : {}) },
      resolved: { score: resolvedSub, value: num(appsec.resolved_share) },
      secrets: { score: secretsSub, value: appsec.secrets_critical === true },
    },
    ...(capped ? { adjustment: { kind: "open-findings-cap" as const, level: level!, limit: limit!, raw } } : {}),
  };
}

function scoreActivity(derived: DerivedMetrics, now: Date, git: GitState): CategoryScore {
  const submetricsOf = (fresh: number | null, freq: number | null, contrib: number | null, pulls: number | null, rel: number | null): Record<string, SubmetricScore> => ({
    fresh: { score: fresh, value: derived.lastHumanCommitTs },
    freq: { score: freq, value: derived.commitsPerMonth },
    contributors: { score: contrib, value: derived.contributorsTotal },
    pulls_90d: { score: pulls, value: derived.pulls90d },
    releases_12m: { score: rel, value: derived.releases12m },
    // показ-без-веса (§2): mirror-likeness, динамика двух окон и bus factor (К5.9)
    mirror_likeness: { score: null, value: derived.mirrorLikeness },
    bus_factor: { score: null, value: derived.busFactor },
    commits_90d: { score: null, value: derived.commits90d },
    commits_365d: { score: null, value: derived.commits365d },
    sync_bursts: { score: null, value: derived.syncBursts },
  });
  if (derived.humanCommits === null) {
    // 4.3.0 (Н4, D6): без истории — по виду: пустой репо или не прочитан
    return { score: null, no_data: gitNoData(git), submetrics: {} };
  }
  // круг 2 (К5): правило Н10 «история из одних синков — нет данных» снято:
  // зеркало и ребейз считаются по датам автора (robot2), синк — только
  // генерированный всплеск, и история из одних всплесков — как «только роботы»
  // 4.2.0 (М1.2): история прочитана, а людей в ней нет — данные «человеческих
  // коммитов нет» (худший анкер), а не отсутствие данных
  const freshSub =
    derived.lastHumanCommitTs !== null ? anchorScore(FRESH_MONTHS, Math.max(0, (now.getTime() - derived.lastHumanCommitTs) / MONTH_MS)) : 0;
  const freqSub = commitsPerMonthScore(derived.commitsPerMonth ?? 0);
  const contribSub = derived.contributorsTotal !== null && derived.contributorsTotal > 0 ? contributorsScore(derived.contributorsTotal) : null;
  const pullsSub = derived.pulls90d !== null ? anchorScoreLog(PULLS_90D, derived.pulls90d) : null;
  const relSub = derived.releases12m !== null ? anchorScoreLog(RELEASES_12M, derived.releases12m) : null;
  const w = SUBWEIGHTS.activity;
  // 4.2.0 (М1.2): якорь — прочитанная история (свежесть и частота); без нее
  // категорию несли бы счетчики MR и релизов с полом 0,2. В5.3-М (Н15):
  // ветка «git+rest channels no-data» была недостижима — удалена
  const score = weighted([
    [w.fresh, freshSub],
    [w.freq, freqSub],
    [w.contributors, contribSub],
    [w.pulls, pullsSub],
    [w.releases, relSub],
  ])!;
  return { score: score * 100, submetrics: submetricsOf(freshSub, freqSub, contribSub, pullsSub, relSub) };
}

function scoreIssues(ok: Map<string, unknown>, derived: DerivedMetrics): CategoryScore {
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown; closed_counted?: unknown; median_close_days?: unknown } | undefined;
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
  // 4.3.0 (Р2): в выборку идут закрытые задачи, прожившие не меньше часа;
  // у фактов прежнего сборщика — все закрытые
  const closedN = issuesClosedCounted(stats) ?? 0;
  const staleSub = derived.staleShare !== null ? anchorScore(STALE_SHARE, derived.staleShare) : null;
  // 4.3.0 (Н9, F4): открытые есть, а закрыта ни одна — «ни одна не закрыта»
  // (данные, худший анкер), а не отсутствие медианы: первое закрытие больше
  // не снижает балл
  const noneClosed = closedN === 0 && open > 0;
  const closeDays = num(stats.median_close_days);
  const closeSub = noneClosed ? 0 : closeDays !== null ? anchorScore(CLOSE_DAYS, closeDays) : null;
  const resSub = derived.resolutionRatio !== null ? anchorScore(RESOLVED_SHARE, derived.resolutionRatio) : null;
  const comments = ok.get("issues.comments_sample") as { median_first_comment_delay_hours?: unknown } | undefined;
  const firstSub = num(comments?.median_first_comment_delay_hours) !== null ? anchorScore(FIRST_COMMENT_H, num(comments!.median_first_comment_delay_hours)!) : null;
  const w = SUBWEIGHTS.issues;
  // трекер не пуст: доля зависших или доля решенных есть всегда — среднее есть
  // (В5.3-М, Н15: защиты `raw === null` и `Math.max(0, …)` были недостижимы:
  // минимум по анкерам — ровно ISSUES_TRACKER_UNUSED)
  const raw =
    weighted([
      [w.stale, staleSub],
      [w.close_days, closeSub],
      [w.resolution, resSub],
      [w.first_resp, firstSub],
    ])! * 100;
  // 4.2.0 (М1.9) → 4.3.0 (Р2): на малой выборке ЗАКРЫТЫХ задач балл сжимается
  // к минимуму «трекер не ведется»; открытые в размер выборки не входят —
  // спам пустыми задачами и открыл-закрыл за минуту балл не поднимают (J2, F1)
  const sample = Math.min(1, closedN / ISSUES_FULL_SAMPLE);
  const score = ISSUES_TRACKER_UNUSED + (raw - ISSUES_TRACKER_UNUSED) * sample;
  return {
    score,
    submetrics: {
      stale: { score: staleSub, value: derived.staleShare },
      close_days: { score: closeSub, value: noneClosed ? null : closeDays, ...(noneClosed ? { note: "no issue closed" } : {}) },
      resolution: { score: resSub, value: derived.resolutionRatio },
      first_resp: { score: firstSub, value: num(comments?.median_first_comment_delay_hours) },
    },
    ...(sample < 1 ? { adjustment: { kind: "small-sample" as const, n: closedN, full: ISSUES_FULL_SAMPLE, raw, floor: ISSUES_TRACKER_UNUSED } } : {}),
  };
}

function scoreCode(derived: DerivedMetrics, hasTree: boolean): CategoryScore {
  if (!hasTree) return { score: null, no_data: "git channel no-data", submetrics: {} };
  const densitySub = derived.todoDensityPerKloc !== null ? anchorScore(TODO_PER_KLOC, derived.todoDensityPerKloc) : null;
  const oldSub = derived.oldShare !== null ? anchorScore(OLD_SHARE, derived.oldShare) : null;
  const testsSub = derived.testShare !== null ? anchorScore(TEST_SHARE, derived.testShare) : null;
  const rootSub = derived.rootEntries !== null ? anchorScore(ROOT_ENTRIES, derived.rootEntries) : null;
  const w = SUBWEIGHTS.code;
  // К-Р14: неполная выборка TODO — причина no-data рядом со значением;
  // 4.3.0 (Н14б): доля старых при 1-4 пометках — от не менее 5 (оговорка показа)
  const oldNote = derived.oldShareNoData ?? (derived.todoTotal !== null && derived.todoTotal > 0 && derived.todoTotal < OLD_SHARE_MIN_BASE ? "share of at least 5 markers" : null);
  const submetrics: Record<string, SubmetricScore> = {
    density: { score: densitySub, value: derived.todoDensityPerKloc },
    old_share: { score: oldSub, value: derived.oldShare, ...(oldNote ? { note: oldNote } : {}) },
    // круг 2 (В1): тестов нет — подметрика вне расчета с пометкой показа
    tests: { score: testsSub, value: derived.testShare, ...(derived.testsNone ? { note: TESTS_NONE_NOTE } : {}) },
    root: { score: rootSub, value: derived.rootEntries },
    todo_total: { score: null, value: derived.todoTotal },
  };
  // 4.3.0 (Н4): строки не прочитаны — незнание. Круг 2 (К3): сюда же 0
  // прочитанных строк при непрочитанных файлах кода (derived → null) и 0 строк
  // у фактов до М2.3 (ошибка счета М2.2: однострочные файлы без `\n`) —
  // файлы кода есть, а строки не посчитаны. Причина «мало кода» (Р4б) снята (В3)
  // приемка HQ (E15): у фактов до М2.3 `loc = 0` — ошибка счета прежнего
  // сборщика (М2.2), а не «файлы не прочитаны» — своя причина и текст
  if (derived.codeLoc === 0 && derived.codeLocLegacy) return { score: null, no_data: "too little data — lines miscounted by an older collector", submetrics };
  if (derived.codeLoc === null || derived.codeLoc === 0) return { score: null, no_data: "too little data — lines of code not read", submetrics };
  // якорь — плотность пометок (4.2.0, М1.2); без факта TODO категории нет
  if (densitySub === null) return { score: null, no_data: "git channel no-data", submetrics };
  const base = weighted([
    [w.density, densitySub],
    [w.old_share, oldSub],
    [w.root, rootSub],
  ])!;
  // круг 2 (В1): «Тесты» — бонус. Доля непустых тестов входит в балл с весом
  // 0,3 (анкеры круга 1), только если поднимает его: первый тест при хороших
  // прочих показателях не снижает «Код» (P1 «+ непустой тест»), а у репо без
  // тестов «Код» на фактах сборщика 3 и старых фактах одинаков (G3, E2)
  let raw = base;
  if (testsSub !== null) {
    const withTests = weighted([
      [w.density, densitySub],
      [w.old_share, oldSub],
      [w.tests, testsSub],
      [w.root, rootSub],
    ])!;
    if (withTests >= base) raw = withTests;
    else submetrics.tests = { score: null, value: derived.testShare, note: TESTS_BONUS_IDLE_NOTE };
  }
  // круг 2 (В3, вытесняет порог Р4б): плавное сжатие малого кода к нейтрали —
  // Код = 50 + (сырой − 50) × min(1, строк / 200); ступени на 50-й строке нет.
  // Приемка HQ (уточнение В3, Екатерина 24.09): только ВНИЗ — плохой малый код
  // к 50 не подтягивается (иначе удалить строки выгодно, дописать — снижение)
  const rawScore = raw * 100;
  const factor = Math.min(1, derived.codeLoc / CODE_FULL_LOC);
  const compressed = CODE_NEUTRAL + (rawScore - CODE_NEUTRAL) * factor;
  if (factor >= 1 || compressed >= rawScore) return { score: rawScore, submetrics };
  return {
    score: compressed,
    submetrics,
    adjustment: { kind: "small-code", loc: derived.codeLoc, full: CODE_FULL_LOC, raw: rawScore, center: CODE_NEUTRAL },
  };
}

/** Круг 2 (В1): сборщик 3 посчитал тесты, непустых нет — «тестов нет, в балл не входит». */
export const TESTS_NONE_NOTE = "no tests — not scored (tests are a bonus)";
/** Круг 2 (В1): тесты есть, но их доля ниже прочих показателей — бонус не применен. */
export const TESTS_BONUS_IDLE_NOTE = "tests bonus not applied — share would lower the category";

// ---------- запись (immutable: PK scan_id+model_version, идемпотентно) ----------

// 4.3.0 (Н13, F20): индекс округляется устойчиво к двоичному шуму (39,4999… → 40)
const roundTotal = (x: number | null): number | null => (x === null ? null : roundScore(x));
const roundCoverage = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * В4.3 (Ф3.2/Ф3.3): строка scores хранит ТОЛЬКО публичный показатель —
 * healthcraft_index/index_coverage. Полный Repo Health Score — дериватив
 * показанных категорий (карточка считает totalsFromCategories на чтении),
 * отдельным total не хранится нигде.
 */
export function writeScores(db: Database, s: Scores): void {
  db.query(
    `INSERT OR REPLACE INTO scores
       (scan_id, model_version, repo_id, healthcraft_index, index_coverage,
        categories, no_data, stale, computed_at, derived, code_empty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.scanId,
    s.modelVersion,
    s.repoId,
    roundTotal(s.healthcraftIndex),
    roundCoverage(s.indexCoverage),
    JSON.stringify(s.categories),
    JSON.stringify(s.noData),
    JSON.stringify(s.stale),
    s.computedAt,
    JSON.stringify(s.derived),
    s.codeEmpty ? 1 : 0,
  );
}
