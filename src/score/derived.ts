// derived.ts — derived-метрики §7.3 из фактов (без re-clone): вход =
// карта kind → value только ОК-фактов (bad-channel уже замещён stale-
// историей в compute), выход — сырые числа для score-модели и показа
// (mirror_likeness — показ, без веса). Robot-истина — robot2
// (v1-флаги в фактах игнорируются, Q18).
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
  /** commits/мес := commits_90d/3 (human не-sync, author-даты, §3) */
  commitsPerMonth: number | null;
  activeMonths: number | null;
  contributorsActive90d: number | null;
  /** ts последнего НЕ-sync НЕ-robot author-коммита (freshness) */
  lastHumanCommitTs: number | null;
  syncBursts: number | null;
  robotRatioV2: number | null;
  /** показ (§7.3): доля sync + authors/committers — без веса */
  mirrorLikeness: { sync_share: number; authors: number; committers: number } | null;
  // круг 2 (К5): признак «история только из синков» (Н10) снят вместе с правилом
  // «Активность — нет данных»: зеркала считаются по датам автора (robot2)
  /** авторы-люди (пол 0.2 у соло): email человеческих коммитов — 4.2.0 (М1.6) без robot/sync */
  contributorsTotal: number | null;
  /**
   * В5 (К5.9): bus factor — сколько авторов покрывают половину человеческих
   * коммитов за окно; нет коммитов в окне — null. Показ без веса.
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
   * К-Р14 (круг 2): причина no-data для old_share, когда выборка TODO
   * неполна (todo_note = "incomplete" — обрыв `git cat-file`): доля старых
   * маркеров опирается на полноту выборки и по частичной число не даёт.
   */
  oldShareNoData: string | null;
  rootEntries: number | null;
  /**
   * 4.3.0: строки кода, по которым считается категория — `source_loc` нового
   * сборщика, иначе весь `loc` фактов до правки М2.3; null — не прочитаны
   */
  codeLoc: number | null;
  /**
   * 4.3.0 (Р1): доля файлов тестов среди файлов кода. Круг 2 (В1): null и у
   * фактов без `test_files`, и при `test_files = 0` — «Тесты» только бонус
   */
  testShare: number | null;
  /** круг 2 (В1): сборщик 3 посчитал тесты, и непустых нет — показ «тестов нет» */
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
 * Карта kind → value ОК-фактов. Читает activity.git.timeline/summary,
 * issues.stats, code.todo, tree.stats, activity.rest.
 */
export function deriveMetrics(ok: Map<string, unknown>, now: Date): DerivedMetrics {
  // --- git: robot2 → human-множество ---
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
      // 4.2.0 (М1.11): дата автора из будущего не делает репо «свежим навсегда»
      if (excluded || at === null || at > now.getTime() + DAY_MS) return;
      humanTs.push(at);
      if (email) humanEmails.add(email);
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
    // bus factor: авторы человеческих коммитов окна по убыванию вклада,
    // накапливаем до BUS_FACTOR_SHARE суммарно (Классика T½; без веса)
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
 * 4.3.0 (Р2): закрытые задачи, которые идут в балл, — прожившие не меньше часа
 * (`closed_counted` сборщика 3); у фактов прежнего сборщика поля нет — все закрытые.
 */
export function issuesClosedCounted(stats: { closed?: unknown; closed_counted?: unknown } | undefined | null): number | null {
  if (typeof stats?.closed_counted === "number") return stats.closed_counted;
  return typeof stats?.closed === "number" ? stats.closed : null;
}

function issuesCodeRest(ok: Map<string, unknown>, now: Date): Pick<DerivedMetrics, "staleShare" | "resolutionRatio" | "todoTotal" | "todoDensityPerKloc" | "oldShare" | "oldShareNoData" | "rootEntries" | "codeLoc" | "testShare" | "testsNone" | "pulls90d" | "releases12m"> {
  // issues.stats
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown; closed_counted?: unknown; stale_90d?: unknown } | undefined;
  const open = typeof stats?.open === "number" ? stats.open : null;
  const closed = typeof stats?.closed === "number" ? stats.closed : null;
  const closedCounted = issuesClosedCounted(stats);
  const stale90 = typeof stats?.stale_90d === "number" ? stats.stale_90d : null;
  // 4.2.0 (М1.3): открытых 0 при закрытых — «зависших нет» (данные, доля 0);
  // no-data только у пустого трекера (0/0 — отдельное правило категории)
  const staleShare =
    open !== null && open > 0 && stale90 !== null ? stale90 / open : open === 0 && closed !== null && closed > 0 ? 0 : null;
  // 4.3.0 (Р2): доля решенных — без мгновенно закрытых
  const resolutionRatio = open !== null && closedCounted !== null && open + closedCounted > 0 ? closedCounted / (open + closedCounted) : null;

  // code.todo + tree.stats
  const todo = ok.get("code.todo") as { count?: unknown; fixme?: unknown; older_180d?: unknown; todo_files?: unknown; blamed_files?: unknown; todo_note?: unknown } | undefined;
  const count = typeof todo?.count === "number" ? todo.count : null;
  const fixme = typeof todo?.fixme === "number" ? todo.fixme : null;
  const older = typeof todo?.older_180d === "number" ? todo.older_180d : null;
  const todoTotal = count !== null && fixme !== null ? count + fixme : null;
  const tree = ok.get("tree.stats") as { top_level?: unknown[]; loc?: unknown; source_loc?: unknown; source_files?: unknown; test_files?: unknown; source_unread?: unknown } | undefined;
  // М2.3: плотность — по строкам кода (`source_loc`); у фактов до правки
  // сборщика поля нет — берется весь LOC, как раньше.
  // Круг 2 (К3, E3): 0 прочитанных строк при непрочитанных файлах кода
  // (больше лимита текста, бинарные) — строки неизвестны (null), не «0 строк»
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
  // К-Р14: неполная выборка TODO (обрыв cat-file) → old_share no-data с
  // причиной, а не число по частичной выборке
  const todoIncomplete = todo?.todo_note === "incomplete";
  // 4.2.0 (М1.4, М1.5): 0 пометок при полной выборке — «старых нет» (доля 0);
  // доля считается от не меньше OLD_SHARE_MIN_BASE пометок — одна старая
  // пометка не обрушивает категорию
  const oldShare = todoIncomplete || todoTotal === null
    ? null
    : todoTotal === 0
      ? 0
      : older !== null && blamed !== null && blamed > 0
        ? older / Math.max(todoTotal, OLD_SHARE_MIN_BASE)
        : null;
  const oldShareNoData = todoIncomplete ? "todo sample incomplete (cat-file truncated) — old_share needs the full sample" : null;
  const rootEntries = Array.isArray(tree?.top_level) ? tree!.top_level!.length : null;
  // Р1: доля тестов — только у фактов сборщика 3 (поле test_files) и при коде;
  // круг 2 (В1): нет непустых тестов — подметрика вне расчета (бонус), а не 0
  const testsCounted = typeof tree?.test_files === "number" && typeof tree?.source_files === "number" && tree.source_files > 0;
  const testShare = testsCounted && (tree!.test_files as number) > 0 ? (tree!.test_files as number) / (tree!.source_files as number) : null;
  const testsNone = testsCounted && tree!.test_files === 0;

  // activity.rest (событийные даты §7.4)
  const rest = ok.get("activity.rest") as { pulls_created_at?: unknown; releases_released_at?: unknown } | undefined;
  const pulls90d = Array.isArray(rest?.pulls_created_at) ? countRecent(rest!.pulls_created_at!, now, 90) : null;
  const releases12m = Array.isArray(rest?.releases_released_at) ? countRecent(rest!.releases_released_at!, now, 365) : null;

  return { staleShare, resolutionRatio, todoTotal, todoDensityPerKloc, oldShare, oldShareNoData, rootEntries, codeLoc: loc, testShare, testsNone, pulls90d, releases12m };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
