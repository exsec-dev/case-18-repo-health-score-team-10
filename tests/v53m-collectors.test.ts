// В5.3-М — сборщик модели 4.3.0-hci (workers/V5.3-method-oneshot.md, §2
// «Сборщик»): версия сборщика и доочередь (Н1), blame по sha (Н2),
// перечисления спеки (Н6), длительность CI по успешным (Н8б), YAML-маркеры
// (Н12), файлы тестов (Р1), время жизни задач (Р2), маркеры в комментариях
// (Р4а), содержимое документов (Р4в), answered/censored (Н14а).
// Поведенческие тесты на данных: локальный git, фейковые REST/AppSec, временная БД.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { COLLECTOR_VERSION, okFact, type Fact } from "../src/collectors/facts";
import { blameLineTimes, ciHasSteps, cleanupClone, cloneBare, docHasContent, extractFacts, readmeSectionFlags, todoMarkerKind } from "../src/collectors/git";
import { isTestPath } from "../src/collectors/source-path";
import { parseYamlSubset } from "../src/collectors/yamlmini";
import { collectRestFacts, releaseStatusClass } from "../src/collectors/rest";
import { APPSEC_OPEN_STATUSES, appsecQuery, collectAppsec, defectGroupStatusClass, type AppsecClient, type AppsecGet, type AppsecParams } from "../src/collectors/appsec";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { loadConfig } from "../src/config";
import { openDb, SCHEMA_VERSION } from "../src/db";
import { nightlyCatalog, recollectPerWave, RECOLLECT_PER_WAVE_DEFAULT } from "../src/jobs/scheduler";
import { runScan, type ScanDeps } from "../src/jobs/runner";

const NOW = new Date("2026-09-15T00:00:00Z");
const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const EXTRACT = { maxBlameFiles: 200, textCapBytes: 1_000_000 };
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date = "2026-01-01T00:00:00+00:00", author = "Dev <dev@example.com>") {
  const [name, email] = author.replace(">", "").split(" <");
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function newRepo(): string {
  const src = mkdtempSync(join(tmpdir(), "rh-v53m-src-"));
  tmp.push(src);
  git(src, ["init", "-q", "-b", "main"]);
  return src;
}

function write(src: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), body);
  }
}

async function factsOfRepo(src: string): Promise<Map<string, Record<string, unknown>>> {
  const work = mkdtempSync(join(tmpdir(), "rh-v53m-work-"));
  tmp.push(work);
  const out = await cloneBare(`file://${src}`, work, { ...LIMITS });
  if (!out.ok) throw new Error(out.detail);
  try {
    const facts: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
    return new Map(facts.map((f) => [f.key, f.value as Record<string, unknown>]));
  } finally {
    cleanupClone(out.dir);
  }
}

async function factsOf(files: Record<string, string>): Promise<Map<string, Record<string, unknown>>> {
  const src = newRepo();
  write(src, files);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "init"]);
  return factsOfRepo(src);
}

describe("Н2: git blame — время строки по sha заголовка", () => {
  test("Н2: старый TODO после свежей вставки другим коммитом — older_180d = 1", async () => {
    const src = newRepo();
    write(src, { "src/a.ts": "export const a = 1;\n// TODO: old debt\n" });
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", "old"], "2024-01-01T00:00:00+00:00", "Old <old@example.com>");
    // свежая строка МЕЖДУ старыми: porcelain печатает старый коммит, затем
    // новый, затем снова старый — уже без author-time
    write(src, { "src/a.ts": "export const a = 1;\nexport const b = 2;\n// TODO: old debt\n" });
    git(src, ["add", "-A"]);
    git(src, ["commit", "-q", "-m", "new"], "2026-09-01T00:00:00+00:00", "New <new@example.com>");
    const facts = await factsOfRepo(src);
    const todo = facts.get("code.todo")!;
    expect(todo.count).toBe(1);
    expect(todo.older_180d).toBe(1);
  });

  test("Н2: разбор porcelain — повторная группа коммита берет его время, а не последнее прочитанное", () => {
    const old = "a".repeat(40);
    const fresh = "b".repeat(40);
    const out = [
      `${old} 1 1 1`,
      "author Old",
      "author-time 1700000000",
      "filename a.ts",
      "\tline one",
      `${fresh} 2 2 1`,
      "author New",
      "author-time 1790000000",
      "filename a.ts",
      "\tline two",
      `${old} 2 3 1`,
      "\t// TODO old",
    ].join("\n");
    expect(blameLineTimes(out).map((l) => l.ts)).toEqual([1700000000_000, 1790000000_000, 1700000000_000]);
  });
});

describe("Р4а: маркеры техдолга — без учета регистра и только в комментариях", () => {
  test("Р4а: маркер в комментарии любого регистра — пометка; HACK и XXX — в корзину fixme", () => {
    expect(todoMarkerKind("// todo: lower case")).toBe("TODO");
    // круг 2 (К1): `#` — комментарий только в начале строки
    expect(todoMarkerKind("# Todo later")).toBe("TODO");
    expect(todoMarkerKind("/* FIXME */")).toBe("FIXME");
    expect(todoMarkerKind("  * hack around the api")).toBe("FIXME");
    expect(todoMarkerKind("-- XXX sql")).toBe("FIXME");
    expect(todoMarkerKind("<!-- todo -->")).toBe("TODO");
    expect(todoMarkerKind("REM todo batch")).toBe("TODO");
    expect(todoMarkerKind("' todo vb")).toBe("TODO");
  });

  test("Р4а: слово todo в коде — не пометка (todoList, строка \"todo\", имя без комментария)", () => {
    expect(todoMarkerKind("const todoList = [];")).toBeNull();
    expect(todoMarkerKind('status = "todo";')).toBeNull();
    expect(todoMarkerKind("function todo() {}")).toBeNull();
    expect(todoMarkerKind("const s = 'todo'")).toBeNull();
    expect(todoMarkerKind("let TODO = 1")).toBeNull();
    expect(todoMarkerKind("// nothing here: todos")).toBeNull();
  });

  test("Р4а: сборщик — TODO→todo больше не снимает пометки, код без комментария их не дает", async () => {
    const facts = await factsOf({
      "src/a.ts": "// todo: lower\n// TODO: upper\nconst todoList = ['todo'];\n// hack: temp\n",
      "src/b.py": "# xxx remove\nstatus = 'todo'\n",
    });
    const todo = facts.get("code.todo")!;
    expect(todo.count).toBe(2);
    expect(todo.fixme).toBe(2);
  });
});

describe("Р1: файлы тестов среди файлов кода", () => {
  test("Р1: каталоги test/tests/__tests__/spec/specs и имена test_*, *_test.*, *.test.*, *.spec.* — без учета регистра", () => {
    for (const p of ["tests/a.py", "src/__tests__/x.js", "Spec/a.rb", "pkg/specs/b.rb", "test/c.go", "test_x.py", "x_test.go", "a.test.ts", "b.SPEC.js", "TESTS/Foo.java"]) expect(isTestPath(p)).toBe(true);
    for (const p of ["src/main.ts", "latest.py", "contest/a.ts", "tests/README.md", "docs/test.md", "attestation.go"]) expect(isTestPath(p)).toBe(false);
  });

  test("Р1: tree.stats.test_files — считает только код", async () => {
    const facts = await factsOf({ "src/a.ts": "export const a = 1;\n", "tests/a.test.ts": "test();\n", "tests/notes.md": "# notes\n", "b_test.go": "package b\n" });
    const tree = facts.get("tree.stats")!;
    expect(tree.source_files).toBe(3);
    expect(tree.test_files).toBe(2);
  });
});

describe("Р4в: документы засчитываются только с содержанием", () => {
  test("Р4в: пустые LICENSE/CONTRIBUTING/CODEOWNERS — нет; с текстом от 16 знаков — есть", async () => {
    const empty = await factsOf({ "LICENSE": "", "CONTRIBUTING.md": "  \n", "CODEOWNERS": "* @a\n", "src/a.ts": "x\n" });
    expect(empty.get("docs.presence")).toEqual({ readme: false, license: false, contributing: false, codeowners: false, content_checked: true });
    const full = await factsOf({
      "LICENSE": "MIT License\n\nCopyright (c) 2026 Dev\n",
      "CONTRIBUTING.md": "Open a pull request with tests.\n",
      "CODEOWNERS": "* @team-lead @backend-owner\n",
      "src/a.ts": "x\n",
    });
    expect(full.get("docs.presence")).toEqual({ readme: false, license: true, contributing: true, codeowners: true, content_checked: true });
    expect(docHasContent("  a b c d e f g h  i j k l m n o p ")).toBe(true);
    expect(docHasContent("MIT License")).toBe(false);
  });

  test("Р4в: каталог LICENSES засчитывается по файлу с текстом", async () => {
    const facts = await factsOf({ "LICENSES/MIT.txt": "Permission is hereby granted, free of charge\n", "src/a.ts": "x\n" });
    expect(facts.get("docs.presence")!.license).toBe(true);
  });

  test("Р4в: раздел README — только с текстом или блоком кода под заголовком", () => {
    expect(readmeSectionFlags("# X\n\n## Install\n\n## Build\n\n## Tests\n")).toEqual({ install: false, build: false, test: false });
    expect(readmeSectionFlags("# X\n\n## Install\n\n```\n```\n\n## Build\n<!-- later -->\n")).toEqual({ install: false, build: false, test: false });
    expect(readmeSectionFlags("# X\n\n## Install\n\n```sh\nnpm i\n```\n\n## Build\nRun make.\n\n## Tests\n### Unit\nbun test\n")).toEqual({ install: true, build: true, test: true });
  });
});

describe("Н12: ci.yaml — маркеры документа, пустой объект, строковый script", () => {
  test("Н12: `---`, `...`, `{}` разбираются; `script: echo hi` — шаг", () => {
    expect(parseYamlSubset("---\non: [push]\n...\n")).toEqual({ on: ["push"] });
    expect(parseYamlSubset("{}\n")).toEqual({});
    expect(parseYamlSubset("on: {}\n")).toEqual({ on: {} });
    expect(ciHasSteps(parseYamlSubset("---\ntasks:\n  - name: t\n    script: echo hi\n"))).toBe(true);
    expect(ciHasSteps(parseYamlSubset("tasks:\n  - name: t\n    script: |\n      make test\n"))).toBe(true);
    expect(ciHasSteps(parseYamlSubset("tasks:\n  - name: t\n    script: \"\"\n"))).toBe(false);
  });
});

// ---------- REST ----------

const ok = (json: unknown): ScResponse => ({ status: 200, json, bodyText: "" });
const pathOf = (p: string): string => (p.includes("?") ? p.slice(0, p.indexOf("?")) : p);

function restClient(over: { open?: unknown[]; progress?: unknown[] | ScResponse; closed?: unknown[]; releases?: unknown[]; runs?: unknown[]; comments?: (p: string) => unknown[] }): ScClient {
  return {
    async get(p: string): Promise<ScResponse> {
      const base = pathOf(p);
      if (base === "/repos/o/r") return ok({ id: "1", name: "r", visibility: "public" });
      if (base === "/repos/o/r/issues" && p.includes("status%3Dopen")) return ok({ issues: over.open ?? [] });
      if (base === "/repos/o/r/issues" && p.includes("status%3Din_progress")) {
        const pr = over.progress ?? [];
        return Array.isArray(pr) ? ok({ issues: pr }) : pr;
      }
      if (base === "/repos/o/r/issues" && p.includes("status%3Dclosed")) return ok({ issues: over.closed ?? [] });
      if (base.includes("/comments")) return ok({ issue_comments: over.comments ? over.comments(p) : [] });
      if (base === "/repos/o/r/contributors") return ok({ contributors: [] });
      if (base === "/repos/o/r/releases") return ok({ releases: over.releases ?? [] });
      if (base === "/repos/o/r/pulls") return ok({ pull_requests: [] });
      if (base === "/repos/o/r/cicd/runs") return ok({ runs: over.runs ?? [] });
      return { status: 404, json: null, bodyText: "no route" };
    },
    requestCount: () => 0,
  };
}

async function restFacts(client: ScClient, topN = 5): Promise<Map<string, Record<string, unknown>>> {
  const out = await collectRestFacts(client, "o/r", { commentsTopN: topN, now: NOW });
  return new Map(out.facts.map((f) => [f.key, f.value as Record<string, unknown>]));
}

const issue = (slug: string, created: string, updated = created, extra: Record<string, unknown> = {}) => ({ id: slug, slug, created_at: created, updated_at: updated, ...extra });

describe("Н6: перечисления спеки", () => {
  test("Н6: задачи in_progress — открытые: в зависших и в выборке первого ответа", async () => {
    const f = await restFacts(
      restClient({
        open: [issue("1", "2026-09-10T00:00:00Z")],
        progress: [issue("2", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")],
        comments: (p) => (p.includes("/issues/2/") ? [{ created_at: "2026-01-02T00:00:00Z" }] : []),
      }),
    );
    const stats = f.get("issues.stats")!;
    expect(stats.open).toBe(2);
    expect(stats.in_progress).toBe(1);
    expect(stats.stale_90d).toBe(1);
    const sample = f.get("issues.comments_sample")!;
    expect(sample.issues).toBe(2);
    expect(sample.answered).toBe(1);
  });

  // круг 2 (К4, E1): вытесняет «сбой in_progress — факт bad»
  test("Н6 → К4: сбой запроса in_progress — задачи по open + closed с пометкой, факт не bad", async () => {
    const out = await collectRestFacts(restClient({ open: [issue("1", "2026-09-10T00:00:00Z")], progress: { status: 503, json: null, bodyText: "" } }), "o/r", { commentsTopN: 0, now: NOW });
    const stats = out.facts.find((x) => x.key === "issues.stats")!;
    expect(stats.status).toBe("ok");
    const v = stats.value as Record<string, unknown>;
    expect(v.open).toBe(1);
    expect(v.in_progress).toBeNull();
    expect(String(v.in_progress_note)).toContain("status 503");
  });

  test("Н6: релизы — только published; draft и discarded своей веткой, неизвестный статус — явной", async () => {
    expect(["published", "draft", "discarded", "weird", undefined].map(releaseStatusClass)).toEqual(["published", "draft", "discarded", "unknown", "unknown"]);
    const f = await restFacts(
      restClient({
        releases: [
          { status: "draft", released_at: "2026-09-10T00:00:00Z", is_latest: true },
          { status: "published", released_at: "2026-08-01T00:00:00Z" },
          { status: "discarded", released_at: "2026-09-12T00:00:00Z" },
          { status: "weird", released_at: "2026-09-13T00:00:00Z" },
        ],
      }),
    );
    const rest = f.get("activity.rest")!;
    expect(rest.releases).toBe(1);
    expect(rest.releases_released_at).toEqual(["2026-08-01T00:00:00Z"]);
    expect(rest.latest_release_at).toBe("2026-08-01T00:00:00Z");
    expect(rest.release_statuses).toEqual({ draft: 1, published: 1, discarded: 1, unknown: 1 });
    expect(String(rest.release_status_note)).toContain("weird");
  });

  test("Н6: запуски CI сортируются по дате начала на клиенте (API отдал старые первыми)", async () => {
    const run = (status: string, day: string, secs = 60) => ({ status, dates: { started_at: `2026-09-${day}T10:00:00Z`, finished_at: new Date(Date.parse(`2026-09-${day}T10:00:00Z`) + secs * 1000).toISOString() } });
    const f = await restFacts(restClient({ runs: [run("success", "01"), run("success", "02"), run("failed", "14")] }));
    const runs = f.get("cicd.runs")!;
    expect(runs.last_status).toBe("failed");
    expect(runs.green_streak).toBe(0);
  });

  test("Н8б: длительность CI — по успешным запускам (быстрый провал не ускоряет пайплайн)", async () => {
    const run = (status: string, day: string, secs: number) => ({ status, dates: { started_at: `2026-09-${day}T10:00:00Z`, finished_at: new Date(Date.parse(`2026-09-${day}T10:00:00Z`) + secs * 1000).toISOString() } });
    const f = await restFacts(restClient({ runs: [run("failed", "14", 5), run("failed", "13", 5), run("failed", "12", 5), run("success", "11", 900)] }));
    expect(f.get("cicd.runs")!.duration_p50).toBe(900);
    const none = await restFacts(restClient({ runs: [run("failed", "14", 5)] }));
    expect(none.get("cicd.runs")!.duration_p50).toBeNull();
  });
});

describe("Р2: время жизни закрытых задач", () => {
  test("Р2: прожившие меньше часа — closed_instant; медиана закрытия — только по closed_counted", async () => {
    const closed = [
      issue("1", "2026-09-01T00:00:00Z", "2026-09-01T00:10:00Z", { completed_at: "2026-09-01T00:10:00Z" }),
      issue("2", "2026-09-01T00:00:00Z", "2026-09-01T00:59:00Z", { completed_at: "2026-09-01T00:59:00Z" }),
      issue("3", "2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", { completed_at: "2026-09-03T00:00:00Z" }),
      // без completed_at — фолбэк updated_at, как у median_close_days
      issue("4", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
    ];
    const stats = (await restFacts(restClient({ closed }))).get("issues.stats")!;
    expect(stats.closed).toBe(4);
    expect(stats.closed_instant).toBe(2);
    expect(stats.closed_counted).toBe(2);
    // медиана по 2 дням и 1 часу (0,04 дня), мгновенные не входят
    expect(stats.median_close_days).toBe(1);
  });
});

describe("Н14а: answered и censored вместо with_comments", () => {
  test("Н14а: ответ и цензура — раздельными полями; with_comments новый сборщик не пишет", async () => {
    const f = await restFacts(
      restClient({
        open: [issue("1", "2026-09-10T00:00:00Z"), issue("2", "2026-06-01T00:00:00Z"), issue("3", "2026-09-14T00:00:00Z")],
        comments: (p) => (p.includes("/issues/1/") ? [{ created_at: "2026-09-10T05:00:00Z" }] : []),
      }),
    );
    const s = f.get("issues.comments_sample")!;
    expect(s.answered).toBe(1);
    expect(s.censored).toBe(1);
    expect(s.delays_hours).toEqual([5, 720]);
    expect("with_comments" in s).toBe(false);
  });
});

// ---------- AppSec ----------

function appsecFake(groups: Record<string, unknown>[], log: AppsecParams[]): AppsecClient {
  return {
    async get(path: string, params: AppsecParams): Promise<AppsecGet> {
      log.push(params);
      if (path === "/v1/scans/latest") return { status: 200, json: { uuid: "s1", timeFinished: Date.parse("2026-09-10T00:00:00Z"), isLatest: true, openDefectGroups: 1, totalDefectGroups: 3 } };
      const statuses = Array.isArray(params.status) ? params.status : [];
      const kept = groups.filter((g) => statuses.length === 0 || statuses.includes(String(g.status)));
      if (params.severity !== undefined) {
        const n = kept.filter((g) => g.severity === params.severity && (params.type === undefined || g.type === params.type)).length;
        return { status: 200, json: { data: [], nextPageToken: "", totalSize: n } };
      }
      // платформа проигнорировала фильтр страницы — отдала все группы
      return { status: 200, json: { data: groups, nextPageToken: "", totalSize: groups.length } };
    },
    requestCount: () => 0,
  };
}

const restForAppsec: ScClient = { async get() { return ok({ id: "repo-1" }); }, requestCount: () => 0 };

describe("Н6: AppSec — только открытые группы", () => {
  test("Н6: каждое значение DefectGroupStatus — своей веткой, неизвестное — явной", () => {
    const all = ["OPEN", "TRIAGE_IN_PROGRESS", "TRIAGED_TP", "FIX_IN_PROGRESS", "RESOLVED_FIXED", "RESOLVED_FP", "RESOLVED_PROJECT_NOT_AFFECTED", "RESOLVED_TOLERABLE", "RESOLVED_DUPLICATE", "RESOLVED_AUTOFIXED", "UNRECOGNIZED", "NEW_VALUE"];
    expect(all.map(defectGroupStatusClass)).toEqual(["open", "open", "open", "open", "resolved", "resolved", "resolved", "resolved", "resolved", "resolved", "unrecognized", "unknown"]);
    expect(appsecQuery({ a: "1", status: ["OPEN", "TRIAGED_TP"] })).toBe("a=1&status=OPEN&status=TRIAGED_TP");
  });

  test("Н6: исправленный критичный секрет и закрытые группы не входят в счетчики, секреты и бэклог", async () => {
    const groups = [
      { status: "OPEN", severity: "HIGH", type: "SAST", findingsCount: 2 },
      { status: "RESOLVED_FIXED", severity: "CRITICAL", type: "SECRETS", findingsCount: 1 },
      { status: "RESOLVED_FP", severity: "CRITICAL", type: "SAST", findingsCount: 4 },
    ];
    const log: AppsecParams[] = [];
    const out = await collectAppsec(restForAppsec, appsecFake(groups, log), "o/r", { now: NOW });
    const v = out.fact!.value as { severity_counts: Record<string, number>; secrets_critical: boolean; backlog: { open_groups: number; open_findings: number; status_counts: Record<string, number> } };
    expect(v.severity_counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(v.secrets_critical).toBe(false);
    expect(v.backlog.open_groups).toBe(1);
    expect(v.backlog.open_findings).toBe(2);
    expect(v.backlog.status_counts).toEqual({ open: 1, resolved: 2 });
    // каждый запрос групп несет фильтр открытых статусов
    for (const p of log.filter((x) => "scanUuid" in x)) expect(p.status).toEqual([...APPSEC_OPEN_STATUSES]);
  });
});

// ---------- Н1: версия сборщика ----------

describe("Н1: версия сборщика и доочередь ночной волны", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-v53m-db-"));
  tmp.push(dir);
  const db: Database = openDb({ ...loadConfig(), dataDir: dir });
  afterAll(() => db.close());

  const repoOf = (slug: string, likes: number) => ({ organization: { slug: "rc" }, slug, name: slug, visibility: "public", last_updated: "2026-09-01T00:00:00Z", language: null, rating: { value: likes } });
  function catalog(repos: Record<string, unknown>[]): ScClient {
    return {
      async get(p: string): Promise<ScResponse> {
        if (!p.startsWith("/repos")) return { status: 404, json: null, bodyText: "" };
        return ok({ repositories: repos, next_page_token: "" });
      },
      requestCount: () => 1,
    };
  }
  function seed(slug: string, collector: number | null, eligible = 1): number {
    db.query("INSERT INTO repos (org_slug, repo_slug, last_activity_at, visibility) VALUES ('rc', ?, '2026-09-01T00:00:00Z', 'public')").run(slug);
    const id = (db.query("SELECT id FROM repos WHERE org_slug = 'rc' AND repo_slug = ?").get(slug) as { id: number }).id;
    db.query("INSERT INTO scans (repo_id, started_at, finished_at, status, trigger, rating_eligible, collector_version) VALUES (?, '2026', '2026', 'ok', 'periodic', ?, ?)").run(id, eligible, collector);
    return id;
  }

  test("Н1: схема 2.2 — колонка scans.collector_version; openDb повторно идемпотентен", () => {
    expect(SCHEMA_VERSION).toBe("2.4"); // В5.5 тур 1 (W2): поверх 2.3 — rating_snapshots, аддитивно
    const cols = (db.query("PRAGMA table_info(scans)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("collector_version");
    const again = openDb({ ...loadConfig(), dataDir: dir });
    again.close();
  });

  test("Н1: неизменные репо со сборщиком старше текущего — доочередь по лайкам, порцией; текущий сборщик — нет", async () => {
    seed("fresh", COLLECTOR_VERSION);
    seed("legacy-null", null);
    seed("old-2", 2);
    seed("old-1", 1);
    seed("ineligible-old", 1, 0);
    const repos = [repoOf("fresh", 90), repoOf("legacy-null", 5), repoOf("old-2", 50), repoOf("old-1", 20), repoOf("ineligible-old", 99)];
    const out = await nightlyCatalog(db, catalog(repos), { now: NOW, recollectPerWave: 2 });
    const recollect = out.enqueued.filter((e) => e.reason === "recollect").map((e) => e.slug);
    expect(recollect).toEqual(["rc/old-2", "rc/old-1"]);
    // непригодный последний скан уходит своей причиной, текущий сборщик — не в волне
    expect(out.enqueued.find((e) => e.slug === "rc/ineligible-old")?.reason).toBe("retry-ineligible");
    expect(out.enqueued.some((e) => e.slug === "rc/fresh")).toBe(false);
  });

  // круг 2 (К8, решение В2): дефолт 3000 → 5000
  test("Н1 + К8: порция по умолчанию — 5000 (переменная не задана), 0 выключает, мусор — дефолт", () => {
    expect(recollectPerWave({})).toBe(RECOLLECT_PER_WAVE_DEFAULT);
    expect(RECOLLECT_PER_WAVE_DEFAULT).toBe(5000);
    expect(recollectPerWave({ SCHEDULER_RECOLLECT_PER_WAVE: "0" })).toBe(0);
    expect(recollectPerWave({ SCHEDULER_RECOLLECT_PER_WAVE: "25" })).toBe(25);
    expect(recollectPerWave({ SCHEDULER_RECOLLECT_PER_WAVE: "-4" })).toBe(5000);
    expect(recollectPerWave({ SCHEDULER_RECOLLECT_PER_WAVE: "abc" })).toBe(5000);
  });

  test("Н1: runScan штампует скан текущей версией сборщика", async () => {
    const facts: Fact[] = [okFact("activity.git.summary", { commits: 1 }, "git")];
    const deps: ScanDeps = {
      db,
      scClient: null,
      restBase: "http://127.0.0.1:1",
      appsecBase: "http://127.0.0.1:1",
      collectGit: async () => ({ facts }),
      collectRest: async () => ({ facts: [], repoMeta: null, channelErrors: [] }),
    };
    const r = await runScan(deps, "rc/stamp");
    expect((db.query("SELECT collector_version FROM scans WHERE id = ?").get(r.scanId) as { collector_version: number }).collector_version).toBe(COLLECTOR_VERSION);
  });
});
