// scheduler.ts — периодика В4/Б3: claim-loop по jobs, ночной обход
// каталога (источник диффа last_updated и эвикции), форс-полный тогл,
// эвикция ТОЛЬКО по repo-уровневым сигналам (Q&A №16). Расписание =
// конфигурация (ТЗ §6): интервал Config.scheduler.intervalMs (сутки
// по умолчанию), форс SCHEDULER_FULL_RESCAN, потолок страниц
// Config.scan.catalog.maxPages. Инкрементальность: в очередь ставятся
// только изменившиеся (last_updated ≠ repos.last_activity_at) и новые
// репо — «умный рескан» 17.09. NULL-lease матчится (SQLite NULL<now
// ложно — потому IS NULL OR). Воркер-луп живёт в процессе сервера,
// одну job за раз (tmp-диск стенда конечен); лиз истёк → job снова
// доступен (упавший воркер не блокирует очередь).
// В4.1 (К3): режима у job нет — автор (user_id) определяет токен скана;
// эвикция только у задач без автора (периодика, серверный токен);
// серверный REST-клиент — фабрика: новый бюджет на каждую задачу и на
// каждый ночной обход (H2).
import type { Database } from "bun:sqlite";
import { enumerateCatalog, type CatalogResult } from "../collectors/catalog";
import type { ScClient } from "../collectors/http";
import { upsertRepo, runScan, scanCloneLimitsOf, type ScanResult } from "./runner";
import { getPat } from "../auth/pat";
import { makeScClient } from "../collectors/http";
import { makeAppsecClient } from "../collectors/appsec";
import type { Config } from "../config";

export interface ClaimedJob {
  id: number;
  repoId: number;
  slug: string;
  /** автор заявки; null = периодика (серверный токен) */
  userId: number | null;
  triggerKind: string;
  /** метка заявки: продление лиза и finishJob — только своей заявки (К4) */
  claimedAt: string;
  /** номер попытки (после инкремента при claim) */
  attempts: number;
}

/** Активная (queued/running) заявка юзера на репо — для дедупа (К4). */
export function findActiveUserJob(db: Database, userId: number, repoId: number): number | null {
  const row = db
    .query("SELECT id FROM jobs WHERE user_id = ? AND repo_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1")
    .get(userId, repoId) as { id: number } | null;
  return row ? row.id : null;
}

/**
 * Отказанная предпроверка доступа (repo-GET 403/404 по PAT, Ф1.6): строка jobs
 * со status='refused' — воркером не заявляется (claimNext берёт только
 * queued/running), но учитывается лимитом частоты. repo_id = 0: строка
 * repos по отказу не создаётся (К3), а NOT NULL колонки требует значения
 * (FK в SQLite не включены); ночной обход по repo_id её не видит.
 */
export function recordRefusedUserJob(db: Database, userId: number, now = new Date()): number {
  const r = db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at) VALUES (0, 'refused', ?, 'user', ?)")
    .run(userId, now.toISOString());
  return Number(r.lastInsertRowid);
}

/** Активных (queued/running) юзерских заявок юзера — предел Config.queue.userActiveMax (Ф1.7). */
export function countActiveUserJobs(db: Database, userId: number): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')").get(userId) as { c: number }
  ).c;
}

/** Новых юзерских заявок за скользящий час, включая отказанные предпроверки (дубли строк не создают — не считаются). */
export function countRecentUserJobs(db: Database, userId: number, now = new Date()): number {
  const since = new Date(now.getTime() - 3600_000).toISOString();
  return (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND trigger_kind = 'user' AND created_at > ?").get(userId, since) as {
      c: number;
    }
  ).c;
}

/**
 * Постановка скана в очередь (jobs без UNIQUE с v1.4). Заявка юзера (К4):
 * при активной queued/running заявке того же (user, repo) новая не
 * создаётся — возвращается id существующей.
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

export interface ClaimOptions {
  /** предел попыток (Config.queue.maxAttempts): достигнут → failed, не заявляется */
  maxAttempts?: number;
}

/**
 * Заявить одну job: атомарный UPDATE … WHERE (lease_until IS NULL OR
 * lease_until < now) — NULL-lease обязан матчиться (контракт плана);
 * истёкший лиз running-строки тоже матчится (упавший воркер).
 * К4: attempts +1 при claim; исчерпавшие попытки → failed. Чередование:
 * если последняя заявленная (по claimed_at) была юзерской, а в очереди
 * есть периодическая — берётся периодическая; иначе юзерские вперёд.
 * В4.1-fix (Ф1.7): внутри юзерской половины — круговой порядок между
 * юзерами: сперва юзеры без единой заявленной job, затем по давности их
 * последней заявки (MAX claimed_at ASC), затем id. Ф1.12: job без строки
 * repos → failed (попытки не сжигаются по истечении лиза), берётся следующая.
 */
export function claimNext(db: Database, now = new Date(), leaseMs = 60 * 60_000, opts: ClaimOptions = {}): ClaimedJob | null {
  const maxAttempts = opts.maxAttempts ?? 3;
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + leaseMs).toISOString();
  db.query(
    `UPDATE jobs SET status = 'failed', lease_until = NULL
     WHERE status IN ('queued', 'running') AND attempts >= ? AND (lease_until IS NULL OR lease_until < ?)`,
  ).run(maxAttempts, nowIso);
  const last = db
    .query("SELECT trigger_kind FROM jobs WHERE claimed_at IS NOT NULL ORDER BY claimed_at DESC, id DESC LIMIT 1")
    .get() as { trigger_kind: string } | null;
  const first = last?.trigger_kind === "user" ? "periodic" : "user";
  const claimStmt = db.query(
      `UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE (lease_until IS NULL OR lease_until < ?)
           AND status IN ('queued', 'running')
           AND attempts < ?
         ORDER BY CASE trigger_kind WHEN ? THEN 0 ELSE 1 END,
                  (SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id) IS NOT NULL,
                  (SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id) ASC,
                  id
         LIMIT 1
       )
       RETURNING id, repo_id, user_id, trigger_kind, claimed_at, attempts`,
  );
  // предохранитель цикла: каждая итерация переводит одну job в running или failed
  for (let guard = 0; guard < 1000; guard++) {
    const claimed = claimStmt.get(nowIso, leaseIso, nowIso, maxAttempts, first) as {
      id: number;
      repo_id: number;
      user_id: number | null;
      trigger_kind: string;
      claimed_at: string;
      attempts: number;
    } | null;
    if (!claimed) return null;
    const repo = db.query("SELECT org_slug, repo_slug FROM repos WHERE id = ?").get(claimed.repo_id) as
      | { org_slug: string; repo_slug: string }
      | null;
    if (!repo) {
      db.query("UPDATE jobs SET status = 'failed', lease_until = NULL WHERE id = ?").run(claimed.id);
      continue;
    }
    return {
    id: claimed.id,
    repoId: claimed.repo_id,
    slug: `${repo.org_slug}/${repo.repo_slug}`,
    userId: claimed.user_id,
    triggerKind: claimed.trigger_kind,
    claimedAt: claimed.claimed_at,
    attempts: claimed.attempts,
  };
  }
  return null;
}

/** Продление лиза своей заявки (К4): чужой/перезаявленный claimed_at — no-op. */
export function renewLease(db: Database, jobId: number, claimedAt: string, leaseMs: number, now = new Date()): boolean {
  const r = db
    .query("UPDATE jobs SET lease_until = ? WHERE id = ? AND claimed_at = ? AND status = 'running'")
    .run(new Date(now.getTime() + leaseMs).toISOString(), jobId, claimedAt);
  return r.changes > 0;
}

/**
 * Завершение job (К4): только своей заявки — WHERE id AND claimed_at;
 * воркер с истёкшим лизом, чью job перезаявили, чужой прогон не закрывает.
 */
export function finishJob(db: Database, jobId: number, claimedAt: string, status: "done" | "failed"): boolean {
  const r = db.query("UPDATE jobs SET status = ?, lease_until = NULL WHERE id = ? AND claimed_at = ?").run(status, jobId, claimedAt);
  return r.changes > 0;
}

// ---------- эвикция (Q&A №16) ----------

/** repo-уровневый сигнал (repo-GET 404/403, исчезновение из каталога). */
export function evictRepo(db: Database, repoId: number, reason: string): void {
  db.query("UPDATE repos SET rating_active = 0, evict_reason = ? WHERE id = ?").run(reason, repoId);
}

/** Возврат флагом (закон 6: не удаляем) — репо снова в рейтинге. */
export function returnRepo(db: Database, repoId: number): void {
  db.query("UPDATE repos SET rating_active = 1, evict_reason = NULL WHERE id = ?").run(repoId);
}

// ---------- ночной обход каталога ----------

export interface NightlyEnqueued {
  slug: string;
  /** retry-ineligible — последний завершённый периодический скан непригоден для рейтинга (С3, круг 2) */
  reason: "new" | "changed" | "forced" | "retry-failed" | "retry-ineligible";
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
  error?: string;
}

export interface NightlyOptions {
  maxPages?: number;
  fullRescan?: boolean;
  now?: Date;
}

/**
 * Полный обход каталога: дифф last_updated → очередь изменившихся,
 * постановка новых, эвикция исчезнувших (только public-строки нашей
 * таблицы; приватные own-репо в публичном каталоге и не ждутся).
 * Второй прогон при неизменном каталоге не ставит в очередь ничего —
 * приёмочный инвариант Б6.
 * В4.1-fix круг 2 (С3, LOW-8): retry-failed — только по последней
 * ПЕРИОДИЧЕСКОЙ job (юзерская не навязывает и не маскирует перескан);
 * последний завершённый периодический скан непригоден → перескан
 * (retry-ineligible), не чаще раза за обход.
 */
export async function nightlyCatalog(db: Database, client: ScClient, opts: NightlyOptions = {}): Promise<NightlyResult> {
  const fullRescan = opts.fullRescan ?? false;
  const now = opts.now ?? new Date();
  const catalog: CatalogResult = await enumerateCatalog(client, { maxPages: opts.maxPages });
  if (!catalog.ok && catalog.pages === 0) {
    return { ok: false, pages: 0, entriesSeen: 0, enqueued: [], evicted: [], returned: [], catalogComplete: false, error: catalog.error?.detail ?? "catalog failed" };
  }

  const enqueued: NightlyEnqueued[] = [];
  const enqueuedRepoIds = new Set<number>();
  const seenRepoIds = new Set<number>();
  const seenSlugs = new Set<string>();

  for (const entry of catalog.entries) {
    const slug = `${entry.org}/${entry.repo}`;
    seenSlugs.add(slug);
    const existing = db.query("SELECT id, last_activity_at FROM repos WHERE org_slug = ? AND repo_slug = ?").get(entry.org, entry.repo) as
      | { id: number; last_activity_at: string | null }
      | null;
    // upsert мета каталога (language/likes/дата — свежие всегда)
    const repoId = upsertRepo(db, entry.org, entry.repo, {
      title: entry.name,
      language: entry.language,
      likes: entry.likes,
      lastActivityAt: entry.last_updated,
      visibility: entry.visibility ?? "public",
    });
    seenRepoIds.add(repoId);
    // не чаще раза за обход (дубли записей каталога)
    if (enqueuedRepoIds.has(repoId)) continue;
    if (!existing) {
      enqueuedRepoIds.add(repoId);
      enqueueScan(db, repoId, { triggerKind: "periodic" });
      enqueued.push({ slug, reason: "new" });
      continue;
    }
    if (existing.last_activity_at === null && entry.last_updated !== null) {
      // строка была без даты (ручной ввод слага) — теперь дата есть: это «изменившийся»
      enqueuedRepoIds.add(repoId);
      enqueueScan(db, repoId, { triggerKind: "periodic" });
      enqueued.push({ slug, reason: "changed" });
      continue;
    }
    const changed = entry.last_updated !== existing.last_activity_at;
    const lastJob = db
      .query("SELECT status FROM jobs WHERE repo_id = ? AND user_id IS NULL ORDER BY id DESC LIMIT 1")
      .get(repoId) as { status: string } | null;
    const retryFailed = lastJob?.status === "failed";
    const lastPeriodicScan = db
      .query("SELECT rating_eligible FROM scans WHERE repo_id = ? AND user_id IS NULL AND status NOT IN ('queued', 'running') ORDER BY id DESC LIMIT 1")
      .get(repoId) as { rating_eligible: number } | null;
    const retryIneligible = lastPeriodicScan !== null && lastPeriodicScan.rating_eligible !== 1;
    if (fullRescan || changed || retryFailed || retryIneligible) {
      enqueuedRepoIds.add(repoId);
      enqueueScan(db, repoId, { triggerKind: "periodic" });
      enqueued.push({ slug, reason: fullRescan ? "forced" : changed ? "changed" : retryFailed ? "retry-failed" : "retry-ineligible" });
    }
  }

  // возврат ранее эвиктированных, вернувшихся в каталог
  const returned: string[] = [];
  for (const id of seenRepoIds) {
    const row = db.query("SELECT rating_active, org_slug, repo_slug FROM repos WHERE id = ?").get(id) as
      | { rating_active: number; org_slug: string; repo_slug: string }
      | null;
    if (row && row.rating_active === 0) {
      returnRepo(db, id);
      returned.push(`${row.org_slug}/${row.repo_slug}`);
    }
  }

  // эвикция: только полным каталогом и только public-строки
  const evicted: string[] = [];
  if (!catalog.truncated) {
    const candidates = db
      .query("SELECT id, org_slug, repo_slug FROM repos WHERE rating_active = 1 AND visibility = 'public'")
      .all() as { id: number; org_slug: string; repo_slug: string }[];
    for (const row of candidates) {
      if (!seenSlugs.has(`${row.org_slug}/${row.repo_slug}`)) {
        evictRepo(db, row.id, "disappeared from public catalog");
        evicted.push(`${row.org_slug}/${row.repo_slug}`);
      }
    }
  }

  return {
    ok: true,
    pages: catalog.pages,
    entriesSeen: catalog.entries.length,
    enqueued,
    evicted,
    returned,
    catalogComplete: !catalog.truncated,
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
}

/**
 * Исполнить заявленную job: заявка юзера → PAT автора, периодика →
 * серверный токен (новый клиент на задачу, H2). Лимиты клона — только
 * оператора (К5): scanCloneLimitsOf(Config.scan) для всех сканов.
 * repo-сигнал 'gone' (repo-GET 404/403) → эвикция ТОЛЬКО у задач без
 * автора (К3): 403 на PAT юзера говорит о правах PAT, не о репо (H1).
 * Канальные 403 cicd/runs — не эвикция (no-data access в фактах).
 * В4.1-fix (Ф1.8): заявка юзера без читаемого PAT (удалён после постановки,
 * нет APP_SECRET) → finishJob(failed) без скана; серверный токен юзерской
 * заявке не достаётся никогда.
 */
export async function processJob(deps: WorkerDeps, job: ClaimedJob): Promise<ScanResult | "gone" | "no-pat"> {
  const pat =
    job.userId !== null && deps.config.auth.appSecret
      ? (deps.getPat ?? getPat)(deps.db, deps.config.auth.appSecret, job.userId)
      : null;
  if (job.userId !== null && !pat) {
    finishJob(deps.db, job.id, job.claimedAt, "failed");
    return "no-pat";
  }
  const limits = scanCloneLimitsOf(deps.config.scan);
  const result = await (deps.runScan ?? runScan)(
    {
      db: deps.db,
      scClient: deps.serverClient(),
      cloneLimits: limits,
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

// ---------- циклы процесса сервера ----------

/** Воркер-луп: одна job за раз; ошибки не останавливают цикл; лиз продлевается каждые leaseMs/3 (К4). */
export function startWorkerLoop(deps: WorkerDeps, pollMs = 5000): () => void {
  let busy = false;
  const leaseMs = deps.config.scheduler.leaseMs;
  const timer = setInterval(async () => {
    if (busy) return;
    const job = claimNext(deps.db, new Date(), leaseMs, { maxAttempts: deps.config.queue.maxAttempts });
    if (!job) return;
    busy = true;
    const heartbeat = setInterval(() => {
      try {
        renewLease(deps.db, job.id, job.claimedAt, leaseMs);
      } catch (e) {
        console.error(`[worker] job ${job.id} lease renew failed: ${String((e as Error).message).slice(0, 200)}`);
      }
    }, Math.max(1, Math.floor(leaseMs / 3)));
    try {
      const result = await processJob(deps, job);
      finishJob(deps.db, job.id, job.claimedAt, result === "gone" || result === "no-pat" || result.status === "bad" ? "failed" : "done");
    } catch (e) {
      console.error(`[worker] job ${job.id} (${job.slug}) crashed: ${String((e as Error).message).slice(0, 200)}`);
      finishJob(deps.db, job.id, job.claimedAt, "failed");
    } finally {
      clearInterval(heartbeat);
      busy = false;
    }
  }, pollMs);
  return () => clearInterval(timer);
}

/**
 * Планировщик обхода каталога: интервал из конфига (сутки по умолчанию,
 * ТЗ §6); первый обход — через startDelayMs (окно управления стендом:
 * обход с живым токеном ставит первый скан всего каталога в очередь —
 * дизайн продукта, но оператор должен успеть это увидеть/отключить).
 * Расписание объясняется конфигурацией — раздел в отчёте воркера.
 */
export function startScheduler(db: Database, serverClient: () => ScClient | null, config: Config): () => void {
  const run = async () => {
    // новый клиент (и бюджет) на каждый обход — H2
    const client = serverClient();
    if (!client) return; // без серверного токена каталог не читается
    try {
      const result = await nightlyCatalog(db, client, {
        maxPages: config.scan.catalog.maxPages,
        fullRescan: config.scheduler.fullRescan,
      });
      if (!result.ok) {
        console.error(`[scheduler] catalog walk failed: ${result.error ?? "unknown"}`);
        return;
      }
      console.log(
        `[scheduler] catalog: ${result.pages} pages, ${result.entriesSeen} repos; queued ${result.enqueued.length} (${result.enqueued.filter((e) => e.reason === "new").length} new), evicted ${result.evicted.length}, returned ${result.returned.length}${result.catalogComplete ? "" : "; catalog INCOMPLETE - eviction skipped"}`,
      );
    } catch (e) {
      console.error(`[scheduler] crashed: ${String((e as Error).message).slice(0, 200)}`);
    }
  };
  const first = setTimeout(() => void run(), config.scheduler.startDelayMs);
  const timer = setInterval(() => void run(), config.scheduler.intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
