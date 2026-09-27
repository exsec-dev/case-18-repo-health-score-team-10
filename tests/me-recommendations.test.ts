// Счетчик рекомендаций «Моих репозиториев». Число проверяется на данных, а не
// по исходнику: при актуальной проверке прав `recommendationsCount` равен
// `getRepoCardForViewer(...).recommendations.length` для того же зрителя —
// на карточке с закрытыми и с открытыми каналами. Без прав — null, не 0;
// права есть, скана нет — 0, как на карточке. Сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { getRepoCardForViewer } from "../src/api/repos";
import { addFavorite, listMyRepos, type FavoriteAccess } from "../src/api/me";
import type { AccessResult } from "../src/auth/access";
import { upsertUser } from "../src/auth/session";
import { recommendationsText } from "../src/web/format";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

const t: ApiTestDb = makeApiDb();
afterAll(() => t.close());

const user = upsertUser(t.db, "ya-v47-recs", "v47recs");

/** Публичный репо: CI только конфигом (правило grant-ci-runs у зрителя с CI), AppSec без данных (connect-appsec у зрителя с Security). */
function seedPublic(repo: string): void {
  const repoId = seedRepo(t, { org: "recs", repo, language: "Go" });
  const scanId = seedScan(t, repoId, { facts: cardFacts() });
  seedScore(t, repoId, scanId, { total: 64 });
  seedRecommendation(t, scanId, { ruleId: "contributing-missing", priority: 1, factRef: "docs.presence", deltaScore: 2.25 });
  seedRecommendation(t, scanId, { ruleId: "readme-sections", priority: 2, factRef: "docs.readme" });
}

/** Сохранённая проверка прав — то, что пишет `checkFavoriteAccess`. */
function saveCheck(repo: string, access: FavoriteAccess | null): void {
  t.db
    .query("UPDATE favorites SET last_access = ?, last_checked_at = ? WHERE user_id = ? AND org_slug = 'recs' AND repo_slug = ?")
    .run(access === null ? null : JSON.stringify(access), access === null ? null : "2026-09-16T12:00:00Z", user, repo);
}

/** Доступ, который зритель получил бы живой проверкой — тот же, что сохранён («актуальная проверка прав»). */
const liveAccessOf = (access: FavoriteAccess): AccessResult => ({
  cicd: access.ci === true ? "granted" : "denied",
  appsec: access.appsec === true ? "granted" : "denied",
  repo: access.clone ? "granted" : "denied",
});

async function entryOf(repo: string) {
  const entry = (await listMyRepos(t.db, user)).entries.find((e) => e.repo === repo);
  if (!entry) throw new Error(`нет записи ${repo}`);
  return entry;
}

const CASES: { name: string; access: FavoriteAccess }[] = [
  { name: "каналы закрыты", access: { clone: true, visibility: "public", ci: false, appsec: false, own: false } },
  { name: "открыт только CI", access: { clone: true, visibility: "public", ci: true, appsec: false, own: true } },
  { name: "открыты CI и Security", access: { clone: true, visibility: "public", ci: true, appsec: true, own: true } },
];

describe("П3.4 (У26): recommendationsCount равен карточке при актуальной проверке прав", () => {
  for (const { name, access } of CASES) {
    test(name, async () => {
      const repo = `pub-${CASES.findIndex((c) => c.name === name)}`;
      seedPublic(repo);
      addFavorite(t.db, user, "recs", repo);
      saveCheck(repo, access);
      const card = await getRepoCardForViewer(t.db, "recs", repo, async () => liveAccessOf(access), { viewerUserId: user });
      const entry = await entryOf(repo);
      expect(card).not.toBeNull();
      expect(entry.recommendationsCount).toBe(card!.recommendations.length);
    });
  }

  test("число действительно зависит от открытых каналов (иначе равенство выше ничего не доказывает)", async () => {
    const counts = await Promise.all(CASES.map((_, i) => entryOf(`pub-${i}`).then((e) => e.recommendationsCount)));
    // 2 публичных; +grant-ci-runs при CI; +connect-appsec при Security
    expect(counts).toEqual([2, 3, 4]);
  });

  test("права не проверялись: канальные правила не считаются (fail-closed), публичные — да", async () => {
    seedPublic("unchecked");
    addFavorite(t.db, user, "recs", "unchecked");
    const closed = await getRepoCardForViewer(t.db, "recs", "unchecked", async () => ({ cicd: "no-pat", appsec: "no-pat", repo: "no-pat" }));
    expect((await entryOf("unchecked")).recommendationsCount).toBe(closed!.recommendations.length);
    expect(closed!.recommendations.length).toBe(2);
  });

  test("без прав — null, а не 0 (приватный репо без доказанных прав; слаг вне каталога)", async () => {
    const repoId = seedRepo(t, { org: "recs", repo: "private" });
    t.db.query("UPDATE repos SET visibility = 'private' WHERE id = ?").run(repoId);
    const scanId = seedScan(t, repoId, { facts: cardFacts() });
    seedScore(t, repoId, scanId, { total: 50 });
    seedRecommendation(t, scanId, { ruleId: "contributing-missing", priority: 1, factRef: "docs.presence", deltaScore: 1 });
    addFavorite(t.db, user, "recs", "private");
    addFavorite(t.db, user, "recs", "ghost");
    expect({ mayRead: (await entryOf("private")).mayRead, count: (await entryOf("private")).recommendationsCount }).toEqual({ mayRead: false, count: null });
    expect((await entryOf("ghost")).recommendationsCount).toBeNull();
  });

  test("приватный репо с доказанными правами: число как на карточке зрителя с этими правами", async () => {
    const access: FavoriteAccess = { clone: true, visibility: "private", ci: true, appsec: false, own: true };
    saveCheck("private", access);
    const card = await getRepoCardForViewer(t.db, "recs", "private", async () => liveAccessOf(access));
    expect((await entryOf("private")).recommendationsCount).toBe(card!.recommendations.length);
  });

  test("права есть, скана нет — 0, как на карточке", async () => {
    seedRepo(t, { org: "recs", repo: "never" });
    addFavorite(t.db, user, "recs", "never");
    const card = await getRepoCardForViewer(t.db, "recs", "never", async () => ({ cicd: "no-pat", appsec: "no-pat", repo: "no-pat" }));
    expect(card!.recommendations.length).toBe(0);
    expect((await entryOf("never")).recommendationsCount).toBe(0);
  });
});

describe("подпись счётчика: цифрой и с согласованием", () => {
  test("1 рекомендация, 2-4 рекомендации, 5-20 и 0 — рекомендаций, 21 — рекомендация", () => {
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(recommendationsText)).toEqual([
      "0 рекомендаций",
      "1 рекомендация",
      "2 рекомендации",
      "4 рекомендации",
      "5 рекомендаций",
      "11 рекомендаций",
      "12 рекомендаций",
      "14 рекомендаций",
      "21 рекомендация",
      "22 рекомендации",
      "25 рекомендаций",
      "101 рекомендация",
      "111 рекомендаций",
    ]);
  });
});
