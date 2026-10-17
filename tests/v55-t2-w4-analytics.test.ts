// Углубленная аналитика (ТЗ §7, ЗН-2): review и bottlenecks PR
// (`activity.pr_review`) и карта владельцев файлов (`code.ownership`). Оба –
// справочные (DISPLAY_ONLY): индекс, полный Score, покрытие и рекомендации не
// меняются. Тесты поведенческие, на данных: числа на фикстурах с известным
// ответом, каждое значение перечислений спеки, робот не владеет, email не утекает,
// бюджет и обрезка, «нет PR» ≠ «нет данных», права, мутационный инвариант,
// отрисованный MD. Сети нет: REST — фейковый клиент, git — локальный bare-клон.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRestFacts } from "../src/collectors/rest";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { cleanupClone, cloneBare, extractFacts } from "../src/collectors/git";
import type { Fact } from "../src/collectors/facts";
import {
  PR_BOTTLENECK_H,
  PR_REQUEST_BUDGET,
  PR_REVIEW_SAMPLE,
  aggregatePrReview,
  prCommentTypeClass,
  prSampleEntry,
  prStatusClass,
  reviewDecisionClass,
} from "../src/collectors/pr-review";
import {
  OWNERSHIP_MAX_CHANGES,
  OWNERSHIP_MAX_COMMITS,
  aggregateOwnership,
  displayAuthorName,
  parseOwnershipLog,
  type OwnershipCommit,
} from "../src/collectors/ownership";
import { compute, computeFromFacts, ratingEligible, type Scores } from "../src/score/compute";
import { recommend } from "../src/score/recommend";
import { SUBMETRICS, displayOnly, formatSubmetricValue, submetricContext, submetricShownValue } from "../src/report/submetrics";
import { ownershipView } from "../src/report/sections";
import { renderRepoReport } from "../src/report/markdown";
import { buildReportModel } from "../src/report/build";
import { BREAK, MAX_UNBROKEN, buildPdfDocument } from "../src/report/pdf";
import { getRepoCard } from "../src/api/repos";
import { NOW, healthyFacts, makeDb, seedScan } from "./score-fixtures";
import { cardFacts, makeApiDb, seedRepo } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";

const HOUR = 3_600_000;
const at = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const ok = (json: unknown): ScResponse => ({ status: 200, json, bodyText: "" });
const pathOf = (p: string): string => (p.includes("?") ? p.slice(0, p.indexOf("?")) : p);

/** Фейк REST: список PR и страницы комментариев/ревьюеров по слагу; прочие ресурсы — пустые ok. */
function prClient(
  pulls: Record<string, unknown>[] | ScResponse,
  pages: { comments?: Record<string, ScResponse>; reviewers?: Record<string, ScResponse> } = {},
): ScClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<ScResponse> {
      calls.push(path);
      const p = pathOf(path);
      const pr = /^\/repos\/o\/r\/pulls\/([^/]+)\/(comments|reviewers)$/.exec(p);
      if (pr) {
        const table = pr[2] === "comments" ? pages.comments : pages.reviewers;
        return table?.[decodeURIComponent(pr[1]!)] ?? ok(pr[2] === "comments" ? { pull_request_comments: [] } : { reviewers: [] });
      }
      if (p === "/repos/o/r/pulls") return Array.isArray(pulls) ? ok({ pull_requests: pulls }) : pulls;
      if (p === "/repos/o/r") return ok({ name: "r" });
      if (p === "/repos/o/r/issues") return ok({ issues: [] });
      if (p === "/repos/o/r/contributors") return ok({ contributors: [] });
      if (p === "/repos/o/r/releases") return ok({ releases: [] });
      if (p === "/repos/o/r/cicd/runs") return ok({ runs: [] });
      return { status: 404, json: null, bodyText: "no route" };
    },
    requestCount: () => calls.length,
  };
}

async function prFact(client: ScClient): Promise<Fact> {
  const out = await collectRestFacts(client, "o/r", { commentsTopN: 0, now: NOW });
  return out.facts.find((f) => f.key === "activity.pr_review")!;
}

const user = (id: string) => ({ id, slug: id });

// ---------------------------------------------------------------------------

describe("перечисления спеки — каждое значение своей веткой (правило 22.09)", () => {
  test("PullRequest.Status: draft, open, discarded, merging, merged; иное — unknown", () => {
    expect(["draft", "open", "discarded", "merging", "merged"].map(prStatusClass)).toEqual(["draft", "open", "discarded", "merging", "merged"]);
    expect([undefined, null, "", "closed", "OPEN"].map(prStatusClass)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  test("ReviewDecision: approve, trust, block, abstain; нет решения — pending; иное — unknown", () => {
    expect(["approve", "trust", "block", "abstain"].map(reviewDecisionClass)).toEqual(["approve", "trust", "block", "abstain"]);
    expect([undefined, null, ""].map(reviewDecisionClass)).toEqual(["pending", "pending", "pending"]);
    expect(["ship", "sticky_ship", 1].map(reviewDecisionClass)).toEqual(["unknown", "unknown", "unknown"]);
  });

  test("PullRequestComment.Type: default (и опущенное поле), appsec; иное — unknown", () => {
    expect([undefined, null, "", "default", "appsec", "bot"].map(prCommentTypeClass)).toEqual(["default", "default", "default", "default", "appsec", "unknown"]);
  });

  test("каждое решение ревьюера на данных: ответом считаются approve/trust/block, abstain и pending — нет", () => {
    const pr = { status: "open", created_at: at(100), author: user("a") };
    const answer = (decision: unknown) =>
      prSampleEntry(pr, [], [{ user: user("r"), review_decision: decision, created_at: at(99), updated_at: at(90) }], false).firstResponseMs;
    for (const d of ["approve", "trust", "block"]) expect({ d, t: answer(d) }).toEqual({ d, t: Date.parse(at(90)) });
    for (const d of ["abstain", undefined, "ship"]) expect({ d, t: answer(d) }).toEqual({ d, t: null });
  });

  test("каждый тип комментария на данных: default — ответ ревью, appsec и неизвестный — нет", () => {
    const pr = { status: "open", created_at: at(100), author: user("a") };
    const c = (type: unknown) => ({ author: user("r"), created_at: at(95), type });
    const e = prSampleEntry(pr, [c(undefined), c("default"), c("appsec"), c("bot")], [], false);
    expect({ review: e.reviewComments, appsec: e.appsecComments, unknown: e.unknownCommentTypes }).toEqual({ review: 2, appsec: 1, unknown: ["bot"] });
  });

  test("каждый статус PR на данных: черновик и неизвестный — вне выборки; merging — не ждет ответа", async () => {
    const pulls = ["draft", "open", "discarded", "merging", "merged", "weird"].map((status, i) => ({ slug: String(i), status, created_at: at(200 + i), updated_at: at(150), author: user("a") }));
    const v = (await prFact(prClient(pulls))).value as Record<string, unknown>;
    expect(v.statuses).toEqual({ draft: 1, open: 1, merging: 1, merged: 1, discarded: 1, unknown: 1 });
    expect(v.sampled).toBe(4);
    expect(v.status_note).toBe("unknown pull statuses: weird");
    // без ответа ждет только open (200 ч > 72 ч); merging в знаменатель не входит
    expect({ open: v.open_sampled, waiting: v.waiting_over_threshold }).toEqual({ open: 1, waiting: 1 });
  });
});

describe("А1: review и bottlenecks PR — числа на фикстуре с известным ответом", () => {
  // A: open, 100 ч назад, ответа нет → bottleneck (> 72 ч)
  // B: open, 10 ч назад, комментарий ревьюера через 2 ч; свой комментарий автора и удаленный — не ответ
  // C: merged, 200 ч назад, решение approve через 4 ч, слияние через 50 ч (updated_at)
  // D: discarded, 300 ч назад, только комментарий автора и appsec — ответа нет
  // E: draft — вне выборки
  const pulls = [
    { slug: "A", status: "open", created_at: at(100), updated_at: at(100), author: user("alice") },
    { slug: "B", status: "open", created_at: at(10), updated_at: at(8), author: user("alice") },
    { slug: "C", status: "merged", created_at: at(200), updated_at: at(150), author: user("bob") },
    { slug: "D", status: "discarded", created_at: at(300), updated_at: at(290), author: user("carol") },
    { slug: "E", status: "draft", created_at: at(5), updated_at: at(5), author: user("dave") },
  ];
  const pages = {
    comments: {
      B: ok({
        pull_request_comments: [
          { author: user("alice"), created_at: at(9.5) },
          { author: user("rev"), created_at: at(8), is_deleted: true },
          { author: user("rev"), created_at: at(9), is_published: false },
          { author: user("rev"), created_at: at(8) },
          { author: user("rev2"), created_at: at(7) },
        ],
      }),
      C: ok({ pull_request_comments: [{ author: user("rev"), created_at: at(190) }] }),
      D: ok({ pull_request_comments: [{ author: user("carol"), created_at: at(299) }, { author: user("scanner"), created_at: at(298), type: "appsec" }] }),
    },
    reviewers: {
      A: ok({ reviewers: [{ user: user("rev"), created_at: at(99) }] }),
      C: ok({ reviewers: [{ user: user("rev"), review_decision: "approve", created_at: at(199), updated_at: at(196) }] }),
      D: ok({ reviewers: [{ user: user("rev"), review_decision: "abstain", created_at: at(299), updated_at: at(280) }] }),
    },
  };

  test("медиана первого ответа, bottleneck, комментарии ревью, решения, время слияния, бюджет", async () => {
    const client = prClient(pulls, pages);
    const fact = await prFact(client);
    expect(fact.status).toBe("ok");
    expect(fact.source).toBe("rest:pulls");
    const v = fact.value as Record<string, unknown>;
    expect(v.pulls).toBe(5);
    expect(v.sampled).toBe(4);
    // B: 2 ч (комментарий rev), C: 4 ч (approve раньше комментария на 10 ч) → медиана 3
    expect(v.answered).toBe(2);
    expect(v.median_first_response_hours).toBe(3);
    // открытые A и B; ждет дольше 72 ч только A
    expect({ open: v.open_sampled, waiting: v.waiting_over_threshold, threshold: v.threshold_hours }).toEqual({ open: 2, waiting: 1, threshold: PR_BOTTLENECK_H });
    // ревью-комментарии: A 0, B 2 (rev, rev2), C 1, D 0 → медиана 0,5, всего 3
    expect({ total: v.review_comments_total, median: v.median_review_comments, appsec: v.appsec_comments }).toEqual({ total: 3, median: 0.5, appsec: 1 });
    expect(v.decisions).toEqual({ approve: 1, trust: 0, block: 0, abstain: 1, pending: 1, unknown: 0 });
    expect({ merged: v.merged, merge: v.median_merge_hours, basis: v.merge_time_basis }).toEqual({ merged: 1, merge: 50, basis: "updated_at" });
    // бюджет: 2 запроса на PR выборки (черновик E не запрашивается)
    expect(v.requests).toBe(8);
    const prCalls = client.calls.filter((p) => /\/pulls\/[^/]+\/(comments|reviewers)/.test(p));
    expect(prCalls.length).toBe(8);
    expect(prCalls.some((p) => p.includes("/pulls/E/"))).toBe(false);
  });

  test("бюджет запросов на репо — число: не больше PR_REQUEST_BUDGET = 20 при любом числе PR", async () => {
    expect(PR_REQUEST_BUDGET).toBe(20);
    expect(PR_REQUEST_BUDGET).toBe(PR_REVIEW_SAMPLE * 2);
    const many = Array.from({ length: 40 }, (_, i) => ({ slug: String(i), status: "merged", created_at: at(1000 - i), updated_at: at(900 - i), author: user("a") }));
    const client = prClient(many);
    const v = (await prFact(client)).value as Record<string, unknown>;
    expect(v.sampled).toBe(PR_REVIEW_SAMPLE);
    expect(client.calls.filter((p) => /\/pulls\/[^/]+\/(comments|reviewers)/.test(p)).length).toBe(PR_REQUEST_BUDGET);
    // выборка — самые свежие: слаги 30-39 (created_at ближе к NOW)
    expect(client.calls.some((p) => p.includes("/pulls/39/comments"))).toBe(true);
    expect(client.calls.some((p) => p.includes("/pulls/0/comments"))).toBe(false);
    // время слияния — по всем полученным слитым PR, без запросов
    expect(v.merged).toBe(40);
  });

  test("полная страница комментариев — счет «не меньше» помечен", async () => {
    const client = prClient([{ slug: "X", status: "open", created_at: at(5), author: user("a") }], {
      comments: { X: ok({ pull_request_comments: [{ author: user("r"), created_at: at(4) }], next_page_token: "t2" }) },
    });
    const v = (await prFact(client)).value as Record<string, unknown>;
    expect(v.comments_capped).toBe(1);
  });
});

describe("А1: «нет PR» — данные, сбой выборки — не данные", () => {
  // UX 17.10: на экране «PR» → «предложения изменений»
  test("PR нет: факт ok с pulls = 0, ни одного лишнего запроса; показ «предложения изменений не используются»", async () => {
    const client = prClient([]);
    const fact = await prFact(client);
    expect(fact.status).toBe("ok");
    expect(fact.value).toMatchObject({ pulls: 0, sampled: 0, requests: 0 });
    expect(client.calls.filter((p) => /\/pulls\/[^/]+\//.test(p)).length).toBe(0);
    const s = score(withKinds({ "activity.pr_review": fact.value }));
    const row = s.categories.activity.submetrics.pr_review!;
    expect(row.score).toBeNull();
    expect(submetricShownValue("activity", "pr_review", row, CTX)).toBe("предложения изменений не используются");
    expect(s.categories.activity.submetrics.pr_first_response).toBeUndefined();
  });

  test("только черновики — «только черновики», не «нет данных»", async () => {
    const fact = await prFact(prClient([{ slug: "1", status: "draft", created_at: at(3), author: user("a") }]));
    expect(fact.status).toBe("ok");
    const row = score(withKinds({ "activity.pr_review": fact.value })).categories.activity.submetrics.pr_review!;
    expect(submetricShownValue("activity", "pr_review", row, CTX)).toBe("только черновики: 1");
  });

  test("сбой одного запроса выборки — факт bad (урезанная выборка не выдается за данные)", async () => {
    const pulls = [
      { slug: "1", status: "open", created_at: at(5), author: user("a") },
      { slug: "2", status: "open", created_at: at(6), author: user("a") },
    ];
    const fact = await prFact(prClient(pulls, { reviewers: { "2": { status: 503, json: null, bodyText: "down" } } }));
    expect(fact.status).toBe("bad");
    expect(fact.value).toMatchObject({ reason: "bad-channel" });
  });

  test("403 на выборке — no-data access; 403 на списке PR — тоже no-data access", async () => {
    const pulls = [{ slug: "1", status: "open", created_at: at(5), author: user("a") }];
    const denied: ScResponse = { status: 403, json: null, bodyText: "" };
    expect((await prFact(prClient(pulls, { comments: { "1": denied } }))).value).toMatchObject({ reason: "access" });
    const onList = await prFact(prClient(denied));
    expect({ status: onList.status, reason: (onList.value as { reason: string }).reason }).toEqual({ status: "no-data", reason: "access" });
  });
});

// ---------------------------------------------------------------------------

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows EBUSY — уборка tmp не влияет на результат */
    }
  }
});

interface Commit {
  name: string;
  email: string;
  date: string;
  files: Record<string, string>;
}

function gitIn(cwd: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

async function ownershipOf(commits: Commit[], extra?: (src: string) => void): Promise<Fact> {
  const src = mkdtempSync(join(tmpdir(), "rh-w4-src-"));
  const work = mkdtempSync(join(tmpdir(), "rh-w4-work-"));
  tmp.push(src, work);
  gitIn(src, ["init", "-q", "-b", "main"]);
  for (const c of commits) {
    for (const [path, body] of Object.entries(c.files)) {
      mkdirSync(join(src, path, ".."), { recursive: true });
      writeFileSync(join(src, path), body);
    }
    gitIn(src, ["add", "-A"]);
    const env = { GIT_AUTHOR_NAME: c.name, GIT_AUTHOR_EMAIL: c.email, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: c.date };
    gitIn(src, ["-c", `user.name=${c.name}`, "-c", `user.email=${c.email}`, "commit", "-q", "--allow-empty", "-m", "c"], env);
  }
  extra?.(src);
  const out = await cloneBare(`file://${src}`, work, { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 });
  if (!out.ok) throw new Error(out.detail);
  try {
    const facts = await extractFacts(out.dir, { maxBlameFiles: 10, textCapBytes: 1_000_000, now: NOW });
    return facts.find((f) => f.key === "code.ownership")!;
  } finally {
    cleanupClone(out.dir);
  }
}

const day = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

describe("А2: карта владельцев файлов — локальный bare-клон", () => {
  test("доли и авторы по каталогам; робот не владеет; документы и старые коммиты вне окна; email не утекает", async () => {
    const fact = await ownershipOf([
      // старше года — вне окна
      { name: "Old Timer", email: "old@corp.example", date: day(500), files: { "src/a.ts": "a0\n", "lib/x.ts": "x0\n" } },
      { name: "Alice", email: "alice@corp.example", date: day(100), files: { "src/a.ts": "a1\n" } },
      { name: "Alice", email: "alice@corp.example", date: day(90), files: { "src/a.ts": "a2\n", "src/b.ts": "b1\n" } },
      { name: "Bob", email: "bob@corp.example", date: day(80), files: { "src/b.ts": "b2\n" } },
      // документ — не код: README и docs/*.md не считаются
      { name: "Bob", email: "bob@corp.example", date: day(70), files: { "docs/guide.md": "g\n", "README.md": "r\n" } },
      // робот (author-паттерн robot2) — вне карты, даже если он один в каталоге
      { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", date: day(60), files: { "deps/pkg.ts": "p\n", "lib/x.ts": "x1\n" } },
      { name: "Carol", email: "carol@corp.example", date: day(50), files: { "lib/x.ts": "x2\n" } },
      // имя-адрес — маскируется
      { name: "dave@corp.example", email: "dave@corp.example", date: day(40), files: { "main.go": "package main\n" } },
    ]);
    expect(fact.status).toBe("ok");
    expect(fact.source).toBe("git");
    const v = fact.value as Record<string, unknown> & { dirs: { dir: string; changes: number; authors: number; owner: string; owner_share: number }[] };
    expect(v.window_days).toBe(365);
    expect(v.robot_commits_skipped).toBe(1);
    // src: Alice 3 изменения (a, a, b), Bob 1 (b) → 75%, 2 автора
    expect(v.dirs.find((d) => d.dir === "src")).toEqual({ dir: "src", changes: 4, authors: 2, owner: "Alice", owner_share: 0.75 });
    // lib: только Carol (робот исключен) → 100%
    expect(v.dirs.find((d) => d.dir === "lib")).toEqual({ dir: "lib", changes: 1, authors: 1, owner: "Carol", owner_share: 1 });
    // файл в корне — корзина «.»; имя-адрес замаскировано
    expect(v.dirs.find((d) => d.dir === ".")).toEqual({ dir: ".", changes: 1, authors: 1, owner: "(имя не указано)", owner_share: 1 });
    expect(v.dirs.some((d) => d.dir === "deps" || d.dir === "docs")).toBe(false);
    // единственный владелец (≥ 80%): lib (1) + корень (1) из 6 изменений
    expect(v.changes).toBe(6);
    expect(v.single_owner_share).toBe(0.333);
    expect({ total: v.dirs_total, single: v.dirs_single_owner }).toEqual({ total: 3, single: 2 });
    expect(v.commits).toBe(5);
    // приватность: ни одного email в факте
    expect(JSON.stringify(v)).not.toMatch(/@/);
  });

  test("мердж-коммит не считается изменением", async () => {
    const fact = await ownershipOf([{ name: "Alice", email: "alice@corp.example", date: day(30), files: { "src/a.ts": "1\n" } }], (src) => {
      const env = (d: string) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
      gitIn(src, ["checkout", "-q", "-b", "feat"]);
      writeFileSync(join(src, "src", "f.ts"), "f\n");
      gitIn(src, ["add", "-A"]);
      gitIn(src, ["-c", "user.name=Bob", "-c", "user.email=bob@corp.example", "commit", "-q", "-m", "f"], env(day(20)));
      gitIn(src, ["checkout", "-q", "main"]);
      writeFileSync(join(src, "src", "m.ts"), "m\n");
      gitIn(src, ["add", "-A"]);
      gitIn(src, ["-c", "user.name=Alice", "-c", "user.email=alice@corp.example", "commit", "-q", "-m", "m"], env(day(15)));
      gitIn(src, ["-c", "user.name=Merger", "-c", "user.email=merger@corp.example", "merge", "-q", "--no-ff", "-m", "merge", "feat"], env(day(10)));
    });
    const v = fact.value as { commits: number; dirs: { owner: string; changes: number }[] };
    // 3 коммита людей (Alice ×2, Bob), мердж Merger — не в карте
    expect(v.commits).toBe(3);
    expect(v.dirs.map((d) => d.owner)).not.toContain("Merger");
    expect(v.dirs[0]!.changes).toBe(3);
  });

  test("изменений кода за год нет — данные (changes 0, доля null), показ словами", async () => {
    const fact = await ownershipOf([{ name: "Alice", email: "alice@corp.example", date: day(400), files: { "src/a.ts": "1\n" } }]);
    expect(fact.status).toBe("ok");
    expect(fact.value).toMatchObject({ changes: 0, single_owner_share: null, dirs: [] });
    expect(formatSubmetricValue("code", "ownership", { ...(fact.value as object), codeowners: null }, CTX)).toBe("изменений кода за год нет");
  });
});

describe("А2: бюджет обхода и обрезка на крупных репо — с пометкой в факте", () => {
  const commit = (i: number, paths: string[], name = "A", email = "a@x.example"): OwnershipCommit => ({ sha: `s${i}`, name, email, authorDate: day(1 + (i % 300)), paths });

  test("изменений больше OWNERSHIP_MAX_CHANGES — обрезка «changes»", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `src/f${i}.ts`);
    const commits = Array.from({ length: Math.ceil(OWNERSHIP_MAX_CHANGES / 1000) + 5 }, (_, i) => commit(i, paths));
    const v = aggregateOwnership(commits, { now: NOW, excluded: new Set() });
    expect(v.changes).toBe(OWNERSHIP_MAX_CHANGES);
    expect(v.truncated).toBe("changes");
    expect(String(v.truncated_note)).toContain(String(OWNERSHIP_MAX_CHANGES));
  });

  test("коммитов больше OWNERSHIP_MAX_COMMITS — обрезка «commits»; деградационный клон — history_since", () => {
    const v = aggregateOwnership([commit(1, ["src/a.ts"])], { now: NOW, excluded: new Set(), commitsTruncated: true, historyTruncatedSince: day(100) });
    expect(v.truncated).toBe("commits");
    expect(String(v.truncated_note)).toContain(String(OWNERSHIP_MAX_COMMITS));
    expect(v.history_since).toBe(day(100));
    // отсечение раньше окна года — окно не пострадало, пометки нет
    expect(aggregateOwnership([commit(1, ["src/a.ts"])], { now: NOW, excluded: new Set(), historyTruncatedSince: day(400) }).history_since).toBeUndefined();
  });

  test("не больше 10 каталогов в карте, итог — по всем", () => {
    const commits = Array.from({ length: 14 }, (_, i) => commit(i, [`d${i}/a.ts`]));
    const v = aggregateOwnership(commits, { now: NOW, excluded: new Set() }) as { dirs: unknown[]; dirs_total: number; single_owner_share: number };
    expect(v.dirs.length).toBe(10);
    expect(v.dirs_total).toBe(14);
    expect(v.single_owner_share).toBe(1);
  });

  test("робот по sha (robot2) исключен; разбор лога с путями в кавычках", () => {
    const log = "\x1es1\x1fA\x1fa@x.example\x1f2026-09-01T00:00:00Z\n\nsrc/a.ts\n\"src/with \\\"q\\\".ts\"\n\x1es2\x1fBot\x1fbot@x.example\x1f2026-09-02T00:00:00Z\n\nsrc/a.ts\n";
    const commits = parseOwnershipLog(log);
    expect(commits.map((c) => c.paths)).toEqual([["src/a.ts", 'src/with "q".ts'], ["src/a.ts"]]);
    const v = aggregateOwnership(commits, { now: NOW, excluded: new Set(["s2"]) }) as { dirs: { owner: string; changes: number }[]; robot_commits_skipped: number };
    expect(v.robot_commits_skipped).toBe(1);
    expect(v.dirs).toEqual([{ dir: "src", changes: 2, authors: 1, owner: "A", owner_share: 1 } as never]);
  });

  test("имя автора без email: адрес в имени маскируется, пустое — словами", () => {
    expect(displayAuthorName("Ivan Petrov <ivan@corp.example>")).toBe("Ivan Petrov");
    expect(displayAuthorName("ivan@corp.example")).toBe("(имя не указано)");
    expect(displayAuthorName("  ")).toBe("(имя не указано)");
  });
});

// ---------------------------------------------------------------------------

const CTX = submetricContext(NOW.toISOString());
function withKinds(patch: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) m.set(k, v);
  return m;
}
const score = (ok: Map<string, unknown>, displayMissing?: Record<string, string>): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0, displayMissing }, NOW);

const PR_VALUE = {
  pulls: 5,
  statuses: { draft: 1, open: 2, merging: 0, merged: 1, discarded: 1, unknown: 0 },
  sampled: 4,
  answered: 2,
  median_first_response_hours: 3,
  open_sampled: 2,
  waiting_over_threshold: 1,
  threshold_hours: 72,
  review_comments_total: 3,
  median_review_comments: 0.5,
  comments_capped: 0,
  appsec_comments: 1,
  decisions: { approve: 1, trust: 0, block: 0, abstain: 1, pending: 1, unknown: 0 },
  merged: 1,
  median_merge_hours: 50,
  merge_time_basis: "updated_at",
  requests: 8,
};
const OWN_VALUE = {
  window_days: 365,
  threshold: 0.8,
  commits: 5,
  robot_commits_skipped: 1,
  changes: 6,
  single_owner_share: 0.333,
  dirs_total: 3,
  dirs_single_owner: 2,
  dirs: [
    { dir: "src", changes: 4, authors: 2, owner: "Alice", owner_share: 0.75 },
    { dir: "lib", changes: 1, authors: 1, owner: "Carol", owner_share: 1 },
    { dir: ".", changes: 1, authors: 1, owner: "Dave", owner_share: 1 },
  ],
};

describe("мутационный инвариант (§2 тур 2 п.3, правило 24.09): справочные факты не меняют оценку", () => {
  test("индекс, полный Score, покрытие и баллы категорий — те же с новыми фактами и без", () => {
    const base = score(withKinds({}));
    for (const extra of [
      { "activity.pr_review": PR_VALUE, "code.ownership": OWN_VALUE },
      { "activity.pr_review": { ...PR_VALUE, waiting_over_threshold: 2, median_first_response_hours: 900 }, "code.ownership": { ...OWN_VALUE, single_owner_share: 1 } },
      { "activity.pr_review": { pulls: 0, sampled: 0 } },
    ]) {
      const s = score(withKinds(extra));
      expect({ i: s.healthcraftIndex, f: s.repoHealthScore, ic: s.indexCoverage, fc: s.repoHealthCoverage }).toEqual({
        i: base.healthcraftIndex,
        f: base.repoHealthScore,
        ic: base.indexCoverage,
        fc: base.repoHealthCoverage,
      });
      for (const [k, c] of Object.entries(s.categories)) expect({ k, score: c.score }).toEqual({ k, score: base.categories[k as keyof typeof base.categories].score });
    }
    // и без данных (факт bad) — оценка та же
    const missing = score(withKinds({}), { "activity.pr_review": "bad-channel", "code.ownership": "bad-channel" });
    expect(missing.healthcraftIndex).toBe(base.healthcraftIndex);
  });

  test("новые строки — справочные: балл null, в DISPLAY_ONLY, в словаре подметрик", () => {
    const s = score(withKinds({ "activity.pr_review": PR_VALUE, "code.ownership": OWN_VALUE }));
    const rows = [
      ["activity", "pr_first_response"],
      ["activity", "pr_waiting"],
      ["activity", "pr_review_comments"],
      ["activity", "pr_merge_time"],
      ["code", "ownership"],
    ] as const;
    for (const [cat, sub] of rows) {
      const entry = (s.categories[cat].submetrics as Record<string, { score: unknown }>)[sub];
      expect({ cat, sub, score: entry?.score, display: displayOnly(cat, sub), dict: `${cat}.${sub}` in SUBMETRICS }).toEqual({ cat, sub, score: null, display: true, dict: true });
    }
    expect(displayOnly("activity", "pr_review")).toBe(true);
  });

  test("показ значений: часы и дни, «1 из 2 открытых», доля у единственного владельца", () => {
    const s = score(withKinds({ "activity.pr_review": PR_VALUE, "code.ownership": OWN_VALUE }));
    const a = s.categories.activity.submetrics;
    expect(submetricShownValue("activity", "pr_first_response", a.pr_first_response!, CTX)).toBe("3 ч");
    expect(submetricShownValue("activity", "pr_waiting", a.pr_waiting!, CTX)).toBe("1 из 2 открытых");
    expect(submetricShownValue("activity", "pr_review_comments", a.pr_review_comments!, CTX)).toBe("0,5");
    expect(submetricShownValue("activity", "pr_merge_time", a.pr_merge_time!, CTX)).toBe("2,1 дня");
    expect(submetricShownValue("code", "ownership", s.categories.code.submetrics.ownership!, CTX)).toBe("33% изменений за год");
    // порог в названии совпадает с константой
    expect(SUBMETRICS["activity.pr_waiting"]!.title).toContain(`${PR_BOTTLENECK_H / 24} дней`);
    // ни одного ответа — словами, а не «—»
    const none = score(withKinds({ "activity.pr_review": { ...PR_VALUE, answered: 0, median_first_response_hours: null, merged: 0, median_merge_hours: null } })).categories.activity.submetrics;
    expect(submetricShownValue("activity", "pr_first_response", none.pr_first_response!, CTX)).toBe("ответов ревьюеров нет");
    // UX 17.10: «слитых PR нет» → «слитых предложений изменений нет»
    expect(submetricShownValue("activity", "pr_merge_time", none.pr_merge_time!, CTX)).toBe("слитых предложений изменений нет");
  });

  test("рекомендации те же: новые факты правил не порождают и эффекты не меняют", () => {
    const t = makeDb();
    try {
      const plain = seedScan(t, healthyFacts());
      const withNew = seedScan(t, [...healthyFacts(), { key: "activity.pr_review", value: { ...PR_VALUE, waiting_over_threshold: 2 } }, { key: "code.ownership", value: { ...OWN_VALUE, single_owner_share: 1 } }]);
      const pick = (id: number) => recommend(t.db, id, { now: NOW }).map((r) => [r.ruleId, r.deltaScore, r.expectedImpact]);
      expect(pick(withNew)).toEqual(pick(plain));
    } finally {
      t.close();
    }
  });

  test("пригодность скана не зависит от справочных фактов (bad, no-data или их нет)", () => {
    const base = healthyFacts().map((f) => ({ key: f.key, status: "ok", source: f.key.startsWith("issues") || f.key === "activity.rest" || f.key === "cicd.runs" ? "rest:x" : "git", value: f.value }));
    const scan = { status: "partial", userId: 7 };
    expect(ratingEligible(base, scan)).toBe(true);
    expect(
      ratingEligible(
        [...base, { key: "activity.pr_review", status: "bad", source: "rest:pulls", value: { reason: "bad-channel" } }, { key: "code.ownership", status: "bad", source: "git", value: { reason: "bad-channel" } }],
        scan,
      ),
    ).toBe(true);
  });

  test("факт не ok — строка «нет данных» с причиной, без подстановки из прошлого скана", () => {
    const t = makeDb();
    try {
      seedScan(t, [...healthyFacts(), { key: "activity.pr_review", value: PR_VALUE }], 5, t.repoId);
      const failed = seedScan(t, [...healthyFacts(), { key: "activity.pr_review", value: { reason: "bad-channel" }, status: "bad" }, { key: "code.ownership", value: { reason: "access" }, status: "no-data" }], 0, t.repoId);
      const s = recomputeFromDb(t, failed);
      const row = s.categories.activity.submetrics.pr_review!;
      expect(row.value).toBeNull();
      expect(submetricShownValue("activity", "pr_review", row, CTX)).toBe("нет данных: источник не ответил");
      expect(s.categories.activity.submetrics.pr_first_response).toBeUndefined();
      expect(submetricShownValue("code", "ownership", s.categories.code.submetrics.ownership!, CTX)).toBe("нет данных: история не прочитана");
    } finally {
      t.close();
    }
  });

  test("скан прежнего сборщика (фактов нет) — строк нет вовсе", () => {
    const s = score(withKinds({}));
    expect(Object.keys(s.categories.activity.submetrics).some((k) => k.startsWith("pr_"))).toBe(false);
    expect("ownership" in s.categories.code.submetrics).toBe(false);
  });
});

/** compute читает факты скана из БД (effectiveFacts + displayMissing). */
function recomputeFromDb(t: ReturnType<typeof makeDb>, scanId: number): Scores {
  return compute(t.db, scanId, { now: NOW });
}

// ---------------------------------------------------------------------------

function seedAnalytics(visibility: string, ownValue: unknown = OWN_VALUE) {
  const t = makeApiDb();
  const repoId = seedRepo(t, { org: "w4", repo: "r", title: "W4", language: "Go", likes: 1, forks: 0, lastActivityAt: "2026-09-15T00:00:00Z" });
  t.db.query("UPDATE repos SET visibility = ?, rating_active = 1 WHERE id = ?").run(visibility, repoId);
  const facts = [
    ...cardFacts().filter((f) => f.status !== "no-data"),
    { key: "activity.pr_review", source: "rest:pulls", value: PR_VALUE },
    { key: "code.ownership", source: "git", value: ownValue },
  ];
  scoredScan(t, repoId, { status: "ok", trigger: "user", facts });
  return t;
}

const GRANTED = { cicd: "granted", appsec: "granted", repo: "granted" } as const;
const NO_PAT = { cicd: "no-pat", appsec: "no-pat", repo: "no-pat" } as const;

describe("права и отрисованный MD", () => {
  test.each(["private", "internal"])("%s: без прав карточка (и новые показатели) не раскрывается; с правами — есть", (visibility) => {
    const t = seedAnalytics(visibility);
    try {
      expect(getRepoCard(t.db, "w4", "r", { access: { ...NO_PAT }, viewerAuth: "no-session" })).toBeNull();
      expect(getRepoCard(t.db, "w4", "r", { access: { cicd: "denied", appsec: "denied", repo: "denied" }, viewerAuth: "pat" })).toBeNull();
      const card = getRepoCard(t.db, "w4", "r", { access: { ...GRANTED }, viewerAuth: "pat" })!;
      expect(card.score!.categories.activity.submetrics.pr_waiting).toBeDefined();
      expect(card.score!.categories.code.submetrics.ownership).toBeDefined();
    } finally {
      t.close();
    }
  });

  test("публичный: видно всем, как остальная Активность; email не утекает ни в карточку, ни в MD", () => {
    const t = seedAnalytics("public", { ...OWN_VALUE, dirs: [{ dir: "src", changes: 4, authors: 2, owner: "Alice", owner_share: 0.75 }] });
    try {
      const card = getRepoCard(t.db, "w4", "r", { access: { ...NO_PAT }, viewerAuth: "no-session" })!;
      expect(card.score!.categories.activity.submetrics.pr_first_response).toBeDefined();
      const md = renderRepoReport(card);
      // строки справочного показателя — в «Справочно»; карта — таблицей под «Состоянием кода»
      // UX 17.10: названия показателей — «предложение изменений» вместо «PR»
      expect(md).toContain("Время до первого ответа на предложение изменений – 3 ч");
      expect(md).toContain("Предложения изменений без ответа дольше 3 дней – 1 из 2 открытых");
      expect(md).toContain("Изменения у единственного владельца – 33% изменений за год");
      expect(md).toContain("Карта владельцев файлов (справочно, в балл не входит)");
      expect(md).toContain("| Каталог | Главный автор | Доля главного автора | Авторов |");
      expect(md).toContain("| src | Alice | 75% | 2 |");
      expect(md).toContain("Время до слияния предложения изменений приблизительное");
      // CODEOWNERS рядом с картой (cardFacts: codeowners false)
      expect(md).toMatch(/CODEOWNERS в репозитории нет\.|В репозитории есть CODEOWNERS\./);
      expect(JSON.stringify(card.score)).not.toContain("@");
      expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      // язык UI: без «ё» и длинного тире в новых текстах (кроме глифа «нет данных»)
      const own = md.slice(md.indexOf("Карта владельцев файлов"), md.indexOf("Карта владельцев файлов") + 900);
      expect(own).not.toMatch(/[ёЁ]/);
      expect(own).not.toContain("—");
      // основание «Активности» — не оговорка справочного показателя
      expect(md).not.toMatch(/\| Активность \|[^\n]*приблизительное/);
    } finally {
      t.close();
    }
  });

  test("крайний случай верстки: имя каталога в 90 символов — MD-таблица цела, в PDF нет неразрывного куска длиннее порога", () => {
    const long = `${"very-long-directory-name-".repeat(3)}${"x".repeat(15)}`;
    expect(long.length).toBe(90);
    const longOwner = `Author_${"y".repeat(83)}`;
    const t = seedAnalytics("public", { ...OWN_VALUE, dirs: [{ dir: long, changes: 4, authors: 2, owner: longOwner, owner_share: 0.9 }] });
    try {
      const card = getRepoCard(t.db, "w4", "r", { access: { ...NO_PAT }, viewerAuth: "no-session" })!;
      const md = renderRepoReport(card);
      const row = md.split("\n").find((l) => l.includes(long))!;
      expect(row).toBeDefined();
      expect(row.startsWith("| ") && row.endsWith(" |")).toBe(true);
      expect(row.split(" | ").length).toBe(4);
      expect(row).toContain("90%, единственный");
      // PDF: ячейки карты переносятся (breakable) — ни одного куска длиннее MAX_UNBROKEN
      const doc = buildPdfDocument(buildReportModel(card));
      const texts: string[] = [];
      const collect = (node: unknown): void => {
        if (typeof node === "string") texts.push(node);
        else if (Array.isArray(node)) node.forEach(collect);
        else if (node && typeof node === "object") {
          const o = node as Record<string, unknown>;
          if ("text" in o) collect(o.text);
          for (const k of ["stack", "columns"]) if (k in o) collect(o[k]);
          if ("table" in o) collect((o.table as { body: unknown }).body);
        }
      };
      let found = false;
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!node || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if ("table" in o) {
          for (const r of (o.table as { body: unknown[][] }).body.slice(1)) {
            for (const cell of r) {
              texts.length = 0;
              collect(cell);
              const joined = texts.join(" ");
              if (joined.replaceAll(BREAK, "").includes(long)) found = true;
              const longest = Math.max(0, ...joined.split(new RegExp(`[\\s${BREAK}]+`)).map((w) => w.length));
              expect(longest).toBeLessThanOrEqual(MAX_UNBROKEN);
            }
          }
        }
        for (const k of ["stack", "columns"]) if (k in o) visit(o[k]);
      };
      visit(doc.content);
      expect(found).toBe(true);
    } finally {
      t.close();
    }
  });

  test("ownershipView: одна сборка строк для карточки и отчета; нет карты — null", () => {
    const view = ownershipView({ score: 80, submetrics: { ownership: { score: null, value: { ...OWN_VALUE, codeowners: true } } } } as never)!;
    expect(view.rows.map((r) => [r.dir, r.owner, r.share, r.authors, r.single])).toEqual([
      ["src", "Alice", "75%", "2", false],
      ["lib", "Carol", "100%", "1", true],
      ["(файлы в корне)", "Dave", "100%", "1", true],
    ]);
    expect(view.notes[0]).toBe(
      "Единственный владелец – у 2 из 3 каталогов: главный автор сделал не меньше 80% изменений каталога. Изменение – коммит человека за 365 дней без слияний, тронувший файл кода; коммиты роботов не учитываются.",
    );
    expect(view.notes).toContain("В репозитории есть CODEOWNERS.");
    expect(ownershipView({ score: 80, submetrics: {} } as never)).toBeNull();
    expect(ownershipView({ score: 80, submetrics: { ownership: { score: null, value: { ...OWN_VALUE, changes: 0, dirs: [] } } } } as never)).toBeNull();
  });
});

describe("исходник: aggregatePrReview — чистая функция (тот же ответ без сети)", () => {
  test("пустая выборка: медианы null, счетчики 0", () => {
    const v = aggregatePrReview([], [], NOW, 0);
    expect(v).toMatchObject({ pulls: 0, sampled: 0, answered: 0, median_first_response_hours: null, median_review_comments: null, merged: 0, median_merge_hours: null });
  });
});
