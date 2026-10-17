// Поверхность «мой кабинет» без HTTP-слоя. Запуск анализа пользователем:
// repo-GET с PAT до постановки (200/403/404/401/0/429/5xx), строка repos не
// создается без доступа. Сети нет: REST-клиент — фейк с заданным статусом.
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import type { ScClient } from "../src/collectors/http";
import { upsertUser } from "../src/auth/session";
import { addFavorite, listMyRepos, listSourcecraftRepos, requestUserScan } from "../src/api/me";

const dir = mkdtempSync(join(tmpdir(), "rh-me-"));
const db: Database = openDb({ ...loadConfig(), dataDir: dir });
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function statusClient(status: number, json: unknown = null): ScClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async get(path: string) {
      paths.push(path);
      return { status, json, bodyText: "" };
    },
    requestCount: () => paths.length,
  };
}

const QUEUE = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 100, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000, retentionDays: 30, myReposPerMinute: 1000, favoritesMax: 1000, cardPerMinute: 30 };
const refusedOf = (userId: number) =>
  (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status = 'refused'").get(userId) as { c: number }).c;

const repoRow = (org: string, repo: string) =>
  db.query("SELECT id, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?").get(org, repo) as { id: number; visibility: string } | null;
const jobsOf = (userId: number) => (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?").get(userId) as { c: number }).c;

describe("requestUserScan: предпроверка доступа PAT (К3)", () => {
  const user = upsertUser(db, "ya-scan", "scanner");

  test("200 → upsert repos (visibility из ответа) → заявка → 202", async () => {
    const client = statusClient(200, { id: "42", name: "Secret", visibility: "private" });
    const out = await requestUserScan(db, client, user, "acme", "secret", QUEUE);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ queued: true, slug: "acme/secret" });
    expect(client.paths).toEqual(["/repos/acme/secret"]);
    expect(repoRow("acme", "secret")?.visibility).toBe("private");
    const job = db.query("SELECT user_id, trigger_kind, status FROM jobs WHERE id = ?").get(out.body["jobId"] as number) as {
      user_id: number;
      trigger_kind: string;
      status: string;
    };
    expect(job).toEqual({ user_id: user, trigger_kind: "user", status: "queued" });
  });

  test("403 и 404 → 403 no_access; строка repos и заявка НЕ создаются; отказ учтён строкой refused (Ф1.6)", async () => {
    const before = jobsOf(user);
    const refusedBefore = refusedOf(user);
    for (const [status, slug] of [
      [403, "forbidden"],
      [404, "missing"],
    ] as const) {
      const out = await requestUserScan(db, statusClient(status), user, "other", slug, QUEUE);
      expect(out.status).toBe(403);
      expect((out.body["error"] as { code: string }).code).toBe("no_access");
      expect(repoRow("other", slug)).toBeNull();
    }
    expect(refusedOf(user)).toBe(refusedBefore + 2);
    // отказанные строки воркером не заявляются и в очереди не стоят
    expect((db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')").get(user) as { c: number }).c).toBe(before);
  });

  test("отказы учитываются лимитом частоты: после N отказов за час — 429 без сети", async () => {
    const u = upsertUser(db, "ya-prober", "prober");
    const limit = { userScansPerHour: 3, maxAttempts: 3, userActiveMax: 100, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000, retentionDays: 30, myReposPerMinute: 1000, favoritesMax: 1000, cardPerMinute: 30 };
    for (let i = 0; i < 3; i++) expect((await requestUserScan(db, statusClient(404), u, "enum", `slug-${i}`, limit)).status).toBe(403);
    const client = statusClient(200, { visibility: "public" });
    const out = await requestUserScan(db, client, u, "enum", "real", limit);
    expect(out.status).toBe(429);
    expect(client.paths).toEqual([]);
  });

  // сбой платформы (0/429/5xx) — не вердикт о правах и часовой лимит запусков
  // не списывает; строкой refused учитывается только отказ (401)
  test("401 → 401 pat_expired (учтён строкой refused); 0/429/5xx → 503 check_failed без строки refused; без постановки", async () => {
    const before = jobsOf(user);
    const refusedBefore = refusedOf(user);
    const expired = await requestUserScan(db, statusClient(401), user, "x", "expired", QUEUE);
    expect(expired.status).toBe(401);
    expect((expired.body["error"] as { code: string }).code).toBe("pat_expired");
    for (const status of [0, 429, 500, 503]) {
      const out = await requestUserScan(db, statusClient(status), user, "x", `flaky-${status}`, QUEUE);
      expect(out.status).toBe(503);
      expect((out.body["error"] as { code: string }).code).toBe("check_failed");
      expect(repoRow("x", `flaky-${status}`)).toBeNull();
    }
    expect(repoRow("x", "expired")).toBeNull();
    expect(refusedOf(user)).toBe(refusedBefore + 1);
    expect(jobsOf(user)).toBe(before + 1); // только refused-строка отказа 401
    expect((db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')").get(user) as { c: number }).c).toBe(1);
  });

  test("too_many_active проверяется до сети (круг 2, LOW-6)", async () => {
    const u = upsertUser(db, "ya-active-cheap", "activecheap");
    const limit = { userScansPerHour: 100, maxAttempts: 3, userActiveMax: 1, favoriteChecksPerMinute: 6, favoriteOwnCooldownMs: 6 * 60 * 60_000, retentionDays: 30, myReposPerMinute: 1000, favoritesMax: 1000, cardPerMinute: 30 };
    expect((await requestUserScan(db, statusClient(200, { visibility: "public" }), u, "cheap", "one", limit)).status).toBe(202);
    const client = statusClient(200, { visibility: "public" });
    const out = await requestUserScan(db, client, u, "cheap", "two", limit);
    expect({ status: out.status, code: (out.body["error"] as { code: string }).code, requests: client.paths.length }).toEqual({
      status: 429,
      code: "too_many_active",
      requests: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Статус последнего скана в /api/me/repos и честные ветки UI кабинета и
// карточки (source-assert: компонентных тестов в репо нет).
// ---------------------------------------------------------------------------

describe("З4 (круг 2 В4.4): lastScanStatus в /api/me/repos", () => {
  const user = upsertUser(db, "ya-lss", "lss");

  test("последний скан bad → 'bad', running → 'running'; без прав меты → null", async () => {
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('lss', 'failed-repo')").run();
    const failedRepo = repoRow("lss", "failed-repo")!.id;
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, public_status, trigger) VALUES (?, '2026-09-19T00:00:00Z', '2026-09-19T00:05:00Z', 'bad', 'bad', 'periodic')").run(failedRepo);
    db.query("INSERT INTO repos (org_slug, repo_slug) VALUES ('lss', 'running-repo')").run();
    const runningRepo = repoRow("lss", "running-repo")!.id;
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, public_status, trigger) VALUES (?, '2026-09-19T00:00:00Z', NULL, 'running', 'running', 'periodic')").run(runningRepo);
    db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('lss', 'private-repo', 'private')").run();
    addFavorite(db, user, "lss", "failed-repo");
    addFavorite(db, user, "lss", "running-repo");
    addFavorite(db, user, "lss", "private-repo");
    const out = await listMyRepos(db, user);
    const byRepo = new Map(out.entries.map((e) => [e.repo, e]));
    expect(byRepo.get("failed-repo")?.lastScanStatus).toBe("bad");
    expect(byRepo.get("running-repo")?.lastScanStatus).toBe("running");
    // fail-closed: без прав меты статус не раскрывается вместе с ней
    expect(byRepo.get("private-repo")?.lastScanStatus).toBeNull();
    expect(byRepo.get("private-repo")?.lastScanAt).toBeNull();
  });
});

describe("UI-ветки круга 2 (source-assert, Б2)", () => {
  const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

  test("З1: сбой /api/me/favorites показывает Alert над списком кабинета", () => {
    expect(srcOf("MePage.tsx").includes('title="Не удалось загрузить избранное"')).toBe(true);
  });

  // «затянулось» — признак сервера из общего опроса заданий (`live.stalled`),
  // локальной stalled-метки у строки нет; задание ушло из active — строка не
  // «затянулась» (поведение — tests/v485-ui.test.ts, liveFor)
  test("З2: stalled строки — признак сервера из опроса заданий, не локальная метка", () => {
    const src = srcOf("MePage.tsx");
    expect({ serverFlag: src.includes("live.stalled"), localState: src.includes("stillActive") || src.includes("ScanJobState") }).toEqual({
      serverFlag: true,
      localState: false,
    });
  });

  // после старта карточка не опрашивает себя — сразу будится общий опрос заданий, и тело карточки переключается в ветку
  // «идет анализ» по живому заданию (`own = live ?? card.job`)
  test("З3: RepoPage после успешного старта будит опрос заданий, тело — по живому заданию", () => {
    const src = srcOf("RepoPage.tsx");
    expect(src.includes("analysis.refresh();")).toBe(true);
    expect(src.includes("const own = live ?? (data?.job ? { phase: data.job.status, stalled: data.job.stalled } : null);")).toBe(true);
  });

  test("З4: bad-статус имеет честный текст; ветка индекса срабатывает раньше статус-текста", () => {
    const src = srcOf("MePage.tsx");
    // состояние — короткой плашкой «Ошибка анализа» (как метки SourceCraft),
    // что делать — в подсказке
    expect(src.includes("Ошибка анализа")).toBe(true);
    // текст с призывом живет в `failedAnalysisHint` (format.ts) и показывается
    // только при кнопке анализа
    expect(src.includes("title={failedAnalysisHint(canAnalyze)}")).toBe(true);
    expect(srcOf("format.ts").includes("Анализ завершился ошибкой – запустите его еще раз")).toBe(true);
    const indexBranch = src.indexOf("entry.healthcraftIndex !== null");
    const badBranch = src.indexOf('entry.lastScanStatus === "bad"');
    expect({ indexBranch, badBranch, indexFirst: indexBranch < badBranch }).toMatchObject({ indexFirst: true });
  });

  // анализ доступен только для своих репозиториев, а без токена «свой» не
  // известен — поэтому CTA про токен анализ не обещает вовсе
  test("UX-6: подсказка про токен не обещает анализ (ни «первый», ни просто «запустите анализ»)", () => {
    const src = srcOf("RepoPage.tsx");
    expect(src.includes('{ text: "Добавить токен в Настройках", view: "action", size: "l", href: "/settings" }')).toBe(true);
    expect(src.includes("и запустите анализ")).toBe(false);
    expect(src.includes("и запустите первый анализ")).toBe(false);
  });

  test("UX-7: сбой снятия звезды показывается тостом, не молчит", () => {
    const src = srcOf("MePage.tsx");
    expect(src.includes("Не удалось убрать из избранного")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Различение прав и каталога, скрытие кнопки анализа на error-странице,
// seedNote без username, заметка «затянулось» на карточке (source-assert).
// ---------------------------------------------------------------------------

describe("UX-8 (круг 2 В4.4): inCatalog/mayRead в /api/me/repos", () => {
  test("публичное репо каталога без title: inCatalog+mayRead честны (прокси title===null врал бы)", async () => {
    const u = upsertUser(db, "ya-ux8", "ux8");
    // публичное витринное репо каталога без title: права есть, репо в
    // каталоге, сканов еще не было
    db.query("INSERT INTO repos (org_slug, repo_slug, title, visibility) VALUES ('showcase', 'no-title-repo', NULL, 'public')").run();
    // чужой слаг вне каталога — строка repos не создаётся никогда
    addFavorite(db, u, "showcase", "no-title-repo");
    addFavorite(db, u, "ghost", "not-in-catalog");
    // приватный в каталоге без прав
    db.query("INSERT INTO repos (org_slug, repo_slug, visibility) VALUES ('vault', 'hidden', 'private')").run();
    addFavorite(db, u, "vault", "hidden");
    const out = await listMyRepos(db, u);
    const byRepo = new Map(out.entries.map((e) => [e.repo, e]));
    expect(byRepo.get("no-title-repo")?.inCatalog).toBe(true);
    expect(byRepo.get("no-title-repo")?.mayRead).toBe(true);
    expect(byRepo.get("not-in-catalog")?.inCatalog).toBe(false);
    expect(byRepo.get("not-in-catalog")?.mayRead).toBe(false);
    // в каталоге, без прав — отдельная ветка «нет прав»
    expect(byRepo.get("hidden")?.inCatalog).toBe(true);
    expect(byRepo.get("hidden")?.mayRead).toBe(false);
  });
});

describe("UI-ветки круга 2 (source-assert, Б4)", () => {
  const srcOf = (file: string): string => readFileSync(join(import.meta.dir, "..", "src", "web", file), "utf8");

  test("UX-5: кнопка анализа не показывается на error-странице карточки", () => {
    const src = srcOf("RepoPage.tsx");
    expect(src.includes("actions={refreshButton}")).toBe(false);
  });

  test("UX-8: ярлыки кабинета различают «нет в каталоге» / «нет прав» / «еще не анализировали»", () => {
    const src = srcOf("MePage.tsx");
    expect({ noCatalog: src.includes("Нет в каталоге"), noRights: src.includes("Нет прав"), notYet: src.includes("Еще не анализировали") }).toEqual({
      noCatalog: true,
      noRights: true,
      notYet: true,
    });
    // title === null не годится как признак «нет в каталоге»
    expect(src.includes("entry.title === null")).toBe(false);
  });

  test("UX-9: seedNote при отсутствующем username не обвиняет namespace", () => {
    const meSrc = srcOf("MePage.tsx");
    // причина не обвиняет пространство имен
    expect(meSrc.includes('"SourceCraft не вернул имя пользователя"')).toBe(true);
    const serverSrc = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");
    expect(serverSrc.includes('code: "no_username"')).toBe(true);
  });

  // «затянулось» — признак сервера (лиз задания истек), а не «прошло leaseMs»
  test("UX-10: карточка при зависшем задании показывает «затянулось», а не вечный спиннер", () => {
    const src = srcOf("RepoPage.tsx");
    expect({
      stalled: src.includes("jobStalled"),
      // UX 17.10: раздел «Задания» переименован в «Очередь»
      note: src.includes("Анализ затянулся – его итог появится в «Очереди».") && src.includes("анализ затянулся – итог появится в «Очереди»"),
    }).toEqual({
      stalled: true,
      note: true,
    });
  });
});

test("S-7 (круг 2 В4.4): двойной sessionOf в PUT-ветках избранного убран", () => {
  const serverSrc = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");
  expect(serverSrc.includes("user0 = sessionOf(req)")).toBe(false);
});

// Пикер «своих»: пагинация /me/repos, маппинг, честный отказ
describe("listSourcecraftRepos: пикер своих репозиториев по PAT", () => {
  function pageClient(pages: { body: unknown; status?: number }[]): ScClient & { paths: string[] } {
    const paths: string[] = [];
    let call = 0;
    return {
      paths,
      async get(path: string) {
        paths.push(path);
        const page = pages[Math.min(call, pages.length - 1)];
        call++;
        return { status: page.status ?? 200, json: page.body, bodyText: "" };
      },
    } as unknown as ScClient & { paths: string[] };
  }

  test("маппит org/slug/name/visibility/isEmpty и ходит по next_page_token", async () => {
    const client = pageClient([
      { body: { repositories: [
        { organization: { slug: "acme" }, slug: "api", name: "API", visibility: "public", is_empty: false },
        { slug: "без-орг", name: "мусор без организации" },
      ], next_page_token: "t2" } },
      { body: { repositories: [
        { organization: { slug: "acme" }, slug: "empty", name: null, visibility: "private", is_empty: true },
      ] } },
    ]);
    const res = await listSourcecraftRepos(client);
    expect(res.status).toBe("ok");
    expect(res.partial).toBe(false);
    expect(res.repos).toEqual([
      { org: "acme", slug: "api", name: "API", visibility: "public", isEmpty: false },
      { org: "acme", slug: "empty", name: null, visibility: "private", isEmpty: true },
    ]);
    expect(client.paths[0]).toContain("/me/repos?page_size=100");
    expect(client.paths[1]).toContain("page_token=t2");
  });

  test("не-200 → source_http и то, что успели собрать", async () => {
    const client = pageClient([{ body: { error: "x" }, status: 502 }]);
    const res = await listSourcecraftRepos(client, { maxPages: 1 });
    expect(res.status).toBe("source_http");
    expect(res.repos).toEqual([]);
  });
});
