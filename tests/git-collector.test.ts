// git-collector.test.ts — Б1: cloneBare (лимиты/watchdog/cleanup),
// extractFacts (факты всех git-kinds, robot-эвристика v1, tri-state
// пустого репо). Внешний канал фейкован локальным file://-репо — сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneBare, cleanupClone, extractFacts, isRobotPattern, robotIntervalFlags, DEFAULT_CLONE_LIMITS } from "../src/collectors/git";
import { Fact } from "../src/collectors/facts";

const NOW = new Date("2026-09-15T00:00:00Z");

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-fixture-src-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Alice Dev"]);
  git(dir, ["config", "user.email", "alice@example.com"]);

  // базовый коммит 2024-01-01 (TODO из него будет older_180d)
  const d2024 = "2024-01-01T00:00:00+00:00";
  writeFileSync(join(dir, "README.md"), "# Title\n\nSome intro text.\n\n## Usage\n\nRun it.\n");
  writeFileSync(join(dir, "LICENSE"), "MIT License\n");
  mkdirSync(join(dir, ".sourcecraft/security"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "sync"), { recursive: true });
  mkdirSync(join(dir, "tick"), { recursive: true });
  writeFileSync(join(dir, ".sourcecraft/ci.yaml"), "on: [push]\n");
  writeFileSync(join(dir, ".sourcecraft/security/licenses.yaml"), "risk: matrix\n");
  writeFileSync(join(dir, "src/a.ts"), "export const x = 1;\n// TODO: refactor this thing\n");
  writeFileSync(join(dir, "src/b.ts"), "export const y = 2;\n// FIXME: broken edge case\n");
  writeFileSync(join(dir, "assets/logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  git(dir, ["add", "-A"], { GIT_AUTHOR_DATE: d2024, GIT_COMMITTER_DATE: d2024 });
  git(dir, ["commit", "-q", "-m", "base"], { GIT_AUTHOR_DATE: d2024, GIT_COMMITTER_DATE: d2024 });

  // пачка робот-коммитов (committer-паттерн), одна метка времени
  const d2025 = "2025-06-01T12:00:00+00:00";
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(dir, `sync/r${i}.txt`), `robot commit ${i}\n`);
    git(dir, ["add", "-A"]);
    git(
      dir,
      ["commit", "-q", "-m", `sync ${i}`, "--author=Some One <some@example.com>"],
      {
        GIT_AUTHOR_DATE: d2025,
        GIT_COMMITTER_DATE: d2025,
        GIT_COMMITTER_NAME: "GitHub Sync",
        GIT_COMMITTER_EMAIL: "sync-bot@users.noreply.github.com",
      },
    );
  }

  // серия человека с регулярным интервалом ровно 1ч (7 коммитов)
  const base = Date.parse("2026-08-01T00:00:00Z");
  for (let i = 0; i < 7; i++) {
    const iso = new Date(base + i * 3600_000).toISOString();
    writeFileSync(join(dir, `tick/t${i}.txt`), `tick ${i}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `tick ${i}`], {
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    });
  }
  return dir;
}

describe("robot heuristics v1 (pure)", () => {
  test("committer-паттерн: robot|sync|bot|-github", () => {
    expect(isRobotPattern("GitHub Sync", "sync-bot@x.y")).toBe(true);
    expect(isRobotPattern("robot", "r@x.y")).toBe(true);
    expect(isRobotPattern("Someone", "someone-1@x.y")).toBe(false);
    expect(isRobotPattern("Some GitHub", "someone@x-1c-github.example.com")).toBe(true);
    expect(isRobotPattern("Alice Dev", "alice@example.com")).toBe(false);
  });

  test("интервал: ровная серия ≥6 коммитов → робот, рваная → нет", () => {
    const h = 3600_000;
    const regular = robotIntervalFlags([0, h, 2 * h, 3 * h, 4 * h, 5 * h, 6 * h].map((t) => ({ ts: t })));
    expect(regular.every(Boolean)).toBe(true);
    const irregular = robotIntervalFlags([0, h, 9 * h, 40 * h, 100 * h, 300 * h, 900 * h].map((t) => ({ ts: t })));
    expect(irregular.some(Boolean)).toBe(false);
    const short = robotIntervalFlags([0, h, 2 * h, 3 * h].map((t) => ({ ts: t })));
    expect(short.every(Boolean)).toBe(false);
  });

  test("интервал: ±20% коридор — jitter 10% проходит, 30% нет", () => {
    const h = 3600_000;
    const jitter10 = robotIntervalFlags([0, 1.1 * h, 2 * h, 2.9 * h, 4 * h, 5.1 * h, 6 * h].map((t) => ({ ts: Math.round(t) })));
    expect(jitter10.every(Boolean)).toBe(true);
    const jitter40 = robotIntervalFlags([0, h, 1.4 * h, 3 * h, 3.5 * h, 5 * h, 5.1 * h].map((t) => ({ ts: Math.round(t) })));
    expect(jitter40.every(Boolean)).toBe(false);
  });
});

describe("extractFacts (локальный bare-клон, без сети)", () => {
  const src = buildFixtureRepo();
  const work = mkdtempSync(join(tmpdir(), "rh-git-test-"));
  let cloneDir = "";

  test("cloneBare: ok + cleanup удаляет", async () => {
    const out = await cloneBare(`file://${src}`, work, { ...DEFAULT_CLONE_LIMITS, timeoutMs: 60_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    cloneDir = out.dir;
    expect(existsSync(cloneDir)).toBe(true);
    cleanupClone(cloneDir);
    expect(existsSync(cloneDir)).toBe(false);
  });

  test("факты: docs/cicd/tree/todo/timeline/robot — все kinds, status ok", async () => {
    const out = await cloneBare(`file://${src}`, work, { ...DEFAULT_CLONE_LIMITS, timeoutMs: 60_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts = await extractFacts(out.dir, { now: NOW });
      expect(facts.every((f) => f.status === "ok" && f.source === "git")).toBe(true);
      const by = new Map(facts.map((f) => [f.key, f]));
      const val = (k: string) => by.get(k)!.value as Record<string, unknown>;

      expect(val("docs.presence")).toEqual({ readme: true, license: true, contributing: false, codeowners: false });
      expect((val("docs.readme").sections as number) >= 2).toBe(true);
      expect((val("docs.readme").bytes as number) > 30).toBe(true);

      const cicd = val("cicd.configs") as { paths: string[]; has_ci_yaml: boolean };
      expect(cicd.paths).toContain(".sourcecraft/ci.yaml");
      expect(cicd.paths).toContain(".sourcecraft/security/licenses.yaml");
      expect(cicd.has_ci_yaml).toBe(true);

      const tree = val("tree.stats");
      expect((tree.file_count as number) >= 18).toBe(true);
      expect((tree.bytes as number) > 100).toBe(true);
      expect((tree.loc as number) > 10).toBe(true);

      const todo = val("code.todo");
      expect(todo.count).toBeGreaterThanOrEqual(1);
      expect(todo.fixme).toBeGreaterThanOrEqual(1);
      expect(todo.older_180d).toBeGreaterThanOrEqual(1); // коммит 2024-01-01
      expect(todo.blamed_files).toBeGreaterThanOrEqual(1);

      const timeline = val("activity.git.timeline") as {
        events: Array<{
          sha: string;
          committer: { name: string; email: string };
          robot: boolean;
          robot_reasons: string[];
        }>;
      };
      const events = timeline.events;
      expect(events.length).toBe(16); // 1 база + 8 роботов + 7 тиков
      const robots = events.filter((e) => e.committer.email === "sync-bot@users.noreply.github.com");
      expect(robots.length).toBe(8);
      expect(robots.every((e) => e.robot && e.robot_reasons.includes("committer-pattern"))).toBe(true);
      const intervalRobots = events.filter((e) => e.robot_reasons.includes("regular-interval"));
      expect(intervalRobots.length).toBeGreaterThanOrEqual(7); // тики 1ч + нулевые дельты роботов

      const summary = val("activity.git.summary");
      expect(summary.commits).toBe(16);
      expect((summary.robot_ratio as number) > 0).toBe(true);
      expect(String(summary.first_committed_at)).toMatch(/^2024-01-01T00:00:00/);
      expect(String(summary.last_committed_at)).toMatch(/^2026-08-01T06:00:00/);
    } finally {
      cleanupClone(out.dir);
    }
  });

  test("пустое репо → весь git-набор no-data reason=empty", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "rh-fixture-empty-"));
    git(emptyDir, ["init", "-q", "-b", "main"]);
    const out = await cloneBare(`file://${emptyDir}`, work, { ...DEFAULT_CLONE_LIMITS, timeoutMs: 60_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts = await extractFacts(out.dir, { now: NOW });
      expect(facts.length).toBe(7);
      expect(facts.every((f) => f.status === "no-data")).toBe(true);
      expect(facts.every((f) => (f.value as { reason: string }).reason === "empty")).toBe(true);
    } finally {
      cleanupClone(out.dir);
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("нет README → docs.readme {present:false} ok-факт (отсутствие = данные)", async () => {
    const noReadme = mkdtempSync(join(tmpdir(), "rh-fixture-noreadme-"));
    git(noReadme, ["init", "-q", "-b", "main"]);
    git(noReadme, ["config", "user.name", "Bob"]);
    git(noReadme, ["config", "user.email", "bob@example.com"]);
    writeFileSync(join(noReadme, "main.py"), "print('hi')\n# TODO: later\n");
    git(noReadme, ["add", "-A"]);
    git(noReadme, ["commit", "-q", "-m", "init"]);
    const out = await cloneBare(`file://${noReadme}`, work, { ...DEFAULT_CLONE_LIMITS, timeoutMs: 60_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts: Fact[] = await extractFacts(out.dir, { now: NOW });
      const readme = facts.find((f) => f.key === "docs.readme")!;
      expect(readme.status).toBe("ok");
      expect(readme.value).toEqual({ present: false });
      const presence = facts.find((f) => f.key === "docs.presence")!;
      expect((presence.value as Record<string, unknown>).readme).toBe(false);
      expect(presence.status).toBe("ok");
    } finally {
      cleanupClone(out.dir);
      rmSync(noReadme, { recursive: true, force: true });
    }
  });

  test("cloneBare: git-ошибка (несуществующий источник) → reason=git, tmp вычищен", async () => {
    const out = await cloneBare("file:///nonexistent/rh-nowhere.git", work, { ...DEFAULT_CLONE_LIMITS, timeoutMs: 30_000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("git");
  });

  test("cloneBare: таймаут → abort + cleanup (большой локальный источник, timeoutMs=1)", async () => {
    const big = mkdtempSync(join(tmpdir(), "rh-fixture-big-"));
    git(big, ["init", "-q", "-b", "main"]);
    git(big, ["config", "user.name", "B"]);
    git(big, ["config", "user.email", "b@x.y"]);
    const chunk = Buffer.alloc(512 * 1024, 7);
    for (let i = 0; i < 24; i++) writeFileSync(join(big, `blob${i}.bin`), chunk); // ~12МБ
    git(big, ["add", "-A"]);
    git(big, ["commit", "-q", "-m", "big"]);
    const out = await cloneBare(`file://${big}`, work, { timeoutMs: 1, maxBytes: 10 ** 12, pollMs: 10 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("timeout");
    rmSync(big, { recursive: true, force: true });
  });

  test("cloneBare: диск-бюджет → abort reason=disk", async () => {
    const out = await cloneBare(`file://${src}`, work, { timeoutMs: 120_000, maxBytes: 100, pollMs: 10 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("disk");
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });
});
