// v485-surfaces.test.ts — В4.8.5, блок Б7: поверхности UI. К8.5.14 (кнопки
// анализа нет на чужих и у анонима — элемента нет; на своей карточке не из
// избранного — есть; пункта «Проверить доступ» нет нигде; тексты UI не
// утверждают обратного), К8.5.7 (строка обновляется точечно), К8.5.9
// («нет в каталоге» — про каталог сервиса), К8.5.10 (URL рейтинга приводится
// к допустимому, место на карточке = позиция строки), К8.5.11 (MD — fetch +
// blob, тост по коду). Чистые функции и данные — поведенческие, вёрстка и
// тексты — source-assert (AGENTS.md: для текстов разрешён).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard, listRepos, parseReposQuery } from "../src/api/repos";
import { favoriteAddedText, reportFailureText } from "../src/web/format";
import { firstSortOrder, normalizeRatingSearch, pageBeyond } from "../src/web/ratingParams";
import { makeApiDb, seedRepo, seedScan, seedScore, cardFacts } from "./api-fixtures";

const WEB = join(import.meta.dir, "..", "src", "web");
const web = (file: string): string => readFileSync(join(WEB, file), "utf8");
/** Исходник без комментариев: утверждения — о пользовательских строках, не о мотивировке. */
const code = (file: string): string => web(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const webFiles = readdirSync(WEB).filter((f) => /\.(tsx?|html)$/.test(f));

describe("К8.5.14: анализ — только своих; права — сами", () => {
  test("«Проверить доступ» нет ни в одном файле src/web — ни в строках, ни в комментариях", () => {
    expect(webFiles.filter((f) => web(f).includes("Проверить доступ"))).toEqual([]);
  });

  test("(ж) тексты UI не обещают анализ чужого и не зовут проверять доступ вручную", () => {
    const offenders = webFiles.filter((f) => /запустите (первый )?анализ|проверьте доступ|проверить доступ к своим/i.test(code(f)));
    expect(offenders).toEqual([]);
  });

  test("карточка: кнопка анализа — только на своем репозитории (элемента нет, а не disabled); на своем не из избранного — есть", () => {
    const repoPage = code("RepoPage.tsx");
    expect(repoPage).toContain('const canRefresh = data?.viewer?.own === true && data.viewer.auth === "pat";');
    expect(repoPage).toContain("const refreshButton = canRefresh && (");
    // «свой» на карточке — из доступа показа, без избранного
    const t = makeApiDb();
    try {
      const priv = seedRepo(t, { org: "mine", repo: "priv" });
      t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(priv);
      seedScore(t, priv, seedScan(t, priv, { facts: cardFacts() }), { total: 70 });
      const pub = seedRepo(t, { org: "other", repo: "pub" });
      seedScore(t, pub, seedScan(t, pub, { facts: cardFacts() }), { total: 70 });
      const favorites = (t.db.query("SELECT COUNT(*) AS c FROM favorites").get() as { c: number }).c;
      const own = getRepoCard(t.db, "mine", "priv", { access: { repo: "granted", cicd: "denied", appsec: "denied" }, viewerAuth: "pat" });
      const foreign = getRepoCard(t.db, "other", "pub", { access: { repo: "granted", cicd: "denied", appsec: "denied" }, viewerAuth: "pat" });
      const anon = getRepoCard(t.db, "other", "pub");
      expect({ favorites, own: own?.viewer?.own, foreign: foreign?.viewer?.own, anon: anon?.viewer?.own }).toEqual({ favorites: 0, own: true, foreign: false, anon: false });
    } finally {
      t.close();
    }
  });

  test("строка «Моих репозиториев»: кнопка анализа — только у своего (сохраненная проверка own), у чужого и непроверенного ее нет", () => {
    const me = code("MePage.tsx");
    expect(me).toContain("const canAnalyze = hasPat && access?.own === true;");
    expect(me).toContain("{!canAnalyze ? null : scored ? (");
  });

  test("исход автопроверки при добавлении — человеческим текстом, анализ чужого не обещается", () => {
    expect(favoriteAddedText({ status: "checked", enqueue: { status: "queued", code: null } })).toBe("Права проверены – запущен анализ, итог придет уведомлением.");
    expect(favoriteAddedText({ status: "checked", enqueue: { status: "skipped", code: "not_own" } })).toBe(
      "Права проверены. Анализ запускается только для своих репозиториев – этот обновит ночной обход.",
    );
    expect(favoriteAddedText({ status: "failed", enqueue: null })).toBe("Проверить права не удалось: SourceCraft сейчас не отвечает – проверим позже.");
    expect(favoriteAddedText({ status: "deferred", enqueue: null })).toBe("Права проверим в фоне – итог появится в строке списка.");
  });
});

describe("К8.5.7 / К8.5.9: строка и подсказки кабинета", () => {
  test("после добавления и снятия обновляется только строка — список целиком не перечитывается", () => {
    const section = code("MePage.tsx");
    const add = section.slice(section.indexOf("onAdded={(res) => {"), section.indexOf("function AddRepoDialog") > 0 ? section.indexOf("/>", section.indexOf("onAdded={(res) => {")) : undefined);
    expect(add).toContain("repos.set({ ...current, entries: [res.entry, ...rest] });");
    const remove = section.slice(section.indexOf("const removeFav = async"), section.indexOf("const reposData = dataOf(repos.state);"));
    expect(remove).toContain("repos.set({ ...current, entries: current.entries.filter(");
    expect(remove).not.toContain("reposReloadRef.current()");
  });

  test("С3-3: «Нет в каталоге» — о каталоге сервиса и без кнопки", () => {
    expect(code("MePage.tsx")).toContain('title="Репозитория пока нет в каталоге сервиса: его еще не анализировали, или адрес указан с ошибкой"');
  });
});

describe("К8.5.10: адрес рейтинга приводится к допустимому", () => {
  test("неизвестные sort/order/per_page/page заменяются дефолтом (адрес исправляется); верные — не трогаются", () => {
    expect(normalizeRatingSearch("sort=stars&order=up&per_page=500&page=0&q=go")).toEqual({ search: "q=go", changed: true });
    expect(normalizeRatingSearch("?sort=likes&order=asc&per_page=50&page=2")).toEqual({ search: "sort=likes&order=asc&per_page=50&page=2", changed: false });
    // исправленный адрес сервер принимает (раньше — 400 и «Повторить», повторяющий 400)
    expect(parseReposQuery(new URLSearchParams(normalizeRatingSearch("sort=stars&per_page=500").search)).ok).toBe(true);
  });

  test("С5-1: страница за пределами выдачи — последняя существующая", () => {
    const t = makeApiDb();
    try {
      for (let i = 0; i < 3; i++) {
        const id = seedRepo(t, { org: "o", repo: `r${i}` });
        seedScore(t, id, seedScan(t, id), { total: 50 + i });
      }
      const q = parseReposQuery(new URLSearchParams("page=5&per_page=2"));
      if (!q.ok) throw new Error(q.message);
      const res = listRepos(t.db, q.query);
      expect({ beyond: pageBeyond(res), inRange: pageBeyond({ ...res, page: 1, items: [1] }) }).toEqual({ beyond: 2, inRange: null });
    } finally {
      t.close();
    }
  });

  test("С5-8: первый клик по «Репозиторию» — А→Я, по числам — по убыванию; С5-5: поиск не откатывает параллельный выбор", () => {
    expect([firstSortOrder("name"), firstSortOrder("index"), firstSortOrder("likes")]).toEqual(["asc", "desc", "desc"]);
    expect(code("Rating.tsx")).toContain("const next = new URLSearchParams(window.location.search);");
  });

  test("С6-6: место на карточке = позиция строки в рейтинге при равных индексах", () => {
    const t = makeApiDb();
    try {
      for (const name of ["delta", "alpha", "charlie", "bravo"]) {
        const id = seedRepo(t, { org: "tie", repo: name });
        seedScore(t, id, seedScan(t, id, { facts: cardFacts() }), { total: 60 });
      }
      const top = seedRepo(t, { org: "top", repo: "one" });
      seedScore(t, top, seedScan(t, top, { facts: cardFacts() }), { total: 90 });
      const q = parseReposQuery(new URLSearchParams(""));
      if (!q.ok) throw new Error(q.message);
      const rows = listRepos(t.db, q.query).items.map((i) => `${i.org}/${i.repo}`);
      const places = rows.map((slug) => {
        const [org, repo] = slug.split("/") as [string, string];
        return getRepoCard(t.db, org, repo)?.score?.rank;
      });
      expect(places).toEqual([1, 2, 3, 4, 5]);
    } finally {
      t.close();
    }
  });

  test("С5-3: без /api/meta колонки категорий строятся из клиентских констант, панель не висит скелетоном", () => {
    const rating = code("Rating.tsx");
    expect(rating).toContain("(meta?.categories ?? FALLBACK_CATEGORIES)");
    expect(rating).toContain("if (!meta && metaFailed) {");
  });
});

describe("К8.5.11: выгрузка MD — как PDF", () => {
  test("совет «другой формат» — только при сбое сборки PDF; 429/404/сеть — свой текст", () => {
    expect(reportFailureText("pdf", 500, "pdf_failed")).toBe("Не удалось собрать PDF. Markdown-выгрузка – в этом же меню.");
    for (const [kind, status] of [["pdf", 429], ["md", 429], ["pdf", 404], ["md", 0]] as const) {
      expect(reportFailureText(kind, status, null)).not.toMatch(/Markdown|PDF/);
    }
    expect(reportFailureText("md", 503, "check_failed")).toBe("SourceCraft сейчас не отвечает – не удалось проверить доступ, попробуйте позже.");
  });
});
