// Признаки ритма коммитов для проверки на накрутку. Ровность интервалов и всплеск
// считает КОД по полной ленте событий, а флаггер (LLM) получает готовые числа одним
// фактом `activity.rhythm` — измеримое не отдается модели. Кто робот — решает
// robot2, как и в Score: robot — паттерн автора, sync — всплеск.
// Роботы и всплески — сильные признаки, флаг по ним ставит код без модели
// (hardFlagFactors); ровный ритм и всплеск недели — пороги, при которых флаг
// ставится до вызова модели, а модель лишь добавляет улики (ruleFlagFactors).
// Пороги — в fraud-thresholds.ts (их же берет текст улик на карточке).
// Соотношение авторов и коммиттеров признаком не является: ребейз и зеркало — работа людей.
import { robotIntervalFlags } from "../collectors/git";
import { robot2Flags, type CommitActor } from "../score/robot2";
import {
  recentSpikeHigh,
  regularHigh,
  robotShareHigh,
  ROBOT_RULE_MIN_COMMITS,
  syncHigh,
  RECENT_BASELINE_MIN,
  RECENT_SPIKE_MIN,
  RECENT_SPIKE_RATIO_WEAK,
  REGULAR_INTERVAL_MAX_MINUTES,
  REGULAR_SHARE_WEAK,
  ROBOT_SHARE_WEAK,
} from "./fraud-thresholds";

/** Ключ синтетического факта: во входе флаггера и в факторах флага. */
export const RHYTHM_KEY = "activity.rhythm";

/** Окно «последней недели» для всплеска перед замером. */
export const RECENT_WINDOW_DAYS = 7;
/** Сколько недель до окна берется для обычного недельного темпа. */
export const BASELINE_WEEKS = 12;
/** Окно детектора ровных серий: последние N коммитов людей (детектор квадратичен, см. ниже). */
export const REGULAR_WINDOW = 2000;

const DAY_MS = 24 * 3600_000;

export interface RhythmSignals {
  /** все события ленты */
  commits: number;
  /** коммиты людей: robot2 — не робот и не всплеск синхронизации */
  human_commits: number;
  /** robot2: автор похож на робота (dependabot, [bot], noreply-домены) */
  robot_commits: number;
  /** robot2: коммиты внутри всплесков синхронизации */
  sync_commits: number;
  sync_bursts: number;
  /** разных авторов среди коммитов людей */
  authors: number;
  /** доля коммитов людей в сериях из 6+ коммитов с ровными интервалами (±20% от медианы серии) среди последних REGULAR_WINDOW; null — меньше 6 коммитов */
  regular_share: number | null;
  /** медианный интервал между коммитами людей, минуты; null — меньше 2 коммитов */
  interval_median_minutes: number | null;
  /** коммиты людей за последние 7 дней до замера */
  recent_week_commits: number;
  /** медиана коммитов людей в неделю за 12 недель до этого окна */
  baseline_week_median: number;
  /** первый и последний коммит людей (дата автора) */
  first_human_at: string | null;
  last_human_at: string | null;
}

interface TimelineEvent extends CommitActor {
  sha?: string;
}

function tsOf(raw: string | undefined): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Признаки ритма по полной ленте (`activity.git.timeline.events`) на дату
 * замера `asOf` (окончание скана). Порядок событий не важен — считается по
 * датам. Пустая лента → null: проверка не проводится.
 */
export function rhythmSignals(events: TimelineEvent[], asOf: Date): RhythmSignals | null {
  if (events.length === 0) return null;
  const { flags, bursts } = robot2Flags(events);
  let robot = 0;
  let sync = 0;
  const human: { author: string; ts: number | null }[] = [];
  events.forEach((e, i) => {
    const f = flags[i]!;
    if (f.robot) robot++;
    if (f.sync) sync++;
    if (f.robot || f.sync) return;
    human.push({ author: (e.author.email || e.author.name || "").toLowerCase(), ts: tsOf(e.author.date) });
  });

  const stamps = human.map((h) => h.ts).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let k = 1; k < stamps.length; k++) intervals.push(stamps[k]! - stamps[k - 1]!);
  // серии ровных интервалов (≥6 подряд, ±20% от медианы серии): из Score детектор
  // убран за ложные срабатывания, но как признак накрутки годится. На «почти ровной»
  // ленте (как раз паттерн накрутки) он квадратичен — поэтому считаем по окну
  const window = stamps.slice(-REGULAR_WINDOW);
  const regular = window.length >= 6 ? robotIntervalFlags(window.map((ts) => ({ ts }))).filter(Boolean).length : null;

  const end = asOf.getTime();
  const recentFrom = end - RECENT_WINDOW_DAYS * DAY_MS;
  const recent = stamps.filter((t) => t > recentFrom && t <= end).length;
  const weeks: number[] = [];
  for (let w = 0; w < BASELINE_WEEKS; w++) {
    const hi = recentFrom - w * 7 * DAY_MS;
    const lo = hi - 7 * DAY_MS;
    weeks.push(stamps.filter((t) => t > lo && t <= hi).length);
  }

  return {
    commits: events.length,
    human_commits: human.length,
    robot_commits: robot,
    sync_commits: sync,
    sync_bursts: bursts,
    authors: new Set(human.map((h) => h.author)).size,
    regular_share: regular === null ? null : round2(regular / window.length),
    interval_median_minutes: intervals.length > 0 ? Math.round(median(intervals) / 60_000) : null,
    recent_week_commits: recent,
    baseline_week_median: median(weeks),
    first_human_at: stamps.length > 0 ? new Date(stamps[0]!).toISOString() : null,
    last_human_at: stamps.length > 0 ? new Date(stamps[stamps.length - 1]!).toISOString() : null,
  };
}

/**
 * Фактор флага, поставленного кодом: ключ факта и машинный код причины
 * (`robot_share>=0.8`). Текст для человека строит fraudFactorFact по признакам;
 * код причины читают лог и тесты.
 */
export interface RuleFactor {
  key: typeof RHYTHM_KEY;
  note: string;
}

/** Факт `activity.rest`, который гейтит правило роботов: живой проект с релизами и PR — не накрутка. */
export interface RestEvidence {
  releases?: unknown;
  pulls_open?: unknown;
  pulls_created_at?: unknown;
  [other: string]: unknown;
}

/** В REST видна жизнь проекта: есть релизы или запросы на слияние. */
function restAlive(rest: RestEvidence | null | undefined): boolean {
  if (rest === null || rest === undefined || typeof rest !== "object") return false;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(rest.releases) > 0 || n(rest.pulls_open) > 0 || (Array.isArray(rest.pulls_created_at) && rest.pulls_created_at.length > 0);
}

/**
 * Сильные признаки — флаг ставит код, модель не зовется:
 * - роботы составляют ROBOT_SHARE_FLAG истории и больше при истории от
 *   ROBOT_RULE_MIN_COMMITS коммитов и без признаков жизни в REST (боты
 *   зависимостей в живом проекте с релизами и PR — не накрутка);
 * - всплески синхронизации (10+ коммитов за 2 секунды по обеим датам) от
 *   SYNC_BURSTS_FLAG штук или от SYNC_SHARE_FLAG доли истории: один всплеск —
 *   ребейз с переписанными датами или принятый чужой PR, его взвешивает модель.
 * Пусто — решает модель.
 */
export function hardFlagFactors(s: RhythmSignals, rest?: RestEvidence | null): RuleFactor[] {
  const out: RuleFactor[] = [];
  if (s.commits >= ROBOT_RULE_MIN_COMMITS && robotShareHigh(s.robot_commits, s.commits) && !restAlive(rest)) {
    out.push({ key: RHYTHM_KEY, note: "robot_share>=0.8" });
  }
  if (syncHigh(s.sync_bursts, s.sync_commits, s.commits)) {
    out.push({ key: RHYTHM_KEY, note: "sync_bursts>=2|sync_share>=0.1" });
  }
  return out;
}

/**
 * Пороги: при таких числах флаг ставится до вызова модели, модель только
 * добавляет улики. Ровный ритм — REGULAR_SHARE_FLAG коммитов людей и больше идут
 * как по таймеру при интервале не длиннее REGULAR_INTERVAL_MAX_MINUTES (коммит
 * раз в день — ритм человека); всплеск недели — RECENT_SPIKE_MIN коммитов и больше
 * при обычном темпе от RECENT_BASELINE_MIN и в RECENT_SPIKE_RATIO раз ниже.
 */
/**
 * Слабые сигналы — ниже порогов, но повод позвать модель: ровность от
 * REGULAR_SHARE_WEAK при коротком интервале, один всплеск синхронизации, роботы от
 * ROBOT_SHARE_WEAK без жизни в REST, всплеск недели от RECENT_SPIKE_RATIO_WEAK×
 * темпа. Пусто — модель не зовется, ответ «подозрений нет» пишет код.
 */
export function weakSignals(s: RhythmSignals, rest?: RestEvidence | null): string[] {
  const out: string[] = [];
  if (s.regular_share !== null && s.regular_share >= REGULAR_SHARE_WEAK && s.interval_median_minutes !== null && s.interval_median_minutes <= REGULAR_INTERVAL_MAX_MINUTES) {
    out.push("regular_share>=0.3");
  }
  if (s.sync_bursts > 0) out.push("sync_bursts>=1");
  if (s.commits >= ROBOT_RULE_MIN_COMMITS && s.robot_commits / s.commits >= ROBOT_SHARE_WEAK && !restAlive(rest)) out.push("robot_share>=0.5");
  if (s.baseline_week_median >= RECENT_BASELINE_MIN && s.recent_week_commits >= RECENT_SPIKE_MIN && s.recent_week_commits >= RECENT_SPIKE_RATIO_WEAK * s.baseline_week_median) {
    out.push("recent_week>=3x_baseline");
  }
  return out;
}

export function ruleFlagFactors(s: RhythmSignals): RuleFactor[] {
  const out: RuleFactor[] = [];
  if (regularHigh(s.regular_share, s.interval_median_minutes)) out.push({ key: RHYTHM_KEY, note: "regular_share>=0.5" });
  if (recentSpikeHigh(s.recent_week_commits, s.baseline_week_median)) out.push({ key: RHYTHM_KEY, note: "recent_week>=5x_baseline" });
  return out;
}
