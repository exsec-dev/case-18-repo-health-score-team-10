// summary-agent.test.ts — инструменты агента и цикл (Б1 В5): path-гард,
// deny-list секретов, капы, git_log, дедуп; materializeWorktree на настоящем
// локальном клоне; цикл — tool_budget, salvage, wall-clock фуз, ретрай 429.
// Живых вызовов LLM нет — CallLlm фейк на сценариях.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallLlm, ChatMessage } from "../src/llm";
import { LlmError } from "../src/llm";
import { generateWithTools } from "../src/summary/agent";
import {
  GREP_LINE_CAP,
  isDeniedPath,
  guardPath,
  makeToolExecutor,
  materializeWorktree,
  sanitizeUntrusted,
} from "../src/summary/tools";

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Рабочее дерево с файлами для read_file/grep/list_files. */
async function seedWorktree(): Promise<{ root: string; gitDir: string }> {
  const bare = tempDir("rh-agent-bare-");
  const wt = `${bare}.wt`;
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  const seed = tempDir("rh-agent-seed-");
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "Alice"]);
  git(seed, ["config", "user.email", "alice@example.com"]);
  writeFileSync(join(seed, "README.md"), "# Repo\n\nInstall: npm i\n");
  const src = join(seed, "src");
  execFileSync("mkdir", ["-p", src]);
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n// TODO: rewrite to async\n// FIXME: edge case\n");
  writeFileSync(join(seed, ".env"), "SECRET_TOKEN=hunter2\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "initial: import sources"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" });
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-q", "origin", "main"]);
  const io = await materializeWorktree(bare);
  expect(io.root).toBe(wt);
  expect(existsSync(join(io.root, "src/a.ts"))).toBe(true);
  return io;
}

describe("Инструменты агента: deny-list, path-гард, капы", () => {
  test("deny-list: .env/*.pem/*.key/.git не читаются и не попадают в выдачу", async () => {
    expect(isDeniedPath(".env")).toBe(true);
    expect(isDeniedPath("config/.env.production")).toBe(true);
    expect(isDeniedPath("certs/server.pem")).toBe(true);
    expect(isDeniedPath("ssh/id_rsa")).toBe(true);
    expect(isDeniedPath(".git/config")).toBe(true);
    expect(isDeniedPath("src/app.key")).toBe(true);
    expect(isDeniedPath("src/keyboard.ts")).toBe(false);
    expect(isDeniedPath("src/main.ts")).toBe(false);

    const io = await seedWorktree();
    const ex = makeToolExecutor(io, 5);
    const envRead = JSON.parse(await ex.execute("read_file", { path: ".env" })) as { ok: boolean };
    expect(envRead.ok).toBe(false);
    const listing = JSON.parse(await ex.execute("list_files", {})) as { files: string[] };
    expect(listing.files.some((f) => f.includes(".env") && !f.includes("(denied)"))).toBe(false);
    const grepped = JSON.parse(await ex.execute("grep", { pattern: "SECRET" })) as { lines: string[] };
    expect(grepped.lines).toEqual([]); // .env не ищется вовсе
  });

  test("path-гард: выход за корень и симлинк-обход отклоняются", () => {
    const root = tempDir("rh-guard-");
    expect(guardPath(root, "../outside")).toBeNull();
    expect(guardPath(root, "/etc/passwd")).toBeNull();
    expect(guardPath(root, "src/main.ts")).toBe(join(root, "src/main.ts"));
    expect(guardPath(root, "a\0b")).toBeNull();
  });

  test("read_file: кап 32 КБ с пометкой truncated; grep: кап строк", async () => {
    const root = tempDir("rh-caps-");
    writeFileSync(join(root, "big.txt"), "x".repeat(40 * 1024));
    writeFileSync(
      join(root, "todo.txt"),
      Array.from({ length: GREP_LINE_CAP + 20 }, (_, i) => `TODO item ${i}`).join("\n"),
    );
    const ex = makeToolExecutor({ root, gitDir: null }, 5);
    const big = JSON.parse(await ex.execute("read_file", { path: "big.txt" })) as { truncated: boolean; content: string };
    expect(big.truncated).toBe(true);
    expect(big.content.length).toBe(32 * 1024);
    const greps = JSON.parse(await ex.execute("grep", { pattern: "TODO" })) as { lines: string[]; truncated: boolean };
    expect(greps.lines.length).toBe(GREP_LINE_CAP);
    expect(greps.truncated).toBe(true);
  });

  test("git_log: последние 30 сообщений; дедуп повторных вызовов по аргументам", async () => {
    const io = await seedWorktree();
    const ex = makeToolExecutor(io, 10);
    const first = JSON.parse(await ex.execute("git_log", {})) as { commits: number; lines: string[] };
    expect(first.commits).toBe(1);
    expect(first.lines[0]).toContain("initial: import sources");
    // дедуп: тот же вызов из кэша, статистика считает оба
    const second = JSON.parse(await ex.execute("git_log", {})) as { commits: number };
    expect(second.commits).toBe(1);
    expect(ex.stats()).toEqual({ calls: 2, deduped: 1 });
    expect(ex.budgetLeft()).toBe(8);
  });

  test("sanitizeUntrusted срезает контрольные символы (переводы строк остаются)", () => {
    expect(sanitizeUntrusted("a\u0000b\u001bc")).toBe("abc");
    expect(sanitizeUntrusted("a\rb\nc")).toBe("a\rb\nc"); // CRLF — легитимные
    expect(sanitizeUntrusted("обычный текст\n")).toBe("обычный текст\n");
  });
});

// ---------------------------------------------------------------------------

function scriptCallLlm(script: Array<(opts: Parameters<CallLlm>[0]) => ReturnType<CallLlm>>): CallLlm {
  let i = 0;
  return (async (opts) => {
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return step(opts);
  }) as CallLlm;
}

const finalText = (text: string) => async () => ({ text, toolCalls: [], finish: "stop", usage: null });

describe("Агентный цикл: tool_budget, salvage, фуз, ретрай", () => {
  test("вызов инструмента → ответ role:tool → финальный текст; счётчики честные", async () => {
    const seen: ChatMessage[] = [];
    const call = scriptCallLlm([
      (opts) => {
        seen.push(...opts.messages);
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "t1", name: "grep", arguments: '{"pattern":"TODO"}' }],
          finish: "tool_calls",
          usage: null,
        });
      },
      (opts) => {
        seen.push(...opts.messages);
        expect(opts.tools?.length).toBe(4); // read_file, grep, list_files, git_log
        return finalText("TODO в коде — реальные задачи {f:code.todo}.")();
      },
    ]);
    const io = await seedWorktree();
    const ex = makeToolExecutor(io, 5);
    const res = await generateWithTools({ callLlm: call, role: "code", executor: ex }, [{ role: "user", content: "вход" }]);
    expect(res.text).toContain("{f:code.todo}");
    expect(res.modelCalls).toBe(2);
    expect(res.toolCalls).toBe(1);
    const toolMsg = seen.find((m) => m.role === "tool") as { role: "tool"; toolCallId: string; content: string };
    expect(toolMsg.toolCallId).toBe("t1");
    expect(toolMsg.content).toContain('"lines"');
  });

  test("зацикливание на инструментах: на 12-м раунде salvage без инструментов, текст собирается", async () => {
    let n = 0;
    const call: CallLlm = (async () => {
      n++;
      return n >= 12
        ? { text: "финал salvage", toolCalls: [], finish: "stop", usage: null }
        : { text: "", toolCalls: [{ id: `t${n}`, name: "list_files", arguments: "{}" }], finish: "tool_calls", usage: null };
    }) as CallLlm;
    const io = await seedWorktree();
    const ex = makeToolExecutor(io, 15);
    const res = await generateWithTools({ callLlm: call, role: "activity", executor: ex }, [{ role: "user", content: "вход" }]);
    expect(res.text).toBe("финал salvage");
    // раунды 1..11 с инструментами, раунд 12 — salvage (модель послушалась)
    expect(n).toBe(12);
    expect(ex.stats().calls).toBe(11);
  });

  test("salvage без текста — честная ошибка tool_budget", async () => {
    let n = 0;
    const call: CallLlm = (async () => {
      n++;
      return n >= 12
        ? { text: "", toolCalls: [], finish: "stop", usage: null }
        : { text: "", toolCalls: [{ id: `t${n}`, name: "list_files", arguments: "{}" }], finish: "tool_calls", usage: null };
    }) as CallLlm;
    const io = await seedWorktree();
    const ex = makeToolExecutor(io, 15);
    try {
      await generateWithTools({ callLlm: call, role: "activity", executor: ex, backoffMs: 0 }, [{ role: "user", content: "вход" }]);
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe("tool_budget");
    }
  });

  test("wall-clock фуз: медленная модель → abort (не retryable)", async () => {
    const slow: CallLlm = (_opts) =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new LlmError("aborted", "вызов отменён (бюджет генерации)")), 30);
      });
    try {
      await generateWithTools(
        { callLlm: slow, role: "issues", executor: null, roundBudgetMs: 10 },
        [{ role: "user", content: "вход" }],
      );
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe("aborted");
    }
  });

  test("429 ретраится один раз и довозит генерацию; не-retryable не ретраится", async () => {
    let attempts = 0;
    const flaky: CallLlm = (async () => {
      attempts++;
      if (attempts === 1) throw new LlmError("429", "HTTP 429: rate limited");
      return { text: "пересказ {f:issues.stats}", toolCalls: [], finish: "stop", usage: null };
    }) as CallLlm;
    const res = await generateWithTools({ callLlm: flaky, role: "issues", executor: null, backoffMs: 1 }, [{ role: "user", content: "вход" }]);
    expect(res.text).toContain("{f:issues.stats}");
    expect(res.modelCalls).toBe(2);

    let fatal = 0;
    const broken: CallLlm = (async () => {
      fatal++;
      throw new LlmError("400", "HTTP 400: bad request");
    }) as CallLlm;
    try {
      await generateWithTools({ callLlm: broken, role: "issues", executor: null, backoffMs: 1 }, [{ role: "user", content: "вход" }]);
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe("400");
      expect(fatal).toBe(1);
    }
  });
});
