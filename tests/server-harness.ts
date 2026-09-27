// Герметичный запуск настоящего сервера в тестах: временный DATA_DIR,
// SOURCECRAFT_TOKEN="", все адреса внешних API (REST, AppSec, git-хост) — на
// локальный Bun.serve-мок со счетчиком запросов, YA_REDIRECT_URI задан явно.
// Тестовый сервер без этих env запрещён: иначе зритель с PAT или юзерская заявка
// ушли бы на живые сервисы. Не *.test.ts — bun test не подхватывает.
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb, setMetaValue } from "../src/db";
import { DERIVED_VERSION, RESCORE_CURSOR } from "../src/score/rescore";

const ROOT = join(import.meta.dir, "..");

export interface MockRequest {
  method: string;
  path: string;
  /** есть ли заголовок Authorization (значение не сохраняется) */
  auth: boolean;
}

export type MockRoute = (req: Request, url: URL) => Response | Promise<Response> | null;

export interface MockApi {
  url: string;
  requests: MockRequest[];
  /** подменить обработчик (null от обработчика → 404 JSON) */
  setRoute(route: MockRoute): void;
  stop(): void;
}

/** Локальный мок REST/AppSec/git: считает каждый запрос. */
export function startMockApi(route: MockRoute = () => null): MockApi {
  let current = route;
  const requests: MockRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: `${url.pathname}${url.search}`, auth: req.headers.has("authorization") });
      const res = await current(req, url);
      return res ?? Response.json({ error: "mock: not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setRoute: (r) => {
      current = r;
    },
    stop: () => server.stop(true),
  };
}

export interface SpawnedServer {
  base: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Актуальные meta сид-БД: без derived_version сервер при старте
 * пересчитал бы сид-оценки моделью и затёр фикстуру; без водяного знака
 * рескора (needsRescore «курсор не догнал») фоновый проход сделал бы то же
 * самое уже асинхронно.
 */
export function seedCurrentMeta(dataDir: string): void {
  const db = openDb({ ...loadConfig(), dataDir });
  setMetaValue(db, "derived_version", String(DERIVED_VERSION));
  const maxId = (db.query("SELECT COALESCE(MAX(id), 0) AS m FROM scans").get() as { m: number }).m;
  setMetaValue(db, RESCORE_CURSOR, String(maxId));
  db.close();
}

/** Сервер во временном каталоге; мок обязателен (адреса API без него не задать). */
export async function spawnServer(opts: {
  dataDir: string;
  mock: MockApi;
  appSecret?: string;
  env?: Record<string, string>;
  /** false — не сеять meta (тест пересчёта при старте) */
  seedMeta?: boolean;
}): Promise<SpawnedServer> {
  if (opts.seedMeta !== false) seedCurrentMeta(opts.dataDir);
  // ОС выбирает свободный порт; случайный номер давал редкие коллизии между
  // параллельными test-worker процессами на Windows.
  const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 503 }) });
  const port = portProbe.port;
  portProbe.stop(true);
  if (port === undefined) throw new Error("OS did not allocate a port for the test server");
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, "run", join(ROOT, "src/server.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: opts.dataDir,
      APP_SECRET: opts.appSecret ?? "",
      SOURCECRAFT_TOKEN: "", // без серверного токена: ни каталога, ни периодики
      SOURCECRAFT_API_BASE: opts.mock.url,
      APPSEC_API_BASE: opts.mock.url,
      SOURCECRAFT_GIT_BASE: opts.mock.url,
      YA_CLIENT_ID: "",
      YA_CLIENT_SECRET: "",
      YA_REDIRECT_URI: `${base}/auth/ya/callback`,
      // адреса Я ID — на тот же мок; без них маршруты /auth/* ушли бы
      // на боевой oauth.yandex.ru
      YA_OAUTH_BASE: opts.mock.url,
      YA_LOGIN_BASE: opts.mock.url,
      SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
      ...(opts.env ?? {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = new Response(proc.stderr).text();
  let ready = false;
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  if (!ready) {
    if (proc.exitCode === null) proc.kill();
    const code = await proc.exited;
    const detail = (await stderrText.catch(() => "")).trim().slice(-1000);
    throw new Error(`test server did not become ready (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
  return {
    base,
    port,
    stop: async () => {
      proc.kill();
      await proc.exited;
      await stderrText.catch(() => "");
    },
  };
}
