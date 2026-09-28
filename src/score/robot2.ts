// Отделение роботов и синхронизаций от работы людей (docs/guide/method/robustness.md#roboty).
// Детектора «ровных интервалов» здесь нет сознательно: он ловил синки, но
// пропускал ботов и ложно срабатывал на ровных человеческих сериях.
// 1) burst-коллапс — ≥10 коммитов внутри скользящего окна 2 с по COMMITTER-датам
//    → всем sync=true, но только если и author-даты окна лежат в пределах окна
//    (сгенерированный всплеск). Ребейз с любым числом авторов и импорт зеркала
//    сохраняют разнесенные author-даты — это работа людей, она считается по датам автора;
// 2) author-паттерны — [bot], bot@, -bot, dependabot/renovate/allcontributors
//    + noreply-домены → robot.
// Флаги совместимы: коммит может быть robot=true И sync=true; оба исключаются из
// частоты и свежести. Старые robot-флаги в фактах compute игнорирует — источник
// истины здесь. Сырье (author+committer+обе даты) в фактах хранится полностью.
import { NOREPLY_DOMAINS, ROBOT_EMAILS, ROBOT_NAME_MARKERS } from "./model";

/** ширина скользящего окна burst-коллапса */
export const BURST_WINDOW_MS = 2_000;
/** минимум коммитов в окне для коллапса */
export const BURST_MIN_COMMITS = 10;

export interface CommitActor {
  author: { name: string; email: string; date?: string };
  committer: { name: string; email: string; date?: string };
}

export interface Robot2Flags {
  robot: boolean;
  sync: boolean;
  reasons: string[];
}

/** Email-локальная часть оканчивается на «bot» с разделителем: bot@, 42-bot@, x_bot@ (не «abot@»). */
function localEndsWithBot(email: string): boolean {
  const local = email.toLowerCase().split("@")[0] ?? "";
  return /(?:^|[.+_\d-])bot$/.test(local);
}

/** Паттерн робота по имени/емейлу автора, не коммиттера. */
export function isRobotAuthor(authorName: string, authorEmail: string): boolean {
  const n = (authorName ?? "").toLowerCase();
  const e = (authorEmail ?? "").toLowerCase();
  for (const marker of ROBOT_NAME_MARKERS) {
    if (n.includes(marker) || e.includes(marker)) return true;
  }
  if (localEndsWithBot(e)) return true;
  // точное совпадение: поддомены (`users.noreply.github.com`) — не роботы
  if (ROBOT_EMAILS.includes(e)) return true;
  const domain = e.split("@")[1] ?? "";
  if (domain && NOREPLY_DOMAINS.includes(domain)) return true;
  return false;
}

/**
 * Кто стоит за коммитом окна. Ни число авторов, ни чужой коммиттер синк не
 * доказывают: ребейз общей ветки и зеркало (импорт чужой истории) — тоже работа
 * людей. Синк — только сгенерированный всплеск: author-даты окна лежат в пределах того же окна.
 */
export interface BurstActor {
  author: string;
  committer: string;
  /** author-дата (мс); null — не разобрана */
  authorTs?: number | null;
}

export function isSyncWindow(actors: BurstActor[]): boolean {
  // author-даты всех коммитов окна разобраны и лежат в пределах окна:
  // 1000 пустых коммитов за секунду схлопываются
  const ts = actors.map((a) => a.authorTs).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return ts.length === actors.length && ts.length > 0 && Math.max(...ts) - Math.min(...ts) <= BURST_WINDOW_MS;
}

/**
 * Burst-коллапс: скользящее окно шириной BURST_WINDOW_MS по committer-датам;
 * окно с ≥BURST_MIN_COMMITS коммитами → все его коммиты sync=true. Невалидные
 * даты не участвуют (не создают искусственных скоплений на ts=0).
 * bursts — число связных групп помеченных коммитов.
 */
export function burstSyncFlags(committerTs: (number | null)[], actors?: BurstActor[]): { flags: boolean[]; bursts: number } {
  const flags = new Array<boolean>(committerTs.length).fill(false);
  const valid = committerTs
    .map((ts, i) => ({ ts, i }))
    .filter((x): x is { ts: number; i: number } => x.ts !== null && Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts || a.i - b.i);
  if (valid.length < BURST_MIN_COMMITS) return { flags, bursts: 0 };
  let j = 0;
  for (let i = 0; i < valid.length; i++) {
    if (j < i) j = i;
    while (j + 1 < valid.length && valid[j + 1]!.ts - valid[i]!.ts <= BURST_WINDOW_MS) j++;
    if (j - i + 1 >= BURST_MIN_COMMITS) {
      const window = valid.slice(i, j + 1);
      if (actors && !isSyncWindow(window.map((v) => actors[v.i]!))) continue;
      for (const v of window) flags[v.i] = true;
    }
  }
  // группы = связные компоненты помеченных коммитов: разрыв > окна → новый burst
  let bursts = 0;
  let prevFlaggedTs: number | null = null;
  for (const v of valid) {
    if (!flags[v.i]) continue;
    if (prevFlaggedTs === null || v.ts - prevFlaggedTs > BURST_WINDOW_MS) bursts++;
    prevFlaggedTs = v.ts;
  }
  return { flags, bursts };
}

/**
 * Флаги {robot, sync} для каждого события ленты (activity.git.timeline.events);
 * флаги совместимы, оба исключают коммит из частоты и свежести.
 */
export function robot2Flags(events: CommitActor[]): { flags: Robot2Flags[]; bursts: number } {
  const ts = events.map((e) => {
    const raw = e.committer.date;
    if (typeof raw !== "string" || raw === "") return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  });
  const actors = events.map((e) => {
    const at = typeof e.author.date === "string" && e.author.date !== "" ? Date.parse(e.author.date) : Number.NaN;
    return {
      author: (e.author.email || e.author.name || "").toLowerCase(),
      committer: (e.committer.email || e.committer.name || "").toLowerCase(),
      authorTs: Number.isNaN(at) ? null : at,
    };
  });
  const { flags: syncFlags, bursts } = burstSyncFlags(ts, actors);
  const flags = events.map((e, i) => {
    const robot = isRobotAuthor(e.author.name, e.author.email);
    const sync = syncFlags[i] === true;
    const reasons: string[] = [];
    if (robot) reasons.push("author-pattern");
    if (sync) reasons.push("burst-sync");
    return { robot, sync, reasons };
  });
  return { flags, bursts };
}
