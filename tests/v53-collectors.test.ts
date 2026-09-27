// Сборщик: комментарий в первой колонке ci.yaml, LOC без хвостового перевода
// строки, код против документов, MR всех статусов, цензура первого ответа,
// путь временного клона в тексте сбоя. Поведенческие тесты на данных.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubDetail, type Fact } from "../src/collectors/facts";
import { cleanupClone, cloneBare, extractFacts } from "../src/collectors/git";
import { isSourcePath, rootHasNoSource } from "../src/collectors/source-path";
import { parseYamlSubset } from "../src/collectors/yamlmini";
import { computeFromFacts } from "../src/score/compute";

const NOW = new Date("2026-09-15T00:00:00Z");
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

/** Репо с файлами `files` одним коммитом → факты сборщика с bare-клона. */
async function factsOf(files: Record<string, string>): Promise<Map<string, Record<string, unknown>>> {
  const src = mkdtempSync(join(tmpdir(), "rh-v53-src-"));
  const work = mkdtempSync(join(tmpdir(), "rh-v53-work-"));
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
    const facts: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
    return new Map(facts.map((f) => [f.key, f.value as Record<string, unknown>]));
  } finally {
    cleanupClone(out.dir);
  }
}

describe("М2.1: ci.yaml с комментарием в первой колонке", () => {
  test("комментарий в начале файла не ломает разбор; шаги находятся", async () => {
    expect(parseYamlSubset("# CI pipeline\non: [push]\n")).toEqual({ on: ["push"] });
    const facts = await factsOf({
      ".sourcecraft/ci.yaml": "# CI for the project\nworkflows:\n  build:\n    tasks:\n      - name: build\n        cubes:\n          - name: run\n            script:\n              - echo hi\n",
      "src/a.ts": "export const a = 1;\n",
    });
    const cfg = facts.get("cicd.configs")!;
    expect(cfg.steps_note).toBeUndefined();
    expect(cfg.has_steps).toBe(true);
  });

  test("неразбираемый ci.yaml — has_steps: null (неизвестно), не false", async () => {
    const facts = await factsOf({ ".sourcecraft/ci.yaml": "\tbroken: [\n", "src/a.ts": "export const a = 1;\n" });
    const cfg = facts.get("cicd.configs")!;
    expect(cfg.has_steps).toBeNull();
    expect(typeof cfg.steps_note).toBe("string");
  });
});

describe("М2.2, М2.3: строки и пометки — по коду", () => {
  test("однострочный файл без перевода строки — 1 строка; README не код", async () => {
    const facts = await factsOf({ "README.md": "# T\n\nTODO: write docs\n", "main.py": "print(1)", "LICENSE": "MIT" });
    const tree = facts.get("tree.stats")!;
    expect(tree.source_files).toBe(1);
    expect(tree.source_loc).toBe(1);
    expect(tree.loc).toBe(5); // 3 строки README + 1 main.py + 1 LICENSE
    const todo = facts.get("code.todo")!;
    expect((todo.count as number) + (todo.fixme as number)).toBe(0); // пометка в README — не пометка кода
  });

  test("репо из README и лицензии — «кода нет», оценка 0 (Q&A №13)", async () => {
    const facts = await factsOf({ "README.md": "# Hello\n", "LICENSE": "MIT\n", ".gitignore": "node_modules\n" });
    expect(facts.get("tree.stats")!.source_files).toBe(0);
    const ok = new Map<string, unknown>([...facts.entries()]);
    const s = computeFromFacts(ok, { scanId: 0, repoId: 0 }, NOW);
    expect(s.codeEmpty).toBe(true);
    expect(s.healthcraftIndex).toBe(0);
  });

  test("классификатор путей: документы, лицензии, lock-файлы и картинки — не код", () => {
    for (const p of ["README.md", "docs/guide.rst", "LICENSE-MIT", "COPYING", "yarn.lock", "go.sum", "img/logo.png", ".gitignore", "CHANGELOG"]) expect(isSourcePath(p)).toBe(false);
    for (const p of ["src/main.ts", "Makefile", "Dockerfile", ".sourcecraft/ci.yaml", "package.json", "main.py"]) expect(isSourcePath(p)).toBe(true);
  });

  test("факты до правки сборщика: кода нет, если в корне только не-код и нет каталогов", () => {
    expect(rootHasNoSource([{ name: "README.md", type: "blob" }, { name: "LICENSE", type: "blob" }])).toBe(true);
    expect(rootHasNoSource([{ name: "README.md", type: "blob" }, { name: "src", type: "tree" }])).toBe(false);
    expect(rootHasNoSource([{ name: "README.md", type: "blob" }, { name: "main.py", type: "blob" }])).toBe(false);
    expect(rootHasNoSource([])).toBe(false);
  });
});

describe("М2.7: путь временного клона не попадает в текст сбоя", () => {
  test("Windows и POSIX пути клона — меткой; прочий текст сохраняется", () => {
    expect(scrubDetail("no commits at HEAD (Command failed: git --git-dir C:\\Users\\X\\AppData\\Local\\Temp\\rh-clone-EQjbNs rev-parse)")).toBe(
      "no commits at HEAD (Command failed: git --git-dir <временный клон> rev-parse)",
    );
    expect(scrubDetail("Cloning into bare repository '/tmp/rh-clone-abc'... fatal")).toBe("Cloning into bare repository '<временный клон>'... fatal");
    expect(scrubDetail("clone exceeded 1200000 ms timeout")).toBe("clone exceeded 1200000 ms timeout");
  });
});
