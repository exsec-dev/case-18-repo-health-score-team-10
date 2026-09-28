// Демо-база для скриншотов документации (docs/guide/images): только выдуманные
// репозитории и люди, ни одного реального репозитория SourceCraft.
//
// Скрипт пишет в БД ТОЛЬКО факты — в тех формах, что пишут сборщики
// (src/collectors/facts.ts, KINDS). Оценки, рекомендации, пригодность для
// рейтинга и public_status считает настоящая модель: в конце вызывается
// rescoreAll — тот же пересчет, что сервер выполняет на старте для базы без
// оценок. После пересчета пишется снимок мест рейтинга «вчера» с чуть другим
// порядком, чтобы в рейтинге были стрелки изменения места.
//
// Запуск:
//   bun scripts/docs-demo-db.ts <каталог>
// Каталог создается; прежняя БД в нем удаляется. Живой каталог data/ скрипт
// не принимает.
//
// Ключевые репозитории (числа — как в docs/guide):
//   example/tasktracker — HealthCraft Index 61; «По шагам»: 61 → 65 → 68 → 72;
//     баллы категорий 47,95 / 69,41 / 41,5 / 79,72 (guide/badge-api.md);
//   example/weather-bot — 70 (method/scores.md, пример расчета);
//   my-team/backend — 81, Repo Health Score 82 (method/robustness.md);
//   example/image-resizer — «Состояние кода»: нет данных (строки кода не прочитаны);
//   example/legacy-monolith, example/data-archive — клон больше лимита,
//     покрытие ниже 0,4 (вкладка «Без оценки»);
//   example/design-notes — кода нет, оценка 0.
// Остальные ~1200 репозиториев — сгенерированный фон (детерминированный ГПСЧ):
// рейтинг больше 1000 мест дает лиги до «ТОП-1000», а когорта TypeScript
// 1-10 тыс. строк у example/tasktracker — больше 30 похожих.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { COLLECTOR_VERSION, categoryOf, encodeFactValue } from "../src/collectors/facts";
import { computeFromFacts, scanStatusOf } from "../src/score/compute";
import { rescoreAll } from "../src/score/rescore";
import { takeRatingSnapshot, utcDayOf } from "../src/jobs/rating-snapshot";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---------- аргументы ----------

const target = process.argv[2];
if (!target) {
  console.error("usage: bun scripts/docs-demo-db.ts <каталог>");
  process.exit(2);
}
const dataDir = resolve(target);
const liveDir = resolve("data");
if (dataDir === liveDir || dataDir.startsWith(liveDir + "\\") || dataDir.startsWith(liveDir + "/")) {
  console.error(`отказ: ${dataDir} — живой каталог data/, демо-база пишется только в отдельный каталог`);
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const f = join(dataDir, `repo-health.db${suffix}`);
  if (existsSync(f)) rmSync(f);
}

/**
 * Опорное время: начало текущего часа UTC минус 2 ч. Все даты фактов считаются
 * от времени своего анализа, поэтому оценки не зависят от дня запуска, а
 * последний анализ всегда «сегодня».
 */
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;

// ---------- ГПСЧ ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexSha(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 40; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

// ---------- параметры репозитория → факты ----------

interface Person {
  name: string;
  email: string;
}

const PEOPLE: Person[] = [
  { name: "Анна Смирнова", email: "dev1@example.org" },
  { name: "Иван Петров", email: "dev2@example.org" },
  { name: "Мария Орлова", email: "dev3@example.org" },
  { name: "Олег Козлов", email: "dev4@example.org" },
  { name: "Елена Волкова", email: "dev5@example.org" },
  { name: "Дмитрий Соколов", email: "dev6@example.org" },
  { name: "Ольга Новикова", email: "dev7@example.org" },
  { name: "Павел Морозов", email: "dev8@example.org" },
];

interface Params {
  /** git: клон прочитан или no-data с причиной */
  git: "ok" | { reason: "limits"; detail: string };
  authors: number;
  /** коммиты людей за 90 дней */
  commits90: number;
  /** давность последнего коммита, дни (дробные допустимы) */
  lastDays: number;
  /** коммиты старше 90 дней */
  older: number;
  /** возраст первого коммита, дни */
  historyDays: number;
  pulls90: number;
  pullsOld: number;
  releases12m: number;
  releasesOld: number;
  readme: { bytes: number; install: boolean; build: boolean; test: boolean } | null;
  license: boolean;
  contributing: boolean;
  codeowners: boolean;
  rootEntries: number;
  sourceFiles: number;
  testFiles: number;
  sourceLoc: number;
  /** файлы кода, строки которых не прочитаны */
  sourceUnread?: number;
  /** файлов без кода (docs, картинки) */
  otherFiles: number;
  todo: number;
  fixme: number;
  todoOld: number;
  /** "empty" — трекер не ведется (0/0) */
  issues: { open: number; stale: number; closed: number; instant: number; closeDays: number; firstHours: number } | "empty";
  ci: boolean;
  language: string | null;
  /** справочные факты: ревью PR и карта владельцев */
  prReview?: boolean;
  ownership?: boolean;
  /** факты каналов с правами (CI-запуски, AppSec) — как у анализа с токеном участника */
  channel?: { runs: { count: number; rate: number; durP50: number }; appsec: { critical: number; high: number; medium: number; low: number; resolved: number } };
}

interface FactRow {
  key: string;
  value: unknown;
  status: "ok" | "no-data" | "bad";
  source: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

function rootNames(p: Params): { name: string; type: "tree" | "blob" }[] {
  const lang = p.language ?? "";
  const manifest: Record<string, string> = {
    TypeScript: "package.json",
    JavaScript: "package.json",
    Python: "pyproject.toml",
    Go: "go.mod",
    Java: "pom.xml",
    Kotlin: "build.gradle.kts",
    Rust: "Cargo.toml",
    "C++": "CMakeLists.txt",
    "C#": "App.sln",
    PHP: "composer.json",
  };
  const out: { name: string; type: "tree" | "blob" }[] = [];
  const add = (name: string, type: "tree" | "blob") => {
    if (out.length < p.rootEntries && !out.some((e) => e.name === name)) out.push({ name, type });
  };
  if (p.sourceFiles > 0) add("src", "tree");
  if (p.testFiles > 0) add("tests", "tree");
  add(".sourcecraft", "tree");
  if (p.readme) add("README.md", "blob");
  if (p.license) add("LICENSE", "blob");
  if (p.contributing) add("CONTRIBUTING.md", "blob");
  if (p.codeowners) add("CODEOWNERS", "blob");
  if (manifest[lang] && p.sourceFiles > 0) add(manifest[lang]!, "blob");
  const filler: [string, "tree" | "blob"][] = [
    ["docs", "tree"], [".gitignore", "blob"], ["scripts", "tree"], ["Makefile", "blob"], ["examples", "tree"],
    ["CHANGELOG.md", "blob"], ["config", "tree"], ["assets", "tree"], ["deploy", "tree"], [".editorconfig", "blob"],
    ["tools", "tree"], ["Dockerfile", "blob"], ["bench", "tree"], ["migrations", "tree"], ["docker-compose.yml", "blob"],
  ];
  for (const [name, type] of filler) add(name, type);
  for (let i = 1; out.length < p.rootEntries; i++) add(`notes-${i}.md`, "blob");
  return out;
}

function buildFacts(p: Params, at: number, rng: () => number): FactRow[] {
  const facts: FactRow[] = [];
  const ok = (key: string, value: unknown, source: string) => facts.push({ key, value, status: "ok", source });
  const noData = (key: string, value: unknown, source: string) => facts.push({ key, value, status: "no-data", source });

  // --- git ---
  if (p.git === "ok") {
    const people = PEOPLE.slice(0, Math.max(1, Math.min(PEOPLE.length, p.authors)));
    const events: unknown[] = [];
    let n = 0;
    const push = (t: number) => {
      const who = people[n % people.length]!;
      const date = iso(t);
      events.push({
        sha: hexSha(rng),
        author: { name: who.name, email: who.email, date },
        committer: { name: who.name, email: who.email, date },
        robot: false,
        robot_reasons: [],
      });
      n++;
    };
    // коммиты за 90 дней: от lastDays до ~89 дней назад
    if (p.commits90 > 0) {
      const span = Math.max(0, 89 - p.lastDays);
      for (let i = 0; i < p.commits90; i++) push(at - (p.lastDays + (p.commits90 === 1 ? 0 : (span * i) / (p.commits90 - 1))) * DAY - i * 37_000);
    }
    const olderFrom = Math.max(91, p.commits90 > 0 ? 91 : p.lastDays);
    const olderTo = Math.max(olderFrom + 1, p.historyDays);
    for (let i = 0; i < p.older; i++) push(at - (olderFrom + ((olderTo - olderFrom) * i) / Math.max(1, p.older - 1)) * DAY - i * 41_000);
    const times = events.map((e) => Date.parse((e as { committer: { date: string } }).committer.date)).sort((a, b) => a - b);
    ok("activity.git.timeline", { events }, "git");
    ok(
      "activity.git.summary",
      {
        commits: events.length,
        authors: people.length,
        committers: people.length,
        robot_commits: 0,
        robot_ratio: events.length ? 0 : null,
        first_committed_at: times.length ? iso(times[0]!) : null,
        last_committed_at: times.length ? iso(times[times.length - 1]!) : null,
      },
      "git",
    );
    ok(
      "docs.presence",
      { readme: p.readme !== null, license: p.license, contributing: p.contributing, codeowners: p.codeowners, content_checked: true },
      "git",
    );
    ok(
      "docs.readme",
      p.readme
        ? {
            bytes: p.readme.bytes,
            sections: 2 + (p.readme.install ? 1 : 0) + (p.readme.build ? 1 : 0) + (p.readme.test ? 1 : 0),
            flags: { install: p.readme.install, build: p.readme.build, test: p.readme.test },
          }
        : { present: false },
      "git",
    );
    const unread = p.sourceUnread ?? 0;
    ok(
      "tree.stats",
      {
        top_level: rootNames(p),
        file_count: p.sourceFiles + p.testFiles + p.otherFiles,
        bytes: p.sourceLoc * 34 + p.otherFiles * 4200 + unread * 900_000,
        loc: p.sourceLoc + Math.round(p.testFiles * 60) + p.otherFiles * 40,
        source_files: p.sourceFiles,
        test_files: p.testFiles,
        source_loc: p.sourceLoc,
        source_unread: unread,
      },
      "git",
    );
    ok("cicd.configs", { paths: p.ci ? [".sourcecraft/ci.yaml"] : [], has_ci_yaml: p.ci, has_steps: p.ci }, "git");
    const total = p.todo + p.fixme;
    ok(
      "code.todo",
      {
        count: p.todo,
        fixme: p.fixme,
        older_180d: p.todoOld,
        todo_files: Math.min(total, Math.max(1, Math.round(total / 3))) || 0,
        blamed_files: Math.min(total, Math.max(1, Math.round(total / 3))) || 0,
        test_markers: Math.round(total / 8),
      },
      "git",
    );
    if (p.ownership) {
      const dirs = [
        { dir: "src", changes: 412, authors: Math.min(4, people.length), owner: people[0]!.name, owner_share: 0.46 },
        { dir: "tests", changes: 138, authors: Math.min(3, people.length), owner: people[1 % people.length]!.name, owner_share: 0.58 },
        { dir: "scripts", changes: 41, authors: 1, owner: people[2 % people.length]!.name, owner_share: 1 },
        { dir: "docs", changes: 27, authors: Math.min(2, people.length), owner: people[0]!.name, owner_share: 0.85 },
      ];
      const changes = dirs.reduce((s, d) => s + d.changes, 0);
      const single = dirs.filter((d) => d.owner_share >= 0.8);
      ok(
        "code.ownership",
        {
          window_days: 365,
          threshold: 0.8,
          commits: Math.min(events.length, 180),
          robot_commits_skipped: 0,
          changes,
          single_owner_share: Math.round((single.reduce((s, d) => s + d.changes, 0) / changes) * 1000) / 1000,
          dirs_total: dirs.length,
          dirs_single_owner: single.length,
          dirs,
        },
        "git",
      );
    }
  } else {
    for (const k of ["activity.git.timeline", "activity.git.summary", "docs.presence", "docs.readme", "tree.stats", "cicd.configs", "code.todo"]) {
      noData(k, { reason: p.git.reason, detail: p.git.detail }, "git");
    }
  }

  // --- REST: активность ---
  const pulls: string[] = [];
  for (let i = 0; i < p.pulls90; i++) pulls.push(iso(at - (2 + (85 * i) / Math.max(1, p.pulls90)) * DAY));
  for (let i = 0; i < p.pullsOld && pulls.length < 50; i++) pulls.push(iso(at - (95 + i * 11) * DAY));
  const releases: string[] = [];
  for (let i = 0; i < p.releases12m; i++) releases.push(iso(at - (10 + (340 * i) / Math.max(1, p.releases12m)) * DAY));
  for (let i = 0; i < p.releasesOld && releases.length < 50; i++) releases.push(iso(at - (380 + i * 60) * DAY));
  ok(
    "activity.rest",
    {
      contributors: p.authors,
      releases: releases.length,
      release_statuses: { published: releases.length },
      pulls_open: Math.min(pulls.length, Math.round(p.pulls90 / 4)),
      latest_release_at: releases[0] ?? null,
      pulls_created_at: pulls,
      releases_released_at: releases,
    },
    "rest:activity",
  );
  if (p.prReview) {
    ok(
      "activity.pr_review",
      {
        pulls: pulls.length,
        statuses: { draft: 1, open: Math.round(p.pulls90 / 4), merging: 0, merged: Math.max(0, pulls.length - 1 - Math.round(p.pulls90 / 4)), discarded: 1, unknown: 0 },
        sampled: Math.min(10, pulls.length),
        answered: Math.min(9, pulls.length),
        median_first_response_hours: 18.5,
        open_sampled: Math.min(2, Math.round(p.pulls90 / 4)),
        waiting_over_threshold: 0,
        threshold_hours: 72,
        review_comments_total: 23,
        median_review_comments: 2,
        comments_capped: 0,
        appsec_comments: 0,
        decisions: { approve: 8, trust: 0, block: 1, abstain: 0, pending: 1, unknown: 0 },
        merged: Math.max(0, pulls.length - 1 - Math.round(p.pulls90 / 4)),
        median_merge_hours: 26.4,
        merge_time_basis: "updated_at",
        requests: 21,
      },
      "rest:pulls",
    );
  }

  // --- REST: задачи ---
  if (p.issues === "empty") {
    ok("issues.stats", { open: 0, in_progress: 0, closed: 0, closed_instant: 0, closed_counted: 0, median_close_days: null, stale_90d: 0, fetched_count: 0 }, "rest:issues");
    ok("issues.comments_sample", { issues: 0, answered: 0, censored: 0, median_first_comment_delay_hours: null, delays_hours: [] }, "rest:comments");
  } else {
    const is = p.issues;
    ok(
      "issues.stats",
      {
        open: is.open,
        in_progress: Math.round(is.open / 5),
        closed: is.closed + is.instant,
        closed_instant: is.instant,
        closed_counted: is.closed,
        median_close_days: is.closeDays,
        stale_90d: is.stale,
        fetched_count: is.open + is.closed + is.instant,
      },
      "rest:issues",
    );
    const sampled = Math.min(10, is.open + is.closed);
    const delays = Array.from({ length: sampled }, (_, i) => Math.round(is.firstHours * (0.6 + (0.8 * i) / Math.max(1, sampled - 1)) * 10) / 10);
    ok(
      "issues.comments_sample",
      { issues: sampled, answered: sampled, censored: 0, median_first_comment_delay_hours: is.firstHours, delays_hours: delays },
      "rest:comments",
    );
  }

  // --- каналы с правами: периодический анализ без токена их не видит ---
  if (p.channel) {
    const r = p.channel.runs;
    ok(
      "cicd.runs",
      {
        last_status: "success",
        success_rate: r.rate,
        weighted_success_rate: r.rate,
        duration_p50: r.durP50,
        runs_count: r.count,
        runs_total: r.count,
        green_streak: 6,
      },
      "rest:cicd",
    );
    const a = p.channel.appsec;
    ok(
      "appsec.findings",
      {
        severity_counts: { critical: a.critical, high: a.high, medium: a.medium, low: a.low },
        resolved_share: a.resolved,
        secrets_critical: false,
        backlog: { open_groups: a.critical + a.high + a.medium + a.low, open_findings: a.critical + a.high + a.medium + a.low, engines: { sca: a.medium, sast: a.low }, severity_raw_counts: {} },
        provenance: { scan_uuid: "00000000-0000-4000-8000-000000000001", commit_hash: hexSha(rng), time_finished: iso(at - 6 * HOUR), group_ids: [] },
      },
      "appsec:api",
    );
  } else {
    noData("cicd.runs", { reason: "access", detail: "status 403" }, "rest:cicd");
    noData("appsec.findings", { reason: "access", detail: "status 403" }, "appsec:api");
  }
  return facts;
}

// ---------- подбор одного параметра под целевой балл ----------

/** Бисекция по монотонному параметру: fn(x) — балл категории. */
function tune(lo: number, hi: number, targetScore: number, fn: (x: number) => number): number {
  const up = fn(hi) > fn(lo);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const v = fn(mid);
    if (v < targetScore === up) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function categoryScore(p: Params, key: "documentation" | "activity" | "issues" | "code", at = NOW): number {
  const facts = buildFacts(p, at, mulberry32(1));
  const ok = new Map<string, unknown>();
  for (const f of facts) if (f.status === "ok") ok.set(f.key, f.value);
  return computeFromFacts(ok, { scanId: 0, repoId: 0 }, new Date(at)).categories[key].score ?? NaN;
}

// ---------- ключевые репозитории ----------

interface RepoSpec {
  org: string;
  repo: string;
  title: string;
  likes: number;
  forks: number;
  /** анализы от старых к новым: сдвиг от NOW (дни) и параметры */
  scans: { daysAgo: number; params: Params; sha?: string }[];
}

/**
 * example/tasktracker: README 2 КБ без разделов установки, сборки и тестов,
 * лицензия есть, CONTRIBUTING и CODEOWNERS нет. Баллы категорий —
 * 47,95 / 69,41 / 41,5 / 79,72 → индекс 61.
 */
function tasktracker(): Params {
  const p: Params = {
    git: "ok",
    authors: 3,
    commits90: 20,
    lastDays: 30,
    older: 140,
    historyDays: 620,
    pulls90: 5,
    pullsOld: 18,
    releases12m: 2,
    releasesOld: 3,
    readme: { bytes: 2048, install: false, build: false, test: false },
    license: true,
    contributing: false,
    codeowners: false,
    rootEntries: 11,
    sourceFiles: 150,
    testFiles: 30,
    sourceLoc: 7600,
    otherFiles: 24,
    todo: 32,
    fixme: 8,
    todoOld: 8,
    issues: { open: 20, stale: 12, closed: 20, instant: 2, closeDays: 84, firstHours: 120 },
    ci: true,
    language: "TypeScript",
    prReview: true,
    ownership: true,
  };
  // свежесть подбирается так, чтобы «Активность» была ровно 69,408…
  p.lastDays = tune(30.44, 60, 69.40816326530612, (x) => categoryScore({ ...p, lastDays: x }, "activity"));
  return p;
}

/** example/weather-bot: 58,5 / 81,2 / 44,6 / 88 → 70 (method/scores.md). */
function weatherBot(): Params {
  const p: Params = {
    git: "ok",
    authors: 5,
    commits90: 49,
    lastDays: 2,
    older: 260,
    historyDays: 900,
    pulls90: 10,
    pullsOld: 30,
    releases12m: 4,
    releasesOld: 6,
    readme: { bytes: 955, install: false, build: false, test: false },
    license: true,
    contributing: true,
    codeowners: false,
    rootEntries: 10,
    sourceFiles: 120,
    testFiles: 36,
    sourceLoc: 12800,
    otherFiles: 30,
    todo: 42,
    fixme: 8,
    todoOld: 5,
    issues: { open: 20, stale: 12, closed: 16, instant: 1, closeDays: 60, firstHours: 72 },
    ci: true,
    language: "Python",
    prReview: true,
    ownership: true,
  };
  p.lastDays = tune(30.44, 60, 81.2, (x) => categoryScore({ ...p, lastDays: x }, "activity"));
  const closeDays = tune(30, 90, 44.6, (x) => categoryScore({ ...p, issues: { ...(p.issues as Exclude<Params["issues"], "empty">), closeDays: x } }, "issues"));
  p.issues = { ...(p.issues as Exclude<Params["issues"], "empty">), closeDays: Math.round(closeDays * 10) / 10 };
  p.sourceLoc = Math.round(tune(10_001, 40_000, 88, (x) => categoryScore({ ...p, sourceLoc: Math.round(x) }, "code")));
  return p;
}

/**
 * my-team/backend (method/robustness.md): 4 автора, 36 коммитов за 90 дней,
 * последний 3 дня назад; README 6000 байт с установкой и сборкой; 18 000 строк;
 * 12/60 задач; CI 95%, AppSec 2 medium + 3 low. Индекс 81, Repo Health Score 82.
 */
function backend(): Params {
  return {
    git: "ok",
    authors: 4,
    commits90: 36,
    lastDays: 3,
    older: 200,
    historyDays: 700,
    pulls90: 8,
    pullsOld: 30,
    releases12m: 3,
    releasesOld: 4,
    readme: { bytes: 6000, install: true, build: true, test: false },
    license: true,
    contributing: true,
    codeowners: false,
    rootEntries: 14,
    sourceFiles: 150,
    testFiles: 30,
    sourceLoc: 18000,
    otherFiles: 120,
    todo: 20,
    fixme: 4,
    todoOld: 6,
    issues: { open: 12, stale: 1, closed: 60, instant: 0, closeDays: 6, firstHours: 65.6 },
    ci: true,
    language: "Go",
    prReview: true,
    ownership: true,
    channel: { runs: { count: 40, rate: 0.95, durP50: 358 }, appsec: { critical: 0, high: 0, medium: 2, low: 3, resolved: 0.8 } },
  };
}

// ---------- фон: сгенерированные репозитории ----------

const ORGS = [
  "acme-labs", "northwind", "blue-harbor", "pixel-forge", "open-meadow", "data-garden", "cloud-kitchen", "tiny-robots",
  "green-byte", "river-soft", "polar-dev", "sunrise-it", "orbit-tools", "quiet-lab", "maple-team", "stone-code",
  "lumen-works", "delta-studio", "fox-and-owl", "brick-lane", "silver-pine", "bright-path", "echo-systems", "nova-craft",
  "urban-grid", "cedar-hub", "amber-field", "iron-kettle", "paper-plane", "lake-view", "hill-top", "coral-reef",
  "demo-org", "sample-team", "study-group", "hack-club", "uni-lab", "startup-one", "home-lab", "side-project",
];
const WORDS_A = [
  "task", "weather", "chat", "image", "log", "queue", "cache", "auth", "pay", "geo", "metrics", "notes", "shop", "quiz",
  "calendar", "mail", "file", "search", "stream", "config", "deploy", "schedule", "report", "invoice", "budget", "recipe",
  "fitness", "library", "parking", "ticket", "event", "survey", "photo", "music", "video", "news", "wiki", "form", "map",
  "order", "stock", "sensor", "robot", "game", "blog", "forum", "vote", "feed", "backup", "monitor",
];
const WORDS_B = [
  "bot", "api", "service", "sdk", "cli", "ui", "worker", "parser", "gateway", "dashboard", "client", "server", "lib",
  "tools", "core", "app", "web", "sync", "exporter", "agent", "kit", "engine", "hub", "portal", "manager", "tracker",
];
const LANGS: [string | null, number][] = [
  ["TypeScript", 0.18], ["Python", 0.2], ["Go", 0.12], ["Java", 0.1], ["JavaScript", 0.1], ["Kotlin", 0.06],
  ["Rust", 0.05], ["C++", 0.06], ["C#", 0.04], ["PHP", 0.04], [null, 0.05],
];

function pickLang(rng: () => number): string | null {
  let x = rng();
  for (const [lang, w] of LANGS) {
    if (x < w) return lang;
    x -= w;
  }
  return "Python";
}

function titleOf(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Профиль по «качеству» q ∈ [0, 1]: чем выше q, тем здоровее факты. */
function profile(q: number, rng: () => number, language: string | null, locOverride?: number): Params {
  const r = () => rng();
  const authors = 1 + Math.floor(r() * (1 + 7 * q));
  const alive = r() < 0.35 + 0.6 * q;
  const commits90 = alive ? Math.floor(1 + r() * 45 * q) : 0;
  const lastDays = alive ? 0.5 + r() * (40 * (1 - q)) : 95 + r() * 900 * (1 - q);
  const sourceLoc = locOverride ?? Math.round(Math.pow(10, 2.5 + r() * 2.7));
  const sourceFiles = Math.max(2, Math.round(sourceLoc / (60 + r() * 60)));
  const testShare = r() < 0.25 + 0.6 * q ? r() * 0.35 * (0.3 + q) : 0;
  const todoTotal = Math.round((sourceLoc / 1000) * r() * 30 * (1.1 - q));
  const fixme = Math.round(todoTotal * r() * 0.3);
  const hasReadme = r() < 0.6 + 0.4 * q;
  const trackerUsed = r() < 0.55 + 0.45 * q;
  const open = 1 + Math.floor(r() * 40);
  const closed = Math.floor(r() * 150 * q + r() * 8);
  return {
    git: "ok",
    authors,
    commits90,
    lastDays,
    older: Math.floor(r() * 200 * (0.2 + q)),
    historyDays: 200 + r() * 1500,
    pulls90: Math.floor(r() * 25 * q * q),
    pullsOld: Math.floor(r() * 30 * q),
    releases12m: Math.floor(r() * 8 * q * q),
    releasesOld: Math.floor(r() * 6 * q),
    readme: hasReadme
      ? { bytes: Math.round(150 + r() * 14000 * q), install: r() < 0.2 + 0.7 * q, build: r() < 0.15 + 0.6 * q, test: r() < 0.1 + 0.5 * q }
      : null,
    license: r() < 0.3 + 0.65 * q,
    contributing: r() < 0.55 * q * q,
    codeowners: r() < 0.4 * q * q,
    rootEntries: Math.round(5 + r() * 30 * (1.2 - q)),
    sourceFiles,
    testFiles: Math.round(sourceFiles * testShare),
    sourceLoc,
    otherFiles: Math.floor(r() * 60),
    todo: todoTotal - fixme,
    fixme,
    todoOld: Math.round(todoTotal * r() * (1 - q)),
    issues: trackerUsed
      ? {
          open,
          stale: Math.round(open * r() * (1.1 - q)),
          closed,
          instant: Math.floor(r() * 3),
          closeDays: Math.round((1 + r() * 150 * (1.05 - q)) * 10) / 10,
          firstHours: Math.round((1 + r() * 400 * (1.05 - q)) * 10) / 10,
        }
      : "empty",
    ci: r() < 0.25 + 0.55 * q,
    language,
  };
}

function specs(): RepoSpec[] {
  const out: RepoSpec[] = [];
  // --- example/tasktracker: история 53 → 57 → 59 → 61 ---
  const tt = tasktracker();
  out.push({
    org: "example",
    repo: "tasktracker",
    title: "Task Tracker",
    likes: 14,
    forks: 3,
    scans: [
      { daysAgo: 35, params: { ...tt, license: false, testFiles: 8, commits90: 26 } },
      { daysAgo: 24, params: { ...tt, testFiles: 8, commits90: 24 } },
      { daysAgo: 12, params: { ...tt, testFiles: 18, commits90: 22 } },
      // время и коммит последнего анализа — как в примере ответа (guide/badge-api.md)
      { daysAgo: 0, params: tt, sha: "4f2a9c1e7b03d58a6e91f0c2b7d4a3e8f5c6019b" },
    ],
  });
  const wb = weatherBot();
  out.push({
    org: "example",
    repo: "weather-bot",
    title: "Weather Bot",
    likes: 57,
    forks: 9,
    scans: [
      { daysAgo: 21, params: { ...wb, contributing: false } },
      { daysAgo: 7, params: { ...wb, testFiles: 20 } },
      { daysAgo: 0, params: wb },
    ],
  });
  const be = backend();
  out.push({
    org: "my-team",
    repo: "backend",
    title: "Backend",
    likes: 31,
    forks: 4,
    scans: [
      { daysAgo: 28, params: { ...be, readme: { bytes: 6000, install: true, build: false, test: false } } },
      { daysAgo: 14, params: { ...be, todoOld: 9 } },
      { daysAgo: 0, params: be },
    ],
  });

  // --- особые случаи ---
  const rng = mulberry32(7);
  out.push({
    org: "example",
    repo: "image-resizer",
    title: "Image Resizer",
    likes: 22,
    forks: 2,
    scans: [
      {
        daysAgo: 0,
        // файлы кода есть, но строки не прочитаны (сгенерированные файлы больше лимита текста)
        params: { ...profile(0.7, rng, "C++"), sourceLoc: 0, sourceUnread: 46, sourceFiles: 46, testFiles: 0, todo: 0, fixme: 0, todoOld: 0 },
      },
    ],
  });
  out.push({
    org: "example",
    repo: "legacy-monolith",
    title: "Legacy Monolith",
    likes: 8,
    forks: 1,
    scans: [
      {
        daysAgo: 0,
        params: { ...profile(0.5, rng, "Java"), git: { reason: "limits", detail: "bare clone 3221225472 B > budget 1073741824 B (final-size)" } },
      },
    ],
  });
  out.push({
    org: "example",
    repo: "data-archive",
    title: "Data Archive",
    likes: 3,
    forks: 0,
    scans: [
      {
        daysAgo: 0,
        params: { ...profile(0.3, rng, "C++"), git: { reason: "limits", detail: "clone completed in 305000 ms > 300000 ms timeout" }, issues: "empty" },
      },
    ],
  });
  out.push({
    org: "example",
    repo: "design-notes",
    title: "Design Notes",
    likes: 5,
    forks: 0,
    scans: [
      {
        daysAgo: 0,
        // только Markdown и картинки: кода нет — оценка 0
        params: { ...profile(0.6, rng, null), sourceFiles: 0, testFiles: 0, sourceLoc: 0, otherFiles: 48, todo: 0, fixme: 0, todoOld: 0 },
      },
    ],
  });

  // --- верх рейтинга: выдуманные репозитории с высоким q ---
  const top: [string, string, string, number, number][] = [
    ["northwind", "payments-gateway", "Java", 0.99, 412],
    ["pixel-forge", "render-kit", "Rust", 0.98, 388],
    ["open-meadow", "geo-tiles", "Go", 0.98, 256],
    ["data-garden", "etl-flow", "Python", 0.97, 301],
    ["lumen-works", "ui-kit", "TypeScript", 0.97, 540],
    ["polar-dev", "metrics-agent", "Go", 0.96, 190],
    ["acme-labs", "auth-service", "Kotlin", 0.96, 144],
    ["river-soft", "mobile-app", "Kotlin", 0.95, 97],
    ["sunrise-it", "crm-core", "Java", 0.95, 76],
    ["orbit-tools", "deploy-cli", "Go", 0.94, 133],
    ["quiet-lab", "search-engine", "C++", 0.94, 210],
    ["maple-team", "docs-portal", "TypeScript", 0.93, 64],
    ["green-byte", "stream-sdk", "C#", 0.92, 58],
    ["cloud-kitchen", "order-api", "PHP", 0.9, 41],
    ["tiny-robots", "sensor-hub", "Rust", 0.9, 85],
  ];
  const topRng = mulberry32(99);
  for (const [org, repo, lang, q, likes] of top) {
    const p = profile(q, topRng, lang);
    out.push({
      org,
      repo,
      title: titleOf(repo),
      likes,
      forks: Math.round(likes / 12),
      scans: [
        { daysAgo: 9, params: { ...p, codeowners: false } },
        { daysAgo: 0, params: { ...p, prReview: true } },
      ],
    });
  }

  // --- фон ---
  const bg = mulberry32(12345);
  const used = new Set(out.map((s) => `${s.org}/${s.repo}`));
  const TOTAL_BG = 1180;
  for (let i = 0; i < TOTAL_BG; ) {
    const org = ORGS[Math.floor(bg() * ORGS.length)]!;
    const repo = `${WORDS_A[Math.floor(bg() * WORDS_A.length)]}-${WORDS_B[Math.floor(bg() * WORDS_B.length)]}`;
    const slug = `${org}/${repo}`;
    if (used.has(slug)) continue;
    used.add(slug);
    i++;
    // не выше 0,85: верх рейтинга держат репозитории из списка выше
    const q = Math.min(0.85, Math.max(0.02, 0.45 + (bg() + bg() + bg() - 1.5) * 0.45));
    // первые 60 фоновых — TypeScript 1-10 тыс. строк: когорта example/tasktracker
    const lang = i <= 60 ? "TypeScript" : pickLang(bg);
    const loc = i <= 60 ? Math.round(1000 + bg() * 8999) : undefined;
    out.push({
      org,
      repo,
      title: titleOf(repo),
      likes: Math.floor(Math.pow(bg(), 3) * 120 * (0.3 + q)),
      forks: Math.floor(bg() * 6 * q),
      scans: [{ daysAgo: bg() * 6, params: profile(q, bg, lang, loc) }],
    });
  }
  return out;
}

// ---------- запись ----------

const config = { ...loadConfig(), dataDir };
const db = openDb(config);
const insRepo = db.query(
  `INSERT INTO repos (org_slug, repo_slug, title, language, likes, forks, last_activity_at, visibility, rating_active, language_color)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'public', 1, NULL)`,
);
const insScan = db.query(
  `INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, user_id, head_sha, collector_version)
   VALUES (?, ?, ?, ?, 'periodic', NULL, ?, ?)`,
);
const insFact = db.query(
  "INSERT INTO facts (scan_id, category, key, value, status, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

const all = specs();
const shaRng = mulberry32(4242);
let scanCount = 0;
db.transaction(() => {
  for (const spec of all) {
    const last = spec.scans[spec.scans.length - 1]!;
    const lastAt = NOW - last.daysAgo * DAY;
    const lastActivity = last.params.git === "ok" ? lastAt - last.params.lastDays * DAY : lastAt - 12 * DAY;
    const repoId = Number(
      insRepo.run(spec.org, spec.repo, spec.title, last.params.language, spec.likes, spec.forks, iso(lastActivity)).lastInsertRowid,
    );
    spec.scans.forEach((s, i) => {
      // анализ длится несколько минут; время фактов — начало анализа
      const finished = NOW - s.daysAgo * DAY - (spec.scans.length - 1 - i) * 7 * 60_000;
      const started = finished - (3 + (repoId % 5)) * 60_000 - 14_000;
      const facts = buildFacts(s.params, finished, mulberry32(repoId * 31 + i));
      const status = scanStatusOf(facts, false);
      const sha = s.sha ?? (s.params.git === "ok" ? hexSha(shaRng) : null);
      const scanId = Number(insScan.run(repoId, iso(started), iso(finished), status, sha, COLLECTOR_VERSION).lastInsertRowid);
      for (const f of facts) {
        insFact.run(scanId, categoryOf(f.key), f.key, encodeFactValue(f.key, f.value, f.status), f.status, f.source, iso(started));
      }
      scanCount++;
    });
  }
})();
console.log(`[demo-db] ${all.length} репозиториев, ${scanCount} анализов → ${dataDir}`);

// ---------- оценки считает модель ----------

const t0 = Date.now();
const result = rescoreAll(db, { log: (m) => console.log(`[demo-db] ${m}`), progressEvery: 500 });
console.log(`[demo-db] пересчет: ${Math.round((Date.now() - t0) / 1000)} с, ошибок ${result.errors}`);

// ---------- снимок мест «вчера» с чуть другим порядком ----------

const yesterday = new Date(NOW - DAY);
const snap = takeRatingSnapshot(db, { now: yesterday });
const day = utcDayOf(yesterday);
const rows = db.query("SELECT id, rank FROM rating_snapshots WHERE taken_at = ? ORDER BY rank").all(day) as { id: number; rank: number }[];
// перестановки в первой десятке и вокруг example/tasktracker: стрелки вверх и вниз
const swap = (a: number, b: number) => {
  const ra = rows.find((r) => r.rank === a);
  const rb = rows.find((r) => r.rank === b);
  if (!ra || !rb) return;
  db.query("UPDATE rating_snapshots SET rank = ? WHERE id = ?").run(b, ra.id);
  db.query("UPDATE rating_snapshots SET rank = ? WHERE id = ?").run(a, rb.id);
};
swap(2, 3);
swap(5, 8);
swap(9, 12);
const tt = db
  .query(
    `SELECT rs.rank FROM rating_snapshots rs JOIN repos r ON r.id = rs.repo_id
     WHERE rs.taken_at = ? AND r.org_slug = 'example' AND r.repo_slug = 'tasktracker'`,
  )
  .get(day) as { rank: number } | null;
if (tt) {
  // вчера example/tasktracker был на 4 места ниже
  const rowsNow = db.query("SELECT id, rank FROM rating_snapshots WHERE taken_at = ? ORDER BY rank").all(day) as { id: number; rank: number }[];
  const self = rowsNow.find((r) => r.rank === tt.rank)!;
  const shifted = rowsNow.filter((r) => r.rank > tt.rank && r.rank <= tt.rank + 4);
  for (const r of shifted) db.query("UPDATE rating_snapshots SET rank = ? WHERE id = ?").run(r.rank - 1, r.id);
  db.query("UPDATE rating_snapshots SET rank = ? WHERE id = ?").run(tt.rank + 4, self.id);
}
console.log(`[demo-db] снимок мест за ${day}: ${snap.rows} строк`);

// ---------- контроль ключевых чисел ----------

const check = db
  .query(
    `SELECT r.org_slug || '/' || r.repo_slug AS slug, sc.healthcraft_index AS idx, sc.index_coverage AS cov, sc.categories AS cats
     FROM repos r JOIN scores sc ON sc.scan_id = (SELECT MAX(id) FROM scans WHERE repo_id = r.id)
     WHERE r.org_slug IN ('example', 'my-team') ORDER BY slug`,
  )
  .all() as { slug: string; idx: number | null; cov: number; cats: string }[];
for (const row of check) {
  const cats = JSON.parse(row.cats) as Record<string, { score: number | null }>;
  const fmt = (k: string) => (cats[k]?.score === null || cats[k]?.score === undefined ? "н/д" : cats[k]!.score!.toFixed(2));
  console.log(
    `[demo-db] ${row.slug.padEnd(24)} index ${String(row.idx).padStart(4)} cov ${row.cov}  doc ${fmt("documentation")} act ${fmt("activity")} iss ${fmt("issues")} code ${fmt("code")}`,
  );
}
const ranked = db.query("SELECT COUNT(*) AS n FROM rating_snapshots WHERE taken_at = ?").get(day) as { n: number };
console.log(`[demo-db] мест в рейтинге: ${ranked.n}`);
db.close();
