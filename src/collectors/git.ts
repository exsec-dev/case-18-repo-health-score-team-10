// git.ts — git-коллектор (план В1, контракт): cloneBare с watchdog
// (du-поллинг + таймаут, tree-kill через setsid-группу), extractFacts
// из bare-клона, cleanup в finally на стороне вызывающего (закон 3:
// клон в tmp → метрики → rm; в БД только факты).
// Tri-state: клон не удался/пустой → факты no-data, не bad.
import { execFile, execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fact, GIT_KINDS, noDataFact, okFact } from "./facts";

export interface CloneLimits {
  /** таймаут субпроцесса клонирования */
  timeoutMs: number;
  /** диск-бюджет: размер bare .git (du) */
  maxBytes: number;
  /** интервал du-поллинга watchdog'а */
  pollMs: number;
}

export const DEFAULT_CLONE_LIMITS: CloneLimits = {
  timeoutMs: 10 * 60_000,
  maxBytes: 500 * 1024 * 1024,
  pollMs: 5_000,
};

export type CloneFailReason = "timeout" | "disk" | "git";

export type CloneOutcome =
  | { ok: true; dir: string; bytes: number; elapsedMs: number }
  | { ok: false; reason: CloneFailReason; detail: string; elapsedMs: number };

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execGit(args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = stderr ?? "";
          reject(err);
        } else {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killTree(pid: number, killSelf: () => void): void {
  // setsid: pid == pgid → отрицательный pid валит всю группу (git + субпроцессы)
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      killSelf();
    } catch {
      /* уже мёртв */
    }
  }
}

/** du -sb: размер каталога в байтах (0 при ошибке/отсутствии) — для watchdog. */
async function duBytes(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFileCb("du", ["-sb", dir], { timeout: 30_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const n = parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

const HAVE_SETSID = Boolean(Bun.which("setsid"));

/**
 * Клонирует `git clone --bare <url>` в свежий tmp-подкаталог. Watchdog:
 * каждые pollMs du-поллинг размера (maxBytes) + проверка таймаута;
 * пробой → kill группы процессов + rm + {ok:false}. Успех → путь клона
 * (очистка — cleanupClone(dir) в finally вызывающего).
 */
export async function cloneBare(
  url: string,
  tmpDir: string = tmpdir(),
  limits: CloneLimits = DEFAULT_CLONE_LIMITS,
): Promise<CloneOutcome> {
  const dir = mkdtempSync(join(tmpDir, "rh-clone-"));
  const started = Date.now();
  const cmd = HAVE_SETSID
    ? ["setsid", "git", "clone", "--bare", url, dir]
    : ["git", "clone", "--bare", url, dir];
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "pipe", stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" } });
  let bytes = 0;
  let breach: "timeout" | "disk" | null = null;
  while (breach === null) {
    const tick = await Promise.race([proc.exited.then(() => "exit" as const), sleep(limits.pollMs).then(() => "poll" as const)]);
    if (tick === "exit") break;
    bytes = await duBytes(dir);
    if (bytes > limits.maxBytes) breach = "disk";
    else if (Date.now() - started > limits.timeoutMs) breach = "timeout";
  }
  if (breach !== null) {
    killTree(proc.pid, () => proc.kill("SIGKILL"));
    await proc.exited.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    const detail =
      breach === "disk"
        ? `bare clone ${bytes} B > budget ${limits.maxBytes} B (du-poll)`
        : `clone exceeded ${limits.timeoutMs} ms timeout`;
    return { ok: false, reason: breach, detail, elapsedMs: Date.now() - started };
  }
  const code = await proc.exited;
  if (code !== 0) {
    let stderr = "";
    try {
      stderr = (await new Response(proc.stderr).text()).trim().slice(0, 300);
    } catch {
      /* stdout/stderr ignore */
    }
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: "git", detail: stderr || `git clone exited ${code}`, elapsedMs: Date.now() - started };
  }
  bytes = await duBytes(dir);
  return { ok: true, dir, bytes, elapsedMs: Date.now() - started };
}

/** Закон 3: клон удаляется сразу после извлечения фактов. */
export function cleanupClone(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Полный набор git-фактов как no-data (клон не удался/пустой). */
export function gitFactsNoData(reason: "limits" | "empty" | "other", detail: string, collectedAt = new Date().toISOString()): Fact[] {
  return GIT_KINDS.map((k) => noDataFact(k, reason, "git", detail, collectedAt));
}

// ---------- robot-эвристика v1 (план В1; сменяема — сырьё хранится полностью) ----------

/** Паттерн: committer name+email содержит robot|sync|bot|-github (case-insensitive). */
export function isRobotPattern(committerName: string, committerEmail: string): boolean {
  const s = `${committerName} ${committerEmail}`.toLowerCase();
  return /robot|sync|bot|-github/.test(s);
}

/**
 * Регулярный интервал: серия ≥6 подряд коммитов (по committer-дате),
 * где каждый Δt в пределах ±20% от медианы Δt серии. Возвращает флаги
 * в порядке входного массива events (ts — ms epoch).
 * Двухфазно (иначе жадный префикс теряет серии, у которых медиана
 * «доезжает» позже): фаза 1 — максимальные отрезки с разбросом
 * max/min ≤ 1.5 (необходимое условие: ±20% от медианы ⇒ 1.2/0.8);
 * фаза 2 — внутри кандидата окна со строгим условием медианы.
 * MAX_RUN капирует патологию (гигантские ровные серии зеркал).
 */
export function robotIntervalFlags(events: { ts: number }[]): boolean[] {
  const flags = new Array<boolean>(events.length).fill(false);
  if (events.length < 6) return flags;
  const order = events.map((e, i) => ({ ts: e.ts, i })).sort((a, b) => a.ts - b.ts || a.i - b.i);
  const deltas: number[] = [];
  for (let k = 1; k < order.length; k++) deltas.push(Math.max(0, order[k].ts - order[k - 1].ts));
  const MAX_RUN = 2000;
  const medOf = (a: number[]): number => {
    const m = a.length >> 1;
    return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
  };
  const insort = (a: number[], v: number): void => {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m]! < v) lo = m + 1;
      else hi = m;
    }
    a.splice(lo, 0, v);
  };
  let i = 0;
  while (i < deltas.length) {
    // фаза 1: кандидат [i..j)
    let min = Infinity;
    let max = -Infinity;
    let j = i;
    const hiCap = Math.min(i + MAX_RUN, deltas.length);
    while (j < hiCap) {
      const d = deltas[j]!;
      if (d < min) min = d;
      if (d > max) max = d;
      if (j > i && max > min * 1.5 + 1e-9) break;
      j++;
    }
    if (j - i >= 5) {
      // фаза 2: строгие окна внутри кандидата (без break: медиана окна
      // может «доехать» до ранних элементов на поздних расширениях)
      for (let s = i; s < j; s++) {
        const win: number[] = [];
        let wmin = Infinity;
        let wmax = -Infinity;
        let bestEnd = -1;
        for (let e = s; e < j; e++) {
          const d = deltas[e]!;
          insort(win, d);
          if (d < wmin) wmin = d;
          if (d > wmax) wmax = d;
          const m = medOf(win);
          if (wmax <= m * 1.2 + 1e-9 && wmin >= m * 0.8 - 1e-9) bestEnd = e;
        }
        if (bestEnd - s + 1 >= 5) {
          for (let k = s; k <= bestEnd + 1; k++) flags[order[k]!.i] = true;
          s = bestEnd; // прыжок за размеченное окно
        }
      }
    }
    i = Math.max(j, i + 1);
  }
  return flags;
}

// ---------- извлечение фактов ----------

export interface TimelineEvent {
  sha: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  robot: boolean;
  robot_reasons: ("committer-pattern" | "regular-interval")[];
}

interface BlobEntry {
  path: string;
  sha: string;
  size: number;
}

const TODO_RE = /\b(TODO|FIXME)\b/;

function toUtc(raw: string): { iso: string; ts: number | null } {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { iso: raw, ts: null };
  return { iso: d.toISOString(), ts: d.getTime() };
}

/** Потоковый читатель байтов stdout (для git cat-file --batch). */
class ByteReader {
  private head: Uint8Array | null = null;
  private off = 0;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  private async refill(): Promise<boolean> {
    if (this.head && this.off < this.head.length) return true;
    const { done, value } = await this.reader.read();
    if (done) {
      this.head = null;
      this.off = 0;
      return false;
    }
    this.head = value;
    this.off = 0;
    return true;
  }
  async readByte(): Promise<number | null> {
    while (!(this.head && this.off < this.head.length)) {
      if (!(await this.refill())) return null;
    }
    return this.head![this.off++]!;
  }
  async readExact(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      while (!(this.head && this.off < this.head.length)) {
        if (!(await this.refill())) return null;
      }
      const take = Math.min(this.head!.length - this.off, n - got);
      out.set(this.head!.subarray(this.off, this.off + take), got);
      this.off += take;
      got += take;
    }
    return out;
  }
  async readLine(maxLen = 8192): Promise<string | null> {
    const bytes: number[] = [];
    for (;;) {
      const b = await this.readByte();
      if (b === null) return bytes.length ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
      if (b === 10) return new TextDecoder().decode(new Uint8Array(bytes));
      bytes.push(b);
      if (bytes.length > maxLen) throw new Error("cat-file: oversized header line");
    }
  }
}

interface TodoOccurrence {
  path: string;
  line: number;
  kind: "TODO" | "FIXME";
}

export interface ExtractOptions {
  /** общий бюджет извлечения (по умолчанию 10 мин, как у клона) */
  deadlineMs?: number;
  /** максимум файлов, прогоняемых через blame (анти-патология) */
  maxBlameFiles?: number;
  /** максимальный размер текстового файла для LOC/TODO (байты) */
  textFileCapBytes?: number;
  now?: Date;
}

/**
 * Извлекает факты из bare-клона (контракт: extractFacts(clone) → Fact[]).
 * Все даты нормализуются в UTC ISO 8601; source="git".
 */
export async function extractFacts(cloneDir: string, opts: ExtractOptions = {}): Promise<Fact[]> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? DEFAULT_CLONE_LIMITS.timeoutMs);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const textCap = opts.textFileCapBytes ?? 1_000_000;
  const maxBlameFiles = opts.maxBlameFiles ?? 200;
  const git = (args: string[], timeoutMs = 120_000) =>
    execGit(["--git-dir", cloneDir, ...args], { timeoutMs });

  // HEAD и пустота репо
  let branch = "HEAD";
  try {
    branch = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim() || "HEAD";
    await git(["rev-parse", "--verify", `${branch}^{commit}`]);
  } catch (e) {
    return gitFactsNoData("empty", `no commits at HEAD (${String((e as Error).message).slice(0, 120)})`, nowIso);
  }

  // --- 1. событийный git-таймлайн ---
  const fmt = "%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1e";
  const logRaw = await git(["log", "-z", `--format=${fmt}`, branch], 300_000);
  const events: TimelineEvent[] = [];
  const committerTs: number[] = [];
  for (const rec of logRaw.stdout.split("\x1e")) {
    const clean = rec.replace(/\0/g, "").trim();
    if (!clean) continue;
    const [sha, an, ae, ad, cn, ce, cd] = clean.split("\x1f");
    if (!sha || !cn) continue;
    const a = toUtc(ad ?? "");
    const c = toUtc(cd ?? "");
    committerTs.push(c.ts ?? 0);
    events.push({
      sha,
      author: { name: an ?? "", email: ae ?? "", date: a.iso },
      committer: { name: cn, email: ce ?? "", date: c.iso },
      robot: false,
      robot_reasons: [],
    });
  }
  const intervalFlags = robotIntervalFlags(events.map((e, i) => ({ ts: committerTs[i] ?? 0 })));
  let robotCommits = 0;
  events.forEach((e, i) => {
    const pattern = isRobotPattern(e.committer.name, e.committer.email);
    const regular = intervalFlags[i] === true;
    e.robot = pattern || regular;
    if (pattern) e.robot_reasons.push("committer-pattern");
    if (regular) e.robot_reasons.push("regular-interval");
    if (e.robot) robotCommits++;
  });

  const committedTs = committerTs.filter((t) => t > 0).sort((a, b) => a - b);
  const authors = new Set(events.map((e) => e.author.email.toLowerCase()));
  const committers = new Set(events.map((e) => e.committer.email.toLowerCase()));
  const timelineFact = okFact("activity.git.timeline", { events }, "git", nowIso);
  const summaryFact = okFact(
    "activity.git.summary",
    {
      commits: events.length,
      authors: authors.size,
      committers: committers.size,
      robot_commits: robotCommits,
      robot_ratio: events.length ? round3(robotCommits / events.length) : null,
      first_committed_at: committedTs.length ? new Date(committedTs[0]!).toISOString() : null,
      last_committed_at: committedTs.length ? new Date(committedTs[committedTs.length - 1]!).toISOString() : null,
    },
    "git",
    nowIso,
  );

  // --- 2. дерево: ls-tree ---
  const treeRaw = await git(["ls-tree", "-l", "-r", "-z", branch], 300_000);
  const blobs: BlobEntry[] = [];
  for (const rec of treeRaw.stdout.split("\0")) {
    if (!rec) continue;
    const meta = rec.slice(0, rec.indexOf("\t"));
    const path = rec.slice(rec.indexOf("\t") + 1);
    const parts = meta.split(/\s+/);
    const size = parts[3];
    if (parts[1] === "blob" && path && size && size !== "-") {
      blobs.push({ path, sha: parts[2] ?? "", size: parseInt(size, 10) });
    }
  }
  const topRaw = await git(["ls-tree", "-z", branch]);
  const topLevel: { name: string; type: string }[] = [];
  for (const rec of topRaw.stdout.split("\0")) {
    if (!rec) continue;
    const parts = rec.slice(0, rec.indexOf("\t")).split(/\s+/);
    topLevel.push({ name: rec.slice(rec.indexOf("\t") + 1), type: parts[1] ?? "" });
  }

  // --- 3. CI-конфиги (канон: полный список .sourcecraft/**) ---
  const scPaths = blobs.map((b) => b.path).filter((p) => p.startsWith(".sourcecraft/")).sort();
  const cicdConfigsFact = okFact(
    "cicd.configs",
    { paths: scPaths, has_ci_yaml: scPaths.includes(".sourcecraft/ci.yaml") },
    "git",
    nowIso,
  );

  // --- 4. документация ---
  const rootNames = topLevel.map((t) => t.name);
  const hasRoot = (re: RegExp) => rootNames.some((n) => re.test(n));
  const docsPresenceFact = okFact(
    "docs.presence",
    {
      readme: hasRoot(/^readme(\.|$)/i),
      license: hasRoot(/^licen[cs]e(\.|$)/i),
      contributing: hasRoot(/^contributing(\.|$)/i),
      codeowners: hasRoot(/^codeowners(\.|$)/i),
    },
    "git",
    nowIso,
  );
  const readmeBlob = blobs.find((b) => /^readme(\.|$)/i.test(b.path) && !b.path.includes("/"));
  let readmeFact: Fact;
  if (readmeBlob) {
    const content = await git(["cat-file", "blob", readmeBlob.sha]);
    const text = content.stdout;
    const sections = (text.match(/^[ \t]{0,3}#{1,6} \S.*$/gm) ?? []).length;
    readmeFact = okFact("docs.readme", { bytes: readmeBlob.size, sections }, "git", nowIso);
  } else {
    readmeFact = okFact("docs.readme", { present: false }, "git", nowIso);
  }

  // --- 5. LOC + TODO/FIXME потоково (git cat-file --batch) ---
  const candidates = blobs.filter((b) => b.size > 0 && b.size <= textCap);
  let loc = 0;
  let locDeadlineHit = false;
  const todoOccs: TodoOccurrence[] = [];
  if (candidates.length > 0) {
    const proc = Bun.spawn(["git", "--git-dir", cloneDir, "cat-file", "--batch"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const enc = new TextEncoder();
    const writer = (async () => {
      for (const b of candidates) proc.stdin.write(enc.encode(`${b.sha}\n`));
      await proc.stdin.end();
    })();
    const reader = new ByteReader(proc.stdout.getReader());
    try {
      for (let i = 0; i < candidates.length; i++) {
        if (Date.now() > deadline) {
          locDeadlineHit = true;
          break;
        }
        const entry = candidates[i]!;
        const header = await reader.readLine();
        if (header === null) break;
        // формат: "<sha> blob <size>" (или "<sha> missing")
        const m = header.match(/^([0-9a-f]+) (?:blob|tag|tree) (\d+)$/);
        if (!m) continue;
        const size = parseInt(m[2]!, 10);
        const buf = await reader.readExact(size);
        await reader.readByte(); // завершающий \n
        if (buf === null) break;
        const probe = buf.subarray(0, Math.min(8192, buf.length));
        if (probe.includes(0)) continue; // бинарный — не текст
        const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const lines = text.split("\n");
        loc += lines.length - 1;
        for (let ln = 0; ln < lines.length; ln++) {
          const kind = todoKind(lines[ln]!);
          if (kind) todoOccs.push({ path: entry.path, line: ln + 1, kind });
        }
      }
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      await writer.catch(() => undefined);
      await proc.exited.catch(() => undefined);
    }
  }

  const treeStatsFact = okFact(
    "tree.stats",
    {
      top_level: topLevel,
      file_count: blobs.length,
      bytes: blobs.reduce((s, b) => s + b.size, 0),
      loc: locDeadlineHit ? null : loc,
      ...(locDeadlineHit ? { loc_note: "deadline" } : {}),
    },
    "git",
    nowIso,
  );

  // --- 6. TODO/FIXME давность по blame ---
  const todoCount = todoOccs.filter((o) => o.kind === "TODO").length;
  const fixmeCount = todoOccs.filter((o) => o.kind === "FIXME").length;
  const byFile = new Map<string, number>();
  for (const o of todoOccs) byFile.set(o.path, (byFile.get(o.path) ?? 0) + 1);
  const todoFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  let older180 = 0;
  let blamedFiles = 0;
  const MS_180D = 180 * 24 * 3600 * 1000;
  for (const [path] of todoFiles.slice(0, maxBlameFiles)) {
    if (Date.now() > deadline) break;
    try {
      const out = await git(["blame", "--porcelain", "-w", "-M", branch, "--", path], 60_000);
      let currentTs: number | null = null;
      let lineNo = 0;
      for (const line of out.stdout.split("\n")) {
        const hm = line.match(/^author-time (\d+)$/);
        if (hm) {
          currentTs = parseInt(hm[1]!, 10) * 1000;
          continue;
        }
        if (line.startsWith("\t")) {
          lineNo++;
          const kind = todoKind(line.slice(1));
          if (kind && currentTs !== null && now.getTime() - currentTs > MS_180D) older180++;
        }
      }
      blamedFiles++;
    } catch {
      /* blame не удался (переименования/субмодули) — файл не в older_180d */
    }
  }
  const codeTodoFact = okFact(
    "code.todo",
    {
      count: todoCount,
      fixme: fixmeCount,
      older_180d: older180,
      todo_files: todoFiles.length,
      blamed_files: blamedFiles,
    },
    "git",
    nowIso,
  );

  return [timelineFact, summaryFact, docsPresenceFact, readmeFact, treeStatsFact, cicdConfigsFact, codeTodoFact];
}

function todoKind(line: string): "TODO" | "FIXME" | null {
  const m = line.match(TODO_RE);
  if (!m) return null;
  return m[1] === "FIXME" ? "FIXME" : "TODO";
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
