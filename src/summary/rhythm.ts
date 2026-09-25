// rhythm.ts — признаки ритма коммитов для проверки на накрутку (В5.2, Б1;
// TASK.md §2 «В5.2 — публичный AI-обзор…» п.2). Закон 5 (tool-first): ровность
// интервалов, всплеск и подмену авторов считает КОД по полной ленте событий, а
// флаггер получает готовые числа одним фактом `activity.rhythm`. Раньше флаггер
// видел только `activity.git.summary` со счетчиком роботов v1 (интервальный слой,
// вырезанный из Score за ложные срабатывания) и помечал репо по этому счетчику.
// Робот-истина — robot2 (как в Score): robot — паттерн автора, sync — всплеск.
import { robotIntervalFlags } from "../collectors/git";
import { NOREPLY_DOMAINS, ROBOT_EMAILS } from "../score/model";
import { robot2Flags, type CommitActor } from "../score/robot2";

/** Ключ синтетического факта: во входе флаггера и в факторах флага. */
export const RHYTHM_KEY = "activity.rhythm";

/** Окно «последней недели» для всплеска перед замером. */
export const RECENT_WINDOW_DAYS = 7;
/** Сколько недель до окна берется для обычного недельного темпа. */
export const BASELINE_WEEKS = 12;
/** Окно детектора ровных серий: последние N коммитов людей (аудит надежности М10). */
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
  /** разных коммиттеров среди коммитов людей, без коммитов платформы (веб-слияния) */
  committers: number;
  /** коммиты людей, закоммиченные платформой (noreply@github.com) — обычные веб-слияния */
  platform_commits: number;
  /** доля коммитов людей (без платформы), где автор не совпадает с коммиттером; null — таких коммитов нет */
  foreign_committer_share: number | null;
  /** наибольшее число разных авторов, чьи коммиты закоммитил один и тот же человек (не сам автор) */
  authors_via_one_committer: number;
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

function isPlatformCommitter(email: string): boolean {
  const e = email.toLowerCase();
  if (ROBOT_EMAILS.includes(e)) return true;
  const domain = e.split("@")[1] ?? "";
  return domain !== "" && NOREPLY_DOMAINS.includes(domain);
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
 * датам. Пустая лента — null: ритма нет, проверка не проводится (tri-state).
 */
export function rhythmSignals(events: TimelineEvent[], asOf: Date): RhythmSignals | null {
  if (events.length === 0) return null;
  const { flags, bursts } = robot2Flags(events);
  let robot = 0;
  let sync = 0;
  const human: { author: string; committer: string; platform: boolean; ts: number | null }[] = [];
  events.forEach((e, i) => {
    const f = flags[i]!;
    if (f.robot) robot++;
    if (f.sync) sync++;
    if (f.robot || f.sync) return;
    const committer = (e.committer.email || e.committer.name || "").toLowerCase();
    human.push({
      author: (e.author.email || e.author.name || "").toLowerCase(),
      committer,
      platform: isPlatformCommitter(committer),
      ts: tsOf(e.author.date),
    });
  });

  const direct = human.filter((h) => !h.platform);
  const foreign = direct.filter((h) => h.author !== h.committer);
  const byCommitter = new Map<string, Set<string>>();
  for (const h of foreign) {
    const set = byCommitter.get(h.committer) ?? new Set<string>();
    set.add(h.author);
    byCommitter.set(h.committer, set);
  }
  const viaOne = Math.max(0, ...[...byCommitter.values()].map((s) => s.size));

  const stamps = human.map((h) => h.ts).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let k = 1; k < stamps.length; k++) intervals.push(stamps[k]! - stamps[k - 1]!);
  // серии ровных интервалов — тот же детектор, что был в robot v1 (≥6 подряд, ±20%
  // от медианы серии): для Score он вырезан, для подозрения на накрутку — признак
  // аудит надежности М10: детектор серий квадратичен на «почти ровной» ленте (ровно на
  // паттерне накрутки) — доля считается по последним REGULAR_WINDOW коммитам людей
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
    committers: new Set(direct.map((h) => h.committer)).size,
    platform_commits: human.length - direct.length,
    foreign_committer_share: direct.length > 0 ? round2(foreign.length / direct.length) : null,
    authors_via_one_committer: viaOne,
    regular_share: regular === null ? null : round2(regular / window.length),
    interval_median_minutes: intervals.length > 0 ? Math.round(median(intervals) / 60_000) : null,
    recent_week_commits: recent,
    baseline_week_median: median(weeks),
    first_human_at: stamps.length > 0 ? new Date(stamps[0]!).toISOString() : null,
    last_human_at: stamps.length > 0 ? new Date(stamps[stamps.length - 1]!).toISOString() : null,
  };
}
