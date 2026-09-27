// Флаггер – отдельная проверка на накрутку. Признаки ритма считает код
// (rhythm.ts) по полной ленте; модель получает их одним фактом
// `activity.rhythm`; обзор флаггер не зовет; кап ленты для специалистов берет
// свежие события.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getRepoCard } from "../src/api/repos";
import type { CallLlm, ChatMessage } from "../src/llm";
import { capTimelineFact, NO_RHYTHM_REASON, runFraudCheck, runSummary, TIMELINE_EVENTS_CAP } from "../src/summary/pipeline";
import { rhythmSignals, RHYTHM_KEY } from "../src/summary/rhythm";
import { fraudFactorFact, fraudFactorTitle, fraudFactorValue } from "../src/web/format";
import type { AccessResult } from "../src/auth/access";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";

const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const AS_OF = new Date("2026-09-24T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type Ev = { sha: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } };

function ev(i: number, author: string, committer: string, at: number, committedAt = at): Ev {
  return {
    sha: `s${i}`,
    author: { name: author.split("@")[0]!, email: author, date: new Date(at).toISOString() },
    committer: { name: committer.split("@")[0]!, email: committer, date: new Date(committedAt).toISOString() },
  };
}

/** Как `git log`: от новых к старым. */
const newestFirst = (events: Ev[]): Ev[] => [...events].sort((a, b) => Date.parse(b.committer.date) - Date.parse(a.committer.date));

/** Скрытая накрутка (как `hc-fraud-subtle`): 5 «авторов» на одного коммиттера, коммит каждые 30 минут. */
function subtle(): Ev[] {
  const out: Ev[] = [];
  const start = AS_OF.getTime() - 2 * DAY;
  for (let i = 0; i < 60; i++) out.push(ev(i, `dev${i % 5}@team.io`, "ops@team.io", start + i * 30 * MIN));
  return newestFirst(out);
}

/** Явная накрутка (как `hc-fraud-explicit`): боты и сгенерированные пачки внутри 2 секунд. */
function explicit(): Ev[] {
  const out: Ev[] = [];
  const t0 = AS_OF.getTime() - DAY;
  let i = 0;
  for (let b = 0; b < 3; b++) for (let k = 0; k < 12; k++) out.push(ev(i++, "gen@x.io", "gen@x.io", t0 + b * 3600_000 + k * 100));
  for (let k = 0; k < 20; k++) out.push(ev(i++, "dependabot[bot]@users.noreply.github.com", "noreply@github.com", t0 - (k + 1) * DAY));
  for (let k = 0; k < 4; k++) out.push(ev(i++, "alice@x.io", "alice@x.io", t0 - (k * 9 + 3) * DAY - k * 37 * MIN));
  return newestFirst(out);
}

/** Обычный проект: 3 автора с неровным ритмом за полгода и слияния платформы. */
function honest(): Ev[] {
  const out: Ev[] = [];
  const gaps = [3, 1, 7, 2, 11, 4, 1, 6, 9, 2, 5, 13, 1, 3, 8, 2, 4, 10, 6, 1];
  let at = AS_OF.getTime() - 170 * DAY;
  gaps.forEach((g, i) => {
    at += g * DAY + (i * 97 % 600) * MIN;
    out.push(ev(i, ["ann@p.org", "ben@p.org", "cy@p.org"][i % 3]!, i % 4 === 0 ? "noreply@github.com" : ["ann@p.org", "ben@p.org", "cy@p.org"][i % 3]!, at));
  });
  return newestFirst(out);
}

describe("rhythmSignals: признаки ритма считает код по полной ленте", () => {
  test("скрытая накрутка: ровный ритм и подставные авторы видны числами, хотя robot2 роботов не видит", () => {
    const s = rhythmSignals(subtle(), AS_OF)!;
    expect(s.robot_commits).toBe(0);
    expect(s.sync_bursts).toBe(0);
    expect(s.human_commits).toBe(60);
    expect(s.authors).toBe(5);
    expect(s.committers).toBe(1);
    expect(s.authors_via_one_committer).toBe(5);
    expect(s.foreign_committer_share).toBe(1);
    expect(s.regular_share).toBe(1);
    expect(s.interval_median_minutes).toBe(30);
    expect(s.recent_week_commits).toBe(60);
    expect(s.baseline_week_median).toBe(0);
  });

  test("явная накрутка: роботы и всплески синхронизации — по robot2", () => {
    const s = rhythmSignals(explicit(), AS_OF)!;
    expect(s.commits).toBe(60);
    expect(s.robot_commits).toBe(20);
    expect(s.sync_bursts).toBe(3);
    expect(s.sync_commits).toBe(36);
    expect(s.human_commits).toBe(4);
  });

  test("обычный проект: неровный ритм, слияния платформы не считаются чужим коммиттером", () => {
    const s = rhythmSignals(honest(), AS_OF)!;
    expect(s.robot_commits).toBe(0);
    expect(s.sync_bursts).toBe(0);
    expect(s.platform_commits).toBe(5);
    expect(s.committers).toBe(3);
    expect(s.foreign_committer_share).toBe(0);
    expect(s.authors_via_one_committer).toBe(0);
    expect(s.regular_share).toBe(0);
  });

  test("всплеск перед замером: последняя неделя против медианы 12 недель до нее", () => {
    const base: Ev[] = [];
    let i = 0;
    for (let w = 1; w <= 12; w++) for (let k = 0; k < 2; k++) base.push(ev(i++, "a@x.io", "a@x.io", AS_OF.getTime() - 7 * DAY - w * 7 * DAY + k * 2 * DAY + w * 13 * MIN));
    for (let k = 0; k < 25; k++) base.push(ev(i++, "a@x.io", "a@x.io", AS_OF.getTime() - DAY - k * 97 * MIN - (k % 3) * 11 * MIN));
    const s = rhythmSignals(newestFirst(base), AS_OF)!;
    expect(s.recent_week_commits).toBe(25);
    expect(s.baseline_week_median).toBe(2);
  });

  test("пустая лента — null (ритма нет, проверка не проводится)", () => {
    expect(rhythmSignals([], AS_OF)).toBeNull();
  });
});

describe("capTimelineFact: специалист видит СВЕЖИЕ события", () => {
  test("лента длиннее капа — остаются первые N (git log: от новых к старым)", () => {
    const events = Array.from({ length: TIMELINE_EVENTS_CAP + 40 }, (_, i) => ({ sha: `n${i}` }));
    const capped = capTimelineFact({ key: "activity.git.timeline", value: { events } }).value as { events: { sha: string }[]; total: number };
    expect(capped.events).toHaveLength(TIMELINE_EVENTS_CAP);
    expect(capped.events[0]!.sha).toBe("n0");
    expect(capped.events.at(-1)!.sha).toBe(`n${TIMELINE_EVENTS_CAP - 1}`);
    expect(capped.total).toBe(TIMELINE_EVENTS_CAP + 40);
  });
});

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  // БД закрываются до уборки: на Windows открытый файл дает EBUSY в rmSync
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-fraud-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}
const wrap = (db: Database) => ({ db, close: () => {} });

function seed(db: Database, repo: string, timeline: Ev[] | null): number {
  const repoId = seedRepo(wrap(db), { org: "v52", repo });
  const facts = cardFacts().filter((f) => f.key !== "activity.git.timeline");
  if (timeline !== null) facts.push({ key: "activity.git.timeline", source: "git", value: { events: timeline } });
  const scanId = seedScan(wrap(db), repoId, { facts, finishedAt: AS_OF.toISOString(), startedAt: AS_OF.toISOString() });
  seedScore(wrap(db), repoId, scanId, { total: 55 });
  return scanId;
}

/** Фейк модели: пишет, какие роли звались и что получил флаггер. */
function recorder(flagJson: string): { call: CallLlm; roles: string[]; flaggerInput: string[] } {
  const roles: string[] = [];
  const flaggerInput: string[] = [];
  const call = (async (opts: { role?: string; messages: ChatMessage[] }) => {
    roles.push(opts.role ?? "");
    if (opts.role === "flagger") flaggerInput.push(opts.messages.map((m) => String(m.content)).join("\n"));
    return { text: opts.role === "flagger" ? flagJson : "", toolCalls: [], finish: "stop", usage: null };
  }) as unknown as CallLlm;
  return { call, roles, flaggerInput };
}

const SUBTLE_FLAG = '{"flag":true,"factors":[{"key":"activity.rhythm","note":"5 авторов при одном коммиттере, коммиты с ровными интервалами"}]}';

describe("runFraudCheck: отдельная заявка по фактам скана", () => {
  test("вход флаггера — признаки ритма и activity.rest; сводки v1 и сырой ленты во входе нет", async () => {
    const db = freshDb();
    const scanId = seed(db, "subtle", subtle());
    const fake = recorder(SUBTLE_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "subtle", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(true);
    expect(res.flag).toMatchObject({ flag: true });
    expect(fake.roles).toEqual(["flagger"]);
    const input = fake.flaggerInput[0]!;
    expect(input).toContain(`- ${RHYTHM_KEY}: `);
    expect(input).toContain('"authors_via_one_committer":5');
    expect(input).toContain("- activity.rest: ");
    expect(input).not.toContain("activity.git.summary");
    expect(input).not.toContain("activity.git.timeline");
    expect(input).not.toContain("dev0@team.io");
  });

  test("повтор по тому же скану — из кэша, модель не зовется", async () => {
    const db = freshDb();
    const scanId = seed(db, "cache", subtle());
    const first = recorder(SUBTLE_FLAG);
    await runFraudCheck({ db, org: "v52", repo: "cache", callLlm: first.call, agentBackoffMs: 0 }, { scanId });
    const second = recorder(SUBTLE_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "cache", callLlm: second.call, agentBackoffMs: 0 }, { scanId });
    expect(res.cached).toBe(true);
    expect(second.roles).toEqual([]);
  });

  test("ленты нет — вызова нет, причина «не проводилась» в ai_fails", async () => {
    const db = freshDb();
    const scanId = seed(db, "empty", null);
    const fake = recorder(SUBTLE_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "empty", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(NO_RHYTHM_REASON);
    expect(fake.roles).toEqual([]);
    expect((db.query("SELECT reason FROM ai_fails WHERE scan_id = ? AND role = 'flagger'").get(scanId) as { reason: string }).reason).toBe(NO_RHYTHM_REASON);
  });

  test("обзор флаггер не зовет; заметка проверки не делает обзор «готовым» и переживает регенерацию", async () => {
    const db = freshDb();
    const scanId = seed(db, "split", subtle());
    await runFraudCheck({ db, org: "v52", repo: "split", callLlm: recorder(SUBTLE_FLAG).call, agentBackoffMs: 0 }, { scanId });
    const fake = recorder(SUBTLE_FLAG);
    const res = await runSummary({ db, org: "v52", repo: "split", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.cached).toBeUndefined();
    expect(fake.roles).not.toContain("flagger");
    expect(fake.roles.length).toBeGreaterThan(0);
    await runSummary({ db, org: "v52", repo: "split", callLlm: fake.call, agentBackoffMs: 0, cache: false }, { scanId });
    expect(db.query("SELECT 1 FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").get(scanId)).not.toBeNull();
  });

  test("карточка: признаки из заметки = признакам проверки; отказ и время проверки не смешиваются с обзором", async () => {
    const db = freshDb();
    const scanId = seed(db, "card", subtle());
    const res = await runFraudCheck({ db, org: "v52", repo: "card", callLlm: recorder(SUBTLE_FLAG).call, agentBackoffMs: 0 }, { scanId });
    const card = getRepoCard(db, "v52", "card", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(card.ai?.fraud?.signals).toEqual(res.signals as unknown as Record<string, unknown>);
    expect(card.ai?.generatedAt).toBeNull();
    const db2 = freshDb();
    const scan2 = seed(db2, "fail", null);
    await runFraudCheck({ db: db2, org: "v52", repo: "fail", callLlm: recorder(SUBTLE_FLAG).call, agentBackoffMs: 0 }, { scanId: scan2 });
    const card2 = getRepoCard(db2, "v52", "fail", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(card2.ai?.failures.map((f) => f.role)).not.toContain("flagger");
  });
});

describe("фактор «Ритм коммитов»: текст строит код из признаков", () => {
  test("скрытая накрутка — ровный ритм, подставные авторы, всплеск недели", () => {
    const s = rhythmSignals(subtle(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorTitle(RHYTHM_KEY)).toBe("Ритм коммитов");
    expect(fraudFactorFact(RHYTHM_KEY, s)).toBe(
      "100% коммитов людей идут с ровными интервалами, обычно раз в 30 мин; 5 авторов при одном коммиттере; 60 коммитов за последнюю неделю при обычных 0 в неделю",
    );
  });

  test("явная накрутка — роботы и всплески синхронизации", () => {
    const s = rhythmSignals(explicit(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorFact(RHYTHM_KEY, s)).toStartWith("20 из 60 коммитов – от роботов (33%); 3 всплеска синхронизации (36 коммитов)");
  });

  test("ничего заметного — null (печатается формулировка модели)", () => {
    const s = rhythmSignals(honest(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, recent_week_commits: 0 })).toBeNull();
  });

  test("значение фактора: ритм — из заметки проверки, прочее — из фактов карточки", () => {
    const evidence = [{ key: "activity.rest", value: { contributors: 3 } }];
    expect(fraudFactorValue(RHYTHM_KEY, { commits: 1 }, evidence)).toEqual({ commits: 1 });
    expect(fraudFactorValue(RHYTHM_KEY, null, evidence)).toBeUndefined();
    expect(fraudFactorValue("activity.rest", { commits: 1 }, evidence)).toEqual({ contributors: 3 });
  });
});
