// shot.ts — харнесс скриншотов на сыром CDP, ноль новых зависимостей
// (решение канвы «з»): поднимает наш сервер на временном порту, водит
// headless Chrome по обеим страницам, ловит ошибки консоли и внешние
// запросы, кладёт PNG в reports/shots/. В `bun test` не входит — требует
// установленный Chrome. Сети наружу приложение не делает: единственное
// разрешённое исключение — шрифты uikit (решение канвы «к»).
//
// Запуск: bun scripts/shot.ts [org/repo]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SLUG = process.argv[2] ?? "bayselonarrend/openintegrations";
const SERVER_PORT = Number(process.env.SHOT_PORT ?? 8519);
const CDP_PORT = Number(process.env.SHOT_CDP_PORT ?? 9519);
const SHOTS_DIR = "reports/shots";
/** Шрифты uikit грузит сам пакет (styles/fonts.css → @import) — не наш код. */
const ALLOWED_EXTERNAL = ["fonts.googleapis.com", "fonts.gstatic.com"];

function chromePath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : undefined,
  ].filter((p): p is string => typeof p === "string" && p !== "");
  return candidates.find((p) => existsSync(p)) ?? null;
}

const chrome = chromePath();
if (!chrome) {
  // честный выход вместо ожидания несуществующего эндпоинта по таймауту
  console.error("Chrome не найден. Укажите путь переменной CHROME_PATH или установите Google Chrome.");
  process.exit(2);
}

interface Problem {
  page: string;
  kind: string;
  text: string;
}

const problems: Problem[] = [];
const externals = new Set<string>();

// ---------- сервер ----------

const server = spawn(process.execPath, ["run", "src/server.ts"], {
  env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR: process.env.DATA_DIR ?? "data", NODE_ENV: "production" },
  stdio: "ignore",
});

const base = `http://127.0.0.1:${SERVER_PORT}`;
await waitFor(async () => (await fetch(`${base}/api/health`)).ok, "сервер не поднялся");

// ---------- chrome ----------

const profile = mkdtempSync(join(tmpdir(), "rh-shot-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
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
  target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) as typeof target;
  return target !== undefined;
}, "Chrome не отдал DevTools-эндпоинт");

const ws = new WebSocket(target!.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP: соединение не открылось")), { once: true });
});

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let currentPage = "";
const loaded = { fired: false };

function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
}

ws.addEventListener("message", (event) => {
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
      // ошибка = уровень error; warning (в т.ч. StrictMode) харнесс не роняет
      if (msg.params.type === "error") {
        problems.push({ page: currentPage, kind: "console.error", text: preview(msg.params.args) });
      }
      break;
    case "Log.entryAdded":
      if (msg.params.entry.level === "error") {
        problems.push({ page: currentPage, kind: "log.error", text: `${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim() });
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
});

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

// В4: «Мой кабинет» без сессии — витрина слоёв (Я ID → PAT) и входа
await shoot("me", `${base}/me`, {
  "заголовок кабинета": `document.querySelectorAll('h1').length`,
  "кнопка входа Я ID": `[...document.querySelectorAll('a,button')].filter((n) => n.textContent?.includes("Войти через Я ID")).length`,
});

await shoot("repo", `${base}/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`, {
  "блок Score": "document.body.innerText.includes('из 100') ? 1 : 0",
  "категории": "document.body.innerText.includes('Категории') ? 1 : 0",
  "рекомендации": "document.body.innerText.includes('Рекомендации') ? 1 : 0",
  "объяснение Security": "document.body.innerText.includes('исключена с перенормировкой') ? 1 : 0",
  "кнопка отчёта": "document.querySelectorAll('a[href$=\"report.md\"]').length",
});

// ---------- итог ----------

const badExternals = [...externals].filter((url) => {
  const host = safeHost(url);
  return host === null || !ALLOWED_EXTERNAL.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
});

console.log("");
console.log(`внешние запросы: ${externals.size} (разрешённые шрифты uikit: ${externals.size - badExternals.length})`);
for (const url of externals) console.log(`  ${url}`);
console.log(`ошибки консоли: ${problems.length}`);
for (const p of problems) console.log(`  [${p.page}] ${p.kind}: ${p.text}`);

ws.close();
browser.kill();
server.kill();
await cleanupProfile();

if (problems.length > 0 || badExternals.length > 0) {
  if (badExternals.length > 0) console.error(`ЗАПРЕЩЁННЫЕ внешние запросы: ${badExternals.join(", ")}`);
  process.exit(1);
}
console.log("харнесс: чисто");
process.exit(0);

// ---------- механика ----------

async function shoot(name: string, url: string, checks: Record<string, string>): Promise<void> {
  currentPage = name;
  loaded.fired = false;
  await call("Page.navigate", { url });
  await waitFor(async () => loaded.fired, `${name}: страница не загрузилась`);
  // данные приезжают запросом уже после load — ждём появления ключевых узлов
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
  const res = await call<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true });
  return res.result.value;
}

async function waitFor(check: () => Promise<boolean>, message: string, attempts = 80, delayMs = 250): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await check()) return;
    } catch {
      // сервер или Chrome ещё не отвечают — это ожидаемо на старте
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(message);
}

/**
 * Windows отдаёт EBUSY, пока Chrome не отпустил профиль. Уборка временного
 * каталога — не результат прогона: она не имеет права ронять харнесс
 * (тот же урок, что с cleanupClone в В2, ERROR_LOG 16.09).
 */
async function cleanupProfile(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.log(`профиль Chrome остался в ${profile} (Windows держит файлы) — можно удалить вручную`);
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
    .map((a) => (a.description !== undefined ? a.description : JSON.stringify(a.value)))
    .join(" ")
    .slice(0, 400);
}
