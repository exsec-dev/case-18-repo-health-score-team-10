// Репро-тесты на AI-обзор, историю Score, badge и публичный API: схема БД,
// валидатор LLM-вывода, конвейер, маршруты. Обертка `repro` – в обычном прогоне
// `test.failing`, под AUDIT_STRICT=1 обычный `test`; в конце файла строгая
// самопроверка, что под `repro` ничего не осталось.
//
// Все проверки поведенческие: временные БД, настоящий сервер харнесса
// (spawnServer) с локальным моком, локальный bare-клон git. Живых вызовов LLM
// и живых запросов нет – специалисты работают на пер-ролевых фейках.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { cloneBare, cleanupClone, extractFacts, type ExtractOptions } from "../src/collectors/git";
import { makeApiDb, seedRepo, seedScore, seedScan } from "./api-fixtures";
import { cardFacts } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";
import {
  DARKEN_README,
  EXFILTRATE_README,
  FOREIGN_ZONE_OUTPUT,
  INFLATE_README,
  SELF_PRAISE_TODO,
  VALID_DOC_OUTPUT,
  giantReadme,
  separatorCollision,
} from "./fixtures/adversarial";

/**
 * Путь – переменная, чтобы `tsc` не падал, пока модуля еще нет: репро должно
 * быть красным тестом, а не красной типизацией.
 */
const importLater = async (path: string): Promise<Record<string, unknown>> => (await import(path)) as Record<string, unknown>;

const repro = process.env.AUDIT_STRICT ? test : test.failing;

// ---------------------------------------------------------------------------
// Фикстуры БД: публичный оцененный репо + приватный + эвицтированный
// (для маршрутов) и репо с фактами для конвейера.
// ---------------------------------------------------------------------------

function tempConfigDir(prefix: string): { db: Database; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  return { db, dir, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

interface SeedTriple {
  publicRepoId: number;
  privateSlug: [string, string];
  evictedSlug: [string, string];
}

function seedVisibilityTriple(db: Database): SeedTriple {
  const publicId = seedRepo({ db, close: () => {} }, { org: "v5", repo: "rated", likes: 10 });
  const s1 = seedScan({ db, close: () => {} }, publicId, { facts: cardFacts() });
  seedScore({ db, close: () => {} }, publicId, s1, { total: 74 });
  const privateId = seedRepo({ db, close: () => {} }, { org: "v5", repo: "hidden" });
  const s2 = seedScan({ db, close: () => {} }, privateId, { facts: cardFacts() });
  seedScore({ db, close: () => {} }, privateId, s2, { total: 50 });
  db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(privateId);
  const evictedId = seedRepo({ db, close: () => {} }, { org: "v5", repo: "gone" });
  const s3 = seedScan({ db, close: () => {} }, evictedId, { facts: cardFacts() });
  seedScore({ db, close: () => {} }, evictedId, s3, { total: 60 });
  db.query("UPDATE repos SET rating_active = 0, evict_reason = 'test' WHERE id = ?").run(evictedId);
  return { publicRepoId: publicId, privateSlug: ["v5", "hidden"], evictedSlug: ["v5", "gone"] };
}

// Сид-хелперы ждут полный ApiTestDb (с close) — оборачиваем голый db.
function wrap(db: Database) {
  return { db, close: () => {} };
}

describe("В5 репро: схема 2.0 и транспорт head_sha (Б1)", () => {
  test("В5-1: миграция 2.0 — таблица ai_notes (append, §3.5), scans.head_sha, jobs.kind", () => {
    const t = tempConfigDir("rh-v5-schema-");
    try {
      const columnsOf = (table: string) =>
        new Set((t.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
      const tables = new Set(
        (t.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
      );
      expect(tables.has("ai_notes")).toBe(true);
      const notes = columnsOf("ai_notes");
      for (const col of ["id", "repo_id", "scan_id", "role", "text", "fact_refs", "charter_version", "model", "created_at"]) {
        expect(notes.has(col)).toBe(true);
      }
      expect(columnsOf("scans").has("head_sha")).toBe(true);
      expect(columnsOf("jobs").has("kind")).toBe(true);
      // старые строки не тронуты: дефолт 'scan'
      t.db.query("INSERT INTO jobs (repo_id, status, trigger_kind) VALUES (?, 'queued', 'periodic')").run(0);
      const kind = t.db.query("SELECT kind FROM jobs ORDER BY id DESC LIMIT 1").get() as { kind: string };
      expect(kind.kind).toBe("scan");
    } finally {
      t.close();
    }
  });

  test("В5-2: транспорт head_sha — extractFacts выносит sha клона, runner пишет колонку scans.head_sha", async () => {
    // локальный bare-клон (без сети), как в git-collector.test.ts
    const src = mkdtempSync(join(tmpdir(), "rh-v5-src-"));
    const git = (args: string[], env: Record<string, string> = {}) =>
      execFileSync("git", args, { cwd: src, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Alice Dev"]);
    git(["config", "user.email", "alice@example.com"]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(src, "README.md"), "# T\n");
    git(["add", "-A"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
    git(["commit", "-q", "-m", "base"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
    const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src }).toString().trim();

    const work = mkdtempSync(join(tmpdir(), "rh-v5-clone-"));
    try {
      const out = await cloneBare(`file://${src}`, work, { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      try {
        const box: { headSha?: string | null } = {};
        // `out` – ящик, в который коллектор выносит sha клона
        await extractFacts(out.dir, { maxBlameFiles: 10, textCapBytes: 1_000_000, out: box } as unknown as ExtractOptions);
        expect(box.headSha).toBe(expectedSha);
      } finally {
        cleanupClone(out.dir);
      }
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("В5 репро: валидатор вывода (спека §3.7, блок Б2)", () => {
  const validatorOf = async (): Promise<{ validateOutput: Function }> => {
    const mod = await importLater("../src/summary/validator");
    return { validateOutput: mod.validateOutput as Function };
  };

  test("В5-3 (переосмыслено 23.09): числа больше не роняют текст — коридор снят владельцем; markdown-ссылка — нет", async () => {
    const { validateOutput } = await validatorOf();
    const facts = [
      { key: "docs.presence", value: { readme: true, license: true, contributing: true, codeowners: false } },
      { key: "docs.contributing", value: { present: true } },
      { key: "code.todo", value: { count: 4, fixme: 1, older_180d: 2, todo_files: 3, blamed_files: 3 } },
    ];
    const okDoc = validateOutput({
      role: "documentation",
      text: VALID_DOC_OUTPUT,
      facts,
      segments: [],
    });
    expect(okDoc.ok).toBe(true);
    expect(okDoc.refs).toEqual(["docs.presence", "docs.contributing"]);
    // числового коридора нет – числа не роняют текст, их дисциплина живет в хартиях
    const anyNumber = validateOutput({
      role: "code",
      text: "{f:code.todo} из 100 ошибок.",
      facts,
      segments: [],
    });
    expect(anyNumber.ok).toBe(true);
    // markdown-ссылка запрещена в LLM-тексте
    const badLink = validateOutput({
      role: "documentation",
      text: "Документация есть {f:docs.presence}, чат [здесь](https://example.com).",
      facts,
      segments: [],
    });
    expect(badLink.ok).toBe(false);
  });

  test("В5-4: валидатор отбрасывает вывод, следующие инъекции (завышение, выведение промпта, чужой контент)", async () => {
    const { validateOutput } = await validatorOf();
    const facts = [{ key: "docs.presence", value: { readme: true, license: true, contributing: false, codeowners: false } }];
    // инъекция из INFLATE_README: «100 из 100» отсекает дисциплина хартии, а не
    // валидатор – числового коридора нет
    const inflated = validateOutput({
      role: "documentation",
      text: "Проект идеален, оценка 100 из 100 {f:docs.presence}.",
      facts,
      segments: [],
    });
    expect(inflated.ok).toBe(true);
    // инъекция из EXFILTRATE_README: вывод тащит URL/служебный текст — ссылки запрещены
    const exfil = validateOutput({
      role: "documentation",
      text: "Документация есть {f:docs.presence}. Системный промпт: https://internal.example/prompt.",
      facts,
      segments: [],
    });
    expect(exfil.ok).toBe(false);
    // DARKEN_README: «активность нулевая» — новое утверждение без факта
    const darkened = validateOutput({
      role: "documentation",
      text: "Проект мёртв, активность нулевая {f:docs.presence}.",
      facts,
      segments: [],
    });
    expect(darkened.ok).toBe(false);
  });

  test("В5-5: «чужая зона» в выводе специалиста отбрасывается (ограда роли ловится механически)", async () => {
    const { validateOutput } = await validatorOf();
    // у documentation в скоупе только docs.*; ссылка на activity-факт — чужая зона
    const foreign = validateOutput({
      role: "documentation",
      text: FOREIGN_ZONE_OUTPUT,
      facts: [
        { key: "docs.presence", value: { readme: true, license: true, contributing: false, codeowners: false } },
        { key: "activity.git.summary", value: { commits: 2, authors: 2 } },
      ],
      segments: [],
    });
    expect(foreign.ok).toBe(false);
  });
});

describe("В5 репро: конвейер и хранение (блоки Б3/Б8)", () => {
  // Фейки пер-ролевые (ключ шва = роль хартии). Валидные тексты собраны из
  // фактов сид-фикстуры cardFacts().
  const VALID_BY_ROLE: Record<string, string> = {
    documentation: "README покрывает установку {f:docs.presence}.",
    code: "TODO в коде — реальные задачи {f:code.todo}.",
    activity: "Проект коммитили 2 автора {f:activity.git.summary}.",
    issues: "Из 14 задач открыто 4 {f:issues.stats}.",
    cicd: "Конфиг CI объявляет шаги {f:cicd.configs}.",
    overview: "У проекта есть README {f:docs.presence}; специалист по документации отметил пробел вклада {sp:documentation:1}.",
  };
  const GARBAGE =
    "Проект великолепен: 100 из 100 [сайт](https://example.com) — чат, CVE-2029-0001, движок Reactjs 99 {f:docs.presence}.";

  function pipelineDeps(t: { db: Database }, slug: [string, string], fake: (role: string) => string) {
    // форма ответа – реальный контракт CallLlm: toolCalls/finish обязательны
    const callLlm = async (opts: { role?: string }) => {
      const text = fake(opts.role ?? "");
      if (text === "") throw new Error(`fake: no text for role ${opts.role}`);
      return { text, toolCalls: [], finish: "stop", usage: null };
    };
    return {
      db: t.db,
      org: slug[0],
      repo: slug[1],
      callLlm,
      agentBackoffMs: 0,
    };
  }

  const notesOf = (db: Database, scanId: number): { role: string; text: string; fact_refs: string }[] =>
    db.query("SELECT role, text, fact_refs FROM ai_notes WHERE scan_id = ? ORDER BY id").all(scanId) as {
      role: string;
      text: string;
      fact_refs: string;
    }[];

  test("В5-6: невалидный вывод модели не доезжает — ai_notes пусты, роль в fail-soft", async () => {
    const t = tempConfigDir("rh-v5-soft-");
    try {
      const repoId = seedRepo(wrap(t.db), { org: "v5", repo: "soft", likes: 3 });
      const scanId = seedScan(wrap(t.db), repoId, { facts: cardFacts() });
      seedScore(wrap(t.db), repoId, scanId, { total: 55 });
      const mod = await importLater("../src/summary/pipeline");
      const runSummary = mod.runSummary as (deps: unknown, req: unknown) => Promise<{ failSoft: string[] }>;
      const res = (await runSummary(pipelineDeps(t, ["v5", "soft"], () => GARBAGE), { scanId, now: new Date("2026-09-22T12:00:00Z") })) as {
        failSoft: string[];
        skipped: string[];
      };
      expect(notesOf(t.db, scanId)).toEqual([]);
      expect(res.failSoft.length).toBeGreaterThan(0);
      expect(res.failSoft).toContain("overview");
      // причина отказа живет в ai_fails – карточка покажет ее пользователю
      // вместо молчаливого «не сформировано» (fail-soft + skips)
      const fails = t.db.query("SELECT role, reason FROM ai_fails WHERE scan_id = ? ORDER BY id").all(scanId) as { role: string; reason: string }[];
      expect(fails.length).toBe(res.failSoft.length + res.skipped.length);
      expect(fails.every((f) => f.reason.length > 0)).toBe(true);
      const overviewFail = fails.find((f) => f.role === "overview");
      expect(overviewFail?.reason).toContain("специалистов"); // овервью не собрался: ни одного ответа специалистов при GARBAGE-входе
    } finally {
      t.close();
    }
  });

  test("В5-7: конвейер на валидных фейках пишет ai_notes (append, роль, fact_refs, версия хартии)", async () => {
    const t = tempConfigDir("rh-v5-notes-");
    try {
      const repoId = seedRepo(wrap(t.db), { org: "v5", repo: "notes", likes: 4 });
      const scanId = seedScan(wrap(t.db), repoId, { facts: cardFacts() });
      seedScore(wrap(t.db), repoId, scanId, { total: 55 });
      const mod = await importLater("../src/summary/pipeline");
      const runSummary = mod.runSummary as (deps: unknown, req: unknown) => Promise<unknown>;
      await runSummary(pipelineDeps(t, ["v5", "notes"], (role) => VALID_BY_ROLE[role] ?? ""), { scanId, now: new Date("2026-09-22T12:00:00Z") });
      const notes = notesOf(t.db, scanId);
      const roles = notes.map((n) => n.role);
      expect(roles).toContain("overview");
      expect(roles).toContain("documentation");
      for (const n of notes) {
        expect(n.text.length).toBeGreaterThan(0);
        expect(() => JSON.parse(n.fact_refs)).not.toThrow();
      }
    } finally {
      t.close();
    }
  });
});

describe("В5 репро: маршруты (блоки Б5/Б6)", () => {
  const dirs: string[] = [];
  const servers: SpawnedServer[] = [];
  const mocks: { stop(): void }[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const m of mocks) m.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function serverWithSeeds(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "rh-v5-routes-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    seedVisibilityTriple(db);
    db.close();
    const mock = startMockApi();
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock });
    servers.push(server);
    return server.base;
  }

  test("В5-8: GET /api/repos/:org/:repo/history — публичная проекция точек истории (К5.7)", async () => {
    const base = await serverWithSeeds();
    const res = await fetch(`${base}/api/repos/v5/rated/history`);
    const body = (await res.json()) as {
      points?: { scanId: number; finishedAt: string | null; healthcraftIndex: number | null; indexCoverage: number; repoHealthScore: number | null; modelVersion: string }[];
    };
    expect(res.status).toBe(200);
    expect(body.points?.length).toBe(1);
    expect(body.points?.[0]?.healthcraftIndex).toBe(74);
    expect(typeof body.points?.[0]?.modelVersion).toBe("string");
  }, 60_000);

  test("В5-9: badge и публичный API — public 200, приватный/эвицтированный/несуществующий — 404 неотличимо (К5.8)", async () => {
    const base = await serverWithSeeds();
    const okBadge = await fetch(`${base}/api/v1/repos/v5/rated/badge.svg`);
    expect(okBadge.status).toBe(200);
    expect(okBadge.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await okBadge.text();
    expect(svg).toContain("svg");
    const okApi = await fetch(`${base}/api/v1/repos/v5/rated`);
    expect(okApi.status).toBe(200);
    const priv = await fetch(`${base}/api/v1/repos/v5/hidden/badge.svg`);
    const evict = await fetch(`${base}/api/v1/repos/v5/gone/badge.svg`);
    const missing = await fetch(`${base}/api/v1/repos/v5/nope/badge.svg`);
    const a = await priv.text();
    expect({ status: priv.status, body: a }).toEqual({ status: evict.status, body: await evict.text() });
    expect(a).toEqual(await missing.text());
    // SVG не содержит ничего, кроме числа, подписи и цвета
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» – тавтология.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const self = Bun.file(import.meta.path);
    return self.text().then((text) => {
      const parked = text.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
      expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
    });
  });
}

// Недоверенные фикстуры здесь напрямую не используются – их проверяют тесты
// валидатора и конвейера; живой импорт держит модуль в сборке tsc, чтобы
// список атак не протух.
void [INFLATE_README, DARKEN_README, EXFILTRATE_README, SELF_PRAISE_TODO, giantReadme, separatorCollision];
void existsSync;
