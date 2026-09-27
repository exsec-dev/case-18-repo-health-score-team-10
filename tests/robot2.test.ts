// Признак робота: burst-коллапс (скользящее окно 2с, ≥10 коммитов,
// committer-даты), author-паттерны ([bot], bot@, -bot, dependabot/renovate/
// allcontributors, noreply-домены), совместимость robot+sync, доминирование
// robot; производные метрики.
import { describe, expect, test } from "bun:test";
import { burstSyncFlags, isRobotAuthor, robot2Flags, BURST_MIN_COMMITS } from "../src/score/robot2";
import { deriveMetrics } from "../src/score/derived";

const HUMAN = { name: "Alice Dev", email: "alice@example.com" };
const BOT = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
const ev = (author: { name: string; email: string } = HUMAN, at: string, ct?: string) => ({
  author: { ...author, date: at },
  committer: { name: "C", email: "c@x.y", date: ct ?? at },
});

describe("burst-коллапс (скользящее окно 2с по committer-датам)", () => {
  test("10 коммитов в одной секунде → все sync", () => {
    const ts = Array.from({ length: 10 }, (_, i) => 1_000_000 + i * 100); // 0.9с размах
    const { flags, bursts } = burstSyncFlags(ts);
    expect(flags.every(Boolean)).toBe(true);
    expect(bursts).toBe(1);
  });

  test("9 коммитов → никто; скользящая цепочка → все", () => {
    expect(burstSyncFlags(Array.from({ length: BURST_MIN_COMMITS - 1 }, () => 5)).flags.some(Boolean)).toBe(false);
    // скользящая цепочка шагом 200мс: НИ одно окно не накрывает всё, но
    // каждое окно 2с захватывает ~11 соседей → все sync
    const ts = Array.from({ length: 40 }, (_, i) => i * 200);
    const { flags, bursts } = burstSyncFlags(ts);
    expect(flags.every(Boolean)).toBe(true);
    expect(bursts).toBe(1); // максимимальная группа одна (цепочка сцеплена)
  });

  test("окно 2с: 10 коммитов размахом ровно 2000мс → sync; 2100мс → нет", () => {
    expect(burstSyncFlags([0, ...Array.from({ length: 9 }, (_, i) => 2000 - i)]).flags.every(Boolean)).toBe(true);
    expect(burstSyncFlags([0, ...Array.from({ length: 9 }, (_, i) => 2100 - i)]).flags.some(Boolean)).toBe(false);
  });

  test("две отдельные burst-группы → 2 bursts, между ними чистые коммиты не тронуты", () => {
    const burst1 = Array.from({ length: 12 }, (_, i) => 1000 + i * 100);
    const gap = Array.from({ length: 3 }, (_, i) => 60_000 + i * 30_000);
    const burst2 = Array.from({ length: 11 }, (_, i) => 180_000 + i * 100);
    const { flags, bursts } = burstSyncFlags([...burst1, ...gap, ...burst2]);
    expect(bursts).toBe(2);
    const gapFlagged = gap.some((_, k) => flags[burst1.length + k]);
    expect(gapFlagged).toBe(false);
    expect(burst1.every((_, k) => flags[k])).toBe(true);
  });

  test("невалидные даты не создают burst на ts=0", () => {
    const ts: (number | null)[] = [null, null, null, null, null, null, null, null, null, null, null, null];
    expect(burstSyncFlags(ts).flags.some(Boolean)).toBe(false);
  });
});

describe("author-паттерны (§7.2)", () => {
  test("маркеры имён и noreply-домены", () => {
    expect(isRobotAuthor("dependabot[bot]", "x@y.z")).toBe(true);
    expect(isRobotAuthor("Renovate Bot", "ci@renovate.example")).toBe(true); // имя содержит «renovate»
    expect(isRobotAuthor("Deploy Unit", "bot@renovate.example")).toBe(true); // bot@-паттерн локальной части
    expect(isRobotAuthor("Some Bot", "some-bot@company.example")).toBe(true); // -bot
    expect(isRobotAuthor("release-bot", "rb@company.example")).toBe(true);
    // приватная почта GitHub — человек; бот на ней ловится маркером
    expect(isRobotAuthor("H", "49699333+user@users.noreply.github.com")).toBe(false);
    expect(isRobotAuthor("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBe(true);
    expect(isRobotAuthor("GitHub", "noreply@github.com")).toBe(true); // адрес автоматизации — точным совпадением
    expect(isRobotAuthor("H", "user@noreply.github.com")).toBe(true); // noreply-домен
    expect(isRobotAuthor("H", "user@github.com")).toBe(false); // сотрудник GitHub — не робот
    expect(isRobotAuthor("Alexey", "alexey@example.com")).toBe(false);
    expect(isRobotAuthor("Кирилл Боталов", "k@example.com")).toBe(false); // «бот» внутри слова не матчится
  });

  test("bot@-паттерн: локальная часть кончается на bot с разделителем (abot@ — нет)", () => {
    expect(isRobotAuthor("N", "bot@company.example")).toBe(true);
    expect(isRobotAuthor("N", "42-bot@company.example")).toBe(true);
    expect(isRobotAuthor("N", "abot@company.example")).toBe(false);
  });

  test("v1-кейс: dependabot от коммиттера «GitHub» — ловится author-паттерном; человек с sync-коммиттером — sync без robot", () => {
    const dependabot = {
      author: { name: "dependabot[bot]", email: "x@users.noreply.github.com", date: "2026-01-01T00:00:00Z" },
      committer: { name: "GitHub", email: "noreply@github.com", date: "2026-01-01T00:00:00Z" },
    };
    const { flags } = robot2Flags([dependabot]);
    expect(flags[0]!.robot).toBe(true);
    expect(flags[0]!.sync).toBe(false); // один коммит — не burst
  });
});

describe("robot2Flags: совместимость флагов и доминирование", () => {
  test("коммит может быть robot=true И sync=true (оба исключаются)", () => {
    const events = Array.from({ length: 12 }, () => ev(BOT, "2026-01-01T00:00:00Z"));
    const { flags } = robot2Flags(events);
    expect(flags.every((f) => f.robot && f.sync)).toBe(true);
    expect(flags[0]!.reasons).toEqual(["author-pattern", "burst-sync"]);
  });

  test("синк-бурст людей (зеркало): sync без robot; порядок флагов = порядок событий", () => {
    const events = [
      ev(HUMAN, "2026-01-01T00:00:00Z"),
      ...Array.from({ length: 10 }, (_, i) => ev(HUMAN, `2026-01-02T00:00:00.00${i}Z`)),
    ];
    const { flags, bursts } = robot2Flags(events);
    expect(bursts).toBe(1);
    expect(flags[0]!.sync).toBe(false); // одиночный ранний коммит вне окна
    expect(flags[0]!.robot).toBe(false);
    expect(flags.slice(1).every((f) => f.sync && !f.robot)).toBe(true);
  });
});

describe("derived §7.3 (robot2-истина, без re-clone)", () => {
  const NOW = new Date("2026-09-15T00:00:00Z");

  test("human-метрики: burst/robot исключены из частоты, freshness и contributors_90d", () => {
    const mk = (iso: string) => ev(HUMAN, iso);
    const humanRecent = [mk("2026-09-01T00:00:00Z"), mk("2026-08-20T00:00:00Z"), mk("2026-07-15T00:00:00Z")];
    const mirrorBurst = Array.from({ length: 12 }, (_, i) => ev({ name: "Upstream Author", email: `u${i}@up.example` }, "2026-09-10T00:00:00Z"));
    const bot = [ev(BOT, "2026-09-12T00:00:00Z")];
    const events = [...humanRecent, ...mirrorBurst, ...bot];
    const ok = new Map<string, unknown>([
      ["activity.git.timeline", { events }],
      ["activity.git.summary", { commits: events.length, authors: 14, committers: 1, robot_commits: 1, robot_ratio: 0.06 }],
    ]);
    const d = deriveMetrics(ok, NOW);
    expect(d.humanCommits).toBe(3); // 12 синков + 1 бот исключены
    expect(d.commits90d).toBe(3);
    expect(d.commitsPerMonth).toBe(1);
    expect(d.contributorsActive90d).toBe(1);
    expect(d.lastHumanCommitTs).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(d.syncBursts).toBe(1);
    expect(d.robotRatioV2).toBe(round3(1 / 16));
    expect(d.mirrorLikeness).toEqual({ sync_share: round3(12 / 16), authors: 14, committers: 1 });
    expect(d.contributorsTotal).toBe(1); // только люди — синки и бот не авторы
  });

  test("issues/code/rest derived + git no-data → git-поля null", () => {
    const ok = new Map<string, unknown>([
      ["issues.stats", { open: 10, closed: 5, stale_90d: 4 }],
      ["code.todo", { count: 21, fixme: 6, older_180d: 9, todo_files: 20, blamed_files: 20 }],
      ["tree.stats", { top_level: Array.from({ length: 17 }, (_, i) => ({ name: `d${i}`, type: "tree" })), loc: 9000 }],
      ["activity.rest", { pulls_created_at: ["2026-08-01T00:00:00Z", "2026-09-10T00:00:00Z", "2025-01-01T00:00:00Z"], releases_released_at: ["2026-01-01T00:00:00Z"] }],
    ]);
    const d = deriveMetrics(ok, NOW);
    expect(d.humanCommits).toBeNull();
    expect(d.mirrorLikeness).toBeNull();
    expect(d.staleShare).toBe(0.4);
    expect(d.resolutionRatio).toBe(5 / 15);
    expect(d.todoTotal).toBe(27);
    expect(d.todoDensityPerKloc).toBe(3); // 27/9000*1000
    expect(d.oldShare).toBe(9 / 27);
    expect(d.rootEntries).toBe(17);
    expect(d.pulls90d).toBe(2);
    expect(d.releases12m).toBe(1);
  });

  test("4.2.0 (М1.3, М1.4): open=0 при закрытых — «зависших нет»; 0 маркеров — «старых нет»", () => {
    const ok = new Map<string, unknown>([
      ["issues.stats", { open: 0, closed: 3, stale_90d: 0 }],
      ["code.todo", { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 }],
    ]);
    const d = deriveMetrics(ok, NOW);
    expect(d.staleShare).toBe(0);
    expect(d.resolutionRatio).toBe(1);
    expect(d.todoTotal).toBe(0);
    expect(d.oldShare).toBe(0);
    expect(d.todoDensityPerKloc).toBeNull();
  });
});

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
