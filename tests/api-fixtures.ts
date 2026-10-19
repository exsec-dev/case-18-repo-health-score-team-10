// Сид-набор для тестов read-API. Отдельный от score-fixtures.ts намеренно: там
// один репо без title/language/likes/forks/last_activity_at, а именно эти
// колонки проверяют фильтры, фасеты и сортировки рейтинга.
// Скоры вставляются готовыми строками: API — чистый читатель, и тест
// обязан ломаться на чтении, а не на пересчете модели.
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { categoryOf, encodeFactValue } from "../src/collectors/facts";
import { MODEL_VERSION, type CategoryKey } from "../src/score/model";

export const NOW = new Date("2026-09-16T12:00:00Z");

export interface ApiTestDb {
  db: Database;
  close: () => void;
}

export function makeApiDb(): ApiTestDb {
  const dir = mkdtempSync(join(tmpdir(), "rh-api-"));
  const db = openDb({ ...loadConfig(), dataDir: dir });
  return { db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export interface RepoSpec {
  org: string;
  repo: string;
  title?: string | null;
  language?: string | null;
  likes?: number | null;
  forks?: number | null;
  lastActivityAt?: string | null;
}

export function seedRepo(t: ApiTestDb, spec: RepoSpec): number {
  const r = t.db
    .query("INSERT INTO repos (org_slug, repo_slug, title, language, likes, forks, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      spec.org,
      spec.repo,
      spec.title ?? spec.repo,
      spec.language ?? null,
      spec.likes ?? null,
      spec.forks ?? null,
      spec.lastActivityAt ?? null,
    );
  return Number(r.lastInsertRowid);
}

export interface FactSpec {
  key: string;
  value: unknown;
  status?: "ok" | "no-data" | "bad";
  source?: string;
}

export interface ScanSpec {
  startedAt?: string;
  finishedAt?: string | null;
  status?: string;
  trigger?: string;
  facts?: FactSpec[];
  /** scans.rating_eligible; дефолт true — сид-скан с оценкой читается рейтингом */
  ratingEligible?: boolean;
  /** scans.public_status; дефолт = status */
  publicStatus?: string;
  /** scans.user_id — автор скана; дефолт NULL (периодика) */
  userId?: number | null;
}

/** Скан + факты. id растут независимо от дат — «последний» определяется по id. */
export function seedScan(t: ApiTestDb, repoId: number, spec: ScanSpec = {}): number {
  const started = spec.startedAt ?? NOW.toISOString();
  const r = t.db
    .query("INSERT INTO scans (repo_id, started_at, finished_at, status, public_status, trigger, rating_eligible, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      repoId,
      started,
      spec.finishedAt === undefined ? started : spec.finishedAt,
      spec.status ?? "ok",
      spec.publicStatus ?? spec.status ?? "ok",
      spec.trigger ?? "test",
      spec.ratingEligible === false ? 0 : 1,
      spec.userId ?? null,
    );
  const scanId = Number(r.lastInsertRowid);
  const stmt = t.db.query(
    "INSERT OR REPLACE INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const f of spec.facts ?? []) {
    // как runner: сжатые kinds (лента, граф lock-файлов) лежат в БД с префиксом z:
    stmt.run(scanId, categoryOf(f.key), f.key, encodeFactValue(f.key, f.value, f.status ?? "ok"), f.status ?? "ok", f.source ?? "test", started);
  }
  return scanId;
}

export interface ScoreSpec {
  /** HealthCraft Index (healthcraft_index) */
  total: number | null;
  coverage?: number;
  categories?: Partial<Record<CategoryKey, unknown>>;
  noData?: string[];
  stale?: string[];
  derived?: unknown;
  computedAt?: string;
  modelVersion?: string;
}

/** Категории «по умолчанию»: пять с данными + Security no-data (public). */
export function defaultCategories(): Record<CategoryKey, unknown> {
  return {
    documentation: { score: 60, submetrics: { readme: { score: 0.72, value: { bytes: 8000 } }, license: { score: 1 } } },
    cicd: { score: null, no_data: "ci runs no-data — прогоны не видны, автоматизацию не оцениваем", submetrics: { config: { score: 1 } } },
    security: { score: null, no_data: "AppSec data unavailable (no AppSec access or no finished scan)", submetrics: {} },
    activity: { score: 70, submetrics: { fresh: { score: 0.9, value: 1789481810000 } } },
    issues: { score: 40, submetrics: { stale: { score: 0.4, value: 0.5 } } },
    code: { score: 80, submetrics: { density: { score: 0.8, value: 1.2 } } },
  };
}

export function seedScore(t: ApiTestDb, repoId: number, scanId: number, spec: ScoreSpec): void {
  t.db
    .query(
      `INSERT OR REPLACE INTO scores
         (scan_id, model_version, repo_id, healthcraft_index, index_coverage, categories, no_data, stale, computed_at, derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scanId,
      spec.modelVersion ?? MODEL_VERSION,
      repoId,
      spec.total,
      spec.coverage ?? 1,
      JSON.stringify({ ...defaultCategories(), ...(spec.categories ?? {}) }),
      JSON.stringify(spec.noData ?? ["security: AppSec data unavailable (no AppSec access or no finished scan)"]),
      JSON.stringify(spec.stale ?? []),
      spec.computedAt ?? NOW.toISOString(),
      spec.derived === undefined ? JSON.stringify({ commitsPerMonth: 12, mirrorLikeness: null }) : JSON.stringify(spec.derived),
    );
}

export interface RecSpec {
  ruleId: string;
  priority: number;
  problem?: string;
  action?: string;
  factRef: string;
  expectedImpact?: string | null;
  deltaScore?: number | null;
  opensCategory?: string | null;
  channel?: "cicd" | "appsec" | null;
}

export function seedRecommendation(t: ApiTestDb, scanId: number, spec: RecSpec): void {
  t.db
    .query(
      `INSERT OR REPLACE INTO recommendations
         (scan_id, model_version, rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?)`,
    )
    .run(
      scanId,
      MODEL_VERSION,
      spec.ruleId,
      spec.priority,
      spec.problem ?? `проблема ${spec.ruleId}`,
      spec.action ?? `действие ${spec.ruleId}`,
      spec.factRef,
      spec.expectedImpact ?? null,
      spec.deltaScore ?? null,
      spec.opensCategory ?? null,
      spec.channel ?? null,
    );
}

/**
 * Лента с ДВУМЯ слабыми сигналами проверки на накрутку (ровный ритм ~40% при
 * интервале 20 минут и один всплеск синхронизации на долгой истории): ни
 * сильных правил, ни порогов — код зовет модель. Для тестов, где нужен ответ модели.
 */
export function weakRhythmTimelineEvents(): object[] {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const end = Date.parse("2026-09-24T12:00:00Z");
  const ev = (i: number, at: number) => ({
    sha: `w${i}`,
    author: { name: "ann", email: "ann@p.org", date: new Date(at).toISOString() },
    committer: { name: "ann", email: "ann@p.org", date: new Date(at).toISOString() },
  });
  const out: object[] = [];
  // 200 коммитов с неровными интервалами 30–230 минут (медиана интервала короче 4 часов),
  // все старше 13 недель — всплеска недели нет
  let at = end - 120 * DAY;
  for (let i = 0; i < 200; i++) {
    at += ((i * 131) % 200 + 30) * MIN;
    out.push(ev(i, at));
  }
  // 120 коммитов ровно каждые 20 минут — ровная серия, ~36% коммитов людей (ниже порога 50%)
  at += 3 * DAY;
  for (let k = 0; k < 120; k++) out.push(ev(300 + k, at + k * 20 * MIN));
  // один всплеск из 12 коммитов за 1,2 секунды
  at += 5 * DAY;
  for (let k = 0; k < 12; k++) out.push(ev(500 + k, at + k * 100));
  return out.reverse();
}

/** cardFacts с лентой weakRhythmTimelineEvents вместо двух коммитов. */
export function cardFactsWeakRhythm(): FactSpec[] {
  return cardFacts().map((f) => (f.key === "activity.git.timeline" ? { ...f, value: { events: weakRhythmTimelineEvents() } } : f));
}

/** Полный ok-набор фактов для карточки (формы — collectors/facts.ts KINDS). */
export function cardFacts(): FactSpec[] {
  return [
    {
      key: "activity.git.timeline",
      source: "git",
      value: {
        events: [
          { sha: "a1", author: { name: "alice", email: "a@e.com", date: "2025-08-16T10:00:00Z" }, committer: { name: "alice", email: "a@e.com", date: "2025-08-16T10:00:00Z" } },
          { sha: "a2", author: { name: "bob", email: "b@e.com", date: "2026-09-10T10:00:00Z" }, committer: { name: "bob", email: "b@e.com", date: "2026-09-10T10:00:00Z" } },
        ],
      },
    },
    {
      key: "activity.git.summary",
      source: "git",
      value: { commits: 2, authors: 2, committers: 2, robot_commits: 0, robot_ratio: 0, first_committed_at: "2025-08-16T10:00:00Z", last_committed_at: "2026-09-10T10:00:00Z", history_truncated_since: "2025-08-16" },
    },
    { key: "docs.presence", source: "git", value: { readme: true, license: true, contributing: false, codeowners: false } },
    { key: "docs.readme", source: "git", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } },
    { key: "tree.stats", source: "git", value: { top_level: [{ name: "src", type: "tree" }], file_count: 10, bytes: 1000, loc: 5000 } },
    { key: "cicd.configs", source: "git", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
    { key: "cicd.runs", source: "rest:cicd", status: "no-data", value: { reason: "access" } },
    { key: "code.todo", source: "git", value: { count: 4, fixme: 1, older_180d: 2, todo_files: 3, blamed_files: 3 } },
    { key: "issues.stats", source: "rest:issues", value: { open: 4, closed: 10, median_close_days: 5, stale_90d: 2, fetched_count: 14 } },
    { key: "issues.comments_sample", source: "rest:comments", value: { issues: 4, with_comments: 2, median_first_comment_delay_hours: 30, delays_hours: [30] } },
    { key: "activity.rest", source: "rest:activity", value: { contributors: 2, releases: 1, pulls_open: 1, pulls_created_at: [], releases_released_at: [] } },
  ];
}

/**
 * Базовый набор рейтинга: 6 репо разных языков/лайков/дат + один со
 * Score = NULL (недобранное покрытие) + репо в каталоге без единого скана.
 */
export function seedRating(t: ApiTestDb): void {
  const rows: (RepoSpec & { total: number | null; coverage?: number })[] = [
    { org: "k-5-45mm", repo: "dozzle-plus", language: "Go", likes: 25, forks: 0, lastActivityAt: "2026-09-15T04:00:00Z", total: 74 },
    { org: "hex21h", repo: "datahint", language: "Go", likes: 28, forks: 1, lastActivityAt: "2026-05-22T13:57:00Z", total: 62 },
    { org: "gravity-ui", repo: "uikit", language: "TSX", likes: 1607, forks: 3, lastActivityAt: "2026-09-16T07:46:00Z", total: 60 },
    { org: "divkit", repo: "divkit", language: "Kotlin", likes: 4062, forks: 6, lastActivityAt: "2026-09-16T07:31:00Z", total: 56 },
    { org: "raph", repo: "its-wednesday-my-dudes", language: null, likes: 35, forks: 0, lastActivityAt: "2025-10-01T15:07:00Z", total: 35 },
    // без лайков и без даты активности: проверяет «NULL-значение величины
    // всегда в хвосте items, независимо от order»
    { org: "tail", repo: "no-meta", language: "Go", likes: null, forks: null, lastActivityAt: null, total: 50 },
    { org: "yandex-cloud-examples", repo: "cloudapp-hugo", language: null, likes: 33, forks: 0, lastActivityAt: "2026-01-12T09:19:00Z", total: 47 },
    { org: "nodata", repo: "dark-repo", language: "C++", likes: 5, forks: null, lastActivityAt: null, total: null, coverage: 0.375 },
  ];
  for (const row of rows) {
    const repoId = seedRepo(t, row);
    const scanId = seedScan(t, repoId, { status: row.total === null ? "partial" : "ok" });
    seedScore(t, repoId, scanId, { total: row.total, coverage: row.coverage ?? 1 });
  }
  // репо каталога без скана: карточка обязана отдавать 200, а не 404
  seedRepo(t, { org: "catalog-only", repo: "never-scanned", language: "Rust", likes: 1 });
}
