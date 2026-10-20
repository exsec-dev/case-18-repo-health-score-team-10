// Производные метрики из фактов (без повторного клона): вход — карта kind → value
// только ОК-фактов (упавший канал compute уже заменил прошлыми данными), выход —
// сырые числа для модели и показа (mirror_likeness — только показ, без веса).
// Роботов и синки определяет robot2; старые robot-флаги в фактах игнорируются.
import { BUS_FACTOR_SHARE, BUS_FACTOR_WINDOW_DAYS, OLD_SHARE_MIN_BASE } from "./model";
import { robot2Flags } from "./robot2";

export interface TimelineEventValue {
  sha: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  robot?: boolean;
  robot_reasons?: string[];
}

export interface DerivedMetrics {
  // --- git-канал (null = канал no-data) ---
  humanCommits: number | null;
  commits90d: number | null;
  commits365d: number | null;
  /** commits/мес := commits_90d/3 (коммиты людей без синков, по датам автора) */
  commitsPerMonth: number | null;
  activeMonths: number | null;
  contributorsActive90d: number | null;
  /** ts последнего коммита человека (не sync, не robot) по дате автора — для свежести */
  lastHumanCommitTs: number | null;
  syncBursts: number | null;
  robotRatioV2: number | null;
  /** только показ: доля sync + authors/committers, без веса */
  mirrorLikeness: { sync_share: number; authors: number; committers: number } | null;
  /** авторы-люди: email коммитов (без адреса — имя) без robot/sync */
  contributorsTotal: number | null;
  /**
   * Bus factor — сколько авторов покрывают половину коммитов людей за окно;
   * нет коммитов в окне — null. Только показ, без веса.
   */
  busFactor: number | null;
  // --- issues ---
  staleShare: number | null;
  resolutionRatio: number | null;
  // --- code ---
  todoTotal: number | null;
  /** маркеров на KLOC (loc=null при дедлайне → null) */
  todoDensityPerKloc: number | null;
  oldShare: number | null;
  /**
   * Причина no-data для old_share, когда выборка TODO неполна (todo_note =
   * "incomplete" — обрыв `git cat-file`): доля старых маркеров требует полной выборки.
   */
  oldShareNoData: string | null;
  rootEntries: number | null;
  /**
   * Строки кода, по которым считается категория: `source_loc`, а у старых
   * фактов без этого поля — весь `loc`; null — не прочитаны
   */
  codeLoc: number | null;
  /** строки взяты из `loc` старого факта (поля `source_loc` нет) */
  codeLocLegacy: boolean;
  /**
   * Доля файлов тестов среди файлов кода. null и у фактов без `test_files`, и при
   * `test_files = 0`: «Тесты» — только бонус, их отсутствие балл не снижает
   */
  testShare: number | null;
  /** сборщик посчитал тесты, и непустых нет — показ «тестов нет» */
  testsNone: boolean;
  // --- rest ---
  pulls90d: number | null;
  releases12m: number | null;
}

const DAY_MS = 24 * 3600_000;

function tsOf(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function countRecent(dates: unknown[], now: Date, windowDays: number): number {
  const from = now.getTime() - windowDays * DAY_MS;
  return dates.filter((d) => {
    const t = tsOf(d);
    return t !== null && t >= from && t <= now.getTime() + DAY_MS;
  }).length;
}

/**
 * Читает activity.git.timeline, issues.stats, code.todo, tree.stats, activity.rest.
 */
export function deriveMetrics(ok: Map<string, unknown>, now: Date): DerivedMetrics {
  // --- git: robot2 отделяет коммиты людей ---
  const timeline = ok.get("activity.git.timeline") as { events?: TimelineEventValue[] } | undefined;
  const events = Array.isArray(timeline?.events) ? timeline!.events! : null;
  if (events) {
    const { flags, bursts } = robot2Flags(events);
    const humanTs: number[] = [];
    const humanEmails = new Set<string>();
    const activeMonth = new Set<string>();
    let syncCount = 0;
    let robotCount = 0;
    const authorsAll = new Set<string>();
    const committersAll = new Set<string>();
    events.forEach((e, i) => {
      const email = (e.author?.email ?? "").toLowerCase();
      if (email) authorsAll.add(email);
      const cEmail = (e.committer?.email ?? "").toLowerCase();
      if (cEmail) committersAll.add(cEmail);
      const excluded = flags[i]!.robot || flags[i]!.sync;
      if (flags[i]!.sync) syncCount++;
      if (flags[i]!.robot) robotCount++;
      const at = tsOf(e.author?.date);
      // дата автора из будущего не делает репо «свежим навсегда»
      if (excluded || at === null || at > now.getTime() + DAY_MS) return;
      humanTs.push(at);
      // автор без адреса (импорт, зеркало) — по имени, как в bus factor
      const who = email || (e.author?.name ?? "").toLowerCase();
      if (who) humanEmails.add(who);
      activeMonth.add(new Date(at).toISOString().slice(0, 7));
    });
    const from90 = now.getTime() - 90 * DAY_MS;
    const from365 = now.getTime() - 365 * DAY_MS;
    const commits90d = humanTs.filter((t) => t >= from90).length;
    const contributorsActive90d = new Set(
      events
        .map((e, i) => ({ e, f: flags[i]! }))
        .filter(({ e, f }) => {
          if (f.robot || f.sync) return false;
          const at = tsOf(e.author?.date);
          return at !== null && at >= from90 && at <= now.getTime() + DAY_MS;
        })
        .map(({ e }) => (e.author?.email ?? "").toLowerCase())
        .filter((x) => x !== ""),
    ).size;
    const lastHuman = humanTs.length ? Math.max(...humanTs) : null;
    // bus factor: авторы коммитов людей в окне по убыванию вклада,
    // накапливаем до доли BUS_FACTOR_SHARE
    const windowCommits = events
      .map((e, i) => ({ e, f: flags[i]! }))
      .filter(({ e, f }) => {
        if (f.robot || f.sync) return false;
        const at = tsOf(e.author?.date);
        return at !== null && at >= now.getTime() - BUS_FACTOR_WINDOW_DAYS * DAY_MS;
      })
      .map(({ e }) => (e.author?.email || e.author?.name || "").toLowerCase())
      .filter((x) => x !== "");
    let busFactor: number | null = null;
    if (windowCommits.length > 0) {
      const perAuthor = new Map<string, number>();
      for (const a of windowCommits) perAuthor.set(a, (perAuthor.get(a) ?? 0) + 1);
      const sorted = [...perAuthor.values()].sort((a, b) => b - a);
      let acc = 0;
      let need = 0;
      const threshold = Math.ceil(windowCommits.length * BUS_FACTOR_SHARE);
      for (const c of sorted) {
        acc += c;
        need++;
        if (acc >= threshold) break;
      }
      busFactor = need;
    }
    return {
      humanCommits: humanTs.length,
      commits90d,
      commits365d: humanTs.filter((t) => t >= from365).length,
      commitsPerMonth: commits90d / 3,
      activeMonths: activeMonth.size,
      contributorsActive90d,
      lastHumanCommitTs: lastHuman,
      syncBursts: bursts,
      robotRatioV2: events.length ? round3(robotCount / events.length) : null,
      mirrorLikeness: {
        sync_share: events.length ? round3(syncCount / events.length) : 0,
        authors: authorsAll.size,
        committers: committersAll.size,
      },
      contributorsTotal: humanEmails.size,
      busFactor,
      ...issuesCodeRest(ok, now),
    };
  }
  return {
    humanCommits: null,
    commits90d: null,
    commits365d: null,
    commitsPerMonth: null,
    activeMonths: null,
    contributorsActive90d: null,
    lastHumanCommitTs: null,
    syncBursts: null,
    robotRatioV2: null,
    mirrorLikeness: null,
    contributorsTotal: null,
    busFactor: null,
    ...issuesCodeRest(ok, now),
  };
}

/**
 * Закрытые задачи, которые идут в балл, — прожившие не меньше часа
 * (`closed_counted`); у старых фактов без этого поля — все закрытые.
 */
export function issuesClosedCounted(stats: { closed?: unknown; closed_counted?: unknown } | undefined | null): number | null {
  if (typeof stats?.closed_counted === "number") return stats.closed_counted;
  return typeof stats?.closed === "number" ? stats.closed : null;
}

function issuesCodeRest(ok: Map<string, unknown>, now: Date): Pick<DerivedMetrics, "staleShare" | "resolutionRatio" | "todoTotal" | "todoDensityPerKloc" | "oldShare" | "oldShareNoData" | "rootEntries" | "codeLoc" | "codeLocLegacy" | "testShare" | "testsNone" | "pulls90d" | "releases12m"> {
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown; closed_counted?: unknown; stale_90d?: unknown } | undefined;
  const open = typeof stats?.open === "number" ? stats.open : null;
  const closed = typeof stats?.closed === "number" ? stats.closed : null;
  const closedCounted = issuesClosedCounted(stats);
  const stale90 = typeof stats?.stale_90d === "number" ? stats.stale_90d : null;
  // открытых 0 при закрытых — «зависших нет» (данные, доля 0);
  // no-data только у пустого трекера (0/0 — отдельное правило категории)
  const staleShare =
    open !== null && open > 0 && stale90 !== null ? stale90 / open : open === 0 && closed !== null && closed > 0 ? 0 : null;
  // доля решенных — без мгновенно закрытых
  const resolutionRatio = open !== null && closedCounted !== null && open + closedCounted > 0 ? closedCounted / (open + closedCounted) : null;

  const todo = ok.get("code.todo") as { count?: unknown; fixme?: unknown; older_180d?: unknown; todo_files?: unknown; blamed_files?: unknown; todo_note?: unknown } | undefined;
  const count = typeof todo?.count === "number" ? todo.count : null;
  const fixme = typeof todo?.fixme === "number" ? todo.fixme : null;
  const older = typeof todo?.older_180d === "number" ? todo.older_180d : null;
  const todoTotal = count !== null && fixme !== null ? count + fixme : null;
  const tree = ok.get("tree.stats") as { top_level?: unknown[]; loc?: unknown; source_loc?: unknown; source_files?: unknown; test_files?: unknown; source_unread?: unknown } | undefined;
  // плотность — по строкам кода (`source_loc`); у старых фактов поля нет — весь LOC.
  // 0 прочитанных строк при непрочитанных файлах кода (больше лимита текста,
  // бинарные) — строки неизвестны (null), а не «0 строк»
  const unread = typeof tree?.source_unread === "number" && tree.source_unread > 0;
  const loc =
    typeof tree?.source_loc === "number"
      ? tree.source_loc === 0 && unread
        ? null
        : tree.source_loc
      : "source_loc" in (tree ?? {})
        ? null
        : typeof tree?.loc === "number"
          ? tree.loc
          : null;
  const todoDensityPerKloc = todoTotal !== null && loc !== null && loc > 0 ? (todoTotal / loc) * 1000 : null;
  const blamed = typeof todo?.blamed_files === "number" ? todo.blamed_files : null;
  // неполная выборка TODO (обрыв cat-file) → old_share no-data с причиной,
  // а не число по частичной выборке
  const todoIncomplete = todo?.todo_note === "incomplete";
  // 0 пометок при полной выборке — «старых нет» (доля 0); знаменатель не меньше
  // OLD_SHARE_MIN_BASE, чтобы одна старая пометка не обрушивала категорию
  const oldShare = todoIncomplete || todoTotal === null
    ? null
    : todoTotal === 0
      ? 0
      : older !== null && blamed !== null && blamed > 0
        ? older / Math.max(todoTotal, OLD_SHARE_MIN_BASE)
        : null;
  const oldShareNoData = todoIncomplete ? "todo sample incomplete (cat-file truncated) — old_share needs the full sample" : null;
  const rootEntries = Array.isArray(tree?.top_level) ? tree!.top_level!.length : null;
  // доля тестов — только если сборщик их считал (поле test_files) и код есть;
  // нет непустых тестов — подметрика вне расчета (она бонус), а не 0
  const testsCounted = typeof tree?.test_files === "number" && typeof tree?.source_files === "number" && tree.source_files > 0;
  const testShare = testsCounted && (tree!.test_files as number) > 0 ? (tree!.test_files as number) / (tree!.source_files as number) : null;
  const testsNone = testsCounted && tree!.test_files === 0;

  const rest = ok.get("activity.rest") as { pulls_created_at?: unknown; releases_released_at?: unknown } | undefined;
  const pulls90d = Array.isArray(rest?.pulls_created_at) ? countRecent(rest!.pulls_created_at!, now, 90) : null;
  const releases12m = Array.isArray(rest?.releases_released_at) ? countRecent(rest!.releases_released_at!, now, 365) : null;

  return { staleShare, resolutionRatio, todoTotal, todoDensityPerKloc, oldShare, oldShareNoData, rootEntries, codeLoc: loc, codeLocLegacy: tree !== undefined && tree !== null && !("source_loc" in tree), testShare, testsNone, pulls90d, releases12m };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
