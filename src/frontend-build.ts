// Сборка интерфейса для запуска под путем (BASE_PATH) и для демо (DEMO_MODE).
//
// HTML-импорт Bun (`import index from "./web/index.html"`) отдает бандл с
// абсолютными адресами `/chunk-*.js`: под общим доменом (`exsec.dev/healthcraft`)
// браузер искал бы их в корне чужого сайта. Здесь тот же index.html собирается
// Bun.build с publicPath = BASE_PATH, а в <head> добавляются метки, по которым
// интерфейс узнает путь и режим демо (src/web/base.ts). Сборка – один раз на
// старте процесса, в памяти.
import { resolve } from "node:path";

export interface BuiltFrontend {
  html: string;
  /** адрес файла относительно BASE_PATH (`/chunk-abc.js`) → тело и тип */
  assets: Map<string, { body: ArrayBuffer; type: string }>;
}

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function buildFrontend(basePath: string, demo: boolean): Promise<BuiltFrontend> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "web/index.html")],
    publicPath: `${basePath}/`,
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    throw new Error(`сборка интерфейса не удалась: ${result.logs.map((l) => String(l.message ?? l)).join("; ").slice(0, 500)}`);
  }
  let html: string | null = null;
  const assets = new Map<string, { body: ArrayBuffer; type: string }>();
  for (const out of result.outputs) {
    const name = out.path.replace(/\\/g, "/").replace(/^\.?\//, "").split("/").pop()!;
    if (name.endsWith(".html")) html = await out.text();
    else assets.set(`/${name}`, { body: await out.arrayBuffer(), type: out.type });
  }
  if (html === null) throw new Error("сборка интерфейса не дала index.html");
  const marks = `<meta name="hc-base" content="${escapeAttr(basePath)}">` + (demo ? `<meta name="hc-demo" content="1">` : "");
  return { html: html.replace(/<head>/i, `<head>${marks}`), assets };
}

/** Таблица маршрутов под путем: `/api/meta` → `/healthcraft/api/meta`; сам путь без «/» ведет на путь со «/». */
export function underBasePath(table: Record<string, unknown>, basePath: string): Record<string, unknown> {
  if (basePath === "") return table;
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(table)) out[`${basePath}${path}`] = value;
  out[basePath] = () => new Response(null, { status: 308, headers: { location: `${basePath}/` } });
  return out;
}
