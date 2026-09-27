// Git-сборщик: cloneBare со сторожем (опрос размера через du и таймаут,
// убийство всей setsid-группы) и запасной попыткой --shallow-since для
// слишком больших репо, extractFacts из bare-клона. Код не храним: клон
// живет в tmp, из него извлекаются факты, и вызывающий удаляет его в finally.
// Клон не удался или пустой → факты no-data, а не bad.
// Лимиты берутся из Config.scan (src/config.ts).
import { execFile, execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fact, GIT_KINDS, badChannelFact, noDataFact, okFact, scrubDetail } from "./facts";
import { isSourcePath, isTestPath } from "./source-path";
import { OWNERSHIP_LOG_FORMAT, OWNERSHIP_MAX_COMMITS, OWNERSHIP_WINDOW_DAYS, aggregateOwnership, parseOwnershipLog } from "./ownership";
import { robot2Flags } from "../score/robot2";
import { parseYamlSubset } from "./yamlmini";
import type { CloneLimits, ScanCloneLimits } from "../config";

export type CloneFailReason = "timeout" | "disk" | "git";

export interface CloneSuccess {
  ok: true;
  dir: string;
  bytes: number;
  elapsedMs: number;
}

export interface CloneFailure {
  ok: false;
  reason: CloneFailReason;
  detail: string;
  elapsedMs: number;
}

export type CloneOutcome = CloneSuccess | CloneFailure;

/**
 * Минимальные структурные типы вместо `Bun.Subprocess`: тест подставляет
 * свой процесс, не собирая генерики Bun.
 */
export interface SpawnedGit {
  pid: number;
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Запуск `git clone`, подменяемый в тестах: тест видит argv и env дочернего процесса. */
export type SpawnGit = (opts: { cmd: string[]; env: Record<string, string> }) => SpawnedGit;

export interface CatFileProc {
  stdin: { write(data: Uint8Array): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Запуск `git cat-file --batch`, подменяемый в тестах (например, чтобы оборвать поток). */
export type CatFileSpawn = (cloneDir: string) => CatFileProc;

export interface CloneSeams {
  /** подмена запуска git (по умолчанию `Bun.spawn`) */
  spawnGit?: SpawnGit;
  /** подмена версии git: null – не определилась */
  gitVersion?: [number, number, number] | null;
  /** вызывается с каталогом успешного клона до того, как его увидит вызывающий */
  onCloneDir?: (dir: string) => void | Promise<void>;
  /** свободные байты в каталоге (по умолчанию statfs) */
  freeBytes?: (dir: string) => number;
  /** ожидание места на диске: пауза опроса и предел ожидания */
  diskWait?: { pollMs: number; maxWaitMs: number };
}

/** Опрос свободного места раз в 30 с, не дольше 15 мин – с запасом внутри аренды заявки (85 мин). */
export const DISK_WAIT = { pollMs: 30_000, maxWaitMs: 15 * 60_000 };

function statfsFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Одновременные клоны делят один диск, и ENOSPC одного клона роняет соседние.
 * Поэтому перед клоном, если свободного места меньше резерва, ждем, пока
 * соседние клоны закончатся и уберутся. После предела ожидания клон все равно
 * идет (исход решает git) – ожидание только разводит клоны по времени.
 * Ошибка statfs – не повод стоять: проверка пропускается.
 */
export async function waitForDiskRoom(
  dir: string,
  minFreeBytes: number | undefined,
  seams: Pick<CloneSeams, "freeBytes" | "diskWait"> = {},
): Promise<{ waitedMs: number; freeBytes: number | null; room: boolean }> {
  if (!minFreeBytes || minFreeBytes <= 0) return { waitedMs: 0, freeBytes: null, room: true };
  const free = seams.freeBytes ?? statfsFreeBytes;
  const { pollMs, maxWaitMs } = seams.diskWait ?? DISK_WAIT;
  const started = Date.now();
  let warned = false;
  for (;;) {
    let bytes: number;
    try {
      bytes = free(dir);
    } catch (e) {
      console.error(`[git] statfs ${dir} failed, disk check skipped: ${String((e as Error).message).slice(0, 120)}`);
      return { waitedMs: Date.now() - started, freeBytes: null, room: true };
    }
    const waitedMs = Date.now() - started;
    if (bytes >= minFreeBytes) {
      if (warned) console.log(`[git] disk room is back: ${Math.round(bytes / 2 ** 20)} MB free after ${Math.round(waitedMs / 1000)} s`);
      return { waitedMs, freeBytes: bytes, room: true };
    }
    if (waitedMs >= maxWaitMs) {
      console.error(`[git] low disk: ${Math.round(bytes / 2 ** 20)} MB free < reserve ${Math.round(minFreeBytes / 2 ** 20)} MB after ${Math.round(waitedMs / 1000)} s — cloning anyway`);
      return { waitedMs, freeBytes: bytes, room: false };
    }
    if (!warned) {
      console.log(`[git] low disk: ${Math.round(bytes / 2 ** 20)} MB free < reserve ${Math.round(minFreeBytes / 2 ** 20)} MB — waiting for other clones`);
      warned = true;
    }
    await sleep(pollMs);
  }
}

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
  // после setsid pid == pgid: отрицательный pid убивает всю группу (git и его подпроцессы)
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      killSelf();
    } catch {
      /* уже мертв */
    }
  }
}

// Реестр живых групп клонов этого процесса. setsid-группы переживают убитого
// родителя, пока их не подберет плановая зачистка (2 × аренда, 170 мин), поэтому
// при SIGTERM гасим их сразу.
const liveCloneGroups = new Set<number>();

/** Регистрирует живую группу клона (у setsid-процесса pid == pgid). */
export function trackCloneGroup(pid: number): void {
  if (Number.isFinite(pid) && pid > 0) liveCloneGroups.add(pid);
}

function untrackCloneGroup(pid: number): void {
  liveCloneGroups.delete(pid);
}

/** Убивает все живые группы клонов процесса (при SIGTERM); возвращает число убитых. */
export function killActiveClones(): number {
  let killed = 0;
  for (const pid of Array.from(liveCloneGroups)) {
    untrackCloneGroup(pid);
    try {
      process.kill(-pid, "SIGKILL");
      killed++;
    } catch {
      /* группа уже мертва */
    }
  }
  return killed;
}

const HAVE_DU = Boolean(Bun.which("du"));

/** Размер каталога для сторожа: быстрый du, а без него (Windows) – обход файлов. */
async function duBytes(dir: string): Promise<number> {
  if (!HAVE_DU) return fsTreeBytes(dir);
  const measured = await new Promise<number | null>((resolve) => {
    execFileCb("du", ["-sb", dir], { timeout: 30_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const n = parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
  return measured ?? fsTreeBytes(dir);
}

async function fsTreeBytes(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) total += await fsTreeBytes(join(path, entry.name));
    return total;
  } catch {
    // клон пишет дерево параллельно: файл, исчезнувший между readdir и lstat,
    // учтется в следующем опросе или в обязательном финальном замере
    return 0;
  }
}

const HAVE_SETSID = Boolean(Bun.which("setsid"));

/**
 * Креды из URL (https://user:pat@host) вырезаются из деталей ошибок и фактов:
 * git печатает URL в stderr, а PAT пользователя не должен попасть в БД.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@\/\s]+@/g, "$1***@");
}

export type CredentialSplit =
  | { kind: "none"; url: string }
  | { kind: "header"; url: string; authorization: string }
  | { kind: "refused"; detail: string };

/**
 * Декодировать percent-последовательности из пользовательского ввода только
 * через этот хелпер: битая последовательность (`%zz`) бросает URIError, а
 * здесь она дает управляемый отказ (null) вместо 500.
 */
export function safeDecodeURIComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Разбор URL клона с кредами. Креды переезжают из URL в заголовок
 * `Authorization`: в argv их видно всему хосту через /proc/<pid>/cmdline.
 * Разрешены только `https://` и – для локальных тестов – `http://` на loopback
 * (`localhost`/`127.0.0.1`). Любой другой `http://` с кредами отклоняется:
 * отправить PAT открытым текстом на чужой хост хуже, чем не собрать канал.
 */
export function splitCredentialUrl(raw: string): CredentialSplit {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "none", url: raw };
  }
  // секрет – это пароль. Имя без пароля (анонимный `https://git@host/...` –
  // так платформа отдает публичные репо) секрета не несет, заголовок не
  // нужен, и проверка git ≥ 2.31 такой клон не блокирует
  if (u.password === "") return { kind: "none", url: raw };
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    return { kind: "refused", detail: `refusing to send credentials over ${u.protocol}//${u.hostname} (https, or http on loopback, only)` };
  }
  const user = safeDecodeURIComponent(u.username);
  const pass = safeDecodeURIComponent(u.password);
  if (user === null || pass === null) {
    return { kind: "refused", detail: "refusing malformed credentials in URL (bad percent-encoding)" };
  }
  u.username = "";
  u.password = "";
  return {
    kind: "header",
    url: u.toString(),
    authorization: `Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

/** `git version 2.43.0.windows.1` → [2, 43, 0]; неразбираемое – null. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = text.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * `http.extraHeader` через `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` работает с
 * git 2.31: раньше переменные игнорируются, и клон приватного репо ушел бы
 * без авторизации. В кэше хранится только успешная проба версии.
 */
export const MIN_GIT_VERSION: [number, number] = [2, 31];
let gitVersionCache: Promise<[number, number, number] | null> | null = null;

export function __resetGitVersionCache(): void {
  gitVersionCache = null;
}

export async function gitVersion(): Promise<[number, number, number] | null> {
  if (gitVersionCache === null) {
    const probe = execGit(["--version"], { timeoutMs: 10_000 }).then((r) => parseGitVersion(r.stdout));
    // сбой или неразбираемый вывод обнуляют кэш, и следующий вызов пробует
    // заново: иначе один случайный сбой `git --version` (EAGAIN, таймаут под
    // нагрузкой) до перезапуска процесса отклонял бы каждый клон с кредами.
    // Параллельные вызовы делят один промис – двух проб одновременно нет
    gitVersionCache = probe.then(
      (v) => {
        if (v === null) gitVersionCache = null;
        return v;
      },
      (e) => {
        console.error(`[git] version probe failed: ${String((e as Error).message).slice(0, 160)}`);
        gitVersionCache = null;
        return null;
      },
    );
  }
  return gitVersionCache;
}

export function versionAtLeast(v: [number, number, number] | null, min: [number, number]): boolean {
  if (v === null) return false;
  return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);
}

/**
 * `git clone --bare` в свежий подкаталог tmp. Сторож каждые pollMs меряет
 * размер и проверяет таймаут; при превышении убивает группу процессов и
 * удаляет каталог. При успехе удалить клон (cleanupClone) обязан вызывающий.
 * opts.shallowSince – запасной режим --shallow-since для больших репо.
 */
export async function cloneBare(
  urlWithCreds: string,
  tmpDir: string = tmpdir(),
  limits: CloneLimits,
  opts: { shallowSince?: string } & CloneSeams = {},
): Promise<CloneOutcome> {
  // ждем места до mkdtemp и до отсчета таймаута, чтобы ожидание не съело бюджет клона
  await waitForDiskRoom(tmpDir, limits.minFreeBytes, opts);
  const dir = mkdtempSync(join(tmpDir, "rh-clone-"));
  const started = Date.now();
  // креды не попадают в argv (/proc/<pid>/cmdline читают все): они уходят в
  // http-заголовок через env-конфиг git (GIT_CONFIG_*), а environ процесса
  // читает только его владелец
  const split = splitCredentialUrl(urlWithCreds);
  if (split.kind === "refused") {
    await cleanupFailedClone(dir);
    return { ok: false, reason: "git", detail: split.detail, elapsedMs: Date.now() - started };
  }
  let cloneUrl = split.url;
  const childEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" };
  if (split.kind === "header") {
    // на git < 2.31 `GIT_CONFIG_*` молча игнорируется – клон ушел бы без авторизации
    const v = opts.gitVersion !== undefined ? opts.gitVersion : await gitVersion();
    if (!versionAtLeast(v, MIN_GIT_VERSION)) {
      await cleanupFailedClone(dir);
      return {
        ok: false,
        reason: "git",
        detail: `git ${v ? v.join(".") : "version unknown"} < ${MIN_GIT_VERSION.join(".")}: http.extraHeader via GIT_CONFIG_* is not supported, refusing to clone with a token`,
        elapsedMs: Date.now() - started,
      };
    }
    // пустой `credential.helper` глушит системные хелперы (менеджер кредов
    // Windows, osxkeychain), иначе они подхватят и сохранят PAT на диске хоста
    childEnv.GIT_CONFIG_COUNT = "2";
    childEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
    childEnv.GIT_CONFIG_VALUE_0 = split.authorization;
    childEnv.GIT_CONFIG_KEY_1 = "credential.helper";
    childEnv.GIT_CONFIG_VALUE_1 = "";
  }
  const gitArgs = ["clone", "--bare"];
  if (opts.shallowSince) gitArgs.push(`--shallow-since=${opts.shallowSince}`);
  gitArgs.push(cloneUrl, dir);
  const cmd = HAVE_SETSID ? ["setsid", "git", ...gitArgs] : ["git", ...gitArgs];
  const spawn: SpawnGit =
    opts.spawnGit ?? ((o) => Bun.spawn({ cmd: o.cmd, stdout: "ignore", stderr: "pipe", stdin: "ignore", env: o.env }));
  const proc = spawn({ cmd, env: { ...(process.env as Record<string, string>), ...childEnv } });
  trackCloneGroup(proc.pid);
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
    untrackCloneGroup(proc.pid);
    await proc.exited.catch(() => undefined);
    await cleanupFailedClone(dir);
    const detail =
      breach === "disk"
        ? `bare clone ${bytes} B > budget ${limits.maxBytes} B (du-poll)`
        : `clone exceeded ${limits.timeoutMs} ms timeout`;
    return { ok: false, reason: breach, detail, elapsedMs: Date.now() - started };
  }
  const code = await proc.exited;
  untrackCloneGroup(proc.pid);
  if (code !== 0) {
    let stderr = "";
    try {
      // сначала вырезаем креды, потом обрезаем: обрезка могла отрезать `@`, и
      // креды остались бы в детали факта
      stderr = scrubCredentials((await new Response(proc.stderr).text()).trim()).slice(0, 300);
    } catch {
      /* stdout/stderr ignore */
    }
    await cleanupFailedClone(dir);
    return { ok: false, reason: "git", detail: stderr || `git clone exited ${code}`, elapsedMs: Date.now() - started };
  }
  bytes = await duBytes(dir);
  const elapsedMs = Date.now() - started;
  // быстрый клон может завершиться раньше первого опроса, поэтому финальный
  // замер обязателен: бюджет – постусловие, а не только забота сторожа
  if (bytes > limits.maxBytes || elapsedMs > limits.timeoutMs) {
    await cleanupFailedClone(dir);
    return bytes > limits.maxBytes
      ? {
          ok: false,
          reason: "disk",
          detail: `bare clone ${bytes} B > budget ${limits.maxBytes} B (final-size)`,
          elapsedMs,
        }
      : {
          ok: false,
          reason: "timeout",
          detail: `clone completed in ${elapsedMs} ms > ${limits.timeoutMs} ms timeout`,
          elapsedMs,
        };
  }
  // тест может прочитать `<dir>/config` до того, как каталог уберут
  await opts.onCloneDir?.(dir);
  return { ok: true, dir, bytes, elapsedMs };
}

/** Дата отсечения истории (календарные месяцы назад) – значение history_truncated_since. */
export function truncateSinceIso(sinceMonths: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - sinceMonths);
  return d.toISOString();
}

/** Успешный клон; historyTruncatedSince – с какой даты усечена история (null – не усекалась). */
export interface DegradeCloneSuccess extends CloneSuccess {
  historyTruncatedSince: string | null;
}

export type DegradeCloneOutcome = DegradeCloneSuccess | CloneFailure;

/**
 * Сначала полный клон; если он превысил таймаут или размер – вторая попытка
 * --shallow-since=<N>.months на отдельном бюджете и с пометкой об усеченной
 * истории. Бюджеты задает оператор (env или `DEFAULT_SCAN` в config.ts).
 * Ошибку самого git усечение не лечит – она отдается как есть.
 */
export async function cloneWithDegrade(
  url: string,
  tmpDir: string = tmpdir(),
  limits: ScanCloneLimits,
  seams: CloneSeams = {},
): Promise<DegradeCloneOutcome> {
  const first = await cloneBare(url, tmpDir, limits, seams);
  if (first.ok || first.reason === "git") {
    return first.ok ? { ...first, historyTruncatedSince: null } : first;
  }
  // усеченная попытка выключена в конфиге – отдаем провал первой как есть
  if (limits.degrade.enabled === false) {
    return { ...first, detail: `full clone failed (${first.reason}: ${first.detail}); degrade tier disabled by config` };
  }
  const second = await cloneBare(
    url,
    tmpDir,
    { timeoutMs: limits.degrade.timeoutMs, maxBytes: limits.degrade.maxBytes, pollMs: limits.pollMs, minFreeBytes: limits.minFreeBytes },
    { ...seams, shallowSince: `${limits.degrade.sinceMonths}.months` },
  );
  if (second.ok) {
    return { ...second, historyTruncatedSince: truncateSinceIso(limits.degrade.sinceMonths) };
  }
  return {
    ok: false,
    reason: second.reason,
    detail: `full clone failed (${first.reason}: ${first.detail}); degrade attempt failed (${second.reason}: ${second.detail})`,
    elapsedMs: first.elapsedMs + second.elapsedMs,
  };
}

/**
 * Клон удаляется сразу после извлечения фактов – код не храним. Windows
 * держит дескрипторы убитых git-подпроцессов и отдает EBUSY, а сбой уборки не
 * должен ронять успешный сбор: несколько попыток с паузой, затем текст ошибки
 * вызывающему (следующий скан все равно кладет клон в новый mkdtemp).
 */
export function cleanupClone(dir: string, attempts = 3, pauseMs = 250): string | null {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: pauseMs });
      return null;
    } catch (e) {
      if (i === attempts - 1) return String((e as Error).message).slice(0, 160);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    }
  }
  return null;
}

/** Git for Windows может отпустить файлы чуть позже выхода родителя. */
async function cleanupFailedClone(dir: string): Promise<void> {
  if (process.platform === "win32") await sleep(500);
  const firstError = cleanupClone(dir, 5);
  if (firstError !== null && process.platform === "win32") {
    await sleep(500);
    cleanupClone(dir, 5);
  }
}

/** Полный набор git-фактов как no-data (клон не удался или пустой). */
export function gitFactsNoData(reason: "limits" | "empty" | "other", detail: string, collectedAt = new Date().toISOString()): Fact[] {
  return GIT_KINDS.map((k) => noDataFact(k, reason, "git", scrubDetail(detail), collectedAt));
}

// ---------- первая эвристика роботов ----------
// Флаги пишутся в timeline, но расчет их не использует: он считает признак
// robot2 по сырым событиям, которые хранятся полностью.

/** Имя или email коммитера содержит robot|sync|bot|-github (без учета регистра). */
export function isRobotPattern(committerName: string, committerEmail: string): boolean {
  const s = `${committerName} ${committerEmail}`.toLowerCase();
  return /robot|sync|bot|-github/.test(s);
}

/**
 * Регулярный интервал: серия из ≥6 коммитов подряд (по дате коммитера), где
 * каждый Δt в пределах ±20% от медианы Δt серии. Флаги возвращаются в порядке
 * входного массива (ts – мс epoch).
 * Две фазы, потому что жадный префикс теряет серии, у которых медиана
 * «доезжает» позже: сначала максимальные отрезки с max/min ≤ 1.5 (необходимое
 * условие для ±20%: 1.2/0.8), затем внутри них окна со строгим условием.
 * MAX_RUN ограничивает патологию – гигантские ровные серии зеркал.
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
      // фаза 2: строгие окна внутри кандидата; без break, потому что медиана
      // окна может «доехать» до ранних элементов на поздних расширениях
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

// ---------- флаги секций README (словарь на русском и английском) ----------

const SECTION_DICT: Record<"install" | "build" | "test", string[]> = {
  install: ["установка", "install", "getting started", "быстрый старт", "setup", "запуск"],
  build: ["сборка", "build"],
  test: ["тесты", "testing", "tests", "запуск тестов"],
};

function headingMatchesWord(heading: string, word: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(heading);
}

/**
 * Заголовки README с непустым телом: до следующего заголовка того же или более
 * высокого уровня есть строка текста или блок кода с содержимым – пустой
 * «## Install» раздела не дает. Ограды блоков кода (```/~~~) и
 * HTML-комментарии содержанием не считаются.
 */
export function readmeHeadingsWithBody(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const heads: { i: number; level: number; line: string }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^[ \t]{0,3}(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = l.match(/^[ \t]{0,3}(#{1,6}) \S.*$/);
    if (m) heads.push({ i, level: m[1]!.length, line: l });
  });
  const out: string[] = [];
  heads.forEach((h, k) => {
    const next = heads.slice(k + 1).find((n) => n.level <= h.level);
    const body = lines.slice(h.i + 1, next ? next.i : lines.length);
    const meaningful = body.some((l) => {
      const t = l.trim();
      if (t === "" || /^(```|~~~)\S*$/.test(t) || /^#{1,6}( |$)/.test(t)) return false;
      return t.replace(/<!--.*?-->/g, "").trim() !== "";
    });
    if (meaningful) out.push(h.line);
  });
  return out;
}

/** Флаги {install, build, test} по заголовкам README с непустым телом. */
export function readmeSectionFlags(text: string): { install: boolean; build: boolean; test: boolean } {
  const flags = { install: false, build: false, test: false };
  const headings = readmeHeadingsWithBody(text);
  for (const hRaw of headings) {
    const h = hRaw.replace(/^[ \t]{0,3}#{1,6}\s+/, "").trim().toLowerCase();
    // «Запуск тестов» (test) содержит «Запуск» (install) – фраза важнее
    // одиночного слова
    const testPhrase = SECTION_DICT.test.filter((w) => w.includes(" ")).some((w) => headingMatchesWord(h, w));
    for (const cat of ["install", "build", "test"] as const) {
      for (const word of SECTION_DICT[cat]) {
        if (word.includes(" ")) continue; // фразы ниже отдельно
        if (cat === "install" && testPhrase) continue;
        if (headingMatchesWord(h, word)) {
          flags[cat] = true;
          break;
        }
      }
      if (!testPhrase) {
        for (const word of SECTION_DICT[cat].filter((w) => w.includes(" "))) {
          if (headingMatchesWord(h, word)) flags[cat] = true;
        }
      } else if (cat === "test") {
        flags.test = true;
      }
    }
  }
  return flags;
}

// ---------- has_steps в ci.yaml: хотя бы один task с непустой командой ----------

/** Непустая команда script: строка или блочный скаляр yamlmini ({__block}). */
function nonEmptyCommand(cmd: unknown): boolean {
  if (typeof cmd === "string") return cmd.trim() !== "";
  if (cmd && typeof cmd === "object" && "__block" in (cmd as Record<string, unknown>)) {
    return String((cmd as { __block: unknown }).__block ?? "").trim() !== "";
  }
  return false;
}

/**
 * has_steps по разобранному ci.yaml: хотя бы один task с непустой командой
 * script (task.script или task.cubes[].script). В живых конфигах задачи
 * лежат и в верхнем tasks, и в workflows.<name>.tasks, а команды бывают и
 * строками, и блочными скалярами «- |». Кубы с action/image без script не
 * считаются: нужен именно выполняемый script, а не заготовка.
 */
export function ciHasSteps(parsed: unknown): boolean {
  const root = parsed as { tasks?: unknown; workflows?: Record<string, unknown> } | null;
  const tasks: unknown[] = [];
  if (Array.isArray(root?.tasks)) tasks.push(...root.tasks);
  if (root?.workflows && typeof root.workflows === "object") {
    for (const wf of Object.values(root.workflows)) {
      if (wf && typeof wf === "object" && Array.isArray((wf as { tasks?: unknown }).tasks)) {
        tasks.push(...((wf as { tasks: unknown[] }).tasks));
      }
    }
  }
  // `script: echo hi` (строка, а не список) и `script: |` – тоже шаг
  const scriptNonEmpty = (s: unknown): boolean => (Array.isArray(s) ? s.some(nonEmptyCommand) : nonEmptyCommand(s));
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const task = t as { script?: unknown; cubes?: unknown };
    if (scriptNonEmpty(task.script)) return true;
    if (Array.isArray(task.cubes)) {
      for (const c of task.cubes) {
        if (c && typeof c === "object" && scriptNonEmpty((c as { script?: unknown }).script)) return true;
      }
    }
  }
  return false;
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

/**
 * Маркеры техдолга – TODO, FIXME, HACK, XXX без учета регистра и только как
 * первое слово комментария. Иначе `#todo-list {`, `i < todo.length;`,
 * `printf("%d todo")` и `// update the todo list` стали бы техдолгом
 * todo-приложений. Правила:
 * - `//`, `/*`, `<!--` – где угодно на строке (комментарий после кода);
 * - `#`, `--`, `;`, `%`, `'`, `*`, `REM` – только в начале строки после отступа
 *   (в середине строки это операторы, селекторы и форматы);
 * - сразу после префикса – пробелы и `@` (`/* @todo *\/`), затем маркер, за ним
 *   `:`, `(`, `!`, пробел, конец строки или `-`, после которого не буква
 *   (`TODO - fix`, но не `todo-list`); у `#` вплотную к маркеру `:` – только
 *   без буквы следом (`#TODO: fix` – пометка, `#todo:hover {` – CSS-селектор).
 * Повтор префикса (`///`, `/**`, `##`, `;;`, `%%`) – тот же комментарий.
 */
const MARKER_AFTER = /^[\s@]*(todo|fixme|hack|xxx)(?=$|[\s:(!]|-(?![\p{L}\p{N}_]))/iu;
const MARKER_AFTER_TIGHT = /^(todo|fixme|hack|xxx)(?=$|[\s(!]|:(?![\p{L}\p{N}_])|-(?![\p{L}\p{N}_]))/iu;
const COMMENT_ANYWHERE = /\/\/+!?|\/\*+!?|<!--/g;
const COMMENT_LINE_START = /^\s*(?:#+|--+|;+|%+|'|\*+|rem\b)/i;

function markerAt(rest: string, tight: boolean): "TODO" | "FIXME" | null {
  const hit = (tight ? MARKER_AFTER_TIGHT : MARKER_AFTER).exec(rest);
  if (!hit) return null;
  return hit[1]!.toLowerCase() === "todo" ? "TODO" : "FIXME";
}

/** Вид маркера техдолга в строке (TODO → «TODO», FIXME/HACK/XXX → «FIXME») или null. */
export function todoMarkerKind(line: string): "TODO" | "FIXME" | null {
  const lead = COMMENT_LINE_START.exec(line);
  if (lead) {
    const rest = line.slice(lead[0].length);
    // `#todo-list {` – селектор CSS, поэтому `#` вплотную к маркеру проверяется строже
    const kind = markerAt(rest, lead[0].trimStart().startsWith("#") && !/^[\s@]/.test(rest));
    if (kind) return kind;
  }
  COMMENT_ANYWHERE.lastIndex = 0;
  for (let m = COMMENT_ANYWHERE.exec(line); m !== null; m = COMMENT_ANYWHERE.exec(line)) {
    const kind = markerAt(line.slice(m.index + m[0].length), false);
    if (kind) return kind;
  }
  return null;
}

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
  /** максимум файлов, прогоняемых через blame (Config.scan.extract) */
  maxBlameFiles: number;
  /** максимальный размер текстового файла для LOC/TODO (Config.scan.extract) */
  textCapBytes: number;
  /** общий бюджет извлечения; отсутствует = без дедлайна */
  deadlineMs?: number;
  /** дата отсечения усеченного клона → history_truncated_since */
  historyTruncatedSince?: string;
  now?: Date;
  /** подмена `git cat-file --batch` в тестах */
  catFile?: CatFileSpawn;
  /**
   * Сюда кладется head_sha из `rev-parse --verify`, который extractFacts и так
   * делает; runner пишет его в scans.head_sha.
   */
  out?: { headSha?: string | null };
}

/** Факты из bare-клона; все даты в UTC ISO 8601, source="git". */
export async function extractFacts(cloneDir: string, opts: ExtractOptions): Promise<Fact[]> {
  const started = Date.now();
  const deadline = opts.deadlineMs !== undefined ? started + opts.deadlineMs : Infinity;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const textCap = opts.textCapBytes;
  const maxBlameFiles = opts.maxBlameFiles;
  const git = (args: string[], timeoutMs = 120_000) =>
    execGit(["--git-dir", cloneDir, ...args], { timeoutMs });

  // HEAD и пустота репо
  let branch = "HEAD";
  try {
    branch = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim() || "HEAD";
    const sha = (await git(["rev-parse", "--verify", `${branch}^{commit}`])).stdout.trim();
    if (opts.out) opts.out.headSha = sha || null;
  } catch (e) {
    // empty – только однозначное «нет коммитов» (клон читается, а коммитов в
    // нем нет); любое другое исключение – other
    if (opts.out) opts.out.headSha = null;
    const detail = String((e as Error).message).slice(0, 120);
    let noCommits = false;
    try {
      noCommits = (await git(["rev-list", "--all", "--max-count=1"])).stdout.trim() === "";
    } catch {
      noCommits = false;
    }
    return noCommits
      ? gitFactsNoData("empty", `no commits at HEAD (${detail})`, nowIso)
      : gitFactsNoData("other", `HEAD unreadable (${detail})`, nowIso);
  }

  // --- 1. таймлайн коммитов ---
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
      ...(opts.historyTruncatedSince ? { history_truncated_since: opts.historyTruncatedSince } : {}),
    },
    "git",
    nowIso,
  );

  // --- 1б. карта владельцев файлов `code.ownership` (ownership.ts) ---
  // Роботы и синхронизации исключаются по sha из robot2, как в расчете, а не по
  // флагу `robot` выше. --since по дате коммитера только отсекает объем, окно по
  // дате автора применяет агрегатор; обрезка по бюджету помечается в факте.
  // Сбой git log – факт `bad` без путей машины: скан из-за справочного
  // показателя пригодность не теряет.
  let ownershipFact: Fact;
  try {
    const excluded = new Set<string>();
    robot2Flags(events).flags.forEach((f, i) => {
      if (f.robot || f.sync) excluded.add(events[i]!.sha);
    });
    const since = new Date(now.getTime() - (OWNERSHIP_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    const ownRaw = await git(
      ["-c", "core.quotepath=off", "log", "--no-merges", `--since=${since}`, `--max-count=${OWNERSHIP_MAX_COMMITS + 1}`, `--format=${OWNERSHIP_LOG_FORMAT}`, "--name-only", branch],
      120_000,
    );
    const commits = parseOwnershipLog(ownRaw.stdout);
    const commitsTruncated = commits.length > OWNERSHIP_MAX_COMMITS;
    ownershipFact = okFact(
      "code.ownership",
      aggregateOwnership(commitsTruncated ? commits.slice(0, OWNERSHIP_MAX_COMMITS) : commits, {
        now,
        excluded,
        commitsTruncated,
        historyTruncatedSince: opts.historyTruncatedSince,
      }),
      "git",
      nowIso,
    );
  } catch {
    ownershipFact = badChannelFact("code.ownership", "git", "git log for ownership failed", nowIso);
  }

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

  // --- 3. CI-конфиги: полный список .sourcecraft/** и has_steps ---
  const scPaths = blobs.map((b) => b.path).filter((p) => p.startsWith(".sourcecraft/")).sort();
  const hasCiYaml = scPaths.includes(".sourcecraft/ci.yaml");
  // неразобранный ci.yaml – `has_steps: null` (неизвестно), а не «шагов нет»;
  // расчет тогда дает CI «нет данных»
  let hasSteps: boolean | null = false;
  let stepsNote: string | undefined;
  if (hasCiYaml) {
    const ciBlob = blobs.find((b) => b.path === ".sourcecraft/ci.yaml")!;
    try {
      const content = await git(["cat-file", "blob", ciBlob.sha]);
      hasSteps = ciHasSteps(parseYamlSubset(content.stdout));
    } catch (e) {
      hasSteps = null;
      stepsNote = `ci.yaml parse failed: ${String((e as Error).message).slice(0, 80)}`;
    }
  }
  const cicdConfigsFact = okFact(
    "cicd.configs",
    { paths: scPaths, has_ci_yaml: hasCiYaml, has_steps: hasSteps, ...(stepsNote ? { steps_note: stepsNote } : {}) },
    "git",
    nowIso,
  );

  // --- 4. документация и флаги секций README ---
  const rootNames = topLevel.map((t) => t.name);
  const hasRoot = (re: RegExp) => rootNames.some((n) => re.test(n));
  // документ засчитывается, только если в нем есть текст – не меньше
  // DOC_MIN_CHARS непробельных символов (пустой LICENSE – не лицензия).
  // Каталог (`LICENSES/`) – если такой текст есть хотя бы в одном файле
  const docWithContent = async (re: RegExp): Promise<boolean> => {
    for (const entry of topLevel.filter((t) => re.test(t.name))) {
      const files = entry.type === "tree" ? blobs.filter((b) => b.path.startsWith(`${entry.name}/`)).slice(0, 20) : blobs.filter((b) => b.path === entry.name);
      for (const b of files) {
        if (b.size < DOC_MIN_CHARS) continue;
        try {
          if (docHasContent((await git(["cat-file", "blob", b.sha])).stdout)) return true;
        } catch {
          /* блоб не прочитан – содержание не доказано */
        }
      }
    }
    return false;
  };
  const docsPresenceFact = okFact(
    "docs.presence",
    {
      readme: hasRoot(/^readme(\.|$)/i),
      // в том числе LICENSE-MIT, COPYING, UNLICENSE и каталог LICENSES
      license: await docWithContent(/^(licen[cs]es?|copying|unlicense)([._-].*)?$/i),
      contributing: await docWithContent(/^contributing(\.|$)/i),
      codeowners: await docWithContent(/^codeowners(\.|$)/i),
      // файлы проверены по содержанию – расчет не подменяет это именем файла
      // в корне (у старых фактов поля нет)
      content_checked: true,
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
    readmeFact = okFact("docs.readme", { bytes: readmeBlob.size, sections, flags: readmeSectionFlags(text) }, "git", nowIso);
  } else {
    readmeFact = okFact("docs.readme", { present: false }, "git", nowIso);
  }

  // --- 5. LOC и TODO/FIXME потоком через git cat-file --batch ---
  const candidates = blobs.filter((b) => b.size > 0 && b.size <= textCap);
  let loc = 0;
  // строки и пометки считаются только по коду (isSourcePath); `source_files = 0`
  // – «кода нет»
  let sourceLoc = 0;
  const sourceFiles = blobs.filter((b) => isSourcePath(b.path)).length;
  // непустые файлы тестов (хотя бы одна непробельная строка): пустые
  // `tests/t_*.py` и `.gitkeep` тестами не считаются
  let testFiles = 0;
  // файлы кода, строки которых не прочитаны (больше лимита текста или
  // бинарные): `source_loc = 0` у них – незнание, а не «кода нет»
  let sourceUnread = blobs.filter((b) => b.size > textCap && isSourcePath(b.path)).length;
  // файлы с «кодовым» именем, оказавшиеся бинарными, – не код
  let sourceBinary = 0;
  // любой обрыв потока `cat-file` (дедлайн, оборванный заголовок, недочитанный
  // блоб) делает LOC и TODO неполными; иначе «ok, loc = 0» читалось бы как
  // «кода нет»
  let locIncomplete = false;
  const todoOccs: TodoOccurrence[] = [];
  // маркеры в файлах тестов в счетчик долга не идут: у сканеров TODO тесты и
  // фикстуры состоят из намеренных маркеров. Их число пишется в
  // `test_markers`, чтобы читатель факта видел, сколько отложено в сторону
  let testMarkers = 0;
  if (candidates.length > 0) {
    const catFile: CatFileSpawn =
      opts.catFile ??
      ((dir) =>
        Bun.spawn(["git", "--git-dir", dir, "cat-file", "--batch"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        }));
    const proc = catFile(cloneDir);
    const enc = new TextEncoder();
    // отказ писателя (git умер раньше, поток закрыт) обрабатываем сразу: иначе
    // отказ промиса до `finally` ниже был бы необработанным и ронял процесс
    // (в Bun unhandled rejection → exit 1). Неполноту чтения покажет читатель
    const writer = (async () => {
      for (const b of candidates) proc.stdin.write(enc.encode(`${b.sha}\n`));
      await proc.stdin.end();
    })().catch(() => undefined);
    const reader = new ByteReader(proc.stdout.getReader());
    try {
      for (let i = 0; i < candidates.length; i++) {
        if (Date.now() > deadline) {
          locIncomplete = true;
          break;
        }
        const entry = candidates[i]!;
        const header = await reader.readLine();
        if (header === null) {
          locIncomplete = true;
          break;
        }
        // формат: "<sha> blob <size>" (или "<sha> missing")
        const m = header.match(/^([0-9a-f]+) (?:blob|tag|tree) (\d+)$/);
        if (!m) {
          if (isSourcePath(entry.path)) sourceUnread++;
          continue;
        }
        const size = parseInt(m[2]!, 10);
        const buf = await reader.readExact(size);
        await reader.readByte(); // завершающий \n
        if (buf === null) {
          locIncomplete = true;
          break;
        }
        const probe = buf.subarray(0, Math.min(8192, buf.length));
        if (probe.includes(0)) {
          // бинарный файл – не код (а не «строки не прочитаны»): README +
          // app.bin – все равно «кода нет»
          if (isSourcePath(entry.path)) sourceBinary++;
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const lines = text.split("\n");
        // строка без завершающего перевода строки – тоже строка
        const fileLoc = lines.length - (text.endsWith("\n") ? 1 : 0);
        loc += fileLoc;
        if (!isSourcePath(entry.path)) continue;
        sourceLoc += fileLoc;
        const testFile = isTestPath(entry.path);
        if (testFile && /\S/.test(text)) testFiles++;
        for (let ln = 0; ln < lines.length; ln++) {
          const kind = todoKind(lines[ln]!);
          if (!kind) continue;
          if (testFile) testMarkers++;
          else todoOccs.push({ path: entry.path, line: ln + 1, kind });
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
      loc: locIncomplete ? null : loc,
      source_files: sourceFiles - sourceBinary,
      // при обрыве чтения непустоту всех файлов тестов не проверить
      test_files: locIncomplete ? null : testFiles,
      source_loc: locIncomplete ? null : sourceLoc,
      source_unread: locIncomplete ? null : sourceUnread,
      ...(locIncomplete ? { loc_note: "incomplete" } : {}),
    },
    "git",
    nowIso,
  );

  // --- 6. давность TODO/FIXME по blame ---
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
      for (const { text, ts } of blameLineTimes(out.stdout)) {
        if (todoKind(text) && ts !== null && now.getTime() - ts > MS_180D) older180++;
      }
      blamedFiles++;
    } catch {
      /* blame не удался (переименования, субмодули) – файл не входит в older_180d */
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
      // маркеры в файлах тестов, не вошедшие в count/fixme/older_180d
      test_markers: testMarkers,
      // счетчики TODO собраны тем же потоком `cat-file`: оборвался он – неполны
      // и они, и факт должен это сказать
      ...(locIncomplete ? { todo_note: "incomplete" } : {}),
    },
    "git",
    nowIso,
  );

  return [timelineFact, summaryFact, docsPresenceFact, readmeFact, treeStatsFact, cicdConfigsFact, codeTodoFact, ownershipFact];
}

const todoKind = todoMarkerKind;

/** Документ с содержанием – не меньше DOC_MIN_CHARS непробельных символов. */
export const DOC_MIN_CHARS = 16;

export function docHasContent(text: string): boolean {
  return text.replace(/\s+/g, "").length >= DOC_MIN_CHARS;
}

/**
 * Время (мс) каждой строки `git blame --porcelain` – по sha ее заголовка.
 * Porcelain печатает `author-time` только при первом появлении коммита, у
 * повторных групп есть лишь заголовок `<sha> <orig> <final> [<n>]`. Если брать
 * последнее прочитанное время, старый TODO после свежей вставки другим
 * коммитом окажется свежим.
 */
export function blameLineTimes(porcelain: string): { text: string; ts: number | null }[] {
  const times = new Map<string, number>();
  const out: { text: string; ts: number | null }[] = [];
  let sha: string | null = null;
  for (const line of porcelain.split("\n")) {
    const header = line.match(/^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/);
    if (header) {
      sha = header[1]!;
      continue;
    }
    const at = line.match(/^author-time (\d+)$/);
    if (at && sha !== null) {
      times.set(sha, parseInt(at[1]!, 10) * 1000);
      continue;
    }
    if (line.startsWith("\t")) out.push({ text: line.slice(1), ts: sha !== null ? (times.get(sha) ?? null) : null });
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
