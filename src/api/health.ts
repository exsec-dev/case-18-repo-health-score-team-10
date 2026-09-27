// /api/health: `ok` вычисляется из состояния, а не отдается литералом.
// Состояние планировщика лежит в meta, потому что его пишет rating-роль, а
// читает web-роль (разные процессы). HTTP-статус всегда 200: здоровье читают
// по телу, а тестовый харнесс по ответу лишь ждет, что порт поднялся.
import type { Database } from "bun:sqlite";
import { worstCaseScanMs, type Config } from "../config";
import { getMetaValue } from "../db";
import { needsRescore, rescoreState, type RescoreState } from "../score/rescore";

/** meta-ключи состояния планировщика (пишет catalogTick rating-роли). */
export const SCHED_META = {
  /** время последней УСПЕШНОЙ (дочитанной) сверки — ключ успеха фазы сверки */
  reconcileAt: "sched_last_reconcile_at",
  /** время последней ПОПЫТКИ ночной фазы (исход — nightlyOk/nightlyError) */
  nightlyAt: "sched_last_nightly_at",
  nightlyOk: "sched_last_nightly_ok",
  nightlyError: "sched_last_nightly_error",
  /** время последней УСПЕШНОЙ ночной фазы; nightlyAt значит лишь «попытка» */
  nightlyOkAt: "sched_nightly_ok_at",
  /** последняя ошибка сверки и ее время; успешная сверка их стирает */
  reconcileError: "sched_reconcile_error",
  reconcileErrorAt: "sched_reconcile_error_at",
  /** когда тик каталога не нашел серверного токена; тик с токеном стирает */
  noTokenAt: "sched_no_token_at",
  /** метка живого тика rating-стороны воркер-лупа. Занятый тик пишет ее, только
   *  пока текущее задание укладывается в худший бюджет скана. */
  tickAt: "sched_tick_at",
  /** та же метка пользовательской стороны лупа (роль web/all) */
  userTickAt: "sched_user_tick_at",
} as const;

/** Пользовательская заявка ждет дольше этого, а user-сторона не тикает – health краснеет. */
export const USER_LANE_STALE_MS = 30 * 60_000;

/** Метка тика старше этого порога – rating-роль, вероятно, мертва (таймеры
 *  стоят), и health должен краснеть, а не оставаться зеленым. */
export const SCHED_STALE_AFTER_MS = 30 * 60_000;

/** meta-ключ гарда пустого каталога. */
export const CATALOG_SUSPICIOUS_AT = "catalog_suspicious_at";

export interface HealthStatus {
  ok: boolean;
  /** красные причины человекочитаемо; пусто = здоров */
  reasons: string[];
  repos: number;
  llmProvider: string;
  queue: { user: number; rating: number };
  /** сколько ждет самая старая пользовательская заявка каждого рода, мс (null – никто).
   *  Только для оператора: живость циклов проверяют `stuck`/`expired`, а ожидания они не видят */
  userQueueOldestMs: { scan: number | null; summary: number | null; check: number | null };
  failedJobs24h: number;
  /** прогресс асинхронного рескора */
  rescore: RescoreState;
  /** обход вернул пустой каталог при живом рейтинге — эвикция стоит */
  catalogSuspiciousAt: string | null;
  /** записей каталога отброшено гардом слагов (последний обход) */
  catalogSkippedBadEntries: number;
  /** последняя ИСПОЛНИВШАЯСЯ ночная фаза (сверка этот факт не трогает) */
  lastNightly: { ok: boolean; error?: string } | null;
  lastReconcileAt: string | null;
  lastNightlyAt: string | null;
  freshAsOf: string | null;
}

export function getHealth(db: Database, config: Config): HealthStatus {
  const repos = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
  const queue = {
    user: (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running') AND trigger_kind = 'user'").get() as { c: number }).c,
    rating: (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running') AND trigger_kind != 'user'").get() as { c: number }).c,
  };
  const oldestOf = (kind: string): number | null => {
    const row = db.query("SELECT MIN(created_at) AS t FROM jobs WHERE status = 'queued' AND trigger_kind = 'user' AND kind = ? AND created_at IS NOT NULL").get(kind) as { t: string | null };
    const age = row.t === null ? NaN : Date.now() - Date.parse(row.t);
    return Number.isFinite(age) ? Math.max(0, age) : null;
  };
  const userQueueOldestMs = { scan: oldestOf("scan"), summary: oldestOf("summary"), check: oldestOf("check") };
  const failed24h = (
    db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'failed' AND created_at > ?").get(new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as { c: number }
  ).c;
  const fresh = db
    .query("SELECT MAX(s.finished_at) AS f FROM scans s JOIN scores sc ON sc.scan_id = s.id WHERE s.finished_at IS NOT NULL AND sc.healthcraft_index IS NOT NULL")
    .get() as { f: string | null };

  const rescore = rescoreState(db);
  const suspiciousAt = getMetaValue(db, CATALOG_SUSPICIOUS_AT);
  const nightlyOkRaw = getMetaValue(db, SCHED_META.nightlyOk);
  const nightlyAt = getMetaValue(db, SCHED_META.nightlyAt);
  const nightlyError = getMetaValue(db, SCHED_META.nightlyError);

  const reasons: string[] = [];
  // сырые внутренние тексты (сообщения SQLite, фрагменты ответа платформы)
  // в публичном /api/health обрезаются: диагностика читается, а поверхность ограничена
  const safeHealthText = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  if (rescore.error !== null) {
    reasons.push(`стартовый пересчёт оценок упал: ${safeHealthText(rescore.error)}`);
  } else if (needsRescore(db)) {
    reasons.push(rescore.running ? "идёт стартовый пересчёт оценок (rescore pending)" : "стартовый пересчёт оценок не завершён (rescore pending)");
  }
  if (suspiciousAt !== null) {
    reasons.push(`обход каталога вернул пустой список при живом рейтинге (${suspiciousAt}) — эвикция приостановлена до живого снимка`);
  }
  if (nightlyOkRaw === "0") {
    reasons.push(`последняя ночная фаза обхода не удалась${nightlyError ? `: ${safeHealthText(nightlyError)}` : ""}`);
  }
  // метка тика есть, но устарела – rating-роль, вероятно, мертва (исход ночной
  // фазы этого не покажет: там хранится последний успех). Нет метки – нет и
  // утверждения «не тикал»: свежий деплой или роль web без планировщика
  const schedTickAt = getMetaValue(db, SCHED_META.tickAt);
  if (schedTickAt !== null) {
    const ageMs = Date.now() - Date.parse(schedTickAt);
    if (Number.isFinite(ageMs) && ageMs > SCHED_STALE_AFTER_MS) {
      reasons.push(`планировщик не тикал ${Math.round(ageMs / 60_000)} минут — похоже, rating-роль не работает`);
    }
  }
  const nowMs = Date.now();
  // сверка краснеет, если ошибка записана, а последняя успешная сверка старше
  // двух интервалов (или ее не было). Одиночный сбой внутри двух интервалов – не красное.
  const reconcileError = getMetaValue(db, SCHED_META.reconcileError);
  if (reconcileError !== null) {
    const lastOk = getMetaValue(db, SCHED_META.reconcileAt);
    const okAge = lastOk === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(lastOk);
    if (!(okAge <= 2 * config.scheduler.catalogIntervalMs)) {
      reasons.push(
        `сверка каталога не удается ${lastOk === null ? "с запуска" : `${Math.round(okAge / 60_000)} минут`}: ${safeHealthText(reconcileError)}`,
      );
    }
  }
  // без серверного токена планировщик молча стоял бы
  if (getMetaValue(db, SCHED_META.noTokenAt) !== null) {
    reasons.push("у планировщика нет серверного токена SourceCraft — обход каталога и периодические анализы не идут");
  }
  // «running» с истекшим лизом – процесс умер или цикл событий стоял дольше лиза;
  // задание дольше худшего бюджета скана – зависло
  const nowIso = new Date(nowMs).toISOString();
  const expired = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'running' AND lease_until < ?").get(nowIso) as { c: number }).c;
  if (expired > 0) reasons.push(`заданий в работе с истекшим лизом: ${expired} — их процесс не отвечает`);
  const stuckSince = new Date(nowMs - worstCaseScanMs(config.scan)).toISOString();
  const stuck = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'running' AND claimed_at < ?").get(stuckSince) as { c: number }).c;
  if (stuck > 0) reasons.push(`заданий в работе дольше худшего бюджета скана: ${stuck} — похоже, зависли`);
  // пользовательская полоса стоит: есть давняя заявка, а метки user-стороны
  // лупа нет или она устарела (роль web не запущена или мертва)
  const oldestUser = db
    .query("SELECT MIN(created_at) AS t FROM jobs WHERE status = 'queued' AND trigger_kind = 'user' AND created_at IS NOT NULL")
    .get() as { t: string | null };
  if (oldestUser.t !== null && nowMs - Date.parse(oldestUser.t) > USER_LANE_STALE_MS) {
    const userTick = getMetaValue(db, SCHED_META.userTickAt);
    const userTickAge = userTick === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(userTick);
    if (!(userTickAge <= SCHED_STALE_AFTER_MS)) {
      reasons.push("пользовательская очередь стоит: анализы ждут, а обслуживающая роль не тикает");
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    repos,
    llmProvider: config.llm.provider,
    queue,
    userQueueOldestMs,
    failedJobs24h: failed24h,
    rescore,
    catalogSuspiciousAt: suspiciousAt,
    catalogSkippedBadEntries: Number(getMetaValue(db, "catalog_skipped_bad_entries") ?? "0") || 0,
    lastNightly:
      nightlyAt === null
        ? null
        : nightlyOkRaw === "0"
          ? { ok: false, error: nightlyError ?? "catalog walk failed" }
          : { ok: true },
    lastReconcileAt: getMetaValue(db, SCHED_META.reconcileAt),
    lastNightlyAt: nightlyAt,
    freshAsOf: fresh.f,
  };
}
