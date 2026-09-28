// Правки модели и сборщика по аудиту методики. Каждый пункт – поведенческий
// тест на данных: локальный git (сборщик), фейковые REST/AppSec, чистый расчет,
// временная БД карточки.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../src/collectors/facts";
import { cleanupClone, cloneBare, extractFacts, todoMarkerKind } from "../src/collectors/git";
import { isTestPath } from "../src/collectors/source-path";
import { collectRestFacts } from "../src/collectors/rest";
import { DEFECT_GROUP_STATUS_ORDER, defectGroupStatusClass, defectGroupStatusName } from "../src/collectors/appsec";
import type { ScClient, ScResponse } from "../src/collectors/http";
import { RECOLLECT_PER_WAVE_DEFAULT, recollectPerWave } from "../src/jobs/scheduler";
import { computeFromFacts, TESTS_BONUS_IDLE_NOTE, TESTS_NONE_NOTE, type Scores } from "../src/score/compute";
import { appsecFixEffect, recommendFromFacts, recommendationText, type DeltaEvaluator, type Recommendation } from "../src/score/recommend";
import { robot2Flags } from "../src/score/robot2";
import { CODE_FULL_LOC, CODE_NEUTRAL, SUBWEIGHTS, TEST_SHARE, anchorScore } from "../src/score/model";
import { noDataReason } from "../src/web/format";
import { adjustmentText, whyText } from "../src/report/sections";
import { submetricContext, submetricShownValue } from "../src/report/submetrics";
import { renderRepoReport } from "../src/report/markdown";
import { getRepoCard } from "../src/api/repos";
import { cardFacts, makeApiDb, seedRepo, type FactSpec } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";
import { NOW, healthyFacts } from "./score-fixtures";

const DAY = 24 * 3600_000;
const iso = (t: number): string => new Date(t).toISOString();
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

// ---------- общие помощники ----------

type Patch = Record<string, unknown | undefined>;
function facts(patch: Patch = {}): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}
const score = (ok: Map<string, unknown>): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0 }, NOW);
const tree = (over: Record<string, unknown> = {}) => ({ top_level: [{ name: "src", type: "tree" }], file_count: 60, bytes: 90_000, loc: 5000, source_files: 40, source_loc: 4000, test_files: 0, ...over });
/** Пометки техдолга: плотность 10 на 1 тыс. строк при 4000 строк, половина старых — «Код» заметно ниже 100. */
const badTodo = { count: 40, fixme: 0, older_180d: 20, todo_files: 10, blamed_files: 10 };
const ctx = submetricContext(NOW.toISOString());
const ids = (recs: Recommendation[]) => recs.map((r) => r.ruleId);
const realDelta = (ok: Map<string, unknown>): DeltaEvaluator => (channel, patch) => {
  const b = score(ok);
  const f = new Map(ok);
  patch(f);
  const a = score(f);
  const pick = (s: Scores) => (channel === null ? s.healthcraftIndex : s.repoHealthScore);
  return { delta: Math.round((pick(a)! - pick(b)!) * 10000) / 10000, reason: null };
};
const recs = (ok: Map<string, unknown>) => {
  const s = score(ok);
  return recommendFromFacts(ok, { delta: realDelta(ok), issuesScore: s.categories.issues.score, categoryScores: Object.fromEntries(Object.entries(s.categories).map(([k, c]) => [k, c.score])) });
};

// ---------- локальный git (сборщик) ----------

const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const EXTRACT = { maxBlameFiles: 200, textCapBytes: 1_000_000 };

function git(cwd: string, args: string[]) {
  const date = "2026-01-01T00:00:00+00:00";
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function factsOf(files: Record<string, string | Uint8Array>): Promise<Map<string, Record<string, unknown>>> {
  const src = mkdtempSync(join(tmpdir(), "rh-v53m2-src-"));
  tmp.push(src);
  git(src, ["init", "-q", "-b", "main"]);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), body);
  }
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "init"]);
  const work = mkdtempSync(join(tmpdir(), "rh-v53m2-work-"));
  tmp.push(work);
  const out = await cloneBare(`file://${src}`, work, { ...LIMITS });
  if (!out.ok) throw new Error(out.detail);
  try {
    const list: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
    return new Map(list.map((f) => [f.key, f.value as Record<string, unknown>]));
  } finally {
    cleanupClone(out.dir);
  }
}

// ---------- маркер техдолга – первым словом комментария ----------

describe("К1: маркер техдолга — первое слово комментария", () => {
  test("К1: не маркер — `#todo-list {`, `i < todo.length;`, `printf(\"%d todo\")`, `// update the todo list`", () => {
    for (const line of [
      "#todo-list {",
      "  #todo-list { color: red }",
      "#todo:hover {",
      "for (let i = 0; i < todo.length; i++) {",
      'printf("%d todo", n);',
      "// update the todo list",
      "i--; todo.push(x)",
      "--todo-color: red;",
      "x = 1  # todo here",
      "const url = 'http://todo.example'; ",
      "  * @param todo the item",
      "SELECT 1; -- todo later",
    ]) {
      expect({ line, kind: todoMarkerKind(line) }).toEqual({ line, kind: null });
    }
  });

  test("К1: маркер — `// todo: x`, `# FIXME(bob)`, `-- TODO fix`, `/* @todo */`, `<!-- TODO -->` и продолжения", () => {
    const cases: [string, "TODO" | "FIXME"][] = [
      ["// todo: x", "TODO"],
      ["# FIXME(bob)", "FIXME"],
      ["-- TODO fix", "TODO"],
      ["/* @todo */", "TODO"],
      ["<!-- TODO -->", "TODO"],
      ["const a = 1; // TODO: remove", "TODO"],
      ["#TODO: python style", "TODO"],
      ["    ## todo", "TODO"],
      [";; XXX lisp", "FIXME"],
      ["% HACK matlab", "FIXME"],
      ["' TODO vb", "TODO"],
      [" * TODO: continue block", "TODO"],
      ["REM todo batch", "TODO"],
      ["/// TODO docs", "TODO"],
      ["/** FIXME */", "FIXME"],
      ["// TODO - later", "TODO"],
      ["// todo!", "TODO"],
      ["// TODO", "TODO"],
    ];
    for (const [line, kind] of cases) expect({ line, kind: todoMarkerKind(line) }).toEqual({ line, kind });
  });

  test("К1: сборщик — todo-приложение без пометок не получает техдолг", async () => {
    const f = await factsOf({
      "src/app.js": "const todo = todos[i]; todo.done = true;\nfor (let i = 0; i < todo.length; i++) {}\n// render todo list\ndocument.querySelector('#todo-list');\n",
      "src/app.css": "#todo-list {\n  --todo-color: red;\n}\n#todo:hover { color: blue }\n",
      "src/real.py": "# TODO: real marker\nx = 1\n",
    });
    const todo = f.get("code.todo")!;
    expect(todo.count).toBe(1);
    expect(todo.fixme).toBe(0);
  });
});

// ---------- файл тестов – только непустой; данные тестов – не тесты ----------

describe("К2: файлы тестов", () => {
  test("К2: fixtures/, testdata/, __snapshots__/, mocks/, data/ внутри тестов — не тесты", () => {
    for (const p of ["tests/fixtures/big.json", "tests/fixtures/a.py", "test/testdata/x.go", "src/__tests__/__snapshots__/a.snap", "tests/mocks/api.ts", "spec/data/rows.csv"]) {
      expect({ p, test: isTestPath(p) }).toEqual({ p, test: false });
    }
    for (const p of ["tests/test_a.py", "src/__tests__/a.test.ts", "spec/models/user_spec.rb"]) expect(isTestPath(p)).toBe(true);
  });

  test("К2: tree.stats.test_files — только непустые файлы тестов (пустые, пробельные, .gitkeep и фикстуры не считаются)", async () => {
    const f = await factsOf({
      "src/main.py": "def main():\n    return 1\n",
      "tests/test_real.py": "def test_main():\n    assert main() == 1\n",
      "tests/test_empty.py": "",
      "tests/test_blank.py": "  \n\n\t\n",
      "tests/.gitkeep": "",
      "tests/fixtures/data.json": '{"rows": [1, 2, 3]}\n',
    });
    const t = f.get("tree.stats")!;
    expect(t.test_files).toBe(1);
  });

  test("К2: совет add-tests — «Код» оценен, тестов нет; Δ = реальный пересчет с тестами в 10% файлов", () => {
    const ok = facts({ "tree.stats": tree(), "code.todo": badTodo });
    const all = recs(ok);
    const rec = all.find((r) => r.ruleId === "add-tests")!;
    expect(rec).toBeDefined();
    expect(rec.action).toBe("Добавьте тесты");
    const patched = new Map(ok);
    patched.set("tree.stats", tree({ test_files: 4 }));
    const expected = Math.round((score(patched).healthcraftIndex! - score(ok).healthcraftIndex!) * 10000) / 10000;
    expect(rec.deltaScore).toBe(expected);
    expect(rec.deltaScore!).toBeGreaterThan(0);
    // тесты есть — совета нет; факты до сборщика 3 (поля нет) — совета нет
    expect(ids(recs(facts({ "tree.stats": tree({ test_files: 5 }), "code.todo": badTodo })))).not.toContain("add-tests");
    const legacy = { ...tree() } as Record<string, unknown>;
    delete legacy.test_files;
    expect(ids(recs(facts({ "tree.stats": legacy, "code.todo": badTodo })))).not.toContain("add-tests");
  });

  test("К2: add-tests не обещает «+0» — бонус при 10% тестов не поднимает чистый «Код 100»", () => {
    const clean = facts({ "tree.stats": tree(), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } });
    expect(score(clean).categories.code.score).toBe(100);
    expect(ids(recs(clean))).not.toContain("add-tests");
  });
});

// ---------- «Тесты» – бонус ----------

describe("В1: «Тесты» — бонус", () => {
  test("В1: у репо без тестов «Код» на фактах сборщика 3 и на старых фактах одинаков", () => {
    const legacyTree = { ...tree() } as Record<string, unknown>;
    delete legacyTree.test_files;
    for (const todo of [badTodo, { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 }]) {
      const v3 = score(facts({ "tree.stats": tree({ test_files: 0 }), "code.todo": todo }));
      const old = score(facts({ "tree.stats": legacyTree, "code.todo": todo }));
      expect(v3.categories.code.score).toBe(old.categories.code.score);
      expect(v3.healthcraftIndex).toBe(old.healthcraftIndex);
    }
  });

  test("В1: тестов нет — подметрика вне расчета, показ «тестов нет – в балл не входит»", () => {
    const s = score(facts({ "tree.stats": tree({ test_files: 0 }), "code.todo": badTodo }));
    const entry = s.categories.code.submetrics.tests!;
    expect(entry.score).toBeNull();
    expect(entry.note).toBe(TESTS_NONE_NOTE);
    expect(submetricShownValue("code", "tests", entry, ctx)).toBe("тестов нет – в балл не входит");
  });

  test("В1: тесты поднимают «Код» с весом 0,3 по анкерам круга 1", () => {
    const none = score(facts({ "tree.stats": tree({ test_files: 0 }), "code.todo": badTodo })).categories.code;
    const some = score(facts({ "tree.stats": tree({ test_files: 8 }), "code.todo": badTodo })).categories.code; // 20% файлов
    expect(SUBWEIGHTS.code.tests).toBe(0.3);
    expect(some.submetrics.tests!.score).toBeCloseTo(anchorScore(TEST_SHARE, 0.2), 12);
    const w = SUBWEIGHTS.code;
    const d = some.submetrics.density!.score!;
    const o = some.submetrics.old_share!.score!;
    const r = some.submetrics.root!.score!;
    const expected = ((w.density * d + w.old_share * o + w.tests * anchorScore(TEST_SHARE, 0.2) + w.root * r) / (w.density + w.old_share + w.tests + w.root)) * 100;
    expect(some.score!).toBeCloseTo(expected, 9);
    expect(some.score!).toBeGreaterThan(none.score!);
  });

  test("В1: первый непустой тест не снижает «Код» — бонус, который опустил бы балл, не применяется", () => {
    const clean = { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 };
    const none = score(facts({ "tree.stats": tree({ test_files: 0 }), "code.todo": clean }));
    const one = score(facts({ "tree.stats": tree({ test_files: 1, source_files: 41, source_loc: 4010 }), "code.todo": clean }));
    expect(one.categories.code.score!).toBeGreaterThanOrEqual(none.categories.code.score!);
    expect(one.healthcraftIndex!).toBeGreaterThanOrEqual(none.healthcraftIndex!);
    const entry = one.categories.code.submetrics.tests!;
    expect(entry.score).toBeNull();
    expect(entry.note).toBe(TESTS_BONUS_IDLE_NOTE);
    expect(submetricShownValue("code", "tests", entry, ctx)).toBe("2% (в балл не входит: доля тестов учитывается, только когда повышает балл)");
  });
});

// ---------- сжатие малого кода к 50 ----------

describe("В3: плавное сжатие малого кода", () => {
  test("В3: Код = 50 + (сырой − 50) × min(1, строк/200); поправка — поле adjustment", () => {
    expect([CODE_FULL_LOC, CODE_NEUTRAL]).toEqual([200, 50]);
    const full = score(facts({ "tree.stats": tree({ source_loc: 400 }), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } })).categories.code;
    expect(full.score).toBe(100);
    expect(full.adjustment).toBeUndefined();
    for (const loc of [1, 30, 120, 199]) {
      const cat = score(facts({ "tree.stats": tree({ source_loc: loc }), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } })).categories.code;
      expect(cat.score!).toBeCloseTo(50 + (100 - 50) * (loc / 200), 9);
      expect(cat.adjustment).toEqual({ kind: "small-code", loc, full: 200, raw: 100, center: 50 });
    }
    // сжатие только вниз: сырой ниже 50 к 50 НЕ подтягивается – поправки нет,
    // балл = сырой
    const bad = score(facts({ "tree.stats": tree({ source_loc: 100 }), "code.todo": { count: 20, fixme: 0, older_180d: 20, todo_files: 1, blamed_files: 1 } })).categories.code;
    expect(bad.adjustment).toBeUndefined();
    expect(bad.score!).toBeLessThan(50);
  });

  test("В3 (G1): ступени на 50-й строке нет; «мало кода» больше не причина «нет данных»", () => {
    const at = (loc: number) => score(facts({ "tree.stats": tree({ source_loc: loc }), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } }));
    expect(at(50).categories.code.score! - at(49).categories.code.score!).toBeCloseTo(0.25, 9);
    expect(at(49).categories.code.no_data).toBeUndefined();
    // «кода нет» (0 строк) — по-прежнему итог 0
    const empty = score(facts({ "tree.stats": tree({ source_files: 1, source_loc: 0 }) }));
    expect(empty.codeEmpty).toBe(true);
    expect(empty.healthcraftIndex).toBe(0);
  });

  test("В3: текст «Мало кода: N строк из 200 – балл сжат к 50» — первая причина «почему»", () => {
    const cat = score(facts({ "tree.stats": tree({ source_loc: 30 }), "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } })).categories.code;
    expect(adjustmentText(cat)).toBe("Мало кода: 30 из 200 строк для надежной оценки – балл снижен с 100 до 57,5, ближе к середине шкалы.");
    expect(whyText("code", { ...cat, weight: 31 }, ctx)).toBe("Мало кода: 30 из 200 строк для надежной оценки – балл снижен с 100 до 57,5, ближе к середине шкалы.");
  });

  test("В3: приложение А — строка сжатия сводит таблицу к «Итого»", () => {
    const t = makeApiDb();
    try {
      const over: FactSpec[] = [
        { key: "tree.stats", source: "git", value: { top_level: [{ name: "src", type: "tree" }, { name: "README.md", type: "blob" }], file_count: 6, bytes: 4000, loc: 120, source_files: 3, source_loc: 30, test_files: 0 } },
        { key: "code.todo", source: "git", value: { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } },
      ];
      const list = cardFacts().filter((f) => !over.some((o) => o.key === f.key)).concat(over);
      const repoId = seedRepo(t, { org: "v53m2", repo: "small-code" });
      scoredScan(t, repoId, { status: "ok", trigger: "user", facts: list });
      const card = getRepoCard(t.db, "v53m2", "small-code", { access: { cicd: "granted", appsec: "granted", repo: "granted" }, viewerAuth: "pat" })!;
      const md = renderRepoReport(card);
      expect(md).toContain("Мало кода: 30 из 200 строк для надежной оценки – балл снижен с 100 до 57,5, ближе к середине шкалы.");
      const row = md.split("\n").find((l) => l.includes("| Мало кода: 30 из 200 строк |"))!;
      expect(row).toBeDefined();
      expect(row).toContain("−42,5");
      expect(md).toContain("тестов нет – в балл не входит");
    } finally {
      t.close();
    }
  });
});

// ---------- код не прочитан ----------

describe("К3: строки кода не прочитаны", () => {
  test("К3: единственный файл кода больше лимита — «строки не прочитаны», а не «кода нет»", async () => {
    const big = "x".repeat(1_100_000) + "\n";
    const f = await factsOf({ "README.md": "# app\n", "index.html": big });
    const t = f.get("tree.stats")!;
    expect(t.source_loc).toBe(0);
    expect(t.source_unread).toBe(1);
    const s = score(facts({ "tree.stats": t, "code.todo": f.get("code.todo") }));
    expect(s.codeEmpty).toBe(false);
    expect(s.categories.code.score).toBeNull();
    expect(noDataReason("code", s.categories.code.no_data)).toContain("Строки кода прочитать не удалось");
    expect(s.healthcraftIndex).not.toBe(0);
  });

  test("К3 + H1 (приемка HQ): бинарный файл — не код («кода нет»), а не «не прочитан»; пустой файл кода — «кода нет»", async () => {
    const bin = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3]);
    const f = await factsOf({ "README.md": "# app\n", "app.apk": bin });
    expect(f.get("tree.stats")!.source_files).toBe(0);
    expect(score(facts({ "tree.stats": f.get("tree.stats") })).codeEmpty).toBe(true);
    // бинарник с «кодовым» именем — тоже не код
    const g = await factsOf({ "README.md": "# app\n", "app.py": bin });
    expect(g.get("tree.stats")!.source_files).toBe(0);
    expect(g.get("tree.stats")!.source_unread).toBe(0);
    expect(score(facts({ "tree.stats": g.get("tree.stats") })).codeEmpty).toBe(true);
    const e = await factsOf({ "README.md": "# app\n", "a.js": "" });
    expect(e.get("tree.stats")!.source_unread).toBe(0);
    expect(score(facts({ "tree.stats": e.get("tree.stats") })).codeEmpty).toBe(true);
  });
});

// ---------- сбой in_progress ----------

const ok200 = (json: unknown): ScResponse => ({ status: 200, json, bodyText: "" });
function restClient(progress: ScResponse | unknown[]): ScClient {
  return {
    async get(p: string): Promise<ScResponse> {
      const base = p.includes("?") ? p.slice(0, p.indexOf("?")) : p;
      if (base === "/repos/o/r") return ok200({ id: "1", name: "r", visibility: "public" });
      if (base === "/repos/o/r/issues" && p.includes("status%3Dopen")) return ok200({ issues: [{ id: "1", slug: "1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }] });
      if (base === "/repos/o/r/issues" && p.includes("status%3Din_progress")) return Array.isArray(progress) ? ok200({ issues: progress }) : progress;
      if (base === "/repos/o/r/issues" && p.includes("status%3Dclosed")) return ok200({ issues: [{ id: "9", slug: "9", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-05T00:00:00Z", completed_at: "2026-01-05T00:00:00Z" }] });
      if (base.includes("/comments")) return ok200({ issue_comments: [] });
      if (base === "/repos/o/r/contributors") return ok200({ contributors: [] });
      if (base === "/repos/o/r/releases") return ok200({ releases: [] });
      if (base === "/repos/o/r/pulls") return ok200({ pull_requests: [] });
      if (base === "/repos/o/r/cicd/runs") return ok200({ runs: [] });
      return { status: 404, json: null, bodyText: "no route" };
    },
    requestCount: () => 0,
  };
}

describe("К4: сбой одного запроса in_progress", () => {
  for (const status of [400, 404, 500, 0]) {
    test(`К4: in_progress → ${status} — факт задач ok по open + closed, пометка in_progress_note`, async () => {
      const out = await collectRestFacts(restClient({ status, json: null, bodyText: "" }), "o/r", { commentsTopN: 0, now: NOW });
      const stats = out.facts.find((f) => f.key === "issues.stats")!;
      expect(stats.status).toBe("ok");
      const v = stats.value as Record<string, unknown>;
      expect({ open: v.open, closed: v.closed, in_progress: v.in_progress }).toEqual({ open: 1, closed: 1, in_progress: null });
      expect(String(v.in_progress_note)).toContain(`status ${status}`);
      expect(out.facts.find((f) => f.key === "issues.comments_sample")!.status).toBe("ok");
      expect(out.channelErrors.some((e) => e.resource === "issues-in-progress")).toBe(true);
    });
  }

  test("К4: in_progress ответил — пометки нет, задачи в работе в открытых", async () => {
    const out = await collectRestFacts(restClient([{ id: "2", slug: "2", created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" }]), "o/r", { commentsTopN: 0, now: NOW });
    const v = out.facts.find((f) => f.key === "issues.stats")!.value as Record<string, unknown>;
    expect(v.open).toBe(2);
    expect(v.in_progress).toBe(1);
    expect("in_progress_note" in v).toBe(false);
  });
});

// ---------- синки по датам автора ----------

describe("К5: зеркала и ребейз — по датам автора", () => {
  const events = (n: number, author: (i: number) => string, authorTs: (i: number) => number, committerTs: (i: number) => number, committer?: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => ({
      sha: `c${i}`,
      author: { name: author(i), email: `${author(i)}@x.io`, date: iso(authorTs(i)) },
      committer: { name: (committer ?? author)(i), email: `${(committer ?? author)(i)}@x.io`, date: iso(committerTs(i)) },
    }));
  const t0 = NOW.getTime() - 3 * DAY;

  test("К5 (G5): ребейз общей ветки двух авторов — не синк, Активность по датам автора", () => {
    const ev = events(12, (i) => (i === 5 ? "dev1" : "dev0"), (i) => NOW.getTime() - (60 - i * 4) * DAY, (i) => t0 + i * 90);
    expect(robot2Flags(ev).flags.every((f) => !f.sync)).toBe(true);
    const s = score(facts({ "activity.git.timeline": { events: ev } }));
    expect(s.categories.activity.submetrics.contributors!.value).toBe(2);
    expect(s.categories.activity.score!).toBeGreaterThan(50);
  });

  test("К5 (G2, Q&A №10): зеркало — коммиты по датам автора, как у оригинала; «нет данных» нет", () => {
    const authorTs = (i: number) => NOW.getTime() - (200 - i * 15) * DAY;
    const original = events(12, (i) => `u${i % 3}`, authorTs, authorTs);
    const mirror = events(12, (i) => `u${i % 3}`, authorTs, (i) => t0 + i * 50, () => "mirror-sync");
    const a = score(facts({ "activity.git.timeline": { events: original } }));
    const b = score(facts({ "activity.git.timeline": { events: mirror } }));
    expect(b.categories.activity.score).not.toBeNull();
    expect(b.categories.activity.score).toBe(a.categories.activity.score);
    expect(b.healthcraftIndex).toBe(a.healthcraftIndex);
  });

  test("К5 (S6a): 1000 коммитов за 1 с с одной author-датой — схлопнуты (Δ индекса ≤ +1)", () => {
    const base = events(5, () => "dev", (i) => NOW.getTime() - (900 + i) * DAY, (i) => NOW.getTime() - (900 + i) * DAY);
    const spam = events(1000, () => "dev", () => NOW.getTime() - DAY, (i) => NOW.getTime() - DAY + i);
    const before = score(facts({ "activity.git.timeline": { events: base } }));
    const after = score(facts({ "activity.git.timeline": { events: [...base, ...spam.map((e, i) => ({ ...e, sha: `s${i}` }))] } }));
    expect(robot2Flags(spam).flags.every((f) => f.sync)).toBe(true);
    expect(after.healthcraftIndex! - before.healthcraftIndex!).toBeLessThanOrEqual(1);
  });

  test("К5 (P1): первый свой коммит в зеркало не снижает индекс — сегодня и в прошлом", () => {
    const authorTs = (i: number) => NOW.getTime() - (700 - i * 20) * DAY;
    for (const [authors, days] of [[3, 0], [3, 200], [1, 0], [5, 400]] as const) {
      const mirror = events(12, (i) => `u${i % authors}`, authorTs, (i) => t0 + i * 50, () => "mirror-sync");
      const before = score(facts({ "activity.git.timeline": { events: mirror } }));
      const mine = { sha: "me", author: { name: "me", email: "me@x.io", date: iso(NOW.getTime() - days * DAY) }, committer: { name: "me", email: "me@x.io", date: iso(NOW.getTime() - days * DAY) } };
      const after = score(facts({ "activity.git.timeline": { events: [...mirror, mine] } }));
      expect({ authors, days, ok: after.healthcraftIndex! >= before.healthcraftIndex! - 1e-9 }).toEqual({ authors, days, ok: true });
    }
  });
});

// ---------- рекомендации по факту ----------

describe("К6: рекомендации", () => {
  test("К6 (E6): reduce-stale-issues — при открытых зависших и 0 засчитанных закрытых", () => {
    const ok = facts({ "issues.stats": { open: 10, closed: 0, closed_instant: 0, closed_counted: 0, median_close_days: null, stale_90d: 8, fetched_count: 10 } });
    expect(ids(recs(ok))).toContain("reduce-stale-issues");
    expect(ids(recs(ok))).not.toContain("speed-up-issue-close");
  });

  const big = tree({ loc: 600_000, source_loc: 500_000 });
  const appsec = (critical: number, high: number, medium = 0, low = 0, resolved = 0.9) => ({ severity_counts: { critical, high, medium, low }, resolved_share: resolved, secrets_critical: false });

  test("К6: appsec-critical при потолке — «снимет потолок 40»; пересчет подтверждает рост", () => {
    const ok = facts({ "tree.stats": big, "appsec.findings": appsec(2, 0) });
    expect(score(ok).categories.security.score).toBe(40);
    expect(appsecFixEffect(ok, "critical")).toEqual({ capLimit: 40, gain: true });
    const rec = recs(ok).find((r) => r.ruleId === "appsec-critical")!;
    // 4.5.0: критичные находки держат и потолок полного итога 69
    expect(rec.expectedImpact).toBe("снимет потолок 40 с категории «Безопасность» и снимет ограничение Repo Health Score в 69 баллов");
    expect(rec.problem).toContain("не выше 40");
  });

  test("К6 (G8а): appsec-critical на полу плотности — роста не обещает", () => {
    const ok = facts({ "tree.stats": tree({ loc: 6000, source_loc: 5575 }), "appsec.findings": appsec(2, 3, 39, 59, 0.09) });
    const eff = appsecFixEffect(ok, "critical");
    expect(eff.capLimit).toBeNull();
    // идеальная правка (critical → 0) категорию не поднимает — и текст этого не обещает
    const fixed = new Map(ok);
    fixed.set("appsec.findings", appsec(0, 3, 39, 59, 0.09));
    expect(score(fixed).categories.security.score).toBe(score(ok).categories.security.score);
    expect(eff.gain).toBe(false);
    const rec = recs(ok).find((r) => r.ruleId === "appsec-critical")!;
    expect(rec.expectedImpact).toBe("снимет ограничение Repo Health Score в 69 баллов; балл категории «Безопасность» от этого не вырастет: его снижают и другие находки");
    expect(rec.expectedImpact).not.toContain("повысит");
  });

  test("К6 (G8б): открытые high без critical — совет appsec-high «снимет потолок 69»", () => {
    const ok = facts({ "tree.stats": big, "appsec.findings": appsec(0, 1) });
    expect(score(ok).categories.security.score).toBe(69);
    const rec = recs(ok).find((r) => r.ruleId === "appsec-high")!;
    expect(rec.action).toBe("Устраните находки AppSec высокой важности");
    expect(rec.expectedImpact).toBe("снимет потолок 69 с категории «Безопасность»");
    expect(rec.channel).toBe("appsec");
    // при critical совет один — appsec-critical
    expect(ids(recs(facts({ "tree.stats": big, "appsec.findings": appsec(1, 1) })))).not.toContain("appsec-high");
  });

  test("К6: appsec-high ниже потолка — «повысит балл», если пересчет дает рост", () => {
    const ok = facts({ "tree.stats": tree({ source_loc: 20_000 }), "appsec.findings": appsec(0, 6, 0, 0, 0.2) });
    const eff = appsecFixEffect(ok, "high");
    expect(eff).toEqual({ capLimit: null, gain: true });
    expect(recommendationText("appsec-high", eff)!.expectedImpact).toBe("повысит балл категории «Безопасность»");
  });
});

// ---------- статус группы AppSec числом ----------

describe("К7: статус группы AppSec числом — по порядку перечня спеки", () => {
  test("К7: 0..10 — значения DefectGroupStatus по порядку; вне диапазона — неизвестное", () => {
    expect(DEFECT_GROUP_STATUS_ORDER).toEqual([
      "OPEN",
      "RESOLVED_FIXED",
      "RESOLVED_FP",
      "RESOLVED_PROJECT_NOT_AFFECTED",
      "RESOLVED_TOLERABLE",
      "RESOLVED_DUPLICATE",
      "TRIAGE_IN_PROGRESS",
      "TRIAGED_TP",
      "FIX_IN_PROGRESS",
      "RESOLVED_AUTOFIXED",
      "UNRECOGNIZED",
    ]);
    const classes = Array.from({ length: 11 }, (_, i) => defectGroupStatusClass(i));
    expect(classes).toEqual(["open", "resolved", "resolved", "resolved", "resolved", "resolved", "open", "open", "open", "resolved", "unrecognized"]);
    for (const bad of [-1, 11, 1.5, Number.NaN]) expect(defectGroupStatusClass(bad)).toBe("unknown");
    expect(defectGroupStatusName(0)).toBe("OPEN");
    expect(defectGroupStatusClass("OPEN")).toBe("open");
  });
});

// ---------- порция доочереди ----------

describe("К8: порция доочереди", () => {
  test("К8: дефолт 5000 — переменная не задана", () => {
    expect(RECOLLECT_PER_WAVE_DEFAULT).toBe(5000);
    expect(recollectPerWave({})).toBe(5000);
    expect(recollectPerWave({ SCHEDULER_RECOLLECT_PER_WAVE: "" })).toBe(5000);
  });
});
