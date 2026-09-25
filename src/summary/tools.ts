// tools.ts — инструменты агента чтения репозитория (спека В5 §3.3):
// read-only, root = рабочий каталог клона, path-гард, капы на выдачу,
// deny-list секретов (содержимое не читается и не попадает в выдачу).
// Результаты инструмента — НЕдоверенные данные: контрольные символы
// срезаются, объём капится; дедуп повторных вызовов по аргументам — на
// исполнителе (см. makeToolExecutor). git_log — по --git-dir клона
// (последние 30 сообщений, без диффов).
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ToolSpec } from "../llm";

/** Локальный git без блокировки event loop (воркер живёт в процессе сервера). */
async function runGit(args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`git ${args[0]}: exit ${exitCode}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

export const READ_FILE_CAP_BYTES = 32 * 1024;
export const GREP_LINE_CAP = 50;
export const GREP_LINE_CHARS = 200;
export const LIST_FILES_CAP = 500;
export const GIT_LOG_CAP = 30;
/** потолок файлов, обходимых grep (предохранитель больших деревьев) */
export const GREP_FILE_CAP = 2000;
/**
 * В5.1 (Прод-З3): кап размера ДО чтения — файлы больше капа получают честный
 * отказ, содержимое целиком в память не тянется (всплеск кучи до санитайза).
 */
export const MAX_PLAIN_READ_BYTES = 1024 * 1024;

/** Путь к секретам: содержимое не читается и в выдачу не попадает (спека §3.3). */
const SECRET_DENYLIST: RegExp[] = [
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.git($|\/)/,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa[^/]*$/i,
  /(^|\/)\.gitconfig$/i,
  /credentials?\.(json|txt|ya?ml)$/i,
  // В5.1 (Security-С1): распространённые классы, читавшиеся и сканировавшиеся grep
  /(^|\/)secrets[^/]*\.json$/i,
  /\.(p12|pfx|jks)$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  // В5.2 (Б7, хвосты аудита В5.1): SSH-ключи любого алгоритма вне .ssh/ (deploy/id_ed25519,
  // id_ecdsa, id_dsa) и ключи сервисных аккаунтов Firebase
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?[^/]*$/i,
  /(^|\/)[^/]*firebase-adminsdk[^/]*\.json$/i,
];

export function isDeniedPath(relPath: string): boolean {
  const norm = relPath.replaceAll("\\", "/");
  return SECRET_DENYLIST.some((re) => re.test(norm));
}

/**
 * Path-гард: относительный путь внутри root, без выхода наружу. Возвращает
 * абсолютный путь или null (симлинки и `..` наружу — отказ, не исключение).
 */
export function guardPath(root: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.includes("\0")) return null;
  const absRoot = resolve(root);
  const abs = resolve(absRoot, relPath);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null;
  return abs;
}

/**
 * В5.1 (Security-К1): прежний гард на симлинки был мёртв — `statSync`
 * СЛЕДУЕТ по ссылке, и флаг isSymbolicLink для неё всегда false. Проверка
 * lstatSync по каждому компоненту пути между root и целью: трекнутый
 * симлинк (в том числе на файл хоста вне root) — отказ для read_file,
 * grep и list_files. Нечитаемый компонент — тоже отказ.
 */
function hasSymlinkComponent(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  if (rel.length === 0) return false;
  let cur = root;
  for (const part of rel.split(sep).filter((p) => p.length > 0)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Результат инструмента — недоверенные данные: контрольные символы вон.
 *  В5.1 (Security-З1): полоса расширена bidi/zero-width (RLO, ZWSP, BOM) —
 *  визуальный спуфинг не проезжает ни в промпт, ни в валидатор. */
export function sanitizeUntrusted(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Прочитай файл из репозитория (до 32 КБ). path — путь от корня репозитория. " +
        "Файлы секретов (.env, *.pem, *.key, .git) не читаются никогда.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Путь от корня репозитория, например src/main.ts" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Найди регуляркой строки в текстовых файлах репозитория (до 50 строк выдачи). " +
        "Например, паттерн TODO|FIXME покажет пометки долга с текстами.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Регулярное выражение (JavaScript-синтаксис)" },
          glob: { type: "string", description: "Необязательный фильтр путей, например src/ или *.ts" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Покажи файлы и каталоги репозитория (до 500 путей). subdir — необязательный подкаталог.",
      parameters: {
        type: "object",
        properties: { subdir: { type: "string", description: "Необязательный подкаталог от корня" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Последние 30 коммит-сообщений (автор и тема, без диффов).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/** Спецификация калькулятора (23.09, Алексей: арифметика — инструментом,
 *  не в уме); доступен в т.ч. security, которой файловые инструменты запрещены. */
export const CALCULATOR_SPEC: ToolSpec = {
  type: "function",
  function: {
    name: "calculate",
    description:
      "Посчитай арифметическое выражение точно: числа, + - * / ( ). " +
      "Например, перевод доли в проценты: 0.866*100 → 86.6. Буквы и чужой текст в выражении запрещены.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "Арифметическое выражение, например 0.866*100 или (1-0.2)/4" } },
      required: ["expression"],
    },
  },
};

/**
 * Безопасный калькулятор: рекурсивный спуск по грамматике
 * expr := term (('+'|'-') term)*; term := factor (('*'|'/') factor)*;
 * factor := ['-'] ('(' expr ')' | число). Буквы и прочий мусор
 * грамматикой отсекаются — никакого eval, никакой инъекции.
 */
export function evaluateArithmetic(input: string): number | null {
  const src = input.replace(/,/g, ".").replace(/\s+/g, "");
  if (src.length === 0 || src.length > 120 || !/^[0-9.()+\-*/]+$/.test(src)) return null;
  let pos = 0;
  const peek = (): string | null => (pos < src.length ? src[pos]! : null);
  const parseExpr = (): number | null => {
    const first = parseTerm();
    if (first === null) return null;
    let acc = first;
    while (peek() === "+" || peek() === "-") {
      const op = src[pos++]!;
      const rhs = parseTerm();
      if (rhs === null) return null;
      acc = op === "+" ? acc + rhs : acc - rhs;
    }
    return acc;
  };
  const parseTerm = (): number | null => {
    const first = parseFactor();
    if (first === null) return null;
    let acc = first;
    while (peek() === "*" || peek() === "/") {
      const op = src[pos++]!;
      const rhs = parseFactor();
      if (rhs === null) return null;
      if (op === "/" && rhs === 0) return null;
      acc = op === "*" ? acc * rhs : acc / rhs;
    }
    return acc;
  };
  const parseFactor = (): number | null => {
    if (peek() === "-") {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (peek() === "+") {
      pos++;
      return parseFactor();
    }
    if (peek() === "(") {
      pos++;
      const v = parseExpr();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(pos));
    if (num === null) return null;
    pos += num[0].length;
    const v = Number(num[0]);
    return Number.isFinite(v) ? v : null;
  };
  const result = parseExpr();
  if (result === null || pos !== src.length || !Number.isFinite(result)) return null;
  return result;
}

export interface ToolExecutorIo {
  /** корень рабочей копии клона (файлы для read_file/grep/list_files) */
  root: string;
  /** git-каталог (bare-клон или .git) для git_log; null → git_log отказом */
  gitDir: string | null;
}

function listFilesRec(root: string, dir: string, out: string[], cap: number): void {
  if (out.length >= cap) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= cap) return;
    const abs = join(dir, name);
    const rel = relative(root, abs).replaceAll("\\", "/");
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // симлинки не читаем и не показываем как читаемые (В5.1, Security-К1)
    if (st.isDirectory()) {
      if (name === ".git" || name === "node_modules") continue;
      out.push(`${rel}/`);
      listFilesRec(root, abs, out, cap);
    } else if (isDeniedPath(rel)) {
      out.push(`${rel} (denied)`);
    } else {
      out.push(rel);
    }
  }
}

/** Исполнение одного инструмента; возвращает СТРОКУ (едет в role:"tool"). */
export async function executeTool(io: ToolExecutorIo, name: string, args: unknown): Promise<string> {
  const fail = (error: string): string => JSON.stringify({ ok: false, error });
  try {
    if (name === "read_file") {
      const rel = (args as { path?: unknown } | null)?.path;
      if (typeof rel !== "string") return fail("ожидался аргумент path: строка");
      if (isDeniedPath(rel)) return fail("denied: путь к секретам — содержимое не выдаётся");
      const abs = guardPath(io.root, rel);
      if (abs === null) return fail("denied: путь вне корня репозитория");
      if (hasSymlinkComponent(io.root, abs)) return fail("denied: путь содержит симлинк — содержимое не выдаётся");
      let st;
      try {
        st = statSync(abs);
      } catch {
        return fail(`файл не найден: ${sanitizeUntrusted(rel)}`);
      }
      if (st.isDirectory()) return fail("это каталог, а не файл");
      // В5.1 (Прод-З3): честный отказ ДО чтения — гигантский файл не всплёскивает кучу
      if (st.size > MAX_PLAIN_READ_BYTES) return fail(`denied: файл больше 1 МБ (${st.size} байт) — чтение отклонено`);
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8192).includes(0)) return fail("бинарный файл — текст не выдаётся");
      const truncated = buf.length > READ_FILE_CAP_BYTES;
      const body = sanitizeUntrusted(buf.subarray(0, READ_FILE_CAP_BYTES).toString("utf8"));
      return JSON.stringify({ ok: true, path: rel, truncated, content: body });
    }
    if (name === "grep") {
      const a = args as { pattern?: unknown; glob?: unknown } | null;
      if (typeof a?.pattern !== "string" || a.pattern.length === 0) return fail("ожидался аргумент pattern: строка");
      let re: RegExp;
      try {
        re = new RegExp(a.pattern);
      } catch (e) {
        return fail(`неверный паттерн: ${String((e as Error).message).slice(0, 100)}`);
      }
      const glob = typeof a.glob === "string" && a.glob.length > 0 ? a.glob : null;
      const files: string[] = [];
      listFilesRec(io.root, io.root, files, GREP_FILE_CAP);
      const lines: string[] = [];
      let scanned = 0;
      for (const rel of files) {
        if (lines.length >= GREP_LINE_CAP) break;
        if (scanned >= GREP_FILE_CAP) break;
        if (rel.endsWith("/") || rel.endsWith("(denied)")) continue;
        if (isDeniedPath(rel)) continue;
        if (glob !== null && !rel.includes(glob)) continue;
        const abs = join(io.root, rel);
        // В5.1 (Прод-З3): кап размера ДО чтения — гигантский файл не читается
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_PLAIN_READ_BYTES) continue;
        scanned++;
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        if (buf.subarray(0, 8192).includes(0)) continue;
        const text = sanitizeUntrusted(buf.toString("utf8"));
        const split = text.split("\n");
        for (let i = 0; i < split.length && lines.length < GREP_LINE_CAP; i++) {
          if (re.test(split[i]!)) {
            lines.push(`${rel}:${i + 1}: ${split[i]!.trim().slice(0, GREP_LINE_CHARS)}`);
          }
        }
      }
      return JSON.stringify({
        ok: true,
        matches: lines.length,
        truncated: lines.length >= GREP_LINE_CAP || scanned >= GREP_FILE_CAP,
        lines,
      });
    }
    if (name === "list_files") {
      const sub = (args as { subdir?: unknown } | null)?.subdir;
      let base = io.root;
      if (typeof sub === "string" && sub.length > 0) {
        if (isDeniedPath(sub)) return fail("denied: путь к секретам — содержимое не выдаётся");
        const abs = guardPath(io.root, sub);
        if (abs === null) return fail("denied: путь вне корня репозитория");
        if (hasSymlinkComponent(io.root, abs)) return fail("denied: путь содержит симлинк — содержимое не выдаётся");
        base = abs;
      }
      const out: string[] = [];
      listFilesRec(io.root, base, out, LIST_FILES_CAP);
      return JSON.stringify({ ok: true, truncated: out.length >= LIST_FILES_CAP, files: out });
    }
    if (name === "git_log") {
      if (io.gitDir === null) return fail("git-история недоступна");
      const fmt = "%h %an%x09%s";
      const out = await runGit(["--git-dir", io.gitDir, "log", `-${GIT_LOG_CAP}`, `--format=${fmt}`], 30_000);
      const lines = out
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => sanitizeUntrusted(l).slice(0, GREP_LINE_CHARS));
      return JSON.stringify({ ok: true, commits: lines.length, lines });
    }
    return fail(`неизвестный инструмент: ${sanitizeUntrusted(String(name))}`);
  } catch (e) {
    return fail(`инструмент упал: ${String((e as Error).message).slice(0, 160)}`);
  }
}

export interface ToolExecutor {
  specs: ToolSpec[];
  /** вызов инструмента с дедупом по (имя, аргументы); возвращает content для role:"tool" */
  execute: (name: string, args: unknown) => Promise<string>;
  /** сколько вызовов осталось до капа (модель видит счётчик) */
  budgetLeft: () => number;
  /** итог: сколько вызовов исполнено / сколько из них из кэша */
  stats: () => { calls: number; deduped: number };
}

/**
 * Материализовать рабочую копию HEAD из bare-клона (`git worktree add`):
 * инструменты read_file/grep/list_files работают по файлам, а клон скана —
 * bare. Worktree создаётся рядом, внутри bare-репо появляется служебная
 * запись worktrees — уходит вместе с ним при cleanupClone. Сбой — исключение:
 * без файлов агентная стадия с инструментами не начинается.
 */
export async function materializeWorktree(bareDir: string): Promise<{ root: string; gitDir: string }> {
  const root = `${bareDir}.wt`;
  await runGit(["--git-dir", bareDir, "worktree", "add", "--detach", root, "HEAD"], 120_000);
  return { root, gitDir: bareDir };
}

/** Снять worktree (явный git-dir: вызов может идти из чужого репозитория). */
export async function removeWorktree(root: string, gitDir?: string): Promise<void> {
  try {
    const args = gitDir !== undefined ? ["--git-dir", gitDir, "worktree", "remove", "--force", root] : ["worktree", "remove", "--force", root];
    await runGit(args, 60_000);
  } catch {
    /* уборку догонит свип осиротевших клонов (глоб rh-clone-* матчит .wt-сиблинг) */
  }
}

/** Дописать модели остаток бюджета в результат инструмента (В5.1, Ищейка-С3). */
function withBudgetLeft(result: string, left: number): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown> | null;
    if (parsed !== null && typeof parsed === "object") return JSON.stringify({ budgetLeft: left, ...parsed });
    return result;
  } catch {
    return result;
  }
}

/**
 * Исполнитель с дедупом: повторные вызовы по тем же аргументам отдают
 * закэшированный результат, модель не крутится на одном месте за счёт
 * диска и процессов. Бюджет считает ВСЕ вызовы (и кэшированные) —
 * зациклиться на инструментах нельзя. В5.1 (Ищейка-С3): бюджет
 * ПРИНУЖДАЕТСЯ — исчерпание → честный отказ вызова (не молчаливое
 * исполнение сверх капа), остаток показывается модели в каждом результате.
 */
export function makeToolExecutor(io: ToolExecutorIo, toolBudget: number): ToolExecutor {
  const cache = new Map<string, string>();
  let calls = 0;
  let deduped = 0;
  const left = (): number => Math.max(0, toolBudget - calls);
  return {
    specs: TOOL_SPECS,
    budgetLeft: left,
    stats: () => ({ calls, deduped }),
    async execute(name, args) {
      if (left() <= 0) {
        return JSON.stringify({ ok: false, budgetLeft: 0, error: "бюджет инструментов исчерпан — вызовы больше не исполняются" });
      }
      calls++;
      const key = `${name}:${JSON.stringify(args ?? null)}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        deduped++;
        return withBudgetLeft(hit, left());
      }
      const result = await executeTool(io, name, args);
      cache.set(key, result);
      return withBudgetLeft(result, left());
    },
  };
}

/**
 * Калькулятор-исполнитель (23.09, Алексей: «с арифметикой не проще ему
 * пользоваться инструментами?»): ТОЛЬКО calculate — никакого доступа к
 * репо. Для security, которой файловые инструменты запрещены законом 5,
 * арифметика при этом доступна: процент из доли считается инструментом,
 * а не в уме.
 */
export function makeCalculatorExecutor(toolBudget = 6): ToolExecutor {
  let calls = 0;
  const left = (): number => Math.max(0, toolBudget - calls);
  return {
    specs: [CALCULATOR_SPEC],
    budgetLeft: left,
    stats: () => ({ calls, deduped: 0 }),
    async execute(name, args) {
      if (left() <= 0) {
        return JSON.stringify({ ok: false, budgetLeft: 0, error: "бюджет инструментов исчерпан — вызовы больше не исполняются" });
      }
      if (name !== "calculate") {
        return JSON.stringify({ ok: false, budgetLeft: left(), error: "denied: доступен только calculate" });
      }
      calls++;
      const expr = (args as { expression?: unknown } | null)?.expression;
      if (typeof expr !== "string") {
        return JSON.stringify({ ok: false, budgetLeft: left(), error: "ожидался аргумент expression: строка" });
      }
      const value = evaluateArithmetic(expr);
      if (value === null) {
        return JSON.stringify({ ok: false, budgetLeft: left(), error: "выражение не арифметическое (разрешены числа и + - * / ( ))" });
      }
      const rounded = Math.round(value * 1000) / 1000;
      return withBudgetLeft(JSON.stringify({ ok: true, result: rounded, expression: expr }), left());
    },
  };
}
