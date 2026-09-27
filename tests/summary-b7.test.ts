// Bus factor: derived ПРИ скане, no-data факт дает null (а не число по пустым
// данным), окно и доля — константы model.ts, показ без веса (подметрика
// score=null). Живых вызовов нет.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { deriveMetrics, type TimelineEventValue } from "../src/score/derived";
import { BUS_FACTOR_SHARE, BUS_FACTOR_WINDOW_DAYS, MODEL_VERSION } from "../src/score/model";
import { compute, writeScores } from "../src/score/compute";
import { seedRepo, seedScan } from "./api-fixtures";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const now = new Date("2026-09-22T12:00:00Z");
const day = 24 * 3600_000;

function event(sha: string, email: string, daysAgo: number, robot = false): TimelineEventValue {
  return {
    sha,
    author: { name: email, email, date: new Date(now.getTime() - daysAgo * day).toISOString() },
    committer: { name: email, email, date: new Date(now.getTime() - daysAgo * day).toISOString() },
    ...(robot ? { robot: true, robot_reasons: ["committer-pattern"] } : {}),
  };
}

describe("bus factor: derived при скане, константы окна и доли", () => {
  test("один доминирующий автор покрывает половину — bus factor 1; равный вклад двух — 1", () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => event(`a${i}`, "lead@x", i)),
      ...Array.from({ length: 4 }, (_, i) => event(`b${i}`, "dev@x", i)),
    ];
    const derived = deriveMetrics(new Map([["activity.git.timeline", { events }]]), now);
    expect(derived.busFactor).toBe(1); // lead: 6 из 10 ≥ 50%
    // четверо с равным вкладом: порог ceil(8*0.5)=4, двое покрывают
    const events4 = [
      ...Array.from({ length: 2 }, (_, i) => event(`c${i}`, "w@x", i)),
      ...Array.from({ length: 2 }, (_, i) => event(`d${i}`, "x@x", i)),
      ...Array.from({ length: 2 }, (_, i) => event(`e${i}`, "y@x", i)),
      ...Array.from({ length: 2 }, (_, i) => event(`f${i}`, "z@x", i)),
    ];
    const derived4 = deriveMetrics(new Map([["activity.git.timeline", { events: events4 }]]), now);
    expect(derived4.busFactor).toBe(2);
  });

  test("роботы и sync не считаются; окно 90 дней; вне окна коммитов — null", () => {
    const events = [
      event("r1", "sync-bot@x", 1, true),
      event("h1", "human@x", 200), // вне окна
    ];
    const derived = deriveMetrics(new Map([["activity.git.timeline", { events }]]), now);
    expect(derived.busFactor).toBeNull();
    expect(BUS_FACTOR_WINDOW_DAYS).toBe(90);
    expect(BUS_FACTOR_SHARE).toBe(0.5);
    expect(MODEL_VERSION.length).toBeGreaterThan(0);
  });

  test("no-data факта таймлайна — busFactor null, показ-подметрика без веса", () => {
    // deriveMetrics получает только ОК-факты: отсутствие timeline — null
    const derived = deriveMetrics(new Map(), now);
    expect(derived.busFactor).toBeNull();
    // и с no-data значением: ок-карты нет — тот же null
    const derivedEmpty = deriveMetrics(new Map([["activity.git.summary", { commits: 5 }]]), now);
    expect(derivedEmpty.busFactor).toBeNull();
  });

  test("compute: подметрика activity.bus_factor показом без веса (score=null), derived в строке scores", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v5b7-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const repoId = seedRepo({ db, close: () => {} }, { org: "v5", repo: "bf" });
    const scanId = seedScan({ db, close: () => {} }, repoId, { facts: [], startedAt: "2026-09-20T00:00:00Z" });
    const events: TimelineEventValue[] = [
      ...Array.from({ length: 6 }, (_, i) => event(`a${i}`, "lead@x", i)),
      ...Array.from({ length: 4 }, (_, i) => event(`b${i}`, "dev@x", i)),
    ];
    const ins = db.query(
      "INSERT OR REPLACE INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, 'ok', 'test', '2026-09-20T00:00:00Z')",
    );
    ins.run(scanId, "activity", "activity.git.timeline", JSON.stringify({ events }));
    ins.run(scanId, "activity", "activity.git.summary", JSON.stringify({ commits: 10, authors: 2 }));
    const scores = compute(db, scanId);
    expect(scores.categories.activity.submetrics.bus_factor).toMatchObject({ score: null, value: 1 });
    // derived ПРИ скане уезжает в строку scores (writeScores скор-хука)
    writeScores(db, scores);
    const row = db.query("SELECT derived FROM scores WHERE scan_id = ?").get(scanId) as { derived: string };
    expect(JSON.parse(row.derived)).toMatchObject({ busFactor: 1 });
    db.close();
  });
});
