// dynamics.ts — справочные показатели динамики (4.4.0-hci, В5.5 тур 2):
// ТП-1 «стабильность CI в динамике» и ТП-9 «динамика создания и закрытия
// задач» (ТЗ §3.1, «рекомендуется»). Оба БЕЗ веса (`DISPLAY_ONLY` словаря
// подметрик): балл подметрики всегда null, в балл категории, индекс, полный
// Score и рекомендации они не входят (решение §2 «В5.5 — тур 2» п.3).
// Чистые функции от значений фактов; все числа — константы model.ts.
import {
  CI_STABILITY_DELTA,
  CI_STABILITY_MIN_WINDOW,
  CI_STABILITY_WINDOW,
  ISSUE_BACKLOG_STABLE_ABS,
  ISSUE_BACKLOG_STABLE_SHARE,
  ISSUE_BACKLOG_WINDOWS,
} from "./model";

/** Подметрика без веса: балл всегда null (как `SubmetricScore` compute.ts). */
export interface DisplaySubmetric {
  score: null;
  value: unknown;
  note?: string;
}

/** Заметка: факт собран сборщиком до 5 — нового поля нет, показатель «нет данных» (незнание). */
export const DYNAMICS_OLD_COLLECTOR = "older collector — no dynamics fields";
/** Заметка: трекер не ведется — тот же статус, что у категории, а не «0 динамики». */
export const DYNAMICS_TRACKER_UNUSED = "tracker not maintained";
/** Заметка: окна 90 дней не покрыты выборкой (список задач обрезан капом страниц) — незнание. */
export const DYNAMICS_TRUNCATED = "issue list truncated — 90-day window not covered";

export type CiTrend = "better" | "same" | "worse";

/** Значение стабильности CI: сравнение двух окон или «мало запусков». */
export type CiStabilityValue =
  | { trend: CiTrend; recent_share: number; previous_share: number; window: number }
  | { trend: null; few_runs: true; completed: number; needed: number };

/**
 * ТП-1: доля успешных у последних N завершенных запусков против N предыдущих.
 * `recentRuns` — лента факта (свежие первыми). Нет поля — null (сборщик до 5).
 */
export function ciStabilityValue(recentRuns: unknown): CiStabilityValue | null {
  if (!Array.isArray(recentRuns)) return null;
  const outcomes = recentRuns
    .map((r) => (r !== null && typeof r === "object" ? (r as { outcome?: unknown }).outcome : null))
    .filter((o): o is "success" | "failure" => o === "success" || o === "failure");
  const needed = 2 * CI_STABILITY_MIN_WINDOW;
  if (outcomes.length < needed) return { trend: null, few_runs: true, completed: outcomes.length, needed };
  const window = Math.min(CI_STABILITY_WINDOW, Math.floor(outcomes.length / 2));
  const shareOf = (xs: string[]): number => xs.filter((o) => o === "success").length / xs.length;
  const recent = shareOf(outcomes.slice(0, window));
  const previous = shareOf(outcomes.slice(window, 2 * window));
  const delta = recent - previous;
  // сравнение в целых процентах: двоичный шум (0,9 − 0,75) не двигает порог
  const deltaPct = Math.round(delta * 100);
  const thresholdPct = Math.round(CI_STABILITY_DELTA * 100);
  const trend: CiTrend = deltaPct >= thresholdPct ? "better" : deltaPct <= -thresholdPct ? "worse" : "same";
  return { trend, recent_share: recent, previous_share: previous, window };
}

/** Подметрика `cicd.stability` по факту запусков (`cicd.runs`). */
export function ciStability(runs: { recent_runs?: unknown } | undefined): DisplaySubmetric {
  if (runs === undefined) return { score: null, value: null, note: "runs no-data" };
  const value = ciStabilityValue(runs.recent_runs);
  return value === null ? { score: null, value: null, note: DYNAMICS_OLD_COLLECTOR } : { score: null, value };
}

export type BacklogDirection = "growing" | "stable" | "shrinking";

export interface BacklogValue {
  created: number;
  closed: number;
  balance: number;
  direction: BacklogDirection;
}

interface FlowWindow {
  from?: unknown;
  created?: unknown;
  closed?: unknown;
  instant?: unknown;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function flowWindows(stats: { flow?: unknown }): FlowWindow[] | null {
  const flow = stats.flow as { windows?: unknown } | null | undefined;
  if (!flow || typeof flow !== "object" || !Array.isArray(flow.windows)) return null;
  return flow.windows.filter((w): w is FlowWindow => w !== null && typeof w === "object");
}

/**
 * ТП-9: баланс «создано − закрыто» за 90 дней (3 последних окна потока) и
 * направление: «растет» / «стабилен» / «разбирается». Окно без счетчиков
 * (обрезка списка) — незнание, баланс не считается.
 */
export function backlogValue(windows: FlowWindow[]): BacklogValue | null {
  const last = windows.slice(-ISSUE_BACKLOG_WINDOWS);
  if (last.length < ISSUE_BACKLOG_WINDOWS || last.some((w) => !isCount(w.created) || !isCount(w.closed))) return null;
  const created = last.reduce((a, w) => a + (w.created as number), 0);
  const closed = last.reduce((a, w) => a + (w.closed as number), 0);
  const balance = created - closed;
  const band = Math.max(ISSUE_BACKLOG_STABLE_ABS, ISSUE_BACKLOG_STABLE_SHARE * (created + closed));
  const direction: BacklogDirection = Math.abs(balance) <= band ? "stable" : balance > 0 ? "growing" : "shrinking";
  return { created, closed, balance, direction };
}

/** Трекер не ведется — тот же признак, что у категории (`scoreIssues`: 0 открытых и 0 закрытых). */
function trackerUnused(stats: { open?: unknown; closed?: unknown }): boolean {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(stats.open) === 0 && n(stats.closed) === 0;
}

/** Подметрики `issues.backlog_trend` и `issues.monthly_flow` по факту `issues.stats`. */
export function issueDynamics(stats: { open?: unknown; closed?: unknown; flow?: unknown }): { backlog_trend: DisplaySubmetric; monthly_flow: DisplaySubmetric } {
  if (trackerUnused(stats)) {
    return {
      backlog_trend: { score: null, value: null, note: DYNAMICS_TRACKER_UNUSED },
      monthly_flow: { score: null, value: null, note: DYNAMICS_TRACKER_UNUSED },
    };
  }
  const windows = flowWindows(stats);
  if (windows === null) {
    return {
      backlog_trend: { score: null, value: null, note: DYNAMICS_OLD_COLLECTOR },
      monthly_flow: { score: null, value: null, note: DYNAMICS_OLD_COLLECTOR },
    };
  }
  const backlog = backlogValue(windows);
  const monthly = windows.map((w) => ({
    from: typeof w.from === "string" ? w.from : null,
    created: isCount(w.created) ? w.created : null,
    closed: isCount(w.closed) ? w.closed : null,
  }));
  return {
    backlog_trend: backlog === null ? { score: null, value: null, note: DYNAMICS_TRUNCATED } : { score: null, value: backlog },
    monthly_flow: { score: null, value: monthly },
  };
}
