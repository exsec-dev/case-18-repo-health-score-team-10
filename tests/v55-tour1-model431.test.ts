// Маркеры техдолга считаются только в коде вне тестов (пропущенные – отдельным
// test_markers в code.todo); «кода нет» – явная ветка балла 0 с причиной, а не
// «нет данных» и не 100; рекомендаций с эффектом «+0,0» нет. Поведенческие
// тесты на данных; сборщик проверяется на локальном bare-клоне, без сети.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupClone, cloneBare, extractFacts } from "../src/collectors/git";
import type { Fact } from "../src/collectors/facts";
import { computeFromFacts, type Scores } from "../src/score/compute";
import { recommendFromFacts } from "../src/score/recommend";
import { COLLECTOR_VERSION } from "../src/collectors/facts";
import { MODEL_VERSION } from "../src/score/model";
import { categoryWhy } from "../src/report/sections";
import { submetricContext } from "../src/report/submetrics";
import { renderRepoReport } from "../src/report/markdown";
import { getRepoCard } from "../src/api/repos";
import { NOW, healthyFacts } from "./score-fixtures";
import { makeApiDb, seedRepo } from "./api-fixtures";
import { scoredScan } from "./report-fixtures";

type Patch = Record<string, unknown | undefined>;
function facts(patch: Patch = {}): Map<string, unknown> {
  const m = new Map<string, unknown>(healthyFacts().map((f) => [f.key, f.value]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}
const score = (ok: Map<string, unknown>, extra: { emptyRepo?: boolean } = {}): Scores => computeFromFacts(ok, { scanId: 0, repoId: 0, ...extra }, NOW);

// --- локальный git-репозиторий → факты сборщика (как в tests/v53-collectors) ---
const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const EXTRACT = { maxBlameFiles: 200, textCapBytes: 1_000_000 };
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function git(cwd: string, args: string[]) {
  const d = "2026-01-01T00:00:00+00:00";
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }, stdio: ["ignore", "pipe", "pipe"] });
}
async function factsOf(files: Record<string, string>): Promise<Map<string, Record<string, unknown>>> {
  const src = mkdtempSync(join(tmpdir(), "rh-v55-src-"));
  const work = mkdtempSync(join(tmpdir(), "rh-v55-work-"));
  tmp.push(src, work);
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["config", "user.name", "Dev"]);
  git(src, ["config", "user.email", "dev@example.com"]);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), body);
  }
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "init"]);
  const out = await cloneBare(`file://${src}`, work, { ...LIMITS });
  if (!out.ok) throw new Error(out.detail);
  try {
    const collected: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
    return new Map(collected.map((f) => [f.key, f.value as Record<string, unknown>]));
  } finally {
    cleanupClone(out.dir);
  }
}

test("версии после тура 1: модель 4.5.0-hci, сборщик 5 (тур 2)", () => {
  expect(MODEL_VERSION).toBe("4.5.0-hci");
  expect(COLLECTOR_VERSION).toBe(5);
});

describe("М1: маркеры техдолга — только в коде вне тестов", () => {
  test("маркеры в файлах тестов не считаются; test_markers — число пропущенных", async () => {
    const collected = await factsOf({
      "src/a.ts": "// TODO: real debt\nexport const a = 1;\n// FIXME: broken\n",
      "src/b.ts": "export const b = 2;\n",
      "tests/a.test.ts": "// TODO: test fixture marker\nconst x = 1;\n// FIXME: second\n'tODO: quoted at line start'\n",
      "README.md": "# T\n\nTODO: docs marker\n",
    });
    const todo = collected.get("code.todo")!;
    // код: 1 TODO + 1 FIXME; тесты: 3 маркера в сторону; README – не код
    expect({ count: todo.count, fixme: todo.fixme }).toEqual({ count: 1, fixme: 1 });
    expect(todo.test_markers).toBe(3);
    expect(todo.todo_files).toBe(1);
    expect(collected.get("tree.stats")!.test_files).toBe(1);
  });

  test("сканер TODO: все маркеры в тестах — долг 0, test_markers честно показывает объем", async () => {
    const collected = await factsOf({
      "src/scanner.ts": "export const re = /TODO/;\n",
      "tests/scan.test.ts": "// TODO: case 1\n// TODO: case 2\n// FIXME: case 3\n",
    });
    const todo = collected.get("code.todo")!;
    expect({ count: todo.count, fixme: todo.fixme, older: todo.older_180d }).toEqual({ count: 0, fixme: 0, older: 0 });
    expect(todo.test_markers).toBe(3);
    // и расчет видит чистый код: плотность 0 — балл подметрики 100
    const s = score(new Map<string, unknown>([...collected.entries()]));
    expect(s.categories.code.submetrics.density!.value).toBe(0);
    expect(s.categories.code.submetrics.density!.score).toBe(1);
  });

  test("старые факты (без test_markers) пересчитываются без поломки", () => {
    const legacyTodo = { count: 3, fixme: 1, older_180d: 2, todo_files: 2, blamed_files: 2 };
    const s = score(facts({ "code.todo": legacyTodo }));
    expect(s.categories.code.score).not.toBeNull();
    expect(s.derived.todoTotal).toBe(4);
  });
});

describe("М2: «кода нет» — балл 0 с причиной (П-1)", () => {
  const readmeOnly = { "tree.stats": { top_level: [{ name: "README.md", type: "blob" }], file_count: 1, bytes: 300, loc: 10, source_files: 0, source_loc: 0 } };

  test("категория «Состояние кода» — 0 (не null, не 100); итог 0; категория не в списке no-data", () => {
    const s = score(facts(readmeOnly));
    expect(s.codeEmpty).toBe(true);
    expect(s.categories.code.score).toBe(0);
    expect(s.categories.code.no_data).toBe("no source code — only non-code files");
    expect(s.healthcraftIndex).toBe(0);
    expect(s.repoHealthScore).toBe(0);
    expect(s.noData.some((r) => r.startsWith("code:"))).toBe(false);
  });

  test("основание категории — причина пустоты, а не «все показатели на максимуме»", () => {
    const s = score(facts(readmeOnly));
    const cat = s.categories.code;
    expect(Object.keys(cat.submetrics).length).toBe(0);
    const why = categoryWhy(
      { score: { categories: { code: cat } }, evidence: [] } as never,
      "code",
      submetricContext(NOW.toISOString()),
    );
    expect(why).toContain("нет файлов кода");
    expect(why).not.toContain("на максимуме");
    expect(why).not.toContain("Категория в оценке не участвует");
  });

  test("отчет без-кодового репо: строка категории с 0 и причиной, без ложного «ограничен 0: секреты»", () => {
    const t = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "v55", repo: "nocode", title: "No code", language: null, likes: 1, forks: 0, lastActivityAt: "2026-09-20T00:00:00Z" });
      scoredScan(t, repoId, {
        status: "ok",
        trigger: "user",
        facts: [
          { key: "tree.stats", source: "git", value: { top_level: [{ name: "README.md", type: "blob" }], file_count: 1, bytes: 300, loc: 10, source_files: 0, source_loc: 0 } },
          { key: "docs.presence", source: "git", value: { readme: true, license: false, contributing: false, codeowners: false, content_checked: true } },
          { key: "docs.readme", source: "git", value: { present: true, bytes: 300, flags: {} } },
        ],
      });
      const card = getRepoCard(t.db, "v55", "nocode", { access: { cicd: "granted", appsec: "granted", repo: "granted" }, viewerAuth: "pat" })!;
      expect(card.score?.categories.code.score).toBe(0);
      const md = renderRepoReport(card);
      expect(md).toContain("| Состояние кода | 0 |");
      expect(md).toContain("В репозитории нет файлов кода");
      expect(md).toContain("в репозитории нет кода, поэтому оценка 0; баллы категорий выше – справочно");
      expect(md).not.toContain("Q&A");
      // потолок секретов тут ни при чем
      expect(md).not.toContain("AppSec нашел утекшие секреты");
      // единственный совет – добавить код, без «+0,0»
      expect(card.recommendations.map((r) => r.ruleId)).toEqual(["add-code"]);
      expect(md).not.toContain("+0,0");
    } finally {
      t.close();
    }
  });
});

describe("М2: рекомендаций с эффектом «+0,0» нет", () => {
  test("presence-правило с дельтой 0 (и меньше) не попадает в выдачу", () => {
    const ok = facts({ "docs.presence": { readme: true, license: false, contributing: true, codeowners: true } });
    const zero = recommendFromFacts(ok, { delta: () => ({ delta: 0, reason: null }), issuesScore: 50 });
    expect(zero.find((r) => r.ruleId === "license-missing")).toBeUndefined();
    const negative = recommendFromFacts(ok, { delta: () => ({ delta: -1, reason: null }), issuesScore: 50 });
    expect(negative.find((r) => r.ruleId === "license-missing")).toBeUndefined();
    const positive = recommendFromFacts(ok, { delta: () => ({ delta: 2.4, reason: null }), issuesScore: 50 });
    const rec = positive.find((r) => r.ruleId === "license-missing")!;
    expect(rec.expectedImpact).toBe("+2,4 к HealthCraft Index");
  });
});

describe("свойство (правило AGENTS.md 24.09): улучшение факта не снижает оценку", () => {
  test("убранные маркеры долга не снижают ни категорию, ни индекс", () => {
    const before = score(facts({ "code.todo": { count: 10, fixme: 2, older_180d: 6, todo_files: 4, blamed_files: 4 } }));
    const after = score(facts({ "code.todo": { count: 0, fixme: 0, older_180d: 0, todo_files: 0, blamed_files: 0 } }));
    expect(after.categories.code.score!).toBeGreaterThanOrEqual(before.categories.code.score! - 1e-9);
    expect(after.healthcraftIndex!).toBeGreaterThanOrEqual(before.healthcraftIndex! - 1e-9);
  });
});
