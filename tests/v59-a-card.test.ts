// v59-a-card.test.ts — В5.9 (воркер А): поля карточки `ladder` и
// `recommendations[].fixTemplate` на временной БД, собранной НАСТОЯЩИМ
// конвейером оценки (compute → recommend → writeScores/writeRecommendations).
// Правило AGENTS.md 21.09: поле API, которое рисует экран, — тест «равно
// источнику» и отдельно «без прав не раскрывается».
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getRepoCard, fixFileFor } from "../src/api/repos";
import { getPublicRepo } from "../src/api/public";
import { effectiveFacts } from "../src/score/compute";
import { ladderFromFacts } from "../src/score/ladder";
import { templateFor } from "../src/fix/templates";
import { roundScore } from "../src/web/format";
import { makeApiDb, seedRepo, type ApiTestDb } from "./api-fixtures";
import { healthyFacts, NOW } from "./score-fixtures";
import { codeEmptyFacts, reachesFacts, seedScored, unreachedFacts } from "./v59-a-fixtures";

const GRANTED = { repo: "granted", cicd: "granted", appsec: "granted" } as const;

let t: ApiTestDb;
let db: Database;
const scans: Record<string, number> = {};

beforeAll(() => {
  t = makeApiDb();
  db = t.db;
  scans.reaches = seedScored(t, "acme", "reaches", reachesFacts());
  scans.unreached = seedScored(t, "acme", "unreached", unreachedFacts());
  scans.healthy = seedScored(t, "acme", "healthy", healthyFacts());
  scans.empty = seedScored(t, "acme", "empty", codeEmptyFacts());
  scans.secret = seedScored(t, "acme", "secret", unreachedFacts(), "private");
  seedRepo(t, { org: "acme", repo: "unscored" });
});

afterAll(() => t.close());

describe("В5.9: лестница в карточке — равно источнику", () => {
  test("первый шаг = Δ рекомендации карточки; старт = показанный индекс", () => {
    for (const slug of ["reaches", "unreached"]) {
      const card = getRepoCard(db, "acme", slug, { withRank: false })!;
      const ladder = card.ladder!;
      expect(ladder).not.toBeNull();
      const first = ladder.steps[0]!;
      const rec = card.recommendations.find((r) => r.ruleId === first.ruleId)!;
      expect(rec).toBeDefined();
      expect(rec.kind).toBe("presence");
      expect(rec.channel).toBeNull();
      expect(first.delta).toBe(rec.deltaScore!);
      // первый шаг — наибольший Δ среди публичных presence-рекомендаций карточки
      expect(first.delta).toBe(Math.max(...card.recommendations.filter((r) => r.kind === "presence" && r.channel === null).map((r) => r.deltaScore ?? -Infinity)));
      expect(roundScore(ladder.start)).toBe(card.score!.healthcraftIndex!);
    }
  });

  test("лестница карточки = ladderFromFacts на эффективных фактах скана P и дате оценки", () => {
    const card = getRepoCard(db, "acme", "unreached", { withRank: false })!;
    const scanId = scans.unreached!;
    const repoId = (db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number }).repo_id;
    const eff = effectiveFacts(db, scanId, repoId);
    const direct = ladderFromFacts(eff.ok, { scanId, repoId, stale: eff.stale, staleCats: eff.staleCats, emptyRepo: eff.emptyRepo }, new Date(card.score!.computedAt));
    expect(card.ladder).toEqual(direct);
    expect(card.ladder!.reached).toBe(false);
    expect(getRepoCard(db, "acme", "reaches", { withRank: false })!.ladder!.reached).toBe(true);
  });

  test("пустые состояния: в зоне, без кода, без оценки — ladder = null", () => {
    const healthy = getRepoCard(db, "acme", "healthy", { withRank: false })!;
    expect(healthy.score!.healthcraftIndex!).toBeGreaterThanOrEqual(70);
    expect(healthy.ladder).toBeNull();
    const empty = getRepoCard(db, "acme", "empty", { withRank: false })!;
    expect(empty.markers.codeEmpty).toBe(true);
    expect(empty.ladder).toBeNull();
    const unscored = getRepoCard(db, "acme", "unscored", { withRank: false })!;
    expect(unscored.score).toBeNull();
    expect(unscored.ladder).toBeNull();
  });

  test("не хранится: чтение карточки не пишет в scores и recommendations", () => {
    const snap = () => JSON.stringify([db.query("SELECT * FROM scores ORDER BY scan_id").all(), db.query("SELECT * FROM recommendations ORDER BY scan_id, rule_id").all()]);
    const before = snap();
    for (const slug of ["reaches", "unreached", "healthy"]) getRepoCard(db, "acme", slug, { withRank: false });
    expect(snap()).toBe(before);
    expect(before).not.toContain("ladder");
    expect(before).not.toContain("indexAfter");
  });

  test("не попадает в /api/v1: публичная проекция без лестницы и признаков заготовок", () => {
    const proj = getPublicRepo(db, "acme", "unreached")!;
    expect(proj).not.toBeNull();
    const json = JSON.stringify(proj);
    for (const leak of ["ladder", "steps", "indexAfter", "withoutNumber", "fixTemplate"]) expect(json).not.toContain(leak);
  });

  test("приватный: без прав карточки нет (null), с правами лестница есть", () => {
    expect(getRepoCard(db, "acme", "secret", { withRank: false })).toBeNull();
    const own = getRepoCard(db, "acme", "secret", { withRank: false, access: GRANTED })!;
    expect(own.ladder).not.toBeNull();
    expect(own.ladder!.steps.length).toBeGreaterThan(0);
  });
});

describe("В5.9: признак fixTemplate — равно источнику (заготовка есть ⇔ файл отдается)", () => {
  test("у правил документации — имя файла; у прочих — null; лицензия — с вариантами", () => {
    const card = getRepoCard(db, "acme", "unreached", { withRank: false })!;
    const byRule = Object.fromEntries(card.recommendations.map((r) => [r.ruleId, r.fixTemplate]));
    expect(byRule["license-missing"]).toEqual({ filename: "LICENSE", licenses: ["mit", "apache-2.0"] });
    expect(byRule["contributing-missing"]).toEqual({ filename: "CONTRIBUTING.md" });
    expect(byRule["codeowners-missing"]).toEqual({ filename: "CODEOWNERS" });
    expect(byRule["readme-sections-missing"]).toEqual({ filename: "README-sections.md" });
    for (const [id, meta] of Object.entries(byRule)) {
      if (!["license-missing", "contributing-missing", "codeowners-missing", "readme-sections-missing"].includes(id)) expect(meta).toBeNull();
    }
  });

  test("признак есть ⇔ fixFileFor отдает файл; содержимое = templateFor на фактах скана P", () => {
    for (const slug of ["reaches", "unreached", "healthy", "empty"]) {
      const card = getRepoCard(db, "acme", slug, { withRank: false })!;
      for (const ruleId of ["contributing-missing", "readme-missing", "readme-sections-missing", "codeowners-missing", "license-missing"] as const) {
        const rec = card.recommendations.find((r) => r.ruleId === ruleId);
        const file = fixFileFor(db, card, ruleId, { license: "mit", now: NOW });
        expect(file !== null).toBe(rec !== undefined && rec.fixTemplate !== null && rec.fixTemplate !== undefined);
        if (file) {
          const scanId = scans[slug]!;
          const repoId = (db.query("SELECT repo_id FROM scans WHERE id = ?").get(scanId) as { repo_id: number }).repo_id;
          expect(file).toEqual(templateFor(ruleId, effectiveFacts(db, scanId, repoId).ok, { org: "acme", repo: slug, title: slug }, { license: "mit", now: NOW })!);
          expect(file.filename).toBe(rec!.fixTemplate!.filename);
        }
      }
    }
  });

  test("правило не срабатывает — файла нет (не отдаем «на всякий случай»)", () => {
    const healthy = getRepoCard(db, "acme", "healthy", { withRank: false })!;
    expect(healthy.recommendations.some((r) => r.ruleId === "license-missing")).toBe(false);
    expect(fixFileFor(db, healthy, "license-missing", { license: "mit" })).toBeNull();
    expect(fixFileFor(db, healthy, "contributing-missing")).toBeNull();
  });
});
