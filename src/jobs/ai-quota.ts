// Лимиты AI-действий и пароль неограниченного доступа.
// Учет — по строкам jobs в БД, а не в памяти процесса: память сбрасывается
// перезапуском и не видна другим репликам. Три слоя: на человека за скользящий
// час, на человека за сутки, на весь сервис за сутки; сутки — календарные МСК.
// Пользователи с паролем не расходуют общий лимит, у них свой аварийный потолок.
// Не списываются повтор по тому же скану (заявки нет) и заявки, где модель не
// расходовала кредиты (сбой до модели, провайдер не ответил); отказ валидатора
// списывается — вызовы модели уже сделаны.
import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AiActionLimits, AiConfig } from "../config";

export type AiAction = "overview" | "check";

/** Род заявки в jobs.kind для действия. */
export const AI_JOB_KIND: Record<AiAction, string> = { overview: "summary", check: "check" };

/**
 * Итог заявки «модель ответила, но ответ не прошел проверку» — кредиты
 * потрачены, заявка списывается. Прочие сбои (нет скана, клон, провайдер
 * недоступен) до модели не дошли или модель не ответила — не списываются.
 */
export const AI_REJECTED_ERRORS: Record<AiAction, string> = {
  overview: "AI-описание не сформировано: ни один блок не прошел проверку фактами",
  check: "Проверка оценки не сформирована: ответ модели не прошел проверку",
};

/**
 * Прежние тексты тех же итогов: заявки, записанные до смены формулировки,
 * по-прежнему списываются (иначе в сутки смены лимит отдал бы лишние попытки).
 */
const AI_REJECTED_LEGACY: Record<AiAction, string> = {
  // в прежнем тексте слово «прошел» писалось через U+0451; в исходнике этой
  // буквы нет, символ собирается кодом
  overview: `AI-описание не сформировано: ни один блок не прош${String.fromCharCode(0x451)}л проверку`,
  check: AI_REJECTED_ERRORS.check,
};

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** МСК — UTC+3 без перехода на летнее время. */
const MSK_OFFSET_MS = 3 * HOUR_MS;

/** Начало текущих календарных суток МСК. */
export function mskDayStart(now: Date): Date {
  const t = now.getTime() + MSK_OFFSET_MS;
  return new Date(Math.floor(t / DAY_MS) * DAY_MS - MSK_OFFSET_MS);
}

export interface QuotaWindow {
  used: number;
  limit: number;
}

export interface ActionQuota {
  action: AiAction;
  /** у пользователя действует пароль неограниченного доступа */
  unlocked: boolean;
  /** на человека за час; null — не ограничено (пароль) */
  hour: QuotaWindow | null;
  /** на человека за сутки; null — не ограничено (пароль) */
  day: QuotaWindow | null;
  /** общий на сервис за сутки: без пароля — общий лимит, с паролем — аварийный потолок; null — нет */
  global: QuotaWindow | null;
  /** когда освободится место в часовом окне (самая старая заявка окна + час); null — окно свободно */
  hourResetAt: string | null;
  /** начало следующих суток МСК — когда обнуляются суточные окна */
  dayResetAt: string;
}

/** Итог заявки, для которой нашелся готовый текст: заявка done, но лимит не списывается. */
export const AI_CACHED_NOTE = "текст этого анализа уже был – модель не вызывалась";

const CHARGED = `(status IN ('queued', 'running') OR (status = 'done' AND (error IS NULL OR error != '${AI_CACHED_NOTE}')) OR (status = 'failed' AND error IN (?, ?)))`;

function count(db: Database, sql: string, ...args: (string | number)[]): number {
  return (db.query(`SELECT COUNT(*) AS c FROM jobs WHERE ${sql}`).get(...args) as { c: number }).c;
}

/** Остаток лимитов действия для пользователя на момент `now`. */
export function aiQuota(db: Database, userId: number, action: AiAction, cfg: AiConfig, now: Date = new Date()): ActionQuota {
  const kind = AI_JOB_KIND[action];
  const rejected = AI_REJECTED_ERRORS[action];
  const legacy = AI_REJECTED_LEGACY[action];
  const limits: AiActionLimits = cfg[action];
  const unlocked = isUnlocked(db, userId, cfg);
  const hourFrom = new Date(now.getTime() - HOUR_MS).toISOString();
  const dayStart = mskDayStart(now);
  const dayFrom = dayStart.toISOString();
  const dayResetAt = new Date(dayStart.getTime() + DAY_MS).toISOString();

  const globalUsed = (unlockedJobs: 0 | 1): number =>
    count(db, `kind = ? AND user_id IS NOT NULL AND ai_unlocked = ? AND created_at >= ? AND ${CHARGED}`, kind, unlockedJobs, dayFrom, rejected, legacy);

  if (unlocked) {
    // аварийный потолок, общий для всех пользователей с паролем
    const cap = action === "overview" ? cfg.unlockedOverviewPerDay : cfg.unlockedCheckPerDay;
    return {
      action,
      unlocked,
      hour: null,
      day: null,
      global: { used: globalUsed(1), limit: cap },
      hourResetAt: null,
      dayResetAt,
    };
  }
  const hourUsed = count(db, `user_id = ? AND kind = ? AND created_at > ? AND ${CHARGED}`, userId, kind, hourFrom, rejected, legacy);
  const oldest =
    hourUsed === 0
      ? null
      : (db
          .query(`SELECT MIN(created_at) AS t FROM jobs WHERE user_id = ? AND kind = ? AND created_at > ? AND ${CHARGED}`)
          .get(userId, kind, hourFrom, rejected, legacy) as { t: string | null }).t;
  return {
    action,
    unlocked,
    hour: { used: hourUsed, limit: limits.perHour },
    day: { used: count(db, `user_id = ? AND kind = ? AND created_at >= ? AND ${CHARGED}`, userId, kind, dayFrom, rejected, legacy), limit: limits.perDay },
    global: { used: globalUsed(0), limit: limits.globalPerDay },
    hourResetAt: oldest === null ? null : new Date(Date.parse(oldest) + HOUR_MS).toISOString(),
    dayResetAt,
  };
}

export interface QuotaRefusal {
  code: "quota_hour" | "quota_day" | "quota_global";
  message: string;
  /** когда можно повторить */
  until: string;
}

const NOUN: Record<AiAction, string> = { overview: "AI-обзоров", check: "проверок активности" };

/** Отказ по лимиту или null. Порядок: общий (его не обойти ожиданием часа), сутки, час. */
export function quotaRefusal(q: ActionQuota): QuotaRefusal | null {
  const full = (w: QuotaWindow | null): boolean => w !== null && w.used >= w.limit;
  if (full(q.global)) {
    return {
      code: "quota_global",
      message: q.unlocked
        ? `Дневной потолок ${NOUN[q.action]} для доступа по паролю исчерпан – он обновится в 00:00 по Москве`
        : `Дневной лимит ${NOUN[q.action]} сервиса исчерпан – он обновится в 00:00 по Москве`,
      until: q.dayResetAt,
    };
  }
  if (full(q.day)) {
    return { code: "quota_day", message: `Ваш лимит ${NOUN[q.action]} на сегодня исчерпан (${q.day!.limit} в сутки) – он обновится в 00:00 по Москве`, until: q.dayResetAt };
  }
  if (full(q.hour)) {
    return { code: "quota_hour", message: `Ваш лимит ${NOUN[q.action]} на час исчерпан (${q.hour!.limit} в час) – попробуйте позже`, until: q.hourResetAt ?? q.dayResetAt };
  }
  return null;
}

// ---------- пароль неограниченного доступа ----------

/**
 * Отпечаток пароля в users.ai_unlock: сам пароль в БД не пишется. HMAC с ключом
 * APP_SECRET — по копии БД пароль не подобрать без секрета сервера.
 */
export function unlockFingerprint(password: string, key: string | null): string {
  return `hmac-sha256:${createHmac("sha256", key ?? "").update(password, "utf8").digest("hex")}`;
}

/** Отметка действует, только пока пароль в .env тот же: смена пароля отзывает все отметки. */
export function isUnlocked(db: Database, userId: number, cfg: Pick<AiConfig, "unlockPassword" | "unlockKey">): boolean {
  if (cfg.unlockPassword === null) return false;
  const row = db.query("SELECT ai_unlock FROM users WHERE id = ?").get(userId) as { ai_unlock: string | null } | null;
  return row?.ai_unlock != null && row.ai_unlock === unlockFingerprint(cfg.unlockPassword, cfg.unlockKey);
}

/** Проверка введенного пароля (сравнение за постоянное время); верный — отметка пользователю. */
export function tryUnlock(db: Database, userId: number, candidate: string, cfg: Pick<AiConfig, "unlockPassword" | "unlockKey">): boolean {
  if (cfg.unlockPassword === null) return false;
  const want = Buffer.from(unlockFingerprint(cfg.unlockPassword, cfg.unlockKey));
  const got = Buffer.from(unlockFingerprint(candidate, cfg.unlockKey));
  if (!timingSafeEqual(want, got)) return false;
  db.query("UPDATE users SET ai_unlock = ? WHERE id = ?").run(unlockFingerprint(cfg.unlockPassword, cfg.unlockKey), userId);
  return true;
}

export function clearUnlock(db: Database, userId: number): void {
  db.query("UPDATE users SET ai_unlock = NULL WHERE id = ?").run(userId);
}
