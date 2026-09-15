// gen-stress-repo.ts — synthetic stress-repo generator (ТЗ 9.2 boundary testing).
// Builds a git repo via fast-import: N commits, M files, a big binary blob,
// a sprinkle of TODO/FIXME debt. 25k commits import in seconds, not minutes.
//
// Usage:
//   bun scripts/gen-stress-repo.ts [--commits 25000] [--files 12000] \
//     [--blob-size 100] [--todo 50] [--out DIR] [--push REMOTE]
//
// --push: run on a machine whose ssh key may push to the remote, e.g.
//   --push ssh://ssh.sourcecraft.dev/lct-hackaton-2026/case-18-stress-repo.git
//
// No cleanup by default: the generated dir path is printed (delete manually).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

interface Opts {
  commits: number;
  files: number;
  blobMB: number;
  todo: number;
  out?: string;
  push?: string;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { commits: 25_000, files: 12_000, blobMB: 100, todo: 50 };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    const num = () => {
      i++;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad value for ${k}: ${v}`);
      return n;
    };
    if (k === "--commits") o.commits = num();
    else if (k === "--files") o.files = num();
    else if (k === "--blob-size") o.blobMB = num();
    else if (k === "--todo") o.todo = num();
    else if (k === "--out") { i++; o.out = v; }
    else if (k === "--push") { i++; o.push = v; }
    else throw new Error(`unknown flag: ${k}`);
  }
  return o;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const IDENT = "Stress Gen <stress-gen@case-18.local>";
const THREE_YEARS_SEC = 3 * 365 * 24 * 3600;

const README = `# case-18-stress-repo

Синтетический стресс-репозиторий команды 10 (кейс 18 ЛЦТ 2026,
SourceCraft Repo Health). Сгенерирован scripts/gen-stress-repo.ts
для тестирования обработки крупных репозиториев (граница ТЗ 9.2:
20 000 коммитов / 10 000 файлов / 500 МБ). Никакого осмысленного
кода здесь нет; коммиты и файлы — нагрузочная начинка.
`;

function fileContent(idx: number, withTodo: boolean): string {
  const lines: string[] = [
    `// synthetic file ${idx} of the stress suite`,
    "// no meaningful logic here, payload only",
  ];
  if (withTodo) {
    lines.push(`// TODO: synthetic debt #${idx} — never fixed on purpose`);
    lines.push(`// FIXME: legacy marker #${idx}`);
  }
  const filler = `const pad_${idx} = "${"x".repeat(40 + (idx % 60))}";\n`.repeat(3);
  return lines.join("\n") + "\n" + filler;
}

function buildStream(o: Opts): Buffer {
  const chunks: Buffer[] = [];
  const push = (s: string | Buffer) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
  const data = (payload: string | Buffer) => {
    const b = Buffer.from(payload);
    push(`data ${b.length}\n`);
    push(b);
    push("\n");
  };

  // mark :1 — big binary blob
  push("blob\nmark :1\n");
  data(randomBytes(Math.max(1, o.blobMB) * 1024 * 1024));

  const startSec = Math.floor(Date.now() / 1000) - THREE_YEARS_SEC;
  const step = Math.max(1, Math.floor(THREE_YEARS_SEC / Math.max(1, o.commits)));
  const batchEvery = 100; // one file-bearing commit per 100 bulk commits
  const batchCount = Math.max(1, Math.floor(o.commits / batchEvery) - 1);
  const batchSize = Math.max(1, Math.ceil(o.files / batchCount));
  let fileIdx = 0;
  let todoLeft = o.todo;
  const todoEvery = Math.max(1, Math.floor(o.files / (o.todo + 1)));

  for (let c = 1; c <= o.commits; c++) {
    const ts = startSec + c * step;
    push(`commit refs/heads/main\nmark :${c + 1}\ncommitter ${IDENT} ${ts} +0000\n`);
    data(`bulk: synthetic commit ${c}\n`);
    if (c === 1) push("M 100644 :1 assets/large-payload.bin\n");
    if (c === 2) {
      push("M 100644 inline README.md\n");
      data(README);
    }
    if (fileIdx < o.files && c % batchEvery === 0 && c > 2) {
      const take = Math.min(batchSize, o.files - fileIdx);
      for (let k = 0; k < take; k++, fileIdx++) {
        const dir = `src/mod${fileIdx % 200}/pkg${fileIdx % 60}`;
        const withTodo = todoLeft > 0 && fileIdx % todoEvery === 0;
        if (withTodo) todoLeft--;
        push(`M 100644 inline ${dir}/file${fileIdx}.txt\n`);
        data(fileContent(fileIdx, withTodo));
      }
    }
  }
  return Buffer.concat(chunks);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = o.out ?? mkdtempSync(join(tmpdir(), "stress-repo-"));
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Stress Gen");
  git(dir, "config", "user.email", "stress-gen@case-18.local");

  const t0 = Date.now();
  const imp = spawnSync("git", ["fast-import", "--quiet"], {
    cwd: dir,
    input: buildStream(o),
    maxBuffer: 16 * 1024 * 1024 * 1024,
  });
  if (imp.status !== 0) throw new Error(`fast-import failed: ${imp.stderr}`);

  const commits = git(dir, "rev-list", "--count", "HEAD").trim();
  const files = git(dir, "ls-tree", "-r", "--name-only", "HEAD")
    .split("\n")
    .filter(Boolean).length;
  const size = spawnSync("du", ["-sh", join(dir, ".git")], { encoding: "utf8" }).stdout.trim();
  const todoFiles = git(dir, "grep", "-l", "-E", "TODO|FIXME", "HEAD")
    .split("\n")
    .filter(Boolean).length;

  console.log(`готово за ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  директория: ${dir}`);
  console.log(`  коммиты:    ${commits} (просили ${o.commits})`);
  console.log(`  файлы:      ${files} (просили ${o.files} + README + большой блоб)`);
  console.log(`  .git:       ${size}`);
  console.log(`  TODO/FIXME: ${todoFiles} файлов (просили ~${o.todo})`);

  if (o.push) {
    console.log(`push → ${o.push} …`);
    git(dir, "push", o.push, "main");
    console.log("push ок");
  }
}

main();
