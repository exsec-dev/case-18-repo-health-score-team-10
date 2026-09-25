// v52-ui-round.test.ts — В5.2, Б6: круг правок по выбору владельца (TASK.md §2 «В5.2 (Б6) —
// выбор по дизайн-анализу»: 1A 2A 3 4C 5A) и однозначным О1-О11 аудита дизайна.
// Правило AGENTS.md 23.09: число в кнопке/колонке и утверждение состояния — тестом на данных.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { listRepos, parseReposQuery, DEFAULT_QUERY } from "../src/api/repos";
import { aiParagraphs, quotaBlockedText, quotaCounter, withCounter, type ActionQuotaView } from "../src/web/format";
import { normalizeRatingSearch } from "../src/web/ratingParams";
import { fraudCheckState } from "../src/web/RepoV5";
import { seedRepo, seedScan, seedScore, cardFacts } from "./api-fixtures";

const q = (over: Partial<ActionQuotaView>): ActionQuotaView => ({
  unlocked: false,
  hour: { used: 0, limit: 2 },
  day: { used: 0, limit: 6 },
  global: { used: 0, limit: 30 },
  hourResetAt: "2026-09-28T16:40:00.000Z",
  dayResetAt: "2026-09-28T21:00:00.000Z",
  ...over,
});

describe("решение 3: остаток в тексте кнопки — самое тесное окно", () => {
  test("час держит: 1/2; сутки держат: 1/6; общий держит: 2/30; с паролем — без числа", () => {
    expect(quotaCounter(q({ hour: { used: 1, limit: 2 } }))).toEqual({ left: 1, limit: 2, window: "hour" });
    expect(withCounter("Сформировать обзор", quotaCounter(q({ hour: { used: 1, limit: 2 } })))).toBe("Сформировать обзор 1/2");
    expect(quotaCounter(q({ day: { used: 5, limit: 6 } }))).toEqual({ left: 1, limit: 6, window: "day" });
    expect(quotaCounter(q({ global: { used: 29, limit: 30 } }))).toEqual({ left: 1, limit: 30, window: "global" });
    // равный остаток — окно меньшего масштаба (час раньше суток и общего)
    expect(quotaCounter(q({ global: { used: 28, limit: 30 } }))).toEqual({ left: 2, limit: 2, window: "hour" });
    expect(quotaCounter(q({ unlocked: true, hour: null, day: null, global: { used: 5, limit: 100 } }))).toBeNull();
    expect(withCounter("Проверить оценку", null)).toBe("Проверить оценку");
  });
  test("при нуле — видимая причина по окну (О2)", () => {
    const hour = q({ hour: { used: 2, limit: 2 } });
    expect(quotaBlockedText("overview", hour, quotaCounter(hour)!)).toStartWith("Следующий обзор – после ");
    expect(quotaBlockedText("overview", hour, quotaCounter(hour)!)).toEndWith("(не больше 2 в час)");
    const day = q({ day: { used: 6, limit: 6 } });
    expect(quotaBlockedText("check", day, quotaCounter(day)!)).toBe("Лимит проверок на сегодня исчерпан (6 в сутки) – откроется в 00:00 МСК");
    const all = q({ global: { used: 30, limit: 30 } });
    expect(quotaBlockedText("overview", all, quotaCounter(all)!)).toBe("Общий лимит обзоров сервиса на сегодня исчерпан – откроется в 00:00 МСК");
  });
});

type Ai = Parameters<typeof fraudCheckState>[0];
const ai = (check: Partial<Ai["check"]>, fraud: Ai["fraud"] = null): Ai =>
  ({
    scanId: 1,
    audience: "public",
    generatedAt: null,
    overview: null,
    specialists: [],
    failures: [],
    jobActive: false,
    cooldownUntil: null,
    check: { active: false, scanId: null, checkedAt: null, failure: null, retryable: false, latestScanId: 5, ...check },
    fraud,
  }) as Ai;
const flag = (on: boolean) => ({ flag: on, factors: on ? [{ key: "activity.rhythm", note: "x" }] : [], signals: {} });

describe("выбор 1A: 7 состояний проверки оценки (таблица §3.1, О3-О5)", () => {
  test("не проверялось — вошедшему кнопка, анониму — кто может запустить", () => {
    expect(fraudCheckState(ai({}), true)).toMatchObject({ kind: "none", text: "Оценка не проверялась на накрутку", button: "Проверить оценку" });
    expect(fraudCheckState(ai({}), false)).toMatchObject({ kind: "none", text: "Проверку может запустить любой вошедший пользователь", button: null });
  });
  test("идет, признаков нет, есть признаки", () => {
    expect(fraudCheckState(ai({ active: true }), true)).toMatchObject({ kind: "active", button: null });
    expect(fraudCheckState(ai({ scanId: 5, checkedAt: "2026-09-25T15:15:00Z" }, flag(false)), true)).toMatchObject({ kind: "clean", text: "Признаков накрутки нет", button: null });
    expect(fraudCheckState(ai({ scanId: 5, checkedAt: "2026-09-25T15:15:00Z" }, flag(true)), true)).toMatchObject({ kind: "flagged", text: "Есть признаки накрутки – подробности выше", button: null });
  });
  test("не сформировалась — повтор; нечего проверять — факт без кнопки (О3); устарела — снова проверить", () => {
    expect(fraudCheckState(ai({ scanId: 5, failure: "AI-провайдер не ответил – попробуйте позже", retryable: true }), true)).toMatchObject({
      kind: "failed",
      text: "Проверка оценки не сформировалась: AI-провайдер не ответил – попробуйте позже",
      button: "Повторить проверку",
    });
    expect(fraudCheckState(ai({ scanId: 5, failure: "в анализе нет истории коммитов – проверять нечего", retryable: false }), true)).toMatchObject({
      kind: "nothing",
      text: "Проверять нечего: в анализе нет истории коммитов",
      button: null,
    });
    expect(fraudCheckState(ai({ scanId: 3, checkedAt: "2026-09-25T15:15:00Z" }, flag(false)), true)).toMatchObject({ kind: "stale", button: "Проверить оценку" });
    // О5: флаг прошлого анализа не повторяется — текст подвала тот же, кнопка появляется
    expect(fraudCheckState(ai({ scanId: 3 }, flag(true)), true)).toMatchObject({ kind: "flagged", text: "Есть признаки накрутки – подробности выше", button: "Проверить оценку" });
  });
});

describe("О7: правило языка и при выводе — тексты, записанные до него", () => {
  test("aiParagraphs нормализует «ё» и длинное тире", () => {
    expect(aiParagraphs("В нём — всё\n\nВторой")).toEqual(["В нем – все", "Второй"]);
  });
});

const dirs: string[] = [];
const dbs: Database[] = [];
afterAll(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("выбор 4C: отметка и фильтр «С AI-обзором» в рейтинге — на данных", () => {
  test("aiOverview = есть публичная заметка overview; полная версия и флаггер — не в счет; фильтр и счетчик", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v52-ui-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    dbs.push(db);
    const w = { db, close: () => {} };
    const make = (repo: string, total: number): { repoId: number; scanId: number } => {
      const repoId = seedRepo(w, { org: "r", repo });
      const scanId = seedScan(w, repoId, { facts: cardFacts() });
      seedScore(w, repoId, scanId, { total });
      return { repoId, scanId };
    };
    const note = (x: { repoId: number; scanId: number }, role: string, audience: string) =>
      db.query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, ?, 't', '[]', '1', 'm', '2026', ?)").run(x.repoId, x.scanId, role, audience);
    const a = make("a", 80);
    const b = make("b", 70);
    const c = make("c", 60);
    note(a, "overview", "public");
    note(b, "overview", "full");
    note(c, "flagger", "public");
    const all = listRepos(db, DEFAULT_QUERY);
    expect(Object.fromEntries(all.items.map((i) => [i.repo, i.aiOverview]))).toEqual({ a: true, b: false, c: false });
    expect(all.aiCount).toBe(1);
    const only = listRepos(db, { ...DEFAULT_QUERY, ai: true });
    expect(only.items.map((i) => i.repo)).toEqual(["a"]);
    expect(only.items[0]!.rank).toBe(1); // место — по всему рейтингу, не по фильтру
    expect(only.aiCount).toBe(1);
  });

  test("адрес: ai=1 принимается, прочее — отказ сервера и сброс на клиенте", () => {
    expect(parseReposQuery(new URLSearchParams("ai=1"))).toMatchObject({ ok: true, query: { ai: true } });
    expect(parseReposQuery(new URLSearchParams("ai=yes")).ok).toBe(false);
    expect(normalizeRatingSearch("ai=yes&q=x")).toEqual({ search: "q=x", changed: true });
    expect(normalizeRatingSearch("ai=1")).toEqual({ search: "ai=1", changed: false });
  });
});
