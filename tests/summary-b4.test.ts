// Специалист динамики и эволюция взглядов: без точек истории роль не запускается;
// состав входа — числа точек, прошлых LLM-текстов в промпте нет; стэйл и рост —
// валидные тексты; порог эволюции 2 дня — чистая функция. Живых вызовов нет.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { getAiNotesHistory } from "../src/api/history";
import { evolutionTooEarly } from "../src/summary/history-contract";
import { historyPoints, runSummary } from "../src/summary/pipeline";
import type { CallLlm } from "../src/llm";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";

const dirs: string[] = [];
const cleanup = (): void => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
};
process.on("exit", cleanup);

function freshDb(prefix: string): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return { db: openDb({ ...loadConfig(), dataDir: dir }), dir };
}

const wrap = (db: Database) => ({ db, close: () => {} });

const TRAJECTORY_TEXTS = {
  stale: "Индекс держится на 61, покрытие на 1 – проект топчется на месте {f:scores.points}.",
  growth: "Индекс вырос с 40 до 61, покрытие добрало {f:scores.points}.",
};

describe("Специалист динамики (trajectory): tri-state и состав входа", () => {
  test("без точек истории роль не запускается — честная причина (прямой тест)", async () => {
    const { db } = freshDb("rh-v5b4-nopoints-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "np" });
    const scanId = seedScan(wrap(db), repoId, { facts: cardFacts() });
    // скор-хук не записал scores: точек истории нет
    expect(historyPoints(db, scanId)).toEqual([]);
    let calls = 0;
    const callLlm = (async () => {
      calls++;
      return { text: "x", toolCalls: [], finish: "stop", usage: null };
    }) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "np", callLlm, agentBackoffMs: 0 }, { scanId });
    expect(res.skipped).toContain("trajectory");
    // вызов роли не был: сканов без истории не бывает в промптах
    expect(calls).toBeGreaterThan(0); // специалисты работали
    const notes = (db.query("SELECT role FROM ai_notes").all() as { role: string }[]).map((r) => r.role);
    expect(notes).not.toContain("trajectory");
  });

  test("состав входа: точки с числами и коммитами; прошлых LLM-текстов в промпте нет", async () => {
    const { db } = freshDb("rh-v5b4-comp-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "c" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-01T00:00:00Z" });
    seedScore(wrap(db), repoId, s1, { total: 40 });
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-20T00:00:00Z" });
    seedScore(wrap(db), repoId, s2, { total: 61 });
    db.query("UPDATE scans SET head_sha = 'aaa111' WHERE id = ?").run(s1);
    db.query("UPDATE scans SET head_sha = 'bbb222' WHERE id = ?").run(s2);
    // «прошлый взгляд»: заметки первого скана
    const seedCall: CallLlm = (async () => ({ text: TRAJECTORY_TEXTS.growth, toolCalls: [], finish: "stop", usage: null })) as CallLlm;
    await runSummary({ db, org: "v5", repo: "c", callLlm: seedCall, agentBackoffMs: 0 }, { scanId: s1 });

    const seen: string[] = [];
    const spy: CallLlm = (async (opts: { messages: { content: string }[]; role?: string }) => {
      if (opts.role === "trajectory") seen.push(...opts.messages.map((m) => m.content));
      return { text: TRAJECTORY_TEXTS.stale, toolCalls: [], finish: "stop", usage: null };
    }) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "c", callLlm: spy, agentBackoffMs: 0 }, { scanId: s2 });
    expect(res.notes).toBeGreaterThan(0);
    const prompt = seen.join("\n");
    expect(prompt).toContain("scores.points");
    expect(prompt).toContain("40"); // точки истории едут числами
    expect(prompt).toContain("61");
    expect(prompt).toContain("bbb"); // head_sha точки истории во входе
    // самореференция исключена: никаких прошлых текстов модели во входе
    expect(prompt).not.toContain("Индекс вырос");
    const notes = (db.query("SELECT role, text FROM ai_notes WHERE scan_id = ?").all(s2) as { role: string; text: string }[]).map((n) => n.role);
    expect(notes).toContain("trajectory");
  });

  test("стэйл — легитимный вывод: валидатор пропускает числа из точек", async () => {
    const { db } = freshDb("rh-v5b4-stale-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "s" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s1, { total: 61 });
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts() });
    seedScore(wrap(db), repoId, s2, { total: 61 });
    const callLlm = (async (opts: { role?: string }) => ({
      text: opts.role === "trajectory" ? TRAJECTORY_TEXTS.stale : "README покрывает установку {f:docs.presence}.",
      toolCalls: [],
      finish: "stop",
      usage: null,
    })) as CallLlm;
    const res = await runSummary({ db, org: "v5", repo: "s", callLlm, agentBackoffMs: 0 }, { scanId: s2 });
    expect(res.failSoft).not.toContain("trajectory");
    const note = db.query("SELECT text FROM ai_notes WHERE scan_id = ? AND role = 'trajectory'").get(s2) as { text: string };
    expect(note.text).toContain("топчется на месте");
  });
});

describe("Порог эволюции 2 дней (решение 22.09)", () => {
  test("меньше 2 дней — экрана нет; достаточно истории — есть; одна точка — рано", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(evolutionTooEarly(["2026-09-22T10:00:00Z"], now)).toBe(true);
    expect(evolutionTooEarly(["2026-09-22T08:00:00Z", "2026-09-22T12:00:00Z"], now)).toBe(true);
    expect(evolutionTooEarly(["2026-09-19T00:00:00Z", "2026-09-22T12:00:00Z"], now)).toBe(false);
  });

  test("двухдневная история доезжает до /ai-notes-проекции с датами", async () => {
    const { db } = freshDb("rh-v5b4-evo-");
    const repoId = seedRepo(wrap(db), { org: "v5", repo: "e" });
    const s1 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-19T00:00:00Z" });
    seedScore(wrap(db), repoId, s1, { total: 40 });
    const s2 = seedScan(wrap(db), repoId, { facts: cardFacts(), finishedAt: "2026-09-22T00:00:00Z" });
    seedScore(wrap(db), repoId, s2, { total: 61 });
    const callLlm = (async (opts: { role?: string }) => ({
      text: opts.role === "trajectory" ? TRAJECTORY_TEXTS.growth : "README покрывает установку {f:docs.presence}.",
      toolCalls: [],
      finish: "stop",
      usage: null,
    })) as CallLlm;
    await runSummary({ db, org: "v5", repo: "e", callLlm, agentBackoffMs: 0 }, { scanId: s1 });
    await runSummary({ db, org: "v5", repo: "e", callLlm, agentBackoffMs: 0 }, { scanId: s2 });
    const hist = getAiNotesHistory(db, "v5", "e", {
      access: { cicd: "granted", appsec: "granted", repo: "granted" },
    })!;
    expect(hist.locked).toBe(false);
    if (!hist.locked) {
      // порог меряется датами СКАНОВ (19.09 и 22.09 – 3 дня), не временем генерации
      expect(evolutionTooEarly(hist.notes.filter((n) => n.role === "overview").map((n) => n.scanFinishedAt ?? ""))).toBe(false);
      expect(hist.notes.every((n) => n.scanFinishedAt !== null)).toBe(true);
    }
  });
});
