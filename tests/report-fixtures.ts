// report-fixtures.ts — фикстурные карточки отчёта (В4.7, блок Б0; В4.9, Д6).
//
// В4.9 (Д6): фикстуры больше не задают итог, покрытие, баллы категорий и
// тексты рекомендаций руками — исследование показало, что ручные числа
// противоречили показанным категориям (`full` 72 при расчетных ≈64, `null`
// 38% при 46%). Теперь каждая фикстура — факты скана, из которых НАСТОЯЩИЙ
// движок считает оценку (`compute` → `totalsFromCategories`) и рекомендации
// (`recommend`), а карточка собирается тем же `getRepoCard`, что у маршрута
// `.md`. Числа отчёта выводятся из показанных категорий и фактов построением.
//
// Каждая фикстура живёт в своей временной БД — id сканов и даты не зависят
// от порядка тестов, эталон детерминирован (время — NOW api-fixtures).
//
// Состав и назначение (контракт П1 В4.7, сохранены):
//   anon      — анонимный зритель (нет сессии): CI/CD и Безопасность закрыты,
//               крупно HealthCraft Index; история усечена (Д4);
//   full      — полный доступ: CI с прогонами, AppSec с критичной находкой без
//               утечки секретов (Д1), дата закрытия задач подменена (Д5),
//               крупно Repo Health Score;
//   grant-ci  — CI открыт без прогонов (потолок 50, правило grant-ci-runs),
//               Безопасность закрыта правами; README нет, трекер не ведётся,
//               язык не определён, заголовок с разметкой;
//   null      — оценка есть, индекса нет: данные только по задачам (23%);
//   never     — репозиторий в каталоге без единого скана.
import type { AccessResult } from "../src/auth/access";
import { getRepoCard, type CardViewer, type RepoCard } from "../src/api/repos";
import { compute, writeScores } from "../src/score/compute";
import { MODEL_VERSION } from "../src/score/model";
import { recommend, writeRecommendations } from "../src/score/recommend";
import { NOW, cardFacts, makeApiDb, seedRepo, seedScan, type ApiTestDb, type FactSpec, type ScanSpec } from "./api-fixtures";

/**
 * Фикстуры, по которым снимается ДОКУМЕНТ отчета. Решение владельца 22.09
 * (круг 3 гейта): без оценки отчет не выдается, поэтому `never` (репозиторий
 * без единого скана) сюда больше не входит — карточка такого репо проверяется
 * отдельно (`v49-appendix.test.ts`, Д3). Сама фикстура остается: ее берут
 * тесты карточки и доступа.
 */
export const ALL_FIXTURES = ["anon", "full", "grant-ci", "null", "never"] as const;
export type ReportFixture = (typeof ALL_FIXTURES)[number];
export const REPORT_FIXTURES: readonly ReportFixture[] = ["anon", "full", "grant-ci", "null"];

const NO_PAT: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };
const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const CI_ONLY: AccessResult = { cicd: "granted", appsec: "denied", repo: "granted" };

export interface FixtureCard {
  card: RepoCard;
  close: () => void;
}

/** Скан с фактами, оценка и рекомендации — настоящим движком (как хук анализа). */
export function scoredScan(t: ApiTestDb, repoId: number, spec: ScanSpec): number {
  const scanId = seedScan(t, repoId, spec);
  const scores = compute(t.db, scanId, { now: NOW });
  writeScores(t.db, scores);
  writeRecommendations(t.db, scanId, MODEL_VERSION, recommend(t.db, scanId, { now: NOW, scores }));
  return scanId;
}

/** Факты с заменой по ключу (остальные — как в `cardFacts`). */
function factsWith(...overrides: FactSpec[]): FactSpec[] {
  const out = cardFacts().filter((f) => !overrides.some((o) => o.key === f.key));
  return [...out, ...overrides];
}

/** История коммитов: 4 автора, свежие коммиты — активность считается по живым датам. */
const TIMELINE: FactSpec = {
  key: "activity.git.timeline",
  source: "git",
  value: {
    events: [
      ["alice", "2025-10-02T10:00:00Z"],
      ["bob", "2026-01-15T10:00:00Z"],
      ["carol", "2026-05-20T10:00:00Z"],
      ["alice", "2026-07-01T10:00:00Z"],
      ["dave", "2026-08-21T10:00:00Z"],
      ["bob", "2026-09-10T10:00:00Z"],
    ].map(([name, date], i) => ({ sha: `c${i}`, author: { name, email: `${name}@e.com`, date }, committer: { name, email: `${name}@e.com`, date } })),
  },
};

/** Итог истории — согласован с TIMELINE; `truncatedSince` — история усечена с этой даты (Д4). */
function summary(truncatedSince: string | null): FactSpec {
  return {
    key: "activity.git.summary",
    source: "git",
    value: {
      commits: 6,
      authors: 4,
      committers: 4,
      robot_commits: 0,
      robot_ratio: 0,
      first_committed_at: "2025-10-02T10:00:00Z",
      last_committed_at: "2026-09-10T10:00:00Z",
      ...(truncatedSince ? { history_truncated_since: truncatedSince } : {}),
    },
  };
}

export function fixtureCard(name: ReportFixture): FixtureCard {
  const t = makeApiDb();
  const done = (org: string, repo: string, access: AccessResult, viewerAuth: CardViewer["auth"]): FixtureCard => {
    const card = getRepoCard(t.db, org, repo, { access, viewerAuth });
    if (!card) throw new Error(`fixture ${name}: карточка не собралась`);
    return { card, close: t.close };
  };
  switch (name) {
    case "anon": {
      const repoId = seedRepo(t, { org: "m47", repo: "anon", title: "Anon *demo* <b>", language: "Go", likes: 11, forks: 2, lastActivityAt: "2026-09-15T00:00:00Z" });
      scoredScan(t, repoId, { status: "partial", trigger: "user", facts: factsWith(TIMELINE, summary("2025-08-16")) });
      return done("m47", "anon", NO_PAT, "no-session");
    }
    case "full": {
      const facts = factsWith(
        TIMELINE,
        summary(null),
        { key: "cicd.runs", source: "rest:cicd", value: { last_status: "success", success_rate: 0.95, duration_p50: 420, runs_count: 20 } },
        {
          key: "issues.stats",
          source: "rest:issues",
          value: { open: 4, closed: 10, median_close_days: 48.849999999999994, stale_90d: 3, fetched_count: 14, close_date_note: "completed_at missing on 10/10 closed — used updated_at fallback" },
        },
        {
          key: "appsec.findings",
          source: "appsec:api",
          value: {
            severity_counts: { critical: 1, high: 1, medium: 2, low: 3 },
            resolved_share: 0.8,
            secrets_critical: false,
            backlog: { open_groups: 4, open_findings: 7, engines: { sast: 5, secrets: 2 }, severity_raw_counts: {} },
            provenance: { scan_uuid: "u-1", commit_hash: "deadbeef", time_finished: "2026-09-16T11:00:00Z", group_ids: [] },
          },
        },
      );
      const repoId = seedRepo(t, { org: "m47", repo: "full", title: "Full access", language: "TypeScript", likes: 40, forks: 5, lastActivityAt: "2026-09-10T08:30:00Z" });
      scoredScan(t, repoId, { status: "ok", trigger: "periodic", facts });
      return done("m47", "full", GRANTED, "pat");
    }
    case "grant-ci": {
      const facts = factsWith(
        TIMELINE,
        summary(null),
        { key: "docs.presence", source: "git", value: { readme: false, license: true, contributing: false, codeowners: false } },
        { key: "docs.readme", source: "git", value: { present: false } },
        { key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } },
      );
      const repoId = seedRepo(t, { org: "m47", repo: "grant-ci", title: "CI [config] `only` | pipes", language: null, likes: null, forks: 0, lastActivityAt: null });
      scoredScan(t, repoId, { status: "ok", trigger: "user", facts });
      return done("m47", "grant-ci", CI_ONLY, "pat");
    }
    case "null": {
      // как `qipparu/2`: данные есть только по задачам (трекер пуст) — 15 из 65 = 23%
      const repoId = seedRepo(t, { org: "m47", repo: "null", language: "C++" });
      scoredScan(t, repoId, {
        status: "partial",
        trigger: "periodic",
        facts: [{ key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } }],
      });
      return done("m47", "null", NO_PAT, "no-session");
    }
    case "never": {
      seedRepo(t, { org: "m47", repo: "never", language: "Rust", likes: 1 });
      return done("m47", "never", NO_PAT, "no-session");
    }
  }
}

/** Путь эталона фикстуры (LF-файл, `.gitattributes`: tests/fixtures/** -text). */
export function goldenPath(name: ReportFixture): string {
  return `${import.meta.dir}/fixtures/report/${name}.md`;
}
