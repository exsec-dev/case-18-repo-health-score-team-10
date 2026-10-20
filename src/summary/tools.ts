// Инструменты агента для чтения репозитория: только чтение, root = рабочий каталог
// клона, path-гард, капы на выдачу, deny-list секретов (содержимое не читается).
// Результат инструмента — НЕдоверенные данные: контрольные символы срезаются,
// объем капится. Дедуп повторных вызовов — в исполнителе (makeToolExecutor).
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolSpec } from "../llm";

/** Локальный git без блокировки event loop (воркер живёт в процессе сервера). */
async function runGit(args: string[], timeoutMs: number, env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env === undefined ? undefined : { ...(process.env as Record<string, string>), ...env } });
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
/** Предел длины паттерна grep: паттерн пишет модель, длинный регэксп – повод отказать, а не выполнять. */
export const GREP_PATTERN_MAX = 200;
/** Сколько символов строки проверяется регэкспом: ограничивает работу на строку, но НЕ время –
 *  «взрывной» паттерн тратит секунды и на 4000 символах, время держат бюджет и отдельный процесс ниже. */
export const GREP_MATCH_CHARS = 4000;
/**
 * Общий бюджет времени одного вызова grep (обход и регэкспы). Проверяется между
 * файлами и строками; по исчерпании – честный частичный результат с пометкой.
 */
export const GREP_TIME_BUDGET_MS = 800;
/**
 * Запас сверх бюджета до принудительного завершения процесса grep. Одну строку
 * регэксп не прерывает: `.*a.*b` на строке из 4000 «a» идет ~30 с, `\w+.*\w+;` –
 * минуты (предел перебора JSC ловит только экспоненту, полином – нет). Поэтому
 * grep идет в отдельном процессе: сервер не стоит, а зависшую строку снимает kill.
 */
export const GREP_KILL_GRACE_MS = 300;
export const LIST_FILES_CAP = 500;
export const GIT_LOG_CAP = 30;
/** потолок файлов, обходимых grep (предохранитель больших деревьев) */
export const GREP_FILE_CAP = 2000;
/**
 * Кап размера ДО чтения: файл больше капа получает отказ, а не читается
 * целиком в память (иначе всплеск кучи еще до санитизации).
 */
export const MAX_PLAIN_READ_BYTES = 1024 * 1024;

/** Путь к секретам: содержимое не читается и в выдачу не попадает. */
const SECRET_DENYLIST: RegExp[] = [
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.git($|\/)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa[^/]*$/i,
  /(^|\/)\.gitconfig$/i,
  /credentials?\.(json|txt|ya?ml)$/i,
  /(^|\/)secrets[^/]*\.json$/i,
  /\.(p12|pfx|jks)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  // SSH-ключи любого алгоритма вне .ssh/ (deploy/id_ed25519) и ключи сервисных аккаунтов Firebase
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?[^/]*$/i,
  /(^|\/)[^/]*firebase-adminsdk[^/]*\.json$/i,
];

/**
 * Канонический относительный путь для deny-list: разделители `/`, без `.`, `..`
 * и пустых сегментов. Сырая строка обходила запрет: `.env/.`, `x/../.env/.`,
 * `deploy/id_ed25519/x/..` после resolve открывают тот же секрет.
 */
export function normalizeRelPath(relPath: string): string {
  const parts: string[] = [];
  for (const seg of relPath.replaceAll("\\", "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Имя так, как его откроет Windows: хвостовые точки и пробелы отбрасываются,
 *  `имя:поток` читает сам файл (`server.pem.`, `.env `, `server.pem::$DATA`). */
function windowsName(seg: string): string {
  const bare = seg.replace(/:.*$/, "").replace(/[. ]+$/, "");
  return bare.length > 0 ? bare : seg;
}

export function isDeniedPath(relPath: string): boolean {
  const norm = normalizeRelPath(relPath);
  const win = norm.split("/").map(windowsName).join("/");
  return SECRET_DENYLIST.some((re) => re.test(norm) || re.test(win));
}

/**
 * Запрет по пути, который реально откроется, – после guardPath: относительный от
 * корня после resolve и, если цель есть, после realpath (регистр, короткие имена
 * 8.3 и прочие псевдонимы файловой системы сводятся к настоящему имени).
 */
function isDeniedResolved(root: string, abs: string): boolean {
  if (isDeniedPath(relative(resolve(root), abs))) return true;
  let real: string;
  try {
    real = relative(realpathSync.native(root), realpathSync.native(abs));
  } catch {
    return false; // цели нет – дальше отказ «не найден»
  }
  return isDeniedPath(real);
}

/**
 * Path-гард: относительный путь внутри root, без выхода наружу. Возвращает
 * абсолютный путь или null (симлинки и `..` наружу — отказ, не исключение).
 */
export function guardPath(root: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.includes("\0")) return null;
  const absRoot = resolve(root);
  // `\` – разделитель и на Linux: модель пишет пути как на Windows, deny-list читает их так же
  const abs = resolve(absRoot, relPath.replaceAll("\\", "/"));
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null;
  return abs;
}

/**
 * lstatSync по каждому компоненту пути между root и целью (`statSync` следует
 * по ссылке и симлинк не видит). Закоммиченный симлинк, в том числе на файл
 * хоста вне root, — отказ для read_file, grep и list_files. Нечитаемый компонент — тоже отказ.
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

/** Результат инструмента — недоверенные данные: контрольные символы вон, включая
 *  bidi/zero-width (RLO, ZWSP, BOM), чтобы визуальный спуфинг не попал ни в промпт, ни в валидатор. */
export function sanitizeUntrusted(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}

/** \u0427\u0435\u043c \u0437\u0430\u043c\u0435\u043d\u044f\u0435\u0442\u0441\u044f \u0441\u0442\u0440\u043e\u043a\u0430 \u043d\u0435\u0434\u043e\u0432\u0435\u0440\u0435\u043d\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445, \u043f\u043e\u0445\u043e\u0436\u0430\u044f \u043d\u0430 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044e \u043c\u043e\u0434\u0435\u043b\u0438. */
export const INSTRUCTION_PLACEHOLDER = "[\u0441\u0442\u0440\u043e\u043a\u0430 \u0443\u0434\u0430\u043b\u0435\u043d\u0430: \u043f\u043e\u0445\u043e\u0436\u0430 \u043d\u0430 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044e \u0434\u043b\u044f \u043c\u043e\u0434\u0435\u043b\u0438]";

/**
 * \u0421\u0442\u0440\u043e\u043a\u0438 \u043d\u0435\u0434\u043e\u0432\u0435\u0440\u0435\u043d\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445, \u043a\u043e\u0442\u043e\u0440\u044b\u0435 \u043e\u0431\u0440\u0430\u0449\u0430\u044e\u0442\u0441\u044f \u043a \u043c\u043e\u0434\u0435\u043b\u0438, \u0430 \u043d\u0435 \u043a \u0447\u0438\u0442\u0430\u0442\u0435\u043b\u044e \u043a\u043e\u0434\u0430.
 * \u041c\u0435\u0445\u0430\u043d\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u0441\u043b\u043e\u0439 \u043f\u043e\u0432\u0435\u0440\u0445 \u043f\u0440\u0430\u0432\u0438\u043b\u0430 \u00ab\u0434\u0430\u043d\u043d\u044b\u0435 \u2013 \u043d\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438\u00bb: \u0442\u0430\u043a\u0438\u0435 \u0441\u0442\u0440\u043e\u043a\u0438 \u0434\u043e
 * \u043c\u043e\u0434\u0435\u043b\u0438 \u043d\u0435 \u0434\u043e\u0445\u043e\u0434\u044f\u0442 \u0432\u043e\u0432\u0441\u0435, \u043d\u0430 \u0438\u0445 \u043c\u0435\u0441\u0442\u0435 \u043e\u0441\u0442\u0430\u0435\u0442\u0441\u044f \u043f\u043e\u043c\u0435\u0442\u043a\u0430. \u0424\u0438\u043b\u044c\u0442\u0440 \u043d\u0430\u043c\u0435\u0440\u0435\u043d\u043d\u043e
 * \u0443\u0437\u043a\u0438\u0439: \u043b\u043e\u0432\u0438\u0442 \u043f\u0435\u0440\u0435\u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u0438\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0439, \u0437\u0430\u043f\u0440\u043e\u0441 \u0441\u0438\u0441\u0442\u0435\u043c\u043d\u043e\u0433\u043e \u043f\u0440\u043e\u043c\u043f\u0442\u0430, \u043f\u0440\u044f\u043c\u043e\u0435
 * \u043e\u0431\u0440\u0430\u0449\u0435\u043d\u0438\u0435 \u043a \u0418\u0418 \u0441 \u043f\u043e\u0432\u0435\u043b\u0435\u043d\u0438\u0435\u043c \u0438 \u043f\u043e\u0434\u0434\u0435\u043b\u043a\u0443 \u0440\u0430\u043c\u043e\u043a \u0432\u0445\u043e\u0434\u0430. \u0422\u043e\u043a\u0435\u043d\u044b \u0440\u043e\u043b\u0435\u0439 \u0447\u0430\u0442-\u0448\u0430\u0431\u043b\u043e\u043d\u043e\u0432
 * (`<|im_start|>system`, `[INST]`, \u00abYou are a helpful assistant\u00bb) \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0435\u0439
 * \u041d\u0415 \u0441\u0447\u0438\u0442\u0430\u044e\u0442\u0441\u044f: \u0432 ML-\u043f\u0440\u043e\u0435\u043a\u0442\u0430\u0445 \u044d\u0442\u043e \u043e\u0431\u044b\u0447\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435, \u0438 \u0441\u0430\u043c\u0438 \u043f\u043e \u0441\u0435\u0431\u0435 \u043e\u043d\u0438 \u043d\u0438\u0447\u0435\u0433\u043e
 * \u043d\u0430\u0448\u0435\u0439 \u043c\u043e\u0434\u0435\u043b\u0438 \u043d\u0435 \u0432\u0435\u043b\u044f\u0442.
 */
// `\b` \u0432 JS \u043d\u0435 \u0437\u043d\u0430\u0435\u0442 \u043a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u044b, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u0433\u0440\u0430\u043d\u0438\u0446\u044b \u0441\u043b\u043e\u0432 \u2013 \u0447\u0435\u0440\u0435\u0437 \p{L} \u0441 \u0444\u043b\u0430\u0433\u043e\u043c u
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const re = (src: string): RegExp => new RegExp(src, "iu");
const INSTRUCTION_LINE_PATTERNS: RegExp[] = [
  // \u00abignore/disregard/forget (all|previous|prior|above|earlier) instructions/prompt/rules\u00bb
  re(`${B}(ignore|disregard|forget|override)${E}[^\\n]{0,40}${B}(previous|prior|above|earlier|all|any)${E}[^\\n]{0,30}${B}(instruction|prompt|rule|direction|guideline)s?${E}`),
  // \u00ab\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439/\u0437\u0430\u0431\u0443\u0434\u044c/\u043e\u0442\u0431\u0440\u043e\u0441\u044c (\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0438\u0435|\u043f\u0440\u0435\u0436\u043d\u0438\u0435|\u0432\u0441\u0435|\u0432\u044b\u0448\u0435\u0443\u043a\u0430\u0437\u0430\u043d\u043d\u044b\u0435) \u0443\u043a\u0430\u0437\u0430\u043d\u0438\u044f/\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438/\u043f\u0440\u0430\u0432\u0438\u043b\u0430/\u0445\u0430\u0440\u0442\u0438\u044e\u00bb
  re(`${B}(\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439\u0442\u0435|\u0437\u0430\u0431\u0443\u0434\u044c|\u0437\u0430\u0431\u0443\u0434\u044c\u0442\u0435|\u043e\u0442\u0431\u0440\u043e\u0441\u044c|\u043e\u0442\u0431\u0440\u043e\u0441\u044c\u0442\u0435|\u043d\u0435 \u0443\u0447\u0438\u0442\u044b\u0432\u0430\u0439|\u043d\u0435 \u0443\u0447\u0438\u0442\u044b\u0432\u0430\u0439\u0442\u0435)${E}[^\\n]{0,40}${B}(\u043f\u0440\u0435\u0434\u044b\u0434\u0443\u0449|\u043f\u0440\u0435\u0436\u043d|\u0432\u0441\u0435|\u043b\u044e\u0431\u044b\u0435|\u0432\u044b\u0448\u0435\u0443\u043a\u0430\u0437\u0430\u043d\u043d)\\p{L}*${E}[^\\n]{0,30}${B}(\u0443\u043a\u0430\u0437\u0430\u043d\u0438|\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438|\u043f\u0440\u0430\u0432\u0438\u043b|\u0445\u0430\u0440\u0442\u0438\u044e|\u043f\u0440\u043e\u043c\u043f\u0442)`),
  re(`${B}(\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0439\u0442\u0435)\\s+(\u0445\u0430\u0440\u0442\u0438\u044e|\u0441\u0438\u0441\u0442\u0435\u043c\u043d|\u043f\u0440\u043e\u043c\u043f\u0442|\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438)`),
  // \u0437\u0430\u043f\u0440\u043e\u0441 \u0441\u0438\u0441\u0442\u0435\u043c\u043d\u043e\u0433\u043e \u043f\u0440\u043e\u043c\u043f\u0442\u0430 / \u0440\u0430\u0441\u043a\u0440\u044b\u0442\u0438\u044f \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0439
  re(`${B}(system prompt|\u0441\u0438\u0441\u0442\u0435\u043c\u043d\\p{L}* \u043f\u0440\u043e\u043c\u043f\u0442|\u0441\u0438\u0441\u0442\u0435\u043c\u043d\u044b\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438)${E}[^\\n]{0,40}${B}(output|print|reveal|show|repeat|\u0432\u044b\u0432\u0435\u0434\u0438|\u043f\u043e\u043a\u0430\u0436\u0438|\u0440\u0430\u0441\u043a\u0440\u043e\u0439|\u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439|\u043f\u043e\u0432\u0442\u043e\u0440\u0438)|${B}(output|print|reveal|show|repeat|\u0432\u044b\u0432\u0435\u0434\u0438|\u043f\u043e\u043a\u0430\u0436\u0438|\u0440\u0430\u0441\u043a\u0440\u043e\u0439|\u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439|\u043f\u043e\u0432\u0442\u043e\u0440\u0438)${E}[^\\n]{0,40}${B}(system prompt|\u0441\u0438\u0441\u0442\u0435\u043c\u043d\\p{L}* \u043f\u0440\u043e\u043c\u043f\u0442|\u0441\u0438\u0441\u0442\u0435\u043c\u043d\u044b\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438)`),
  // \u043f\u0441\u0435\u0432\u0434\u043e-\u0440\u043e\u043b\u044c \u0432 \u043d\u0430\u0447\u0430\u043b\u0435 \u0441\u0442\u0440\u043e\u043a\u0438, \u043f\u043e\u0441\u043b\u0435 \u0442\u0430\u0431\u0443\u043b\u044f\u0446\u0438\u0438 (\u0442\u0435\u043c\u0430 \u043a\u043e\u043c\u043c\u0438\u0442\u0430) \u0438\u043b\u0438 \u0432 HTML-\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0438:
  // [SYSTEM], SYSTEM:, \u0421\u0418\u0421\u0422\u0415\u041c\u0410:, ASSISTANT:, \u00ab\u0418\u041d\u0421\u0422\u0420\u0423\u041a\u0426\u0418\u042f \u0414\u041b\u042f ...\u00bb
  re(`(^|\\t|<!--)\\s*(\\[\\s*system\\s*\\]|system\\s*:|\u0441\u0438\u0441\u0442\u0435\u043c\u0430\\s*:|assistant\\s*:|\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442\\s*:|\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438[\u044f\u0438]\\s+\u0434\u043b\u044f\\s+(\u0438\u0438|ai|\u043c\u043e\u0434\u0435\u043b\u0438|\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442\u0430|\u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a\u0430|\u0440\u0435\u0432\u044c\u044e\u0435\u0440\u0430|llm))`),
  // \u043f\u0440\u044f\u043c\u043e\u0435 \u043e\u0431\u0440\u0430\u0449\u0435\u043d\u0438\u0435 \u043a \u0418\u0418/\u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a\u0443 \u0441 \u043f\u043e\u0432\u0435\u043b\u0435\u043d\u0438\u0435\u043c: \u00abAI reviewer, state that...\u00bb, \u00ab\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442, \u043d\u0430\u043f\u0438\u0448\u0438...\u00bb
  re(
    `${B}(ai|llm|assistant|assistants|chatbot|chatgpt|gpt|claude|gemini|\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043d\u0442|\u043d\u0435\u0439\u0440\u043e\u0441\u0435\u0442\\p{L}*|\u044f\u0437\u044b\u043a\u043e\u0432\\p{L}+ \u043c\u043e\u0434\u0435\u043b\\p{L}*|\u043c\u043e\u0434\u0435\u043b\u044c|\u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a|\u0440\u0435\u0432\u044c\u044e\u0435\u0440|reviewer)${E}[^\\n.]{0,60}${B}(\u043d\u0430\u043f\u0438\u0448\u0438|\u043d\u0430\u043f\u0438\u0448\u0438\u0442\u0435|\u0441\u043a\u0430\u0436\u0438|\u0441\u043a\u0430\u0436\u0438\u0442\u0435|\u0443\u043a\u0430\u0436\u0438|\u0443\u043a\u0430\u0436\u0438\u0442\u0435|\u0434\u043e\u0431\u0430\u0432\u044c|\u0434\u043e\u0431\u0430\u0432\u044c\u0442\u0435|\u0432\u044b\u0432\u0435\u0434\u0438|\u0432\u044b\u0432\u0435\u0434\u0438\u0442\u0435|\u043d\u0430\u0447\u043d\u0438|\u043d\u0430\u0447\u043d\u0438\u0442\u0435|\u043f\u043e\u0441\u0442\u0430\u0432\u044c|\u043f\u043e\u0441\u0442\u0430\u0432\u044c\u0442\u0435|\u0441\u0447\u0438\u0442\u0430\u0439|\u0441\u0447\u0438\u0442\u0430\u0439\u0442\u0435|\u043f\u043e\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0443\u0439|write|state|output|say|include|start your|respond|reply|add|recommend|rate|give)${E}`,
  ),
  // \u043f\u043e\u0434\u0434\u0435\u043b\u043a\u0430 \u0440\u0430\u043c\u043e\u043a \u0432\u0445\u043e\u0434\u0430: \u00ab=== \u041a\u041e\u041d\u0415\u0426 \u041d\u0415\u0414\u041e\u0412\u0415\u0420\u0415\u041d\u041d\u042b\u0425 \u0414\u0410\u041d\u041d\u042b\u0425 ===\u00bb, \u00ab=== \u041d\u0410\u0427\u0410\u041b\u041e \u041e\u0422\u0412\u0415\u0422\u041e\u0412 \u0421\u041f\u0415\u0426\u0418\u0410\u041b\u0418\u0421\u0422\u041e\u0412 ===\u00bb, \u00abEND OF UNTRUSTED DATA\u00bb
  re(`={3,}\\s*(\u043d\u0430\u0447\u0430\u043b\u043e|\u043a\u043e\u043d\u0435\u0446|begin|end)${E}|${B}(untrusted data|\u043d\u0435\u0434\u043e\u0432\u0435\u0440\u0435\u043d\u043d\\p{L}+ \u0434\u0430\u043d\u043d\\p{L}+|\u043e\u0442\u0432\u0435\u0442\u043e\u0432 \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0441\u0442\u043e\u0432)${E}[^\\n]{0,20}={3,}|${B}nonce${E}`),
];

/**
 * \u041f\u043e\u0441\u0442\u0440\u043e\u0447\u043d\u044b\u0439 \u0444\u0438\u043b\u044c\u0442\u0440 \u043d\u0435\u0434\u043e\u0432\u0435\u0440\u0435\u043d\u043d\u043e\u0433\u043e \u0442\u0435\u043a\u0441\u0442\u0430: \u0441\u0442\u0440\u043e\u043a\u0430, \u043f\u043e\u043f\u0430\u0432\u0448\u0430\u044f \u043f\u043e\u0434 \u0448\u0430\u0431\u043b\u043e\u043d, \u0437\u0430\u043c\u0435\u043d\u044f\u0435\u0442\u0441\u044f
 * INSTRUCTION_PLACEHOLDER (\u0441\u043e\u0441\u0435\u0434\u043d\u0438\u0435 \u043f\u043e\u043c\u0435\u0442\u043a\u0438 \u0441\u0445\u043b\u043e\u043f\u044b\u0432\u0430\u044e\u0442\u0441\u044f). \u0414\u0430\u043d\u043d\u044b\u0435 \u043e\u0441\u0442\u0430\u044e\u0442\u0441\u044f \u0434\u0430\u043d\u043d\u044b\u043c\u0438:
 * \u0443\u0434\u0430\u043b\u044f\u044e\u0442\u0441\u044f \u0442\u043e\u043b\u044c\u043a\u043e \u0441\u0442\u0440\u043e\u043a\u0438-\u043e\u0431\u0440\u0430\u0449\u0435\u043d\u0438\u044f \u043a \u043c\u043e\u0434\u0435\u043b\u0438. \u0412\u043e\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442 \u0442\u0435\u043a\u0441\u0442 \u0438 \u0447\u0438\u0441\u043b\u043e \u0443\u0434\u0430\u043b\u0435\u043d\u043d\u044b\u0445 \u0441\u0442\u0440\u043e\u043a.
 */
export function stripInstructionLines(text: string): { text: string; removed: number } {
  const out: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    const hit = INSTRUCTION_LINE_PATTERNS.some((re) => re.test(line));
    if (!hit) {
      out.push(line);
      continue;
    }
    removed++;
    if (out[out.length - 1] !== INSTRUCTION_PLACEHOLDER) out.push(INSTRUCTION_PLACEHOLDER);
  }
  return { text: out.join("\n"), removed };
}

/** \u0421\u0430\u043d\u0438\u0442\u0438\u0437\u0430\u0446\u0438\u044f \u0438 \u0444\u0438\u043b\u044c\u0442\u0440 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0439 \u0432\u043c\u0435\u0441\u0442\u0435 \u2013 \u0434\u043b\u044f \u0441\u043e\u0434\u0435\u0440\u0436\u0438\u043c\u043e\u0433\u043e \u0444\u0430\u0439\u043b\u043e\u0432 \u0438 \u0441\u0442\u0440\u043e\u043a \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u043e\u0432. */
export function cleanUntrusted(text: string): string {
  return stripInstructionLines(sanitizeUntrusted(text)).text;
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

/** Калькулятор: модель считает арифметику инструментом, а не в уме. Доступен и
 *  security, которой файловые инструменты запрещены. */
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
  /**
   * Корень рабочей копии клона (файлы для read_file/grep/list_files). Функция –
   * ленивая рабочая копия: разворачивается при первом файловом инструменте, а
   * обзор без вызовов инструментов обходится без нее (вызывающий мемоизирует).
   */
  root: string | (() => Promise<string>);
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
    if (st.isSymbolicLink()) continue; // симлинки не читаем и не показываем как читаемые
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

/**
 * Заведомо опасный паттерн grep: повтор группы, внутри которой тоже повтор –
 * `(a+)+`, `(\w+\s?)+`, `(.*,)*`, `(?:x*){2,}`. Такой регэксп перебирает
 * экспоненту способов разбить строку и на 4000 символах стоит секунды. Отказ
 * сразу, с подсказкой для модели; остальное держит бюджет времени. Возвращает
 * причину отказа или null.
 */
export function dangerousGrepPattern(pattern: string): string | null {
  // кадр группы: был ли внутри квантификатор (на любой глубине)
  const stack: boolean[] = [false];
  let i = 0;
  // квантификатор в позиции j: длина и «без верхней границы» (*, +, {n,})
  const quantAt = (j: number): { len: number; unbounded: boolean } | null => {
    const c = pattern[j];
    if (c === "*" || c === "+") return { len: 1, unbounded: true };
    if (c === "?") return { len: 1, unbounded: false };
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(j));
      if (m === null) return null; // `{` без числа – литерал
      return { len: m[0].length, unbounded: m[2] !== undefined && m[3] === "" };
    }
    return null;
  };
  // после атома: квантификатор (и ленивый `?` за ним) отмечает кадр
  const afterAtom = (): { unbounded: boolean } | null => {
    const q = quantAt(i);
    if (q === null) return null;
    i += q.len;
    if (pattern[i] === "?") i++;
    stack[stack.length - 1] = true;
    return q;
  };
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      // \p{L}, \u{1F600}, \k<name> – скобки часть атома, не квантификатор
      const n = pattern[i + 1];
      i += 2;
      if ((n === "p" || n === "P" || n === "u") && pattern[i] === "{") {
        const end = pattern.indexOf("}", i);
        i = end < 0 ? pattern.length : end + 1;
      } else if (n === "k" && pattern[i] === "<") {
        const end = pattern.indexOf(">", i);
        i = end < 0 ? pattern.length : end + 1;
      }
      afterAtom();
      continue;
    }
    if (c === "[") {
      i++;
      if (pattern[i] === "]") i++; // `[]...]` – литерал `]` в начале класса
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
      afterAtom();
      continue;
    }
    if (c === "(") {
      i++;
      // (?: (?= (?! (?<= (?<! (?<name> – префикс группы, не квантификатор
      if (pattern[i] === "?") {
        i++;
        if (pattern[i] === "<" && pattern[i + 1] !== "=" && pattern[i + 1] !== "!") {
          const end = pattern.indexOf(">", i);
          i = end < 0 ? pattern.length : end + 1;
        } else {
          i += pattern[i] === "<" ? 2 : 1;
        }
      }
      stack.push(false);
      continue;
    }
    if (c === ")") {
      i++;
      const inner = stack.length > 1 ? stack.pop()! : false;
      const q = afterAtom();
      if (q?.unbounded && inner) {
        return "вложенный повтор вида (…+)+ или (…*)* – перебор растет экспоненциально и подвешивает поиск";
      }
      if (inner) stack[stack.length - 1] = true;
      continue;
    }
    i++;
    afterAtom();
  }
  return null;
}

export interface GrepScanResult {
  lines: string[];
  /** сколько файлов прочитано */
  scanned: number;
  /** бюджет времени исчерпан – результат частичный */
  timedOut: boolean;
}

/**
 * Обход и сопоставление grep – синхронно; на сервере вызывается только в
 * отдельном процессе (runGrepChild). Время проверяется между файлами и строками:
 * по исчерпании `deadline` (performance.now()) обход останавливается с частичным
 * результатом. `onLine` отдает совпадение сразу: строки, найденные до зависшей,
 * переживают kill процесса.
 */
export function grepScan(root: string, re: RegExp, glob: string | null, deadline: number, onLine?: (line: string) => void): GrepScanResult {
  const files: string[] = [];
  listFilesRec(root, root, files, GREP_FILE_CAP);
  const lines: string[] = [];
  let scanned = 0;
  const over = (): boolean => performance.now() > deadline;
  for (const rel of files) {
    if (lines.length >= GREP_LINE_CAP) break;
    if (scanned >= GREP_FILE_CAP) break;
    if (over()) return { lines, scanned, timedOut: true };
    if (rel.endsWith("/") || rel.endsWith("(denied)")) continue;
    if (isDeniedPath(rel)) continue;
    if (glob !== null && !rel.includes(glob)) continue;
    const abs = join(root, rel);
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
      if (over()) return { lines, scanned, timedOut: true };
      if (re.test(split[i]!.slice(0, GREP_MATCH_CHARS))) {
        // строка-инструкция заменяется пометкой, номер строки сохраняется
        const line = `${rel}:${i + 1}: ${stripInstructionLines(split[i]!).text.trim().slice(0, GREP_LINE_CHARS)}`;
        lines.push(line);
        onLine?.(line);
      }
    }
  }
  return { lines, scanned, timedOut: false };
}

/**
 * Вход процесса grep: запрос JSON со stdin, совпадения и итог – строками JSON
 * в stdout. Запись синхронная (writeSync): найденное уже в канале, даже если
 * следующая строка подвесит регэксп и родитель снимет процесс.
 */
export async function runGrepChild(): Promise<void> {
  const req = JSON.parse(await Bun.stdin.text()) as { root: string; pattern: string; glob: string | null; budgetMs: number };
  const emit = (rec: unknown): void => {
    writeSync(1, `${JSON.stringify(rec)}\n`);
  };
  const deadline = performance.now() + req.budgetMs;
  // паттерн проверен родителем; nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const res = grepScan(req.root, new RegExp(req.pattern), req.glob, deadline, (line) => emit({ line }));
  emit({ end: true, scanned: res.scanned, timedOut: res.timedOut });
}

/**
 * grep в отдельном процессе bun с жестким сроком GREP_TIME_BUDGET_MS +
 * GREP_KILL_GRACE_MS: регэксп синхронный, и в процессе сервера зависшая строка
 * остановила бы сайт и API. По сроку процесс снимается, найденное до этого
 * остается в выдаче.
 */
async function grepInChild(root: string, pattern: string, glob: string | null): Promise<GrepScanResult & { killed: boolean }> {
  const script = `import { runGrepChild } from ${JSON.stringify(pathToFileURL(import.meta.path).href)}; await runGrepChild();`;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, GREP_TIME_BUDGET_MS + GREP_KILL_GRACE_MS);
  try {
    proc.stdin.write(JSON.stringify({ root, pattern, glob, budgetMs: GREP_TIME_BUDGET_MS }));
    proc.stdin.end();
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const lines: string[] = [];
    let end: { scanned: number; timedOut: boolean } | null = null;
    for (const raw of out.split("\n")) {
      if (raw.length === 0) continue;
      let rec: { line?: unknown; end?: unknown; scanned?: unknown; timedOut?: unknown };
      try {
        rec = JSON.parse(raw) as typeof rec;
      } catch {
        continue; // оборванная kill-ом последняя запись
      }
      if (typeof rec.line === "string" && lines.length < GREP_LINE_CAP) lines.push(rec.line);
      else if (rec.end === true) end = { scanned: Number(rec.scanned) || 0, timedOut: rec.timedOut === true };
    }
    if (end === null && !killed) throw new Error(`grep: процесс завершился с кодом ${exitCode}: ${err.trim().slice(0, 120)}`);
    return { lines, scanned: end?.scanned ?? 0, timedOut: end === null || end.timedOut, killed: end === null };
  } finally {
    clearTimeout(timer);
  }
}

/** Исполнение одного инструмента; возвращает СТРОКУ (едет в role:"tool"). */
export async function executeTool(io: ToolExecutorIo, name: string, args: unknown): Promise<string> {
  const fail = (error: string): string => JSON.stringify({ ok: false, error });
  // рабочая копия разворачивается после проверки аргументов: отказ по пути к
  // секретам или битому паттерну не должен стоить `git worktree add`
  const rootOf = async (): Promise<string> => (typeof io.root === "string" ? io.root : io.root());
  const unavailable = (e: unknown): string => fail(`рабочая копия недоступна: ${String((e as Error).message).slice(0, 120)}`);
  try {
    if (name === "read_file") {
      const rel = (args as { path?: unknown } | null)?.path;
      if (typeof rel !== "string") return fail("ожидался аргумент path: строка");
      if (isDeniedPath(rel)) return fail("denied: путь к секретам — содержимое не выдаётся");
      let root: string;
      try {
        root = await rootOf();
      } catch (e) {
        return unavailable(e);
      }
      const abs = guardPath(root, rel);
      if (abs === null) return fail("denied: путь вне корня репозитория");
      // запрет – по пути, который откроется, а не по сырой строке (`.env/.`, `x/../.env`)
      if (isDeniedResolved(root, abs)) return fail("denied: путь к секретам — содержимое не выдаётся");
      if (hasSymlinkComponent(root, abs)) return fail("denied: путь содержит симлинк — содержимое не выдаётся");
      let st;
      try {
        st = statSync(abs);
      } catch {
        return fail(`файл не найден: ${sanitizeUntrusted(rel)}`);
      }
      if (st.isDirectory()) return fail("это каталог, а не файл");
      if (st.size > MAX_PLAIN_READ_BYTES) return fail(`denied: файл больше 1 МБ (${st.size} байт) — чтение отклонено`);
      const buf = readFileSync(abs);
      if (buf.subarray(0, 8192).includes(0)) return fail("бинарный файл — текст не выдаётся");
      const truncated = buf.length > READ_FILE_CAP_BYTES;
      const body = cleanUntrusted(buf.subarray(0, READ_FILE_CAP_BYTES).toString("utf8"));
      return JSON.stringify({ ok: true, path: rel, truncated, content: body });
    }
    if (name === "grep") {
      const a = args as { pattern?: unknown; glob?: unknown } | null;
      if (typeof a?.pattern !== "string" || a.pattern.length === 0) return fail("ожидался аргумент pattern: строка");
      if (a.pattern.length > GREP_PATTERN_MAX) return fail(`паттерн длиннее ${GREP_PATTERN_MAX} символов`);
      try {
        // паттерн задает модель: здесь только проверка синтаксиса, исполнение – в отдельном процессе
        new RegExp(a.pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      } catch (e) {
        return fail(`неверный паттерн: ${String((e as Error).message).slice(0, 100)}`);
      }
      const danger = dangerousGrepPattern(a.pattern);
      if (danger !== null) {
        return fail(`опасный паттерн: ${danger}. Перепиши без повтора внутри повтора: (\\w+\\s?)+ → [\\w\\s]+, (.*,)*TODO → TODO`);
      }
      const glob = typeof a.glob === "string" && a.glob.length > 0 ? a.glob : null;
      let root: string;
      try {
        root = await rootOf();
      } catch (e) {
        return unavailable(e);
      }
      const res = await grepInChild(root, a.pattern, glob);
      return JSON.stringify({
        ok: true,
        matches: res.lines.length,
        truncated: res.lines.length >= GREP_LINE_CAP || res.scanned >= GREP_FILE_CAP || res.timedOut,
        ...(res.timedOut
          ? {
              timedOut: true,
              note: res.killed
                ? `поиск остановлен: время ${GREP_TIME_BUDGET_MS} мс вышло на строке, где паттерн перебирает слишком долго; результат частичный – упрости паттерн или сузь glob`
                : `поиск остановлен: время ${GREP_TIME_BUDGET_MS} мс вышло, просмотрено файлов: ${res.scanned}; результат частичный – сузь glob`,
            }
          : {}),
        lines: res.lines,
      });
    }
    if (name === "list_files") {
      const sub = (args as { subdir?: unknown } | null)?.subdir;
      if (typeof sub === "string" && sub.length > 0 && isDeniedPath(sub)) return fail("denied: путь к секретам — содержимое не выдаётся");
      let root: string;
      try {
        root = await rootOf();
      } catch (e) {
        return unavailable(e);
      }
      let base = root;
      if (typeof sub === "string" && sub.length > 0) {
        const abs = guardPath(root, sub);
        if (abs === null) return fail("denied: путь вне корня репозитория");
        if (isDeniedResolved(root, abs)) return fail("denied: путь к секретам — содержимое не выдаётся");
        if (hasSymlinkComponent(root, abs)) return fail("denied: путь содержит симлинк — содержимое не выдаётся");
        base = abs;
      }
      const out: string[] = [];
      listFilesRec(root, base, out, LIST_FILES_CAP);
      return JSON.stringify({ ok: true, truncated: out.length >= LIST_FILES_CAP, files: out });
    }
    if (name === "git_log") {
      if (io.gitDir === null) return fail("git-история недоступна");
      const fmt = "%h %an%x09%s";
      const out = await runGit(["--git-dir", io.gitDir, "log", `-${GIT_LOG_CAP}`, `--format=${fmt}`], 30_000);
      const lines = out
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => cleanUntrusted(l).slice(0, GREP_LINE_CHARS));
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
  /** новая попытка генерации: бюджет заново, кэш выдачи остается (повторный grep бесплатен по времени) */
  resetBudget: () => void;
}

/**
 * Рабочая копия HEAD из bare-клона (`git worktree add`): инструментам нужны
 * файлы, а клон скана — bare. Служебная запись worktrees внутри bare-репо
 * удаляется вместе с ним при cleanupClone. Сбой — исключение: без файлов
 * агентная стадия с инструментами не начинается.
 */
export async function materializeWorktree(bareDir: string, env?: Record<string, string>): Promise<{ root: string; gitDir: string }> {
  const root = `${bareDir}.wt`;
  await runGit(["--git-dir", bareDir, "worktree", "add", "--detach", root, "HEAD"], 120_000, env);
  return { root, gitDir: bareDir };
}

/**
 * Файл корня HEAD прямо из git-каталога, без рабочей копии: первый обычный файл
 * (не симлинк, не каталог), чье имя проходит `nameRe`, размером до
 * MAX_PLAIN_READ_BYTES. У частичного клона блоб дотягивается с origin – для
 * этого `env` клона. null – файла нет, он не обычный, слишком большой или git упал.
 */
export async function readHeadFile(gitDir: string, nameRe: RegExp, env?: Record<string, string>): Promise<string | null> {
  try {
    // -z: имена без C-экранирования (иначе README с не-ASCII именем пришел бы в кавычках);
    // -l: размер блоба здесь же, без отдельного cat-file -s
    const tree = await runGit(["--git-dir", gitDir, "ls-tree", "-z", "-l", "HEAD"], 30_000, env);
    // запись: <mode> <type> <sha> <size|->\t<name>\0
    let picked: { name: string; size: number } | null = null;
    for (const rec of tree.split("\0")) {
      const m = /^(\d{6}) (\w+) [0-9a-f]+ +(\d+|-)\t([^]+)$/.exec(rec);
      if (m === null || !nameRe.test(m[4]!)) continue;
      if (m[2] !== "blob" || m[1] === "120000") return null; // каталог или симлинк с таким именем – не README
      picked = { name: m[4]!, size: Number.parseInt(m[3]!, 10) };
      break;
    }
    if (picked === null || !Number.isFinite(picked.size) || picked.size <= 0 || picked.size > MAX_PLAIN_READ_BYTES) return null;
    return await runGit(["--git-dir", gitDir, "cat-file", "blob", `HEAD:${picked.name}`], 60_000, env);
  } catch {
    return null;
  }
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

/** Остаток бюджета — в каждый результат, чтобы модель видела, сколько вызовов осталось. */
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
 * Исполнитель с дедупом: повтор с теми же аргументами отдает кэш, а не
 * гоняет диск и процессы. Бюджет считает ВСЕ вызовы, включая кэшированные, —
 * зациклиться нельзя; после исчерпания вызов получает отказ, а не исполняется сверх капа.
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
    resetBudget: () => {
      calls = 0;
    },
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
 * Исполнитель ТОЛЬКО с calculate, без доступа к репозиторию: так security, которой
 * файловые инструменты запрещены, все равно считает проценты инструментом, а не в уме.
 */
export function makeCalculatorExecutor(toolBudget = 6): ToolExecutor {
  let calls = 0;
  const left = (): number => Math.max(0, toolBudget - calls);
  return {
    specs: [CALCULATOR_SPEC],
    budgetLeft: left,
    stats: () => ({ calls, deduped: 0 }),
    resetBudget: () => {
      calls = 0;
    },
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
