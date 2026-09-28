// Скриншоты интерфейса для документации (docs/guide/images) на демо-базе с
// выдуманными репозиториями (scripts/docs-demo-db.ts). Поднимает сервер на
// демо-базе, водит headless Chrome по сырому CDP (как scripts/shot.ts),
// светлая тема, окно 1440 px, deviceScaleFactor 2, и режет фрагменты по
// bounding box элементов. Сервер и Chrome останавливаются в конце.
//
// Запуск:
//   bun scripts/docs-demo-db.ts <каталог>
//   bun scripts/docs-shots.ts <каталог> [каталог-для-png]
// По умолчанию PNG кладутся в docs/guide/images/. Переменные:
//   DOCS_SHOTS_PORT (8533), DOCS_SHOTS_CDP_PORT (9533), DOCS_SHOTS_SCALE (2),
//   DOCS_SHOTS_DEBUG=1 — дополнительно снимки страниц целиком (*-page.png).
// Изоляция сервера — как у shot.ts: роль web (без планировщика и пересчета),
// пустой токен, все внешние базы на закрытом порту loopback, ключи LLM —
// заглушки.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = process.argv[2];
if (!dataDir || !existsSync(join(dataDir, "repo-health.db"))) {
  console.error("usage: bun scripts/docs-shots.ts <каталог демо-базы> [каталог-для-png]");
  console.error("демо-базу создает: bun scripts/docs-demo-db.ts <каталог>");
  process.exit(2);
}
if (resolve(dataDir) === resolve("data")) {
  console.error("отказ: живой каталог data/ — снимки документации делаются только на демо-базе");
  process.exit(2);
}
const OUT = process.argv[3] ?? join("docs", "guide", "images");
const PORT = Number(process.env.DOCS_SHOTS_PORT ?? 8533);
const CDP_PORT = Number(process.env.DOCS_SHOTS_CDP_PORT ?? 9533);
const SCALE = Number(process.env.DOCS_SHOTS_SCALE ?? 2);
const DEBUG = process.env.DOCS_SHOTS_DEBUG === "1";
const WIDTH = 1440;
const HEIGHT = 900;
const BASE = `http://127.0.0.1:${PORT}`;
/** поля вокруг вырезанного элемента, CSS px */
const PAD = 16;
/**
 * Высота окна для карточки и сравнения: основная колонка прокручивается внутри
 * своего контейнера, и снимок за пределами окна ее не дорисовывает — окно
 * делается выше всей ленты. Рейтингу — обычная высота (таблица заполняет окно).
 */
const TALL = 3200;
type Pad = number | { t?: number; r?: number; b?: number; l?: number };

let server: ChildProcess | null = null;
let browser: ChildProcess | null = null;
let ws: WebSocket | null = null;
let profile: string | null = null;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const errors: string[] = [];
let nextId = 1;
let loaded = false;

try {
  await run();
} catch (error) {
  console.error(`docs-shots: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function run(): Promise<void> {
  const chrome = chromePath();
  if (!chrome) throw new Error("Chrome не найден. Укажите CHROME_PATH.");
  if (await healthy()) throw new Error(`порт ${PORT} занят: остановите прежний сервер`);

  server = spawn(process.execPath, ["run", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: resolve(dataDir!),
      NODE_ENV: "production",
      SCHEDULER_START_DELAY_MS: "86400000",
      PROCESS_ROLE: "web",
      SOURCECRAFT_TOKEN: "",
      SOURCECRAFT_API_BASE: "http://127.0.0.1:1",
      APPSEC_API_BASE: "http://127.0.0.1:1",
      SOURCECRAFT_GIT_BASE: "http://127.0.0.1:1",
      YA_OAUTH_BASE: "http://127.0.0.1:1",
      YA_LOGIN_BASE: "http://127.0.0.1:1",
      YAGPT_API_KEY: "stub-not-a-key",
      YAGPT_FOLDER_ID: "stub-not-a-folder",
      ZAI_API_KEY: "stub-not-a-key",
    },
    stdio: "ignore",
  });
  await waitFor(healthy, "сервер не поднялся (/api/health)");
  await waitFor(async () => (await fetch(`${BASE}/`)).ok, "страница «/» не собралась", 240, 500);

  profile = mkdtempSync(join(tmpdir(), "rh-docs-shots-"));
  browser = spawn(
    chrome,
    ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
  );
  let target: { webSocketDebuggerUrl: string } | undefined;
  await waitFor(async () => {
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[];
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) as typeof target;
    return target !== undefined;
  }, "Chrome не отдал DevTools-эндпоинт");
  ws = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise<void>((ok, fail) => {
    ws!.addEventListener("open", () => ok(), { once: true });
    ws!.addEventListener("error", () => fail(new Error("CDP: соединение не открылось")), { once: true });
  });
  ws.addEventListener("message", onMessage);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  // светлая тема — до загрузки приложения (prefs.ts, `rh:theme`)
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("rh:theme", "light"); } catch (e) {}` });
  mkdirSync(OUT, { recursive: true });

  // 1. Рейтинг: заголовок, фильтры и первые 10 строк таблицы
  await goto(`${BASE}/?sort=index&order=desc`, "document.querySelectorAll('table tbody tr').length >= 10", HEIGHT);
  await shot("rating", `(() => {
    const head = document.querySelector('.rh-fill__header').getBoundingClientRect();
    const rows = document.querySelectorAll('table tbody tr');
    const last = rows[9].getBoundingClientRect();
    return { x: head.left, y: head.top, width: head.width, height: last.bottom - head.top };
  })()`, { b: 1 });

  // 2-3. Карточка example/tasktracker
  const card = `${BASE}/repo/example/tasktracker`;
  await goto(card, "document.querySelector('.rh-score-band') && document.body.innerText.includes('похожих')");
  // первый экран: шапка, оценка, зона, лига, место и похожие, вклад категорий
  await shot("card-hero", `(() => {
    const head = document.querySelector('.rh-card-head').getBoundingClientRect();
    const cards = document.querySelector('.rh-score-cards').getBoundingClientRect();
    return { x: head.left, y: head.top, width: head.width, height: cards.bottom - head.top };
  })()`);
  // шире, чем card-hero: строка действий (Сравнить, Бейдж, Отчет), шапка и плашки
  // показателей вместе с правой панелью; низ — по концу блока панели, который
  // пересекает низ плашек, чтобы панель не резалась посередине
  // блок под плашками (AI-обзор) попал бы в кадр узкой полосой: на время снимка
  // он скрыт, место остается пустым
  await evaluate("(() => { const s = document.querySelector('.rh-ai-section'); if (s) s.style.visibility = 'hidden'; return 1; })()");
  await shot("card-header", `(() => {
    const main = document.querySelector('.rh-page__main').getBoundingClientRect();
    const cards = document.querySelector('.rh-score-cards').getBoundingClientRect();
    const aside = document.querySelector('.rh-page__aside');
    let bottom = cards.bottom;
    if (aside) {
      for (const el of aside.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < cards.bottom && r.bottom > bottom && r.height < 400) bottom = r.bottom;
      }
    }
    const nav = document.querySelector('[class*="gn-aside-header__aside___"]');
    const x = Math.max(nav ? nav.getBoundingClientRect().right + 1 : 0, main.left - ${PAD});
    return { x, y: 0, width: window.innerWidth - x, height: bottom + 12 };
  })()`, 0);
  await evaluate("(() => { const s = document.querySelector('.rh-ai-section'); if (s) s.style.visibility = ''; return 1; })()");

  // 4. Раскрытая категория «Документация» с подметриками
  await clickCategory("Документация");
  await shot("card-category", `(() => {
    const btn = [...document.querySelectorAll('.rh-category')].find((b) => b.textContent.includes('Документация'));
    const li = btn.closest('li').getBoundingClientRect();
    return { x: li.left, y: li.top, width: li.width, height: li.height };
  })()`, { t: 8, b: 4 });

  // 6. Рекомендации в режиме «По шагам»
  await goto(card, "document.getElementById('recommendations') && document.body.innerText.includes('По шагам')");
  await evaluate(`(() => { const o = [...document.querySelectorAll('.g-segmented-radio-group__option')].find((n) => n.textContent.trim() === 'По шагам'); o.querySelector('input')?.click(); o.click(); return 1; })()`);
  await waitFor(async () => (await evaluate<number>("document.body.innerText.includes('После шага') ? 1 : 0")) === 1, "режим «По шагам» не включился");
  await delay(400);
  await shot("recommendations-steps", `(() => {
    const r = document.getElementById('recommendations').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);

  // 5. «Нет данных» у категории: example/image-resizer, строки кода не прочитаны
  await goto(`${BASE}/repo/example/image-resizer`, "document.querySelectorAll('.rh-category').length >= 4");
  await shot("no-data", `(() => {
    const btn = [...document.querySelectorAll('.rh-category')].find((b) => b.textContent.includes('Нет данных'));
    const li = btn.closest('li').getBoundingClientRect();
    return { x: li.left, y: li.top, width: li.width, height: li.height };
  })()`, { t: 8, b: 8 });

  // 7. Сравнение 3 репозиториев с раскрытой категорией
  await goto(
    `${BASE}/compare?r=example/tasktracker&r=example/weather-bot&r=my-team/backend`,
    "document.querySelectorAll('.rh-cmp-head:not(.rh-cmp-head_corner)').length === 3",
  );
  await evaluate(`(() => { const b = [...document.querySelectorAll('.rh-cmp-toggle')].find((n) => n.textContent.includes('Документация')); b.click(); return 1; })()`);
  await delay(600);
  await shot("compare", `(() => {
    const page = document.querySelector('.rh-cmp-page').getBoundingClientRect();
    const cmp = document.querySelector('.rh-cmp').getBoundingClientRect();
    return { x: page.left, y: page.top, width: page.width, height: cmp.bottom - page.top };
  })()`);

  if (errors.length > 0) {
    for (const e of errors) console.error(`  ${e}`);
    throw new Error("ошибки на странице");
  }
  console.log("docs-shots: готово");
}

async function clickCategory(name: string): Promise<void> {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.rh-category')].find((n) => n.textContent.includes(${JSON.stringify(name)})); b.click(); return 1; })()`);
  await waitFor(
    async () => (await evaluate<number>(`(() => { const b = [...document.querySelectorAll('.rh-category')].find((n) => n.textContent.includes(${JSON.stringify(name)})); return b.closest('li').innerText.includes('Вес') ? 1 : 0; })()`)) === 1,
    `категория ${name} не раскрылась`,
  );
  await delay(500);
}

async function goto(url: string, ready: string, height = TALL): Promise<void> {
  await call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: false });
  loaded = false;
  await call("Page.navigate", { url });
  await waitFor(async () => loaded, `${url}: страница не загрузилась`, 240, 250);
  await waitFor(async () => Boolean(await evaluate(ready)), `${url}: не дождались ${ready}`, 120, 250);
  // шрифты и анимации полос
  await evaluate("document.fonts.ready.then(() => 1)");
  await delay(900);
  if (DEBUG) {
    const name = url.replace(BASE, "").replace(/[^\w]+/g, "_").slice(0, 60) || "root";
    const full = await call<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(OUT, `${name}-page.png`), Buffer.from(full.data, "base64"));
  }
}

/** Снимок области: `clipExpr` возвращает прямоугольник во viewport-координатах. */
async function shot(name: string, clipExpr: string, pad: Pad = PAD): Promise<void> {
  const p = typeof pad === "number" ? { t: pad, r: pad, b: pad, l: pad } : { t: pad.t ?? PAD, r: pad.r ?? PAD, b: pad.b ?? PAD, l: pad.l ?? PAD };
  const r = await evaluate<{ x: number; y: number; width: number; height: number }>(clipExpr);
  const sx = await evaluate<number>("window.scrollX");
  const sy = await evaluate<number>("window.scrollY");
  const x = Math.max(0, Math.floor(r.x + sx - p.l));
  const y = Math.max(0, Math.floor(r.y + sy - p.t));
  const clip = { x, y, width: Math.ceil(r.width + p.l + p.r), height: Math.ceil(r.height + p.t + p.b), scale: 1 };
  const res = await call<{ data: string }>("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
  const file = join(OUT, `${name}.png`);
  const buf = Buffer.from(res.data, "base64");
  writeFileSync(file, buf);
  console.log(`${file}: ${clip.width}x${clip.height} CSS px, ${Math.round(buf.length / 1024)} КБ`);
}

function onMessage(event: MessageEvent): void {
  const msg = JSON.parse(String(event.data));
  if (msg.id) {
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message));
    else w.resolve(msg.result);
    return;
  }
  if (msg.method === "Page.loadEventFired") loaded = true;
  if (msg.method === "Runtime.exceptionThrown") errors.push(`exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(`console.error: ${JSON.stringify(msg.params.args?.map((a: any) => a.value ?? a.description)).slice(0, 300)}`);
}

function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP закрыт перед ${method}`));
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<T>((ok, fail) => pending.set(id, { resolve: ok, reject: fail }));
}

async function evaluate<T>(expression: string): Promise<T> {
  const res = await call<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(`evaluate: ${res.exceptionDetails.exception?.description ?? expression.slice(0, 80)}`);
  return res.result.value;
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function cleanup(): Promise<void> {
  if (ws) {
    ws.removeEventListener("message", onMessage);
    ws.close();
    ws = null;
  }
  for (const child of [browser, server]) {
    if (!child || child.exitCode !== null) continue;
    child.kill();
    for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(50);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (profile) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await delay(300);
      }
    }
  }
}

async function waitFor(check: () => Promise<boolean>, message: string, attempts = 80, delayMs = 250): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await check()) return;
    } catch {
      // сервер или страница еще не готовы
    }
    await delay(delayMs);
  }
  throw new Error(message);
}

function chromePath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : undefined,
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((p): p is string => typeof p === "string" && p !== "");
  return candidates.find((p) => existsSync(p)) ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
