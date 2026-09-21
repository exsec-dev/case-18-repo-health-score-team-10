// scheduler.ts — периодика В4/Б3: claim-loop по jobs, обход каталога
// (Ф2.5, круг 2: ДВЕ фазы на одном перечислении — часовая сверка состава
// Config.scheduler.catalogIntervalMs и суточная ночная волна
// Config.scheduler.intervalMs; таймер тикает с периодом ЧАСТОЙ фазы,
// min(catalogIntervalMs, intervalMs) — час по умолчанию), форс-полный
// тогл SCHEDULER_FULL_RESCAN, потолок страниц Config.scan.catalog.maxPages.
// Источник диффа ночной волны — last_updated каталога против
// repos.last_activity_at, эвикция исчезнувших — ТОЛЬКО по дочитанному
// снимку и только repo-уровневым сигналам (Q&A №16). Инкрементальность: в
// очередь ставятся только изменившиеся и новые репо — «умный рескан»
// 17.09. NULL-lease матчится (SQLite NULL<now ложно — потому IS NULL OR).
// Воркер-луп живёт в процессе сервера, одну job за раз (tmp-диск стенда
// конечен); лиз истёк → job снова доступен (упавший воркер не блокирует
// очередь).
// В4.1 (К3): режима у job нет — автор (user_id) определяет токен скана;
// эвикция только у задач без автора (периодика, серверный токен);
// серверный REST-клиент — фабрика: новый бюджет на каждую задачу и на
// каждый ночной обход (H2).
import type { Database } from "bun:sqlite";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateCatalog, type CatalogEntry, type CatalogResult } from "../collectors/catalog";
import type { ScClient } from "../collectors/http";
import { upsertRepo, runScan, scanCloneLimitsOf, type ScanResult } from "./runner";
import { getPat } from "../auth/pat";
import { makeScClient } from "../collectors/http";
import { makeAppsecClient } from "../collectors/appsec";
import { worstCaseScanMs, type Config } from "../config";
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
export function recordRefusedUserJob(db: Database, userId: number, now = new Date(), slug?: string): number {
  // В4.4 (кластер J): слаг отказанной заявки — в error-payload (repo-строки
  // нет, LEFT JOIN панели иначе показал бы «—» вместо репозитория)
  const error = slug === undefined ? null : JSON.stringify({ slug });
  const r = db
    .query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, created_at, error) VALUES (0, 'refused', ?, 'user', ?, ?)")
    .run(userId, now.toISOString(), error);
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
  /** ПОРТ S2: какую очередь обслуживает этот claim — user | rating */
  queue?: "user" | "rating";
}

/**
 * Заявить одну job: атомарный UPDATE … WHERE (lease_until IS NULL OR
 * lease_until < now) — NULL-lease обязан матчиться (контракт плана);
 * истёкший лиз running-строки тоже матчится (упавший воркер).
 * К4: attempts +1 при claim; исчерпавшие попытки → failed с причиной в
 * `jobs.error` (П8).
 * claim обслуживает ОДНУ полосу (`opts.queue`), полоса выводится из
 * `jobs.trigger_kind` — единственного признака (П8). Чередования 1:1 больше
 * НЕТ: его убрал порт S2, изоляция интерактива от ночной волны заменила
 * честность перемеживания, а справедливость МЕЖДУ полосами живёт в
 * `claimAny` (round-robin, П1).
 * В4.1-fix (Ф1.7): внутри полосы `user` — круговой порядок между юзерами:
 * сперва юзеры без единой заявленной job, затем по давности их последней
 * заявки (MAX claimed_at ASC), затем id; в полосе `rating` этот подзапрос не
 * исполняется вовсе (П7). Ф1.12: job без строки repos → failed (попытки не
 * сжигаются по истечении лиза), берётся следующая.
 */
export function claimNext(db: Database, now = new Date(), leaseMs = 60 * 60_000, opts: ClaimOptions = {}): ClaimedJob | null {
  const maxAttempts = opts.maxAttempts ?? 3;
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + leaseMs).toISOString();
  // П8: предел попыток идёт через finishJob (массовый UPDATE шёл мимо и не
  // писал причину) — строк здесь единицы, цена выборки несущественна
  const exhausted = db
    .query(
      `SELECT id, claimed_at FROM jobs
       WHERE status IN ('queued', 'running') AND attempts >= ? AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .all(maxAttempts, nowIso) as { id: number; claimed_at: string | null }[];
  for (const row of exhausted) finishJob(db, row.id, row.claimed_at, "failed", JOB_ERRORS.attempts);
  // ПОРТ hq-parallel (S2): очереди РАЗДЕЛЕНЫ (решение Алексея 17.09 —
  // «всё лучшее от нас, сверху их капы»): claim обслуживает одну очередь
  // 'user' | 'rating'; чередование удалено — изоляция интерактива от ночной
  // волны заменяет честность перемеживания, справедливость между полосами
  // даёт round-robin в claimAny (П1). Внутри user-очереди сохранён их
  // круговой порядок между юзерами (Ф1.7); attempts (K4) неприкосновенны.
  const queue = opts.queue ?? "user";
  const claimStmt = db.query(
      `UPDATE jobs SET status = 'running', claimed_at = ?, lease_until = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE (lease_until IS NULL OR lease_until < ?)
           AND status IN ('queued', 'running')
           AND attempts < ?
           AND (CASE WHEN ? = 'user' THEN trigger_kind = 'user' ELSE trigger_kind != 'user' END)
         -- В4.2-port-fix (П7): круговой порядок между юзерами (Ф1.7) — свойство
         -- ПОЛОСЫ user. У периодических job user_id всегда NULL, но порты
         -- распространили коррелированный подзапрос и на полосу rating, где он
         -- бессмыслен по построению: 28 000 кандидатов × полный скан jobs =
         -- 335,7 с на один claim без idx_jobs_user_claimed (замер вехи), то есть
         -- не «медленнее», а мёртвый синхронный claim. CASE коротко замыкается в
         -- рантайме (EXPLAIN QUERY PLAN у обоих вариантов одинаков — по плану
         -- «исправлять» подзапрос не надо).
         ORDER BY CASE WHEN ? = 'user' THEN ((SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id) IS NOT NULL) ELSE 0 END,
                  CASE WHEN ? = 'user' THEN (SELECT MAX(j2.claimed_at) FROM jobs j2 WHERE j2.user_id = jobs.user_id) ELSE NULL END ASC,
                  id
         LIMIT 1
       )
       RETURNING id, repo_id, user_id, trigger_kind, claimed_at, attempts`,
  );
  // В4.8.5 (К8.5.2b, С8-9): перехват заявки после истекшего лиза закрывает
  // её прежний `running`-скан того же (репо, автор) В ТОЙ ЖЕ транзакции, что
  // и claim. Живого скана под этим ключом быть не может: у живого скана есть
  // живая заявка с непросроченным лизом, а активная заявка на (юзер, репо) и
  // живая периодическая на репо — по одной (дедуп постановки и гард обхода).
  // Прежде сирота жила до свипа, а новый лиз её ещё и прикрывал от свипа
  // (уточнение приемки 6)
  const closeStale = db.query(
    `UPDATE scans SET status = 'bad', public_status = 'bad', finished_at = ?, status_detail = 'orphaned'
     WHERE repo_id = ? AND user_id IS ? AND status = 'running'`,
  );
  const claimTx = db.transaction(() => {
    const row = claimStmt.get(nowIso, leaseIso, nowIso, maxAttempts, queue, queue, queue) as {
      id: number;
      repo_id: number;
      user_id: number | null;
      trigger_kind: string;
      claimed_at: string;
      attempts: number;
    } | null;
    if (row) {
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
      // П8: тоже через finishJob — иначе панель заданий показывает failed без причины
      finishJob(db, claimed.id, claimed.claimed_at, "failed", JOB_ERRORS.gone);
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

// В4.2-port-fix (П1, К1 CRITICAL): курсор круговой очереди между ПОЛОСАМИ.
// Порты убрали чередование 1:1 и оставили строгий порядок полос, поэтому в
// дефолтной роли `all` полоса `rating` голодала навсегда, пока в полосе
// `user` была хоть одна заявка (периодика, эвикция и рейтинг вставали, а
// /api/health оставался зелёным). Решение владельца (1) 17.09: round-robin
// в claimAny — обход начинается с разной полосы на каждом вызове.
let rrCursor = 0;

/** Шов тестов (К-П П1): курсор модульный, поэтому герметичность — сбросом. */
export function __resetRoundRobin(): void {
  rrCursor = 0;
}

/**
 * ПОРТ hq-parallel (S2/ищейка-3, фантомный claim): последовательный claim
 * по порядку очередей — следующая только если предыдущая пуста (map() клеймил
 * обе разом и вторая джоба повисала running без исполнителя на весь лиз).
 * В4.2-port-fix (П1): при нескольких полосах порядок обхода — `order`,
 * повёрнутый на курсор, а курсор растёт на КАЖДОМ вызове (иначе пустая
 * первая полоса залипает и прогресс курсора теряется). Изоляция не
 * меняется: у ролей `web` (`["user"]`) и `rating` (`["rating"]`) поворот —
 * тождество.
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
 * К8.5.2b / К8.5.12: запись с повтором SQLITE_BUSY — до `attempts` попыток с
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

/** Продление лиза своей заявки (К4): чужой/перезаявленный claimed_at — no-op. */
export function renewLease(db: Database, jobId: number, claimedAt: string, leaseMs: number, now = new Date()): boolean {
  const r = db
    .query("UPDATE jobs SET lease_until = ? WHERE id = ? AND claimed_at = ? AND status = 'running'")
    .run(new Date(now.getTime() + leaseMs).toISOString(), jobId, claimedAt);
  return r.changes > 0;
}

/**
 * Причины падения job для `jobs.error` (В4.2-port-fix, П8, LOW-1). Колонку
 * принесли порты, `myJobs` её читает, UI рисует ДОСЛОВНО пользователю
 * (`MePage.tsx`) — отсюда закрытый список RU-текстов без секретов; коммиты
 * при этом EN. Ни одного `UPDATE`/`INSERT` в колонку до этой вехи не было,
 * то есть заявленная портом фича была мертва.
 */
export const JOB_ERROR_MAX = 500;
export const JOB_ERRORS = {
  gone: "репозиторий недоступен",
  noPat: "нет действующего токена",
  attempts: "превышено число попыток",
  internal: "внутренняя ошибка",
  /** К8.5.12 (С10-1): скан собрал факты, но оценку посчитать не удалось — скан закрыт `bad` (score_failed) */
  scoreFailed: "не удалось посчитать оценку",
  /** `bad`-скан: какие каналы не собрались (ScanResult.channels); В4.8.5 (К8.5.4, С4-12) — словами, не кодами каналов */
  channels: (channels: string[]): string => `сбор данных не удался: ${channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ")}`.slice(0, JOB_ERROR_MAX),
} as const;

/** Каналы скана языком продукта: причина падения показывается в «Заданиях» дословно. */
const CHANNEL_NAMES: Record<string, string> = { git: "клон репозитория", rest: "данные SourceCraft", appsec: "Security" };

/**
 * Каналы `bad`-скана, которые не собрались, — для текста причины (П8).
 *
 * М3 (круг 2): собравшимся считается любой `ok*`, а не только точное «ok».
 * `runScan` помечает деградационный клон (shallow-ярус §5.7) как
 * `ok(degraded)` — данные есть, история укорочена; строгое сравнение читало
 * его как отказ, и пользователь получал «сбор данных не удался: git» про
 * канал, который собрался.
 */
export function failedChannelsOf(channels: { git: string; rest: string; appsec: string }): string[] {
  return (["git", "rest", "appsec"] as const).filter((k) => !channels[k].startsWith("ok") && channels[k] !== "skipped");
}

/**
 * Завершение job (К4): только своей заявки — WHERE id AND claimed_at;
 * воркер с истёкшим лизом, чью job перезаявили, чужой прогон не закрывает.
 * `claimed_at IS ?` (а не `=`): через finishJob идёт и ветка предела попыток,
 * где у незаявленной строки `claimed_at` NULL (П8).
 * `error` — причина падения из `JOB_ERRORS`; не передана → колонка гасится,
 * чтобы успешный перезапуск не показывал старую причину.
 */
export function finishJob(db: Database, jobId: number, claimedAt: string | null, status: "done" | "failed", error?: string): boolean {
  const r = db
    .query("UPDATE jobs SET status = ?, lease_until = NULL, error = ? WHERE id = ? AND claimed_at IS ?")
    .run(status, error === undefined ? null : error.slice(0, JOB_ERROR_MAX), jobId, claimedAt);
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
  /** какие фазы реально исполнились на этом snapshot (Ф2.5) */
  phases: CatalogPhases;
  /** В4.4 (кластер D): обход поднял catalog_suspicious_at (эвикция приостановлена) */
  suspicious: boolean;
  error?: string;
}

export interface NightlyOptions {
  maxPages?: number;
  fullRescan?: boolean;
  now?: Date;
  /** какие фазы исполняются на этом snapshot (Ф2.5) */
  phases?: CatalogPhases;
}

/**
 * Ф2.5: две фазы поверх ОДНОГО перечисления каталога.
 * `reconcile` — сверка состава (час): новые репо, возврат вернувшихся,
 * эвикция исчезнувших. `nightly` — волна пересканов (сутки): changed,
 * retry-failed, retry-ineligible, форс. Один обход обслуживает обе — второго
 * клиента и второго бюджета не существует.
 */
export interface CatalogPhases {
  reconcile: boolean;
  nightly: boolean;
}

/** Причина эвикции сверкой (К-Ф2.5, дословно). */
export const EVICT_NOT_IN_CATALOG = "not in public catalog";

/** Строка repos для сверки каталога (К-Р4: чтение одним запросом в память). */
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
 * К-Р4 (круг 2): применить мету каталога к repos ТОЛЬКО при расхождении
 * (или новой строке); неизменившаяся строка НЕ перезаписывается. Семантика
 * сравнения — зеркально COALESCE-ветке upsertRepo: null из каталога ничего
 * не затирает, расхождение — только непустое новое значение; видимость —
 * только явным полем (Ф2.5); `last_activity_at` обход не пишет (К-Ф1.1).
 * Трогает ТОЛЬКО путь сверки каталога — остальные зовущие upsertRepo
 * (сканы, постановка юзером) сохраняют прежнее поведение.
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
    // Ф2.12 (LOW-2, третья часть) + К-Ф1.1: `last_activity_at` — ВОДОРАЗДЕЛ
    // «до какой даты репо просканирован», и двигать его вправе только
    // пригодный успешный скан (`runScan`, после скор-хука)
    lastActivityAt: undefined,
    // Ф2.5: видимость — ТОЛЬКО из явного поля платформы
    visibility: entry.visibility ?? undefined,
    logoUrl: entry.logo_url,
    languageColor: entry.language_color,
  });
}

/**
 * Полный обход каталога: дифф last_updated → очередь изменившихся,
 * постановка новых, эвикция исчезнувших (только public-строки нашей
 * таблицы; приватные own-репо в публичном каталоге и не ждутся).
 * Второй прогон при неизменном каталоге не ставит в очередь ничего —
 * приёмочный инвариант каталога.
 * В4.1-fix круг 2 (С3, LOW-8): retry-failed — только по последней
 * ПЕРИОДИЧЕСКОЙ job (юзерская не навязывает и не маскирует перескан);
 * последний завершённый периодический скан непригоден → перескан
 * (retry-ineligible), не чаще раза за обход.
 * В4.2-port-fix (П5, С2 r2 = Ф2.12, первая половина): у репо с ЖИВОЙ
 * периодической job (queued/running) новая не ставится вообще. Без гарда
 * ветка retry-ineligible ставила job КАЖДЫЙ обход — на масштабе каталога
 * +1044 дубля за обход при пропускной способности ~700 сканов/сутки, и
 * докстринг выше был неправдой.
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
  // В4.4 (кластер F): постановка волны — ПО ЛАЙКАМ (убывание): витринные
  // репо получают оценку первыми (700 сканов/сутки против 27 446 каталога —
  // порядок решает, что увидит демо). Спека GET /repos sort_by=likes НЕ
  // поддерживает (enum created_at|rating) — сортировка клиентская по
  // полям уже собранного перечисления; дифф last_updated не меняется.
  // Кандидаты собираются с прежними гард'ами, ставятся после обхода батчами.
  const waveCandidates: { repoId: number; slug: string; reason: NightlyEnqueued["reason"]; likes: number | null }[] = [];
  // П5: признак полосы сразу через trigger_kind (единый признак — П8);
  // строки refused несут trigger_kind='user' и в полосу периодики не попадают
  const hasLivePeriodicJob = (repoId: number): boolean =>
    db.query("SELECT 1 FROM jobs WHERE repo_id = ? AND trigger_kind != 'user' AND status IN ('queued', 'running') LIMIT 1").get(repoId) !== null;
  const seenRepoIds = new Set<number>();
  const seenSlugs = new Set<string>();
  // К-Р4 (круг 2): состояние repos читается ОДНИМ запросом в память — не
  // запросом на каждую запись каталога; запись — только при расхождении
  // полей или новой строке. Прежний путь делал upsertRepo на КАЖДУЮ запись:
  // 27 446 безусловных UPDATE за проход часовой сверки (замер до правки:
  // 27 446 UPDATE / 869 мс на этой машине; 28–40 с синхронной БД у
  // аудит-пары) × 24 раза в сутки в одном процессе с Bun.serve.
  const repoRows = db
    .query("SELECT id, org_slug, repo_slug, title, language, likes, visibility, logo_url, language_color, last_activity_at FROM repos")
    .all() as CatalogRepoRow[];
  const reposBySlug = new Map(repoRows.map((r) => [`${r.org_slug}/${r.repo_slug}`, r]));

  for (const entry of catalog.entries) {
    const slug = `${entry.org}/${entry.repo}`;
    seenSlugs.add(slug);
    const existing = reposBySlug.get(slug) ?? null;
    // К-Р4: мета каталога — сверкой с записью только при расхождении
    const repoId = reconcileCatalogRepo(db, entry, existing);
    seenRepoIds.add(repoId);
    // не чаще раза за обход (дубли записей каталога)
    if (enqueuedRepoIds.has(repoId)) continue;
    // П5: живая периодическая job уже отсканирует репо — второй не нужно
    if (hasLivePeriodicJob(repoId)) continue;
    if (!existing) {
      // новые репо — фаза сверки (Ф2.5): состав каталога, не волна пересканов
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
    // П8 (LOW-5): признак полосы один — trigger_kind. Раньше здесь стоял
    // второй признак (`user_id IS NULL`). Их согласованность держится НЕ на
    // одной вставке `enqueueScan`, а на миграции: `openDb` бэкфиллит
    // `trigger_kind = 'user'` всем строкам с `user_id` (П11, Н-2) — иначе
    // legacy-строки, получившие колонку из DEFAULT 'periodic', читались бы
    // как периодические. Строки refused (trigger_kind = 'user', repo_id = 0)
    // в полосу периодики не попадают ни одним путём
    const lastJob = db
      .query("SELECT status FROM jobs WHERE repo_id = ? AND trigger_kind != 'user' ORDER BY id DESC LIMIT 1")
      .get(repoId) as { status: string } | null;
    const retryFailed = lastJob?.status === "failed";
    // ВНИМАНИЕ (К-П П5): в таблице scans колонка называется `trigger` и имеет
    // ТРИ значения (periodic|user|probe), поэтому `trigger != 'user'` здесь НЕ
    // эквивалентно `user_id IS NULL` — предикат по scans остаётся на user_id
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
    }
  }

  // В4.4 (кластер F): лайки по убыванию (нет лайков — в хвост), постановка —
  // батчами по 100 в одной транзакции (синхронная фаза постановки как целое
  // — З5 аудита — вне скоупа, В6; батч режет число автокоммитов).
  // И-6 (круг 2): конечный сентинел вместо -Infinity — на паре null-лайков
  // разность давала NaN; лайки неотрицательны, -1 безопасен и null-пара
  // сравнима корректно (обе в хвост, порядок перечисления между ними)
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

  // В4.4 (кластер D код-аудита): «успешно пустой» ПОЛНЫЙ обход (ok, не
  // truncated, 0 записей) при существующих активных публичных репо — это
  // сломавшаяся форма каталога (дрейф поля visibility и т.п.), а не «все
  // исчезли»: один такой тик раньше гасил rating_active всему рейтингу.
  // Эвикция не исполняется, ставится meta-флаг catalog_suspicious_at
  // (health окрасится); снимает флаг первый обход с записями.
  // В4.4 (кластер K/З5): гард слагов — счётчик отброшенного в health/лог.
  // И-3/П-6/S-3 (круг 2): пишется ВСЕГДА — чистый обход сбрасывает в 0, и
  // подпись «последний обход» в health не показывает устаревшее число
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
    // Ф2.5: ошибка страницы посреди обхода — это СБОЙ обхода, даже если
    // что-то уже прочитано. Прежний код отдавал ok=true при `pages > 0`, и
    // тик считал такой проход успешным (due-метки двигались бы зря)
    ok: catalog.ok,
    pages: catalog.pages,
    entriesSeen: catalog.entries.length,
    enqueued,
    evicted,
    returned,
    catalogComplete: !catalog.truncated,
    phases,
    /** В4.4 (кластер D): этот обход поднял catalog_suspicious_at */
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
  /** шов Б0: подмена claim (тест роняет БД внутри тика) */
  claimAny?: typeof claimAny;
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
    finishJob(deps.db, job.id, job.claimedAt, "failed", JOB_ERRORS.noPat);
    return "no-pat";
  }
  const limits = scanCloneLimitsOf(deps.config.scan);
  const result = await (deps.runScan ?? runScan)(
    {
      db: deps.db,
      scClient: deps.serverClient(),
      cloneLimits: limits,
      // Ф2.19: лимиты извлечения — из конфига процесса, а не из дефолтов
      // модуля: иначе SCAN_EXTRACT_TIMEOUT_MS не влиял бы ни на что
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
      // П3: адреса REST/AppSec — во все клиенты, включая те, что runScan строит сам
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

// ---------- циклы процесса сервера ----------

/**
 * В4.4 (кластер L/З1): заявки, заявленные ЭТИМ процессом (id → claimed_at).
 * SIGTERM возвращает их в queued (claimed_at NULL) и ОТКАТЫВАЕТ попытку —
 * административная остановка не считается попыткой (В4.8.5, К8.5.2a: до
 * этого комментарий обещал «attempts без изменений», а claim уже сделал +1,
 * и три рестарта во время скана давали «превышено число попыток»); registry живёт
 * в памяти процесса — чужие заявки не трогаются никогда.
 * П-5 (круг 2): реестр несёт repoId/userId — прерванный завершением скан
 * этого процесса закрывается честным квартетом (см. closeOwnRunningScans),
 * а не висит running до свипа сирот.
 */
const liveClaims = new Map<number, { claimedAt: string; repoId: number; userId: number | null }>();

/**
 * П-5 (круг 2 В4.4): сканы ЭТОГО процесса, прерванные штатным завершением, —
 * не сироты до свипа, а честный `bad` с причиной shutdown. Квартет как у
 * свипа сирот (`sweepOrphanScans`): status + public_status + finished_at +
 * status_detail — один status='bad' оставил бы public_status='running'
 * навсегда. ПОРЯДОК при SIGTERM: сначала закрыть сканы, ПОТОМ вернуть
 * заявки (иначе queued-заявка прикрывала бы закрываемый скан).
 */
export function closeOwnRunningScans(db: Database): number {
  const nowIso = new Date().toISOString();
  let closed = 0;
  for (const claim of liveClaims.values()) {
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
 * Воркер-луп: одна job за раз; ошибки не останавливают цикл; лиз продлевается
 * каждые leaseMs/3 (К4). ПОРТ hq-parallel (S2): очереди user|rating с ролями
 * процесса — web = сервер + user-воркер (интерактив), rating = планировщик +
 * rating-воркер (ночная волна), all = dev-обе-в-одном (user вперёд).
 * Фоновый пересчёт истории крутит только rating-роль (web держит готовность).
 */
export type WorkerTickOutcome = "busy" | "idle" | "claim-failed" | "done" | "failed";

/** Состояние воркер-лупа между тиками (гард «занят»): шов Б0 держит его снаружи. */
export interface WorkerLoopState {
  busy: boolean;
  /** В4.8.5 (С10-3): когда взято текущее задание (мс); нет — задания нет */
  currentSince?: number;
  /** В4.4 (З2): время последнего редкого фонового батча (каденс при непустых очередях) */
  lastBackgroundTickAt?: number;
}

/** В4.4 (З2): каденс фонового пересчёта при НЕпустых очередях — раз в 10 мин один батч. */
export const BACKGROUND_RESCORE_CADENCE_MS = 10 * 60_000;

/** Один шаг фонового пересчёта: сперва недогнанный курсор прохода, затем история. */
function backgroundRescoreStep(deps: WorkerDeps): void {
  try {
    const healed = needsRescore(deps.db) ? rescoreBatchByCursor(deps.db, { log: (m) => console.log(`[worker] ${m}`) }).processed : 0;
    if (healed === 0) rescoreHistoryBatch(deps.db, { log: (m) => console.log(`[worker] ${m}`) });
  } catch (e) {
    console.error(`[worker] background rescore failed: ${String((e as Error).message).slice(0, 200)}`);
  }
}

/**
 * Тело одного тика воркер-лупа — ОТДЕЛЬНАЯ функция (Ф2.1, остаток после
 * портов): тест вызывает её напрямую, без таймера. Броня портов сохранена
 * целиком — claim, фоновый пересчёт, `processJob`, `renewLease` в try/catch;
 * исключение наружу не выходит, цикл жив.
 * В4.4 (З2): фоновый пересчёт гоняется и при непустой очереди — редким
 * каденсом (раз в 10 мин, один батч) до busy-гарда, чтобы длинная волна
 * не морила курсоры голодом (факт аудита: cursor=0 при derived=5).
 */
export async function workerTick(
  deps: WorkerDeps,
  order: Array<"user" | "rating">,
  state: WorkerLoopState,
  opts: { historyRescore?: boolean } = {},
): Promise<WorkerTickOutcome> {
  const dueBackground =
    opts.historyRescore === true && (state.lastBackgroundTickAt === undefined || Date.now() - state.lastBackgroundTickAt >= BACKGROUND_RESCORE_CADENCE_MS);
  if (dueBackground) {
    state.lastBackgroundTickAt = Date.now();
    backgroundRescoreStep(deps);
  }
  if (state.busy) return "busy";
  const leaseMs = deps.config.scheduler.leaseMs;
  // ПОРТ S2/ищейка-8: весь тик в броне — бросок БД не валит процесс
  let job: ClaimedJob | null = null;
  try {
    job = (deps.claimAny ?? claimAny)(deps.db, order, new Date(), leaseMs, { maxAttempts: deps.config.queue.maxAttempts });
  } catch (e) {
    console.error(`[worker] claim failed: ${String((e as Error).message).slice(0, 200)}`);
    return "claim-failed";
  }
  if (!job) {
    // обе наши очереди пусты — порция фонового пересчёта (LOW-7) КАЖДЫЙ тик:
    // В4.4 — сперва недогнанный курсор актуального прохода, затем история
    if (opts.historyRescore) {
      backgroundRescoreStep(deps);
      state.lastBackgroundTickAt = Date.now();
    }
    return "idle";
  }
  const claimed = job;
  state.busy = true;
  state.currentSince = Date.now();
  liveClaims.set(claimed.id, { claimedAt: claimed.claimedAt, repoId: claimed.repoId, userId: claimed.userId });
  // К8.5.2b: продление каждые leaseMs/3; SQLITE_BUSY повторяется (при лизе
  // 10 мин три пропуска подряд = перехват живого скана)
  const heartbeat = setInterval(() => {
    void withBusyRetry(() => renewLease(deps.db, claimed.id, claimed.claimedAt, leaseMs), `job ${claimed.id} lease renew`).catch((e) =>
      console.error(`[worker] job ${claimed.id} lease renew failed: ${String((e as Error).message).slice(0, 200)}`),
    );
  }, Math.max(1, Math.floor(leaseMs / 3)));
  try {
    const result = await processJob(deps, claimed);
    // П8: причина падения — в jobs.error, панель заданий показывает её дословно
    const failure =
      result === "gone"
        ? JOB_ERRORS.gone
        : result === "no-pat"
          ? JOB_ERRORS.noPat
          : result.scoreFailed === true
            ? JOB_ERRORS.scoreFailed
            : result.status === "bad"
              ? JOB_ERRORS.channels(failedChannelsOf(result.channels))
              : null;
    // К8.5.12 (С10-2): итог задания — с повтором SQLITE_BUSY: готовый скан не
    // оставляет задание `running` до лиза и не сжигает попытку повтором
    await withBusyRetry(
      () => finishJob(deps.db, claimed.id, claimed.claimedAt, failure === null ? "done" : "failed", failure ?? undefined),
      `job ${claimed.id} finish`,
    );
    return failure === null ? "done" : "failed";
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

/** С10-3: тик считается живым, если он не `busy` или текущее задание ещё в пределах худшего бюджета скана. */
export function loopTickIsAlive(outcome: WorkerTickOutcome, state: WorkerLoopState, config: Config, now = Date.now()): boolean {
  if (outcome !== "busy") return true;
  return state.currentSince !== undefined && now - state.currentSince <= worstCaseScanMs(config.scan);
}

export function startWorkerLoop(
  deps: WorkerDeps,
  queues: { user?: boolean; rating?: boolean },
  pollMs = 5000,
  seams: { tick?: typeof workerTick } = {},
): () => void {
  const order: Array<"user" | "rating"> = queues.user && queues.rating ? ["user", "rating"] : queues.user ? ["user"] : queues.rating ? ["rating"] : [];
  if (order.length === 0) return () => {};
  const state: WorkerLoopState = { busy: false };
  const tick = seams.tick ?? workerTick;
  const timer = setInterval(() => {
    // тик целиком в броне и на уровне таймера: синхронный бросок шва (или
    // отказ самого `setInterval`-колбэка) не должен ронять процесс
    try {
      void tick(deps, order, state, { historyRescore: queues.rating === true })
        .then((outcome) => {
          // З6 (круг 2 В4.4): метка живого тика — у rating-стороны лупа своя
          // (иначе живой web-процесс маскировал бы мёртвую rating-роль);
          // В4.8.5 (К8.5.5c): у user-стороны — своя, для health полосы.
          // С10-3: тик `busy` — не признак жизни сам по себе: метка пишется,
          // только пока текущее задание не вышло за худший бюджет скана
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
 * Планировщик обхода каталога: интервал из конфига (сутки по умолчанию,
 * ТЗ §6); первый обход — через startDelayMs (окно управления стендом:
 * обход с живым токеном ставит первый скан всего каталога в очередь —
 * дизайн продукта, но оператор должен успеть это увидеть/отключить).
 * Расписание объясняется конфигурацией — раздел в отчёте воркера.
 */
// В4.8.5 (К8.5.5b, С8-12): второе хранилище меток фаз в памяти процесса
// (`schedulerStateRef`, `schedulerHealthSnapshot`) удалено — единственный
// источник меток для health и для рестарта — meta (SCHED_META).

/**
 * Возраст, начиная с которого каталог клона считается осиротевшим (Ф2.19):
 * живой скан держит клон всё время своей работы, а портовый час был короче —
 * свип сносил каталог из-под работающего git, и скан падал «сам по себе».
 * В4.8.5 (К8.5.2b): возраст — от ХУДШЕГО СКАНА (`worstCaseScanMs`, 85 мин на
 * дефолтах), а не от лиза: при лизе 10 мин прежняя формула `max(2·лиз, 60 мин)`
 * дала бы 60 мин < 85 и вернула дефект Ф2.19, а обслуживание в любой роли
 * сносило бы клоны соседнего процесса. Мерило каталога клона — длина скана.
 */
export function orphanCloneAgeMs(config: Config): number {
  return worstCaseScanMs(config.scan);
}

/** ПОРТ hq-parallel (S3): свип осиротевших rh-clone-* (crash/OOM-убитые
 *  клоны никто не подбирал — tmp тек до ENOSPC); возраст — Ф2.19. */
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
 * Ф2.2: осиротевшие `running`-сканы (НЕ путать со свипом каталогов клонов —
 * `sweepOrphanClones`). Процесс, начавший скан, умер; строка `scans` осталась
 * `running` навсегда (на живой БД 17.09 — 7 штук, старейшая от 16.09). Сирота
 * = `running`, старше лиза, и нет ЖИВОЙ job того же (repo, автор) с
 * непросроченным лизом. `user_id IS s.user_id`: SQLite `IS` сравнивает и
 * NULL'ы, поэтому периодический скан не «прикрывается» юзерской job.
 * Закрывается как `bad` с `status_detail='orphaned'` — статус скана честен, а
 * причина отделена от настоящего провала сбора.
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

/**
 * Ф2.13: очистка завершённых строк `jobs` старше `Config.queue.retentionDays`.
 * Строки очереди транзитны (данные скана живут в `scans`/`facts`/`scores`), а
 * растут они линейно от волн: 27 446 репо в сутки — это десятки миллионов
 * строк в год в той же БД, что и чтение рейтинга. `queued`/`running` не
 * трогаем никогда; строки без `created_at` (legacy) — тоже, их возраст
 * неизвестен, а гадать по id нельзя.
 */
export function purgeOldJobs(db: Database, opts: { retentionDays: number; now?: Date }): number {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60_000).toISOString();
  const r = db
    .query("DELETE FROM jobs WHERE status IN ('done', 'failed', 'refused') AND created_at IS NOT NULL AND created_at < ?")
    .run(cutoff);
  if (r.changes > 0) console.log(`[sweep] удалено завершённых job старше ${opts.retentionDays} дней: ${r.changes}`);
  return r.changes;
}

/**
 * Тик обслуживания (Ф2.1: тело тика — функция, вызываемая через шов;
 * Ф2.2 + Ф2.13): сироты-сканы, ретеншен `jobs`, свип каталогов клонов.
 * Целиком в try/catch — исключение наружу не выходит, таймер жив.
 */
export async function maintenanceTick(
  db: Database,
  config: Config,
  opts: { now?: Date; cloneDir?: string } = {},
): Promise<{ scans: number; jobs: number; clones: number }> {
  const out = { scans: 0, jobs: 0, clones: 0 };
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
    out.clones = await sweepOrphanClones(opts.cloneDir, orphanCloneAgeMs(config));
  } catch (e) {
    console.error(`[sweep] orphan clones failed: ${String((e as Error).message).slice(0, 200)}`);
  }
  return out;
}

/** Состояние тика каталога: единый re-entry-гард и две due-метки (Ф2.5). */
export interface CatalogTickState {
  walking: boolean;
  /** время последней УСПЕШНОЙ сверки (каталог дочитан) */
  lastReconcileAt: Date | null;
  /** время последней УСПЕШНОЙ ночной фазы */
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

/** К8.5.5b: пустые метки состояния — из ключей УСПЕХА фаз в meta. */
export function loadPhaseMarks(db: Database, state: CatalogTickState, now = new Date()): void {
  if (state.lastReconcileAt === null) state.lastReconcileAt = metaDate(db, SCHED_META.reconcileAt, now);
  if (state.lastNightlyAt === null) state.lastNightlyAt = metaDate(db, SCHED_META.nightlyOkAt, now);
}

/** С8-4: ошибка сверки — в meta (стирает её только дочитанная сверка). */
function recordReconcileError(db: Database, error: string, now: Date): void {
  setMetaValue(db, SCHED_META.reconcileError, error.slice(0, 200));
  setMetaValue(db, SCHED_META.reconcileErrorAt, now.toISOString());
}

/** Бюджет запросов клиента одного обхода (К-Ф2.5): потолок страниц + 10. */
export function catalogClientBudget(config: Config): number {
  return config.scan.catalog.maxPages + 10;
}

/**
 * Тик каталога (Ф2.1 — шов для прямого вызова из теста; Ф2.5 — одно
 * перечисление на обе фазы). Каталог обходится ОДИН раз, если должна хотя бы
 * одна фаза; дочитанный snapshot всегда исполняет сверку, а ночная фаза
 * добавляется к тому же snapshot, когда её срок пришёл. Недочитанный или
 * ошибочный snapshot не эвиктит и не двигает метку СВЕРКИ; К-Р3 (решение
 * Екатерины 19.09): ночная метка двигается, если ночная фаза ИСПОЛНИЛАСЬ
 * (обход прошёл), независимо от полноты каталога — иначе суточная волна
 * вырождается в часовую, пока каталог недочитывается; ритм ночной волны от
 * полноты каталога не зависит, эвикция — единственное опасное действие на
 * неполном снимке — по-прежнему только по дочитанному. Конкурирующих обходов
 * нет: гард один на обе фазы, клиент (и его бюджет) — один на snapshot.
 */
export async function catalogTick(
  db: Database,
  serverClient: () => ScClient | null,
  config: Config,
  state: CatalogTickState,
  opts: { now?: Date } = {},
): Promise<NightlyResult | null> {
  // гард ДО try: в портовой редакции проверка стояла внутри, и `finally`
  // снимал чужой гард — пропущенный тик открывал дорогу параллельному обходу,
  // ровно тому, от которого гард и ставили
  if (state.walking) {
    console.warn("[scheduler] предыдущий обход ещё жив — запуск пропущен (ПОРТ S2)");
    return null;
  }
  const now = opts.now ?? new Date();
  // В4.8.5 (К8.5.5b, С8-2): метки УСПЕХА фаз переживают рестарт — пустая
  // метка в памяти (первый тик процесса) берётся из meta. Ночная — из
  // отдельного ключа успеха (`sched_last_nightly_at` значит «попытка»)
  loadPhaseMarks(db, state, now);
  const due = (last: Date | null, everyMs: number) => last === null || now.getTime() - last.getTime() >= everyMs;
  const reconcileDue = due(state.lastReconcileAt, config.scheduler.catalogIntervalMs);
  const nightlyDue = due(state.lastNightlyAt, config.scheduler.intervalMs);
  if (!reconcileDue && !nightlyDue) return null;
  // новый клиент (и бюджет) на каждый обход — H2
  const client = serverClient();
  if (!client) {
    // без серверного токена каталог не читается — С8-10: health это видит
    setMetaValue(db, SCHED_META.noTokenAt, now.toISOString());
    return null;
  }
  if (getMetaValue(db, SCHED_META.noTokenAt) !== null) db.query("DELETE FROM meta WHERE key = ?").run(SCHED_META.noTokenAt);
  state.walking = true;
  try {
    // сверка исполняется на КАЖДОМ обходе: каталог всё равно перечислен —
    // не воспользоваться им значит заплатить за обход и выбросить результат
    const result = await nightlyCatalog(db, client, {
      maxPages: config.scan.catalog.maxPages,
      fullRescan: config.scheduler.fullRescan,
      now,
      phases: { reconcile: true, nightly: nightlyDue },
    });
    // К-Р5: ночной факт health — только обходы, в которых ночная фаза
    // участвовала; часовая сверка его не обновляет. В4.4 (кластер B): тот же
    // факт дублируется в meta — кросс-процессно (web-роль читает состоянием
    // планировщика, которого в её процессе нет)
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
      // С8-4: сверка не удалась — след в meta (health судит по нему и по возрасту успеха)
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
    // К-Р3: ночная метка — по исполнению фазы (обход ok), НЕ по полноте
    // каталога; метка сверки выше — по-прежнему только по дочитанному
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
 * К-Р2 (круг 2): броня КОЛБЭКА ТАЙМЕРА — та же, что у воркер-лупа
 * (`startWorkerLoop`): синхронный бросок шва и отказ промиса логируются,
 * цикл жив (Ф2.1 «цикл жив» распространён на ОБА таймера планировщика —
 * тик каталога и часовое обслуживание). Экспортирована для теста брони
 * без ожидания часового интервала обслуживания.
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

export function startScheduler(
  db: Database,
  serverClient: () => ScClient | null,
  config: Config,
  seams: { tick?: typeof catalogTick; maintenance?: typeof maintenanceTick } = {},
): () => void {
  // ПОРТ S2: re-entrancy-гард + due-метки фаз (Ф2.5). Метки пусты — первый тик
  // после startDelayMs считает due обе фазы
  const state = newCatalogTickState();
  const tick = seams.tick ?? catalogTick;
  const maintenance = seams.maintenance ?? maintenanceTick;
  // К-Р2: оба таймера — в броне (раньше `void tick(...)` без try/catch и без
  // .catch: отказ шва останавливал таймер молча)
  const run = armoredTimerCallback("scheduler", () => tick(db, serverClient, config, state));
  const first = setTimeout(run, config.scheduler.startDelayMs);
  // тик зовётся с периодом частой фазы; какая из фаз исполнится — решают
  // due-метки внутри тика, а не расписание таймера
  const timer = setInterval(run, Math.max(1, Math.min(config.scheduler.catalogIntervalMs, config.scheduler.intervalMs)));
  const stopMaintenance = startMaintenance(db, config, { maintenance });
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    stopMaintenance();
  };
}

/**
 * Часовое обслуживание (ПОРТ S3 + Ф2.2/Ф2.13): сироты-сканы, ретеншен jobs,
 * каталоги клонов. В4.8.5 (К8.5.2b, С10-4): таймер запускается в ЛЮБОЙ роли —
 * роль web без него держала скан-сироту «Сканируется» до своего рестарта.
 * Свипы идемпотентны, конкурирующие роли друг другу не мешают (возраст свипа
 * клонов — от худшего скана).
 */
export function startMaintenance(db: Database, config: Config, seams: { maintenance?: typeof maintenanceTick; periodMs?: number } = {}): () => void {
  const maintenance = seams.maintenance ?? maintenanceTick;
  const timer = setInterval(armoredTimerCallback("sweep", () => maintenance(db, config)), seams.periodMs ?? 60 * 60_000);
  return () => clearInterval(timer);
}
