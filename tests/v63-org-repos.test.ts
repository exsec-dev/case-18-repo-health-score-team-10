// Анализ по кнопке для репозиториев ваших организаций: право запуска
// (`launchRightOf`) – свой репозиторий или репозиторий из списка SourceCraft по
// токену; общий кэш списка (`makeTokenRepoCache`); ограничение частоты на
// репозиторий для запуска по членству (`repoCooldownRefusal`) и текст отказа.
// Сквозной сценарий – на настоящем сервере с моком SourceCraft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchRightOf, needsMembership, type NormalizedAccess } from "../src/auth/access";
import { makeTokenRepoCache, membershipIn, type TokenRepoList, type TokenRepoWalk } from "../src/api/token-repos";
import { ORG_INFO_MAX, orgInfoOf, repoCooldownRefusal, requestUserScan, type ScRepoLite } from "../src/api/me";
import { enqueueScan } from "../src/jobs/scheduler";
import { loadConfig, type QueueConfig } from "../src/config";
import { openDb } from "../src/db";
import { createSession, SESSION_COOKIE, upsertUser } from "../src/auth/session";
import { storePat } from "../src/auth/pat";
import type { ScClient } from "../src/collectors/http";
import { errorText, favoriteAddedText, repoCooldownText } from "../src/web/format";
import { makeApiDb, seedRepo, seedScan } from "./api-fixtures";
import { spawnServer, startMockApi, type SpawnedServer } from "./server-harness";

const access = (over: Partial<NormalizedAccess>): NormalizedAccess => ({ repo: "granted", cicd: "denied", appsec: "denied", visibility: "public", ...over });

describe("право запуска анализа по кнопке", () => {
  test("свой – без списка; публичный без CI/CD и Безопасности – по списку по токену", () => {
    expect(launchRightOf(access({ cicd: "granted" }), null)).toBe("own");
    expect(launchRightOf(access({ appsec: "granted" }), null)).toBe("own");
    expect(launchRightOf(access({ visibility: "private" }), null)).toBe("own");
    expect(launchRightOf(access({ visibility: "internal" }), null)).toBe("own");
    expect(launchRightOf(access({}), "yes")).toBe("member");
    expect(launchRightOf(access({}), "no")).toBe("none");
  });

  test("неизвестность – не вердикт: нет списка, обход прерван, каналы не ответили", () => {
    expect(launchRightOf(access({}), "unknown")).toBe("unknown");
    expect(launchRightOf(access({}), null)).toBe("unknown");
    // CI не ответил, а в списке репозитория нет: свой мог бы быть – не «не из организаций»
    expect(launchRightOf(access({ cicd: "check-failed" }), "no")).toBe("unknown");
    // CI не ответил, но репозиторий в списке – запуск как у участника, с ограничением частоты
    expect(launchRightOf(access({ cicd: "check-failed" }), "yes")).toBe("member");
  });

  test("токен не видит репозиторий или отклонен – отказ без списка", () => {
    expect(launchRightOf(access({ repo: "denied", cicd: "denied", appsec: "denied" }), null)).toBe("denied");
    expect(launchRightOf(access({ repo: "pat-expired", cicd: "pat-expired", appsec: "pat-expired" }), null)).toBe("token-rejected");
    expect(launchRightOf(access({ repo: "check-failed", cicd: "check-failed", appsec: "check-failed" }), null)).toBe("unknown");
  });

  test("список спрашивается только у видимого токену репозитория, который не свой", () => {
    expect(needsMembership(access({}))).toBe(true);
    expect(needsMembership(access({ cicd: "granted" }))).toBe(false);
    expect(needsMembership(access({ visibility: "private" }))).toBe(false);
    expect(needsMembership(access({ repo: "denied" }))).toBe(false);
  });
});

const lite = (org: string, slug: string, visibility = "public"): ScRepoLite => ({ org, slug, name: slug, visibility, isEmpty: false });
const listOf = (repos: ScRepoLite[], over: Partial<TokenRepoList> = {}): TokenRepoList => ({ at: 0, repos, partial: false, interrupted: false, orgs: {}, ...over });

describe("членство в списке по токену", () => {
  test("слаг – точно как в SourceCraft (другой регистр – другая строка каталога); нет в полном списке или упершемся в потолок – no; в прерванном – unknown", () => {
    const repos = [lite("team", "pub")];
    expect(membershipIn(listOf(repos), "team", "pub")).toBe("yes");
    expect(membershipIn(listOf(repos), "Team", "Pub")).toBe("no");
    expect(membershipIn(listOf(repos), "team", "other")).toBe("no");
    expect(membershipIn(listOf(repos, { partial: true }), "team", "other")).toBe("no");
    expect(membershipIn(listOf(repos, { partial: true, interrupted: true }), "team", "other")).toBe("unknown");
  });
});

describe("кэш списка по токену", () => {
  const setup = (walkResult: Awaited<ReturnType<TokenRepoWalk>> = { status: "ok", partial: false, repos: [lite("team", "pub")] }) => {
    let clock = 1_000_000;
    let pat: string | null = "pat-a";
    const walks: string[] = [];
    let release: (() => void) | null = null;
    let hold = false;
    const cache = makeTokenRepoCache({
      ttlMs: 10_000,
      now: () => clock,
      currentPat: () => pat,
      walk: async (p) => {
        walks.push(p);
        if (hold) await new Promise<void>((r) => (release = r));
        return walkResult;
      },
    });
    return {
      cache,
      walks,
      tick: (ms: number) => (clock += ms),
      setPat: (p: string | null) => (pat = p),
      holdWalks: () => (hold = true),
      releaseWalk: () => release?.(),
    };
  };
  const allow = { mayWalk: () => true };

  test("свежий список – без обхода; истекший – новый обход; peek видит только свежий", async () => {
    const t = setup();
    expect(t.cache.peek(1)).toBeNull();
    expect((await t.cache.load(1, "pat-a", allow)).kind).toBe("list");
    expect(t.cache.peek(1)?.repos.length).toBe(1);
    await t.cache.load(1, "pat-a", allow);
    expect(t.walks.length).toBe(1);
    t.tick(10_001);
    expect(t.cache.peek(1)).toBeNull();
    await t.cache.load(1, "pat-a", allow);
    expect(t.walks.length).toBe(2);
    // refresh перечитывает и свежий
    await t.cache.load(1, "pat-a", { ...allow, refresh: true });
    expect(t.walks.length).toBe(3);
  });

  test("одновременные промахи делят один обход; присоединение не спрашивает окно", async () => {
    const t = setup();
    t.holdWalks();
    let asked = 0;
    const first = t.cache.load(1, "pat-a", { mayWalk: () => (asked++, true) });
    const second = t.cache.load(1, "pat-a", { mayWalk: () => (asked++, true) });
    t.releaseWalk();
    const [a, b] = await Promise.all([first, second]);
    expect({ walks: t.walks.length, asked, a: a.kind, b: b.kind }).toEqual({ walks: 1, asked: 1, a: "list", b: "list" });
  });

  test("окно исчерпано: прежний список (даже истекший) с пометкой stale, без списка – limited", async () => {
    const t = setup();
    expect((await t.cache.load(1, "pat-a", { mayWalk: () => false })).kind).toBe("limited");
    await t.cache.load(1, "pat-a", allow);
    t.tick(20_000);
    const stale = await t.cache.load(1, "pat-a", { mayWalk: () => false });
    expect(stale.kind === "list" && stale.stale).toBe(true);
  });

  test("в память не попадают прерванный обход и обход прежним токеном; forget сбрасывает список", async () => {
    const broken = setup({ status: "ok", partial: true, interrupted: true, repos: [lite("team", "pub")] });
    const loaded = await broken.cache.load(1, "pat-a", allow);
    expect(loaded.kind === "list" && loaded.list.interrupted).toBe(true);
    expect(broken.cache.peek(1)).toBeNull();

    const t = setup();
    t.holdWalks();
    const old = t.cache.load(1, "pat-a", allow);
    t.setPat("pat-b");
    t.releaseWalk();
    await old;
    expect(t.cache.peek(1)).toBeNull();

    const f = setup();
    await f.cache.load(1, "pat-a", allow);
    f.cache.forget(1);
    expect(f.cache.peek(1)).toBeNull();
  });

  test("SourceCraft не отдал первую страницу – failed", async () => {
    const t = setup({ status: "source_http", partial: true, repos: [] });
    expect((await t.cache.load(1, "pat-a", allow)).kind).toBe("failed");
  });
});

const NOW = new Date("2026-10-17T12:00:00Z");
const HOUR = 3600_000;
const QUEUE: QueueConfig = {
  userScansPerHour: 100,
  maxAttempts: 3,
  userActiveMax: 100,
  favoriteChecksPerMinute: 6,
  favoriteOwnCooldownMs: 6 * HOUR,
  repoCooldownMs: 6 * HOUR,
  retentionDays: 30,
  myReposPerMinute: 1000,
  favoritesMax: 1000,
};
const okClient = (): ScClient => ({ get: async () => ({ status: 200, json: { name: "x", visibility: "public" }, bodyText: "" }), requestCount: () => 0 }) as unknown as ScClient;

describe("ограничение частоты на репозиторий", () => {
  test("анализ меньше 6 ч назад (любой, включая плановый) – 429 со временем; старше – можно; неудачный не в счет", () => {
    const t = makeApiDb();
    try {
      const recent = seedRepo(t, { org: "team", repo: "recent" });
      seedScan(t, recent, { startedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() });
      const old = seedRepo(t, { org: "team", repo: "old" });
      seedScan(t, old, { startedAt: new Date(NOW.getTime() - 7 * HOUR).toISOString() });
      const failed = seedRepo(t, { org: "team", repo: "failed" });
      seedScan(t, failed, { startedAt: new Date(NOW.getTime() - HOUR).toISOString(), status: "bad" });
      const out = repoCooldownRefusal(t.db, recent, "team/recent", 6 * HOUR, NOW);
      expect(out?.status).toBe(429);
      expect(out?.body).toEqual({
        error: {
          code: "repo_cooldown",
          message: "team/recent недавно анализировали – следующий запуск будет доступен позже",
          lastScanAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
          until: new Date(NOW.getTime() + 4 * HOUR).toISOString(),
        },
      });
      expect(out?.retryAfterSec).toBe(4 * 3600);
      expect(repoCooldownRefusal(t.db, old, "team/old", 6 * HOUR, NOW)).toBeNull();
      expect(repoCooldownRefusal(t.db, failed, "team/failed", 6 * HOUR, NOW)).toBeNull();
      // 0 выключает ограничение
      expect(repoCooldownRefusal(t.db, recent, "team/recent", 0, NOW)).toBeNull();
    } finally {
      t.close();
    }
  });

  test("идет чужой анализ или скан – 409 repo_busy; плановая заявка в очереди запуск не держит", () => {
    const t = makeApiDb();
    try {
      const other = upsertUser(t.db, "ya-other", "other");
      const queuedByUser = seedRepo(t, { org: "team", repo: "queued" });
      enqueueScan(t.db, queuedByUser, { userId: other, triggerKind: "user", now: NOW });
      const running = seedRepo(t, { org: "team", repo: "running" });
      seedScan(t, running, { startedAt: new Date(NOW.getTime() - 7 * HOUR).toISOString(), status: "running", finishedAt: null });
      const periodic = seedRepo(t, { org: "team", repo: "periodic" });
      enqueueScan(t.db, periodic, { triggerKind: "periodic", now: NOW });
      expect(repoCooldownRefusal(t.db, queuedByUser, "team/queued", 6 * HOUR, NOW)?.status).toBe(409);
      expect((repoCooldownRefusal(t.db, running, "team/running", 6 * HOUR, NOW)?.body.error as { code: string }).code).toBe("repo_busy");
      expect(repoCooldownRefusal(t.db, periodic, "team/periodic", 6 * HOUR, NOW)).toBeNull();
    } finally {
      t.close();
    }
  });

  test("requestUserScan: ограничение только по флагу запуска по членству; своя активная заявка – по-прежнему дедуп", async () => {
    const t = makeApiDb();
    try {
      const user = upsertUser(t.db, "ya-member", "member");
      const id = seedRepo(t, { org: "team", repo: "fresh" });
      seedScan(t, id, { startedAt: new Date(NOW.getTime() - HOUR).toISOString() });
      const member = await requestUserScan(t.db, okClient(), user, "team", "fresh", QUEUE, NOW, undefined, { repoCooldown: true });
      expect((member.body.error as { code: string }).code).toBe("repo_cooldown");
      const own = await requestUserScan(t.db, okClient(), user, "team", "fresh", QUEUE, NOW);
      expect(own.status).toBe(202);
      const again = await requestUserScan(t.db, okClient(), user, "team", "fresh", QUEUE, NOW, undefined, { repoCooldown: true });
      expect(again.body.deduplicated).toBe(true);
      // SourceCraft говорит «ни одного коммита» – анализировать нечего, заявки нет
      const emptyClient = { get: async () => ({ status: 200, json: { name: "e", visibility: "public", is_empty: true }, bodyText: "" }), requestCount: () => 0 } as unknown as ScClient;
      const hollow = await requestUserScan(t.db, emptyClient, user, "team", "hollow", QUEUE, NOW);
      expect({ status: hollow.status, code: (hollow.body.error as { code: string }).code }).toEqual({ status: 409, code: "repo_empty" });
      expect(t.db.query("SELECT 1 FROM repos WHERE org_slug = 'team' AND repo_slug = 'hollow'").get()).toBeNull();
      // нового репозитория в каталоге нет – ограничивать нечего
      const fresh = await requestUserScan(t.db, okClient(), user, "team", "brand-new", QUEUE, NOW, undefined, { repoCooldown: true });
      expect(fresh.status).toBe(202);
    } finally {
      t.close();
    }
  });
});

describe("текст отказа по частоте", () => {
  const now = new Date(2026, 9, 17, 12, 0);
  test("сколько прошло и после какого времени можно снова; время сегодня – без даты", () => {
    const last = new Date(2026, 9, 17, 10, 0).toISOString();
    expect(repoCooldownText(last, new Date(2026, 9, 17, 16, 0).toISOString(), now)).toBe("Репозиторий анализировали 2 ч назад – следующий запуск после 16:00");
    expect(repoCooldownText(new Date(2026, 9, 17, 11, 35).toISOString(), new Date(2026, 9, 17, 17, 35).toISOString(), now)).toBe(
      "Репозиторий анализировали 25 мин назад – следующий запуск после 17:35",
    );
    expect(repoCooldownText(new Date(2026, 9, 17, 23, 0).toISOString(), new Date(2026, 9, 18, 5, 0).toISOString(), new Date(2026, 9, 17, 23, 0, 30))).toBe(
      "Репозиторий анализировали только что – следующий запуск после 18 окт. 2026, 05:00",
    );
  });

  test("добавление в избранное репозитория своей организации – тост про кнопку анализа", () => {
    expect(favoriteAddedText({ status: "checked", enqueue: { status: "skipped", code: "member" } }, "public")).toBe(
      "Права проверены – анализ можно запустить кнопкой в строке или на карточке.",
    );
  });

  test("errorText собирает его по коду и времени из ответа, без «повторить через N мин»", () => {
    const text = errorText({ status: 429, code: "repo_cooldown", message: "x", retryAfter: "14400", lastScanAt: new Date(Date.now() - 2 * HOUR).toISOString(), until: new Date(Date.now() + 4 * HOUR).toISOString() });
    expect(text).toStartWith("Репозиторий анализировали 2 ч назад – следующий запуск после ");
    expect(text).not.toContain("Повторить");
    // без времени – сообщение сервера
    expect(errorText({ status: 429, code: "repo_cooldown", message: "team/x недавно анализировали – следующий запуск будет доступен позже" })).toStartWith("Team/x недавно");
  });
});

// ---------------------------------------------------------------------------
// HTTP: настоящий сервер с моком SourceCraft
// ---------------------------------------------------------------------------

const SECRET = "v63-org-repos-secret-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "rh-v63-"));
let meReposMode: "ok" | "503" = "ok";
const TEAM_REPOS = ["pub", "fresh", "dev", "newpub", "flaky", "hollow", "hollowcat"].map((slug) => ({ organization: { slug: "team" }, slug, visibility: "public", is_empty: slug.startsWith("hollow") }));
const mock = startMockApi((_req, url) => {
  const p = url.pathname;
  if (p === "/user") return Response.json({ username: "member" });
  if (p === "/me/repos") return meReposMode === "503" ? Response.json({ e: 1 }, { status: 503 }) : Response.json({ repositories: TEAM_REPOS });
  if (p === "/v1/scans/latest") return Response.json({ error: "no scan" }, { status: 404 });
  // team/dev – токену видны CI/CD (роль Developer): свой; остальные публичные – CI 403
  const runs = p.match(/^\/repos\/([^/]+)\/([^/]+)\/cicd\/runs$/);
  if (runs) {
    if (runs[2] === "flaky") return Response.json({ e: 1 }, { status: 503 });
    return runs[1] === "team" && runs[2] === "dev" ? Response.json({ runs: [] }) : Response.json({ error: "denied" }, { status: 403 });
  }
  const repo = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  // hollow* – ни одного коммита: так отвечает и repo-GET, и список по токену
  if (repo) return Response.json({ id: `gid-${repo[2]}`, name: repo[2], visibility: "public", is_empty: repo[2]!.startsWith("hollow") });
  return null;
});
let server: SpawnedServer | null = null;
const cookies: Record<string, string> = {};
const users: Record<string, number> = {};
let freshScanAt = "";

beforeAll(async () => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  const t = { db, close: () => db.close() };
  seedRepo(t, { org: "team", repo: "pub" });
  freshScanAt = new Date(Date.now() - HOUR).toISOString();
  seedScan(t, seedRepo(t, { org: "team", repo: "fresh" }), { startedAt: freshScanAt });
  seedScan(t, seedRepo(t, { org: "team", repo: "dev" }), { startedAt: freshScanAt });
  seedRepo(t, { org: "foreign", repo: "pub" });
  // пустой, но уже в каталоге (плановый обход): у запуска нет живого repo-GET проверки прав
  seedRepo(t, { org: "team", repo: "hollowcat" });
  for (const name of ["alice", "bob", "carol", "erin", "dan"]) {
    users[name] = upsertUser(db, `ya-${name}`, name);
    cookies[name] = createSession(db, SECRET, users[name]!);
    storePat(db, SECRET, users[name]!, `pat-${name}-0000000`);
  }
  db.close();
  // роль rating: пользовательскую полосу никто не разбирает — заявки остаются в очереди
  server = await spawnServer({ dataDir: dir, mock, appSecret: SECRET, env: { PROCESS_ROLE: "rating", QUEUE_USER_ACTIVE_MAX: "10", QUEUE_USER_SCANS_PER_HOUR: "100", QUEUE_MY_REPOS_PER_MINUTE: "3" } });
}, 90_000);

afterAll(async () => {
  if (server) await server.stop();
  mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const scan = async (name: string, slug: string) => {
  const res = await fetch(`${server!.base}/api/me/repos/${slug}/scan`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${cookies[name]}`, origin: server!.base },
  });
  const body = (await res.json()) as { queued?: boolean; error?: { code?: string; until?: string; lastScanAt?: string } };
  return { status: res.status, code: body.error?.code ?? null, body, retryAfter: res.headers.get("retry-after") };
};
const refusedRows = (name: string) => {
  const db = openDb({ ...loadConfig(), dataDir: dir });
  try {
    return (db.query("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status = 'refused'").get(users[name]!) as { c: number }).c;
  } finally {
    db.close();
  }
};

describe("HTTP: анализ по кнопке для репозиториев ваших организаций", () => {
  test("публичный репозиторий из списка по токену без доступа к CI/CD – ставится; второй участник, пока он идет, – repo_busy", async () => {
    expect(await scan("alice", "team/pub")).toMatchObject({ status: 202, code: null });
    expect(await scan("bob", "team/pub")).toMatchObject({ status: 409, code: "repo_busy" });
  }, 60_000);

  test("недавно анализировали – 429 repo_cooldown со временем последнего анализа и временем, когда можно снова", async () => {
    const out = await scan("alice", "team/fresh");
    expect({ status: out.status, code: out.code, lastScanAt: out.body.error?.lastScanAt }).toEqual({ status: 429, code: "repo_cooldown", lastScanAt: freshScanAt });
    expect(Date.parse(out.body.error!.until!)).toBe(Date.parse(freshScanAt) + 6 * HOUR);
    expect(Number(out.retryAfter)).toBeGreaterThan(4 * 3600);
  }, 60_000);

  test("свой (токену видны CI/CD) – без ограничения частоты, даже после свежего анализа", async () => {
    expect(await scan("alice", "team/dev")).toMatchObject({ status: 202, code: null });
  }, 60_000);

  test("репозиторий из списка, которого нет в каталоге, – ставится и попадает в каталог", async () => {
    expect(await scan("bob", "team/newpub")).toMatchObject({ status: 202, code: null });
  }, 60_000);

  test("пустой (ни одного коммита по ответу SourceCraft) – 409 repo_empty без заявки и без строки отказа", async () => {
    const before = refusedRows("alice");
    expect(await scan("alice", "team/hollow")).toMatchObject({ status: 409, code: "repo_empty" });
    expect(refusedRows("alice")).toBe(before);
  }, 60_000);

  test("пустой из каталога у зрителя без прочитанного списка – тоже 409: пустоту проверяет живой repo-GET постановки", async () => {
    expect(await scan("dan", "team/hollowcat")).toMatchObject({ status: 409, code: "repo_empty" });
  }, 60_000);

  test("публичный не из организаций – 403 not_own без строки отказа", async () => {
    const before = refusedRows("alice");
    expect(await scan("alice", "foreign/pub")).toMatchObject({ status: 403, code: "not_own" });
    expect(refusedRows("alice")).toBe(before);
  }, 60_000);

  test("слаг в другом регистре – не репозиторий из списка: 403 not_own, второй строки каталога нет", async () => {
    expect(await scan("alice", "Team/pub")).toMatchObject({ status: 403, code: "not_own" });
  }, 60_000);

  test("CI/CD не ответил, но репозиторий в списке – запуск как у участника организации", async () => {
    expect(await scan("alice", "team/flaky")).toMatchObject({ status: 202, code: null });
  }, 60_000);

  test("список не перечитать из-за окна чтений – 429 rate_limited, а не «SourceCraft не отвечает»", async () => {
    meReposMode = "503";
    try {
      // окно (3 в минуту) расходуют неудачные обходы – каждый из них не вердикт
      for (let i = 0; i < 3; i++) expect(await scan("erin", "team/pub")).toMatchObject({ status: 503, code: "check_failed" });
      const limited = await scan("erin", "team/pub");
      expect({ status: limited.status, code: limited.code, retry: Number(limited.retryAfter) > 0 }).toEqual({ status: 429, code: "rate_limited", retry: true });
    } finally {
      meReposMode = "ok";
    }
  }, 60_000);

  test("список по токену недоступен – не вердикт: 503 check_failed, запуска нет", async () => {
    meReposMode = "503";
    try {
      expect(await scan("carol", "team/pub")).toMatchObject({ status: 503, code: "check_failed" });
    } finally {
      meReposMode = "ok";
    }
  }, 60_000);
});

describe("сведения об организациях списка по токену", () => {
  test("логотип и название – только из ответа 200; 404 и сбой сети – без сведений; каждая организация читается один раз", async () => {
    const calls: string[] = [];
    const client = {
      get: async (path: string) => {
        calls.push(path);
        if (path === "/orgs/a") return { status: 200, json: { logo: { url: "https://img/a.png" }, display_name: " Альфа " } };
        if (path === "/orgs/d") return { status: 200, json: { logo: null, display_name: "" } };
        if (path === "/orgs/b") return { status: 404, json: null };
        throw new Error("network");
      },
      requestCount: () => calls.length,
    } as unknown as ScClient;
    expect(await orgInfoOf(client, ["a", "b", "a", "c", "d"])).toEqual({ a: { logoUrl: "https://img/a.png", displayName: "Альфа" } });
    expect(calls).toEqual(["/orgs/a", "/orgs/b", "/orgs/c", "/orgs/d"]);
  });

  test("порядок – как на экране (своя первой, затем по алфавиту), не больше ORG_INFO_MAX; зависшая организация не держит список", async () => {
    const asked: string[] = [];
    const client = {
      get: (path: string) => {
        asked.push(path);
        // зависает навсегда
        if (path === "/orgs/a00") return new Promise(() => {});
        return Promise.resolve({ status: 200, json: { display_name: path } });
      },
      requestCount: () => asked.length,
    } as unknown as ScClient;
    const orgs = Array.from({ length: ORG_INFO_MAX + 5 }, (_, i) => `a${String(i).padStart(2, "0")}`).reverse();
    const started = Date.now();
    const info = await orgInfoOf(client, [...orgs, "Me"], { owner: "me", concurrency: 2, deadlineMs: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(asked[0]).toBe("/orgs/Me");
    expect(asked.length).toBe(ORG_INFO_MAX);
    expect(asked).not.toContain(`/orgs/a${ORG_INFO_MAX + 4}`);
    expect(info["a00"]).toBeUndefined();
    expect(info["a01"]).toEqual({ displayName: "/orgs/a01" });
  });
});
