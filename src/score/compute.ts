// Детерминированный расчет оценки из фактов (docs/guide/method/scores.md): compute(db, scan_id)
// → Scores с двумя итогами — HealthCraft Index (4 публичные категории) и полный
// Repo Health Score (6 категорий).
// Tri-state: no-data подметрика → перенормировка внутри категории; категория
// целиком no-data → ее вес выбрасывается; coverage = Σ весов с данными / максимум
// набора; coverage < 0.4 → итог NULL. «Нет данных» балл не ухудшает.
// Канал со статусом bad: берутся последние успешные факты того же kind + маркер
// stale; для каналов с правами (cicd.runs, appsec.findings) — при любом не-ok.
// Роботов определяет robot2 (derived). Критичные secrets → кап полного итога ≤ 49.
// Все числа — константы model.ts.
import type { Database } from "bun:sqlite";
import { categoryOf, parseFactValue } from "../collectors/facts";
import { rootHasNoSource } from "../collectors/source-path";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import type { LockGraphFactValue } from "../collectors/lockgraph";
import { APPSEC_NEVER_SCANNED } from "../collectors/appsec";
import { matchVulnerableDependencies } from "./deps-graph";
import { DerivedMetrics, deriveMetrics, issuesClosedCounted } from "./derived";
import { ciStability, issueDynamics } from "./dynamics";
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
  ISSUES_SPREAD_DAYS,
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
  CRITICAL_FINDINGS_TOTAL_CAP,
  SEVERITY_PER_10K,
  SEVERITY_WEIGHTS,
  STALE_SHARE,
  SUBWEIGHTS,
  TODO_PER_KLOC,
  anchorScore,
  DEPS_WEIGHTED,
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
 * Поправка к взвешенному среднему категории — хранится явно, чтобы таблица
 * «Балл категории» в отчете сходилась с итогом, а карточка называла причину.
 * `raw` — балл до поправки (0..100).
 */
export type CategoryAdjustment =
  /** Задачи: закрытых (проживших ≥ 1 ч) меньше полной выборки — балл сжат к минимуму */
  | { kind: "small-sample"; n: number; full: number; raw: number; floor: number; days?: number; daysFull?: number }
  /** Безопасность: открытые находки critical/high — потолок категории */
  | { kind: "open-findings-cap"; level: "critical" | "high"; limit: number; raw: number }
  /** Состояние кода: строк кода меньше `full` — балл сжат к нейтрали `center` */
  | { kind: "small-code"; loc: number; full: number; raw: number; center: number };

export interface CategoryScore {
  /** 0..100 | null = категория no-data */
  score: number | null;
  no_data?: string;
  stale?: boolean;
  submetrics: Record<string, SubmetricScore>;
  /** поправка к взвешенному среднему (сжатие малой выборки, потолок) */
  adjustment?: CategoryAdjustment;
}

/**
 * Один анализ — одна оценка с ДВУМЯ показателями: HealthCraft Index
 * (4 публичные категории, свои веса, без капа) и Repo Health Score (6 категорий,
 * кап 49 за критичные secrets). Индекс хранится (рейтинг сортирует по нему);
 * полный Score отдельно НЕ хранится — он выводится из показанных категорий,
 * а здесь считается для рекомендаций и скриптов.
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
  /** производные показатели — для отображения; хранятся в scores.derived */
  derived: DerivedMetrics;
  noData: string[];
  stale: string[];
  /** в репо нет кода: по правилу методики это оценка 0 как данные («проекта нет»), а не NULL */
  codeEmpty: boolean;
  computedAt: string;
}

/**
 * Kinds, которые читает compute (и замещает историей при сбое канала).
 * Экспортируется: read-API строит по нему доказательную базу карточки —
 * копия списка в API молча разошлась бы при смене модели.
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
 * Kinds каналов с правами зрителя: CI (конфиг и прогоны) и Security. Все фильтры
 * карточки, рейтинга, stale, public_status и пригодности скана строятся только
 * от CHANNEL_KINDS / PUBLIC_KINDS.
 */
export const CHANNEL_KINDS = ["cicd.configs", "cicd.runs", "appsec.findings"];

/** Kinds публичных категорий (HealthCraft Index): READ_KINDS минус CHANNEL_KINDS. */
export const PUBLIC_KINDS = READ_KINDS.filter((k) => !CHANNEL_KINDS.includes(k));

/**
 * Справочные факты — review PR и карта владельцев. Расчет читает их ТОЛЬКО
 * для показа (подметрики DISPLAY_ONLY, балл null) и НЕ включает в READ_KINDS:
 * пригодность скана, public_status, замещение историей и Score от них не
 * зависят. Факт не ok — строка «нет данных» с причиной, без подстановки из
 * прошлого скана.
 */
export const DISPLAY_KINDS = ["activity.pr_review", "code.ownership"];

/**
 * Необязательные факты расчета — граф зависимостей из lock-файлов. Расчет
 * читает их для балла (подметрика «Уязвимые зависимости»), но в READ_KINDS /
 * PUBLIC_KINDS они не входят: без lock-файла факта нет по построению, и это не
 * делает скан неполным, непригодным или устаревшим. Не ok — как отсутствие.
 */
export const OPTIONAL_KINDS = ["tree.lockgraph"];

/** Причины no-data, описывающие не репо, а права/сбой чтения — скан непригоден. */
const INELIGIBLE_NO_DATA_REASONS = ["access", "other"];

export interface EligibilityFact {
  key: string;
  status: string;
  /** git | rest:* | appsec:api — правило для скана пользователя смотрит git-факты */
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
      // строка может быть сжатой (z:-префикс, старые записи) — parseFactValue
      // разворачивает ее; JS- и SQL-правила пригодности должны видеть одну причину
      v = parseFactValue(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" ? (v as { reason?: unknown }).reason ?? null : null;
}

/**
 * Единое правило пригодности скана для рейтинга (одно для хука, rescoreAll и
 * миграции; SQL-эквивалент — ratingEligibleSql). Скан непригоден, если он bad
 * или не завершен, если хоть один факт PUBLIC_KINDS отсутствует, bad или no-data
 * с причиной access/other. no-data limits и причины, описывающие сам репо
 * (пустой репо), пригодности не мешают. Одинаково для публичных и приватных.
 * Скан пользователя (с автором) с любым no-data git-фактом непригоден:
 * медленный или узкий токен не должен выдавать «репо больше лимита» за свойство репо.
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
 *  json_extract по сжатой (z:) строке бросает `malformed JSON` и ронял бы migrateEligibility,
 *  а zlib SQLite не разворачивает. Поэтому сжатая no-data-строка читается как «причина
 *  неизвестна» (NULL — не дисквалификатор); новые no-data значения не сжимаются вовсе,
 *  так что это касается только старых строк. */
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

/** Пересчет пригодности всех сканов одним UPDATE + public_status для следов старого процесса. */
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
 * Статус скана по фактам (runner): bad = фатальная ошибка воркера или ни одного
 * ok-факта git/REST; ok = все факты ok; иначе partial. Тот же алгоритм на фактах
 * PUBLIC_KINDS дает scans.public_status.
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
 * Каналы с правами зрителя: для них факт «не ok» (no-data, bad или отсутствие
 * строки) замещается последним ok-фактом того же kind из более раннего скана
 * репо — периодический скан без токена не стирает CI и Security, собранные
 * сканом с токеном участника. Показ защищен проверкой доступа: эти данные
 * видит только тот, у кого есть доступ к тому же каналу.
 */
export const CHANNEL_FALLBACK_KINDS = ["cicd.runs", "appsec.findings"];

export interface EffectiveFacts {
  ok: Map<string, unknown>;
  stale: string[];
  staleCats: Set<string>;
  /**
   * git-канал подтвердил, что коммитов нет (у старых сканов это no-data с причиной
   * `empty`). Пустота — факт «проекта нет», а не отсутствие данных.
   */
  emptyRepo: boolean;
  /** справочные факты скана не ok — kind → причина (`access`, `bad-channel`…) */
  displayMissing?: Record<string, string>;
  /**
   * AppSec ответил, что проверка по репозиторию ни разу не запускалась, и
   * находок нет ни в одном анализе — подтвержденное отсутствие (Безопасность 0)
   */
  appsecNeverScanned?: boolean;
}

/**
 * AppSec ни разу не проверял репозиторий: последний ответ AppSec до скана
 * `uptoScanId` включительно, дошедший до AppSec (не «нет прав»), – «проверка не
 * запускалась». Ok-находки после такого ответа (любого скана, в том числе
 * `bad` или без `tree.stats`) его отменяют: проверка уже была. Одно правило для
 * расчета (effectiveFacts) и карточки – карточка зовет его с потолком
 * `Number.MAX_SAFE_INTEGER`, когда не нашла скан-источник Безопасности.
 */
export function appsecNeverScannedAt(db: Database, repoId: number, uptoScanId: number): boolean {
  const rows = db
    .query(
      `SELECT f.value, f.status FROM facts f JOIN scans s ON s.id = f.scan_id
       WHERE f.key = 'appsec.findings' AND f.status IN ('ok', 'no-data') AND s.repo_id = ? AND f.scan_id <= ?
       ORDER BY f.scan_id DESC LIMIT 20`,
    )
    .all(repoId, uptoScanId) as { value: string; status: string }[];
  for (const r of rows) {
    if (r.status === "ok") return false;
    const v = parseFactValue(r.value) as { reason?: unknown; detail?: unknown } | null;
    if (v?.reason === "access") continue;
    return v?.reason === "no-scan" && v.detail === APPSEC_NEVER_SCANNED;
  }
  return false;
}

/**
 * Факты скана с замещением историей: bad → последний ok того же kind (все kinds);
 * для CHANNEL_FALLBACK_KINDS — любой не-ok. Общая точка compute и recommend,
 * чтобы рекомендации не противоречили оценке.
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
  // необязательные — только ok, без замещения историей. Граф lock-файлов
  // сопоставляется с находками AppSec ТОГО ЖЕ скана: если находки взяты из
  // истории (периодический скан без токена), граф текущего скана им не пара —
  // обновленный lock сделал бы исправленный пакет «не найденным», и балл упал бы
  // после исправления. Тогда граф не читается, подметрика вне расчета.
  for (const kind of OPTIONAL_KINDS) {
    if (kind === "tree.lockgraph" && stale.includes("appsec.findings")) continue;
    const row = rows.find((r) => r.key === kind);
    if (row && row.status === "ok") ok.set(kind, parseFactValue(row.value));
  }
  // справочные — без замещения историей; нет строки — нет показа
  const displayMissing: Record<string, string> = {};
  for (const kind of DISPLAY_KINDS) {
    const row = rows.find((r) => r.key === kind);
    if (!row) continue;
    if (row.status === "ok") ok.set(kind, parseFactValue(row.value));
    else displayMissing[kind] = String((parseFactValue(row.value) as { reason?: unknown } | null)?.reason ?? row.status);
  }
  const appsecNeverScanned = !ok.has("appsec.findings") && appsecNeverScannedAt(db, repoId, scanId);
  return { ok, stale, staleCats, emptyRepo, displayMissing, ...(appsecNeverScanned ? { appsecNeverScanned } : {}) };
}

export function compute(db: Database, scanId: number, opts: { now?: Date } = {}): Scores {
  const now = opts.now ?? new Date();
  const scan = db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number } | null;
  if (!scan) throw new Error(`scan ${scanId} not found`);
  const eff = effectiveFacts(db, scanId, scan.repo_id);
  return computeFromFacts(
    eff.ok,
    { scanId, repoId: scan.repo_id, stale: eff.stale, staleCats: eff.staleCats, emptyRepo: eff.emptyRepo, displayMissing: eff.displayMissing, appsecNeverScanned: eff.appsecNeverScanned },
    now,
  );
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
  /** справочные факты не ok — kind → причина (EffectiveFacts.displayMissing) */
  displayMissing?: Record<string, string>;
  /** AppSec: проверка ни разу не запускалась (EffectiveFacts.appsecNeverScanned) */
  appsecNeverScanned?: boolean;
}

/**
 * Чистый расчет оценки из эффективных фактов, без БД.
 * compute = effectiveFacts + computeFromFacts; recommend считает реальный
 * прирост правила вторым вызовом на подмененных фактах.
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
    security: scoreSecurity(ok, input.appsecNeverScanned === true),
    activity: withPrReview(scoreActivity(derived, now, git), ok, input.displayMissing),
    issues: scoreIssues(ok, derived),
    // «кода нет» — явный балл 0 с причиной, а не «нет данных»: код ЗАВЕДОМО
    // отсутствует, это факт о репо. Правило «no-data не ухудшает» — про незнание,
    // а не про подтвержденную пустоту. Причина остается в `no_data` — ее читают
    // карточка (partialNote) и полоса вкладов.
    code: withOwnership(emptyKind !== null ? { score: 0, no_data: `no source code — ${emptyKind}`, submetrics: {} } : scoreCode(derived, ok.has("tree.stats")), ok, input.displayMissing),
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

  const totals = totalsFromCategories(categories, { codeEmpty, ...totalCapFlags(ok.get("appsec.findings")) });

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

export interface Totals {
  /** HealthCraft Index — взвешенное среднее четверки с весами INDEX_WEIGHTS */
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** Repo Health Score — взвешенное среднее шести с весами SCORE_WEIGHTS, кап 49 */
  repoHealthScore: number | null;
  repoHealthCoverage: number;
}

/**
 * Оба показателя из готовых категорий: взвешенное среднее с перенормировкой
 * no-data. Индекс — веса INDEX_WEIGHTS (23/23/23/31), полный Score —
 * SCORE_WEIGHTS (20/15/15/15/15/20). Coverage обоих — доля номинальной массы
 * SCORE_WEIGHTS с данными: индекс от 65 (масса четверки), полный от 100.
 * compute и карточка (полный Score из показанных категорий) используют одну
 * формулу. Капы 49 (секреты) и 69 (критичные находки) – только к полному Score.
 */
/**
 * Признаки капов полного итога из факта `appsec.findings`: утекшие критичные
 * секреты (≤ 49) и открытые критичные находки (≤ 69). Нет факта – капов нет.
 */
export function totalCapFlags(appsecValue: unknown): { secretsCritical: boolean; criticalOpen: boolean } {
  const v = appsecValue as { secrets_critical?: unknown; severity_counts?: { critical?: unknown } } | null | undefined;
  return { secretsCritical: v?.secrets_critical === true, criticalOpen: (num(v?.severity_counts?.critical) ?? 0) > 0 };
}

/** Кап полного итога по признакам: наименьший из действующих; null – капа нет. */
export function totalCapOf(flags: { secretsCritical: boolean; criticalOpen?: boolean }): number | null {
  if (flags.secretsCritical) return SECRETS_CRITICAL_TOTAL_CAP;
  if (flags.criticalOpen) return CRITICAL_FINDINGS_TOTAL_CAP;
  return null;
}

export function totalsFromCategories(
  categories: Record<CategoryKey, { score: number | null }>,
  flags: { codeEmpty: boolean; secretsCritical: boolean; criticalOpen?: boolean },
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
      const cap = capSecrets ? totalCapOf(flags) : null;
      if (cap !== null) total = Math.min(total, cap);
    }
    return total;
  };
  const indexWeightOf = (key: CategoryKey): number => INDEX_WEIGHTS[key as IndexCategoryKey];
  // порядок суммирования шести категорий не менять: от него зависят биты числа с плавающей точкой
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
 * Причина «нет данных» у git-категорий различает случаи: репозиторий пуст
 * (коммитов нет — это данные) или не прочитан (лимит, ошибка — незнание).
 */
const gitNoData = (git: GitState): string => (git.empty ? "repository empty" : "git channel no-data");

/** Вид «кода нет» (оценка 0 как данные) или null — код есть или неизвестно. */
export type CodeEmptyKind = "repository empty" | "no files" | "only non-code files" | "no lines of code";

/**
 * Репо без кода: по правилу методики «проекта нет» = оценка 0 как данные,
 * не NULL. Сюда относятся репо без единого коммита; репо без файлов кода (только
 * README, лицензия, картинки; у старых фактов — по корню без каталогов); файлы кода
 * без единой строки (`source_loc = 0`) — пустой `a.js` признак не снимает.
 * `source_loc = null` (обрыв чтения) — не «кода нет», а незнание: оно балл не ухудшает.
 */
export function codeEmptyKind(ok: Map<string, unknown>, git: GitState): CodeEmptyKind | null {
  if (git.empty) return "repository empty";
  const tree = ok.get("tree.stats") as { file_count?: unknown; source_files?: unknown; source_loc?: unknown; source_unread?: unknown; top_level?: unknown } | undefined | null;
  if (tree === undefined || tree === null) return null;
  if (typeof tree.file_count === "number" && tree.file_count === 0) return "no files";
  if (tree.source_files === 0) return "only non-code files";
  if (!("source_files" in tree) && rootHasNoSource(tree.top_level)) return "only non-code files";
  // 0 строк при непрочитанных файлах кода (больше лимита текста, бинарные) —
  // строки не прочитаны (незнание), а не «кода нет»
  const unread = typeof tree.source_unread === "number" && tree.source_unread > 0;
  if (typeof tree.source_loc === "number" && tree.source_loc === 0 && !unread) return "no lines of code";
  return null;
}

/**
 * Лицензия засчитана — ОДНО выражение для расчета и рекомендации: признак
 * сборщика; у старых фактов без `content_checked` — еще и имя в корне
 * (`LICENSE-MIT`, `COPYING`…). Если сборщик проверил содержимое, имя пустого
 * файла лицензию не дает.
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
 * Лицензия под иным именем — `LICENSE-MIT`, `LICENSE.APACHE`, `COPYING*`,
 * `UNLICENSE`, каталог `LICENSES/` (старый сборщик искал только `licen[cs]e*`);
 * корень хранится в `tree.stats.top_level`.
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
    recent_runs?: unknown;
  } | undefined;
  // ci.yaml не разобран — неизвестно, есть ли шаги: подметрика конфигурации вне
  // расчета, а CI оценивается по запускам, если они видны. Без запусков — «нет
  // данных», как у любого CI без видимых запусков
  const unparsed = configs !== undefined && configs.has_ci_yaml === true && (typeof configs.has_steps !== "boolean" || typeof configs.steps_note === "string");
  if (unparsed && runs === undefined) {
    return { score: null, no_data: "ci.yaml not parsed — steps unknown", submetrics: {} };
  }
  if (!configs) {
    return { score: null, no_data: gitNoData(git), submetrics: {} };
  }
  const configSub = unparsed ? null : configs.has_ci_yaml === true && configs.has_steps === true ? 1 : 0;
  const configEntry: SubmetricScore = { score: configSub, value: configs, ...(unparsed ? { note: CI_YAML_UNPARSED_NOTE } : {}) };
  if (runs === undefined) {
    // запуски не видны — «нет данных» НЕЗАВИСИМО от ci.yaml. Иначе «нет ci.yaml»
    // давало бы 0, а заглушка ci.yaml без видимых запусков — «нет данных», и
    // перенормировка поднимала бы полный Score на +15,6 за конфиг без доказательства.
    // Без видимых запусков CI не оцениваем вовсе.
    return {
      score: null,
      no_data: CI_RUNS_INVISIBLE,
      submetrics: {
        config: configEntry,
        pass_rate: { score: null, note: "runs no-data" },
        duration: { score: null, note: "runs no-data" },
        // справочно, без веса — видна с теми же правами, что категория
        stability: ciStability(undefined),
      },
    };
  }
  if (configSub === 0) {
    // нет ci.yaml / ci.yaml без шагов = CI нет = 0 (данные) — даже если запуски
    // каким-то образом видны (запуски без конфига — шум)
    return {
      score: 0,
      submetrics: {
        config: { score: 0, value: configs },
        pass_rate: { score: null, note: "no declared CI" },
        duration: { score: null, note: "no declared CI" },
        stability: { score: null, value: null, note: "no declared CI" },
      },
    };
  }
  // запуски ВИДНЫ и их 0 — данные «CI заявлен, но не запускался» (заглушка
  // ci.yaml не должна быть выгоднее настоящего CI); все запуски старше последней
  // ленты свежести (поле есть, значение null) — то же «за год не запускался»
  const runsCount = num(runs.runs_count);
  // запуски есть, но ни один не завершен (отменены, пропущены, отклонены или
  // идут) — результата кода нет, как у CI, который не запускался: 4.7.0 оценивает
  // это так же, а не «нет данных», иначе отмена всех запусков была бы выгоднее
  // упавших
  const pendingOnly = runsCount === 0 && (num((runs as { runs_total?: unknown }).runs_total) ?? 0) > 0;
  // незнакомые статусы API (status_note) — исход неизвестен, а не «не завершен»;
  // неразобранный ci.yaml без завершенных запусков оценить нечем
  if (pendingOnly && (typeof (runs as { status_note?: unknown }).status_note === "string" || unparsed)) {
    return {
      score: null,
      no_data: unparsed ? "ci.yaml not parsed — steps unknown" : "ci runs pending — запуски идут, завершенных нет",
      submetrics: {
        config: configEntry,
        pass_rate: { score: null, note: "runs pending" },
        duration: { score: null, note: "runs pending" },
        stability: ciStability(runs),
      },
    };
  }
  const staleOnly = runsCount !== null && runsCount > 0 && "weighted_success_rate" in runs && runs.weighted_success_rate === null;
  if ((runsCount === 0 || staleOnly) && unparsed) {
    // ci.yaml не разобран и за год не запускался – шаги неизвестны, оценки нет
    return { score: null, no_data: "ci.yaml not parsed — steps unknown", submetrics: {} };
  }
  if (runsCount === 0 || staleOnly) {
    // успешного запуска за год нет — длительность тоже худший анкер (0), а не
    // «нет данных»: иначе ее вес уходил бы конфигу, и CI, который ни разу не
    // запускался, получал бы 40 — больше, чем медленный CI, который работает
    const wn = SUBWEIGHTS.cicd;
    const s = weighted([
      [wn.config, configSub],
      [wn.pass_rate, 0],
      [wn.duration, 0],
    ])!;
    return {
      score: s * 100,
      submetrics: {
        config: configEntry,
        // значения доли нет — «не запускался» словами, а не «0%» (читалось бы как «все упали»)
        pass_rate: { score: 0, value: null, note: pendingOnly ? "no completed runs" : runsCount === 0 ? "no runs" : "no runs within a year" },
        duration: { score: 0, value: null, note: pendingOnly ? "no completed runs" : runsCount === 0 ? "no runs" : "no recent runs" },
        stability: ciStability(runs),
      },
    };
  }
  if (runsCount === null) {
    // факт запусков без счетчика — формы не знаем, оценки не даем
    return {
      score: null,
      no_data: CI_RUNS_INVISIBLE,
      submetrics: {
        config: configEntry,
        pass_rate: { score: null, note: "runs no-data" },
        duration: { score: null, note: "runs no-data" },
        stability: ciStability(runs),
      },
    };
  }
  // pass_rate по ВЗВЕШЕННОЙ доле успеха (свежие прогоны весомее, CI_RECENCY_BANDS),
  // у старых фактов — простая доля
  const passInput = num(runs.weighted_success_rate) ?? num(runs.success_rate);
  const passSub = passInput !== null ? anchorScore(PASS_RATE, passInput) : null;
  // длительность (у нового сборщика) — по успешным запускам; завершенные есть,
  // а успешных нет — данные (худший анкер), как у свежести и закрытия задач
  const noneSucceeded = num(runs.duration_p50) === null && num(runs.success_rate) === 0;
  const durSub = num(runs.duration_p50) !== null ? anchorScore(DURATION_MIN, num(runs.duration_p50)! / 60) : noneSucceeded ? 0 : null;
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
      config: configEntry,
      pass_rate: { score: passSub, value: passInput },
      duration: { score: durSub, value: num(runs.duration_p50), ...(noneSucceeded ? { note: "no successful runs" } : {}) },
      // справочно, без веса
      stability: ciStability(runs),
    },
  };
}

/**
 * Причина «нет данных» CI без видимых запусков (с ci.yaml и без него).
 * Подстрока «прогоны не видны» — маркер для карточки (`ciConfigOnlyCap`).
 */
export const CI_RUNS_INVISIBLE = "ci runs no-data — прогоны не видны, автоматизацию не оцениваем";

function scoreSecurity(ok: Map<string, unknown>, neverScanned: boolean): CategoryScore {
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (!appsec && neverScanned) {
    // проверка не запускалась — подтвержденное отсутствие, а не «нет данных»:
    // иначе не запускать AppSec было бы выгоднее, чем запустить и получить находки
    return { score: 0, submetrics: { scan_missing: { score: 0, value: null, note: "AppSec scan never run" } } };
  }
  if (!appsec) {
    return { score: null, no_data: "AppSec data unavailable (no AppSec access or no finished scan)", submetrics: {} };
  }
  // плотность — по строкам КОДА (`source_loc`), как у TODO; у старых фактов —
  // весь `loc`; обрыв чтения (`source_loc = null`) — неизвестно
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
  // находок нет — плотность 0 даже без числа строк (подтвержденное отсутствие — данные)
  const per10k = weightedDensity === 0 ? 0 : loc !== null && loc > 0 ? weightedDensity / (loc / 10_000) : null;
  const densitySub = per10k !== null ? anchorScore(SEVERITY_PER_10K, per10k) : null;
  const resolvedSub = num(appsec.resolved_share) !== null ? anchorScore(RESOLVED_SHARE, num(appsec.resolved_share)!) : null;
  const secretsSub = appsec.secrets_critical === true ? 0 : 1;
  // уязвимые зависимости (4.6.0): пакеты SCA против графа lock-файлов. Без графа
  // или без списка пакетов (корзины SCA не ответили, старый факт) — вне расчета
  const deps = scoreDeps(appsec, ok.get("tree.lockgraph") as LockGraphFactValue | undefined);
  if (densitySub === null && resolvedSub === null) {
    // без плотности и доли закрытых категорию несли бы признак утечки и
    // зависимости — 100 при любом числе критичных находок в коде. Сюда приходят
    // только находки > 0 при неизвестном числе строк; балл зависимостей при этом
    // показывается, но категория остается «нет данных» (консервативно).
    return {
      score: null,
      no_data: "too little data — no finding density (LOC unknown) and no resolved share",
      submetrics: {
        density: { score: null, value: per10k },
        resolved: { score: null, value: num(appsec.resolved_share) },
        secrets: { score: secretsSub, value: appsec.secrets_critical === true },
        deps,
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
      [w.deps, deps.score],
    ])! * 100;
  // открытая critical — не выше 40, открытая high — не выше 69 (после взвешивания):
  // на большом репо плотность пару критичных почти не замечает
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
      deps,
    },
    ...(capped ? { adjustment: { kind: "open-findings-cap" as const, level: level!, limit: limit!, raw } } : {}),
  };
}

/** Значение подметрики «Уязвимые зависимости» — для карточки и отчета (submetrics.ts). */
export interface DepsSubmetricValue {
  vulnerable: number;
  direct: number;
  transitive: number;
  unmatched: number;
  /** пакеты экосистем вне прочитанных lock-файлов — показываются, не взвешиваются */
  outside: number;
  /** пакеты, чьей версии из SCA в lock-файле уже нет (обновлены), — вне списка и суммы; нет поля — 0 */
  updated?: number;
  weighted: number;
  managers: string[];
  graph_truncated: boolean;
  /** пакеты для показа: худшие первыми, до DEPS_SHOWN */
  packages: { name: string; version: string | null; severity: string; direct: boolean | null; outside: boolean; via: string[] }[];
}

/** Сколько уязвимых пакетов несет значение подметрики (остальные — в счетчиках). */
export const DEPS_SHOWN = 12;

/**
 * Подметрика «Уязвимые зависимости»: null без графа lock-файлов (нечего
 * сопоставлять — находки SCA считаются в плотности как раньше) и без списка
 * пакетов SCA (старый факт или корзины не ответили). Пустой список при графе —
 * подтвержденное отсутствие уязвимых зависимостей, 1.
 */
function scoreDeps(appsec: AppsecFindingsValue, lockgraph: LockGraphFactValue | undefined): SubmetricScore {
  const sca = appsec.sca;
  if (sca === null || sca === undefined || !Array.isArray(sca.packages)) {
    return { score: null, value: null, note: appsec.sca_note ? `sca buckets failed — no package list (${String(appsec.sca_note).slice(0, 120)})` : "no SCA package list" };
  }
  if (lockgraph === undefined || !Array.isArray(lockgraph.graphs) || lockgraph.graphs.length === 0) {
    return { score: null, value: null, note: "no lockfile graph — direct/transitive unknown" };
  }
  const report = matchVulnerableDependencies(sca, lockgraph);
  const value: DepsSubmetricValue = {
    vulnerable: report.packages.length,
    direct: report.direct,
    transitive: report.transitive,
    unmatched: report.unmatched,
    outside: report.outside,
    ...(report.updated > 0 ? { updated: report.updated } : {}),
    weighted: report.weighted,
    managers: report.managers,
    graph_truncated: report.graph_truncated,
    packages: report.packages.slice(0, DEPS_SHOWN).map((p) => ({ name: p.name, version: p.version, severity: p.severity, direct: p.direct, outside: p.outside, via: p.via })),
  };
  return {
    score: anchorScore(DEPS_WEIGHTED, report.weighted),
    value,
    ...(sca.truncated || report.graph_truncated ? { note: "package list or graph truncated — matching incomplete" } : {}),
  };
}

function scoreActivity(derived: DerivedMetrics, now: Date, git: GitState): CategoryScore {
  // релизы засчитываются у живого проекта: за 12 месяцев был коммит человека.
  // Автоматические релизы заброшенного проекта Активность не поднимают
  const humanWithinYear = derived.lastHumanCommitTs !== null && now.getTime() - derived.lastHumanCommitTs <= 365 * 86_400_000;
  const releasesIdle = derived.humanCommits !== null && !humanWithinYear && (derived.releases12m ?? 0) > 0;
  const submetricsOf = (fresh: number | null, freq: number | null, contrib: number | null, pulls: number | null, rel: number | null): Record<string, SubmetricScore> => ({
    fresh: { score: fresh, value: derived.lastHumanCommitTs },
    freq: { score: freq, value: derived.commitsPerMonth },
    contributors: { score: contrib, value: derived.contributorsTotal },
    pulls_90d: { score: pulls, value: derived.pulls90d },
    releases_12m: { score: rel, value: derived.releases12m, ...(releasesIdle ? { note: RELEASES_NO_HUMANS_NOTE } : {}) },
    // только показ, без веса: mirror-likeness, bus factor, коммиты за два окна, всплески
    mirror_likeness: { score: null, value: derived.mirrorLikeness },
    bus_factor: { score: null, value: derived.busFactor },
    commits_90d: { score: null, value: derived.commits90d },
    commits_365d: { score: null, value: derived.commits365d },
    sync_bursts: { score: null, value: derived.syncBursts },
  });
  if (derived.humanCommits === null) {
    // без истории — причина по виду: пустой репо или не прочитан
    return { score: null, no_data: gitNoData(git), submetrics: {} };
  }
  // зеркало и ребейз считаются по датам автора (robot2), синк — только
  // сгенерированный всплеск; история из одних всплесков — как «только роботы».
  // История прочитана, а людей в ней нет — это данные «коммитов людей нет»
  // (худший анкер), а не отсутствие данных
  const freshSub =
    derived.lastHumanCommitTs !== null ? anchorScore(FRESH_MONTHS, Math.max(0, (now.getTime() - derived.lastHumanCommitTs) / MONTH_MS)) : 0;
  const freqSub = commitsPerMonthScore(derived.commitsPerMonth ?? 0);
  // история прочитана, а авторов-людей нет — данные (худший анкер), как у свежести
  const contribSub = derived.contributorsTotal === null ? null : derived.contributorsTotal > 0 ? contributorsScore(derived.contributorsTotal) : 0;
  const pullsSub = derived.pulls90d !== null ? anchorScoreLog(PULLS_90D, derived.pulls90d) : null;
  const relSub = derived.releases12m === null ? null : releasesIdle ? 0 : anchorScoreLog(RELEASES_12M, derived.releases12m);
  const w = SUBWEIGHTS.activity;
  // якорь — прочитанная история (свежесть и частота); без нее категорию несли бы
  // одни счетчики MR и релизов
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
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown; closed_counted?: unknown; median_close_days?: unknown; flow?: unknown } | undefined;
  if (!stats) {
    return { score: null, no_data: "issues channel no-data", submetrics: {} };
  }
  const open = num(stats.open) ?? 0;
  const closed = num(stats.closed) ?? 0;
  // справочно, без веса; трекер не ведется — тот же статус, а не «0 динамики»
  const dynamics = issueDynamics(stats);
  if (open === 0 && closed === 0) {
    // 0/0 = данные «трекер не ведется» — балл = вычислимый минимум категории, 0
    return {
      score: ISSUES_TRACKER_UNUSED,
      submetrics: {
        tracker_unused: { score: ISSUES_TRACKER_UNUSED / 100, value: { open: 0, closed: 0 }, note: "tracker not maintained — category minimum (Q14)" },
        ...dynamics,
      },
    };
  }
  // в выборку идут закрытые задачи, прожившие не меньше часа; у старых фактов — все закрытые
  const closedN = issuesClosedCounted(stats) ?? 0;
  const staleSub = derived.staleShare !== null ? anchorScore(STALE_SHARE, derived.staleShare) : null;
  // открытые есть, а не закрыта ни одна — это данные (худший анкер), а не отсутствие
  // медианы: иначе первое закрытие снижало бы балл
  const noneClosed = closedN === 0 && open > 0;
  const closeDays = num(stats.median_close_days);
  const closeSub = noneClosed ? 0 : closeDays !== null ? anchorScore(CLOSE_DAYS, closeDays) : null;
  const resSub = derived.resolutionRatio !== null ? anchorScore(RESOLVED_SHARE, derived.resolutionRatio) : null;
  const comments = ok.get("issues.comments_sample") as { median_first_comment_delay_hours?: unknown } | undefined;
  const firstSub = num(comments?.median_first_comment_delay_hours) !== null ? anchorScore(FIRST_COMMENT_H, num(comments!.median_first_comment_delay_hours)!) : null;
  const w = SUBWEIGHTS.issues;
  // трекер не пуст: доля зависших или доля решенных есть всегда — среднее есть,
  // а минимум по анкерам — ровно ISSUES_TRACKER_UNUSED
  const raw =
    weighted([
      [w.stale, staleSub],
      [w.close_days, closeSub],
      [w.resolution, resSub],
      [w.first_resp, firstSub],
    ])! * 100;
  // на малой выборке ЗАКРЫТЫХ задач балл сжимается к минимуму «трекер не ведется» (0);
  // открытые в размер выборки не входят — спам пустыми задачами и «открыл-закрыл
  // за минуту» балл не поднимают
  // и во времени: закрытия в 1-2 дня (пачка задач-пустышек) не дают полного балла
  // 0 дней при засчитанных закрытиях – даты неизвестны, поправки нет
  const daysRaw = num((stats as { closed_days?: unknown }).closed_days);
  const days = daysRaw === null || (daysRaw === 0 && closedN > 0) ? null : daysRaw;
  const bySize = Math.min(1, closedN / ISSUES_FULL_SAMPLE);
  const byDays = days === null ? 1 : Math.min(1, days / ISSUES_SPREAD_DAYS);
  const sample = Math.min(bySize, byDays);
  const score = ISSUES_TRACKER_UNUSED + (raw - ISSUES_TRACKER_UNUSED) * sample;
  return {
    score,
    submetrics: {
      stale: { score: staleSub, value: derived.staleShare },
      close_days: { score: closeSub, value: noneClosed ? null : closeDays, ...(noneClosed ? { note: "no issue closed" } : {}) },
      resolution: { score: resSub, value: derived.resolutionRatio },
      first_resp: { score: firstSub, value: num(comments?.median_first_comment_delay_hours) },
      ...dynamics,
    },
    ...(sample < 1
      ? {
          adjustment: {
            kind: "small-sample" as const,
            n: closedN,
            full: ISSUES_FULL_SAMPLE,
            raw,
            floor: ISSUES_TRACKER_UNUSED,
            // поправку задает распределение во времени, а не число задач
            ...(byDays < bySize ? { days: days!, daysFull: ISSUES_SPREAD_DAYS } : {}),
          },
        }
      : {}),
  };
}

function scoreCode(derived: DerivedMetrics, hasTree: boolean): CategoryScore {
  if (!hasTree) return { score: null, no_data: "git channel no-data", submetrics: {} };
  const densitySub = derived.todoDensityPerKloc !== null ? anchorScore(TODO_PER_KLOC, derived.todoDensityPerKloc) : null;
  const oldSub = derived.oldShare !== null ? anchorScore(OLD_SHARE, derived.oldShare) : null;
  const testsSub = derived.testShare !== null ? anchorScore(TEST_SHARE, derived.testShare) : null;
  const rootSub = derived.rootEntries !== null ? anchorScore(ROOT_ENTRIES, derived.rootEntries) : null;
  const w = SUBWEIGHTS.code;
  // неполная выборка TODO — причина no-data рядом со значением; при 1-4 пометках
  // доля старых считается от 5 — это оговаривается при показе
  const oldNote = derived.oldShareNoData ?? (derived.todoTotal !== null && derived.todoTotal > 0 && derived.todoTotal < OLD_SHARE_MIN_BASE ? "share of at least 5 markers" : null);
  const submetrics: Record<string, SubmetricScore> = {
    density: { score: densitySub, value: derived.todoDensityPerKloc },
    old_share: { score: oldSub, value: derived.oldShare, ...(oldNote ? { note: oldNote } : {}) },
    // тестов нет — подметрика вне расчета, с пометкой для показа
    tests: { score: testsSub, value: derived.testShare, ...(derived.testsNone ? { note: TESTS_NONE_NOTE } : {}) },
    root: { score: rootSub, value: derived.rootEntries },
    todo_total: { score: null, value: derived.todoTotal },
  };
  // строки не прочитаны — незнание. Сюда же 0 прочитанных строк при непрочитанных
  // файлах кода (derived → null). У старых фактов `loc = 0` — ошибка счета прежнего
  // сборщика (однострочные файлы без `\n`), а не «файлы не прочитаны»: своя причина
  if (derived.codeLoc === 0 && derived.codeLocLegacy) return { score: null, no_data: "too little data — lines miscounted by an older collector", submetrics };
  if (derived.codeLoc === null || derived.codeLoc === 0) return { score: null, no_data: "too little data — lines of code not read", submetrics };
  // якорь — плотность пометок; без факта TODO категории нет
  if (densitySub === null) return { score: null, no_data: "git channel no-data", submetrics };
  const base = weighted([
    [w.density, densitySub],
    [w.old_share, oldSub],
    [w.root, rootSub],
  ])!;
  // «Тесты» — бонус: доля непустых тестов входит в балл с весом 0,3, только если
  // поднимает его. Первый тест при хороших прочих показателях не снижает «Код»,
  // а у репо без тестов «Код» одинаков на новых и старых фактах
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
  // плавное сжатие малого кода к нейтрали: Код = 50 + (сырой − 50) × min(1, строк / 200).
  // Только ВНИЗ: плохой малый код к 50 не подтягивается — иначе удалять строки
  // было бы выгодно, а дописывать — невыгодно
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

// ---------- справочные подметрики ----------

/**
 * Review и bottlenecks PR — строки показа «Активности» без веса (балл null,
 * DISPLAY_ONLY): балл категории, индекс и покрытие не меняются (строка
 * добавляется ПОСЛЕ расчета балла). Только у категории с подметриками (без
 * истории git строк нет) и только если факт собран: у сканов прежнего
 * сборщика строк нет вовсе. PR нет — одна строка «PR не используются»
 * (данные); только черновики — она же; факт не ok — она же с причиной.
 */
export function withPrReview(cat: CategoryScore, ok: Map<string, unknown>, missing: Record<string, string> | undefined): CategoryScore {
  if (Object.keys(cat.submetrics).length === 0) return cat;
  const pr = ok.get("activity.pr_review") as Record<string, unknown> | undefined;
  const miss = missing?.["activity.pr_review"];
  if (!pr) {
    if (miss !== undefined) cat.submetrics.pr_review = { score: null, value: null, note: `pr review no-data: ${miss}` };
    return cat;
  }
  const sampled = num(pr.sampled) ?? 0;
  if ((num(pr.pulls) ?? 0) === 0 || sampled === 0) {
    cat.submetrics.pr_review = { score: null, value: { pulls: num(pr.pulls) ?? 0, sampled } };
    return cat;
  }
  const answered = num(pr.answered) ?? 0;
  const merged = num(pr.merged) ?? 0;
  cat.submetrics.pr_first_response = {
    score: null,
    value: num(pr.median_first_response_hours),
    ...(answered === 0 ? { note: "no reviewer response in sample" } : {}),
  };
  cat.submetrics.pr_waiting = { score: null, value: { waiting: num(pr.waiting_over_threshold) ?? 0, open: num(pr.open_sampled) ?? 0, threshold_hours: num(pr.threshold_hours) } };
  cat.submetrics.pr_review_comments = {
    score: null,
    value: num(pr.median_review_comments),
    ...((num(pr.comments_capped) ?? 0) > 0 ? { note: "comments page capped — at least" } : {}),
  };
  cat.submetrics.pr_merge_time = {
    score: null,
    value: num(pr.median_merge_hours),
    note: merged === 0 ? "no merged pulls" : "merge time approximated by updated_at",
  };
  return cat;
}

/**
 * Карта владельцев файлов — строка показа «Состояния кода» без веса
 * (DISPLAY_ONLY): значение — сам агрегат факта (карточка и отчет рисуют по
 * нему таблицу каталогов) плюс признак CODEOWNERS из `docs.presence`. У
 * категории без подметрик («кода нет», git не прочитан) строки нет.
 */
export function withOwnership(cat: CategoryScore, ok: Map<string, unknown>, missing: Record<string, string> | undefined): CategoryScore {
  if (Object.keys(cat.submetrics).length === 0) return cat;
  const own = ok.get("code.ownership") as Record<string, unknown> | undefined;
  const miss = missing?.["code.ownership"];
  if (!own) {
    if (miss !== undefined) cat.submetrics.ownership = { score: null, value: null, note: `ownership no-data: ${miss}` };
    return cat;
  }
  const presence = ok.get("docs.presence") as { codeowners?: unknown } | undefined;
  const codeowners = typeof presence?.codeowners === "boolean" ? presence.codeowners : null;
  cat.submetrics.ownership = { score: null, value: { ...own, codeowners } };
  return cat;
}

/** Сборщик посчитал тесты, непустых нет — «тестов нет, в балл не входит». */
export const CI_YAML_UNPARSED_NOTE = "ci.yaml not parsed — steps unknown, CI scored by runs";

export const RELEASES_NO_HUMANS_NOTE = "releases not counted — no human commits within a year";

export const TESTS_NONE_NOTE = "no tests — not scored (tests are a bonus)";
/** Тесты есть, но их доля ниже прочих показателей — бонус не применен. */
export const TESTS_BONUS_IDLE_NOTE = "tests bonus not applied — share would lower the category";

// ---------- запись (PK scan_id+model_version, идемпотентно) ----------

// индекс округляется устойчиво к двоичному шуму (39,4999… → 40)
const roundTotal = (x: number | null): number | null => (x === null ? null : roundScore(x));
const roundCoverage = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Строка scores хранит ТОЛЬКО публичный показатель — healthcraft_index/index_coverage.
 * Полный Repo Health Score выводится из показанных категорий (карточка считает
 * totalsFromCategories при чтении) и отдельно не хранится нигде.
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
