// summary-b8.test.ts — фрод-флаггер (Б8 В5, К5.10): структурный флаг + факторы
// на показ (карточка, кабинет, MD-раздел «Подозрение на искусственную
// активность»); БЕЗ скидки Score и бампа MODEL_VERSION — прямые тесты.
// Нет LLM-вывода — нет флага; нет фактов активности — роль не запускается.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getRepoCard } from "../src/api/repos";
import { listMyRepos } from "../src/api/me";
import { renderRepoReport } from "../src/report/markdown";
import { MODEL_VERSION } from "../src/score/model";
import { runSummary } from "../src/summary/pipeline";
import type { CallLlm } from "../src/llm";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { NO_PAT_ACCESS, type AccessResult } from "../src/auth/access";

const OPEN: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}
const wrap = (db: Database) => ({ db, close: () => {} });

function seedFull(db: Database, repo = "flag"): number {
  const repoId = seedRepo(wrap(db), { org: "v5", repo });
  const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
  seedScore(wrap(db), repoId, scanId, { total: 55 });
  return scanId;
}

/** Фейк: тексты по ролям + флаг-JSON для flagger. */
function fakeWithFlagger(flagJson: string, validTexts: Record<string, string> = {}): CallLlm {
  return (async (opts: { role?: string }) => ({
    text: opts.role === "flagger" ? flagJson : (validTexts[opts.role ?? ""] ?? ""),
    toolCalls: [],
    finish: "stop",
    usage: null,
  })) as CallLlm;
}

const VALID_TEXTS: Record<string, string> = {
  documentation: "README покрывает установку {f:docs.presence}.",
  code: "TODO в коде — реальные задачи {f:code.todo}.",
  activity: "Проект коммитили 2 автора {f:activity.git.summary}.",
  issues: "Из 14 задач открыто 4 {f:issues.stats}.",
  cicd: "Конфиг CI объявляет шаги {f:cicd.configs}.",
  overview: "Проект имеет README и CI {f:docs.presence} {f:cicd.configs}; специалист по коду отметил задачи по долгу {sp:code:1}.",
};

const FLAG_TRUE = '{"flag":true,"factors":[{"key":"activity.git.summary","note":"ровные интервалы между коммитами"}]}';

describe("flagger в конвейере: структурный флаг, tri-state, fail-soft", () => {
  test("валидный флаг пишется заметкой role=flagger и возвращается в результате", async () => {
    const { db } = freshDb("rh-v5b8-ok-");
    const scanId = seedFull(db);
    const res = await runSummary({ db, org: "v5", repo: "flag", callLlm: fakeWithFlagger(FLAG_TRUE, VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    expect(res.flag).not.toBeNull();
    expect(res.flag?.flag).toBe(true);
    expect(res.flag?.factors[0]?.key).toBe("activity.git.summary");
    const row = db.query("SELECT text FROM ai_notes WHERE scan_id = ? AND role = 'flagger'").get(scanId) as { text: string };
    expect(JSON.parse(row.text)).toMatchObject({ flag: true });
    void dirs;
  });

  test("мусор вместо JSON после ретрая — failSoft, флага нет", async () => {
    const { db } = freshDb("rh-v5b8-bad-");
    const scanId = seedFull(db, "bad");
    const res = await runSummary({ db, org: "v5", repo: "bad", callLlm: fakeWithFlagger("Подозрений нет, проект честный.", VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    expect(res.flag).toBeNull();
    expect(res.failSoft).toContain("flagger");
    expect((db.query("SELECT COUNT(*) AS c FROM ai_notes WHERE role = 'flagger'").get() as { c: number }).c).toBe(0);
  });
});

describe("К5.10: флаг без скидки — Score и версия модели не меняются (прямой тест)", () => {
  test("флаг=true на отсканированном репо: строки scores идентичны до/после", async () => {
    const { db } = freshDb("rh-v5b8-score-");
    const scanId = seedFull(db, "score");
    const before = db.query("SELECT * FROM scores").all();
    const beforeVersion = (db.query("SELECT model_version FROM scores LIMIT 1").get() as { model_version: string }).model_version;
    await runSummary({ db, org: "v5", repo: "score", callLlm: fakeWithFlagger(FLAG_TRUE, VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    expect(db.query("SELECT * FROM scores").all()).toEqual(before);
    expect(beforeVersion).toBe(MODEL_VERSION);
    expect((db.query("SELECT model_version FROM scores LIMIT 1").get() as { model_version: string }).model_version).toBe(beforeVersion);
  });
});

describe("Показ флага: карточка (по правам) и MD-раздел", () => {
  test("карточка: полный Score → ai.fraud; аноним → текст и флаг не утекают", async () => {
    const { db } = freshDb("rh-v5b8-card-");
    const scanId = seedFull(db, "card");
    await runSummary({ db, org: "v5", repo: "card", callLlm: fakeWithFlagger(FLAG_TRUE, VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    const open = getRepoCard(db, "v5", "card", { access: OPEN, viewerUserId: 1, viewerAuth: "pat" })!;
    expect(open.ai?.fraud).toMatchObject({ flag: true, factors: [{ key: "activity.git.summary" }] });
    const anon = getRepoCard(db, "v5", "card", { access: NO_PAT_ACCESS })!;
    expect(anon.ai).toBeUndefined();
    expect(JSON.stringify(anon)).not.toContain("накрутку");
    expect(JSON.stringify(anon)).not.toContain("ровные интервалы");
  });

  test("MD: раздел появляется только с флагом, содержит факторы; без флага — раздела нет", async () => {
    const { db } = freshDb("rh-v5b8-md-");
    const scanId = seedFull(db, "md");
    await runSummary({ db, org: "v5", repo: "md", callLlm: fakeWithFlagger(FLAG_TRUE, VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    const withFlag = getRepoCard(db, "v5", "md", { access: OPEN })!;
    const md = renderRepoReport(withFlag);
    expect(md).toContain("Подозрение на искусственную активность");
    expect(md).toContain("ровные интервалы между коммитами");
    expect(md).toContain("activity.git.summary");
    // Score-таблица отчёта не изменилась флагом: раздел не трогает итог
    expect(md).toContain("55");
    // без генерации — раздела нет вовсе
    const noFlag = seedFull2(db, "md2");
    const card2 = getRepoCard(db, "v5", "md2", { access: OPEN })!;
    expect(renderRepoReport(card2)).not.toContain("Подозрение на искусственную активность");
    void noFlag;
  });

  test("кабинет: запись списка несёт fraudFlag при правах, null без них", async () => {
    const { db } = freshDb("rh-v5b8-me-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "me" });
    const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, scanId, { total: 55 });
    await runSummary({ db, org: "v5", repo: "me", callLlm: fakeWithFlagger(FLAG_TRUE, VALID_TEXTS), agentBackoffMs: 0 }, { scanId });
    // избранное с сохранённой проверкой обоих каналов
    db.query(
      "INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access) VALUES (7, 'v5', 'me', '2026-09-01T00:00:00Z', ?)",
    ).run(JSON.stringify({ ci: true, appsec: true }));
    const { entries } = await listMyRepos(db, 7);
    expect(entries[0]?.fraudFlag).toMatchObject({ flag: true });
    // без сохранённой проверки каналов полный Score закрыт — флага в кабинете нет
    db.query(
      "INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access) VALUES (8, 'v5', 'me', '2026-09-01T00:00:00Z', NULL)",
    ).run();
    const { entries: entries2 } = await listMyRepos(db, 8);
    expect(entries2[0]?.fraudFlag).toBeNull();
  });
});

function seedFull2(db: Database, repo: string): number {
  return seedFull(db, repo);
}
