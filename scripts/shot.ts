// shot.ts — харнесс скриншотов на сыром CDP, ноль новых зависимостей.
// Поднимает локальный сервер в development или production, водит headless
// Chrome по трём страницам в ТРЁХ РАЗРЕШЕНИЯХ, ловит ошибки консоли и внешние
// запросы, кладёт PNG в reports/shots/<mode>/. В `bun test` не входит —
// требует Chrome.
//
// В4.6 (У23/У19): разрешений три, а не одно. Приёмка вехи спрашивает «влезает
// ли в один экран» и «не обрезаны ли данные», а на это отвечает только
// снимок РОВНО ВИДИМОЙ ОБЛАСТИ — поэтому основной файл снимается БЕЗ
// `captureBeyondViewport` (постраничный снимок склеивает всю прокрутку и
// вопрос про один экран не решает вовсе). Постраничный остаётся вторым
// файлом с суффиксом `-full` для чтения содержимого целиком.
// Схема имён: reports/shots/<mode>/<page>@<width>.png (+ `<page>@<width>-full.png`).
// 3 страницы x 3 ширины x 2 режима = 18 приёмочных файлов.
//
// Запуск:
//   SHOT_MODE=production bun scripts/shot.ts [org/repo]
//   SHOT_MODE=development bun scripts/shot.ts [org/repo]
// DATA_DIR задавать ЯВНО (урок инцидента 19.09, ERROR_LOG): без него харнесс
// сам снимает файловую копию живой базы, но полагаться на дефолт нельзя.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ShotMode = "development" | "production";

/**
 * DATA_DIR харнесса: без явной переменной — КОПИЯ живой базы во
 * временном каталоге, оригинал не открывается (урок 19.09: прежний
 * дефолт "data" дал стартовому серверу мигрировать живую БД мимо
 * гейта HQ — ERROR_LOG). Явный DATA_DIR — доверяем как есть.
 */
function harnessDataDir(): string {
  const explicit = process.env.DATA_DIR;
  if (explicit) return explicit;
  const dir = mkdtempSync(join(tmpdir(), "rh-shot-data-"));
  const live = join("data", "repo-health.db");
  if (existsSync(live)) {
    // ТОЛЬКО файловое копирование: SQLite-хендл на живой базе запрещён
    // (ERROR_LOG 19–20.09). WAL и SHM копируются рядом — без них копия
    // теряет последние транзакции и показывает вчерашние данные.
    copyFileSync(live, join(dir, "repo-health.db"));
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(live + suffix)) copyFileSync(live + suffix, join(dir, `repo-health.db${suffix}`));
    }
    console.log(`[shot] DATA_DIR не задан: работаю с КОПИЕЙ живой базы (${dir}) — оригинал не трогается`);
  } else {
    console.log(`[shot] DATA_DIR не задан: чистый временный каталог ${dir}`);
  }
  return dir;
}

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

/**
 * Три разрешения приёмки В4.6. 1366x768 — целевое: именно на нём проверяется,
 * что величина и шесть категорий влезают в один экран и что таблица рейтинга
 * не обрезана (порог правой панели поднят до 1440 ровно ради него).
 * 1440x1200 — ширина, на которой снимала дизайн-пара (сопоставимость с её
 * замерами). 1920x1080 — верхняя граница сетки: на ней проверяется мера
 * основной колонки и то, что полоса категории не растянулась в декорацию.
 */
/**
 * Порог правой панели рейтинга (Shell.tsx, У23). Включительный: на ровно
 * 1440 панель на месте, ниже — в Drawer. Харнесс держит число рядом с проверками,
 * чтобы не требовать содержимого панели там, где его нет по замыслу.
 */
const WIDE_MIN = 1440;

const VIEWPORTS: { width: number; height: number }[] = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 1200 },
  { width: 1366, height: 768 },
];

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
      DATA_DIR: harnessDataDir(),
      NODE_ENV: MODE,
      // Приёмка UI не имеет права случайно запустить живой обход каталога.
      SCHEDULER_START_DELAY_MS: "86400000",
    },
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${SERVER_PORT}`;
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok, "сервер не поднялся");
  // Прогрев бандла ДО прихода Chrome: в development Bun собирает HTML-вход
  // (React 19 + uikit) по первому запросу страницы, и на холодном старте это
  // дольше окна ожидания `load`. /api/health бандл не трогает, поэтому греем
  // сам «/» — иначе первый навигейт падал «страница не загрузилась» в
  // development и проходил в production, где чанки уже минифицированы.
  await waitFor(async () => (await fetch(`${base}/`)).ok, "страница «/» не собралась", 240, 500);

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
      // viewport задаётся через CDP (Emulation), окно — просто достаточно большое
      `--window-size=${VIEWPORTS[0]!.width},${VIEWPORTS[0]!.height}`,
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

  const pages: { name: string; url: string; checks: Record<string, string>; wideOnly?: Record<string, string> }[] = [
    {
      name: "rating",
      url: `${base}/?sort=index&order=desc`,
      checks: {
        "строк таблицы": "document.querySelectorAll('table tbody tr').length",
        // В4.6 круг 2 (Р5): заголовок — «Рейтинг здоровья ОТКРЫТЫХ репозиториев»
        "заголовок рейтинга": "document.body.innerText.includes('Рейтинг здоровья открытых репозиториев') ? 1 : 0",
        "колонка HealthCraft Index": "document.body.innerText.includes('HealthCraft Index') ? 1 : 0",
        // В4.6 круг 2 (Р21): контрол сортировки не режет собственное значение.
        // Проверяется геометрией, а не на глаз: текст выбранной опции обязан
        // укладываться в свою рамку (scrollWidth <= clientWidth).
        "сортировка не обрезана":
          "(() => { const n = [...document.querySelectorAll('[class*=\"select-control__option-text\"]')].pop(); if (!n) return 0; return n.scrollWidth <= n.clientWidth + 1 ? 1 : 0; })()",
      },
      // В4.6 (У22/У23): ниже 1440 правая панель рейтинга уезжает в закрытый Drawer,
      // и легенды в DOM нет ПО ЗАМЫСЛУ — требовать её там значило бы ловить
      // собственное решение о пороге как дефект.
      wideOnly: {
        "легенда шкалы": "document.body.innerText.includes('Как читать оценку') ? 1 : 0",
      },
    },
    {
      // «Личный кабинет» без сессии — витрина слоёв (Я ID → токен доступа) и входа.
      name: "me",
      url: `${base}/me`,
      checks: {
        "заголовок кабинета": "document.querySelectorAll('h1').length",
        "кнопка входа Я ID": `[...document.querySelectorAll('a,button')].filter((n) => n.textContent?.includes("Войти через Я ID")).length`,
      },
    },
    {
      name: "repo",
      url: `${base}/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
      checks: {
        "блок Score": "document.body.innerText.includes('из 100') ? 1 : 0",
        категории: "document.body.innerText.includes('Категории') ? 1 : 0",
        рекомендации: "document.body.innerText.includes('Рекомендации') ? 1 : 0",
        "tri-state NULL": "document.body.textContent?.includes('показатель не выставляется') ? 1 : 0",
        "объяснение закрытых каналов": "document.body.innerText.includes('входят только в Repo Health Score') ? 1 : 0",
        "кнопка отчета": "[...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Отчет').length",
        // В4.6, приёмка вариантa А (пункт 5): величина И шесть категорий в
        // ОДНОМ экране. Проверяется не на глаз, а геометрией: нижняя кромка
        // шестой строки категории обязана лежать внутри окна. Целевое
        // разрешение 1366x768 — самое тесное из трёх.
        "величина и 6 категорий в одном экране":
          "(() => { const rows = [...document.querySelectorAll('.rh-category')]; if (rows.length < 6) return 0; return rows[5].getBoundingClientRect().bottom <= window.innerHeight ? 1 : 0; })()",
        // нижний ярус блока-полосы: строка итога и следующий шаг (У26)
        "строка итога и «Что делать»":
          "(document.body.innerText.includes('Сильнее всего') && document.body.innerText.includes('Что делать')) ? 1 : 0",
      },
    },
  ];

  for (const viewport of VIEWPORTS) {
    // Метрики задаются CDP, а не размером окна: --window-size у headless
    // включает хром браузера, и фактический viewport оказывался уже
    // заявленного — то есть «проверено на 1366» было бы неправдой.
    await call("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const page of pages) await shoot(page.name, page.url, page.checks, viewport, page.wideOnly);
  }
  await call("Emulation.clearDeviceMetricsOverride");

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

async function shoot(
  name: string,
  url: string,
  checks: Record<string, string>,
  viewport: { width: number; height: number },
  wideOnly: Record<string, string> = {},
): Promise<void> {
  currentPage = `${name}@${viewport.width}`;
  loaded.fired = false;
  await call("Page.navigate", { url });
  await waitFor(async () => loaded.fired, `${currentPage}: страница не загрузилась`, 240, 250);
  const first = Object.values(checks)[0]!;
  await waitFor(async () => (await evaluate<number>(first)) > 0, `${currentPage}: ключевой узел не появился`);

  // Проверки ЖДУТ, а не снимают одно мгновение: карточка рисуется по своему
  // ответу, а тексты про порог ждут /api/meta, который на живой базе в 27 тысяч
  // репозиториев отвечает заметно позже. Без ожидания харнесс ругался на гонку
  // загрузки, а не на вёрстку.
  const results: string[] = [];
  const applicable = viewport.width >= WIDE_MIN ? { ...checks, ...wideOnly } : checks;
  for (const [label, expression] of Object.entries(applicable)) {
    let value = await evaluate<number>(expression);
    for (let i = 0; value === 0 && i < 40; i++) {
      await delay(250);
      value = await evaluate<number>(expression);
    }
    results.push(`${label}=${value}`);
    if (value === 0) problems.push({ page: currentPage, kind: "node", text: `узел не найден: ${label}` });
  }
  // Приёмочный факт, видимый только на конкретной ширине: окно никогда
  // не прокручивается горизонтально (решение 17.09) — перелив означает обрезанные данные.
  const overflow = await evaluate<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  results.push(`перелив по горизонтали=${overflow}px`);
  if (overflow > 0) problems.push({ page: currentPage, kind: "layout", text: `страница шире окна на ${overflow}px` });

  // основной файл — РОВНО видимая область: на него смотрит приёмка «в одном экране»
  const viewShot = await call<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const file = join(SHOTS_DIR, `${name}@${viewport.width}.png`);
  writeFileSync(file, Buffer.from(viewShot.data, "base64"));

  // постраничный — вторым файлом, чтобы содержимое можно было прочесть целиком
  const fullShot = await call<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const fullFile = join(SHOTS_DIR, `${name}@${viewport.width}-full.png`);
  writeFileSync(fullFile, Buffer.from(fullShot.data, "base64"));

  console.log(`${currentPage}: ${url}`);
  console.log(`  ${results.join(", ")}`);
  console.log(`  скриншот: ${file} (+ ${fullFile})`);
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
