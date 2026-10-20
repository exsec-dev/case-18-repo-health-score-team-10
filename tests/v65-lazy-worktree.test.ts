// AI-обзор на неглубоком частичном клоне: аргументы клона, README из
// git-каталога без рабочей копии, ленивая рабочая копия у инструментов модели.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneBare } from "../src/collectors/git";
import { SUMMARY_SHALLOW_CLONE } from "../src/jobs/scheduler";
import { readReadme } from "../src/summary/pipeline";
import { executeTool, GIT_LOG_CAP, makeToolExecutor, materializeWorktree, MAX_PLAIN_READ_BYTES, readHeadFile, removeWorktree } from "../src/summary/tools";

const LIMITS = { timeoutMs: 60_000, maxBytes: 1024 * 1024 * 1024, pollMs: 50 };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Репозиторий с `commits` коммитами; README – обычный файл, в `docs/` – еще файл. */
function fixtureRepo(commits: number, readme = "# Проект\n\nОписание.\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-v65-src-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), readme);
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "guide.md"), "needle in docs\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "c1"]);
  for (let i = 2; i <= commits; i++) {
    writeFileSync(join(dir, "docs", "guide.md"), `needle in docs ${i}\n`);
    git(dir, ["commit", "-q", "-am", `c${i}`]);
  }
  return dir;
}

function canSymlink(dir: string): boolean {
  try {
    writeFileSync(join(dir, "host.txt"), "host");
    symlinkSync(join(dir, "host.txt"), join(dir, "probe"));
    return true;
  } catch {
    return false;
  }
}

describe("В6.5: неглубокий частичный клон для обзора", () => {
  test("cloneBare с shallow: --depth и --filter=blob:none в argv; без shallow аргументов нет", async () => {
    const argv: string[][] = [];
    const seam = {
      spawnGit: (o: { cmd: string[] }) => {
        argv.push(o.cmd);
        return { pid: 1, exited: Promise.resolve(128), stderr: new Response("fatal: no").body!, kill: () => {} };
      },
    };
    await cloneBare("https://git@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, { ...seam, shallow: { depth: 30, blobless: true } });
    await cloneBare("https://git@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, { ...seam, shallow: { depth: 7.9 } });
    await cloneBare("https://git@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, seam);
    const flags = argv.map((c) => c.filter((a) => a.startsWith("--depth") || a.startsWith("--filter")));
    expect(flags).toEqual([["--depth=30", "--filter=blob:none"], ["--depth=7"], []]);
    // глубина клона обзора – ровно столько коммитов, сколько показывает git_log
    expect(SUMMARY_SHALLOW_CLONE).toEqual({ depth: GIT_LOG_CAP, blobless: true });
  });

  test("частичный клон: история до depth, README и git log из git-каталога, рабочая копия не создается", async () => {
    const src = fixtureRepo(GIT_LOG_CAP + 5);
    const clone = await cloneBare(`file://${src}`, tmpdir(), LIMITS, { shallow: SUMMARY_SHALLOW_CLONE });
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    try {
      // неглубокая история: ровно GIT_LOG_CAP коммитов
      const log = JSON.parse(await executeTool({ root: () => Promise.reject(new Error("не должна разворачиваться")), gitDir: clone.dir }, "git_log", {})) as { ok: boolean; commits: number };
      expect(log).toMatchObject({ ok: true, commits: GIT_LOG_CAP });
      // README – прямо из git-каталога, с окружением клона
      expect(await readHeadFile(clone.dir, /^readme(\.|$)/i, clone.gitEnv)).toBe("# Проект\n\nОписание.\n");
      expect(await readReadme({ clone: { root: () => Promise.reject(new Error("нет")), gitDir: clone.dir, gitEnv: clone.gitEnv } })).toBe("# Проект\n\nОписание.\n");
      expect(await readHeadFile(clone.dir, /^нет-такого$/i, clone.gitEnv)).toBeNull();
    } finally {
      rmSync(clone.dir, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("README-симлинк и README больше предела из git-каталога не читаются", async () => {
    const src = fixtureRepo(1, "x".repeat(MAX_PLAIN_READ_BYTES + 1));
    const big = await readHeadFile(join(src, ".git"), /^readme(\.|$)/i);
    expect(big).toBeNull();
    const linkDir = mkdtempSync(join(tmpdir(), "rh-v65-link-"));
    if (canSymlink(linkDir)) {
      const repo = join(linkDir, "repo");
      mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      symlinkSync(join(linkDir, "host.txt"), join(repo, "README.md"));
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "link"]);
      expect(git(repo, ["ls-tree", "HEAD"])).toContain("120000");
      expect(await readHeadFile(join(repo, ".git"), /^readme(\.|$)/i)).toBeNull();
    }
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("ленивая рабочая копия: git_log ее не разворачивает, первый файловый инструмент – один раз", async () => {
    const src = fixtureRepo(3);
    const clone = await cloneBare(`file://${src}`, tmpdir(), LIMITS, { shallow: SUMMARY_SHALLOW_CLONE });
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    let materialized = 0;
    let worktree: { root: string; gitDir: string } | null = null;
    let pending: Promise<string> | null = null;
    const lazyRoot = (): Promise<string> => {
      if (pending === null) {
        materialized++;
        pending = materializeWorktree(clone.dir, clone.gitEnv).then((w) => {
          worktree = w;
          return w.root;
        });
      }
      return pending;
    };
    try {
      const ex = makeToolExecutor({ root: lazyRoot, gitDir: clone.dir }, 12);
      expect(JSON.parse(await ex.execute("git_log", {}))).toMatchObject({ ok: true });
      expect(materialized).toBe(0);
      // два файловых инструмента одновременно – одна рабочая копия
      const [listed, found] = await Promise.all([ex.execute("list_files", {}), ex.execute("grep", { pattern: "needle" })]);
      expect(materialized).toBe(1);
      expect(JSON.parse(listed)).toMatchObject({ ok: true });
      expect((JSON.parse(listed) as { files: string[] }).files).toContain("README.md");
      expect((JSON.parse(found) as { matches: number }).matches).toBe(1);
      const read = JSON.parse(await ex.execute("read_file", { path: "docs/guide.md" })) as { ok: boolean; content: string };
      expect(read.ok).toBe(true);
      expect(read.content).toContain("needle in docs 3");
      expect(materialized).toBe(1);
    } finally {
      const wt = worktree as { root: string; gitDir: string } | null;
      if (wt !== null) await removeWorktree(wt.root, wt.gitDir);
      rmSync(clone.dir, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("развертывание упало – файловые инструменты отвечают отказом, не исключением", async () => {
    const out = JSON.parse(await executeTool({ root: () => Promise.reject(new Error("git worktree: exit 128")), gitDir: null }, "read_file", { path: "README.md" })) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("рабочая копия недоступна");
  });
});

describe("В6.5 (ревью): имена не-ASCII, отказы без развертывания", () => {
  test("README с не-ASCII именем читается из git-каталога (ls-tree -z, без C-экранирования)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-v65-utf-"));
    try {
      git(dir, ["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, "README.мд"), "# Привет\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "utf"]);
      // без -z git печатал бы имя в кавычках с \-кодами
      expect(git(dir, ["ls-tree", "HEAD"])).toContain('"');
      expect(await readHeadFile(join(dir, ".git"), /^readme(\.|$)/i)).toBe("# Привет\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("отказ по аргументам (секреты, битый паттерн, нет path) не разворачивает рабочую копию", async () => {
    let materialized = 0;
    const io = {
      root: () => {
        materialized++;
        return Promise.reject(new Error("не должна разворачиваться"));
      },
      gitDir: null,
    };
    expect(JSON.parse(await executeTool(io, "read_file", { path: ".env" }))).toMatchObject({ ok: false });
    expect(JSON.parse(await executeTool(io, "read_file", {}))).toMatchObject({ ok: false });
    expect(JSON.parse(await executeTool(io, "grep", { pattern: "(" }))).toMatchObject({ ok: false });
    expect(JSON.parse(await executeTool(io, "list_files", { subdir: ".env" }))).toMatchObject({ ok: false });
    expect(materialized).toBe(0);
    // а допустимый вызов – разворачивает (и честно отказывает при сбое)
    expect(JSON.parse(await executeTool(io, "list_files", {}))).toMatchObject({ ok: false, error: expect.stringContaining("рабочая копия недоступна") });
    expect(materialized).toBe(1);
  });
});
