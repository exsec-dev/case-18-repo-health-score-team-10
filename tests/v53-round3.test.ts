// UI истории оценки и AI-заметок: поведенческие тесты на данных. Права
// проверяются по настоящему id репо: при общем на все репо кэше прав чужой
// репо после показа своего получил бы его права (Repo Health Score в истории,
// AI-текст).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { SESSION_COOKIE, createSession, upsertUser } from "../src/auth/session";
import { cardFacts, seedRepo, seedScan, seedScore } from "./api-fixtures";
import { spawnServer, startMockApi, type MockApi, type SpawnedServer } from "./server-harness";

const dirs: string[] = [];
const mocks: MockApi[] = [];
const servers: SpawnedServer[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
  for (const m of mocks) m.stop();
  // Windows держит файл БД за процессом сервера (EBUSY) — уборка tmp не проверка
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

const SECRET = "x".repeat(32);

describe("В5.3 О1: права истории и AI-заметок — по строке репо, не общим кэшем", () => {
  test("свой репо с правами прогрел кэш → чужой без прав: RHS в истории нет, заметки только публичные", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v53-o1-"));
    dirs.push(dir);
    const db = openDb({ ...loadConfig(), dataDir: dir });
    const wrap = { db, close: () => {} };
    for (const repo of ["own", "other"]) {
      const repoId = seedRepo(wrap, { org: "v53", repo });
      const scanId = seedScan(wrap, repoId, { facts: cardFacts() });
      seedScore(wrap, repoId, scanId, { total: 70 });
    }
    const userId = upsertUser(db, "ya-v53", "v53user");
    const cookie = `${SESSION_COOKIE}=${createSession(db, SECRET, userId)}`;
    const { storePat } = await import("../src/auth/pat");
    storePat(db, SECRET, userId, "PAT-TOKEN");
    db.close();
    // SourceCraft-мок: свой — CI и AppSec открыты, чужой — оба 403
    const mock = startMockApi((_req, url) => {
      if (url.pathname.endsWith("/repos/v53/own")) return Response.json({ id: "111", visibility: "public" });
      if (url.pathname.endsWith("/repos/v53/other")) return Response.json({ id: "222", visibility: "public" });
      if (url.pathname.endsWith("/repos/v53/own/cicd/runs")) return Response.json({ runs: [], items: [] });
      if (url.pathname.endsWith("/repos/v53/other/cicd/runs")) return new Response("{}", { status: 403 });
      if (url.pathname.endsWith("/v1/scans/latest")) {
        return url.searchParams.get("gitRepo") === "111" ? Response.json({ findings: [] }) : new Response("{}", { status: 403 });
      }
      return null;
    });
    mocks.push(mock);
    const server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET });
    servers.push(server);
    const get = (path: string) => fetch(`${server.base}${path}`, { headers: { cookie } });

    // свой — полный доступ (контроль: тест видит права, а не их отсутствие)
    const own = (await (await get("/api/repos/v53/own/history")).json()) as { fullOpen: boolean; points: { repoHealthScore: number | null }[] };
    expect(own.fullOpen).toBe(true);
    expect(own.points.some((p) => p.repoHealthScore !== null)).toBe(true);
    expect((await get("/api/repos/v53/own/ai-notes")).status).toBe(200);

    // чужой — сразу после своего, в окне кэша прав
    const other = (await (await get("/api/repos/v53/other/history")).json()) as { fullOpen: boolean; points: { repoHealthScore: number | null }[] };
    expect(other.fullOpen).toBe(false);
    expect(other.points.length).toBeGreaterThan(0);
    expect(other.points.every((p) => p.repoHealthScore === null)).toBe(true);
    // чужой публичный – публичная версия текстов, полная не открывается кэшем прав
    const notes = await get("/api/repos/v53/other/ai-notes");
    expect(notes.status).toBe(200);
    expect(((await notes.json()) as { audience: string }).audience).toBe("public");

    // и карточка чужого согласна с историей (один источник прав)
    const card = (await (await get("/api/repos/v53/other")).json()) as { score: { fullLocked: boolean } };
    expect(card.score.fullLocked).toBe(true);
  });
});

// ---------- поведенческие тесты на данных ----------
import { publicBaseUrlFromEnv } from "../src/config";
import { renderBadgeSvg } from "../src/api/public";
import { getRepoHistory } from "../src/api/history";
import { aiParagraphs, fraudFactorFact } from "../src/web/format";
import { SLOT_EMPTY, aiNotesCaption, badgeMarkdown, historyByTime } from "../src/web/slots";
import { evolutionTooEarly, type HistoryPoint } from "../src/summary/history-contract";
import { makeApiDb } from "./api-fixtures";

describe("В5.3 круг 3: флаг фрода — текст фактора строит код из факта (выбор 6-A, способ 2)", () => {
  test("сводка git: доля роботов процентом от чисел факта; авторы при коммиттерах не печатаются (не признак)", () => {
    const fact = { commits: 606, robot_commits: 600, robot_ratio: 0.99, authors: 3, committers: 2 };
    expect(fraudFactorFact("activity.git.summary", fact)).toBe("600 из 606 коммитов – от роботов (99%)");
  });
  test("процент — из чисел факта, а не из округленной доли; нет коммитов — без доли", () => {
    expect(fraudFactorFact("activity.git.summary", { commits: 107, robot_commits: 98, authors: 5, committers: 1 })).toBe(
      "98 из 107 коммитов – от роботов (92%)",
    );
    // ритм: доля роботов печатается только от порога правил (80%)
    expect(fraudFactorFact("activity.rhythm", { commits: 107, robot_commits: 98, sync_bursts: 0 })).toBe("98 из 107 коммитов – от роботов (92%)");
    expect(fraudFactorFact("activity.rhythm", { commits: 107, robot_commits: 50, sync_bursts: 0 })).toBeNull();
    expect(fraudFactorFact("activity.git.summary", { commits: 0, robot_commits: 0 })).toBeNull();
  });
  test("нет факта или неизвестный ключ — null (показывается формулировка модели)", () => {
    expect(fraudFactorFact("activity.git.summary", undefined)).toBeNull();
    expect(fraudFactorFact("activity.new_kind", { commits: 1 })).toBeNull();
  });
  test("история и REST — своими ветками", () => {
    expect(fraudFactorFact("activity.git.timeline", { events: 606, first: "2026-03-02T09:14:00Z", last: "2026-09-24T01:29:54Z" }, (iso) => iso.slice(0, 10))).toBe(
      "606 коммитов с 2026-03-02 по 2026-09-24",
    );
    expect(fraudFactorFact("activity.rest", { contributors: 1, releases: 0, pulls_created_at: [] })).toBe("1 участник, 0 релизов, 0 запросов на слияние");
  });
});

describe("В5.3 круг 3: бейдж для README (выбор 5-A, О5)", () => {
  test("код — абсолютные адреса, картинка ведет на карточку", () => {
    const md = badgeMarkdown("https://hc.example.ru/", "org", "my.repo");
    expect(md).toBe("[![HealthCraft Index](https://hc.example.ru/api/v1/repos/org/my.repo/badge.svg)](https://hc.example.ru/repo/org/my.repo)");
    expect(md.match(/\]\(https?:\/\//g)?.length).toBe(2);
  });
  test("публичный адрес: без переменных — дефолт стенда; из адреса возврата Я ID — его origin; PUBLIC_BASE_URL — как задан", () => {
    expect(publicBaseUrlFromEnv({})).toBe("http://localhost:8418");
    expect(publicBaseUrlFromEnv({ YA_REDIRECT_URI: "https://hc.example.ru/auth/ya/callback" })).toBe("https://hc.example.ru");
    expect(publicBaseUrlFromEnv({ PUBLIC_BASE_URL: "https://x.example.ru/", YA_REDIRECT_URI: "https://y.example.ru/cb" })).toBe("https://x.example.ru");
    expect(() => publicBaseUrlFromEnv({ PUBLIC_BASE_URL: "ftp://x" })).toThrow();
  });
  test("SVG: подпись — «HealthCraft Index», нейтральный фон; прежних «health» и #2d2c33 нет", () => {
    const svg = renderBadgeSvg(82);
    expect(svg).toContain(">HealthCraft Index<");
    expect(svg).toContain('aria-label="HealthCraft Index: 82"');
    expect(svg).not.toContain(">health<");
    expect(svg).not.toContain("#2d2c33");
  });
  test("текст отсутствия бейджа — без ложного «пока» (О6)", () => {
    expect(SLOT_EMPTY.badge.text).not.toMatch(/пока/i);
  });
});

describe("В5.3 круг 3: история — по времени, пустой репозиторий помечен (О12, §2 24.09)", () => {
  const pt = (scanId: number, finishedAt: string | null): HistoryPoint => ({
    scanId,
    finishedAt,
    healthcraftIndex: 50,
    indexCoverage: 1,
    repoHealthScore: null,
    modelVersion: "m",
    headSha: null,
    codeEmpty: false,
  });
  test("точки — по времени анализа, не по номеру; без времени — в конец", () => {
    const sorted = historyByTime([pt(3, "2026-09-18T10:00:00Z"), pt(2, "2026-09-19T10:00:00Z"), pt(4, null), pt(1, "2026-09-17T10:00:00Z")]);
    expect(sorted.map((p) => p.scanId)).toEqual([1, 3, 2, 4]);
  });
  test("codeEmpty точки = строка scores (равно источнику)", () => {
    const t = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "v53", repo: "hist" });
      const empty = seedScan(t, repoId, { finishedAt: "2026-09-24T10:00:00.000Z" });
      seedScore(t, repoId, empty, { total: 0 });
      t.db.query("UPDATE scores SET code_empty = 1 WHERE scan_id = ?").run(empty);
      const full = seedScan(t, repoId, { finishedAt: "2026-09-24T12:00:00.000Z", facts: cardFacts() });
      seedScore(t, repoId, full, { total: 42 });
      const h = getRepoHistory(t.db, "v53", "hist")!;
      const byScan = new Map(h.points.map((p) => [p.scanId, p.codeEmpty]));
      expect(byScan.get(empty)).toBe(true);
      expect(byScan.get(full)).toBe(false);
    } finally {
      t.close();
    }
  });
});

describe("В5.3 круг 3: прежние описания в истории (выбор 4-A, О11) — 3 состояния на данных", () => {
  test("1 описание — подписи нет (сравнивать не с чем)", () => {
    expect(aiNotesCaption(["2026-09-24T10:00:00Z"], evolutionTooEarly)).toBeNull();
  });
  test("2 описания за 1 день — «судить рано»", () => {
    expect(aiNotesCaption(["2026-09-24T10:00:00Z", "2026-09-24T20:00:00Z"], evolutionTooEarly)).toMatch(/меньше 2 дней/);
  });
  test("2 описания за 3 дня — подписи нет", () => {
    expect(aiNotesCaption(["2026-09-21T10:00:00Z", "2026-09-24T10:00:00Z"], evolutionTooEarly)).toBeNull();
  });
});

describe("В5.3 круг 3: абзацы AI-текста — одна функция для карточки и отчета (О3)", () => {
  test("переводы строк делят абзацы, пустые строки выбрасываются", () => {
    expect(aiParagraphs("Первый.\n\nВторой.\n \nТретий.")).toEqual(["Первый.", "Второй.", "Третий."]);
  });
});

// ---------- окно «Добавить в избранное» ----------
import { listSourcecraftRepos } from "../src/api/me";
import type { ScClient } from "../src/collectors/http";

describe("В5.3: список репозиториев токена — все страницы, честный счетчик (О1, О2)", () => {
  // платформа отдает по 1-2 записи на страницу, игнорируя page_size
  const client = (pages: { n: number; status?: number }[]): ScClient => {
    let call = 0;
    return {
      async get() {
        const i = call++;
        const p = pages[i]!;
        if (p.status && p.status !== 200) return { status: p.status, json: null, bodyText: "" };
        const repositories = Array.from({ length: p.n }, (_, k) => ({ organization: { slug: "org" }, slug: `r${i}-${k}`, visibility: "public" }));
        return { status: 200, json: { repositories, next_page_token: i < pages.length - 1 ? `t${i + 1}` : undefined }, bodyText: "" };
      },
    } as unknown as ScClient;
  };
  test("5 страниц по 2 — все 10 записей, не первые 3 страницы", async () => {
    const res = await listSourcecraftRepos(client([{ n: 2 }, { n: 2 }, { n: 2 }, { n: 2 }, { n: 2 }]));
    expect(res).toMatchObject({ status: "ok", partial: false });
    expect(res.repos.length).toBe(10);
  });
  test("сбой на 3-й странице — собранное с partial, а не 502", async () => {
    const res = await listSourcecraftRepos(client([{ n: 2 }, { n: 1 }, { n: 0, status: 500 }]));
    expect(res).toMatchObject({ status: "ok", partial: true });
    expect(res.repos.length).toBe(3);
  });
  test("сбой на первой странице — source_http", async () => {
    const res = await listSourcecraftRepos(client([{ n: 0, status: 500 }]));
    expect(res.status).toBe("source_http");
  });
  test("потолок по записям — partial и не больше потолка", async () => {
    const res = await listSourcecraftRepos(client([{ n: 2 }, { n: 2 }, { n: 2 }]), { maxItems: 3 });
    expect(res.partial).toBe(true);
    expect(res.repos.length).toBe(3);
  });
});

// ---------- bus factor – справочная подметрика ----------
import { displayOnly } from "../src/report/submetrics";

describe("В5.3: bus factor — без веса методики, показывается как справочная подметрика", () => {
  test("displayOnly(activity.bus_factor) — да", () => {
    expect(displayOnly("activity", "bus_factor")).toBe(true);
  });
});

// ---------- анализ internal-репо по доступу к коду; AI-обзор – только при полном Score ----------
import { isOwnRepo } from "../src/auth/access";

describe("В5.3: «свой» — и internal, видимый токену", () => {
  test("internal/private с доступом к коду — свой; публичный без CI/AppSec — нет; без доступа — нет", () => {
    const base = { cicd: "denied", appsec: "denied" } as const;
    expect(isOwnRepo({ ...base, repo: "granted", visibility: "internal" })).toBe(true);
    expect(isOwnRepo({ ...base, repo: "granted", visibility: "private" })).toBe(true);
    expect(isOwnRepo({ ...base, repo: "granted", visibility: "public" })).toBe(false);
    expect(isOwnRepo({ ...base, repo: "denied", visibility: "internal" })).toBe(false);
    expect(isOwnRepo({ ...base, repo: "granted", visibility: "unknown" })).toBe(false);
  });
});

// ---------- права, сохраненные до смены правила, читаются по текущему правилу ----------
import { savedAccessWithCurrentRule } from "../src/api/me";

describe("В5.3: «свой» в сохраненных правах пересчитывается при чтении", () => {
  test("internal с кодом, сохраненный как own:false до 25.09, — теперь свой; чужой публичный — нет", () => {
    expect(savedAccessWithCurrentRule({ clone: true, visibility: "internal", ci: false, appsec: false, own: false }).own).toBe(true);
    expect(savedAccessWithCurrentRule({ clone: true, visibility: "public", ci: false, appsec: false, own: false }).own).toBe(false);
    expect(savedAccessWithCurrentRule({ clone: false, visibility: "unknown", ci: null, appsec: null, own: false }).own).toBe(false);
    expect(savedAccessWithCurrentRule({ clone: true, visibility: "public", ci: true, appsec: false, own: false }).own).toBe(true);
  });
});
