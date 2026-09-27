// «Мои репозитории» отдают логотип, цвет языка и дату активности из `repos`, как
// рейтинг: литерал null на месте поля совпадал бы по типу, но кабинет терял бы
// аватары и цвета. Поведенческий тест на временной БД: значения совпадают с
// рейтингом при правах; без прав мета не раскрывается.
import { afterAll, describe, expect, test } from "bun:test";
import { addFavorite, listMyRepos, myJobs } from "../src/api/me";
import { upsertUser } from "../src/auth/session";
import { makeApiDb, seedRepo, type ApiTestDb } from "./api-fixtures";

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const user = upsertUser(t.db, "ya-v48-meta", "v48meta");
const LOGO = "https://storage.yandexcloud.net/yc-sourcecraft-user-uploads/logo-v48";

function seed(repo: string, visibility: "public" | "private"): void {
  seedRepo(t, { org: "meta", repo, language: "TypeScript", lastActivityAt: "2026-09-15T10:00:00Z" });
  t.db
    .query("UPDATE repos SET logo_url = ?, language_color = ?, visibility = ? WHERE org_slug = 'meta' AND repo_slug = ?")
    .run(LOGO, "#3178c6", visibility, repo);
  addFavorite(t.db, user, "meta", repo);
}

async function entryOf(repo: string) {
  const entry = (await listMyRepos(t.db, user)).entries.find((e) => e.repo === repo);
  if (!entry) throw new Error(`нет записи ${repo}`);
  return entry;
}

describe("В4.8: мета записи «Моих репозиториев» — из repos, под гейтом прав", () => {
  test("публичный активный: логотип, цвет языка и активность те же, что в repos", async () => {
    seed("public-one", "public");
    const e = await entryOf("public-one");
    expect({ mayRead: e.mayRead, logoUrl: e.logoUrl, languageColor: e.languageColor, lastActivityAt: e.lastActivityAt, language: e.language }).toEqual({
      mayRead: true,
      logoUrl: LOGO,
      languageColor: "#3178c6",
      lastActivityAt: "2026-09-15T10:00:00Z",
      language: "TypeScript",
    });
  });

  test("без прав (приватный, проверки нет): мета не раскрывается — все три поля null", async () => {
    seed("private-one", "private");
    const e = await entryOf("private-one");
    expect({ mayRead: e.mayRead, logoUrl: e.logoUrl, languageColor: e.languageColor, lastActivityAt: e.lastActivityAt, title: e.title }).toEqual({
      mayRead: false,
      logoUrl: null,
      languageColor: null,
      lastActivityAt: null,
      title: null,
    });
  });

  test("приватный с сохраненной проверкой clone=true: мета раскрывается", async () => {
    t.db
      .query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ? AND org_slug = 'meta' AND repo_slug = 'private-one'")
      .run(JSON.stringify({ clone: true, visibility: "private", ci: true, appsec: true, own: true }), "2026-09-21T12:00:00Z", user);
    const e = await entryOf("private-one");
    expect({ mayRead: e.mayRead, logoUrl: e.logoUrl, languageColor: e.languageColor }).toEqual({ mayRead: true, logoUrl: LOGO, languageColor: "#3178c6" });
  });
});

describe("В4.8: задания зрителя несут логотип репозитория (панель «Заданий»)", () => {
  test("активное и завершенное — логотип из repos; без логотипа — null; отказанная без строки repos — null", () => {
    const withLogo = seedRepo(t, { org: "jobs", repo: "with-logo" });
    t.db.query("UPDATE repos SET logo_url = ? WHERE id = ?").run(LOGO, withLogo);
    const noLogo = seedRepo(t, { org: "jobs", repo: "no-logo" });
    const insert = t.db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind, error) VALUES (?, ?, ?, 'user', ?)");
    insert.run(withLogo, "running", user, null);
    insert.run(noLogo, "done", user, null);
    insert.run(0, "refused", user, JSON.stringify({ code: "no_access", slug: "jobs/refused" }));
    const { active, recent } = myJobs(t.db, user);
    expect(active.map((j) => ({ slug: j.slug, logoUrl: j.logoUrl }))).toEqual([{ slug: "jobs/with-logo", logoUrl: LOGO }]);
    expect(recent.map((j) => ({ slug: j.slug, logoUrl: j.logoUrl }))).toEqual([
      { slug: "jobs/refused", logoUrl: null },
      { slug: "jobs/no-logo", logoUrl: null },
    ]);
  });

  test("ревью закрытия: логотип задания — под тем же признаком прав, что мета списка (fail-closed)", () => {
    const hidden = seedRepo(t, { org: "jobs", repo: "private-no-rights" });
    t.db.query("UPDATE repos SET logo_url = ?, visibility = 'private' WHERE id = ?").run(LOGO, hidden);
    t.db.query("INSERT INTO jobs (repo_id, status, user_id, trigger_kind) VALUES (?, 'done', ?, 'user')").run(hidden, user);
    const job = myJobs(t.db, user).recent.find((j) => j.slug === "jobs/private-no-rights");
    expect(job?.logoUrl).toBeNull();
  });
});
