// Инструменты AI-обзора по клону: grep не подвешивает сервер «взрывным» регэкспом
// (отказ на вложенные повторы, бюджет времени, отдельный процесс с kill), а
// deny-list секретов проверяется по нормализованному пути, а не по сырой строке.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dangerousGrepPattern, executeTool, GREP_KILL_GRACE_MS, GREP_TIME_BUDGET_MS, isDeniedPath, normalizeRelPath } from "../src/summary/tools";

type GrepRes = { ok: boolean; error?: string; matches?: number; truncated?: boolean; timedOut?: boolean; note?: string; lines?: string[] };
const grep = async (root: string, pattern: string, glob?: string): Promise<GrepRes> =>
  JSON.parse(await executeTool({ root, gitDir: null }, "grep", glob === undefined ? { pattern } : { pattern, glob })) as GrepRes;

describe("dangerousGrepPattern: вложенные повторы – отказ, обычные паттерны – нет", () => {
  test("опасные: повтор группы с повтором внутри", () => {
    for (const p of ["(a+)+$", "(\\w+\\s?)+:", "(\\w+\\s*)*\\(", "(.*,)*TODO", "(a*)*b", "(a+)*b", "(a*)+b", "(?:x*){2,}", "((a)+b)*", "(a{1,3})+", "(?<w>\\w+)+:"]) {
      expect(dangerousGrepPattern(p)).not.toBeNull();
    }
  });

  test("безопасные: литералы, одиночные повторы, классы, ограниченные группы", () => {
    for (const p of [
      "TODO",
      "TODO|FIXME",
      "function\\s+\\w+",
      "import .* from",
      "\\w+\\s*=\\s*\\w+",
      "(TODO|FIXME):",
      "(\\d+)\\.(\\d+)",
      "[(+*]+x",
      "\\p{L}+",
      "(?:foo)?bar+",
      "x{2,}",
      "(ab){2}",
      "\\(+\\)",
      "(?=a+)b",
    ]) {
      expect(dangerousGrepPattern(p)).toBeNull();
    }
  });
});

describe("grep: бюджет времени и отдельный процесс", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rh-grep-guard-"));
    const bad = Array(3).fill(`${"a".repeat(3999)}!`).join("\n");
    writeFileSync(join(root, "a.txt"), `first line ok\n${bad}\n`);
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "main.ts"),
      "import { x } from \"./x\";\n// TODO: убрать\nexport function main() {\n  return x;\n}\n",
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("(a+)+$ по строкам aaaa…a! – отказ сразу, с понятной ошибкой", async () => {
    const t = performance.now();
    const res = await grep(root, "(a+)+$");
    const ms = performance.now() - t;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("опасный паттерн");
    expect(ms).toBeLessThan(1500);
  });

  test("полиномиальный паттерн без вложенных повторов – обрывается по бюджету, частичный результат с пометкой", async () => {
    // `.*a.*b` на строке из 4000 «a» в одном процессе идет ~30 с; здесь – не дольше срока kill
    const t = performance.now();
    const res = await grep(root, ".*a.*b|first");
    const ms = performance.now() - t;
    expect(res.ok).toBe(true);
    expect(res.timedOut).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.note).toContain("частичный");
    // строка, найденная до зависшей, не теряется при kill
    expect(res.lines).toEqual(["a.txt:1: first line ok"]);
    expect(ms).toBeLessThan(1500);
    expect(ms).toBeLessThan(GREP_TIME_BUDGET_MS + GREP_KILL_GRACE_MS + 400);
  });

  test("сервер не стоит, пока grep упирается в бюджет: event loop крутится", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 20);
    try {
      await grep(root, "\\w+.*\\w+;");
    } finally {
      clearInterval(iv);
    }
    expect(ticks).toBeGreaterThan(10);
  });

  test("обычные паттерны работают как раньше", async () => {
    const todo = await grep(root, "TODO");
    expect(todo).toMatchObject({ ok: true, matches: 1, truncated: false });
    expect(todo.lines).toEqual(["src/main.ts:2: // TODO: убрать"]);
    expect(todo.timedOut).toBeUndefined();
    const fn = await grep(root, "function\\s+\\w+");
    expect(fn.lines).toEqual(["src/main.ts:3: export function main() {"]);
    const imp = await grep(root, "import .* from", "src/");
    expect(imp.lines).toEqual(['src/main.ts:1: import { x } from "./x";']);
    const none = await grep(root, "NO_SUCH_THING");
    expect(none).toMatchObject({ ok: true, matches: 0, lines: [] });
  });
});

describe("deny-list по нормализованному пути", () => {
  let root = "";
  const SECRET = "TOP_SECRET_VALUE";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rh-deny-guard-"));
    mkdirSync(join(root, "deploy"));
    mkdirSync(join(root, "x"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".env"), `TOKEN=${SECRET}\n`);
    writeFileSync(join(root, "server.pem"), `-----BEGIN ${SECRET}-----\n`);
    writeFileSync(join(root, "deploy", "id_ed25519"), `ssh-key ${SECRET}\n`);
    writeFileSync(join(root, ".git", "config"), `[remote] url = https://user:${SECRET}@host\n`);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const read = async (path: string): Promise<{ ok: boolean; error?: string; content?: string }> =>
    JSON.parse(await executeTool({ root, gitDir: null }, "read_file", { path })) as { ok: boolean; error?: string; content?: string };

  test("normalizeRelPath сводит `.`, `..`, `\\` и хвостовой `/`", () => {
    expect(normalizeRelPath(".env/.")).toBe(".env");
    expect(normalizeRelPath("x/../.env/.")).toBe(".env");
    expect(normalizeRelPath("deploy/id_ed25519/x/..")).toBe("deploy/id_ed25519");
    expect(normalizeRelPath("deploy\\id_ed25519\\")).toBe("deploy/id_ed25519");
    expect(normalizeRelPath("./src/a.ts")).toBe("src/a.ts");
  });

  test("обходные пути к секретам и обычный .env – отказ, содержимое не выдается", async () => {
    const variants = [
      ".env",
      ".env/.",
      "x/../.env/.",
      "./.env",
      ".env/",
      "deploy/id_ed25519/.",
      "deploy/id_ed25519/x/..",
      "deploy\\id_ed25519",
      "server.pem/.",
      "x/../server.pem",
      // имена, которые Windows открывает как тот же файл
      "server.pem.",
      ".env ",
      "server.pem::$DATA",
      ".GIT/config",
      ".git/./config",
    ];
    for (const v of variants) {
      const res = await read(v);
      expect({ v, ok: res.ok }).toEqual({ v, ok: false });
      expect(JSON.stringify(res)).not.toContain(SECRET);
    }
    expect(isDeniedPath("deploy/id_ed25519/x/..")).toBe(true);
    expect(isDeniedPath("server.pem/.")).toBe(true);
  });

  test("обычный файл читается и по ненормализованному пути", async () => {
    for (const p of ["src/a.ts", "./src/a.ts", "x/../src/a.ts", "src\\a.ts"]) {
      const res = await read(p);
      expect({ p, ok: res.ok }).toEqual({ p, ok: true });
      expect(res.content).toBe("export const a = 1;\n");
    }
  });

  test("grep и list_files не отдают содержимое секретов в обход", async () => {
    const g = JSON.parse(await executeTool({ root, gitDir: null }, "grep", { pattern: SECRET })) as { ok: boolean; matches: number };
    expect(g).toMatchObject({ ok: true, matches: 0 });
    const g2 = JSON.parse(await executeTool({ root, gitDir: null }, "grep", { pattern: "BEGIN|ssh-key|TOKEN", glob: "." })) as { matches: number };
    expect(g2.matches).toBe(0);
    for (const sub of ["deploy/id_ed25519/.", "deploy/id_ed25519/x/..", ".env/.", ".git/.", "x/../.git"]) {
      const res = JSON.parse(await executeTool({ root, gitDir: null }, "list_files", { subdir: sub })) as { ok: boolean };
      expect({ sub, ok: res.ok }).toEqual({ sub, ok: false });
    }
    const all = JSON.parse(await executeTool({ root, gitDir: null }, "list_files", {})) as { files: string[] };
    expect(all.files).toContain(".env (denied)");
    expect(all.files).toContain("server.pem (denied)");
    expect(all.files).toContain("deploy/id_ed25519 (denied)");
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });
});
