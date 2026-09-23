// shot.ts — харнесс скриншотов на сыром CDP, ноль новых зависимостей.
// Поднимает локальный сервер в development или production, водит headless
// Chrome по четырём страницам в ТРЁХ РАЗРЕШЕНИЯХ, ловит ошибки консоли и внешние
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
// 4 страницы x 3 ширины x 2 режима = 24 приёмочных файла.
//
// Запуск:
//   SHOT_MODE=production bun scripts/shot.ts [org/repo]
//   SHOT_MODE=development bun scripts/shot.ts [org/repo]
//
// В4.9 ч.2, круг 1 (расширение харнесса, приемка 6 промпта):
//   SHOT_SLUGS=org/a,org/b   — несколько карточек (первая — по-старому `repo`,
//                               остальные — `repo-<org>-<repo>`);
//   SHOT_WIDTHS=1366,1440,375 — ширины (375 — телефон: mobile-эмуляция);
//   SHOT_THEMES=light,dark    — тема через localStorage["rh:theme"] до загрузки;
//   SHOT_OUT=<каталог>        — куда класть PNG (по умолчанию reports/shots/<mode>).
// Имена: <page>@<width>[-<theme>].png (+ `-full`, ниже 1440 и `-drawer`).
// Сервер стенда поднимается СТРОГО изолированным (урок ERROR_LOG 21.09): роль
// web, токен-заглушка, все внешние базы — на 127.0.0.1:1, ключи LLM —
// непустые заглушки.
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
const SLUGS = (process.env.SHOT_SLUGS ?? SLUG).split(",").map((s) => s.trim()).filter(Boolean);
const THEMES = (process.env.SHOT_THEMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SERVER_PORT = Number(process.env.SHOT_PORT ?? 8519);
const CDP_PORT = Number(process.env.SHOT_CDP_PORT ?? 9519);
const MODE = parseMode(process.env.SHOT_MODE);
const SHOTS_DIR = process.env.SHOT_OUT ?? join("reports", "shots", MODE);
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

const DEFAULT_VIEWPORTS: { width: number; height: number }[] = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 1200 },
  { width: 1366, height: 768 },
];
/** Высоты окон по ширине; 375 — телефон (В4.9 ч.2, приемка 6). */
const HEIGHTS: Record<number, number> = { 1920: 1080, 1440: 1200, 1366: 768, 375: 812 };
const VIEWPORTS: { width: number; height: number }[] = process.env.SHOT_WIDTHS
  ? process.env.SHOT_WIDTHS.split(",").map((w) => Number(w.trim())).filter((w) => w > 0).map((width) => ({ width, height: HEIGHTS[width] ?? 900 }))
  : DEFAULT_VIEWPORTS;
const PHONE_MAX = 767;

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
      // В4.9 ч.2 (приемка 6): стенд изолирован от живых поверхностей — роль web
      // (без планировщика и рейтинговых заданий), токен-заглушка, внешние базы
      // на закрытый порт loopback, ключи LLM — непустые заглушки (пустая
      // переменная `.env` не маскирует, ERROR_LOG 21.09).
      PROCESS_ROLE: "web",
      SOURCECRAFT_TOKEN: "stub-not-a-token",
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

  const pages: { name: string; url: string; checks: Record<string, string>; wideOnly?: Record<string, string>; drawer?: boolean; wideMin?: number }[] = [
    {
      name: "rating",
      url: `${base}/?sort=index&order=desc`,
      checks: {
        // В4.9 ч.2: на телефоне (375) рейтинг — список строк, а не таблица
        "строк таблицы": "document.querySelectorAll('table tbody tr').length || document.querySelectorAll('.rh-page__main .rh-list__item').length",
        // В4.6 круг 2 (Р5): заголовок — «Рейтинг здоровья ОТКРЫТЫХ репозиториев»
        "заголовок рейтинга": "document.body.innerText.includes('Рейтинг здоровья открытых репозиториев') ? 1 : 0",
        "колонка HealthCraft Index": "document.body.innerText.includes('HealthCraft Index') ? 1 : 0",
        // В4.6 круг 2 (Р21): селект не режет собственное значение. Проверяется
        // геометрией, а не на глаз: текст выбранной опции обязан укладываться в
        // свою рамку (scrollWidth <= clientWidth).
        //
        // Сверка документов 21.09: исходный дефект Р21 жил у контрола
        // «Сортировка: …», а круг 3 (П4/6) убрал его вовсе — сортировка уехала
        // в заголовки колонок. Проверка при этом продолжала рапортовать
        // зелёным, потому что `.pop()` брал ПОСЛЕДНИЙ подходящий узел, то есть
        // уже другой селект. Инвариант оставлен (тот же дефект достанет язык и
        // размер страницы), но назван честно и считает ВСЕ селекты: узлов нет
        // или хоть один режет значение — красный.
        //
        // В4.7 (П2): у фильтра языка больше нет опции «все» — без выбора поле
        // показывает ПЛЕЙСХОЛДЕР («все»), а не выбранную опцию, и узла
        // option-text на странице нет вовсе. Инвариант тот же, узлов два вида:
        // текст выбранного и плейсхолдер одинаково не должны резаться.
        "селекты не режут значение":
          "(() => { const ns = [...document.querySelectorAll('[class*=\"select-control__option-text\"], [class*=\"select-control__placeholder\"]')]; if (!ns.length) return 0; return ns.every((n) => n.scrollWidth <= n.clientWidth + 1) ? 1 : 0; })()",
      },
      // В4.6 (У22/У23): ниже 1440 правая панель рейтинга уезжает в закрытый Drawer,
      // и легенды в DOM нет ПО ЗАМЫСЛУ — требовать её там значило бы ловить
      // собственное решение о пороге как дефект.
      wideOnly: {
        "легенда шкалы": "document.body.innerText.includes('Шкала оценки') ? 1 : 0",
      },
      drawer: true,
      // круг 2 части 2 (Н1): панель рейтинга стоит колонкой только с 1600
      // (`asideColumnFrom`), ниже — в Drawer; на 1440 легенды в DOM нет по замыслу
      wideMin: 1600,
    },
    {
      // «Мои репозитории» без сессии — витрина входа через Я ID.
      name: "me",
      url: `${base}/me`,
      checks: {
        "заголовок моих репозиториев": "document.body.innerText.includes('Мои репозитории') ? 1 : 0",
        "кнопка входа Я ID": `[...document.querySelectorAll('a,button')].filter((n) => n.textContent?.includes("Войти через Я ID")).length`,
      },
    },
    {
      name: "settings",
      url: `${base}/settings`,
      checks: {
        "заголовок настроек": "document.body.innerText.includes('Настройки') ? 1 : 0",
        // В4.9: текст экрана сменился в 63b73ab («персональный токен доступа», термины
        // SourceCraft), проверка харнесса отставала — ложная ошибка консоли
        "объяснение входа для настроек": "document.body.innerText.includes('настроить персональный токен доступа SourceCraft') ? 1 : 0",
      },
    },
    // В4.9 ч.2 (приемка 6): карточек несколько — первая по-старому `repo`
    ...SLUGS.map((slug, i) => {
      const [org, repo] = slug.split("/") as [string, string];
      const scored = "document.querySelector('.rh-score-band')";
      return {
        name: i === 0 ? "repo" : `repo-${org}-${repo}`.replace(/[^\w.-]+/g, "_").slice(0, 80),
        url: `${base}/repo/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
        checks: {
          // первый узел — готовность карточки (шапка), дальше — по наличию оценки
          "шапка карточки": "document.querySelectorAll('.rh-repo-head').length",
          "блок Score или пустое состояние": `(${scored} && document.body.innerText.includes('из 100')) || document.body.innerText.includes('Оценки пока нет') || document.body.innerText.includes('еще не сканировался') ? 1 : 0`,
          // В4.9 ч.2 (А1): табов нет — ни TabList, ни переключателя в главной колонке
          "табов нет (А1)": "document.querySelectorAll('.rh-page__main [role=tablist]').length === 0 ? 1 : 0",
          // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А1): прежняя проверка «величина и
          // открытые категории в одном экране» (вариант А В4.6) снята — лента по
          // решению владельца 23.09 ставит под числа полосу вклада и основание у
          // каждой категории. Вместо нее — порядок ленты по линии PDF.
          "лента: показатели, категории, рекомендации, ограничения":
            `(() => { if (!${scored}) return 1; const band = ${scored}.getBoundingClientRect(); const cat = document.querySelector('.rh-category'); const rec = document.getElementById('recommendations'); if (!cat || !rec) return 0; const lim = document.getElementById('rh-limitations-title'); const ok = band.bottom <= cat.getBoundingClientRect().top && cat.getBoundingClientRect().top < rec.getBoundingClientRect().top && (!lim || rec.getBoundingClientRect().top < lim.getBoundingClientRect().top); return ok ? 1 : 0; })()`,
          // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А3): полоса вклада — под числами
          // (было `.rh-contrib-band` в правой панели)
          "вклад категорий под числами (А3)": `(() => { if (!${scored}) return 1; return document.querySelectorAll('.rh-score-band .rh-contrib_card').length > 0 ? 1 : 0; })()`,
          // В4.9 ч.2 (А9, крайний случай): кнопки строки действий видны целиком —
          // длинный слаг в крошках выталкивал «Отчет» за край окна
          "кнопки действий в окне":
            "(() => { const bs = [...document.querySelectorAll('.rh-actionbar button')]; return bs.every((b) => b.getBoundingClientRect().right <= window.innerWidth + 1) ? 1 : 0; })()",
          // В4.9 ч.2 (А4): плашка уровня не растянута — уже своего трека (150px)
          "плашки уровня не растянуты (А4)":
            "(() => { const w = [...document.querySelectorAll('.rh-category__word')].filter((n) => n.getBoundingClientRect().width > 0); return w.every((n) => n.getBoundingClientRect().width < 149) ? 1 : 0; })()",
          // Круг 2 (Р14) → В4.9 ч.2 (А4): закрытые категории — плашкой ПОД списком
          // (ПЕРЕВЕРНУТО С ЗАМЕНОЙ: плашки может не быть — у полного доступа)
          "плашка закрытых категорий под списком":
            "(() => { const note = document.querySelector('.rh-locked-note'); const rows = [...document.querySelectorAll('.rh-category')]; if (!note) return 1; if (rows.length === 0) return 0; return note.getBoundingClientRect().top >= rows[rows.length - 1].getBoundingClientRect().top ? 1 : 0; })()",
          // В4.6 круг 3 (П1.10): под 2 показателями нет текста и CTA.
          "нижний текст и ссылка показателей сняты":
            `(() => { const band = ${scored}; if (!band) return 1; if (band.querySelector('.rh-score-band__summary')) return 0; return [...band.querySelectorAll('a')].every((a) => !/^Рекомендаций:/.test(a.textContent?.trim() ?? '')) ? 1 : 0; })()`,
        },
        // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А8/А9): фраза tri-state живет в «Что
        // учитывается» правой панели; ниже 1440 панель в Drawer, в DOM ее нет по
        // замыслу. Проверка «объяснение закрытых каналов» («учитываются только в
        // Repo Health Score») снята: абзаца нет, закрытые каналы объясняет плашка.
        wideOnly: {
          "tri-state NULL": `(() => { if (!${scored}) return 1; return document.body.textContent?.includes('Отсутствующие данные не учитываются как нулевые') ? 1 : 0; })()`,
          "паспорт анализа": "document.querySelector('.rh-page__aside')?.textContent?.includes('Анализ') ? 1 : 0",
        },
        drawer: true,
      };
    }),
  ];

  const themes: (string | null)[] = THEMES.length > 0 ? THEMES : [null];
  let themeScript: string | null = null;
  for (const theme of themes) {
    // В4.9 ч.2: тема — через localStorage до загрузки приложения (prefs.ts, `rh:theme`)
    if (themeScript) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: themeScript });
    themeScript = null;
    if (theme) {
      const added = await call<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: `try { localStorage.setItem("rh:theme", ${JSON.stringify(theme)}); } catch (e) {}`,
      });
      themeScript = added.identifier;
    }
    for (const viewport of VIEWPORTS) {
      // Метрики задаются CDP, а не размером окна: --window-size у headless
      // включает хром браузера, и фактический viewport оказывался уже
      // заявленного — то есть «проверено на 1366» было бы неправдой.
      await call("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= PHONE_MAX,
      });
      for (const page of pages) await shoot(page.name, page.url, page.checks, viewport, page.wideOnly, theme, page.drawer === true, page.wideMin ?? WIDE_MIN);
    }
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
  theme: string | null = null,
  drawer = false,
  wideMin = WIDE_MIN,
): Promise<void> {
  const suffix = theme ? `-${theme}` : "";
  currentPage = `${name}@${viewport.width}${suffix}`;
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
  const applicable = viewport.width >= wideMin ? { ...checks, ...wideOnly } : checks;
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
  const file = join(SHOTS_DIR, `${name}@${viewport.width}${suffix}.png`);
  writeFileSync(file, Buffer.from(viewShot.data, "base64"));

  // постраничный — вторым файлом, чтобы содержимое можно было прочесть целиком
  const fullShot = await call<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const fullFile = join(SHOTS_DIR, `${name}@${viewport.width}${suffix}-full.png`);
  writeFileSync(fullFile, Buffer.from(fullShot.data, "base64"));

  // В4.9 ч.2 (А9, Б2): ниже 1440 правая панель — в выезжающей панели по
  // кнопке «Как считается» (у рейтинга — и по ссылке в подзаголовке).
  // Проверяется действием: клик → панель в DOM → снимок → Escape.
  if (drawer && viewport.width < wideMin) {
    const openedBy = async (expression: string, label: string, shotName: string | null): Promise<void> => {
      const clicked = await evaluate<number>(expression);
      let inDom = 0;
      for (let i = 0; clicked && i < 40 && !inDom; i++) {
        await delay(150);
        inDom = await evaluate<number>("document.querySelectorAll('.rh-drawer').length");
      }
      results.push(`${label}=${inDom}`);
      if (!inDom) problems.push({ page: currentPage, kind: "node", text: `Drawer не открылся: ${label}` });
      else if (shotName) {
        await delay(450);
        const drawerShot = await call<{ data: string }>("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(SHOTS_DIR, shotName), Buffer.from(drawerShot.data, "base64"));
      }
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      for (let i = 0; i < 20 && (await evaluate<number>("document.querySelectorAll('.rh-drawer').length")) > 0; i++) await delay(100);
    };
    await openedBy(
      "(() => { const b = [...document.querySelectorAll('.rh-actionbar button')].find((n) => n.textContent?.trim() === 'Как считается'); if (!b) return 0; b.click(); return 1; })()",
      "Drawer по кнопке «Как считается»",
      `${name}@${viewport.width}${suffix}-drawer.png`,
    );
    if (name === "rating") {
      await openedBy(
        "(() => { const a = [...document.querySelectorAll('.rh-page__main a')].find((n) => n.textContent?.trim() === 'Как считается'); if (!a) return 0; a.click(); return 1; })()",
        "Drawer по ссылке «Как считается»",
        null,
      );
    }
  }

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
