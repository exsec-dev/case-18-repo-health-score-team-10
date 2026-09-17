// shot.ts — харнесс скриншотов на сыром CDP, ноль новых зависимостей.
// Поднимает локальный сервер в development или production, водит headless
// Chrome по трём экранам, ловит ошибки консоли и внешние запросы, кладёт PNG
// в reports/shots/<mode>/. В `bun test` не входит — требует Chrome.
//
// Запуск:
//   SHOT_MODE=production bun scripts/shot.ts [org/repo]
//   SHOT_MODE=development bun scripts/shot.ts [org/repo]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ShotMode = "development" | "production";

const SLUG = process.argv[2] ?? "bayselonarrend/openintegrations";
const SERVER_PORT = Number(process.env.SHOT_PORT ?? 8519);
const CDP_PORT = Number(process.env.SHOT_CDP_PORT ?? 9519);
const MODE = parseMode(process.env.SHOT_MODE);
const SHOTS_DIR = join("reports", "shots", MODE);
/**
 * Шрифты uikit грузит сам пакет (styles/fonts.css → @import) — не наш код.
 * Аватары (17.09, В4.5): logo.url репозиториев SourceCraft и портреты Я ID —
 * необязательные картинки, без сети UI показывает инициалы.
 */
const ALLOWED_EXTERNAL = ["fonts.googleapis.com", "fonts.gstatic.com", "storage.yandexcloud.net", "avatars.yandex.net"];

interface Problem {
  page: string;
  kind: string;
  text: string;
}

const problems: Problem[] = [];
const externals = new Set<string>();
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const loaded = { fired: false };
let nextId = 1;
let currentPage = "";
let server: ChildProcess | null = null;
let browser: ChildProcess | null = null;
let ws: WebSocket | null = null;
let profile: string | null = null;

try {
  await run();
} catch (error) {
  console.error(`харнесс (${MODE}): ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function run(): Promise<void> {
  const chrome = chromePath();
  if (!chrome) throw new Error("Chrome не найден. Укажите CHROME_PATH или установите Google Chrome.");

  server = spawn(process.execPath, ["run", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      DATA_DIR: process.env.DATA_DIR ?? "data",
      NODE_ENV: MODE,
      // Приёмка UI не имеет права случайно запустить живой обход каталога.
      SCHEDULER_START_DELAY_MS: "86400000",
    },
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${SERVER_PORT}`;
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, "сервер не поднялся");

  profile = mkdtempSync(join(tmpdir(), `rh-shot-${MODE}-`));
  browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      "--window-size=1440,1200",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let target: { webSocketDebuggerUrl: string } | undefined;
  await waitFor(async () => {
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    target = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) as typeof target;
    return target !== undefined;
  }, "Chrome не отдал DevTools-эндпоинт");

  ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws!.addEventListener("open", () => resolve(), { once: true });
    ws!.addEventListener("error", () => reject(new Error("CDP: соединение не открылось")), { once: true });
  });
  ws.addEventListener("message", handleMessage);

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Network.enable");

  mkdirSync(SHOTS_DIR, { recursive: true });
  const [org, repo] = SLUG.split("/") as [string, string];

  await shoot("rating", `${base}/?sort=score&order=desc`, {
    "строк таблицы": "document.querySelectorAll('table tbody tr').length",
    "заголовок рейтинга": "document.body.innerText.includes('Рейтинг здоровья репозиториев') ? 1 : 0",
    "колонка Score": "document.body.innerText.includes('Score') ? 1 : 0",
  });

  // «Личный кабинет» без сессии — витрина слоёв (Я ID → токен доступа) и входа.
  await shoot("me", `${base}/me`, {
    "заголовок кабинета": "document.querySelectorAll('h1').length",
    "кнопка входа Я ID": `[...document.querySelectorAll('a,button')].filter((n) => n.textContent?.includes("Войти через Я ID")).length`,
  });

  await shoot("repo", `${base}/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, {
    "блок Score": "document.body.innerText.includes('из 100') ? 1 : 0",
    категории: "document.body.innerText.includes('Категории') ? 1 : 0",
    рекомендации: "document.body.innerText.includes('Рекомендации') ? 1 : 0",
    "tri-state NULL": "document.body.textContent?.includes('При покрытии данными ниже 40% Score не выставляется') ? 1 : 0",
    "объяснение закрытых каналов": "document.body.innerText.includes('CI и Security видны участникам репозитория') ? 1 : 0",
    "кнопка отчета": "[...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Отчет').length",
  });

  const badExternals = [...externals].filter((url) => {
    const host = safeHost(url);
    return host === null || !ALLOWED_EXTERNAL.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  });

  console.log("");
  console.log(`режим: ${MODE}`);
  console.log(`внешние запросы: ${externals.size} (разрешённые: ${externals.size - badExternals.length})`);
  for (const url of externals) console.log(`  ${url}`);
  console.log(`ошибки консоли: ${problems.length}`);
  for (const problem of problems) console.log(`  [${problem.page}] ${problem.kind}: ${problem.text}`);

  if (problems.length > 0 || badExternals.length > 0) {
    if (badExternals.length > 0) console.error(`ЗАПРЕЩЁННЫЕ внешние запросы: ${badExternals.join(", ")}`);
    throw new Error("найдены ошибки страницы или запрещённые внешние запросы");
  }
  console.log(`харнесс (${MODE}): чисто`);
}

function handleMessage(event: MessageEvent): void {
  const msg = JSON.parse(String(event.data));
  if (msg.id) {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
    return;
  }
  switch (msg.method) {
    case "Page.loadEventFired":
      loaded.fired = true;
      break;
    case "Runtime.consoleAPICalled":
      if (msg.params.type === "error") {
        problems.push({ page: currentPage, kind: "console.error", text: preview(msg.params.args) });
      }
      break;
    case "Log.entryAdded":
      if (msg.params.entry.level === "error") {
        problems.push({
          page: currentPage,
          kind: "log.error",
          text: `${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim(),
        });
      }
      break;
    case "Runtime.exceptionThrown":
      problems.push({
        page: currentPage,
        kind: "exception",
        text: msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "unknown",
      });
      break;
    case "Network.requestWillBeSent": {
      const url = String(msg.params.request.url);
      if (url.startsWith("data:") || url.startsWith("blob:")) break;
      const host = safeHost(url);
      if (host === null || host === `127.0.0.1:${SERVER_PORT}` || host === `localhost:${SERVER_PORT}`) break;
      externals.add(url);
      break;
    }
  }
}

function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP закрыт перед ${method}`));
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function shoot(name: string, url: string, checks: Record<string, string>): Promise<void> {
  currentPage = name;
  loaded.fired = false;
  await call("Page.navigate", { url });
  await waitFor(async () => loaded.fired, `${name}: страница не загрузилась`);
  const first = Object.values(checks)[0]!;
  await waitFor(async () => (await evaluate<number>(first)) > 0, `${name}: ключевой узел не появился`);

  const results: string[] = [];
  for (const [label, expression] of Object.entries(checks)) {
    const value = await evaluate<number>(expression);
    results.push(`${label}=${value}`);
    if (value === 0) problems.push({ page: name, kind: "node", text: `узел не найден: ${label}` });
  }

  const shot = await call<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = join(SHOTS_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`${name}: ${url}`);
  console.log(`  ${results.join(", ")}`);
  console.log(`  скриншот: ${file}`);
}

async function evaluate<T>(expression: string): Promise<T> {
  const response = await call<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(`ошибка evaluate на странице ${currentPage}`);
  return response.result.value;
}

async function cleanup(): Promise<void> {
  if (ws) {
    ws.removeEventListener("message", handleMessage);
    ws.close();
    ws = null;
  }
  await stopChild(browser);
  await stopChild(server);
  browser = null;
  server = null;
  if (profile) await cleanupProfile(profile);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(50);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function cleanupProfile(path: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await delay(300);
    }
  }
  console.log(`профиль Chrome остался в ${path} (Windows держит файлы) — можно удалить вручную`);
}

async function waitFor(check: () => Promise<boolean>, message: string, attempts = 80, delayMs = 250): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await check()) return;
    } catch {
      // Сервер или Chrome ещё не отвечают — ожидаемо на старте.
    }
    await delay(delayMs);
  }
  throw new Error(message);
}

function parseMode(raw: string | undefined): ShotMode {
  if (raw === undefined || raw === "" || raw === "production") return "production";
  if (raw === "development") return "development";
  throw new Error(`SHOT_MODE должен быть development или production, получено: ${raw}`);
}

function chromePath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : undefined,
  ].filter((path): path is string => typeof path === "string" && path !== "");
  return candidates.find((path) => existsSync(path)) ?? null;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function preview(args: { value?: unknown; description?: string }[]): string {
  return args
    .map((arg) => (arg.description !== undefined ? arg.description : JSON.stringify(arg.value)))
    .join(" ")
    .slice(0, 400);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
