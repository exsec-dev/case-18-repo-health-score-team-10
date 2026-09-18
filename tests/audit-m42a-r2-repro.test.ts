// audit-m42a-r2-repro.test.ts — воспроизведение находок круга 2 В4.2a
// (Р1–Р6, Р13, Р14, Р16 — красные; Р7–Р12 — тексты и отчёт, репро не имеют;
// Р15 репро не имеет по К-Р15 — чинится наблюдаемость, счёт скоринга не
// тронут). Закон круга: workers/V4.2a-round2.md (одноразовый, ревизия 2) +
// reports/2026-09-17-fix-plan.md ревизия 6 — «В4.2a круг 2 = Р1–Р12» и
// «К-Р круг 2»; К-Р13…К-Р16 — в промпте. Источник находок:
// reports/2026-09-19-m42a-audit-pair.md (таблица с file:line).
//
// На Б8-коммите находки стоят под обёрткой `repro` (в строгом режиме —
// красные); обёртка снимается в блоке, закрывшем находку, сами утверждения
// при этом не меняются. Строгий режим — для команды приёмки:
//   AUDIT_STRICT=1 bun test tests/audit-m42a-r2-repro.test.ts
//
// Живых запросов нет: каталог — фейковый клиент, compute — временные БД,
// сервер Р13 — во временном каталоге с адресами API на мок.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { catalogTick, newCatalogTickState, nightlyCatalog, schedulerHealthSnapshot, startScheduler, __resetSchedulerState } from "../src/jobs/scheduler";
import { cloneBare, cleanupClone, gitVersion, splitCredentialUrl, __resetGitVersionCache, type SpawnedGit } from "../src/collectors/git";
import { collectAppsec, makeAppsecClient, type AppsecClient, type AppsecGet } from "../src/collectors/appsec";
import { runScan } from "../src/jobs/runner";
import { okFact } from "../src/collectors/facts";
import { compute } from "../src/score/compute";
import { healthyFacts, makeDb, seedScan, withFacts, type TestDb } from "./score-fixtures";
import { cardFacts, seedRepo, seedScan as seedApiScan, seedScore, type ApiTestDb } from "./api-fixtures";
import type { AccessResult } from "../src/auth/access";
import { getRepoCard } from "../src/api/repos";
import { spawnServer, startMockApi, type MockApi, type SpawnedServer } from "./server-harness";

// Обёртка строгого режима (как в audit-m42a-repro.test.ts:242-247, приём Т1
// круга 2 В4.2-port-fix): в обычном прогоне — `test.failing` (набор зелёный,
// красноты в CI нет), под AUDIT_STRICT=1 — обычный `test`, то есть красный,
// пока находка не закрыта.
const repro = process.env.AUDIT_STRICT ? test : test.failing;

const dbs: TestDb[] = [];
afterAll(() => {
  for (const t of dbs.reverse()) t.close();
});

function tempDb(): TestDb {
  const t = makeDb();
  dbs.push(t);
  return t;
}

const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const HOUR = 60 * 60_000;
const T0 = new Date("2026-09-18T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Конфиг с явными интервалами фаз каталога (тест не зависит от env-дефолтов). */
function catalogConfig(over: { catalogIntervalMs: number; intervalMs: number; maxPages: number; startDelayMs?: number }): Config {
  const base = loadConfig();
  return {
    ...base,
    scan: { ...base.scan, catalog: { maxPages: over.maxPages } },
    scheduler: { ...base.scheduler, catalogIntervalMs: over.catalogIntervalMs, intervalMs: over.intervalMs, startDelayMs: over.startDelayMs ?? base.scheduler.startDelayMs },
  };
}

/** Фейк-клиент каталога: страницы repositories + next_page_token (как scheduler.test.ts). */
function catalogPagesClient(pages: { repos: Record<string, unknown>[]; next: string | null }[]): ScClient {
  let page = 0;
  return {
    async get(path: string): Promise<ScResponse> {
      if (!path.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
      const p = pages[Math.min(page, pages.length - 1)]!;
      page++;
      return { status: 200, json: { repositories: p.repos, next_page_token: p.next ?? "" }, bodyText: "" };
    },
    requestCount: () => page,
  };
}

const rawEntry = (org: string, slug: string, lastUpdated: string | null) => ({
  organization: { slug: org },
  slug,
  name: slug,
  visibility: "public",
  last_updated: lastUpdated,
  language: null as unknown,
  rating: null,
});

// ---------------------------------------------------------------------------
// Р1 (HIGH). gitVersionCache кэширует промис вместе с отказом: один
// транзиторный сбой `git --version` отравляет кэш на весь процесс.
// Контракт К-Р1: кэшируется ТОЛЬКО успех; отказ не сохраняется, следующий
// вызов пробует заново; параллельные вызовы делят один живой промис.
// ---------------------------------------------------------------------------

describe("Р1 (HIGH): кэш версии git — только успех", () => {
  // закрыто блоком Б9 — обёртка снята, утверждения не менялись.
  // Проба подменяется шимом в PATH (execFile резолвит git по PATH на каждый
  // запуск): падение и восстановление видны БЕЗ перезапуска процесса.
  test("проба падает → cloneBare отказывает; проба восстановлена → тот же процесс клонирует", async () => {
    __resetGitVersionCache();
    const shimDir = mkdtempSync(join(tmpdir(), "rh-gitshim-"));
    writeFileSync(join(shimDir, "git"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(shimDir, "git"), 0o755);
    const savedPath = process.env.PATH;
    let spawnedWhileBroken = 0;
    try {
      process.env.PATH = `${shimDir}:${savedPath}`;
      // проба падает — это видно и без фикса (null), фикс меняет поведение ПОСЛЕ
      expect(await gitVersion()).toBeNull();
      const refused = await cloneBare("https://repo-health:pat@example.com/o/r.git", tmpdir(), LIMITS, {
        spawnGit: () => {
          spawnedWhileBroken++;
          throw new Error("git must not be spawned while version probe fails");
        },
      });
      expect(refused.ok).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(spawnedWhileBroken).toBe(0);
    // К-Р1: проба восстановлена (тот же процесс, кэш не отравлен) — версия
    // читается снова, клон с кредами проходит до запуска git
    expect(await gitVersion()).not.toBeNull();
    let spawned = 0;
    const ok = await cloneBare("https://repo-health:pat@example.com/o/r.git", tmpdir(), LIMITS, {
      spawnGit: () => {
        spawned++;
        return fakeGitProc(0, "");
      },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(cleanupClone(ok.dir)).toBeNull();
    expect(spawned).toBe(1);
    rmSync(shimDir, { recursive: true, force: true });
  });
});

/** Фейк дочернего git-процесса (шов spawnGit): код выхода + stderr. */
function fakeGitProc(code: number, stderr: string): SpawnedGit {
  return {
    pid: 1,
    exited: Promise.resolve(code),
    stderr: new Response(stderr).body!,
    kill: () => {},
  };
}

// ---------------------------------------------------------------------------
// Р2. Таймеры планировщика и обслуживания без брони: `void tick(...)` без
// try/catch и без .catch — отказ шва останавливает таймер (Ф2.1 «цикл жив»).
// Контракт К-Р2: броня как у воркер-лупа, ПОКРЫТЬ ОБА таймера.
//
// Репро исполняется в ДОЧЕРНЕМ bun-процессе: неронированный бросок из
// колбэка setInterval — это uncaught exception «between tests» в самом
// прогоне (проверено: 0 fail / 13 errors / exit 1) — то есть та самая
// болезнь, которую чиним, но в тестовом процессе она отравляет весь набор.
// Дочерний процесс честно падает → репро красный ТОЛЬКО собой.
// ---------------------------------------------------------------------------

/** Прогон однострочного скрипта дочерним bun: код выхода + stdout. */
async function runBunScript(script: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text().catch(() => "");
  const code = await proc.exited;
  return { code, stdout };
}

const callsOf = (stdout: string): number => Number(/CALLS=(\d+)/.exec(stdout)?.[1] ?? 0);

describe("Р2: броня таймеров планировщика (Ф2.1)", () => {
  // закрыто блоком Б9 — обёртка снята, утверждения не менялись
  test("шов тика бросает синхронно — таймер жив, процесс не падает", async () => {
    const script = `
const { startScheduler } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "jobs", "scheduler"))});
let calls = 0;
const stop = startScheduler(null, () => null, { scheduler: { startDelayMs: 5, catalogIntervalMs: 10, intervalMs: 10 } }, {
  tick: () => { calls++; throw new Error("sync boom from tick seam"); },
  maintenance: () => {},
});
await Bun.sleep(80);
stop();
console.log("CALLS=" + calls);`;
    const out = await runBunScript(script);
    expect(out.code).toBe(0);
    expect(callsOf(out.stdout)).toBeGreaterThanOrEqual(2);
  });

  // закрыто блоком Б9 — обёртка снята, утверждения не менялись
  test("шов тика возвращает отказавший промис — таймер жив, процесс не падает", async () => {
    const script = `
const { startScheduler } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "jobs", "scheduler"))});
let calls = 0;
const stop = startScheduler(null, () => null, { scheduler: { startDelayMs: 5, catalogIntervalMs: 10, intervalMs: 10 } }, {
  tick: () => { calls++; return Promise.reject(new Error("async boom from tick seam")); },
  maintenance: () => {},
});
await Bun.sleep(80);
stop();
console.log("CALLS=" + calls);`;
    const out = await runBunScript(script);
    expect(out.code).toBe(0);
    expect(callsOf(out.stdout)).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Р3. Недочитанный каталог не двигает НИ ОДНОЙ метки → суточная ночная волна
// вырождается в часовую. Контракт К-Р3 (решение Екатерины 19.09): ночная
// метка двигается, если ночная фаза ИСПОЛНИЛАСЬ, независимо от полноты;
// метка сверки — только по дочитанному; эвикция — только по дочитанному.
// ---------------------------------------------------------------------------

describe("Р3: ночная метка — по исполнению фазы, не по полноте каталога", () => {
  // закрыто блоком Б10 — обёртка снята, утверждения не менялись
  test("недочитанный каталог, три часовых тика подряд → ночная фаза исполнилась ОДИН раз, эвикций ноль", async () => {
    const t = tempDb();
    const cfg = catalogConfig({ catalogIntervalMs: HOUR, intervalMs: 24 * HOUR, maxPages: 1 });
    t.db
      .query("INSERT INTO repos (org_slug, repo_slug, last_activity_at, visibility) VALUES ('r3', 'repo', '2026-09-01T00:00:00Z', 'public')")
      .run();
    // одна страница с курсором «more» при maxPages=1 → каталог недочитан, но обход ok
    const pages = [{ repos: [rawEntry("r3", "repo", "2026-09-18T00:00:00Z")], next: "more" }];
    const state = newCatalogTickState();
    const out1 = await catalogTick(t.db, () => catalogPagesClient(pages), cfg, state, { now: T0 });
    const out2 = await catalogTick(t.db, () => catalogPagesClient(pages), cfg, state, { now: at(HOUR) });
    const out3 = await catalogTick(t.db, () => catalogPagesClient(pages), cfg, state, { now: at(2 * HOUR) });
    expect(out1?.phases.nightly).toBe(true); // ночь была due — фаза исполнилась на недочитанном snapshot
    expect(out2?.phases.nightly).toBe(false); // суточный ритм НЕ вырождается в часовой
    expect(out3?.phases.nightly).toBe(false);
    expect({ nightlyMark: state.lastNightlyAt, reconcileMark: state.lastReconcileAt }).toEqual({ nightlyMark: T0, reconcileMark: null });
    expect([...out1!.evicted, ...out2!.evicted, ...out3!.evicted]).toEqual([]); // эвикция — только по дочитанному
    t.db.query("DELETE FROM jobs WHERE repo_id IN (SELECT id FROM repos WHERE org_slug = 'r3')").run();
  });
});

// ---------------------------------------------------------------------------
// Р4. Часовая сверка безусловно писала все строки repos (27 446 UPDATE за
// проход × 24/сутки). Контракт К-Р4: чтение одним запросом, запись только
// при расхождении; на неизменном каталоге — НОЛЬ записей; last_activity_at
// обход не пишет; интервал час не трогается. Счётчик — SQL-триггером.
// ---------------------------------------------------------------------------

describe("Р4: сверка каталога — ноль записей на неизменном каталоге", () => {
  // закрыто блоком Б10 — обёртка снята, утверждения не менялись
  test("SQL-триггер на repos: проход сверки без расхождений не делает ни INSERT, ни UPDATE", async () => {
    const t = tempDb();
    const N = 40;
    const seed = t.db.query(
      "INSERT INTO repos (org_slug, repo_slug, title, language, likes, visibility, logo_url, language_color, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < N; i++) {
      seed.run(`r4o${i}`, `r4r${i}`, `title-${i}`, i % 3 === 0 ? "TypeScript" : null, i, "public", `https://logo.example/${i}.png`, i % 3 === 0 ? "#3178c6" : null, "2026-09-10T00:00:00Z");
    }
    // служебная строка makeDb ('t/repo') в каталоге нет — эвикция тронула бы её
    // своим UPDATE; гасим ДО установки триггеров, чтобы гашение не попадало
    // в замер (это UPDATE репо, но не запись сверки)
    t.db.exec("UPDATE repos SET rating_active = 0 WHERE org_slug NOT LIKE 'r4o%'");
    // триггеры-счётчики ставятся ПОСЛЕ сида и гашения, чтобы они не попадали в замер
    t.db.exec("CREATE TABLE r4_audit (kind TEXT NOT NULL)");
    t.db.exec("CREATE TRIGGER r4_after_ins AFTER INSERT ON repos BEGIN INSERT INTO r4_audit VALUES ('insert'); END");
    t.db.exec("CREATE TRIGGER r4_after_upd AFTER UPDATE ON repos BEGIN INSERT INTO r4_audit VALUES ('update'); END");
    // каталог отдаёт РОВНО те же значения, что лежат в repos (неизменный каталог)
    const repos = Array.from({ length: N }, (_, i) => ({
      organization: { slug: `r4o${i}` },
      slug: `r4r${i}`,
      name: `title-${i}`,
      visibility: "public",
      last_updated: "2026-09-10T00:00:00Z",
      language: i % 3 === 0 ? { name: "TypeScript", color: "#3178c6" } : null,
      rating: { value: i },
      logo: i % 2 === 0 ? { url: `https://logo.example/${i}.png` } : null,
    }));
    const pages: { repos: Record<string, unknown>[]; next: string | null }[] = [];
    for (let i = 0; i < N; i += 100) pages.push({ repos: repos.slice(i, i + 100), next: i + 100 < N ? `p${i / 100 + 1}` : null });
    const out = await nightlyCatalog(t.db, catalogPagesClient(pages), { maxPages: 100, phases: { reconcile: true, nightly: false }, now: T0 });
    expect(out.entriesSeen).toBe(N);
    expect(out.ok).toBe(true);
    const counted = t.db.query("SELECT kind, COUNT(*) AS c FROM r4_audit GROUP BY kind").all() as { kind: string; c: number }[];
    expect(counted).toEqual([]); // ноль записей — ни insert, ни update
    // last_activity_at обходом не тронут (К-Ф1.1)
    const moved = (t.db.query("SELECT COUNT(*) AS c FROM repos WHERE last_activity_at <> '2026-09-10T00:00:00Z'").get() as { c: number }).c;
    expect(moved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Р5. /api/health.lastNightly обновлял ЛЮБОЙ обход, включая часовую сверку, —
// мёртвая ночная волна светила зелёным. Контракт К-Р5: различить «последний
// обход» и «последний обход с исполнившейся ночной фазой».
// ---------------------------------------------------------------------------

describe("Р5: /api/health — часовая сверка не трогает ночной факт", () => {
  // закрыто блоком Б11 — обёртка снята, утверждения не менялись (уточнён
  // сетап: модульный schedulerStateRef отделён от state тика, ночной факт
  // сперва ставится настоящей ночной фазой, иначе сверке нечего «не трогать»)
  test("обход с фазой сверки не обновляет lastNightly/lastNightlyAt", async () => {
    __resetSchedulerState();
    const t = tempDb();
    const cfg = catalogConfig({ catalogIntervalMs: HOUR, intervalMs: 24 * HOUR, maxPages: 100 });
    // ночной тик в T0: обе фазы due — ставит ночной факт health
    const state = newCatalogTickState();
    const nightlyOut = await catalogTick(t.db, () => catalogPagesClient([{ repos: [], next: null }]), cfg, state, { now: T0 });
    expect(nightlyOut?.phases.nightly).toBe(true);
    expect(schedulerHealthSnapshot().lastNightlyAt).toBe(T0.toISOString());
    // часовой тик: только сверка — ночной факт не трогается
    const out = await catalogTick(t.db, () => catalogPagesClient([{ repos: [], next: null }]), cfg, state, { now: at(HOUR) });
    expect(out?.phases).toEqual({ reconcile: true, nightly: false });
    const snap = schedulerHealthSnapshot();
    expect({ lastNightlyOk: (snap.lastNightly as { ok: boolean } | null)?.ok ?? null, lastNightlyAt: snap.lastNightlyAt, lastReconcileAt: snap.lastReconcileAt }).toEqual({
      lastNightlyOk: true, // ночной факт — от ночного тика, не от сверки
      lastNightlyAt: T0.toISOString(),
      lastReconcileAt: at(HOUR).toISOString(),
    });
    __resetSchedulerState();
  });
});

// ---------------------------------------------------------------------------
// Р6. Тест «скраб stderr до обрезки» не различал порядок: на входе noise=400
// проходил и при старом slice→scrub (секрет уходил за границу обрезки, а не
// вычищался скрабом). Контракт К-Р6: вход подобран так, что при порядке
// slice→scrub тест КРАСНЫЙ; число обосновано в комментарии теста.
// ---------------------------------------------------------------------------

describe("Р6: вход теста скраба различает порядок scrub/slice", () => {
  // закрыто блоком Б11 — обёртка снята, утверждения не менялись
  test("вход теста git-collector ловит утечку PAT при порядке slice→scrub", () => {
    const src = readFileSync(join(import.meta.dir, "git-collector.test.ts"), "utf8");
    const m = src.match(/const noise = "x"\.repeat\((\d+)\)/);
    expect(m).not.toBeNull();
    const noise = Number(m![1]);
    // точная симуляция обеих сторон: прежний (баговый) порядок против текущего
    const PAT = "pat-leaked-value";
    const line = `fatal: could not read from 'https://repo-health:${PAT}@git.sourcecraft.dev/o/r.git'`;
    const stderr = `${"x".repeat(noise)}\n${line}\n`.trim();
    const scrub = (s: string) => s.replace(/(https?:\/\/)[^@\/\s]+@/g, "$1***@");
    const buggyOrder = scrub(stderr.slice(0, 300)); // slice→scrub: находка Р6
    expect(buggyOrder.includes(PAT)).toBe(true); // различающий вход ловит утечку
    expect(scrub(stderr).slice(0, 300).includes(PAT)).toBe(false); // правильный порядок чист в любом случае
  });
});

// ---------------------------------------------------------------------------
// Р13. decodeURIComponent бросает URIError на битой percent-
// последовательности. Контракт К-Р13: декодирование пользовательского ввода
// через хелпер; URIError → вход невалиден → управляемый отказ (4xx), не 500.
// ---------------------------------------------------------------------------

describe("Р13: битая percent-последовательность — управляемый отказ, не исключение", () => {
  // закрыто блоком Б13 — обёртка снята, утверждения не менялись
  test("splitCredentialUrl на %zz в кредах отказывает (refused), не бросает URIError", () => {
    const split = splitCredentialUrl("https://user%zz:pat@git.example.com/o/r.git");
    expect(split.kind).toBe("refused");
  });

  // route-половина — на настоящем сервере (временный DATA_DIR, адреса на мок)
  let mock: MockApi | null = null;
  let server: SpawnedServer | null = null;
  beforeAll(async () => {
    mock = startMockApi();
    server = await spawnServer({ dataDir: mkdtempSync(join(tmpdir(), "rh-r13-")), mock });
  });
  afterAll(async () => {
    if (server) await server.stop();
    if (mock) mock.stop();
  });

  // закрыто блоком Б13 — обёртка снята, утверждения не менялись
  test("слаг %zz → управляемый отказ маршрута (bad_query 400), процесс жив", async () => {
    const base = server!.base;
    const bad = await fetch(`${base}/api/repos/%zz/r`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/json");
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_query");
    // процесс жив: соседний запрос отвечает штатно
    const alive = await fetch(`${base}/api/health`);
    expect(alive.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Р14. loc_note/todo_note = "incomplete" не читал ни один продуктовый модуль:
// old_share считался по частичной выборке TODO при обрыве cat-file.
// Контракт К-Р14: неполная выборка → old_share no-data С ПРИЧИНОЙ; полная
// выборка → число как раньше. Правка compute → derived_version повышается.
// ---------------------------------------------------------------------------

describe("Р14: old_share no-data при неполной выборке TODO", () => {
  // закрыто блоком Б13 — обёртка снята, утверждения не менялись
  test("todo_note=incomplete → old_share no-data с причиной, не число по частичной выборке", () => {
    const t = tempDb();
    const facts = withFacts(healthyFacts(), {
      key: "code.todo",
      value: { count: 10, fixme: 2, older_180d: 3, todo_files: 8, blamed_files: 8, todo_note: "incomplete" },
    });
    const scanId = seedScan(t, facts);
    const s = compute(t.db, scanId);
    const oldShare = s.categories.code.submetrics.old_share;
    expect(s.derived.oldShare).toBeNull(); // нет числа по частичной выборке
    expect(oldShare?.score).toBeNull();
    expect(String(oldShare?.note ?? "")).toContain("incomplete"); // причина видна
  });

  test("полная выборка (без todo_note) → old_share число, как раньше", () => {
    const t = tempDb();
    const scanId = seedScan(t, healthyFacts());
    const s = compute(t.db, scanId);
    expect(s.derived.oldShare).toBe(3 / 12);
    expect(s.categories.code.submetrics.old_share?.score).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Р16. Анонимный клон уходил веткой header (anonGitUrl ставит username=git)
// и на git < 2.31 отказывался вместе с приватными, хотя креды ему не нужны.
// Контракт К-Р16: проверка версии — ТОЛЬКО для клонов с кредами; анонимный
// URL не заводится в header-ветку.
// ---------------------------------------------------------------------------

describe("Р16: анонимный клон не требует git ≥ 2.31", () => {
  // закрыто блоком Б13 — обёртка снята, утверждения не менялись
  test("анонимный URL при версии 2.30 клонируется; с кредами при той же версии — отказ с внятной причиной", async () => {
    let anonSpawned = 0;
    const anon = await cloneBare("https://git@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, {
      gitVersion: [2, 30, 2], // инъекция швом: версии ниже минимума
      spawnGit: () => {
        anonSpawned++;
        return fakeGitProc(0, "");
      },
    });
    expect(anon.ok).toBe(true);
    if (anon.ok) expect(cleanupClone(anon.dir)).toBeNull();
    expect(anonSpawned).toBe(1); // git запущен — версии не мешали

    let privSpawned = 0;
    const priv = await cloneBare("https://repo-health:pat@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, {
      gitVersion: [2, 30, 2],
      spawnGit: () => {
        privSpawned++;
        throw new Error("git must not be spawned");
      },
    });
    expect(priv.ok).toBe(false);
    if (priv.ok) return;
    expect(priv.reason).toBe("git");
    expect(priv.detail).toContain("2.31"); // внятная причина
    expect(privSpawned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Р15. Один 500 на корзине type=SECRETS обнуляет весь Security-факт —
// поведение честное и предписанное (К-Ф2.6), но причина no-data нигде не
// фиксировалась. Контракт К-Р15: исход факта НЕ меняется (частичная выборка
// может только льстить скору), чинится наблюдаемость — после исчерпания
// ретраев причина фиксируется в status_detail скана и доезжает до noData
// карточки по существующему каналу причин (факт). Репро не имеет.
// ---------------------------------------------------------------------------

describe("Р15: причина no-data Security наблюдаема, счёт скоринга не тронут", () => {
  const SECRETS_DETAIL = "defect-groups type=SECRETS → 500: upstream (after 2 attempts)";

  /** Фейк AppSec: страницы/severity-корзины ок, корзина SECRETS — 500 после ретрая. */
  function secrets500Client(): AppsecClient {
    return {
      async get(path: string, params: Record<string, string>): Promise<AppsecGet> {
        if (path === "/v1/scans/latest") {
          return {
            status: 200,
            json: { uuid: "u-secrets", timeFinished: 1789570610046, isLatest: true, commitHash: "abc", openDefectGroups: 1, totalDefectGroups: 1 },
          };
        }
        if (path === "/v1/defect-groups" && params["type"] === "SECRETS") {
          return { status: 500, json: null, error: "upstream", attempts: 2 };
        }
        if (path === "/v1/defect-groups" && params["severity"] !== undefined) {
          return { status: 200, json: { data: [], nextPageToken: "", totalSize: 0 }, attempts: 1 };
        }
        if (path === "/v1/defect-groups") {
          return { status: 200, json: { data: [{ engine: "KICS", publicId: 1, findingsCount: 1, uuid: "g1" }], nextPageToken: "", totalSize: 1 }, attempts: 1 };
        }
        return { status: 404, json: null, attempts: 1 };
      },
      requestCount: () => 0,
    };
  }

  const restWithId = (): ScClient => ({
    async get(path: string): Promise<ScResponse> {
      if (path.startsWith("/repos/")) return { status: 200, json: { id: "42" }, bodyText: "" };
      return { status: 404, json: null, bodyText: "" };
    },
    requestCount: () => 1,
  });

  test("коллектор: 500 корзины SECRETS после ретраев → no-data incomplete с корзиной и числом попыток", async () => {
    const out = await collectAppsec(restWithId(), secrets500Client(), "org/repo", { now: T0 });
    expect(out.fact).toBeNull();
    expect({ reason: out.noData?.reason, bucket: out.noData?.bucket, attempts: out.noData?.attempts, detailHasAttempts: (out.noData?.detail ?? "").includes("after 2 attempts") }).toEqual({
      reason: "incomplete",
      bucket: "type=SECRETS",
      attempts: 2,
      detailHasAttempts: true,
    });
  });

  test("клиент: 5xx действительно ретраится — attempts=2 на отказавшемся запросе", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("upstream boom", { status: 500 }),
    });
    try {
      const client = makeAppsecClient({ token: "pat", baseUrl: `http://127.0.0.1:${upstream.port}`, minIntervalMs: 1, timeoutMs: 2000 });
      const out = await client.get("/v1/defect-groups", { gitRepo: "42" });
      expect({ status: out.status, attempts: out.attempts, requests: client.requestCount() }).toEqual({ status: 500, attempts: 2, requests: 2 });
    } finally {
      upstream.stop(true);
    }
  });

  test("runScan: отказ корзины → факт no-data, причина в scans.status_detail; скоринг не тронут", async () => {
    const t = tempDb();
    const gitOk = () => ({
      facts: [
        okFact("activity.git.summary", { commits: 5 }, "git"),
        okFact("docs.presence", { readme: true }, "git"),
      ],
    });
    const restOk = () => ({
      facts: [
        okFact("issues.stats", { open: 1, closed: 2 }, "rest:issues"),
        okFact("cicd.runs", { last_status: null }, "rest:cicd"),
      ],
      repoMeta: null,
      channelErrors: [],
    });
    const result = await runScan(
      {
        db: t.db,
        scClient: null,
        restBase: "http://127.0.0.1:1",
        appsecBase: "http://127.0.0.1:1",
        collectGit: async () => gitOk(),
        collectRest: async () => restOk(),
        collectAppsec: async () => ({ fact: null, noData: { reason: "incomplete", detail: SECRETS_DETAIL, bucket: "type=SECRETS", attempts: 2 } }),
      },
      "kr15/repo",
      { userId: 1, userToken: "pat", trigger: "user" },
    );
    expect(result.channels.appsec).toBe("no-data(incomplete)");
    const row = t.db.query("SELECT status_detail FROM scans WHERE id = ?").get(result.scanId) as { status_detail: string | null };
    expect(row.status_detail).toBe("appsec bucket type=SECRETS unavailable after 2 attempts");
    const fact = t.db.query("SELECT status FROM facts WHERE scan_id = ? AND key = 'appsec.findings'").get(result.scanId) as { status: string };
    expect(fact.status).toBe("no-data"); // исход факта не изменился (К-Ф2.6)
    // счёт скоринга не тронут: публичный Score считается, Security — no-data
    expect(result.score?.totalRating).not.toBeNull();
    const scores = JSON.parse((t.db.query("SELECT categories FROM scores WHERE scan_id = ?").get(result.scanId) as { categories: string }).categories) as { security: { score: number | null } };
    expect(scores.security.score).toBeNull();
  });

  test("карточка: noData Security несёт причину последнего no-data факта (открытому зрителю)", () => {
    const t = tempDb();
    const at: ApiTestDb = { db: t.db, close: () => {} };
    const repoId = seedRepo(at, { org: "kr15c", repo: "repo" });
    const scanId = seedApiScan(at, repoId, {
      facts: [
        ...cardFacts(),
        { key: "appsec.findings", source: "appsec:api", status: "no-data", value: { reason: "incomplete", detail: SECRETS_DETAIL } },
      ],
    });
    seedScore(at, repoId, scanId, { total: 60 });
    const granted: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
    const card = getRepoCard(t.db, "kr15c", "repo", { access: granted });
    const securityNoData = card?.score?.noData.find((raw) => raw.startsWith("security:")) ?? "";
    expect(securityNoData).toContain("type=SECRETS");
    expect(securityNoData).toContain("after 2 attempts");
    expect(card?.score?.totalRating).toBe(60); // счёт не тронут
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима (как в audit-m42a-repro.test.ts:242-247):
// без неё «AUDIT_STRICT=1 зелёный» — тавтология, потому что незакрытые находки
// стоят под `test.failing`. На Б8-коммите этот тест красный вместе с ними.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
