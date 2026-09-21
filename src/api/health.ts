// health.ts — честный /api/health (В4.4, кластер B код-аудита): ok —
// ВЫЧИСЛЯЕМОЕ, а не литерал. Красные причины: (а) pending/ошибка стартового
// рескора, (б) подозрительно пустой каталог (эвикция приостановлена),
// (в) последняя ночная фаза с ok:false. Состояние планировщика — в meta
// (кросс-процессно: rating-роль пишет, web-роль читает); HTTP-статус всегда
// 200 — здоровье читают по телу, а гард тестового харнесса ждёт порт.
// Чистая функция чтения: тесты без HTTP.
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
  /** В4.8.5 (К8.5.5b): время последней УСПЕШНОЙ ночной фазы — ключ успеха; nightlyAt значит «попытка» */
  nightlyOkAt: "sched_nightly_ok_at",
  /** В4.8.5 (К8.5.5c, С8-4): последняя ошибка сверки и её время; успешная сверка их стирает */
  reconcileError: "sched_reconcile_error",
  reconcileErrorAt: "sched_reconcile_error_at",
  /** В4.8.5 (К8.5.5c, С8-10): тик каталога не нашёл серверного токена — время; тик с токеном стирает */
  noTokenAt: "sched_no_token_at",
  /** З6 (круг 2 В4.4): метка живого тика rating-воркер-лупа (пишет только rating-сторона).
   *  В4.8.5 (С10-3): тик `busy` пишет её, только пока текущее задание в пределах худшего бюджета скана. */
  tickAt: "sched_tick_at",
  /** В4.8.5 (К8.5.5c, С10-5): та же метка пользовательской стороны лупа (роль web/all) */
  userTickAt: "sched_user_tick_at",
} as const;

/** В4.8.5 (С10-5): пользовательская заявка ждёт дольше этого при мёртвой (или не запущенной) user-стороне — health краснеет. */
export const USER_LANE_STALE_MS = 30 * 60_000;

/** З6 (круг 2 В4.4): метка тика планировщика старше этого порога — rating-роль
 *  вероятно мертва (таймеры стоят), health обязан краснеть, а не лгать зелёным.
 *  Порог оспариванию в приёмке не подлежит. */
export const SCHED_STALE_AFTER_MS = 30 * 60_000;

/** meta-ключ гарда пустого каталога (кластер D). */
export const CATALOG_SUSPICIOUS_AT = "catalog_suspicious_at";

export interface HealthStatus {
  ok: boolean;
  /** красные причины человекочитаемо; пусто = здоров */
  reasons: string[];
  repos: number;
  llmProvider: string;
  queue: { user: number; rating: number };
  failedJobs24h: number;
  /** прогресс асинхронного рескора (кластер A) */
  rescore: RescoreState;
  /** обход вернул пустой каталог при живом рейтинге — эвикция стоит */
  catalogSuspiciousAt: string | null;
  /** записей каталога отброшено гардом слагов (последний обход) */
  catalogSkippedBadEntries: number;
  /** последняя ИСПОЛНИВШАЯСЯ ночная фаза (К-Р5: сверка этот факт не трогает) */
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
  // S-5 (круг 2 В4.4): сырые внутренние тексты (SQLite-сообщения, фрагменты
  // ответа платформы) в публичном /api/health капятся — диагностика читается,
  // поверхность ограничена (секретов там нет — сверено аудитом)
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
  // З6 (круг 2 В4.4): метка тика есть, но стареет — rating-роль, вероятно,
  // мертва (в разводке web/rating её смерть раньше оставалась зелёной:
  // sched_last_nightly_ok хранил последний УСПЕХ). Нет метки — нет и
  // утверждения «не тикал» (свежий деплой / роль web без планировщика)
  const schedTickAt = getMetaValue(db, SCHED_META.tickAt);
  if (schedTickAt !== null) {
    const ageMs = Date.now() - Date.parse(schedTickAt);
    if (Number.isFinite(ageMs) && ageMs > SCHED_STALE_AFTER_MS) {
      reasons.push(`планировщик не тикал ${Math.round(ageMs / 60_000)} минут — похоже, rating-роль не работает`);
    }
  }
  const nowMs = Date.now();
  // В4.8.5 (К8.5.5c, С8-4): сбой часовой сверки больше не прячется — ошибка
  // записана, а последняя успешная сверка старше двух интервалов (или её не
  // было вовсе). Одиночный сбой внутри двух интервалов — не красное.
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
  // С8-10: тик каталога не нашёл серверного токена — планировщик молча стоял бы
  if (getMetaValue(db, SCHED_META.noTokenAt) !== null) {
    reasons.push("у планировщика нет серверного токена SourceCraft — обход каталога и периодические анализы не идут");
  }
  // С10-3 / К8.5.2b: задание «running» с истекшим лизом — его процесс умер или
  // цикл событий стоял дольше лиза; задание дольше худшего бюджета скана — зависло
  const nowIso = new Date(nowMs).toISOString();
  const expired = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'running' AND lease_until < ?").get(nowIso) as { c: number }).c;
  if (expired > 0) reasons.push(`заданий в работе с истекшим лизом: ${expired} — их процесс не отвечает`);
  const stuckSince = new Date(nowMs - worstCaseScanMs(config.scan)).toISOString();
  const stuck = (db.query("SELECT COUNT(*) AS c FROM jobs WHERE status = 'running' AND claimed_at < ?").get(stuckSince) as { c: number }).c;
  if (stuck > 0) reasons.push(`заданий в работе дольше худшего бюджета скана: ${stuck} — похоже, зависли`);
  // С10-5: пользовательская полоса стоит — есть давняя заявка, а метки
  // user-стороны лупа нет или она устарела (роль web не запущена или мертва)
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
