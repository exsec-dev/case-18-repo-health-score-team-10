// Инструменты агента для чтения репозитория: только чтение, root = рабочий каталог
// клона, path-гард, капы на выдачу, deny-list секретов (содержимое не читается).
// Результат инструмента — НЕдоверенные данные: контрольные символы срезаются,
// объем капится. Дедуп повторных вызовов — в исполнителе (makeToolExecutor).
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
/** Предел длины паттерна grep: паттерн пишет модель, длинный регэксп – повод отказать, а не выполнять. */
export const GREP_PATTERN_MAX = 200;
/** Сколько символов строки проверяется регэкспом: ограничивает время «взрывного» паттерна. */
export const GREP_MATCH_CHARS = 4000;
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
  /(^|\/)\.git($|\/)/,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa[^/]*$/i,
  /(^|\/)\.gitconfig$/i,
  /credentials?\.(json|txt|ya?ml)$/i,
  /(^|\/)secrets[^/]*\.json$/i,
  /\.(p12|pfx|jks)$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  // SSH-ключи любого алгоритма вне .ssh/ (deploy/id_ed25519) и ключи сервисных аккаунтов Firebase
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
      let re: RegExp;
      try {
        // паттерн задает модель: длина паттерна и проверяемой строки ограничены,
        // поэтому «взрывной» регэксп упирается в GREP_MATCH_CHARS, а не висит
        re = new RegExp(a.pattern); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
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
          if (re.test(split[i]!.slice(0, GREP_MATCH_CHARS))) {
            // строка-инструкция заменяется пометкой, номер строки сохраняется
            lines.push(`${rel}:${i + 1}: ${stripInstructionLines(split[i]!).text.trim().slice(0, GREP_LINE_CHARS)}`);
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
