// report-fixtures.ts — фикстурные карточки отчёта В4.7 (блок Б0).
//
// Эталонные MD в tests/fixtures/report/*.md сняты с этих карточек ДО перевода
// markdown.ts на модель блоков (Б3): байт-в-байт сверка после рефакторинга
// опирается только на них. Каждая фикстура живёт в своей временной БД —
// id сканов и дат не зависят от порядка тестов, эталон детерминирован.
//
// Состав выбран по контракту П1 (промпт В4.7, Б0):
//   anon      — зритель без прав на каналы (CI/CD и Security закрыты);
//   full      — полный доступ: CI с прогонами, AppSec с находками (правило
//               appsec-critical несёт «≤»), все публичные подметрики, включая
//               составные значения (readme, mirror_likeness);
//   grant-ci  — CI открыт, Security закрыт, CI без прогонов: правило
//               grant-ci-runs — единственный источник «→» (recommend.ts);
//               заодно README отсутствует ({present:false}), трекер не ведётся
//               ({open:0, closed:0}), язык не определён, заголовок с разметкой;
//   null      — индекс не выставлен (покрытие ниже порога);
//   never     — репозиторий в каталоге без единого скана.
import type { AccessResult } from "../src/auth/access";
import { getRepoCard, type RepoCard } from "../src/api/repos";
import { cardFacts, makeApiDb, seedRecommendation, seedRepo, seedScan, seedScore, type FactSpec } from "./api-fixtures";

export const REPORT_FIXTURES = ["anon", "full", "grant-ci", "null", "never"] as const;
export type ReportFixture = (typeof REPORT_FIXTURES)[number];

const NO_PAT: AccessResult = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" };
const GRANTED: AccessResult = { cicd: "granted", appsec: "granted", repo: "granted" };
const CI_ONLY: AccessResult = { cicd: "granted", appsec: "denied", repo: "granted" };

/** Публичные подметрики «как у compute»: все ключи четырёх публичных категорий. */
const PUBLIC_CATEGORIES = {
  documentation: {
    score: 60,
    submetrics: {
      readme: { score: 0.72, value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } },
      license: { score: 1 },
      contributing: { score: 0 },
      codeowners: { score: 0 },
    },
  },
  activity: {
    score: 70,
    submetrics: {
      fresh: { score: 0.9, value: 1789481810000 },
      freq: { score: 0.6, value: 4.333333333333333 },
      contributors: { score: 0.5, value: 2 },
      pulls_90d: { score: 0.4, value: 3 },
      releases_12m: { score: 0.3, value: 1 },
      mirror_likeness: { score: null, value: { sync_share: 0.125, authors: 2, committers: 3 } },
      commits_90d: { score: null, value: 13 },
      commits_365d: { score: null, value: 40 },
      sync_bursts: { score: null, value: 0 },
    },
  },
  issues: {
    score: 40,
    submetrics: {
      stale: { score: 0.4, value: 0.5 },
      close_days: { score: 0.8, value: 5 },
      resolution: { score: 0.6, value: 0.7142857142857143 },
      first_resp: { score: 0.5, value: 30 },
    },
  },
  code: {
    score: 80,
    submetrics: {
      density: { score: 0.8, value: 0.8723404255319149 },
      old_share: { score: 0.5, value: 0.5 },
      root: { score: 1, value: 1 },
      todo_total: { score: null, value: 5 },
    },
  },
};

export interface FixtureCard {
  card: RepoCard;
  close: () => void;
}

/** Карточка фикстуры — тот же сборщик, что у маршрута `.md` (`getRepoCard` с доступом зрителя). */
export function fixtureCard(name: ReportFixture): FixtureCard {
  const t = makeApiDb();
  const done = (org: string, repo: string, access: AccessResult): FixtureCard => {
    const card = getRepoCard(t.db, org, repo, { access });
    if (!card) throw new Error(`fixture ${name}: карточка не собралась`);
    return { card, close: t.close };
  };
  switch (name) {
    case "anon": {
      const repoId = seedRepo(t, { org: "m47", repo: "anon", title: "Anon *demo* <b>", language: "Go", likes: 11, forks: 2, lastActivityAt: "2026-09-15T00:00:00Z" });
      const scanId = seedScan(t, repoId, { status: "partial", trigger: "user", facts: cardFacts() });
      seedScore(t, repoId, scanId, { total: 67, categories: PUBLIC_CATEGORIES });
      seedRecommendation(t, scanId, {
        ruleId: "contributing-missing",
        priority: 1,
        problem: "Нет CONTRIBUTING – как вносить правки не описано",
        action: "Добавьте CONTRIBUTING.md с правилами внесения правок",
        factRef: "docs.presence",
        deltaScore: 2.25,
        expectedImpact: "+2.3 к HealthCraft Index (по одному)",
      });
      seedRecommendation(t, scanId, {
        ruleId: "readme-sections",
        priority: 2,
        problem: "В README нет разделов про сборку и тесты",
        action: "Опишите сборку и запуск тестов в README",
        factRef: "docs.readme",
      });
      return done("m47", "anon", NO_PAT);
    }
    case "full": {
      const facts: FactSpec[] = cardFacts().map((f) =>
        f.key === "cicd.runs" ? { key: "cicd.runs", source: "rest:cicd", value: { last_status: "success", success_rate: 0.95, duration_p50: 420, runs_count: 20 } } : f,
      );
      facts.push({
        key: "appsec.findings",
        source: "appsec:api",
        value: {
          severity_counts: { critical: 1, high: 1, medium: 2, low: 3 },
          resolved_share: 0.8,
          secrets_critical: false,
          backlog: { open_groups: 4, open_findings: 7, engines: { sast: 5, secrets: 2 }, severity_raw_counts: {} },
          provenance: { scan_uuid: "u-1", commit_hash: "deadbeef", time_finished: "2026-09-16T11:00:00Z", group_ids: [] },
        },
      });
      const repoId = seedRepo(t, { org: "m47", repo: "full", title: "Full access", language: "TypeScript", likes: 40, forks: 5, lastActivityAt: "2026-09-10T08:30:00Z" });
      const scanId = seedScan(t, repoId, { status: "ok", trigger: "periodic", facts });
      seedScore(t, repoId, scanId, { total: 72, categories: PUBLIC_CATEGORIES });
      seedRecommendation(t, scanId, {
        ruleId: "codeowners-missing",
        priority: 1,
        problem: "Нет CODEOWNERS – не видно, кто отвечает за код",
        action: "Добавьте файл CODEOWNERS",
        factRef: "docs.presence",
        deltaScore: 1.5,
        expectedImpact: "+1.5 к HealthCraft Index (по одному)",
      });
      return done("m47", "full", GRANTED);
    }
    case "grant-ci": {
      const facts: FactSpec[] = cardFacts().map((f) =>
        f.key === "docs.readme" ? { key: "docs.readme", source: "git", value: { present: false } } : f.key === "issues.stats" ? { key: "issues.stats", source: "rest:issues", value: { open: 0, closed: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 } } : f,
      );
      const repoId = seedRepo(t, { org: "m47", repo: "grant-ci", title: "CI [config] `only` | pipes", language: null, likes: null, forks: 0, lastActivityAt: null });
      const scanId = seedScan(t, repoId, { status: "ok", trigger: "user", facts });
      seedScore(t, repoId, scanId, {
        total: 55,
        categories: {
          ...PUBLIC_CATEGORIES,
          documentation: { score: 20, submetrics: { readme: { score: 0, value: { present: false } }, license: { score: 1 }, contributing: { score: 0 }, codeowners: { score: 0 } } },
          issues: { score: 20, submetrics: { tracker_unused: { score: 0.2, value: { open: 0, closed: 0 }, note: "tracker not maintained — category minimum (Q14)" } } },
        },
      });
      return done("m47", "grant-ci", CI_ONLY);
    }
    case "null": {
      const repoId = seedRepo(t, { org: "m47", repo: "null", language: "C++" });
      const scanId = seedScan(t, repoId, { status: "partial", facts: [] });
      seedScore(t, repoId, scanId, {
        total: null,
        coverage: 0.375,
        noData: [
          "security: AppSec data unavailable (no AppSec access or no finished scan)",
          "documentation: git channel no-data",
          "code: git channel no-data",
        ],
        categories: {
          documentation: { score: null, no_data: "git channel no-data", submetrics: {} },
          code: { score: null, no_data: "git channel no-data", submetrics: {} },
        },
      });
      return done("m47", "null", NO_PAT);
    }
    case "never": {
      seedRepo(t, { org: "m47", repo: "never", language: "Rust", likes: 1 });
      return done("m47", "never", NO_PAT);
    }
  }
}

/** Путь эталона фикстуры (LF-файл, `.gitattributes`: tests/fixtures/** -text). */
export function goldenPath(name: ReportFixture): string {
  return `${import.meta.dir}/fixtures/report/${name}.md`;
}
