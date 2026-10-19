// UX 17.10, «Мои репозитории»: живой список SourceCraft по токену (/me/repos) с
// данными каталога; «Избранное» без пользователя не пополняется; диалог добавления —
// по организациям; заготовки файлов — окном с текстом; подсказка бейджа — в (?).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { favoriteScoreOf, listSourcecraftRepos, myRepoEntryOf, tokenRepoEntries } from "../src/api/me";
import { patOwnerLogin, storePat } from "../src/auth/pat";
import type { ScClient } from "../src/collectors/http";
import {
  filterTokenRows,
  groupByOrg,
  orderOrgs,
  orgMetaText,
  orgSummaryOf,
  scoreChange,
  sortEntries,
  tokenParamsOf,
  tokenRowOrder,
  tokenSearchOf,
  tokenStateOf,
  TOKEN_FILTER_DEFAULT,
  type TokenRow,
} from "../src/web/myRepos";
import { parseRoute } from "../src/web/router";
import { makeApiDb, seedRepo, seedScan, seedScore, cardFacts } from "./api-fixtures";

const src = (path: string): string => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

describe("отметки строк кабинета (флаг, AI-обзор) — по правилам карточки", () => {
  test("закрытый без полного Score — без отметок; с полным — флаг и любой обзор; открытый — флаг и только публичный обзор", () => {
    const t = makeApiDb();
    try {
      const user = Number(t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-1', 'me', '2026', '2026')").run().lastInsertRowid);
      const note = (repoId: number, scanId: number, role: string, text: string, audience: string) =>
        t.db
          .query("INSERT INTO ai_notes (repo_id, scan_id, role, text, fact_refs, charter_version, model, created_at, audience) VALUES (?, ?, ?, ?, '[]', '7', 'm', '2026', ?)")
          .run(repoId, scanId, role, text, audience);
      const flag = JSON.stringify({ flag: true, factors: [{ key: "activity.rhythm", note: "ровный ритм" }], signals: {}, inputs: {} });
      const repos: Record<string, number> = {};
      for (const [repo, visibility] of [["closed", "private"], ["full", "private"], ["open", "public"]] as const) {
        const id = seedRepo(t, { org: "team", repo });
        t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, id);
        const scan = seedScan(t, id, { facts: cardFacts() });
        seedScore(t, id, scan, { total: 60 });
        note(id, scan, "flagger", flag, "full");
        note(id, scan, "overview", "x", "full");
        repos[repo] = id;
      }
      // полный Score по сохраненной проверке прав – только у «full»
      t.db
        .query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access) VALUES (?, 'team', 'full', '2026', ?)")
        .run(user, JSON.stringify({ clone: true, visibility: "private", ci: true, appsec: true, own: true }));
      const rows = tokenRepoEntries(t.db, user, [
        { org: "team", slug: "closed", name: null, visibility: "private", isEmpty: false },
        { org: "team", slug: "full", name: null, visibility: "private", isEmpty: false },
        { org: "team", slug: "open", name: null, visibility: "public", isEmpty: false },
      ]);
      expect(rows.map((r) => ({ repo: r.repo, flag: r.fraudFlag?.flag ?? false, ai: r.aiOverview }))).toEqual([
        { repo: "closed", flag: false, ai: false },
        { repo: "full", flag: true, ai: true },
        // у открытого полный обзор посторонним не виден – отметки AI нет, флаг виден всем
        { repo: "open", flag: true, ai: false },
      ]);
      note(repos.open!, Number((t.db.query("SELECT MAX(id) AS id FROM scans WHERE repo_id = ?").get(repos.open!) as { id: number }).id), "overview", "y", "public");
      expect(myRepoEntryOf(t.db, user, "team", "open").aiOverview).toBe(true);
      expect(myRepoEntryOf(t.db, user, "team", "full").fraudFlag?.factors).toEqual([{ key: "activity.rhythm", note: "ровный ритм" }]);
      expect(myRepoEntryOf(t.db, user, "team", "closed").fraudFlag).toBeNull();
    } finally {
      t.close();
    }
  });
});

describe("«Мои репозитории»: данные строки", () => {
  test("репо из списка по токену: закрытый раскрывает оценку (чтение доказано списком), выбывший публичный — нет; отметка «в избранном»", () => {
    const t = makeApiDb();
    try {
      const user = Number(t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-1', 'me', '2026', '2026')").run().lastInsertRowid);
      const priv = seedRepo(t, { org: "team", repo: "backend" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      seedScore(t, priv, seedScan(t, priv, { facts: cardFacts() }), { total: 64 });
      const gone = seedRepo(t, { org: "team", repo: "old" });
      t.db.query("UPDATE repos SET rating_active = 0 WHERE id = ?").run(gone);
      seedScore(t, gone, seedScan(t, gone, { facts: cardFacts() }), { total: 80 });
      t.db.query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at) VALUES (?, 'team', 'backend', '2026')").run(user);
      const rows = tokenRepoEntries(t.db, user, [
        { org: "team", slug: "backend", name: "Backend", visibility: "private", isEmpty: false },
        { org: "team", slug: "old", name: null, visibility: "public", isEmpty: false },
        { org: "team", slug: "fresh", name: null, visibility: "private", isEmpty: true },
      ]);
      expect(rows.map((r) => ({ repo: r.repo, index: r.healthcraftIndex, mayRead: r.mayRead, inCatalog: r.inCatalog, favorite: r.favorite, isEmpty: r.isEmpty }))).toEqual([
        { repo: "backend", index: 64, mayRead: true, inCatalog: true, favorite: true, isEmpty: false },
        { repo: "old", index: null, mayRead: false, inCatalog: true, favorite: false, isEmpty: false },
        { repo: "fresh", index: null, mayRead: true, inCatalog: false, favorite: false, isEmpty: true },
      ]);
    } finally {
      t.close();
    }
  });

  test("группы по организациям по алфавиту, внутри — закрытые первыми", () => {
    const g = groupByOrg([
      { org: "zeta", slug: "a", visibility: "public" },
      { org: "acme", slug: "site", visibility: "public" },
      { org: "acme", slug: "infra", visibility: "internal" },
      { org: "acme", slug: "backend", visibility: "private" },
    ], (r) => r.slug);
    expect(g.map((x) => [x.org, x.items.map((i) => i.slug)])).toEqual([
      ["acme", ["backend", "infra", "site"]],
      ["zeta", ["a"]],
    ]);
  });
});

describe("«Мои репозитории»: сервер и навигация", () => {
  test("список по токену — общий кэш (`tokenRepoCache`): сбрасывается сменой и удалением токена; окно чтений — только на новый обход", () => {
    // поведение кэша (общий обход, прежний список при исчерпанном окне, обход прежним
    // токеном) проверяет v63-org-repos.test.ts; здесь — что маршрут и токен им пользуются
    const server = src("server.ts");
    expect(server).toContain("ttlMs: 10 * 60_000,");
    expect(server.match(/tokenRepoCache\.forget\(user\.userId\);/g)?.length).toBe(2);
    const route = server.slice(server.indexOf('"/api/me/sourcecraft-repos"'), server.indexOf('"/api/me/favorites"'));
    expect(route).toContain("mayWalk: () => allowMyReposView(user.userId)");
    // пикеру избранного данные каталога не собираются
    expect(route).toContain('params.get("entries") === "0" ? {} : { entries: tokenRepoEntries(db, user.userId, list.repos) }');
    expect(src("web/MePage.tsx")).toContain('fetch("/api/me/sourcecraft-repos?entries=0"');
  });

  test("сохранение токена не пополняет «Избранное»", () => {
    expect(src("server.ts")).not.toMatch(/seedFavorites|\/orgs\/\$\{encodeURIComponent\(username\)\}\/repos/);
    expect(src("api/me.ts")).not.toContain("export async function seedFavoritesFromNamespace");
  });

  test("маршрут /repos, пункт меню после «Сравнения» и перед «Избранным»; закрытый репозиторий — в «Моих репозиториях»", () => {
    expect(parseRoute("/repos")).toEqual({ kind: "repos" });
    const shell = src("web/Shell.tsx");
    const order = ['id: "rating"', 'id: "compare"', 'id: "repos"', 'id: "me"'].map((id) => shell.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(src("web/RepoPage.tsx")).toContain('closedRepo ? { text: "Мои репозитории", href: "/repos" }');
  });
});

describe("заготовки, бейдж, лимиты", () => {
  test("заготовка — окно: куда положить, текст, «Скопировать» и «Скачать» тем же текстом без второго запроса", () => {
    const page = src("web/RepoPage.tsx");
    const fn = page.slice(page.indexOf("function FixTemplateButton("), page.indexOf("function FactProof"));
    expect(fn).toMatch(/<Popover\s+open=\{open\}/);
    // сбой не запоминается — следующее открытие окна повторит запрос
    expect(fn).toContain("if (!next) setTexts(");
    expect(fn).toContain("<CopyToClipboard text={text ?? \"\"}");
    expect(fn).toContain('new Blob([text], { type: "text/plain;charset=utf-8" })');
    expect(fn.match(/fetch\(/g)?.length).toBe(1);
    expect(page).toContain("Положите файл в корень репозитория и замените @login на логины ответственных.");
  });

  test("бейдж: окно без пояснений, JSON — пунктом формата у поля кода", () => {
    const v5 = src("web/RepoV5.tsx");
    // компактное окно: подсказка «куда вставить» — в документации, не в окне
    expect(v5).not.toContain("Вставьте в начало README.md");
    expect(v5).toContain('json: "JSON API"');
    expect(v5).not.toContain("Данные в JSON");
  });

  // 19.10.2026: таблица лимитов заменена квотами карточками — на телефоне они
  // встают столбиком сами, без прокрутки вбок
  test("«Лимиты AI» на телефоне: квоты столбиком", () => {
    expect(src("web/layout.css")).toMatch(/\.rh-settings__quotas \{\s+display: grid;\s+grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 300px\), 1fr\)\);/);
    expect(src("web/layout.css")).not.toContain(".rh-ai-quota");
  });
});

const row = (p: Partial<TokenRow> & { org: string; repo: string }): TokenRow => ({
  title: null,
  language: null,
  visibility: "public",
  isEmpty: false,
  healthcraftIndex: null,
  lastScanAt: null,
  lastScanStatus: null,
  ...p,
});

describe("«Мои репозитории»: фильтры, порядок, адрес", () => {
  const rows = [
    row({ org: "acme", repo: "site", language: "Go", healthcraftIndex: 82, lastScanAt: "2026-10-01" }),
    row({ org: "acme", repo: "backend", visibility: "private", language: "Go" }),
    row({ org: "me", repo: "notes", visibility: "internal", isEmpty: true }),
    row({ org: "zeta", repo: "broken", lastScanAt: "2026-10-02", lastScanStatus: "bad" }),
    row({ org: "zeta", repo: "thin", lastScanAt: "2026-10-03", lastScanStatus: "partial", language: "Rust" }),
  ];

  test("состояние строки: зона оценки, пустой, ошибка, оценки нет, не анализировали", () => {
    expect(rows.map(tokenStateOf)).toEqual(["success", "never", "empty", "failed", "unscored"]);
  });

  test("фильтры: поиск по организации, видимость, состояние, язык (пустой — «не определен»)", () => {
    const names = (f: Partial<typeof TOKEN_FILTER_DEFAULT>) => filterTokenRows(rows, { ...TOKEN_FILTER_DEFAULT, ...f }).map((r) => r.repo);
    expect(names({ q: "ZETA" })).toEqual(["broken", "thin"]);
    expect(names({ vis: "closed" })).toEqual(["backend", "notes"]);
    expect(names({ states: ["never"] })).toEqual(["backend"]);
    // мультивыбор: любое из выбранных
    expect(names({ states: ["failed", "empty"] })).toEqual(["notes", "broken"]);
    expect(names({ langs: [""] })).toEqual(["notes", "broken"]);
    expect(names({ langs: ["Go", "Rust"] })).toEqual(["site", "backend", "thin"]);
    expect(names({ orgs: ["acme", "me"], vis: "public" })).toEqual(["site"]);
  });

  test("организация владельца токена — первой, остальные по алфавиту; группы — в том же порядке", () => {
    expect(orderOrgs(["zeta", "acme", "Me"], "me")).toEqual(["Me", "acme", "zeta"]);
    expect(groupByOrg(rows, (r) => r.repo, { owner: "zeta" }).map((g) => g.org)).toEqual(["zeta", "acme", "me"]);
  });

  test("сортировка внутри организации: «Сначала без анализа», по индексу, по дате", () => {
    const acme = rows.filter((r) => r.org === "acme");
    expect([...acme].sort(tokenRowOrder("never")).map((r) => r.repo)).toEqual(["backend", "site"]);
    expect([...acme].sort(tokenRowOrder("index")).map((r) => r.repo)).toEqual(["site", "backend"]);
    expect([...rows].sort(tokenRowOrder("scan")).map((r) => r.repo).slice(0, 3)).toEqual(["thin", "broken", "site"]);
  });

  test("выбор в адресе: туда и обратно без потерь; по умолчанию — пустой адрес", () => {
    const f = { q: "api", orgs: ["acme", "me"], vis: "closed" as const, states: ["never" as const, "failed" as const], langs: ["", "C++"] };
    const search = tokenSearchOf(f, "index");
    expect(tokenParamsOf(search)).toEqual({ filter: f, sort: "index" });
    expect(tokenSearchOf(TOKEN_FILTER_DEFAULT, "name")).toBe("");
    expect(tokenParamsOf("?vis=nope&state=x&sort=y")).toEqual({ filter: TOKEN_FILTER_DEFAULT, sort: "name" });
  });
});

describe("«Избранное»: что изменилось", () => {
  test("изменение — по показанным числам; сортировка «По изменению» — по величине, без сравнения — в конце", () => {
    const e = (repo: string, healthcraftIndex: number | null, previousIndex: number | null) => ({ org: "o", repo, title: null, healthcraftIndex, previousIndex, lastScanAt: null });
    expect(scoreChange(e("a", 72.4, 64.6))).toBe(7);
    expect(scoreChange(e("b", 50, null))).toBeNull();
    expect(sortEntries([e("small", 60, 58), e("none", 60, null), e("drop", 40, 52)], "change", true).map((x) => x.repo)).toEqual(["drop", "small", "none"]);
  });

  test("предыдущая оценка — второй пригодный скан той же модели", () => {
    const t = makeApiDb();
    try {
      const user = Number(t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-2', 'w', '2026', '2026')").run().lastInsertRowid);
      const id = seedRepo(t, { org: "o", repo: "watched" });
      seedScore(t, id, seedScan(t, id, { facts: cardFacts(), startedAt: "2026-09-01T00:00:00Z" }), { total: 61 });
      seedScore(t, id, seedScan(t, id, { facts: cardFacts(), startedAt: "2026-10-01T00:00:00Z" }), { total: 70 });
      const entry = myRepoEntryOf(t.db, user, "o", "watched");
      expect({ now: entry.healthcraftIndex, before: entry.previousIndex }).toEqual({ now: 70, before: 61 });
    } finally {
      t.close();
    }
  });
});

describe("«Мои репозитории»: сервер", () => {
  test("логин владельца токена сохраняется вместе с токеном и перезаписывается при замене", () => {
    const t = makeApiDb();
    try {
      const user = Number(t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-3', 'x', '2026', '2026')").run().lastInsertRowid);
      const secret = "s".repeat(32);
      storePat(t.db, secret, user, "token-1-value", new Date(), "my-team");
      expect(patOwnerLogin(t.db, user)).toBe("my-team");
      storePat(t.db, secret, user, "token-2-value", new Date(), null);
      expect(patOwnerLogin(t.db, user)).toBeNull();
    } finally {
      t.close();
    }
  });

  test("сбой на странице после первой — собранное с interrupted (такой список не кэшируется); потолок — без него", async () => {
    let call = 0;
    const client = {
      async get() {
        call++;
        return call === 1
          ? { status: 200, json: { repositories: [{ organization: { slug: "o" }, slug: "a" }], next_page_token: "t" }, bodyText: "" }
          : { status: 503, json: {}, bodyText: "" };
      },
    } as unknown as ScClient;
    const res = await listSourcecraftRepos(client);
    expect({ status: res.status, partial: res.partial, interrupted: res.interrupted, n: res.repos.length }).toEqual({ status: "ok", partial: true, interrupted: true, n: 1 });
    const capped = await listSourcecraftRepos(
      { async get() { return { status: 200, json: { repositories: [{ organization: { slug: "o" }, slug: "a" }, { organization: { slug: "o" }, slug: "b" }], next_page_token: "more" }, bodyText: "" }; } } as unknown as ScClient,
      { maxItems: 2 },
    );
    expect({ partial: capped.partial, interrupted: capped.interrupted }).toEqual({ partial: true, interrupted: undefined });
  });
});

describe("отказ «не свой» не расходует лимит запусков", () => {
  test("not_own — без строки отказа; «нет доступа» и «токен отклонен» — со строкой (защита от перебора)", () => {
    const server = src("server.ts");
    const fn = server.slice(server.indexOf("function scanRefusal("), server.indexOf("function scanResponse("));
    const recordOf = (code: string) => {
      const at = fn.indexOf(`code: "${code}"`);
      return fn.slice(at, fn.indexOf("record:", at) + 14);
    };
    expect(recordOf("not_own")).toContain("record: false");
    expect(recordOf("no_access")).toContain("record: true");
    expect(recordOf("pat_expired")).toContain("record: true");
  });
});

describe("шапка организации в «Моих репозиториях»", () => {
  const row = (visibility: string, healthcraftIndex: number | null) => ({
    org: "o",
    repo: "r",
    title: null,
    language: null,
    visibility,
    isEmpty: false,
    healthcraftIndex,
    lastScanAt: null,
    lastScanStatus: null,
  });
  test("сводка: оценено, закрытые, зоны; строка — слаг только при своем названии, без «·»", () => {
    const s = orgSummaryOf([row("private", 80), row("internal", 50), row("public", 20), row("public", null)]);
    expect(s).toEqual({ scored: 3, closed: 2, zones: { success: 1, warning: 1, danger: 1 } });
    expect(orgMetaText("lct", "ЛЦТ", s)).toBe("lct, 3 оценено, 2 закрытых");
    expect(orgMetaText("lct", "lct", s)).toBe("3 оценено, 2 закрытых");
    expect(orgMetaText("lct", undefined, orgSummaryOf([row("public", null)]))).toBe("Еще не оценивались");
    expect(orgMetaText("lct", undefined, orgSummaryOf([row("private", null)]))).toBe("Еще не оценивались, 1 закрытый");
  });
});

describe("оценка в GET /api/me/favorites", () => {
  test("публичный в рейтинге – оценка всем; закрытый – только с сохраненной проверкой действующего токена", () => {
    const t = makeApiDb();
    try {
      const user = Number(t.db.query("INSERT INTO users (ya_id, login, created_at, last_login_at) VALUES ('ya-f', 'f', '2026', '2026')").run().lastInsertRowid);
      const pub = seedRepo(t, { org: "o", repo: "pub" });
      seedScore(t, pub, seedScan(t, pub, { facts: cardFacts() }), { total: 70 });
      const priv = seedRepo(t, { org: "o", repo: "priv" });
      seedScore(t, priv, seedScan(t, priv, { facts: cardFacts() }), { total: 55 });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      expect(favoriteScoreOf(t.db, user, "o", "pub")).toBe(70);
      expect(favoriteScoreOf(t.db, user, "o", "priv", { savedRightsValid: true })).toBeNull();
      t.db
        .query("INSERT INTO favorites (user_id, org_slug, repo_slug, added_at, last_access) VALUES (?, 'o', 'priv', '2026', ?)")
        .run(user, JSON.stringify({ clone: true, visibility: "private", ci: false, appsec: false, own: true }));
      expect(favoriteScoreOf(t.db, user, "o", "priv", { savedRightsValid: true })).toBe(55);
      expect(favoriteScoreOf(t.db, user, "o", "priv", { savedRightsValid: false })).toBeNull();
    } finally {
      t.close();
    }
  });
});
