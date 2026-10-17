// Очередь заданий и периодика: claim-loop по jobs и обход каталога.
// Обход — две фазы на одном перечислении: часовая сверка состава
// (Config.scheduler.catalogIntervalMs) и суточная ночная волна пересканов
// (Config.scheduler.intervalMs); таймер тикает с периодом более частой фазы.
// Дополнительно: принудительный полный рескан SCHEDULER_FULL_RESCAN и потолок
// страниц Config.scan.catalog.maxPages.
// Ночная волна сравнивает last_updated каталога с repos.last_activity_at и ставит
// в очередь только новые и изменившиеся репо. Эвикция исчезнувших — только по
// дочитанному до конца каталогу и только по сигналам уровня репозитория.
// NULL в lease_until должен матчиться: в SQLite NULL < now ложно, поэтому IS NULL OR.
// Циклы воркеров живут в процессе сервера: свой цикл на каждую пару «полоса роли ×
// род заявки» (`workerLoopPlan`). Тяжелые репо идут только в один слот каждого
// пользовательского рода — tmp-диск стенда конечен. Истек лиз — заявка снова
// доступна, упавший воркер очередь не блокирует.
// Автор заявки (user_id) определяет токен скана; эвикция — только у заданий без
// автора. Серверный REST-клиент — фабрика: свой бюджет запросов на каждую задачу
// и каждый обход каталога.
import type { Database } from "bun:sqlite";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateCatalog, type CatalogEntry, type CatalogResult } from "../collectors/catalog";
import { COLLECTOR_VERSION } from "../collectors/facts";
import type { ScClient } from "../collectors/http";
import { upsertRepo, runScan, scanCloneLimitsOf, scanGitUrl, type ScanResult } from "./runner";
import { getPat } from "../auth/pat";
import { makeScClient } from "../collectors/http";
import { makeAppsecClient } from "../collectors/appsec";
import { makeLlm } from "../llm";
import { runSummary as runSummaryPipeline, runFraudCheck as runFraudCheckPipeline, NO_RHYTHM_REASON, type SummaryRunResult } from "../summary/pipeline";
import { AI_CACHED_NOTE, AI_REJECTED_ERRORS, type QuotaRefusal } from "./ai-quota";
import type { AiAudience } from "../db";
import { materializeWorktree, removeWorktree } from "../summary/tools";
import { cleanupClone, cloneWithDegrade } from "../collectors/git";
import { DEFAULT_HEAVY_SCAN_MS, loopSlots, worstCaseScanMs, type Config } from "../config";
import { listRepos } from "../api/repos";
import { purgeOldRatingSnapshots, snapshotAtCatalogTick } from "./rating-snapshot";
import { getMetaValue, setMetaValue } from "../db";
import { CATALOG_SUSPICIOUS_AT, SCHED_META } from "../api/health";
import { isBusyError, needsRescore, rescoreBatchByCursor, rescoreHistoryBatch } from "../score/rescore";

export interface ClaimedJob {
  id: number;
  repoId: number;
  slug: string;
  /** автор заявки; null = периодика (серверный токен) */
  userId: number | null;
  triggerKind: string;
  /** род заявки: scan | summary (AI-обзор) | check (проверка на накрутку) */
  kind: string;
  /** аудитория AI-заявки: public (только публичные факты) | full */
  audience?: AiAudience;
  /** метка заявки: продлить лиз и завершить можно только свою заявку */
  claimedAt: string;
  /** номер попытки (после инкремента при claim) */
  attempts: number;
}

/**
 * Активная (queued/running) скан-заявка пользователя на репо — для дедупа.
 * Только kind='scan': живая AI-заявка не должна перехватывать запуск анализа.
 */
export function findActiveUserJob(db: Database, userId: number, repoId: number): number | null {
  const row = db
    .query("SELECT id FROM jobs WHERE user_id = ? AND repo_id = ? AND kind = 'scan' AND status IN ('queued', 'running') ORDER BY id LIMIT 1")
    .get(userId, repoId) as { id: number } | null;
  return row ? row.id : null;
}

/**
 * Отказ предпроверки доступа (403/404 на GET репозитория по PAT): строка jobs
 * со status='refused' воркером не заявляется, но учитывается лимитом частоты.
 * repo_id = 0: строка repos по отказу не создается, а колонка NOT NULL
 * (FK в SQLite не включены); ночной обход такую строку не видит.
 */
export function recordRefusedUserJob(db: Database, userId: number, now = new Date(), slug?: string): number {
  // строки repos нет, поэтому слаг — в error, иначе панель заданий показала бы «–»
  const error = slug === undefined ? null : JSON.stringify({ slug });
  const r = db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at, error) VALUES (0, 'refused', ?, 'user', ?, ?)")
    .run(userId, now.toISOString(), error);
  return Number(r.lastInsertRowid);
}

/**
 * Активных (queued/running) скан-заявок пользователя — предел Config.queue.userActiveMax.
 * AI-заявки слоты анализов не занимают, у них свой предел (`countActiveSummaryJobs`).
 */
export function countActiveUserJobs(db: Database, userId: number): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND kind = 'scan' AND status IN ('queued', 'running')").get(userId) as { c: number }
  ).c;
}

/** Активных summary-заявок пользователя: у них свой предел, кредиты LLM ограничены. */
export function countActiveSummaryJobs(db: Database, userId: number): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND kind = 'summary' AND status IN ('queued', 'running')").get(userId) as { c: number }
  ).c;
}

/**
 * Новых скан-заявок пользователя за скользящий час, включая отказы
 * предпроверки (дубли строк не создают и не считаются). AI-заявки часовой
 * лимит сканов не расходуют.
 */
export function countRecentUserJobs(db: Database, userId: number, now = new Date()): number {
  const since = new Date(now.getTime() - 3600_000).toISOString();
  return (
    db
      .query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND kind = 'scan' AND trigger_kind = 'user' AND created_at > ?")
      .get(userId, since) as { c: number }
  ).c;
}

/**
 * Постановка скана в очередь. Если у того же (пользователь, репо) уже есть
 * активная заявка, новая не создается — возвращается id существующей.
 */
export function enqueueScan(
  db: Database,
  repoId: number,
  opts: { userId?: number | null; triggerKind?: "periodic" | "user"; now?: Date } = {},
): number {
  if (opts.userId !== undefined && opts.userId !== null) {
    const active = findActiveUserJob(db, opts.userId, repoId);
    if (active !== null) return active;
  }
  const r = db
    .query(`INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (?, 'queued', ?, ?, ?)`)
    .run(repoId, opts.userId ?? null, opts.triggerKind ?? "periodic", (opts.now ?? new Date()).toISOString());
  return Number(r.lastInsertRowid);
}

/** Итог постановки summary-заявки. */
export type SummaryEnqueue =
  | { kind: "ok"; jobId: number }
  | { kind: "active"; jobId: number }
  | { kind: "cached" }
  | { kind: "too_many"; activeMax: number }
  | { kind: "cooldown"; until: string }
  | { kind: "quota"; refusal: QuotaRefusal };

/** Предел активных summary-заявок одного пользователя по умолчанию. */
export const DEFAULT_SUMMARY_ACTIVE_MAX = 2;

/**
 * Постановка AI-обзора: jobs.kind='summary' в полосе user. Порядок проверок:
 *  - живая summary-заявка этого репо → active (дедуп по репо, а не по
 *    пользователю: обзор один на скан);
 *  - у последнего завершенного скана уже есть ai_notes → cached (второй раз
 *    тот же скан не генерируется — это лишний расход кредитов);
 *  - активных summary-заявок пользователя ≥ activeMax → too_many;
 *  - кулдаун на репо (Config.queue.summaryCooldownMs) от последней поставленной
 *    summary-заявки, включая failed: кредиты дороже повтора.
 */
export function enqueueSummary(
  db: Database,
  repoId: number,
  opts: {
    userId: number;
    cooldownMs?: number;
    activeMax?: number;
    now?: Date;
    skipCached?: boolean;
    /** аудитория текста; по умолчанию full */
    audience?: AiAudience;
    /** отказ по лимитам — проверяется последним, перед вставкой (кэш и дедуп лимит не тратят) */
    quota?: () => QuotaRefusal | null;
    /** заявка ставится с паролем — общий лимит ее не считает */
    unlocked?: boolean;
  },
): SummaryEnqueue {
  const audience = opts.audience ?? "full";
  const active = db
    .query("SELECT id FROM jobs WHERE repo_id = ? AND kind = 'summary' AND audience = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
    .get(repoId, audience) as { id: number } | null;
  if (active !== null) return { kind: "active", jobId: active.id };
  const scanId = lastFinishedScan(db, repoId);
  // кэш выключается тем же флагом, что и кулдаун: QUEUE_SUMMARY_COOLDOWN_MS=1 —
  // отладочный режим «генерировать каждый раз», кэш по скану там только мешает
  // итерациям над промптами
  const cooldownMs = opts.cooldownMs ?? 60 * 60_000;
  // кэш — заметки обзора этой же аудитории; заметки проверки на накрутку не в счет
  if (
    opts.skipCached !== true &&
    cooldownMs > 1 &&
    scanId !== null &&
    db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = ? LIMIT 1").get(scanId, audience) !== null
  ) {
    return { kind: "cached" };
  }
  const activeMax = opts.activeMax ?? DEFAULT_SUMMARY_ACTIVE_MAX;
  if (countActiveSummaryJobs(db, opts.userId) >= activeMax) return { kind: "too_many", activeMax };
  const last = db
    .query("SELECT created_at FROM jobs WHERE repo_id = ? AND kind = 'summary' AND audience = ? AND created_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(repoId, audience) as { created_at: string } | null;
  if (last !== null) {
    const elapsed = (opts.now ?? new Date()).getTime() - Date.parse(last.created_at);
    if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
      return { kind: "cooldown", until: new Date(Date.parse(last.created_at) + cooldownMs).toISOString() };
    }
  }
  const refusal = opts.quota?.() ?? null;
  if (refusal !== null) return { kind: "quota", refusal };
  const r = db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience, ai_unlocked) VALUES (?, 'queued', ?, 'user', 'summary', ?, ?, ?)")
    .run(repoId, opts.userId, (opts.now ?? new Date()).toISOString(), audience, opts.unlocked === true ? 1 : 0);
  return { kind: "ok", jobId: Number(r.lastInsertRowid) };
}

/** Итог постановки проверки на накрутку. */
export type CheckEnqueue =
  | { kind: "ok"; jobId: number }
  | { kind: "active"; jobId: number }
  | { kind: "cached" }
  | { kind: "no_scan" }
  | { kind: "too_many"; activeMax: number }
  | { kind: "quota"; refusal: QuotaRefusal };

/**
 * Постановка проверки на накрутку (кнопка «Проверить оценку»): jobs.kind='check',
 * без клона — по фактам последнего завершенного скана. Кэш: у скана уже есть
 * проверка → cached (одна проверка на скан, результат видят все); живая
 * проверка репо → active; лимиты — последними, перед вставкой.
 */
export function enqueueCheck(
  db: Database,
  repoId: number,
  opts: { userId: number; activeMax?: number; now?: Date; quota?: () => QuotaRefusal | null; unlocked?: boolean },
): CheckEnqueue {
  const active = db
    .query("SELECT id FROM jobs WHERE repo_id = ? AND kind = 'check' AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
    .get(repoId) as { id: number } | null;
  if (active !== null) return { kind: "active", jobId: active.id };
  const scanId = lastFinishedScan(db, repoId);
  if (scanId === null) return { kind: "no_scan" };
  if (db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role = 'flagger' LIMIT 1").get(scanId) !== null) return { kind: "cached" };
  const activeMax = opts.activeMax ?? DEFAULT_SUMMARY_ACTIVE_MAX;
  const live = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND kind = 'check' AND status IN ('queued', 'running')").get(opts.userId) as { c: number }).c;
  if (live >= activeMax) return { kind: "too_many", activeMax };
  const refusal = opts.quota?.() ?? null;
  if (refusal !== null) return { kind: "quota", refusal };
  const r = db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience, ai_unlocked) VALUES (?, 'queued', ?, 'user', 'check', ?, 'public', ?)")
    .run(repoId, opts.userId, (opts.now ?? new Date()).toISOString(), opts.unlocked === true ? 1 : 0);
  return { kind: "ok", jobId: Number(r.lastInsertRowid) };
}

/** Последний завершенный скан репо, пригодный для генерации. */
export function lastFinishedScan(db: Database, repoId: number): number | null {
  const row = db
    .query("SELECT id FROM scans WHERE repo_id = ? AND status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1")
    .get(repoId) as { id: number } | null;
  return row?.id ?? null;
}

export interface ClaimOptions {
  /** предел попыток (Config.queue.maxAttempts): достигнут → failed, не заявляется */
  maxAttempts?: number;
  /** какую полосу обслуживает этот claim — user | rating */
  queue?: "user" | "rating";
  /** только заявки этого рода (у каждого рода в каждой полосе свой цикл) */
  kind?: JobKind;
  /**
   * Заявка автора, у которого уже идет заявка того же рода с живым лизом, уходит в конец
   * очереди: слот сначала другому человеку, но не простаивает. Имеет смысл только в полосе
   * `user` — у плановых заявок автора нет.
   */
  perUserExclusive?: boolean;
  /**
   * Слот только для легких репо: не берет репо, у которого какой-то скан шел дольше `heavyMs`.
   * Тяжелые идут в первом слоте рода, остальные держат поток легких — два тяжелых репо
   * двух людей не займут все слоты.
   */
  lightOnly?: boolean;
  /** порог «тяжелого» репо, мс (Config.queue.heavyScanMs) */
  heavyMs?: number;
}

/** Роды заявок (`jobs.kind`): у каждого — свой цикл в каждой полосе роли (`workerLoopPlan`). */
export const JOB_KINDS = ["scan", "summary", "check"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Заявить одну job атомарным UPDATE … WHERE (lease_until IS NULL OR lease_until < now):
 * матчится и NULL-лиз, и истекший лиз running-строки (упавший воркер).
 * attempts растет при каждом claim; исчерпавшие попытки → failed с причиной в `jobs.error`.
 * claim обслуживает одну полосу (`opts.queue`), полоса определяется только по
 * `jobs.trigger_kind`. Справедливость между полосами — в `claimAny`.
 * Внутри полосы `user` — круговой порядок между пользователями: сначала те, у кого
 * еще не было заявленных job, затем по давности последней заявки, затем по id.
 * Job без строки repos → failed (чтобы не жечь попытки на истечении лиза), берется следующая.
 */
export function claimNext(db: Database, now = new Date(), leaseMs = 60 * 60_000, opts: ClaimOptions = {}): ClaimedJob | null {
  const maxAttempts = opts.maxAttempts ?? 3;
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + leaseMs).toISOString();
  // исчерпавшие попытки закрываются через finishJob, чтобы записать причину;
  // таких строк единицы, лишняя выборка ничего не стоит
  const exhausted = db
    .query(
      `SELECT id, claimed_at FROM jobs
       WHERE status IN ('queued', 'running') AND attempts >= ? AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .all(maxAttempts, nowIso) as { id: number; claimed_at: string | null }[];
  for (const row of exhausted) finishJob(db, row.id, row.claimed_at, "failed", JOB_ERRORS.attempts);
  // полосы 'user' и 'rating' разделены, чтобы ночная волна не задерживала
  // интерактивные заявки
  const queue = opts.queue ?? "user";
  const kindOnly = opts.kind ?? null;
  const exclusive = opts.perUserExclusive === true ? 1 : 0;
  const lightOnly = opts.lightOnly === true ? 1 : 0;
  const heavyMs = opts.heavyMs ?? DEFAULT_HEAVY_SCAN_MS;
  const claimStmt = db.query(
      `UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE (lease_until IS NULL OR lease_until < ?)
           AND status IN ('queued', 'running')
           AND attempts < ?
           AND (? IS NULL OR kind = ?)
           AND (CASE WHEN ? = 'user' THEN trigger_kind = 'user' ELSE trigger_kind != 'user' END)
           -- В5.2 (аудит очереди О2): слот легких не берет тяжелый репо — у него был скан дольше
           -- порога (закрытые свипом сирот не в счет: их длительность — время до свипа)
           AND (? = 0 OR NOT EXISTS (
                 SELECT 1 FROM scans h
                 WHERE h.repo_id = jobs.repo_id AND h.status_detail IS NOT 'orphaned'
                   AND (julianday(COALESCE(h.finished_at, ?)) - julianday(h.started_at)) * 86400000.0 > ?))
           -- В5.2 (там же): «сначала анализ, потом обзор» прежде держался одной очередью; с
           -- отдельными циклами — явно: AI-заявка пользователя ждет его более ранний скан того
           -- же репо (иначе обзор и проверка ушли бы по прошлому анализу). Полоса рейтинга ждет
           -- только ИДУЩИЙ плановый скан того же репо (аудит О6): стоящий в очереди — нет, он
           -- может ждать сутками, а топ берет последний анализ
           AND (kind = 'scan' OR (CASE WHEN trigger_kind = 'user'
                 THEN NOT EXISTS (
                   SELECT 1 FROM jobs s
                   WHERE s.kind = 'scan' AND s.status IN ('queued', 'running') AND s.trigger_kind = 'user'
                     AND s.repo_id = jobs.repo_id AND s.user_id IS jobs.user_id AND s.id < jobs.id)
                 ELSE NOT EXISTS (
                   SELECT 1 FROM jobs s
                   WHERE s.kind = 'scan' AND s.status = 'running' AND s.lease_until >= ? AND s.trigger_kind != 'user'
                     AND s.repo_id = jobs.repo_id)
                 END))
         -- В4.2-port-fix (П7): круговой порядок между юзерами (Ф1.7) — свойство
         -- ПОЛОСЫ user. У периодических job user_id всегда NULL, но порты
         -- распространили коррелированный подзапрос и на полосу rating, где он
         -- бессмыслен по построению: 28 000 кандидатов × полный скан jobs =
         -- 335,7 с на один claim без idx_jobs_user_claimed (замер вехи), то есть
         -- не «медленнее», а мёртвый синхронный claim. CASE коротко замыкается в
         -- рантайме (EXPLAIN QUERY PLAN у обоих вариантов одинаков — по плану
         -- «исправлять» подзапрос не надо).
         -- В5.2 (аудит надежности С3): в полосе рейтинга AI-заявки топа (summary/check, без
         -- автора) — раньше волны сканов: иначе тексты топа ждут конца ночного обхода. В полосе
         -- user порядок прежний — «сначала анализ, потом обзор» держится очередью
         ORDER BY CASE WHEN ? = 'user' THEN 0 WHEN kind = 'scan' THEN 1 ELSE 0 END,
                  -- В5.2 (очередь, решение 25.09; аудит О4 — слово Екатерины «делай»): у кого уже
                  -- идет заявка того же рода — в конец очереди: свободный слот сначала другому
                  -- человеку, но не простаивает, если ждет только он (прежде — запрет в WHERE)
                  CASE WHEN ? = 1 THEN EXISTS (
                    SELECT 1 FROM jobs r
                    WHERE r.status = 'running' AND r.lease_until >= ? AND r.id != jobs.id
                      AND r.user_id = jobs.user_id AND r.kind = jobs.kind) ELSE 0 END,
                  -- аудит очереди О11б: круговой порядок — по роду (проверка не отодвигает скан)
                  CASE WHEN ? = 'user' THEN ((SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id AND j2.kind = jobs.kind) IS NOT NULL) ELSE 0 END,
                  CASE WHEN ? = 'user' THEN (SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id AND j2.kind = jobs.kind) ELSE NULL END ASC,
                  id
         LIMIT 1
       )
       RETURNING id, repo_id, user_id, trigger_kind, kind, claimed_at, attempts, audience`,
  );
  // Перехват заявки после истекшего лиза закрывает ее прежний `running`-скан
  // того же (репо, автор) в той же транзакции, что и claim. Живого скана под
  // этим ключом быть не может: у него была бы живая заявка с непросроченным
  // лизом, а активная заявка на (пользователь, репо) и периодическая на репо —
  // по одной. Иначе сирота жила бы до уборки, а новый лиз еще и прятал бы ее от уборки
  const closeStale = db.query(
    `UPDATE scans SET status = 'bad', public_status = 'bad', finished_at = ?, status_detail = 'orphaned'
     WHERE repo_id = ? AND user_id IS ? AND status = 'running'`,
  );
  const claimTx = db.transaction(() => {
    const row = claimStmt.get(nowIso, leaseIso, nowIso, maxAttempts, kindOnly, kindOnly, queue, lightOnly, nowIso, heavyMs, nowIso, queue, exclusive, nowIso, queue, queue) as {
      id: number;
      repo_id: number;
      user_id: number | null;
      trigger_kind: string;
      kind: string;
      claimed_at: string;
      attempts: number;
      audience: string;
    } | null;
    // только для скан-заявки: AI-заявки сканов не ведут, и running-скан того же
    // (репо, автор) при их claim — чужой законный скан со своей живой заявкой
    if (row && row.kind === "scan") {
      const closed = closeStale.run(nowIso, row.repo_id, row.user_id);
      if (closed.changes > 0) console.log(`[claim] job ${row.id}: stale running scans closed as orphaned: ${closed.changes}`);
    }
    return row;
  });
  // предохранитель цикла: каждая итерация переводит одну job в running или failed
  for (let guard = 0; guard < 1000; guard++) {
    const claimed = claimTx();
    if (!claimed) return null;
    const repo = db.query("SELECT org_slug, repo_slug FROM repos WHERE id = ?").get(claimed.repo_id) as
      | { org_slug: string; repo_slug: string }
      | null;
    if (!repo) {
      // через finishJob — иначе панель заданий покажет failed без причины
      finishJob(db, claimed.id, claimed.claimed_at, "failed", JOB_ERRORS.gone);
      continue;
    }
    return {
    id: claimed.id,
    repoId: claimed.repo_id,
    slug: `${repo.org_slug}/${repo.repo_slug}`,
    userId: claimed.user_id,
    triggerKind: claimed.trigger_kind,
    kind: claimed.kind,
    audience: claimed.audience === "public" ? "public" : "full",
    claimedAt: claimed.claimed_at,
    attempts: claimed.attempts,
  };
  }
  return null;
}

// Курсор round-robin между полосами. При строгом порядке полос в роли `all`
// полоса `rating` голодала бы, пока в `user` есть хоть одна заявка, — периодика
// и эвикция вставали бы, а /api/health оставался зеленым.
let rrCursor = 0;

/** Для тестов: курсор модульный, изоляция между тестами — сбросом. */
export function __resetRoundRobin(): void {
  rrCursor = 0;
}

/**
 * Последовательный claim по полосам: следующая — только если предыдущая пуста.
 * Заявлять из всех сразу нельзя: вторая заявка повисла бы running без исполнителя
 * на весь лиз. Порядок — `order`, повернутый на курсор; курсор растет на каждом
 * вызове, иначе пустая первая полоса залипает. Для ролей с одной полосой поворот
 * ничего не меняет.
 */
export function claimAny(db: Database, order: Array<"user" | "rating">, now = new Date(), leaseMs = 60 * 60_000, opts: ClaimOptions = {}): ClaimedJob | null {
  if (order.length === 0) return null;
  const start = rrCursor % order.length;
  rrCursor = (rrCursor + 1) % Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < order.length; i++) {
    const job = claimNext(db, now, leaseMs, { ...opts, queue: order[(start + i) % order.length]! });
    if (job !== null) return job;
  }
  return null;
}

/**
 * Запись с повтором при SQLITE_BUSY — до `attempts` попыток с
 * асинхронным бэкоффом (цикл событий не блокируется сверх busy_timeout
 * соединения); прочие ошибки и исчерпание попыток летят наружу.
 */
export async function withBusyRetry<T>(fn: () => T, label: string, opts: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const baseMs = opts.baseMs ?? 500;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || i >= attempts) throw e;
      console.warn(`[worker] ${label}: SQLITE_BUSY (attempt ${i}/${attempts}) — retrying`);
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
  }
}

/** Продление лиза своей заявки; если заявку уже перезаявили (другой claimed_at) — no-op. */
export function renewLease(db: Database, jobId: number, claimedAt: string, leaseMs: number, now = new Date()): boolean {
  const r = db
    .query("UPDATE jobs SET lease_until = ? WHERE id = ? AND claimed_at = ? AND status = 'running'")
    .run(new Date(now.getTime() + leaseMs).toISOString(), jobId, claimedAt);
  return r.changes > 0;
}

/**
 * Причины падения job для `jobs.error`. UI показывает их пользователю дословно
 * (`MePage.tsx`), поэтому это закрытый список русских текстов без секретов.
 */
export const JOB_ERROR_MAX = 500;
export const JOB_ERRORS = {
  gone: "репозиторий недоступен",
  noPat: "нет действующего токена",
  attempts: "превышено число попыток",
  internal: "внутренняя ошибка",
  /** скан собрал факты, но оценку посчитать не удалось — скан закрыт `bad` (score_failed) */
  scoreFailed: "не удалось посчитать оценку",
  /** `bad`-скан: какие каналы не собрались — словами, а не кодами каналов */
  channels: (channels: string[]): string => `сбор данных не удался: ${channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ")}`.slice(0, JOB_ERROR_MAX),
} as const;

/** Каналы скана языком продукта: причина падения показывается в «Заданиях» дословно. */
const CHANNEL_NAMES: Record<string, string> = { git: "скачивание репозитория", rest: "данные SourceCraft", appsec: "Безопасность" };

/**
 * Каналы `bad`-скана, которые не собрались, — для текста причины.
 * Собравшимся считается любой `ok*`: деградированный shallow-клон помечен
 * `ok(degraded)` — данные есть, только история укорочена.
 */
export function failedChannelsOf(channels: { git: string; rest: string; appsec: string }): string[] {
  return (["git", "rest", "appsec"] as const).filter((k) => !channels[k].startsWith("ok") && channels[k] !== "skipped");
}

/**
 * Завершение job — только своей заявки (WHERE id AND claimed_at): воркер с
 * истекшим лизом, чью job перезаявили, чужой прогон не закроет.
 * `claimed_at IS ?`, а не `=`: сюда же идет ветка предела попыток, где у
 * незаявленной строки `claimed_at` NULL.
 * `error` — причина из `JOB_ERRORS`; без нее колонка очищается, чтобы успешный
 * перезапуск не показывал старую причину.
 */
export function finishJob(db: Database, jobId: number, claimedAt: string | null, status: "done" | "failed", error?: string): boolean {
  const r = db
    .query("UPDATE jobs SET status = ?, lease_until = NULL, error = ? WHERE id = ? AND claimed_at IS ?")
    .run(status, error === undefined ? null : error.slice(0, JOB_ERROR_MAX), jobId, claimedAt);
  return r.changes > 0;
}

// ---------- эвикция ----------

/** Убрать репо из рейтинга по сигналу уровня репозитория (404/403 на GET, исчезновение из каталога). */
export function evictRepo(db: Database, repoId: number, reason: string): void {
  db.query("UPDATE repos SET rating_active = 0, evict_reason = ? WHERE id = ?").run(reason, repoId);
}

/** Вернуть репо в рейтинг: эвикция — флаг, строка не удаляется. */
export function returnRepo(db: Database, repoId: number): void {
  db.query("UPDATE repos SET rating_active = 1, evict_reason = NULL WHERE id = ?").run(repoId);
}

// ---------- ночной обход каталога ----------

export interface NightlyEnqueued {
  slug: string;
  /**
   * retry-ineligible — последний завершенный периодический скан непригоден для рейтинга;
   * recollect — последний пригодный скан собран сборщиком старше COLLECTOR_VERSION
   */
  reason: "new" | "changed" | "forced" | "retry-failed" | "retry-ineligible" | "recollect";
}

/**
 * Сколько репо, собранных старым сборщиком, ставить на пересбор за одну ночную волну.
 * Стенд по данным БД делает 5-7 тыс. сканов в сутки, так что 5000 за ночь укладываются
 * в пропускную способность, а ~28 тыс. кандидатов уходят примерно за 6 ночей.
 */
export const RECOLLECT_PER_WAVE_DEFAULT = 5000;

/**
 * `SCHEDULER_RECOLLECT_PER_WAVE` — порция пересборки фактов за волну, рычаг нагрузки
 * на живой API. Некорректное или отрицательное значение — дефолт, 0 — пересбор выключен.
 */
export function recollectPerWave(env: Record<string, string | undefined> = process.env): number {
  const raw = env["SCHEDULER_RECOLLECT_PER_WAVE"];
  if (raw === undefined || raw.trim() === "") return RECOLLECT_PER_WAVE_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : RECOLLECT_PER_WAVE_DEFAULT;
}

export interface NightlyResult {
  ok: boolean;
  pages: number;
  entriesSeen: number;
  enqueued: NightlyEnqueued[];
  evicted: string[];
  returned: string[];
  /** каталог дочитан до конца? если нет — эвикция НЕ выполнялась (неполный каталог не доказывает исчезновение) */
  catalogComplete: boolean;
  /** какие фазы реально исполнились на этом обходе */
  phases: CatalogPhases;
  /** обход поднял catalog_suspicious_at (эвикция приостановлена) */
  suspicious: boolean;
  error?: string;
}

export interface NightlyOptions {
  maxPages?: number;
  fullRescan?: boolean;
  now?: Date;
  /** какие фазы исполняются на этом обходе */
  phases?: CatalogPhases;
  /** порция пересбора «собрано старым сборщиком»; по умолчанию — recollectPerWave() */
  recollectPerWave?: number;
}

/**
 * Две фазы поверх одного перечисления каталога.
 * `reconcile` — сверка состава (раз в час): новые репо, возврат вернувшихся,
 * эвикция исчезнувших. `nightly` — волна пересканов (раз в сутки): changed,
 * retry-failed, retry-ineligible, форс. Один обход, один клиент, один бюджет.
 */
export interface CatalogPhases {
  reconcile: boolean;
  nightly: boolean;
}

/** Причина эвикции при сверке каталога. */
export const EVICT_NOT_IN_CATALOG = "not in public catalog";

/** Строка repos для сверки каталога (читаются одним запросом в память). */
interface CatalogRepoRow {
  id: number;
  org_slug: string;
  repo_slug: string;
  title: string | null;
  language: string | null;
  likes: number | null;
  visibility: string;
  logo_url: string | null;
  language_color: string | null;
  last_activity_at: string | null;
}

/**
 * Применить мету каталога к repos только при расхождении или для новой строки:
 * неизменившаяся строка не перезаписывается (иначе каждая часовая сверка —
 * десятки тысяч лишних UPDATE). Сравнение зеркалит COALESCE в upsertRepo: null
 * из каталога ничего не затирает. Видимость — только из явного поля;
 * `last_activity_at` обход не пишет.
 */
function reconcileCatalogRepo(db: Database, entry: CatalogEntry, existing: CatalogRepoRow | null): number {
  if (existing !== null) {
    const hasVisibility = typeof entry.visibility === "string" && entry.visibility !== "";
    const changed =
      (entry.name !== null && entry.name !== existing.title) ||
      (entry.language !== null && entry.language !== existing.language) ||
      (entry.likes !== null && entry.likes !== existing.likes) ||
      (hasVisibility && entry.visibility !== existing.visibility) ||
      (entry.logo_url !== null && entry.logo_url !== existing.logo_url) ||
      (entry.language_color !== null && entry.language_color !== existing.language_color);
    if (!changed) return existing.id; // неизменившаяся строка — ноль записей
  }
  return upsertRepo(db, entry.org, entry.repo, {
    title: entry.name,
    language: entry.language,
    likes: entry.likes,
    // `last_activity_at` — отметка «до какой даты репо просканирован»; двигать ее
    // вправе только пригодный успешный скан (`runScan`, после скор-хука)
    lastActivityAt: undefined,
    // видимость — только из явного поля платформы
    visibility: entry.visibility ?? undefined,
    logoUrl: entry.logo_url,
    languageColor: entry.language_color,
  });
}

/**
 * Полный обход каталога: дифф last_updated → очередь изменившихся, постановка
 * новых, эвикция исчезнувших (только public-строки; приватных репо в публичном
 * каталоге и не ждем). Повторный прогон по неизменному каталогу ничего не ставит.
 * retry-failed смотрит только на последнюю периодическую job — пользовательская
 * перескан не навязывает и не маскирует. Непригодный последний периодический
 * скан → перескан (retry-ineligible), не чаще раза за обход.
 * У репо с живой периодической job (queued/running) новая не ставится вообще,
 * иначе retry-ineligible плодил бы дубли на каждом обходе.
 */
export async function nightlyCatalog(db: Database, client: ScClient, opts: NightlyOptions = {}): Promise<NightlyResult> {
  const fullRescan = opts.fullRescan ?? false;
  const now = opts.now ?? new Date();
  const phases: CatalogPhases = opts.phases ?? { reconcile: true, nightly: true };
  const catalog: CatalogResult = await enumerateCatalog(client, { maxPages: opts.maxPages });
  if (!catalog.ok && catalog.pages === 0) {
    return {
      ok: false,
      pages: 0,
      entriesSeen: 0,
      enqueued: [],
      evicted: [],
      returned: [],
      catalogComplete: false,
      phases: { reconcile: false, nightly: false },
      suspicious: false,
      error: catalog.error?.detail ?? "catalog failed",
    };
  }

  const enqueued: NightlyEnqueued[] = [];
  const enqueuedRepoIds = new Set<number>();
  // Волна ставится по убыванию лайков: витринные репо получают оценку первыми
  // (за сутки успевает лишь часть из ~28 тыс. репо каталога). GET /repos не
  // умеет sort_by=likes (только created_at|rating), поэтому сортировка на нашей
  // стороне. Кандидаты копятся за обход и ставятся пачками в конце.
  const waveCandidates: { repoId: number; slug: string; reason: NightlyEnqueued["reason"]; likes: number | null }[] = [];
  const recollectCandidates: typeof waveCandidates = [];
  const recollectIds = new Set<number>();
  // полоса определяется по trigger_kind; строки refused несут trigger_kind='user'
  // и в полосу периодики не попадают
  const hasLivePeriodicJob = (repoId: number): boolean =>
    // только скан-заявки: AI-заявка топа из полосы рейтинга скан не заслоняет
    db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND trigger_kind != 'user' AND kind = 'scan' AND status IN ('queued', 'running') LIMIT 1").get(repoId) !== null;
  const seenRepoIds = new Set<number>();
  const seenSlugs = new Set<string>();
  // repos читается одним запросом в память, а пишется только при расхождении:
  // безусловный upsert на каждую запись каталога — ~27 тыс. UPDATE за каждую
  // часовую сверку, и все это синхронно в одном процессе с Bun.serve.
  const repoRows = db
    .query("SELECT id, org_slug, repo_slug, title, language, likes, visibility, logo_url, language_color, last_activity_at FROM repos")
    .all() as CatalogRepoRow[];
  const reposBySlug = new Map(repoRows.map((r) => [`${r.org_slug}/${r.repo_slug}`, r]));

  for (const entry of catalog.entries) {
    const slug = `${entry.org}/${entry.repo}`;
    seenSlugs.add(slug);
    const existing = reposBySlug.get(slug) ?? null;
    const repoId = reconcileCatalogRepo(db, entry, existing);
    seenRepoIds.add(repoId);
    // не чаще раза за обход (дубли записей каталога)
    if (enqueuedRepoIds.has(repoId)) continue;
    // живая периодическая job уже отсканирует репо — вторая не нужна
    if (hasLivePeriodicJob(repoId)) continue;
    if (!existing) {
      // новые репо — фаза сверки состава, а не волна пересканов
      if (!phases.reconcile) continue;
      enqueuedRepoIds.add(repoId);
      waveCandidates.push({ repoId, slug, reason: "new", likes: entry.likes });
      continue;
    }
    // всё, что ниже, — ночная волна пересканов
    if (!phases.nightly) continue;
    if (existing.last_activity_at === null && entry.last_updated !== null) {
      // строка была без даты (ручной ввод слага) — теперь дата есть: это «изменившийся»
      enqueuedRepoIds.add(repoId);
      waveCandidates.push({ repoId, slug, reason: "changed", likes: entry.likes ?? existing.likes });
      continue;
    }
    const changed = entry.last_updated !== existing.last_activity_at;
    // полоса определяется только по trigger_kind. Для старых строк это держится
    // на миграции: `openDb` проставляет `trigger_kind = 'user'` всем строкам с
    // `user_id`, иначе они читались бы как периодические из-за DEFAULT 'periodic'.
    // Строки refused (trigger_kind = 'user', repo_id = 0) сюда не попадают
    const lastJob = db
      // упавшая AI-заявка — не повод пересканировать репо
      .query("SELECT status FROM jobs WHERE repo_id = ? AND trigger_kind != 'user' AND kind = 'scan' ORDER BY id DESC LIMIT 1")
      .get(repoId) as { status: string } | null;
    const retryFailed = lastJob?.status === "failed";
    // в scans колонка `trigger` имеет три значения (periodic|user|probe), поэтому
    // `trigger != 'user'` не равносильно `user_id IS NULL` — фильтр остается по user_id
    const lastPeriodicScan = db
      .query("SELECT rating_eligible FROM scans WHERE repo_id = ? AND user_id IS NULL AND status NOT IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
      .get(repoId) as { rating_eligible: number } | null;
    const retryIneligible = lastPeriodicScan !== null && lastPeriodicScan.rating_eligible !== 1;
    if (fullRescan || changed || retryFailed || retryIneligible) {
      enqueuedRepoIds.add(repoId);
      waveCandidates.push({
        repoId,
        slug,
        reason: fullRescan ? "forced" : changed ? "changed" : retryFailed ? "retry-failed" : "retry-ineligible",
        likes: entry.likes ?? existing.likes,
      });
      continue;
    }
    // неизменный репо, чей последний пригодный скан собран старым сборщиком
    // (NULL — до учета версий), ставится на пересбор: иначе правки сборщика
    // не дошли бы до рейтинга
    const lastEligible = db
      .query("SELECT collector_version FROM scans WHERE repo_id = ? AND rating_eligible = 1 ORDER BY id DESC LIMIT 1")
      .get(repoId) as { collector_version: number | null } | null;
    if (!recollectIds.has(repoId) && lastEligible !== null && (lastEligible.collector_version === null || lastEligible.collector_version < COLLECTOR_VERSION)) {
      recollectIds.add(repoId);
      recollectCandidates.push({ repoId, slug, reason: "recollect", likes: entry.likes ?? existing.likes });
    }
  }
  // пересбор ограничен порцией, по убыванию лайков — бережно к живому API
  recollectCandidates.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  for (const cand of recollectCandidates.slice(0, Math.max(0, opts.recollectPerWave ?? recollectPerWave()))) {
    enqueuedRepoIds.add(cand.repoId);
    waveCandidates.push(cand);
  }

  // лайки по убыванию, без лайков — в хвост; постановка пачками по 100 в одной
  // транзакции, чтобы не делать автокоммит на каждую строку.
  // -1 вместо -Infinity: у пары null разность -Infinity дала бы NaN, а лайки
  // неотрицательны
  waveCandidates.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  const WAVE_ENQUEUE_CHUNK = 100;
  for (let i = 0; i < waveCandidates.length; i += WAVE_ENQUEUE_CHUNK) {
    db.transaction(() => {
      for (const cand of waveCandidates.slice(i, i + WAVE_ENQUEUE_CHUNK)) {
        enqueueScan(db, cand.repoId, { triggerKind: "periodic" });
        enqueued.push({ slug: cand.slug, reason: cand.reason });
      }
    })();
  }

  // возврат ранее эвиктированных, вернувшихся в каталог — фаза сверки
  const returned: string[] = [];
  for (const id of phases.reconcile ? seenRepoIds : []) {
    const row = db.query("SELECT rating_active, org_slug, repo_slug FROM repos WHERE id = ?").get(id) as
      | { rating_active: number; org_slug: string; repo_slug: string }
      | null;
    if (row && row.rating_active === 0) {
      returnRepo(db, id);
      returned.push(`${row.org_slug}/${row.repo_slug}`);
    }
  }

  // «Успешно пустой» полный обход (ok, не truncated, 0 записей) при активных
  // публичных репо — это сломавшаяся форма ответа каталога (например, дрейф поля
  // visibility), а не «все исчезли»: иначе один такой обход выключил бы весь
  // рейтинг. Эвикция не выполняется, ставится флаг catalog_suspicious_at (виден
  // в health); снимает его первый обход с записями.
  // Счетчик отброшенных записей пишется всегда: чистый обход сбрасывает его в 0,
  // чтобы health не показывал устаревшее число
  setMetaValue(db, "catalog_skipped_bad_entries", String(catalog.skippedBadEntries));
  if (catalog.skippedBadEntries > 0) {
    console.warn(`[scheduler] catalog walk skipped ${catalog.skippedBadEntries} entries with bad slugs/form`);
  }
  let suspicious = false;
  if (catalog.entries.length > 0) {
    if (getMetaValue(db, CATALOG_SUSPICIOUS_AT) !== null) db.query("DELETE FROM meta WHERE key = ?").run(CATALOG_SUSPICIOUS_AT);
  } else if (catalog.ok && !catalog.truncated) {
    const activePublic = db.query("SELECT 1 FROM repos WHERE rating_active = 1 AND visibility = 'public' LIMIT 1").get();
    if (activePublic !== null) {
      suspicious = true;
      setMetaValue(db, CATALOG_SUSPICIOUS_AT, now.toISOString());
      console.error(
        "[scheduler] catalog walk returned ZERO public entries while active public repos exist — eviction suspended, catalog_suspicious_at set",
      );
    }
  }

  // эвикция: фаза сверки, только полным каталогом и только public-строки;
  // подозрительно пустой снимок эвицировать не имеет права (гард выше)
  const evicted: string[] = [];
  if (phases.reconcile && !catalog.truncated && !suspicious) {
    const candidates = db
      .query("SELECT id, org_slug, repo_slug FROM repos WHERE rating_active = 1 AND visibility = 'public'")
      .all() as { id: number; org_slug: string; repo_slug: string }[];
    for (const row of candidates) {
      if (!seenSlugs.has(`${row.org_slug}/${row.repo_slug}`)) {
        evictRepo(db, row.id, EVICT_NOT_IN_CATALOG);
        evicted.push(`${row.org_slug}/${row.repo_slug}`);
      }
    }
  }

  return {
    // ошибка страницы посреди обхода — сбой всего обхода, даже если что-то уже
    // прочитано: иначе тик сдвинул бы отметки «когда фаза выполнена» зря
    ok: catalog.ok,
    pages: catalog.pages,
    entriesSeen: catalog.entries.length,
    enqueued,
    evicted,
    returned,
    catalogComplete: !catalog.truncated,
    phases,
    suspicious,
    ...(catalog.ok ? {} : { error: catalog.error?.detail ?? "catalog failed" }),
  };
}

// ---------- исполнение заявленной job ----------

export interface WorkerDeps {
  db: Database;
  config: Config;
  /** фабрика серверного REST-клиента: новый клиент (бюджет Config.scan.rest.budget) на каждую задачу; null = токена нет */
  serverClient: () => ScClient | null;
  /** швы для тестов */
  runScan?: typeof runScan;
  getPat?: typeof getPat;
  claimAny?: typeof claimAny;
  runSummary?: typeof runSummaryPipeline;
  runFraudCheck?: typeof runFraudCheckPipeline;
}

/**
 * Исполнить заявленную job: заявка пользователя идет с PAT автора, периодика —
 * с серверным токеном (новый клиент на задачу). Лимиты клона для всех сканов
 * одни — из конфига оператора.
 * 404/403 на GET репозитория → эвикция только у задач без автора: 403 на PAT
 * пользователя говорит о правах PAT, а не о репо. 403 на cicd/runs — не эвикция.
 * Заявка пользователя без читаемого PAT (удален после постановки, нет APP_SECRET)
 * → failed без скана: серверный токен пользовательской заявке не достается никогда.
 */
export async function processJob(deps: WorkerDeps, job: ClaimedJob): Promise<ScanResult | "gone" | "no-pat"> {
  const pat =
    job.userId !== null && deps.config.auth.appSecret
      ? (deps.getPat ?? getPat)(deps.db, deps.config.auth.appSecret, job.userId)
      : null;
  if (job.userId !== null && !pat) {
    finishJob(deps.db, job.id, job.claimedAt, "failed", JOB_ERRORS.noPat);
    return "no-pat";
  }
  const limits = scanCloneLimitsOf(deps.config.scan);
  const result = await (deps.runScan ?? runScan)(
    {
      db: deps.db,
      scClient: deps.serverClient(),
      cloneLimits: limits,
      // лимиты извлечения — из конфига процесса, а не из дефолтов модуля:
      // иначе SCAN_EXTRACT_TIMEOUT_MS ни на что не влиял бы
      extract: deps.config.scan.extract,
      userScClient: pat
        ? makeScClient({
            token: pat,
            baseUrl: deps.config.api.restBase,
            minIntervalMs: deps.config.scan.rest.minIntervalMs,
            maxRequests: deps.config.scan.rest.budget,
            timeoutMs: deps.config.scan.rest.timeoutMs,
          })
        : undefined,
      appsecClient: (p: string) => makeAppsecClient({ token: p, baseUrl: deps.config.api.appsecBase, minIntervalMs: deps.config.scan.rest.appsecMinIntervalMs }),
      gitBase: deps.config.api.gitBase,
      // адреса REST/AppSec — для всех клиентов, включая те, что runScan строит сам
      restBase: deps.config.api.restBase,
      appsecBase: deps.config.api.appsecBase,
      appsecMinIntervalMs: deps.config.scan.rest.appsecMinIntervalMs,
    },
    job.slug,
    { userId: job.userId, userToken: pat, trigger: job.triggerKind },
  );
  if (result.repoAccess === "gone" && job.userId === null) {
    evictRepo(deps.db, job.repoId, `repo GET 404/403 at scan ${result.scanId}`);
    return "gone";
  }
  return result;
}

/**
 * Токен клона summary-заявки: публичная версия — всегда без токена (только то, что
 * открыто всем), полная — токеном автора.
 */
export function summaryCloneToken(audience: AiAudience, pat: string | null): string | null {
  return audience === "public" ? null : pat;
}

/** Причины падения summary-заявки языком продукта (панель заданий). */
export const SUMMARY_JOB_ERRORS = {
  noPat: JOB_ERRORS.noPat,
  noScan: "нет завершённого скана для генерации",
  clone: (detail: string): string => `не удалось клонировать репозиторий: ${detail}`.slice(0, JOB_ERROR_MAX),
  // тот же текст служит признаком «кредиты потрачены» для лимитов (ai-quota.ts)
  empty: AI_REJECTED_ERRORS.overview,
  /** провайдер недоступен (LlmError: сеть/429/5xx/зависание) — не вина валидатора */
  providerDown: "AI-провайдер недоступен: описание не сформировано (сеть или лимиты провайдера)",
  internal: JOB_ERRORS.internal,
} as const;

/**
 * Причина пустого результата генерации. Решает число ответов модели: 0 ответов —
 * провайдер недоступен (лимит не списывается); хоть один — модель отработала, но
 * текст не прошел проверку (списывается).
 */
export function summaryEmptyErrorOf(res: Pick<SummaryRunResult, "outcomes" | "answered">): string {
  // без счетчика ответов (тестовые швы) — по причинам ролей: «провайдер недоступен»,
  // если все несостоявшиеся роли упали на вызове модели; роли без фактов не в счет
  if (res.answered !== undefined) return res.answered === 0 ? SUMMARY_JOB_ERRORS.providerDown : SUMMARY_JOB_ERRORS.empty;
  const failed = res.outcomes.filter((o) => !o.ok && !(o.reason ?? "").startsWith("нет фактов"));
  const modelDown = failed.length > 0 && failed.every((o) => (o.reason ?? "").startsWith("модель:"));
  return modelDown ? SUMMARY_JOB_ERRORS.providerDown : SUMMARY_JOB_ERRORS.empty;
}

/**
 * Исполнить summary-заявку: клон (свежий и полный — история нужна git_log) →
 * worktree → конвейер на фактах последнего завершенного скана → ai_notes → уборка.
 * Возвращает null при успехе или причину для jobs.error. Оценку и очередь сканов не трогает.
 */
export async function processSummaryJob(deps: WorkerDeps, job: ClaimedJob): Promise<string | null> {
  const pat =
    job.userId !== null && deps.config.auth.appSecret
      ? (deps.getPat ?? getPat)(deps.db, deps.config.auth.appSecret, job.userId)
      : null;
  // публичный обзор публичного репо клонируется и без токена автора
  if (job.userId !== null && !pat && job.audience !== "public") return SUMMARY_JOB_ERRORS.noPat;
  const scanId = lastFinishedScan(deps.db, job.repoId);
  if (scanId === null) return SUMMARY_JOB_ERRORS.noScan;
  // заметки этой аудитории у скана уже есть — клонировать незачем;
  // отладочный кулдаун (1 мс) кэш выключает, как и в конвейере
  const cacheOn = (deps.config.queue.summaryCooldownMs ?? 60 * 60_000) > 1;
  if (
    cacheOn &&
    deps.db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = ? LIMIT 1").get(scanId, job.audience ?? "full") !== null
  ) {
    console.log(`[summary job ${job.id}] ${job.slug}: notes already exist for scan ${scanId} — no clone, no generation`);
    return AI_CACHED_NOTE;
  }
  const limits = scanCloneLimitsOf(deps.config.scan);
  const [org, repo] = job.slug.split("/");
  // публичная версия клонируется без токена автора: репо, ставший закрытым до обхода
  // каталога, не склонируется, и его код не попадет в публичный текст
  const cloneToken = summaryCloneToken(job.audience ?? "full", pat);
  const clone = await cloneWithDegrade(scanGitUrl(deps.config.api.gitBase, cloneToken, org!, repo!), undefined, limits);
  if (!clone.ok) return SUMMARY_JOB_ERRORS.clone(clone.detail.slice(0, 120));
  let worktree: { root: string; gitDir: string } | null = null;
  try {
    worktree = await materializeWorktree(clone.dir);
    const res: SummaryRunResult = await (deps.runSummary ?? runSummaryPipeline)(
      {
        db: deps.db,
        org: org!,
        repo: repo!,
        // обзор пользователя — впереди полосы рейтинга в семафоре провайдера
        callLlm: makeLlm(deps.config, undefined, { priority: job.triggerKind === "user" ? "interactive" : "background" }),
        clone: { root: worktree.root, gitDir: worktree.gitDir },
        models: { main: deps.config.llm.mainModel, side: deps.config.llm.sideModel },
        // отладочный кулдаун (1 мс) выключает и внутренний кэш конвейера —
        // регенерация перезаписывает заметки того же скана
        cache: (deps.config.queue.summaryCooldownMs ?? 60 * 60_000) > 1,
        // итог и причины по ролям видны оператору в консоли процесса
        log: (m) => console.log(m),
      },
      { scanId, audience: job.audience ?? "full" },
    );
    // заметки уже были, генерации не было — задание все равно done
    if (res.cached === true) return AI_CACHED_NOTE;
    if (res.notes > 0) return null;
    return summaryEmptyErrorOf(res);
  } finally {
    if (worktree !== null) await removeWorktree(worktree.root, worktree.gitDir);
    const cleanupError = cleanupClone(clone.dir);
    if (cleanupError) console.error(`[summary job ${job.id}] cleanup ${clone.dir}: ${cleanupError}`);
  }
}

/** Причины падения проверки на накрутку языком продукта (панель заданий). */
export const CHECK_JOB_ERRORS = {
  noScan: "нет завершённого скана для проверки",
  noRhythm: "в анализе нет истории коммитов – проверять нечего",
  rejected: AI_REJECTED_ERRORS.check,
  providerDown: "AI-провайдер недоступен: проверка не сформирована (сеть или лимиты провайдера)",
} as const;

/**
 * Исполнить проверку на накрутку: без клона — по фактам последнего
 * завершенного скана (runFraudCheck). Возвращает null при успехе или причину.
 */
export async function processCheckJob(deps: WorkerDeps, job: ClaimedJob): Promise<string | null> {
  const scanId = lastFinishedScan(deps.db, job.repoId);
  if (scanId === null) return CHECK_JOB_ERRORS.noScan;
  const [org, repo] = job.slug.split("/");
  const res = await (deps.runFraudCheck ?? runFraudCheckPipeline)(
    {
      db: deps.db,
      org: org!,
      repo: repo!,
      // проверка пользователя — первой в семафоре провайдера
      callLlm: makeLlm(deps.config, undefined, { priority: job.triggerKind === "user" ? "check" : "background" }),
      models: { main: deps.config.llm.mainModel, side: deps.config.llm.sideModel },
      log: (m) => console.log(m),
    },
    { scanId },
  );
  if (res.cached === true) return AI_CACHED_NOTE;
  if (res.ok) return null;
  if (res.reason === NO_RHYTHM_REASON) return CHECK_JOB_ERRORS.noRhythm;
  // решает число ответов модели, а не текст причины последней попытки
  if (res.answered !== undefined) return res.answered === 0 ? CHECK_JOB_ERRORS.providerDown : CHECK_JOB_ERRORS.rejected;
  return (res.reason ?? "").startsWith("модель:") ? CHECK_JOB_ERRORS.providerDown : CHECK_JOB_ERRORS.rejected;
}

// ---------- циклы процесса сервера ----------

/**
 * Заявки, взятые этим процессом (id → claimed_at и ключ скана). По SIGTERM они
 * возвращаются в queued (claimed_at NULL) с откатом попытки: остановка сервиса —
 * не попытка, иначе три рестарта во время скана давали бы «превышено число попыток».
 * Реестр живет в памяти процесса, поэтому чужие заявки не трогаются никогда.
 * repoId/userId нужны, чтобы прерванный скан этого процесса закрыть сразу
 * (closeOwnRunningScans), а не ждать уборки сирот.
 */
const liveClaims = new Map<number, { claimedAt: string; repoId: number; userId: number | null; kind: string }>();

/**
 * Сканы этого процесса, прерванные штатным завершением, закрываются как `bad` с
 * причиной shutdown. Пишутся все четыре поля, как у уборки сирот (`sweepOrphanScans`):
 * один status='bad' оставил бы public_status='running' навсегда.
 * Порядок при SIGTERM: сначала закрыть сканы, потом вернуть заявки — иначе
 * queued-заявка прикрывала бы закрываемый скан.
 */
export function closeOwnRunningScans(db: Database): number {
  const nowIso = new Date().toISOString();
  let closed = 0;
  for (const claim of liveClaims.values()) {
    // только за скан-заявки: обзор и проверка сканов не ведут, а живой скан того же
    // (репо, автор) у соседней реплики трогать нельзя
    if (claim.kind !== "scan") continue;
    try {
      const r = db
        .query(
          `UPDATE scans SET status = 'bad', public_status = 'bad', finished_at = ?, status_detail = 'shutdown'
           WHERE repo_id = ? AND user_id IS ? AND status = 'running'`,
        )
        .run(nowIso, claim.repoId, claim.userId);
      closed += r.changes;
    } catch (e) {
      console.error(`[shutdown] close scan failed: ${String((e as Error).message).slice(0, 200)}`);
    }
  }
  return closed;
}

/** Вернуть свои running-заявки в очередь; возвращает число возвращённых. */
export function returnOwnRunningJobs(db: Database): number {
  let returned = 0;
  for (const [id, claim] of liveClaims) {
    try {
      const r = db
        .query(
          "UPDATE jobs SET status = 'queued', claimed_at = NULL, lease_until = NULL, attempts = MAX(attempts - 1, 0) WHERE id = ? AND claimed_at = ? AND status = 'running'",
        )
        .run(id, claim.claimedAt);
      if (r.changes > 0) returned++;
    } catch (e) {
      console.error(`[shutdown] return job ${id} failed: ${String((e as Error).message).slice(0, 200)}`);
    }
    liveClaims.delete(id);
  }
  return returned;
}

/**
 * Итог одного тика цикла воркера. Цикл берет одну job за раз, ошибки его не
 * останавливают, лиз продлевается каждые leaseMs/3. Роли процесса: web — сервер +
 * воркер полосы user; rating — планировщик + воркер полосы rating (ночная волна);
 * all — обе полосы в одном процессе. Фоновый пересчет истории крутит только роль
 * rating, чтобы web оставался отзывчивым.
 */
export type WorkerTickOutcome = "busy" | "idle" | "claim-failed" | "done" | "failed";

/** Состояние цикла воркера между тиками (флаг «занят»); хранится снаружи, чтобы тесты могли его видеть. */
export interface WorkerLoopState {
  busy: boolean;
  /** когда взято текущее задание (мс); нет — задания нет */
  currentSince?: number;
  /** время последней порции фонового пересчета при занятой очереди */
  lastBackgroundTickAt?: number;
}

/** Фоновый пересчет при непустых очередях — одна порция раз в 10 мин. */
export const BACKGROUND_RESCORE_CADENCE_MS = 10 * 60_000;

/** Один шаг фонового пересчета: сначала отставший курсор текущего прохода, затем история. */
function backgroundRescoreStep(deps: WorkerDeps): void {
  try {
    const healed = needsRescore(deps.db) ? rescoreBatchByCursor(deps.db, { log: (m) => console.log(`[worker] ${m}`) }).processed : 0;
    if (healed === 0) rescoreHistoryBatch(deps.db, { log: (m) => console.log(`[worker] ${m}`) });
  } catch (e) {
    console.error(`[worker] background rescore failed: ${String((e as Error).message).slice(0, 200)}`);
  }
}

/**
 * Один тик цикла воркера — отдельная функция, чтобы тесты вызывали ее без таймера.
 * claim, фоновый пересчет, исполнение и продление лиза — в try/catch: исключение
 * наружу не выходит, цикл жив.
 * Фоновый пересчет идет и при непустой очереди — одна порция раз в 10 мин, до
 * проверки «занят», чтобы длинная волна сканов не оставляла курсоры пересчета стоять.
 */
export async function workerTick(
  deps: WorkerDeps,
  order: Array<"user" | "rating">,
  state: WorkerLoopState,
  opts: { historyRescore?: boolean; kind?: JobKind; perUserExclusive?: boolean; lightOnly?: boolean } = {},
): Promise<WorkerTickOutcome> {
  const dueBackground =
    opts.historyRescore === true && (state.lastBackgroundTickAt === undefined || Date.now() - state.lastBackgroundTickAt >= BACKGROUND_RESCORE_CADENCE_MS);
  if (dueBackground) {
    state.lastBackgroundTickAt = Date.now();
    backgroundRescoreStep(deps);
  }
  if (state.busy) return "busy";
  const leaseMs = deps.config.scheduler.leaseMs;
  // исключение БД не должно ронять процесс
  let job: ClaimedJob | null = null;
  try {
    job = (deps.claimAny ?? claimAny)(deps.db, order, new Date(), leaseMs, {
      maxAttempts: deps.config.queue.maxAttempts,
      kind: opts.kind,
      perUserExclusive: opts.perUserExclusive,
      lightOnly: opts.lightOnly,
      heavyMs: deps.config.queue.heavyScanMs,
    });
  } catch (e) {
    console.error(`[worker] claim failed: ${String((e as Error).message).slice(0, 200)}`);
    return "claim-failed";
  }
  if (!job) {
    // очереди пусты — порция фонового пересчета на каждом тике
    if (opts.historyRescore) {
      backgroundRescoreStep(deps);
      state.lastBackgroundTickAt = Date.now();
    }
    return "idle";
  }
  const claimed = job;
  state.busy = true;
  state.currentSince = Date.now();
  liveClaims.set(claimed.id, { claimedAt: claimed.claimedAt, repoId: claimed.repoId, userId: claimed.userId, kind: claimed.kind });
  // продление каждые leaseMs/3 с повтором при SQLITE_BUSY: при лизе 10 мин
  // три пропуска подряд — и живой скан перехватит другой воркер
  const heartbeat = setInterval(() => {
    void withBusyRetry(() => renewLease(deps.db, claimed.id, claimed.claimedAt, leaseMs), `job ${claimed.id} lease renew`).catch((e) =>
      console.error(`[worker] job ${claimed.id} lease renew failed: ${String((e as Error).message).slice(0, 200)}`),
    );
  }, Math.max(1, Math.floor(leaseMs / 3)));
  try {
    let failure: string | null;
    if (claimed.kind === "summary") {
      failure = await processSummaryJob(deps, claimed);
    } else if (claimed.kind === "check") {
      failure = await processCheckJob(deps, claimed);
    } else {
      const result = await processJob(deps, claimed);
      // причина падения — в jobs.error, панель заданий показывает ее дословно
      failure =
        result === "gone"
          ? JOB_ERRORS.gone
          : result === "no-pat"
            ? JOB_ERRORS.noPat
            : result.scoreFailed === true
              ? JOB_ERRORS.scoreFailed
              : result.status === "bad"
                ? JOB_ERRORS.channels(failedChannelsOf(result.channels))
                : null;
    }
    // итог задания пишется с повтором при SQLITE_BUSY: иначе готовый скан оставил бы
    // задание `running` до конца лиза, а повторный прогон сжег бы попытку
    await withBusyRetry(
      // «текст уже был» — done с пометкой: лимит такую заявку не списывает
      () => finishJob(deps.db, claimed.id, claimed.claimedAt, failure === null || failure === AI_CACHED_NOTE ? "done" : "failed", failure ?? undefined),
      `job ${claimed.id} finish`,
    );
    return failure === null || failure === AI_CACHED_NOTE ? "done" : "failed";
  } catch (e) {
    console.error(`[worker] job ${claimed.id} (${claimed.slug}) crashed: ${String((e as Error).message).slice(0, 200)}`);
    try {
      await withBusyRetry(() => finishJob(deps.db, claimed.id, claimed.claimedAt, "failed", JOB_ERRORS.internal), `job ${claimed.id} finish`);
    } catch (finishError) {
      console.error(`[worker] job ${claimed.id} finish failed: ${String((finishError as Error).message).slice(0, 200)}`);
    }
    return "failed";
  } finally {
    liveClaims.delete(claimed.id);
    clearInterval(heartbeat);
    state.busy = false;
    state.currentSince = undefined;
  }
}

/** Тик считается живым, если он не `busy` или текущее задание еще в пределах худшего бюджета скана. */
export function loopTickIsAlive(outcome: WorkerTickOutcome, state: WorkerLoopState, config: Config, now = Date.now()): boolean {
  if (outcome !== "busy") return true;
  return state.currentSince !== undefined && now - state.currentSince <= worstCaseScanMs(config.scan);
}

export function startWorkerLoop(
  deps: WorkerDeps,
  queues: { user?: boolean; rating?: boolean },
  pollMs = 5000,
  seams: { tick?: typeof workerTick } = {},
  // цикл одного рода; метки живости пишет только цикл сканов своей полосы
  only: { kind?: JobKind; perUserExclusive?: boolean; lightOnly?: boolean; historyRescore?: boolean; tickMarks?: boolean } = {},
): () => void {
  const order: Array<"user" | "rating"> = queues.user && queues.rating ? ["user", "rating"] : queues.user ? ["user"] : queues.rating ? ["rating"] : [];
  if (order.length === 0) return () => {};
  const state: WorkerLoopState = { busy: false };
  const tick = seams.tick ?? workerTick;
  const historyRescore = only.historyRescore ?? queues.rating === true;
  const tickMarks = only.tickMarks ?? true;
  const timer = setInterval(() => {
    // try/catch и на уровне таймера: синхронное исключение внутри тика не должно
    // ронять процесс
    try {
      void tick(deps, order, state, { historyRescore, kind: only.kind, perUserExclusive: only.perUserExclusive, lightOnly: only.lightOnly })
        .then((outcome) => {
          if (!tickMarks) return;
          // у каждой полосы своя метка живого тика — иначе живой web-процесс
          // маскировал бы мертвую rating-роль. `busy` сам по себе не признак жизни:
          // метка пишется, только пока задание не вышло за худший бюджет скана
          if (!loopTickIsAlive(outcome, state, deps.config)) return;
          const at = new Date().toISOString();
          if (queues.rating) setMetaValue(deps.db, SCHED_META.tickAt, at);
          if (queues.user) setMetaValue(deps.db, SCHED_META.userTickAt, at);
        })
        .catch((e) => console.error(`[worker] tick failed: ${String((e as Error).message).slice(0, 200)}`));
    } catch (e) {
      console.error(`[worker] tick failed: ${String((e as Error).message).slice(0, 200)}`);
    }
  }, pollMs);
  return () => clearInterval(timer);
}

/**
 * Рабочие циклы процесса: у каждой пары «полоса роли × род заявки» свой цикл со своим
 * состоянием. Пользовательские запросы не должны ждать ничего постороннего: плановая
 * волна не держит пользователей, скан не держит обзор, а тяжелый репо (до ~90 мин)
 * одного пользователя занимает только один слот из `userScanSlots`. Claim атомарен
 * (одна инструкция UPDATE), поэтому параллельные циклы одной полосы не возьмут заявку дважды.
 */
export interface WorkerLoopSpec {
  lane: "user" | "rating";
  kind: JobKind;
  /** параллельных циклов (у каждого свое состояние «занят») */
  slots: number;
  /** сколько первых слотов берут и тяжелые репо; остальные — только легкие */
  heavySlots: number;
  pollMs: number;
  /** приоритет, а не запрет (только полоса user): заявка автора, у которого уже идет
   *  заявка этого рода, встает после чужих, но свободный слот не простаивает */
  perUserExclusive: boolean;
  /** фоновый пересчет истории — только цикл сканов рейтинга */
  historyRescore: boolean;
  /** метка живого тика полосы для health — только циклы сканов */
  tickMarks: boolean;
}

export function workerLoopPlan(role: Config["processRole"], queue: Config["queue"]): WorkerLoopSpec[] {
  const lanes: Array<"user" | "rating"> = role === "web" ? ["user"] : role === "rating" ? ["rating"] : ["user", "rating"];
  const plan: WorkerLoopSpec[] = [];
  for (const lane of lanes) {
    const user = lane === "user";
    // тяжелый репо (клон и разбор до ~90 мин) берет только первый слот рода — два тяжелых
    // репо двух людей не займут все слоты; в полосе рейтинга слот один и берет все
    plan.push({ lane, kind: "scan", slots: user ? loopSlots(queue.userScanSlots) : 1, heavySlots: 1, pollMs: 5000, perUserExclusive: user, historyRescore: !user, tickMarks: true });
    plan.push({ lane, kind: "summary", slots: user ? loopSlots(queue.userAiSlots) : 1, heavySlots: 1, pollMs: 5000, perUserExclusive: user, historyRescore: false, tickMarks: false });
    // проверка — секунды без клона: одного цикла на полосу хватает
    plan.push({ lane, kind: "check", slots: 1, heavySlots: 1, pollMs: 2000, perUserExclusive: false, historyRescore: false, tickMarks: false });
  }
  return plan;
}

/** Запустить циклы плана; возвращает одну остановку на все. */
export function startWorkerLoops(deps: WorkerDeps, plan: WorkerLoopSpec[], seams: { tick?: typeof workerTick } = {}): () => void {
  const stops: Array<() => void> = [];
  for (const spec of plan) {
    for (let i = 0; i < spec.slots; i++) {
      stops.push(
        startWorkerLoop(deps, { [spec.lane]: true }, spec.pollMs, seams, {
          kind: spec.kind,
          perUserExclusive: spec.perUserExclusive,
          lightOnly: i >= spec.heavySlots,
          historyRescore: spec.historyRescore,
          tickMarks: spec.tickMarks,
        }),
      );
    }
  }
  return () => {
    for (const stop of stops) stop();
  };
}

/** Строка для лога старта: какие циклы подняты и сколько слотов. */
export function workerLoopSummary(plan: WorkerLoopSpec[]): string {
  return plan.map((s) => `${s.lane}/${s.kind}×${s.slots}`).join(", ");
}

/**
 * Возраст, начиная с которого каталог клона считается осиротевшим. Живой скан держит
 * клон все время работы, поэтому порог — худшая длительность скана (`worstCaseScanMs`,
 * ~91 мин на дефолтах), а не лиз: меньший порог сносил бы каталог из-под работающего
 * git, в том числе у соседнего процесса.
 */
export function orphanCloneAgeMs(config: Config): number {
  return worstCaseScanMs(config.scan);
}

/** Уборка осиротевших rh-clone-*: клоны процессов, убитых падением или OOM, иначе копились бы в tmp до ENOSPC. */
export async function sweepOrphanClones(dir: string = tmpdir(), olderThanMs = 60 * 60_000): Promise<number> {
  let removed = 0;
  try {
    const entries = Array.from(new Bun.Glob("rh-clone-*").scanSync({ cwd: dir, onlyFiles: false }));
    const cutoff = Date.now() - olderThanMs;
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* гонка с параллельным удалением — не страшно */
      }
    }
  } catch {
    /* tmp не читается — молча */
  }
  if (removed > 0) console.log(`[sweep] удалено осиротевших клонов: ${removed}`);
  return removed;
}

/**
 * Осиротевшие `running`-сканы (не путать с уборкой каталогов клонов). Процесс,
 * начавший скан, умер, а строка `scans` осталась `running` навсегда. Сирота —
 * `running` старше лиза без живой job того же (репо, автор) с непросроченным лизом.
 * `user_id IS scans.user_id`: в SQLite `IS` сравнивает и NULL, поэтому
 * периодический скан не прикрывается пользовательской job.
 * Закрывается как `bad` с `status_detail='orphaned'` — причина отделена от
 * настоящего провала сбора.
 */
export function sweepOrphanScans(db: Database, opts: { leaseMs: number; now?: Date }): number[] {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - opts.leaseMs).toISOString();
  const rows = db
    .query(
      `UPDATE scans SET status = 'bad', public_status = 'bad', finished_at = ?, status_detail = 'orphaned'
       WHERE status = 'running' AND started_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.status IN ('queued', 'running')
             AND j.repo_id = scans.repo_id
             AND j.user_id IS scans.user_id
             AND j.lease_until >= ?
         )
       RETURNING id`,
    )
    .all(nowIso, cutoff, nowIso) as { id: number }[];
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) console.log(`[sweep] осиротевших сканов закрыто: ${ids.length}`);
  return ids;
}

/** Минимальный срок хранения AI-заявок при любом ретеншене — окно учета лимитов. */
const AI_JOBS_KEEP_MS = 2 * 24 * 3600_000;

/**
 * Очистка завершенных строк `jobs` старше `Config.queue.retentionDays`. Строки очереди
 * транзитны (данные скана живут в `scans`/`facts`/`scores`), а растут линейно от волн —
 * десятки миллионов строк в год в той же БД, что обслуживает рейтинг.
 * `queued`/`running` не трогаются никогда; строки без `created_at` (старые) — тоже:
 * их возраст неизвестен, а гадать по id нельзя.
 */
export function purgeOldJobs(db: Database, opts: { retentionDays: number; now?: Date }): number {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60_000).toISOString();
  // AI-заявки — это учет лимитов (час и сутки МСК): моложе 2 суток они не удаляются,
  // иначе QUEUE_RETENTION_DAYS=0 обнулял бы лимиты
  const aiKeep = new Date(now.getTime() - AI_JOBS_KEEP_MS).toISOString();
  const r = db
    .query(
      "DELETE FROM jobs WHERE status IN ('done', 'failed', 'refused') AND created_at IS NOT NULL AND created_at < ? AND (kind = 'scan' OR created_at < ?)",
    )
    .run(cutoff, aiKeep);
  if (r.changes > 0) console.log(`[sweep] удалено завершённых job старше ${opts.retentionDays} дней: ${r.changes}`);
  return r.changes;
}

/**
 * Тик обслуживания: сироты-сканы, ретеншен `jobs` и снимков рейтинга, уборка
 * каталогов клонов, авто-AI топа. Каждый шаг в try/catch — таймер остается жив.
 */
export async function maintenanceTick(
  db: Database,
  config: Config,
  opts: { now?: Date; cloneDir?: string } = {},
): Promise<{ scans: number; jobs: number; clones: number; snapshots: number }> {
  const out = { scans: 0, jobs: 0, clones: 0, snapshots: 0 };
  const now = opts.now ?? new Date();
  try {
    out.scans = sweepOrphanScans(db, { leaseMs: config.scheduler.leaseMs, now }).length;
  } catch (e) {
    console.error(`[sweep] orphan scans failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  try {
    out.jobs = purgeOldJobs(db, { retentionDays: config.queue.retentionDays, now });
  } catch (e) {
    console.error(`[sweep] jobs retention failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  try {
    out.snapshots = purgeOldRatingSnapshots(db, { now });
  } catch (e) {
    console.error(`[sweep] rating snapshots retention failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  try {
    out.clones = await sweepOrphanClones(opts.cloneDir, orphanCloneAgeMs(config));
  } catch (e) {
    console.error(`[sweep] orphan clones failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  try {
    const top = topAutoTick(db, config, now);
    if (top.summaries + top.checks > 0) console.log(`[top-auto] queued: ${top.summaries} overviews, ${top.checks} checks`);
  } catch (e) {
    console.error(`[top-auto] failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  return out;
}

const TOP_AUTO_INTERVAL_MS = 24 * 3600_000;

/**
 * Автоматический публичный обзор и проверка на накрутку для топа рейтинга, за
 * переключателем AI_TOP_AUTO (по умолчанию выключен). На каждом такте обслуживания
 * репо топа, у которого последний завершенный скан без публичного обзора (или без
 * проверки), нет живой заявки этого рода и прошлая авто-заявка старше суток,
 * получает заявку в полосе рейтинга (user_id NULL — пользовательские лимиты ее не
 * считают). Такт, а не хук скана: после включения топ получает тексты сразу, не
 * дожидаясь пересканирования.
 */
export function topAutoTick(db: Database, config: Pick<Config, "ai">, now: Date = new Date()): { summaries: number; checks: number } {
  const out = { summaries: 0, checks: 0 };
  if (!config.ai.topAuto) return out;
  const size = config.ai.topAutoSize;
  const top = listRepos(db, { sort: "index", order: "desc", page: 1, perPage: size }).items.filter((i) => i.rank !== null && i.rank <= size);
  // проверка «заявки нет» и вставка — одной транзакцией: такт идет в нескольких
  // ролях процесса, и без нее возможны дубли
  return db.transaction(() => topAutoEnqueue(db, top, now, out)).immediate();
}

function topAutoEnqueue(db: Database, top: { org: string; repo: string }[], now: Date, out: { summaries: number; checks: number }): { summaries: number; checks: number } {
  const since = new Date(now.getTime() - TOP_AUTO_INTERVAL_MS).toISOString();
  for (const item of top) {
    const repo = db.query("SELECT id FROM repos WHERE org_slug = ? AND repo_slug = ?").get(item.org, item.repo) as { id: number } | null;
    if (repo === null) continue;
    const scanId = lastFinishedScan(db, repo.id);
    if (scanId === null) continue;
    const want = (kind: "summary" | "check"): boolean => {
      const notes =
        kind === "summary"
          ? db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role != 'flagger' AND audience = 'public' LIMIT 1").get(scanId)
          : db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role = 'flagger' LIMIT 1").get(scanId);
      if (notes !== null) return false;
      const live = db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = ? AND status IN ('queued', 'running') LIMIT 1").get(repo.id, kind);
      if (live !== null) return false;
      const recent = db
        .query("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = ? AND user_id IS NULL AND created_at > ? LIMIT 1")
        .get(repo.id, kind, since);
      return recent === null;
    };
    const insert = db.query(
      "INSERT INTO jobs (repo_id, status, user_id, trigger_kind, kind, created_at, audience) VALUES (?, 'queued', NULL, 'periodic', ?, ?, 'public')",
    );
    if (want("summary")) {
      insert.run(repo.id, "summary", now.toISOString());
      out.summaries++;
    }
    if (want("check")) {
      insert.run(repo.id, "check", now.toISOString());
      out.checks++;
    }
  }
  return out;
}

/** Состояние тика каталога: защита от повторного входа и отметки последнего выполнения фаз. */
export interface CatalogTickState {
  walking: boolean;
  /** время последней успешной сверки (каталог дочитан) */
  lastReconcileAt: Date | null;
  /** время последней успешной ночной фазы */
  lastNightlyAt: Date | null;
}

export function newCatalogTickState(): CatalogTickState {
  return { walking: false, lastReconcileAt: null, lastNightlyAt: null };
}

/** Время из meta (ISO) или null; метка из будущего (сбитые часы) не принимается. */
function metaDate(db: Database, key: string, now: Date): Date | null {
  const raw = getMetaValue(db, key);
  if (raw === null) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now.getTime() + 5 * 60_000) return null;
  return new Date(t);
}

/** Заполнить пустые отметки состояния из meta — так они переживают рестарт процесса. */
export function loadPhaseMarks(db: Database, state: CatalogTickState, now = new Date()): void {
  if (state.lastReconcileAt === null) state.lastReconcileAt = metaDate(db, SCHED_META.reconcileAt, now);
  if (state.lastNightlyAt === null) state.lastNightlyAt = metaDate(db, SCHED_META.nightlyOkAt, now);
}

/** Ошибка сверки — в meta для health; стирает ее только дочитанная сверка. */
function recordReconcileError(db: Database, error: string, now: Date): void {
  setMetaValue(db, SCHED_META.reconcileError, error.slice(0, 200));
  setMetaValue(db, SCHED_META.reconcileErrorAt, now.toISOString());
}

/** Бюджет запросов клиента на один обход: потолок страниц + 10 про запас. */
export function catalogClientBudget(config: Config): number {
  return config.scan.catalog.maxPages + 10;
}

/**
 * Тик каталога: одно перечисление на обе фазы. Каталог обходится один раз, если
 * пришел срок хотя бы одной фазы; сверка выполняется всегда, ночная фаза
 * добавляется к тому же обходу, когда пришел ее срок.
 * Недочитанный или ошибочный обход не эвиктит и не двигает отметку сверки.
 * Ночная отметка двигается, если обход прошел, даже при неполном каталоге:
 * иначе суточная волна выродилась бы в часовую, пока каталог не дочитывается.
 * Эвикция — единственное опасное действие на неполном снимке — только по дочитанному.
 * Конкурирующих обходов нет: одна защита на обе фазы, один клиент на обход.
 */
export async function catalogTick(
  db: Database,
  serverClient: () => ScClient | null,
  config: Config,
  state: CatalogTickState,
  opts: { now?: Date } = {},
): Promise<NightlyResult | null> {
  // проверка до try: внутри нее `finally` снял бы флаг чужого обхода, и
  // пропущенный тик открыл бы дорогу параллельному обходу
  if (state.walking) {
    console.warn("[scheduler] предыдущий обход ещё жив — запуск пропущен (ПОРТ S2)");
    return null;
  }
  const now = opts.now ?? new Date();
  // отметки успеха фаз переживают рестарт: на первом тике процесса они берутся
  // из meta. Ночная — из отдельного ключа успеха (`sched_last_nightly_at` — это попытка)
  loadPhaseMarks(db, state, now);
  const due = (last: Date | null, everyMs: number) => last === null || now.getTime() - last.getTime() >= everyMs;
  const reconcileDue = due(state.lastReconcileAt, config.scheduler.catalogIntervalMs);
  const nightlyDue = due(state.lastNightlyAt, config.scheduler.intervalMs);
  if (!reconcileDue && !nightlyDue) return null;
  // новый клиент (и бюджет запросов) на каждый обход
  const client = serverClient();
  if (!client) {
    // без серверного токена каталог не читается — отметка для health
    setMetaValue(db, SCHED_META.noTokenAt, now.toISOString());
    return null;
  }
  if (getMetaValue(db, SCHED_META.noTokenAt) !== null) db.query("DELETE FROM meta WHERE key = ?").run(SCHED_META.noTokenAt);
  state.walking = true;
  try {
    // снимок мест «итог суток» — в ночной фазе до обхода: nightlyCatalog эвиктит
    // исчезнувшие репо и ставит новую волну, а снимок фиксирует места до них.
    // Идемпотентно по UTC-дате; сбой снимка обход не валит. Пока идет пересчет
    // после смены модели, снимок откладывается до следующего обхода в те же сутки
    {
      try {
        const snap = snapshotAtCatalogTick(db, { now, nightlyDue });
        if (snap.taken) console.log(`[rating] snapshot ${snap.day}: ${snap.rows} rows`);
        else if ("deferred" in snap && snap.deferred === "rescore") console.log(`[rating] snapshot ${snap.day} deferred: rescore after model change in progress`);
      } catch (e) {
        console.error(`[rating] snapshot failed: ${String((e as Error).message).slice(0, 200)}`);
      }
    }
    // сверка выполняется на каждом обходе: каталог все равно перечислен
    const result = await nightlyCatalog(db, client, {
      maxPages: config.scan.catalog.maxPages,
      fullRescan: config.scheduler.fullRescan,
      now,
      phases: { reconcile: true, nightly: nightlyDue },
    });
    // ночной статус для health обновляют только обходы с ночной фазой. Пишется в
    // meta, потому что web-роль читает его из другого процесса
    if (nightlyDue) {
      setMetaValue(db, SCHED_META.nightlyAt, now.toISOString());
      setMetaValue(db, SCHED_META.nightlyOk, result.ok ? "1" : "0");
      if (result.ok) {
        db.query("DELETE FROM meta WHERE key = ?").run(SCHED_META.nightlyError);
      } else {
        setMetaValue(db, SCHED_META.nightlyError, (result.error ?? "catalog walk failed").slice(0, 200));
      }
    }
    if (!result.ok) {
      console.error(`[scheduler] catalog walk failed: ${result.error ?? "unknown"}`);
      // health судит по этой ошибке и по возрасту последней успешной сверки
      recordReconcileError(db, result.error ?? "catalog walk failed", now);
      return result;
    }
    if (result.catalogComplete) {
      state.lastReconcileAt = now;
      setMetaValue(db, SCHED_META.reconcileAt, now.toISOString());
      db.query("DELETE FROM meta WHERE key IN (?, ?)").run(SCHED_META.reconcileError, SCHED_META.reconcileErrorAt);
    } else {
      recordReconcileError(db, "catalog incomplete: page cap reached", now);
    }
    // ночная отметка — по выполнению фазы (обход ok), а не по полноте каталога;
    // отметка сверки выше — только по дочитанному
    if (nightlyDue && result.ok) {
      state.lastNightlyAt = now;
      setMetaValue(db, SCHED_META.nightlyOkAt, now.toISOString());
    }
    console.log(
      `[scheduler] catalog: ${result.pages} pages, ${result.entriesSeen} repos; phases reconcile+${nightlyDue ? "nightly" : "-"}; queued ${result.enqueued.length} (${result.enqueued.filter((e) => e.reason === "new").length} new), evicted ${result.evicted.length}, returned ${result.returned.length}${result.catalogComplete ? "" : "; catalog INCOMPLETE - eviction skipped, reconcile mark kept"}`,
    );
    return result;
  } catch (e) {
    console.error(`[scheduler] crashed: ${String((e as Error).message).slice(0, 200)}`);
    return null;
  } finally {
    state.walking = false;
  }
}

/**
 * Обертка колбэка таймера, как у цикла воркера: синхронное исключение и отказ
 * промиса логируются, таймер продолжает работать. Экспортирована для теста без
 * ожидания часового интервала.
 */
export function armoredTimerCallback(label: string, fn: () => Promise<unknown> | void): () => void {
  return () => {
    try {
      const out = fn();
      if (out !== undefined && typeof (out as Promise<unknown>).catch === "function") {
        void (out as Promise<unknown>).catch((e) => console.error(`[${label}] tick failed: ${String((e as Error).message).slice(0, 200)}`));
      }
    } catch (e) {
      console.error(`[${label}] tick failed: ${String((e as Error).message).slice(0, 200)}`);
    }
  };
}

/**
 * Планировщик обхода каталога. Первый обход — через startDelayMs: обход с живым
 * токеном ставит в очередь сканы всего каталога, и у оператора должно быть время
 * это увидеть и при необходимости отключить.
 */
export function startScheduler(
  db: Database,
  serverClient: () => ScClient | null,
  config: Config,
  seams: { tick?: typeof catalogTick; maintenance?: typeof maintenanceTick } = {},
): () => void {
  // отметки пусты — первый тик считает, что срок пришел у обеих фаз
  const state = newCatalogTickState();
  const tick = seams.tick ?? catalogTick;
  const maintenance = seams.maintenance ?? maintenanceTick;
  const run = armoredTimerCallback("scheduler", () => tick(db, serverClient, config, state));
  const first = setTimeout(run, config.scheduler.startDelayMs);
  // тик вызывается с периодом более частой фазы; какая фаза выполнится, решают
  // отметки внутри тика, а не расписание таймера
  const timer = setInterval(run, Math.max(1, Math.min(config.scheduler.catalogIntervalMs, config.scheduler.intervalMs)));
  const stopMaintenance = startMaintenance(db, config, { maintenance });
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    stopMaintenance();
  };
}

/**
 * Часовое обслуживание (см. maintenanceTick). Запускается в любой роли: без него
 * роль web показывала бы скан-сироту «Сканируется» до своего рестарта. Уборка
 * идемпотентна, конкурирующие роли друг другу не мешают.
 */
export function startMaintenance(db: Database, config: Config, seams: { maintenance?: typeof maintenanceTick; periodMs?: number } = {}): () => void {
  const maintenance = seams.maintenance ?? maintenanceTick;
  const timer = setInterval(armoredTimerCallback("sweep", () => maintenance(db, config)), seams.periodMs ?? 60 * 60_000);
  return () => clearInterval(timer);
}
