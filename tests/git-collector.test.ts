// Git-коллектор: cloneBare (лимиты, watchdog, уборка), деградация клона,
// флаги секций README, has_steps в ci.yaml, extractFacts (факты всех
// git-kinds, эвристика роботов, tri-state пустого репо). Внешний канал
// заменен локальным file://-репо — сети нет.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killActiveClones, trackCloneGroup, 
  cloneBare,
  cloneWithDegrade,
  cleanupClone,
  extractFacts,
  isRobotPattern,
  robotIntervalFlags,
  readmeSectionFlags,
  readmeHeadingCount,
  ciHasSteps,
  scrubCredentials,
  splitCredentialUrl,
  parseGitVersion,
  versionAtLeast,
  MIN_GIT_VERSION,
} from "../src/collectors/git";
import { scanFromEnv } from "../src/config";
import { parseYamlSubset } from "../src/collectors/yamlmini";
import { Fact } from "../src/collectors/facts";

const NOW = new Date("2026-09-15T00:00:00Z");
// лимиты передаются инъекцией: в модуле констант нет, они живут в Config.scan
const LIMITS = { timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, pollMs: 5_000 };
const EXTRACT = { maxBlameFiles: 200, textCapBytes: 1_000_000 };

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
  // лицензия засчитывается по тексту (не меньше 16 непробельных символов)
  writeFileSync(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2024 Dev\n");
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
    const out = await cloneBare(`file://${src}`, work, { ...LIMITS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    cloneDir = out.dir;
    expect(existsSync(cloneDir)).toBe(true);
    cleanupClone(cloneDir);
    expect(existsSync(cloneDir)).toBe(false);
  });

  test("факты: docs/cicd/tree/todo/timeline/robot — все kinds, status ok", async () => {
    const out = await cloneBare(`file://${src}`, work, { ...LIMITS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
      expect(facts.every((f) => f.status === "ok" && f.source === "git")).toBe(true);
      const by = new Map(facts.map((f) => [f.key, f]));
      const val = (k: string) => by.get(k)!.value as Record<string, unknown>;

      expect(val("docs.presence")).toEqual({ readme: true, license: true, contributing: false, codeowners: false, content_checked: true });
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
    const out = await cloneBare(`file://${emptyDir}`, work, { ...LIMITS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
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
    const out = await cloneBare(`file://${noReadme}`, work, { ...LIMITS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts: Fact[] = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
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
    const out = await cloneBare("file:///nonexistent/rh-nowhere.git", work, { ...LIMITS, timeoutMs: 30_000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("git");
  });

  test("cloneBare: таймаут → abort + cleanup (большой локальный источник, timeoutMs=1)", async () => {
    const big = mkdtempSync(join(tmpdir(), "rh-fixture-big-"));
    git(big, ["init", "-q", "-b", "main"]);
    git(big, ["config", "user.name", "B"]);
    git(big, ["config", "user.email", "b@x.y"]);
    // Локальный file-клон 48МБ занимает ~11мс: при pollMs=10 он успевает
    // завершиться до первого poll, и тест флейкает. pollMs=1 — первый poll
    // на ~1мс, срабатывание на ~2мс, задолго до конца любого реального клона.
    const chunk = Buffer.alloc(512 * 1024, 7);
    for (let i = 0; i < 96; i++) writeFileSync(join(big, `blob${i}.bin`), chunk); // ~48МБ
    git(big, ["add", "-A"]);
    git(big, ["commit", "-q", "-m", "big"]);
    const out = await cloneBare(`file://${big}`, work, { timeoutMs: 1, maxBytes: 10 ** 12, pollMs: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("timeout");
    rmSync(big, { recursive: true, force: true });
  });

  test("cloneBare: диск-бюджет → abort reason=disk (несжимаемый источник ~10МБ, бюджет 1МБ)", async () => {
    // Крошечный клон успевает завершиться до первого du-poll на быстрой
    // машине, и тест флейкает. Несжимаемый payload гарантирует, что poll
    // застает передачу в разгаре: 10МБ > бюджета 1МБ.
    const bigDisk = mkdtempSync(join(tmpdir(), "rh-fixture-disk-"));
    git(bigDisk, ["init", "-q", "-b", "main"]);
    git(bigDisk, ["config", "user.name", "B"]);
    git(bigDisk, ["config", "user.email", "b@x.y"]);
    const chunk = Buffer.alloc(512 * 1024);
    for (let i = 0; i < 20; i++) {
      randomFillSync(chunk);
      writeFileSync(join(bigDisk, `blob${i}.bin`), chunk);
    }
    git(bigDisk, ["add", "-A"]);
    git(bigDisk, ["commit", "-q", "-m", "bulk"]);
    const out = await cloneBare(`file://${bigDisk}`, work, {
      timeoutMs: 120_000,
      maxBytes: 1024 * 1024,
      pollMs: 10,
    });
    rmSync(bigDisk, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("disk");
  }, 15_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("В2/Б1: деградационная попытка cloneWithDegrade (§5.7)", () => {
  const work = mkdtempSync(join(tmpdir(), "rh-degrade-"));

  function buildRepoWithHistory(): string {
    const dir = mkdtempSync(join(tmpdir(), "rh-degrade-src-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "A"]);
    git(dir, ["config", "user.email", "a@x.y"]);
    const old = "2024-01-01T00:00:00+00:00";
    writeFileSync(join(dir, "old.txt"), "old\n");
    git(dir, ["add", "-A"], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    git(dir, ["commit", "-q", "-m", "old"], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    writeFileSync(join(dir, "new.txt"), "new\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "new"]);
    return dir;
  }

  test("пробой полного клона → shallow-повтор ок + history_truncated_since в факте", async () => {
    const src = buildRepoWithHistory();
    // полный клон валится по таймауту (настенные часы — детерминизм теста;
    // du-гонка на крошечном репо ненадёжна), деградация — с реальным бюджетом
    const out = await cloneWithDegrade(`file://${src}`, work, {
      ...LIMITS,
      pollMs: 5,
      timeoutMs: 1,
      degrade: { sinceMonths: 13, timeoutMs: 60_000, maxBytes: 500 * 1024 * 1024, enabled: true },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.historyTruncatedSince).toBeTruthy();
    expect(new Date(out.historyTruncatedSince!).getTime()).toBeLessThan(Date.now());
    try {
      const facts = await extractFacts(out.dir, { ...EXTRACT, now: NOW, historyTruncatedSince: out.historyTruncatedSince! });
      const summary = facts.find((f) => f.key === "activity.git.summary")!.value as Record<string, unknown>;
      // shallow-since (реальные «сейчас − 13 мес» ≈ 2025-08) отсекает
      // коммит 2024-01-01, свежий «new» остаётся
      expect(summary.commits).toBe(1);
      expect(summary.history_truncated_since).toBe(out.historyTruncatedSince);
    } finally {
      cleanupClone(out.dir);
    }
    rmSync(src, { recursive: true, force: true });
  });

  test("обе попытки пробиты → combined detail, git-ошибка деградацией не лечится", async () => {
    const src = buildRepoWithHistory();
    const both = await cloneWithDegrade(`file://${src}`, work, {
      ...LIMITS,
      pollMs: 5,
      timeoutMs: 1,
      degrade: { sinceMonths: 13, timeoutMs: 1, maxBytes: 500 * 1024 * 1024, enabled: true },
    });
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.detail).toContain("full clone failed");
    expect(both.detail).toContain("degrade attempt failed");
    rmSync(src, { recursive: true, force: true });

    const gitErr = await cloneWithDegrade("file:///nonexistent/rh-nowhere.git", work, {
      ...LIMITS,
      degrade: { sinceMonths: 13, timeoutMs: 30_000, maxBytes: 500 * 1024 * 1024, enabled: true },
    });
    expect(gitErr.ok).toBe(false);
    if (gitErr.ok) return;
    expect(gitErr.reason).toBe("git");
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });
});

describe("В2/Б1: флаги секций README (словарь RU+EN §7.4)", () => {
  // раздел засчитывается только с непустым телом — словарь проверяется на
  // заголовках, под которыми есть строка текста
  const b = (md: string): string => md.replace(/^(#{1,6} .*)$/gm, "$1\nтекст раздела");
  test("RU+EN заголовки → install/build/test", () => {
    expect(readmeSectionFlags(b("# Проект\n\n## Установка\n\n## Сборка\n\n## Тесты\n"))).toEqual({ install: true, build: true, test: true });
    expect(readmeSectionFlags(b("# X\n\n## Getting Started\n\n### Build instructions\n\n### Running tests\n"))).toEqual({ install: true, build: true, test: true });
    expect(readmeSectionFlags(b("# X\n\n## Быстрый старт\n\n## Testing\n"))).toEqual({ install: true, build: false, test: true });
    expect(readmeSectionFlags(b("# X\n\n## Setup\n\n## Запуск\n"))).toEqual({ install: true, build: false, test: false });
  });

  test("«Запуск тестов» → test, НЕ install (коллизия фразы/слова)", () => {
    expect(readmeSectionFlags(b("# X\n\n## Запуск тестов\n"))).toEqual({ install: false, build: false, test: true });
    expect(readmeSectionFlags(b("# X\n\n## Установка и запуск\n"))).toEqual({ install: true, build: false, test: false });
  });

  test("слово внутри другого слова не матчится, нет заголовков → все false", () => {
    for (const h of ["Latest", "Contest", "Prebuilt", "Runtime", "Runbook", "Usage", "Тестовый стенд", "Тестовые данные"]) {
      expect(readmeSectionFlags(b(`# X\n\n## ${h}\n`))).toEqual({ install: false, build: false, test: false });
    }
    expect(readmeSectionFlags(b("просто текст без заголовков\n## \n"))).toEqual({ install: false, build: false, test: false });
  });

  test("любая форма слова: Installation, Как запустить, Test, Тестирование", () => {
    const one = (h: string) => readmeSectionFlags(b(`# X\n\n## ${h}\n`));
    for (const h of ["Installation", "Installing", "Как установить", "Как запустить", "How to run", "Running", "Quick start", "Quickstart", "Set up"]) {
      expect(one(h)).toEqual({ install: true, build: false, test: false });
    }
    for (const h of ["Building", "Как собрать", "Соберите проект", "Compiling"]) {
      expect(one(h)).toEqual({ install: false, build: true, test: false });
    }
    // «Test» – тот самый заголовок, который называет рекомендация readme-sections-missing
    for (const h of ["Test", "Тест", "Тестирование", "Unit tests", "Как запустить тесты", "Running tests"]) {
      expect(one(h)).toEqual({ install: false, build: false, test: true });
    }
    expect(one("Сборка и запуск")).toEqual({ install: true, build: true, test: false });
  });

  test("эмодзи, уровни 3–4 и setext-заголовки", () => {
    expect(readmeSectionFlags(b("# X\n\n## 🚀 Установка\n\n### 🛠 Build\n\n#### ✅ Tests\n"))).toEqual({ install: true, build: true, test: true });
    expect(readmeSectionFlags("Проект\n======\n\nУстановка\n---------\nnpm i\n\nTests\n-----\nbun test\n")).toEqual({ install: true, build: false, test: true });
    // setext без тела не засчитывается, а строка над следующим подчеркиванием телом не считается
    expect(readmeSectionFlags("X\n===\n\nInstall\n-------\n\nBuild\n-----\nmake\n")).toEqual({ install: false, build: true, test: false });
    // элемент списка над «---» и разделитель после пустой строки – не заголовки
    expect(readmeSectionFlags("# X\n\n- Install\n---\ntext\n\nBuild\n\n---\ntext\n")).toEqual({ install: false, build: false, test: false });
    // внутри блока кода setext нет
    expect(readmeSectionFlags("# X\n\n```\nInstall\n-------\n```\ntext\n")).toEqual({ install: false, build: false, test: false });
  });

  test("README pelmenya/repo-vitals: «Как запустить» с командами – раздел установки", () => {
    const readme = [
      "# repo-vitals",
      "",
      "## Как запустить",
      "",
      "Нужно: Docker с плагином Compose v2.",
      "",
      "```bash",
      "docker compose -f deploy/compose.reviewer.yaml up -d --build --wait",
      "```",
      "",
      "## Разработка",
      "",
      "Требуется Node 24+.",
    ].join("\n");
    expect(readmeSectionFlags(readme)).toEqual({ install: true, build: false, test: false });
    expect(readmeHeadingCount(readme)).toBe(3);
  });
});

describe("В2/Б1: has_steps (ci.yaml, §7.4)", () => {
  test("наш .sourcecraft/ci.yaml (образец) → has_steps=true", () => {
    const parsed = parseYamlSubset(readFileSync(".sourcecraft/ci.yaml", "utf8"));
    expect(ciHasSteps(parsed)).toBe(true);
  });

  test("пустышка без шагов / без tasks → false; task-level script тоже считается", () => {
    expect(ciHasSteps(parseYamlSubset("on: [push]\n"))).toBe(false);
    expect(ciHasSteps(parseYamlSubset("tasks:\n  - name: empty\n    cubes:\n      - name: c\n        script:\n          - \"\"\n"))).toBe(false);
    expect(ciHasSteps(parseYamlSubset("tasks:\n  - name: t\n    script:\n      - echo hi\n"))).toBe(true);
    expect(ciHasSteps({})).toBe(false);
    expect(ciHasSteps(null)).toBe(false);
  });

  test("extractFacts несёт has_steps в cicd.configs (фикстура с on: [push])", async () => {
    // фикстура основного describe уже склонирована — пересоберём мини-репо
    const dir = mkdtempSync(join(tmpdir(), "rh-steps-src-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "A"]);
    git(dir, ["config", "user.email", "a@x.y"]);
    mkdirSync(join(dir, ".sourcecraft"), { recursive: true });
    writeFileSync(join(dir, ".sourcecraft/ci.yaml"), "on: [push]\n");
    // раздел засчитывается с непустым телом
    writeFileSync(join(dir, "README.md"), "# X\n\n## Install\n\nnpm install\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const work = mkdtempSync(join(tmpdir(), "rh-steps-work-"));
    const out = await cloneBare(`file://${dir}`, work, { ...LIMITS });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      const facts = await extractFacts(out.dir, { ...EXTRACT, now: NOW });
      const cicd = facts.find((f) => f.key === "cicd.configs")!.value as Record<string, unknown>;
      expect(cicd.has_ci_yaml).toBe(true);
      expect(cicd.has_steps).toBe(false); // «on: [push]» — шагов нет
      const readme = facts.find((f) => f.key === "docs.readme")!.value as Record<string, unknown>;
      expect(readme.flags).toEqual({ install: true, build: false, test: false });
    } finally {
      cleanupClone(out.dir);
      rmSync(dir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("В2/Б1 доп: has_steps на ЖИВЫХ формах платформы (фиксстуры 15.09)", () => {
  // живые ci.yaml платформы: workflows.<name>.tasks (без верхнего tasks),
  // блочные скаляры «- |» в script и action-кубы
  test("cloudapp-hugo / datahint / dozzle-plus (workflows.tasks + блоки) → has_steps=true", () => {
    for (const name of ["cloudapp-hugo", "datahint", "dozzle-plus"]) {
      const parsed = parseYamlSubset(readFileSync(`tests/fixtures/ci/${name}.yaml`, "utf8"));
      expect(ciHasSteps(parsed), name).toBe(true);
    }
  });

  test("блочный скаляр парсится в {__block}, пустой блок ≠ команда", () => {
    const parsed = parseYamlSubset("script:\n  - |\n    echo hi\n") as { script: { __block: string }[] };
    expect(parsed.script[0]!.__block).toContain("echo hi");
    expect(ciHasSteps(parseYamlSubset("workflows:\n  w:\n    tasks:\n      - name: t\n        cubes:\n          - name: c\n            script:\n              - |\n"))).toBe(false);
  });
});

describe("scrubCredentials (В4/Б6: PAT не едет в детали ошибок git)", () => {
  test("креды https://user:pat@ хоста вырезаются из stderr-подобных строк", () => {
    const dirty = "fatal: Authentication failed for 'https://repo-health:pat-secret%40x@git.sourcecraft.dev/o/r.git/'";
    const clean = scrubCredentials(dirty);
    expect(clean).not.toContain("pat-secret");
    expect(clean).toContain("https://***@git.sourcecraft.dev/o/r.git/");
    expect(scrubCredentials("no credentials here")).toBe("no credentials here");
    expect(scrubCredentials("https://git@git.sourcecraft.dev/x")).toBe("https://***@git.sourcecraft.dev/x");
  });
});

// ---------------------------------------------------------------------------
// PAT не в argv и не в config клона: креды из URL уезжают в http.extraHeader
// через GIT_CONFIG_*; системные credential-хелперы глушатся пустым
// credential.helper; на git < 2.31 GIT_CONFIG_* молча не работают — клон с
// токеном отказывается. Сети нет: локальный Bun.serve отдает smart-HTTP
// настоящего git.
// ---------------------------------------------------------------------------

describe("Ф2.4: разбор клон-URL с кредами (LOW-9)", () => {
  test("https → заголовок Basic, URL без кредов", () => {
    const out = splitCredentialUrl("https://repo-health:pat-value@git.sourcecraft.dev/o/r.git");
    expect(out.kind).toBe("header");
    if (out.kind !== "header") return;
    expect(out.url).toBe("https://git.sourcecraft.dev/o/r.git");
    expect(out.authorization).toBe(`Authorization: Basic ${Buffer.from("repo-health:pat-value").toString("base64")}`);
  });

  test("percent-кодированный PAT восстанавливается до кодирования (Basic от сырого значения)", () => {
    const pat = "pat/with+special=chars@and:colon";
    const out = splitCredentialUrl(`https://repo-health:${encodeURIComponent(pat)}@git.sourcecraft.dev/o/r.git`);
    expect(out.kind === "header" && out.authorization).toBe(`Authorization: Basic ${Buffer.from(`repo-health:${pat}`).toString("base64")}`);
  });

  test("http на loopback разрешён (герметичный тест), внешний http с кредами — отказ", () => {
    expect(splitCredentialUrl("http://u:p@127.0.0.1:1234/o/r.git").kind).toBe("header");
    expect(splitCredentialUrl("http://u:p@localhost:1234/o/r.git").kind).toBe("header");
    const refused = splitCredentialUrl("http://u:p@evil.example.com/o/r.git");
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" && refused.detail).toContain("evil.example.com");
  });

  test("URL без кредов не трогается", () => {
    expect(splitCredentialUrl("https://git.sourcecraft.dev/o/r.git")).toEqual({ kind: "none", url: "https://git.sourcecraft.dev/o/r.git" });
  });

  test("версия git: разбор и порог 2.31", () => {
    expect(parseGitVersion("git version 2.43.0.windows.1")).toEqual([2, 43, 0]);
    expect(parseGitVersion("git version 2.31")).toEqual([2, 31, 0]);
    expect(parseGitVersion("not git")).toBeNull();
    expect(versionAtLeast([2, 30, 9], MIN_GIT_VERSION)).toBe(false);
    expect(versionAtLeast([2, 31, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast([3, 0, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast(null, MIN_GIT_VERSION)).toBe(false);
  });
});

describe("Ф2.4: клон с PAT — заголовок, argv, config клона", () => {
  /** pkt-line для smart-HTTP объявления сервиса. */
  const pkt = (s: string): string => (s.length + 4).toString(16).padStart(4, "0") + s;

  /**
   * Настоящий smart-HTTP git поверх Bun.serve: `git upload-pack
   * --stateless-rpc`. Нужен именно живой git-клиент — проверяем, что
   * заголовок из GIT_CONFIG_* ДОХОДИТ до сервера, а не что мы его сформировали.
   */
  function startGitHttp(repoPath: string) {
    const seen: { authorization: string | null; paths: string[] } = { authorization: null, paths: [] };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        seen.paths.push(url.pathname);
        if (seen.authorization === null) seen.authorization = req.headers.get("authorization");
        if (url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-upload-pack") {
          const proc = Bun.spawn(["git", "upload-pack", "--stateless-rpc", "--advertise-refs", repoPath], { stdout: "pipe", stderr: "ignore" });
          const refs = await new Response(proc.stdout).arrayBuffer();
          const head = new TextEncoder().encode(`${pkt("# service=git-upload-pack\n")}0000`);
          const body = new Uint8Array(head.length + refs.byteLength);
          body.set(head, 0);
          body.set(new Uint8Array(refs), head.length);
          return new Response(body, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
        }
        if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
          const proc = Bun.spawn(["git", "upload-pack", "--stateless-rpc", repoPath], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
          proc.stdin.write(new Uint8Array(await req.arrayBuffer()));
          await proc.stdin.end();
          const out = await new Response(proc.stdout).arrayBuffer();
          return new Response(out, { headers: { "content-type": "application/x-git-upload-pack-result" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("PAT едет заголовком: сервер видит Basic, argv без '@', config клона без токена", async () => {
    const src = buildFixtureRepo();
    const bare = mkdtempSync(join(tmpdir(), "rh-bare-src-"));
    execFileSync("git", ["clone", "--bare", "-q", src, join(bare, "r.git")], { stdio: ["ignore", "pipe", "pipe"] });
    const http = startGitHttp(join(bare, "r.git"));
    const PAT = "pat-super-secret-value";
    const seen: { cmd: string[]; env: Record<string, string> }[] = [];
    let configText = "";
    try {
      const out = await cloneBare(`${http.url.replace("http://", `http://repo-health:${PAT}@`)}/o/r.git`, tmpdir(), LIMITS, {
        spawnGit: (o) => {
          seen.push(o);
          return Bun.spawn({ cmd: o.cmd, stdout: "ignore", stderr: "pipe", stdin: "ignore", env: o.env });
        },
        onCloneDir: (dir) => {
          configText = readFileSync(join(dir, "config"), "utf8");
        },
      });
      expect(out.ok).toBe(true);
      if (out.ok) cleanupClone(out.dir);
      // сервер получил авторизацию именно заголовком
      expect(http.seen.authorization).toBe(`Basic ${Buffer.from(`repo-health:${PAT}`).toString("base64")}`);
      // argv: ни '@', ни самого токена (в /proc/<pid>/cmdline его нет)
      const argv = seen[0]!.cmd.join(" ");
      expect(argv).not.toContain("@");
      expect(argv).not.toContain(PAT);
      // env дочернего git: заголовок + заглушённый credential.helper
      expect({
        count: seen[0]!.env.GIT_CONFIG_COUNT,
        key0: seen[0]!.env.GIT_CONFIG_KEY_0,
        key1: seen[0]!.env.GIT_CONFIG_KEY_1,
        value1: seen[0]!.env.GIT_CONFIG_VALUE_1,
        prompt: seen[0]!.env.GIT_TERMINAL_PROMPT,
      }).toEqual({ count: "2", key0: "http.extraHeader", key1: "credential.helper", value1: "", prompt: "0" });
      // config клона на диске: ни токена, ни заголовка (сбой уборки не оставит PAT)
      expect(configText).not.toContain(PAT);
      expect(configText.toLowerCase()).not.toContain("authorization");
      expect(configText).toContain("/o/r.git");
    } finally {
      http.stop();
      rmSync(bare, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);

  test("анонимный клон: системный хелпер кредов заглушен, окно входа менеджера кредов не открывается", async () => {
    const seen: Record<string, string>[] = [];
    await cloneBare("https://git@git.sourcecraft.dev/o/private.git", tmpdir(), LIMITS, {
      spawnGit: (o) => {
        seen.push(o.env);
        return { pid: 1, exited: Promise.resolve(128), stderr: new Response("fatal: Authentication failed").body!, kill: () => {} };
      },
    });
    expect({
      count: seen[0]!.GIT_CONFIG_COUNT,
      key0: seen[0]!.GIT_CONFIG_KEY_0,
      value0: seen[0]!.GIT_CONFIG_VALUE_0,
      gcm: seen[0]!.GCM_INTERACTIVE,
      prompt: seen[0]!.GIT_TERMINAL_PROMPT,
    }).toEqual({ count: "1", key0: "credential.helper", value0: "", gcm: "never", prompt: "0" });
  });

  test("ключи GIT_CONFIG_* оператора сохраняются: свои — после них", async () => {
    const seen: Record<string, string>[] = [];
    const prev = { count: process.env.GIT_CONFIG_COUNT, k0: process.env.GIT_CONFIG_KEY_0, v0: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "http.proxy";
    process.env.GIT_CONFIG_VALUE_0 = "http://proxy.local:3128";
    try {
      await cloneBare("https://git@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, {
        spawnGit: (o) => {
          seen.push(o.env);
          return { pid: 1, exited: Promise.resolve(128), stderr: new Response("x").body!, kill: () => {} };
        },
      });
    } finally {
      for (const [k, v] of [["GIT_CONFIG_COUNT", prev.count], ["GIT_CONFIG_KEY_0", prev.k0], ["GIT_CONFIG_VALUE_0", prev.v0]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect({ count: seen[0]!.GIT_CONFIG_COUNT, k0: seen[0]!.GIT_CONFIG_KEY_0, k1: seen[0]!.GIT_CONFIG_KEY_1, v1: seen[0]!.GIT_CONFIG_VALUE_1 }).toEqual({ count: "2", k0: "http.proxy", k1: "credential.helper", v1: "" });
  });

  test("git < 2.31: клон с токеном отказывается (GIT_CONFIG_* там молча не работают), git не запускается", async () => {
    let spawned = 0;
    const out = await cloneBare("https://repo-health:pat@git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, {
      gitVersion: [2, 30, 2],
      spawnGit: () => {
        spawned++;
        throw new Error("git must not be spawned");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("git");
    expect(out.detail).toContain("2.31");
    expect(spawned).toBe(0);
  });

  test("внешний http с кредами: клон отказывается, git не запускается (LOW-9)", async () => {
    let spawned = 0;
    const out = await cloneBare("http://repo-health:pat@git.example.com/o/r.git", tmpdir(), LIMITS, {
      spawnGit: () => {
        spawned++;
        throw new Error("git must not be spawned");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("git");
    expect(out.detail).toContain("git.example.com");
    expect(spawned).toBe(0);
  });

  test("скраб stderr выполняется ДО обрезки: длинный вывод не выносит креды в деталь", async () => {
    const PAT = "pat-leaked-value";
    // Различающий вход: при большем шуме секрет целиком уходит за границу
    // обрезки, и тест проходит благодаря обрезке, а не скрабу. Fatal-строка
    // начинается с индекса noise+1, PAT в ней — с 48-го символа, '@' — на
    // 64-м. Чтобы полный PAT попал в первые 300 символов, а '@' был отрезан:
    // noise+1+48+16 = 300 и noise+1+64 > 300 → noise = 235 (единственное
    // значение). При порядке slice→scrub в detail остается PAT без '@' —
    // регулярка скраба его не матчит, тест красный.
    const noise = "x".repeat(235);
    const stderr = `${noise}\nfatal: could not read from 'https://repo-health:${PAT}@git.sourcecraft.dev/o/r.git'\n`;
    const out = await cloneBare("https://git.sourcecraft.dev/o/r.git", tmpdir(), LIMITS, {
      spawnGit: () => ({
        pid: 1,
        exited: Promise.resolve(128),
        stderr: new Response(stderr).body!,
        kill: () => {},
      }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).not.toContain(PAT);
    expect(out.detail.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Обрыв `cat-file --batch` на уровне коллектора: loc = null,
// loc_note/todo_note = "incomplete". Уровень модели — в
// tests/audit-m42a-repro.test.ts и tests/score.test.ts.
// ---------------------------------------------------------------------------

describe("Ф2.3: обрыв cat-file → loc no-data, а не нулевой LOC", () => {
  test("поток оборвался на первом заголовке: loc=null, loc_note и todo_note = incomplete, file_count цел", async () => {
    const src = buildFixtureRepo();
    const clone = await cloneBare(src, tmpdir(), LIMITS);
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    try {
      const facts = await extractFacts(clone.dir, {
        ...EXTRACT,
        now: NOW,
        // процесс, у которого stdout сразу закончился (убитый cat-file)
        catFile: () => ({
          stdin: { write: () => 0, end: () => 0 },
          stdout: new Response(new Uint8Array(0)).body!,
          exited: Promise.resolve(137),
          kill: () => {},
        }),
      });
      const tree = facts.find((f) => f.key === "tree.stats")!.value as { loc: number | null; loc_note?: string; file_count: number };
      const todo = facts.find((f) => f.key === "code.todo")!.value as { todo_note?: string; count: number };
      expect({ loc: tree.loc, locNote: tree.loc_note, todoNote: todo.todo_note }).toEqual({
        loc: null,
        locNote: "incomplete",
        todoNote: "incomplete",
      });
      expect(tree.file_count).toBeGreaterThan(0); // дерево прочитано — репо НЕ пустое
    } finally {
      cleanupClone(clone.dir);
      rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);

  // git умер раньше, чем писатель отдал ему sha: отказ писателя обработан, а
  // не всплывает необработанным rejection (в Bun это exit 1 процесса сервера
  // посреди скана)
  test("писатель cat-file упал (поток закрыт): извлечение завершается, необработанных отказов нет", async () => {
    const src = buildFixtureRepo();
    const clone = await cloneBare(src, tmpdir(), LIMITS);
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const facts = await extractFacts(clone.dir, {
        ...EXTRACT,
        now: NOW,
        catFile: () => ({
          stdin: {
            write: () => {
              throw new Error("EPIPE: writer closed");
            },
            end: () => 0,
          },
          // поток закрывается не сразу — отказ писателя успевает «повиснуть» без обработчика
          stdout: new ReadableStream<Uint8Array>({ start: (c) => void setTimeout(() => c.close(), 100) }),
          exited: Promise.resolve(141),
          kill: () => {},
        }),
      });
      await Bun.sleep(50);
      const tree = facts.find((f) => f.key === "tree.stats")!.value as { loc: number | null; loc_note?: string };
      expect({ loc: tree.loc, locNote: tree.loc_note, unhandled: unhandled.length }).toEqual({ loc: null, locNote: "incomplete", unhandled: 0 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      cleanupClone(clone.dir);
      rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);

  test("целый поток: loc > 0, пометок неполноты нет", async () => {
    const src = buildFixtureRepo();
    const clone = await cloneBare(src, tmpdir(), LIMITS);
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    try {
      const facts = await extractFacts(clone.dir, { ...EXTRACT, now: NOW });
      const tree = facts.find((f) => f.key === "tree.stats")!.value as { loc: number | null; loc_note?: string };
      const todo = facts.find((f) => f.key === "code.todo")!.value as { todo_note?: string };
      expect({ locPositive: (tree.loc ?? 0) > 0, locNote: tree.loc_note, todoNote: todo.todo_note }).toEqual({
        locPositive: true,
        locNote: undefined,
        todoNote: undefined,
      });
    } finally {
      cleanupClone(clone.dir);
      rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Бюджет клона едет из env через scanFromEnv в Config.scan и реально меняет
// исход клона локального репо.
// ---------------------------------------------------------------------------

describe("Ф2.10: env → Config.scan → поведение клона", () => {
  test("SCAN_CLONE_MAX_BYTES из env роняет клон по диску, без env тот же клон проходит", async () => {
    const src = buildFixtureRepo();
    try {
      const tight = scanFromEnv({ SCAN_CLONE_MAX_BYTES: "1", SCAN_DEGRADE_ENABLED: "false" });
      expect(tight.clone.maxBytes).toBe(1); // env дошёл до конфига
      const failed = await cloneWithDegrade(src, tmpdir(), { ...tight.clone, pollMs: 1, degrade: tight.degrade });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.reason).toBe("disk");

      const wide = scanFromEnv({});
      const okClone = await cloneWithDegrade(src, tmpdir(), { ...wide.clone, pollMs: 1, degrade: wide.degrade });
      expect(okClone.ok).toBe(true);
      if (okClone.ok) cleanupClone(okClone.dir);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  }, 60_000);

  test("SCAN_DEGRADE_ENABLED=false отключает деградационный ярус (тоже из env)", () => {
    expect(scanFromEnv({ SCAN_DEGRADE_ENABLED: "false" }).degrade.enabled).toBe(false);
    expect(scanFromEnv({ SCAN_DEGRADE_ENABLED: "true" }).degrade.enabled).toBe(true);
    expect(scanFromEnv({}).degrade.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Реестр групп клонов: SIGTERM гасит их сразу
// ---------------------------------------------------------------------------

describe("В4.4: killActiveClones", () => {
  test("зарегистрированная setsid-группа убивается; реестр пустеет; незарегистрированное не трогается", async () => {
    const victim = Bun.spawn({ cmd: ["setsid", "sleep", "60"], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const bystander = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    trackCloneGroup(victim.pid);
    await Bun.sleep(150); // setsid обязан успеть стать лидером группы
    const killed = killActiveClones();
    expect(killed).toBe(1);
    expect(killActiveClones()).toBe(0); // реестр пуст
    await victim.exited; // группа убита — setsid/sleep завершены
    // незарегистрированный процесс жив — гасим руками
    expect(bystander.exitCode === null || bystander.exitCode === 0).toBe(true);
    bystander.kill("SIGKILL");
    await bystander.exited;
  }, 15_000);
});
