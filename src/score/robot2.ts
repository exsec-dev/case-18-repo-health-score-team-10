// robot2.ts — robot v2 (§7.2, Q18: интервальный слой ВЫРЕЗАН — v1
// ловил синки, но мимо ботов и с ФП на ровных человеческих сериях):
// 1) burst-коллапс — ≥10 коммитов внутри скользящего окна 2с по
//    COMMITTER-датам → всем sync=true (импорт-бурст зеркала);
// 2) author-паттерны — [bot], bot@, -bot, dependabot/renovate/
//    allcontributors + noreply-домены → robot.
// Robot-паттерн доминирует над sync в семантике, флаги совместимы:
// коммит может быть robot=true И sync=true; оба исключаются из
// частоты и freshness (compute игнорирует v1-флаги в фактах —
// истина robot2). Сырьё (author+committer+обе даты) в фактах полно.
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

/** Author-паттерн робота (§7.2): имя/емейл автора, не коммиттера. */
export function isRobotAuthor(authorName: string, authorEmail: string): boolean {
  const n = (authorName ?? "").toLowerCase();
  const e = (authorEmail ?? "").toLowerCase();
  for (const marker of ROBOT_NAME_MARKERS) {
    if (n.includes(marker) || e.includes(marker)) return true;
  }
  if (localEndsWithBot(e)) return true;
  // 4.2.0 (М1.7): точное совпадение — поддомены (`users.noreply.github.com`) не роботы
  if (ROBOT_EMAILS.includes(e)) return true;
  const domain = e.split("@")[1] ?? "";
  if (domain && NOREPLY_DOMAINS.includes(domain)) return true;
  return false;
}

/**
 * Burst-коллапс: скользящее окно шириной BURST_WINDOW_MS по
 * committer-датам (сортировка внутри); окно с ≥BURST_MIN_COMMITS
 * коммитами → все его коммиты sync=true. Невалидные даты в bursts
 * не участвуют (не создают искусственных скоплений на ts=0).
 * Возвращает {flags, bursts} — bursts = число максимальных burst-групп.
 */
export function burstSyncFlags(committerTs: (number | null)[]): { flags: boolean[]; bursts: number } {
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
      for (let k = i; k <= j; k++) flags[valid[k]!.i] = true;
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
 * Robot v2 по событиям таймлайна (activity.git.timeline.events):
 * {robot, sync} per-commit (совместимы; robot доминирует в семантике —
 * оба исключаются из частоты и freshness).
 */
export function robot2Flags(events: CommitActor[]): { flags: Robot2Flags[]; bursts: number } {
  const ts = events.map((e) => {
    const raw = e.committer.date;
    if (typeof raw !== "string" || raw === "") return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  });
  const { flags: syncFlags, bursts } = burstSyncFlags(ts);
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
