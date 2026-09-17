// server-harness.ts — герметичный запуск настоящего сервера в тестах
// (В4.1-fix, Ф1.13): временный DATA_DIR, SOURCECRAFT_TOKEN="", все адреса
// внешних API (REST, AppSec, git-хост) — на локальный Bun.serve-мок со
// счётчиком запросов, YA_REDIRECT_URI задан явно. Тестовый сервер без этих
// env запрещён: иначе зритель с PAT или юзерская заявка ушли бы на живые
// сервисы. Не *.test.ts — bun test не подхватывает.
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb, setMetaValue } from "../src/db";
import { DERIVED_VERSION } from "../src/score/rescore";

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
 * Актуальные meta сид-БД (Ф1.9): без derived_version сервер при старте
 * пересчитал бы сид-оценки моделью и затёр фикстуру.
 */
export function seedCurrentMeta(dataDir: string): void {
  const db = openDb({ ...loadConfig(), dataDir });
  setMetaValue(db, "derived_version", String(DERIVED_VERSION));
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
  const port = 41000 + Math.floor(Math.random() * 18000);
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
      SCHEDULER_START_DELAY_MS: String(24 * 3600_000),
      ...(opts.env ?? {}),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  return {
    base,
    port,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}
