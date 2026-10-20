// Замер подготовки клона для AI-обзора: «до» и «после» на одном репозитории.
//
//   до    – полный bare-клон (cloneWithDegrade) → git worktree add → README с диска → git log
//   после – неглубокий частичный клон (--depth=30 --filter=blob:none, как у
//           processSummaryJob) → README из git-каталога → git log; рабочая копия –
//           отдельной строкой: обзор платит ее только при первом файловом инструменте
//
// Запуск: bun scripts/measure-summary-clone.ts <org/repo> [--runs N] [--token]
//   --runs N   повторов каждого сценария (по умолчанию 1), в таблице – медиана
//   --token    клонировать с SOURCECRAFT_TOKEN из .env (закрытый репозиторий)
// Сеть: только git-клоны SourceCraft. БД и модель не трогаются.
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { cleanupClone, cloneBare, cloneWithDegrade } from "../src/collectors/git";
import { scanCloneLimitsOf } from "../src/jobs/runner";
import { scanGitUrl } from "../src/jobs/runner";
import { SUMMARY_SHALLOW_CLONE } from "../src/jobs/scheduler";
import { readGitLog, readReadme } from "../src/summary/pipeline";
import { materializeWorktree, removeWorktree } from "../src/summary/tools";

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
if (!slug || !slug.includes("/")) {
  console.error("usage: bun scripts/measure-summary-clone.ts <org/repo> [--runs N] [--token]");
  process.exit(2);
}
const runsAt = argv.indexOf("--runs");
const runs = runsAt >= 0 ? Math.max(1, Number.parseInt(argv[runsAt + 1] ?? "1", 10) || 1) : 1;
const config = loadConfig();
const token = argv.includes("--token") ? config.sourcecraftToken : null;
const [org, repo] = slug.split("/") as [string, string];
const url = scanGitUrl(config.api.gitBase, token, org, repo);
const limits = scanCloneLimitsOf(config.scan);

type Row = { cloneMs: number; bytes: number; worktreeMs: number; readmeMs: number; readmeChars: number; logMs: number; logLines: number; readyMs: number };

const ms = (from: number): number => Date.now() - from;
const lines = (block: string | null): number => (block === null ? 0 : block.split("\n").length - 2);

async function before(): Promise<Row> {
  const clone = await cloneWithDegrade(url, tmpdir(), limits);
  if (!clone.ok) throw new Error(`clone failed: ${clone.reason}: ${clone.detail}`);
  try {
    let t = Date.now();
    // Windows: `git worktree add` падает на длинных путях (Filename too long) – время
    // до сбоя все равно показательно, README и log читаются из git-каталога
    const wt = await materializeWorktree(clone.dir, clone.gitEnv).catch((e: Error) => {
      console.error(`  worktree failed: ${e.message.slice(0, 80)}`);
      return null;
    });
    const worktreeMs = ms(t);
    try {
      const deps = { clone: { root: wt?.root ?? clone.dir, gitDir: clone.dir, gitEnv: clone.gitEnv } };
      t = Date.now();
      const readme = await readReadme(deps);
      const readmeMs = ms(t);
      t = Date.now();
      const log = await readGitLog(deps);
      const logMs = ms(t);
      return { cloneMs: clone.elapsedMs, bytes: clone.bytes, worktreeMs, readmeMs, readmeChars: readme?.length ?? 0, logMs, logLines: lines(log), readyMs: clone.elapsedMs + worktreeMs + readmeMs + logMs };
    } finally {
      if (wt !== null) await removeWorktree(wt.root, wt.gitDir);
    }
  } finally {
    cleanupClone(clone.dir);
  }
}

async function after(): Promise<Row> {
  const clone = await cloneBare(url, tmpdir(), limits, { shallow: SUMMARY_SHALLOW_CLONE });
  if (!clone.ok) throw new Error(`shallow clone failed: ${clone.reason}: ${clone.detail}`);
  let wt: { root: string; gitDir: string } | null = null;
  try {
    const deps = { clone: { root: () => Promise.reject(new Error("worktree must stay lazy")), gitDir: clone.dir, gitEnv: clone.gitEnv } };
    let t = Date.now();
    const readme = await readReadme(deps);
    const readmeMs = ms(t);
    t = Date.now();
    const log = await readGitLog(deps);
    const logMs = ms(t);
    // рабочая копия – то, что обзор платит только при первом файловом инструменте
    t = Date.now();
    wt = await materializeWorktree(clone.dir, clone.gitEnv).catch((e: Error) => {
      console.error(`  worktree failed: ${e.message.slice(0, 80)}`);
      return null;
    });
    const worktreeMs = ms(t);
    return { cloneMs: clone.elapsedMs, bytes: clone.bytes, worktreeMs, readmeMs, readmeChars: readme?.length ?? 0, logMs, logLines: lines(log), readyMs: clone.elapsedMs + readmeMs + logMs };
  } finally {
    if (wt !== null) await removeWorktree(wt.root, wt.gitDir);
    cleanupClone(clone.dir);
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function summarize(rows: Row[]): Row {
  const pick = (k: keyof Row): number => median(rows.map((r) => r[k]));
  return { cloneMs: pick("cloneMs"), bytes: pick("bytes"), worktreeMs: pick("worktreeMs"), readmeMs: pick("readmeMs"), readmeChars: pick("readmeChars"), logMs: pick("logMs"), logLines: pick("logLines"), readyMs: pick("readyMs") };
}

const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;
const sec = (x: number): string => `${(x / 1000).toFixed(1)} s`;

console.log(`repo ${slug}, runs ${runs}, token ${token ? "yes" : "no"}`);
const a: Row[] = [];
const b: Row[] = [];
for (let i = 0; i < runs; i++) {
  const r1 = await before();
  console.log(`  до    #${i + 1}: clone ${sec(r1.cloneMs)} (${mb(r1.bytes)}), worktree ${sec(r1.worktreeMs)}, readme ${r1.readmeMs} ms, log ${r1.logMs} ms`);
  a.push(r1);
  const r2 = await after();
  console.log(`  после #${i + 1}: clone ${sec(r2.cloneMs)} (${mb(r2.bytes)}), readme ${r2.readmeMs} ms, log ${r2.logMs} ms, worktree (лениво) ${sec(r2.worktreeMs)}`);
  b.push(r2);
}
const A = summarize(a);
const B = summarize(b);
console.log("");
console.log("| Шаг | До | После |");
console.log("|---|---|---|");
console.log(`| клон | ${sec(A.cloneMs)}, ${mb(A.bytes)} | ${sec(B.cloneMs)}, ${mb(B.bytes)} |`);
console.log(`| README (${A.readmeChars} симв.) | ${A.readmeMs} ms с диска | ${B.readmeMs} ms из git |`);
console.log(`| git log (${A.logLines} строк) | ${A.logMs} ms | ${B.logMs} ms |`);
console.log(`| рабочая копия | ${sec(A.worktreeMs)} всегда | ${sec(B.worktreeMs)} только при файловом инструменте |`);
console.log(`| готовность входа ролей | ${sec(A.readyMs)} | ${sec(B.readyMs)} |`);
console.log(`| с рабочей копией | ${sec(A.readyMs)} | ${sec(B.readyMs + B.worktreeMs)} |`);
