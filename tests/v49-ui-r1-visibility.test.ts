// v49-ui-r1-visibility.test.ts — В4.9, часть 2 гейта, круг 1, блок Д: поле
// видимости в ответе карточки. Правила AGENTS.md 21.09 («поле API, которое
// рисует экран, — тест "равно источнику" на временной БД и "без прав не
// раскрывается"») и 22.09 («перечисление из спеки внешнего API — ветка и тест
// на каждое значение, "прочее" — явная ветка»).
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCard, resolveCardForViewer } from "../src/api/repos";
import { visibilityOf, type AccessResult } from "../src/auth/access";
import { cardFacts, makeApiDb, seedRepo, type ApiTestDb } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";

const NO_PAT: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };
const DENIED: AccessResult = { cicd: "denied", appsec: "denied", repo: "denied" };
const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

/** Репозиторий с оценкой и заданной строкой `repos.visibility` (как ее пишет каталог). */
function seedWith(repo: string, visibility: string): void {
  const id = seedRepo(t, { org: "vis", repo });
  t.db.query("UPDATE repos SET visibility = ? WHERE id = ?").run(visibility, id);
  scoredScan(t, id, { facts: cardFacts() });
}

seedWith("pub", "public");
seedWith("int", "internal");
seedWith("priv", "private");
seedWith("junk", "friends-only");

describe("блок Д: `repo.visibility` равно строке источника", () => {
  test("public → public (аноним видит публичный)", () => {
    const row = t.db.query("SELECT visibility FROM repos WHERE repo_slug = 'pub'").get() as { visibility: string };
    expect(getRepoCard(t.db, "vis", "pub")!.repo.visibility).toBe(row.visibility as "public");
  });

  test("internal → internal (зритель с правами)", () => {
    expect(getRepoCard(t.db, "vis", "int", { access: GRANTED })!.repo.visibility).toBe("internal");
  });

  test("private → private (зритель с правами)", () => {
    expect(getRepoCard(t.db, "vis", "priv", { access: GRANTED })!.repo.visibility).toBe("private");
  });

  test("мусор в строке → явное «неизвестно» (плашки нет), а не «публичный»", () => {
    expect(getRepoCard(t.db, "vis", "junk", { access: GRANTED })!.repo.visibility).toBe("unknown");
  });

  test("NULL: схема его не пускает (NOT NULL DEFAULT 'public'), источник поля отвечает «неизвестно»", () => {
    expect(() => t.db.query("UPDATE repos SET visibility = NULL WHERE repo_slug = 'junk'").run()).toThrow();
    expect(visibilityOf(null)).toBe("unknown");
    expect(visibilityOf(undefined)).toBe("unknown");
  });
});

describe("блок Д: без прав поле не раскрывается — карточка как несуществующая", () => {
  for (const repo of ["int", "priv"]) {
    test(`${repo}: аноним, без токена и без прав — 404 (null), поля нет`, async () => {
      expect(getRepoCard(t.db, "vis", repo)).toBeNull();
      expect(getRepoCard(t.db, "vis", repo, { access: NO_PAT })).toBeNull();
      expect(getRepoCard(t.db, "vis", repo, { access: DENIED })).toBeNull();
      const out = await resolveCardForViewer(t.db, "vis", repo, async () => DENIED, { viewerAuth: "pat" });
      expect(out).toEqual({ kind: "not_found" });
      expect(JSON.stringify(out)).not.toContain(repo === "int" ? "internal" : "private");
    });
  }
});
