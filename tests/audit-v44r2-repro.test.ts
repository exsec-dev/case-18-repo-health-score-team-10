// Репро-тесты на дефекты сжатого no-data timeline (значение `z:` при статусе
// no-data): карточка и MD не падают 500, стартовый рескор не бросает, JS- и
// SQL-правила пригодности дают одинаковый исход. Незакрытый дефект
// оборачивается в `repro`: в обычном прогоне это test.failing, под
// AUDIT_STRICT=1 — обычный test, который краснеет, пока дефект не исправлен.
//
// Живых запросов нет: только временные БД и настоящий сервер во временном
// DATA_DIR.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { DERIVED_VERSION, RESCORE_CURSOR, runStartupRescore } from "../src/score/rescore";
import { ratingEligible, ratingEligibleSql, type EligibilityFact } from "../src/score/compute";
import { encodeFactValue, TIMELINE_KIND } from "../src/collectors/facts";
import type { Database } from "bun:sqlite";
import { seedRepo, seedScan, seedScore, type ApiTestDb, type FactSpec } from "./api-fixtures";

const repro = process.env.AUDIT_STRICT ? test : test.failing;

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
const procs: { kill: () => void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs.reverse()) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Скан с упавшим git-каналом (все GIT_KINDS no-data с reason `empty` —
 * «пустой репо», он пригоден для рейтинга) и живым REST. Timeline-строка
 * переводится в сжатую форму `z:`, как ее писал бы кодек, сжимающий по kind
 * без оглядки на статус. Возвращает scanId.
 */
function seedScanWithCompressedNoDataTimeline(t: ApiTestDb, repoId: number, spec: { startedAt?: string } = {}): number {
  const startedAt = spec.startedAt ?? "2026-09-19T00:00:00Z";
  const facts: FactSpec[] = [
    { key: "activity.git.timeline", source: "git", status: "no-data", value: { reason: "empty", detail: "no commits at HEAD" } },
    { key: "activity.git.summary", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "docs.presence", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "docs.readme", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "tree.stats", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "cicd.configs", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "code.todo", source: "git", status: "no-data", value: { reason: "empty" } },
    { key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
    { key: "issues.comments_sample", source: "rest:comments", value: { issues: 0, with_comments: 0, median_first_comment_delay_hours: null, delays_hours: [] } },
    { key: "activity.rest", source: "rest:activity", value: { contributors: 0, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] } },
  ];
  const scanId = seedScan(t, repoId, { facts, status: "partial", publicStatus: "partial", startedAt });
  // значение timeline в БД — сырая z:-строка (без JSON-кавычек), статус
  // факта no-data
  const compressed = encodeFactValue(TIMELINE_KIND, { reason: "empty", detail: "no commits at HEAD" });
  t.db.query("UPDATE facts SET value = ? WHERE scan_id = ? AND key = 'activity.git.timeline'").run(compressed, scanId);
  return scanId;
}

// ---------------------------------------------------------------------------
// Карточка/MD репо со сжатым no-data timeline: маршрут не бросает, тело
// приходит (200), activity-канал остается no-data. Сырой JSON.parse в
// gitLimitsHit на сжатом timeline отдавал бы 500 обеим поверхностям.
// ---------------------------------------------------------------------------

describe("R1а (Б1): карточка и MD при сжатом no-data timeline отвечают 200", () => {
  test("карточка пустого репо с z:-timeline — 200 и честный no-data activity", async () => {
    const dir = tempDir("rh-v44r2-card-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "r2", repo: "empty-repo", title: null, language: null });
    const scanId = seedScanWithCompressedNoDataTimeline(t, repoId);
    // пустой репо пригоден для рейтинга (reason `empty` не дисквалифицирует) —
    // его скан становится public-строкой карточки
    seedScore(t, repoId, scanId, { total: 50 });
    db.close();
    const port = 46100 + Math.floor(Math.random() * 3000);
    const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        APP_SECRET: "",
        SOURCECRAFT_TOKEN: "",
        SOURCECRAFT_API_BASE: "http://127.0.0.1:9",
        APPSEC_API_BASE: "http://127.0.0.1:9",
        SOURCECRAFT_GIT_BASE: "http://127.0.0.1:9",
        YA_REDIRECT_URI: `http://127.0.0.1:${port}/auth/ya/callback`,
        SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    procs.push({ kill: () => proc.kill() });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 200 && proc.exitCode === null; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          up = true;
          break;
        }
      } catch {
        /* порт ещё не слушает — следующий тик */
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);
    // маршрут не бросает: тело карточки приходит, а не 500 SyntaxError
    const res = await fetch(`${base}/api/repos/r2/empty-repo`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      markers: { gitLimits: unknown };
      score: { healthcraftIndex: number | null } | null;
      evidence: { key: string; status: string; value: unknown }[];
    };
    expect(card.score).not.toBeNull();
    // activity-канал остаётся no-data — честное состояние, не подделка
    // (значение timeline в evidence — агрегат, событий не выдумано)
    const timeline = card.evidence.find((e) => e.key === "activity.git.timeline");
    expect(timeline?.status).toBe("no-data");
    expect((timeline?.value as { events?: number } | undefined)?.events).toBe(0);
    // MD-отчёт — та же карточка тем же сборщиком
    const md = await fetch(`${base}/api/repos/r2/empty-repo/report.md`);
    expect(md.status).toBe(200);
    proc.kill();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Стартовый рескор при сжатом no-data timeline не бросает и двигает курсор.
// json_extract на z:-строке бросает `malformed JSON`; без обработки в
// migrateEligibility это exit 1 и крэш-луп на старте.
// ---------------------------------------------------------------------------

describe("R1б (Б1): runStartupRescore жив на сжатом no-data timeline", () => {
  test("needsRescore=true + z:-timeline: проход доходит до done, курсор на max", async () => {
    const dir = tempDir("rh-v44r2-rescore-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "r2", repo: "rescore" });
    const first = seedScan(t, repoId, {
      facts: [
        { key: "activity.git.timeline", source: "git", value: { events: [] } },
        { key: "activity.git.summary", source: "git", value: { commits: 0, authors: 0, committers: 0, robot_commits: 0, robot_ratio: 0 } },
        { key: "docs.presence", source: "git", value: { readme: false, license: false, contributing: false, codeowners: false } },
        { key: "docs.readme", source: "git", value: { present: false } },
        { key: "tree.stats", source: "git", value: { top_level: [], file_count: 0, bytes: 0, loc: 0 } },
        { key: "cicd.configs", source: "git", value: { paths: [], has_ci_yaml: false, has_steps: false } },
        { key: "code.todo", source: "git", value: { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } },
        { key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
        { key: "issues.comments_sample", source: "rest:comments", value: { issues: 0, with_comments: 0, median_first_comment_delay_hours: null, delays_hours: [] } },
        { key: "activity.rest", source: "rest:activity", value: { contributors: 0, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] } },
      ],
      startedAt: "2026-03-01T00:00:00Z",
    });
    const last = seedScanWithCompressedNoDataTimeline(t, repoId, { startedAt: "2026-09-19T00:00:00Z" });
    db.close();
    const db2 = openDb({ ...loadConfig(), dataDir: dir });
    const out = await runStartupRescore(db2, { limit: 1, pauseMs: 0 });
    // не бросает malformed JSON из migrateEligibility и двигает курсор
    expect(out).toEqual({ stopped: "done" });
    expect(getMeta(db2, RESCORE_CURSOR)).toBe(String(last));
    expect(getMeta(db2, "derived_version")).toBe(String(DERIVED_VERSION));
    expect(last).toBeGreaterThan(first);
    db2.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// JS-правило пригодности и SQL-правило совпадают на сжатом no-data timeline:
// JS fail-soft читал бы reason как null, а SQL падал.
// ---------------------------------------------------------------------------

describe("R3 (Б1): JS и SQL правила пригодности совпадают на сжатом no-data timeline", () => {
  function factsOf(db: Database, scanId: number): EligibilityFact[] {
    return db.query("SELECT key, status, source, value FROM facts WHERE scan_id = ?").all(scanId) as EligibilityFact[];
  }
  test("z:-timeline с reason empty: ratingEligible === SQL-оценка (и контроль без сжатия)", () => {
    const dir = tempDir("rh-v44r2-elig-");
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const t: ApiTestDb = { db, close: () => db.close() };
    const repoId = seedRepo(t, { org: "r2", repo: "elig" });
    const compressed = seedScanWithCompressedNoDataTimeline(t, repoId);
    const plain = seedScan(t, repoId, {
      facts: [
        { key: "activity.git.timeline", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "activity.git.summary", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "docs.presence", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "docs.readme", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "tree.stats", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "cicd.configs", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "code.todo", source: "git", status: "no-data", value: { reason: "empty" } },
        { key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
        { key: "issues.comments_sample", source: "rest:comments", value: { issues: 0, with_comments: 0, median_first_comment_delay_hours: null, delays_hours: [] } },
        { key: "activity.rest", source: "rest:activity", value: { contributors: 0, releases: 0, pulls_open: 0, pulls_created_at: [], releases_released_at: [] } },
      ],
      status: "partial",
      startedAt: "2026-09-19T01:00:00Z",
    });
    const sqlOf = (scanId: number): boolean => {
      const row = db
        .query(`SELECT CASE WHEN ${ratingEligibleSql("s")} THEN 1 ELSE 0 END AS e FROM scans s WHERE s.id = ?`)
        .get(scanId) as { e: number };
      return row.e === 1;
    };
    const jsOf = (scanId: number): boolean =>
      ratingEligible(factsOf(db, scanId), { status: "partial", userId: null });
    // контроль без сжатия: оба правила считают скан пригодным (reason `empty` —
    // свойство репо), совпадение не «оба упали»
    expect(jsOf(plain)).toBe(true);
    expect(sqlOf(plain)).toBe(true);
    // на сжатом no-data timeline правила обязаны дать одинаковый исход
    expect(jsOf(compressed)).toBe(sqlOf(compressed));
    db.close();
  });
});

function getMeta(db: Database, key: string): string | null {
  return ((db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null);
}

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: красная, пока хоть один тест стоит под
// repro/test.failing.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
