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
import { hardFlagFactors, rhythmSignals, ruleFlagFactors, RHYTHM_KEY } from "../src/summary/rhythm";
import { fraudCheckStale, fraudFactorFact, fraudFactorTitle, fraudFactorValue, fraudNoteText, fraudStaleText } from "../src/web/format";
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
  test("скрытая накрутка: ровный ритм виден числами, хотя robot2 роботов не видит; авторы и коммиттеры не сравниваются", () => {
    const s = rhythmSignals(subtle(), AS_OF)!;
    expect(s.robot_commits).toBe(0);
    expect(s.sync_bursts).toBe(0);
    expect(s.human_commits).toBe(60);
    expect(s.authors).toBe(5);
    expect(s).not.toHaveProperty("committers");
    expect(s).not.toHaveProperty("authors_via_one_committer");
    expect(s).not.toHaveProperty("foreign_committer_share");
    expect(s).not.toHaveProperty("platform_commits");
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

  test("обычный проект: неровный ритм, роботов и всплесков нет", () => {
    const s = rhythmSignals(honest(), AS_OF)!;
    expect(s.robot_commits).toBe(0);
    expect(s.sync_bursts).toBe(0);
    expect(s.authors).toBe(3);
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

/** Дневник: 30 коммитов по одному в день в случайное время 9–11 утра — ритм человека. */
function daily(): Ev[] {
  const out: Ev[] = [];
  for (let i = 0; i < 30; i++) out.push(ev(i, "me@diary.io", "me@diary.io", AS_OF.getTime() - (i + 1) * DAY + 9 * 60 * MIN + ((i * 37) % 120) * MIN));
  return newestFirst(out);
}

describe("правила кода: сильные признаки — флаг без модели, пороги — флаг до ответа модели", () => {
  test("роботы от 80% истории (как hc-fraud-explicit: 600 из 606) — флаг кодом, если REST не показывает жизни", () => {
    const s = { ...rhythmSignals(honest(), AS_OF)!, commits: 606, human_commits: 6, robot_commits: 600 };
    expect(hardFlagFactors(s).map((f) => f.note)).toEqual(["robot_share>=0.8"]);
    expect(hardFlagFactors(s, { contributors: 1, releases: 0, pulls_open: 0, pulls_created_at: [] }).map((f) => f.note)).toEqual(["robot_share>=0.8"]);
    // живой проект на ботах зависимостей: релизы или PR в REST — не флаг кодом, взвешивает модель
    expect(hardFlagFactors(s, { releases: 2, pulls_open: 0, pulls_created_at: [] })).toEqual([]);
    expect(hardFlagFactors(s, { releases: 0, pulls_open: 0, pulls_created_at: ["2026-09-01T00:00:00Z"] })).toEqual([]);
    expect(hardFlagFactors(s, { releases: 0, pulls_open: 1 })).toEqual([]);
  });

  test("роботы: история короче 20 коммитов — не флаг кодом (1 dependabot из 1, 4 из 5)", () => {
    const base = rhythmSignals(honest(), AS_OF)!;
    expect(hardFlagFactors({ ...base, commits: 1, human_commits: 0, robot_commits: 1 })).toEqual([]);
    expect(hardFlagFactors({ ...base, commits: 5, human_commits: 1, robot_commits: 4 })).toEqual([]);
    expect(hardFlagFactors({ ...base, commits: 20, human_commits: 4, robot_commits: 16 }).map((f) => f.note)).toEqual(["robot_share>=0.8"]);
    expect(hardFlagFactors({ ...base, commits: 20, human_commits: 5, robot_commits: 15 })).toEqual([]);
  });

  test("всплески синхронизации: от 2 всплесков или от 10% истории — флаг кодом; один маленький — модели", () => {
    const s = rhythmSignals(explicit(), AS_OF)!;
    expect(s.robot_commits / s.commits).toBeLessThan(0.8);
    expect(hardFlagFactors(s).map((f) => f.note)).toEqual(["sync_bursts>=2|sync_share>=0.1"]);
    expect(hardFlagFactors({ ...s, sync_bursts: 0, sync_commits: 0 })).toEqual([]);
    // один всплеск в 12 коммитов на историю в 500 (2%) — ребейз или принятый чужой PR, не флаг кодом
    expect(hardFlagFactors({ ...s, commits: 500, sync_bursts: 1, sync_commits: 12 })).toEqual([]);
    // один всплеск, но это 20% истории — флаг
    expect(hardFlagFactors({ ...s, commits: 60, sync_bursts: 1, sync_commits: 12 }).map((f) => f.note)).toEqual(["sync_bursts>=2|sync_share>=0.1"]);
  });

  test("обычный проект и скрытая накрутка: сильных признаков нет — решает модель", () => {
    expect(hardFlagFactors(rhythmSignals(honest(), AS_OF)!)).toEqual([]);
    expect(hardFlagFactors(rhythmSignals(subtle(), AS_OF)!)).toEqual([]);
  });

  test("порог ровного ритма: от 50% при интервале не длиннее 4 часов; коммит раз в день — ритм человека", () => {
    const honestS = rhythmSignals(honest(), AS_OF)!;
    expect(ruleFlagFactors(honestS)).toEqual([]);
    expect(ruleFlagFactors(rhythmSignals(subtle(), AS_OF)!).map((f) => f.note)).toEqual(["regular_share>=0.5"]);
    expect(ruleFlagFactors({ ...honestS, regular_share: 0.49, interval_median_minutes: 30 })).toEqual([]);
    expect(ruleFlagFactors({ ...honestS, regular_share: 0.5, interval_median_minutes: 240 }).map((f) => f.note)).toEqual(["regular_share>=0.5"]);
    expect(ruleFlagFactors({ ...honestS, regular_share: 1, interval_median_minutes: 241 })).toEqual([]);
    const d = rhythmSignals(daily(), AS_OF)!;
    expect(d.regular_share).toBeGreaterThanOrEqual(0.5);
    expect(d.interval_median_minutes).toBeGreaterThan(240);
    expect(ruleFlagFactors(d)).toEqual([]);
  });

  test("порог всплеска недели: от 20 коммитов и в 5 раз выше темпа при темпе от 1", () => {
    const honestS = rhythmSignals(honest(), AS_OF)!;
    expect(ruleFlagFactors({ ...honestS, recent_week_commits: 25, baseline_week_median: 2 }).map((f) => f.note)).toEqual(["recent_week>=5x_baseline"]);
    // новый репозиторий без прошлой истории, дробная медиана, слабый всплеск — не порог
    expect(ruleFlagFactors({ ...honestS, recent_week_commits: 60, baseline_week_median: 0 })).toEqual([]);
    expect(ruleFlagFactors({ ...honestS, recent_week_commits: 20, baseline_week_median: 0.5 })).toEqual([]);
    expect(ruleFlagFactors({ ...honestS, recent_week_commits: 19, baseline_week_median: 1 })).toEqual([]);
    expect(ruleFlagFactors({ ...honestS, recent_week_commits: 25, baseline_week_median: 6 })).toEqual([]);
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

const SUBTLE_FLAG = '{"flag":true,"factors":[{"key":"activity.rhythm","note":"коммиты с ровными интервалами, всплеск за неделю"}]}';
const NO_FLAG = '{"flag":false,"factors":[]}';
const REST_FLAG = '{"flag":true,"factors":[{"key":"activity.rest","note":"1 участник и ни одного релиза"}]}';

describe("runFraudCheck: отдельная заявка по фактам скана", () => {
  test("вход флаггера — признаки ритма и activity.rest; сводки v1 и сырой ленты во входе нет", async () => {
    const db = freshDb();
    const scanId = seed(db, "subtle", subtle());
    const fake = recorder(SUBTLE_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "subtle", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(true);
    // порог ровного ритма сработал: флаг по правилам, фактор модели по тому же ключу не дублируется
    expect(res.flag).toEqual({ flag: true, factors: [{ key: RHYTHM_KEY, note: "regular_share>=0.5" }] });
    expect(fake.roles).toEqual(["flagger"]);
    const input = fake.flaggerInput[0]!;
    expect(input).toContain(`- ${RHYTHM_KEY}: `);
    expect(input).toContain('"regular_share":1');
    expect(input).not.toContain("authors_via_one_committer");
    expect(input).not.toContain("committers");
    expect(input).toContain("- activity.rest: ");
    expect(input).not.toContain("activity.git.summary");
    expect(input).not.toContain("activity.git.timeline");
    expect(input).not.toContain("dev0@team.io");
  });

  test("явная накрутка: всплески и роботы — флаг ставит код, модель не зовется, лимит не тратится", async () => {
    const db = freshDb();
    const scanId = seed(db, "explicit", explicit());
    const fake = recorder(NO_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "explicit", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(true);
    expect(res.answered).toBe(0);
    expect(fake.roles).toEqual([]);
    expect(res.flag).toEqual({ flag: true, factors: [{ key: RHYTHM_KEY, note: "sync_bursts>=2|sync_share>=0.1" }] });
    const note = JSON.parse((db.query("SELECT text FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").get(scanId) as { text: string }).text);
    expect(note.by).toBe("rules");
    expect(note.flag).toBe(true);
    const card = getRepoCard(db, "v52", "explicit", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(card.ai?.fraud?.flag).toBe(true);
  });

  test("порог кода сработал, модель отвечает «нет» — один вызов, ее ответ не снимает флаг", async () => {
    const db = freshDb();
    const scanId = seed(db, "stubborn", subtle());
    const fake = recorder(NO_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "stubborn", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(fake.roles).toEqual(["flagger"]);
    expect(res.ok).toBe(true);
    expect(res.answered).toBe(1);
    expect(res.flag).toEqual({ flag: true, factors: [{ key: RHYTHM_KEY, note: "regular_share>=0.5" }] });
    const note = JSON.parse((db.query("SELECT text FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").get(scanId) as { text: string }).text);
    expect(note.by).toBe("rules");
  });

  test("порог сработал, модель добавила улику по activity.rest — она идет после факторов правил", async () => {
    const db = freshDb();
    const scanId = seed(db, "enrich", subtle());
    const res = await runFraudCheck({ db, org: "v52", repo: "enrich", callLlm: recorder(REST_FLAG).call, agentBackoffMs: 0 }, { scanId });
    expect(res.flag).toEqual({
      flag: true,
      factors: [
        { key: RHYTHM_KEY, note: "regular_share>=0.5" },
        { key: "activity.rest", note: "1 участник и ни одного релиза" },
      ],
    });
  });

  test("порог сработал, провайдер упал — флаг по правилам все равно записан", async () => {
    const db = freshDb();
    const scanId = seed(db, "down", subtle());
    const call = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as CallLlm;
    const res = await runFraudCheck({ db, org: "v52", repo: "down", callLlm: call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(true);
    expect(res.flag).toEqual({ flag: true, factors: [{ key: RHYTHM_KEY, note: "regular_share>=0.5" }] });
    expect(db.query("SELECT 1 FROM ai_fails WHERE scan_id = ? AND role = 'flagger'").get(scanId)).toBeNull();
    const card = getRepoCard(db, "v52", "down", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(card.ai?.fraud?.flag).toBe(true);
    expect(card.ai?.check.failure).toBeNull();
  });

  test("порогов нет, провайдер упал — отказ, как раньше", async () => {
    const db = freshDb();
    const scanId = seed(db, "down2", honest());
    const call = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as CallLlm;
    const res = await runFraudCheck({ db, org: "v52", repo: "down2", callLlm: call, agentBackoffMs: 0 }, { scanId });
    expect(res.ok).toBe(false);
    expect(res.reason).toStartWith("модель:");
  });

  test("заметка по прежним правилам (хартия 6) — не кэш: проверка идет заново, карточка и рейтинг зовут ее устаревшей", async () => {
    const db = freshDb();
    const scanId = seed(db, "old", honest());
    const repoId = (db.query("SELECT id FROM repos WHERE repo_slug = 'old'").get() as { id: number }).id;
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'flagger', ?, '[]', '6', 'm', ?, 'public')").run(
      repoId,
      scanId,
      '{"flag":true,"factors":[{"key":"activity.rhythm","note":"5 авторов при одном коммиттере"}],"signals":{"commits":20,"authors_via_one_committer":5}}',
      AS_OF.toISOString(),
    );
    const before = getRepoCard(db, "v52", "old", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(before.ai?.fraud?.flag).toBe(true);
    expect(before.ai?.check.oldRules).toBe(true);
    expect(fraudCheckStale(before.ai?.check)).toBe(true);
    expect(fraudStaleText(before.ai?.check, null)).toBe("Проверка по прежним правилам, нужна новая.");
    const fake = recorder(NO_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "old", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(res.cached).toBeUndefined();
    expect(fake.roles).toEqual(["flagger"]);
    const after = getRepoCard(db, "v52", "old", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(after.ai?.fraud?.flag).toBe(false);
    expect(after.ai?.check.oldRules).toBe(false);
  });

  test("порогов нет — ответ модели «нет» принимается как есть", async () => {
    const db = freshDb();
    const scanId = seed(db, "honest", honest());
    const fake = recorder(NO_FLAG);
    const res = await runFraudCheck({ db, org: "v52", repo: "honest", callLlm: fake.call, agentBackoffMs: 0 }, { scanId });
    expect(fake.roles).toEqual(["flagger"]);
    expect(res.flag).toEqual({ flag: false, factors: [] });
    const note = JSON.parse((db.query("SELECT text FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").get(scanId) as { text: string }).text);
    expect(note.by).toBe("model");
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
  test("скрытая накрутка — ровный ритм; всплеск недели без прошлой истории не улика; авторов при коммиттере в тексте нет", () => {
    const s = rhythmSignals(subtle(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorTitle(RHYTHM_KEY)).toBe("Ритм коммитов");
    expect(fraudFactorFact(RHYTHM_KEY, s)).toBe("100% коммитов людей идут с ровными интервалами, обычно раз в 30 мин");
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, recent_week_commits: 25, baseline_week_median: 2 })).toBe(
      "25 коммитов за последнюю неделю при обычных 2 в неделю; 100% коммитов людей идут с ровными интервалами, обычно раз в 30 мин",
    );
    // старая заметка с этим полем — поле игнорируется
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, authors_via_one_committer: 5 })).not.toContain("коммиттере");
    expect(fraudFactorFact("activity.git.summary", { commits: 10, robot_commits: 2, authors: 3, committers: 1 })).toBe("2 из 10 коммитов – от роботов (20%)");
  });

  test("явная накрутка — всплески синхронизации; роботы ниже 80% уликой не печатаются", () => {
    const s = rhythmSignals(explicit(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorFact(RHYTHM_KEY, s)).toBe("3 всплеска синхронизации (36 коммитов)");
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, commits: 606, robot_commits: 600 })).toStartWith("600 из 606 коммитов – от роботов (99%); ");
  });

  test("ниже порогов — null (печатается формулировка модели): «2 коммита за неделю при обычных 1» — не улика", () => {
    const s = rhythmSignals(honest(), AS_OF)! as unknown as Record<string, unknown>;
    expect(fraudFactorFact(RHYTHM_KEY, s)).toBeNull();
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, recent_week_commits: 2, baseline_week_median: 1, regular_share: 0.08, interval_median_minutes: 30 })).toBeNull();
    // ровно раз в день — ритм человека, не улика
    expect(fraudFactorFact(RHYTHM_KEY, { ...s, regular_share: 1, interval_median_minutes: 1440 })).toBeNull();
  });

  test("значение фактора: ритм — из заметки проверки, прочее — из фактов карточки", () => {
    const evidence = [{ key: "activity.rest", value: { contributors: 3 } }];
    expect(fraudFactorValue(RHYTHM_KEY, { commits: 1 }, evidence)).toEqual({ commits: 1 });
    expect(fraudFactorValue(RHYTHM_KEY, null, evidence)).toBeUndefined();
    expect(fraudFactorValue("activity.rest", { commits: 1 }, evidence)).toEqual({ contributors: 3 });
  });
});

describe("fraudNoteText: формулировка модели без машинных ключей", () => {
  test("старая заметка флаггера с «ключ=число» — словами, нулевые признаки накрутки из перечня опущены", () => {
    const note =
      "recent_week_commits=32 при baseline_week_median=0 и истории всего ~5 недель; regular_share=0, interval_median_minutes=10 мин, sync_bursts=0, robot_commits=0, authors=4, releases=0, pulls_open=0";
    expect(fraudNoteText(note)).toBe(
      "32 коммита за последнюю неделю при обычном темпе 0 в неделю и истории всего ~5 недель; обычный интервал 10 мин, 4 автора, 0 релизов, 0 открытых запросов на слияние",
    );
  });

  test("ненулевой признак накрутки остается; неизвестный ключ и обычный текст — как есть; маркеры фактов убраны", () => {
    expect(fraudNoteText("robot_commits=5, sync_bursts=1")).toBe("5 коммитов от роботов, 1 всплеск синхронизации");
    expect(fraudNoteText("odd_key=3 и что-то еще")).toBe("odd_key=3 и что-то еще");
    expect(fraudNoteText("355 коммитов людей за 15 дней {f:activity.rhythm}")).toBe("355 коммитов людей за 15 дней");
  });

  test("заметка из одних нулей не пустеет; «минут» не дублируется", () => {
    expect(fraudNoteText("sync_bursts=0, robot_commits=0")).toBe("0 всплесков синхронизации, 0 коммитов от роботов");
    expect(fraudNoteText("regular_share=0 {f:activity.rhythm}")).toBe("0% коммитов с ровными интервалами");
    expect(fraudNoteText("interval_median_minutes=10 минут")).toBe("обычный интервал 10 мин");
  });
});
