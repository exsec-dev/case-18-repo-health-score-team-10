// Аудитория AI-текста. Публичный обзор строится только из 4 открытых
// категорий и видим всем; полный – из всех фактов и только зрителю с полным
// Score. Поле, которое рисует экран, проверяется на «равно источнику» и «без
// прав не раскрывается»; каждое значение enum – своя ветка и тест.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { AI_AUDIENCES, openDb, SCHEMA_VERSION, type AiAudience } from "../src/db";
import { getRepoCard } from "../src/api/repos";
import { getAiNotesHistory } from "../src/api/history";
import { renderRepoReport } from "../src/report/markdown";
import type { CallLlm, ChatMessage } from "../src/llm";
import { historyPoints, publicFactKey, runSummary, scopedFacts } from "../src/summary/pipeline";
import { NO_PAT_ACCESS, type AccessResult } from "../src/auth/access";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";

const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
/** Участник репо без прав на каналы (internal «свой» без CI и AppSec). */
const REPO_ONLY: AccessResult = { cicd: "denied", appsec: "denied", repo: "granted" };

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-v52-aud-"));
  dirs.push(dir);
  const db = openDb({ ...loadConfig(), dataDir: dir });
  dbs.push(db);
  return db;
}
const wrap = (db: Database) => ({ db, close: () => {} });

function seed(db: Database, repo: string, visibility = "public"): { repoId: number; scanId: number } {
  const repoId = seedRepo(wrap(db), { org: "v52", repo });
  db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, repoId);
  const scanId = seedScan(wrap(db), repoId, {
    facts: [
      ...cardFacts().filter((f) => f.key !== "cicd.runs"),
      { key: "cicd.runs", source: "rest:cicd", value: { total: 12, success: 9, green_streak: 3 } },
      { key: "appsec.findings", source: "rest:appsec", value: { total: 3, critical: 1, secrets_critical: false } },
    ],
  });
  seedScore(wrap(db), repoId, scanId, { total: 55 });
  return { repoId, scanId };
}

/** Фейк: текст роли помечает аудиторию входа, чтобы тест видел, какая версия куда доехала. */
function fake(): { call: CallLlm; seen: Map<string, string> } {
  const seen = new Map<string, string>();
  const texts: Record<string, string> = {
    documentation: "README покрывает установку {f:docs.presence}.",
    code: "TODO в коде — реальные задачи {f:code.todo}.",
    activity: "Проект коммитили 2 автора {f:activity.git.summary}.",
    issues: "Из 14 задач открыто 4 {f:issues.stats}.",
    cicd: "ПОЛНЫЙ-CICD конфиг CI объявляет шаги {f:cicd.configs}.",
    security: "ПОЛНЫЙ-SEC сканер нашел 3 находки {f:appsec.findings}.",
    overview: "Проект задокументирован {f:scores.summary}; специалист по коду отметил задачи {sp:code:1}.",
  };
  const call = (async (opts: { role?: string; messages: ChatMessage[] }) => {
    const role = opts.role ?? "";
    seen.set(role, opts.messages.map((m) => String(m.content)).join("\n"));
    return { text: texts[role] ?? "", toolCalls: [], finish: "stop", usage: null };
  }) as unknown as CallLlm;
  return { call, seen };
}

describe("схема 2.3: аудитория AI-текста", () => {
  test("колонки есть, прежние строки — 'full', значения перечисления — ровно public и full", () => {
    const db = freshDb();
    expect(SCHEMA_VERSION).toBe("2.4"); // поверх 2.3 – rating_snapshots
    const cols = (t: string) => new Set((db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    // 2.4: таблица снимков мест рейтинга (динамика позиции)
    expect(cols("rating_snapshots").has("taken_at")).toBe(true);
    expect(cols("rating_snapshots").has("rank")).toBe(true);
    expect(cols("rating_snapshots").has("score_index")).toBe(true);
    expect(cols("ai_notes").has("audience")).toBe(true);
    expect(cols("ai_fails").has("audience")).toBe(true);
    expect(cols("jobs").has("audience")).toBe(true);
    expect(cols("users").has("ai_unlock")).toBe(true);
    const { repoId, scanId } = seed(db, "legacy");
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at) VALUES (?, ?, 'overview', 'x', '[]', '1', 'm', '2026')").run(repoId, scanId);
    expect((db.query("SELECT audience FROM ai_notes").get() as { audience: string }).audience).toBe("full");
    expect([...AI_AUDIENCES]).toEqual(["public", "full"]);
  });
});

describe("публичный прогон: только открытые категории", () => {
  test("факт открыт публике — только 4 категории и не канал с правами", () => {
    expect(publicFactKey("docs.presence")).toBe(true);
    expect(publicFactKey("activity.git.summary")).toBe(true);
    expect(publicFactKey("issues.stats")).toBe(true);
    expect(publicFactKey("tree.stats")).toBe(true);
    expect(publicFactKey("cicd.configs")).toBe(false);
    expect(publicFactKey("cicd.runs")).toBe(false);
    expect(publicFactKey("appsec.findings")).toBe(false);
  });

  test("специалисты CI/CD и Безопасности не зовутся; во входе обзора нет фактов каналов; заметки — 'public'", async () => {
    const db = freshDb();
    const { scanId } = seed(db, "pub");
    const f = fake();
    const res = await runSummary({ db, org: "v52", repo: "pub", callLlm: f.call, agentBackoffMs: 0 }, { scanId, audience: "public" });
    expect([...f.seen.keys()].sort()).toEqual(["activity", "code", "documentation", "issues", "overview", "trajectory"].sort());
    const overviewIn = f.seen.get("overview")!;
    for (const k of ["cicd.configs", "cicd.runs", "appsec.findings", "ПОЛНЫЙ-"]) expect(overviewIn).not.toContain(k);
    expect(f.seen.get("trajectory")!).not.toContain('"cicd"');
    expect(f.seen.get("trajectory")!).not.toContain('"security"');
    const audiences = db.query("SELECT DISTINCT audience FROM ai_notes WHERE scan_id = ?").all(scanId) as { audience: string }[];
    expect(audiences).toEqual([{ audience: "public" }]);
    expect(res.notes).toBeGreaterThan(0);
  });

  test("scopedFacts и historyPoints: публичная аудитория не видит каналов, полная видит", () => {
    const db = freshDb();
    const { scanId } = seed(db, "scope");
    expect(scopedFacts(db, scanId, "overview", "public").map((f) => f.key)).not.toContain("appsec.findings");
    expect(scopedFacts(db, scanId, "overview", "full").map((f) => f.key)).toContain("appsec.findings");
    expect(scopedFacts(db, scanId, "cicd", "public")).toEqual([]);
    for (const p of historyPoints(db, scanId, "public")) {
      expect(Object.keys(p.categories).every((k) => ["documentation", "code", "activity", "issues"].includes(k))).toBe(true);
    }
  });

  test("кэш и регенерация — в пределах аудитории", async () => {
    const db = freshDb();
    const { scanId } = seed(db, "cache");
    await runSummary({ db, org: "v52", repo: "cache", callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience: "public" });
    const full = await runSummary({ db, org: "v52", repo: "cache", callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience: "full" });
    expect(full.cached).toBeUndefined();
    const again = await runSummary({ db, org: "v52", repo: "cache", callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience: "public" });
    expect(again.cached).toBe(true);
    await runSummary({ db, org: "v52", repo: "cache", callLlm: fake().call, agentBackoffMs: 0, cache: false }, { scanId, audience: "public" });
    expect((db.query("SELECT COUNT(*) AS c FROM ai_notes WHERE audience = 'full'").get() as { c: number }).c).toBeGreaterThan(0);
  });
});

async function seedBoth(db: Database, repo: string, visibility = "public"): Promise<number> {
  const { scanId } = seed(db, repo, visibility);
  for (const audience of ["public", "full"] as AiAudience[]) {
    await runSummary({ db, org: "v52", repo, callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience });
  }
  return scanId;
}

const noteText = (db: Database, audience: AiAudience, role: string): string =>
  (db.query("SELECT text FROM ai_notes WHERE audience = ? AND role = ?").get(audience, role) as { text: string }).text;

describe("видимость: карточка, история, документ", () => {
  test("аноним публичного репо — публичная версия, равная источнику; полного текста нет нигде в ответе", async () => {
    const db = freshDb();
    await seedBoth(db, "both");
    const anon = getRepoCard(db, "v52", "both", { access: NO_PAT_ACCESS })!;
    expect(anon.ai?.audience).toBe("public");
    expect(anon.ai?.overview?.text).toBe(noteText(db, "public", "overview"));
    expect(anon.ai?.specialists.map((n) => n.role).sort()).toEqual(["activity", "code", "documentation", "issues"]);
    expect(JSON.stringify(anon)).not.toContain("ПОЛНЫЙ-");
    const md = renderRepoReport(anon);
    expect(md).toContain(noteText(db, "public", "documentation"));
    expect(md).not.toContain("ПОЛНЫЙ-");
    const hist = getAiNotesHistory(db, "v52", "both", { access: NO_PAT_ACCESS })!;
    expect(hist).toMatchObject({ locked: false, audience: "public" });
    expect(JSON.stringify(hist)).not.toContain("ПОЛНЫЙ-");
  });

  test("зритель с полным Score — полная версия; нет полной — публичная", async () => {
    const db = freshDb();
    await seedBoth(db, "full");
    const open = getRepoCard(db, "v52", "full", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(open.ai?.audience).toBe("full");
    expect(open.ai?.specialists.find((n) => n.role === "security")?.text).toBe(noteText(db, "full", "security"));
    expect(getAiNotesHistory(db, "v52", "full", { access: OPEN })).toMatchObject({ locked: false, audience: "full" });
    const db2 = freshDb();
    const { scanId } = seed(db2, "onlypub");
    await runSummary({ db: db2, org: "v52", repo: "onlypub", callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience: "public" });
    const open2 = getRepoCard(db2, "v52", "onlypub", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(open2.ai?.audience).toBe("public");
    expect(open2.ai?.overview?.text).toBe(noteText(db2, "public", "overview"));
  });

  test("закрытый репо: участник без прав на каналы AI не получает — ни публичной, ни полной версии", async () => {
    const db = freshDb();
    await seedBoth(db, "priv", "private");
    const card = getRepoCard(db, "v52", "priv", { access: REPO_ONLY, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(card.ai).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain("ПОЛНЫЙ-");
    expect(getAiNotesHistory(db, "v52", "priv", { access: REPO_ONLY })).toMatchObject({ locked: true });
    const open = getRepoCard(db, "v52", "priv", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(open.ai?.audience).toBe("full");
  });
});

describe("обзор и проверка на накрутку — у каждой свой последний скан", () => {
  test("проверка на более новом скане не прячет обзор предыдущего", async () => {
    const db = freshDb();
    const { repoId, scanId } = seed(db, "split");
    await runSummary({ db, org: "v52", repo: "split", callLlm: fake().call, agentBackoffMs: 0 }, { scanId, audience: "public" });
    const newer = seedScan(wrap(db), repoId, { facts: cardFacts() });
    db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, 'flagger', ?, '[]', '2', 'm', '2026-09-25', 'public')").run(
      repoId,
      newer,
      JSON.stringify({ flag: false, factors: [], signals: { commits: 2 } }),
    );
    const card = getRepoCard(db, "v52", "split", { access: NO_PAT_ACCESS })!;
    expect(card.ai?.scanId).toBe(scanId);
    expect(card.ai?.overview?.text).toBe(noteText(db, "public", "overview"));
    expect(card.ai?.fraud).toMatchObject({ flag: false, signals: { commits: 2 } });
  });
});
