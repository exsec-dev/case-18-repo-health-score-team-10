// Граф зависимостей из lock-файлов клона – факт `tree.lockgraph`. Нужен
// «Безопасности»: AppSec SCA называет уязвимый пакет и версию, но не говорит,
// прямая это зависимость или транзитивная и через какую прямую она пришла;
// REST AppSec графа не отдает (SBOM есть только в веб-интерфейсе). Граф здесь
// строится из того, что лежит в репозитории: `package-lock.json` /
// `npm-shrinkwrap.json` v2/v3 и `pnpm-lock.yaml` v6+. Остальные менеджеры и
// старые форматы – без графа (факта нет), их находки считаются как раньше.
//
// Форма компактная: узлы `name@version` в массиве, ребра и корни – индексами.
// Капы по размеру файла, длине имени, числу узлов и ребер: граф больше капа
// помечается truncated, сопоставление по нему неполное, и расчет считает
// несопоставленный пакет прямым (худший случай), а не пропускает его.
// Lock-файл – содержимое чужого репозитория: парсеры не бросают наружу, а
// возвращают null; `resolved`/`integrity`/адреса реестров не сохраняются.
import { parseYamlSubset } from "./yamlmini";

/** Кап размера lock-файла: больше не читается (гигантские монорепо). */
export const LOCK_FILE_CAP_BYTES = 4 * 1024 * 1024;
/** Кап узлов одного графа. */
export const LOCK_NODES_CAP = 6000;
/** Кап ребер одного графа. */
export const LOCK_EDGES_CAP = 40_000;
/** Кап длины узла `name@version`: у npm имя до 214 символов, версия короткая. */
export const LOCK_NODE_CAP_CHARS = 256;
/** Сколько lock-файлов читается на репозиторий (корень и пакеты монорепо). */
export const LOCK_FILES_CAP = 4;
/** Глубина пути lock-файла: корень и до 2 каталогов (как у манифестов deps.ts). */
export const LOCK_MAX_DEPTH = 2;
/** Самая старая поддерживаемая версия pnpm-lock: v5 (`/name/1.0.0`) не читается. */
export const PNPM_LOCK_MIN_VERSION = 6;

export type LockManager = "npm" | "pnpm";

/** Граф одного lock-файла. */
export interface LockGraph {
  /** путь lock-файла от корня клона */
  path: string;
  manager: LockManager;
  /** версия формата lock-файла, как в файле */
  lock_version: string | null;
  /** узлы `name@version`; индекс – id узла */
  nodes: string[];
  /** прямые зависимости корня и пакетов workspace (индексы узлов), включая dev-зависимости */
  roots: number[];
  /** ребра «пакет → его зависимость» (индексы узлов) */
  edges: [number, number][];
  /** узлов, ребер или имен больше капа – граф обрезан */
  truncated?: true;
}

export interface LockGraphFactValue {
  graphs: LockGraph[];
  /** lock-файлов больше капа – прочитаны не все */
  truncated?: true;
}

const LOCK_NAMES: readonly { re: RegExp; manager: LockManager }[] = [
  { re: /^package-lock\.json$/i, manager: "npm" },
  { re: /^npm-shrinkwrap\.json$/i, manager: "npm" },
  { re: /^pnpm-lock\.yaml$/i, manager: "pnpm" },
];

/** Lock-файл ли это по имени и глубине пути; `node_modules` и `vendor` не читаются. */
export function lockManagerOf(path: string): LockManager | null {
  const parts = path.split("/");
  if (parts.length - 1 > LOCK_MAX_DEPTH) return null;
  if (parts.some((p) => p === "node_modules" || p === "vendor" || p === ".git")) return null;
  const name = parts[parts.length - 1]!;
  return LOCK_NAMES.find((l) => l.re.test(name))?.manager ?? null;
}

/** Строитель графа с дедупликацией узлов и капами. */
class GraphBuilder {
  readonly nodes: string[] = [];
  readonly edges: [number, number][] = [];
  readonly roots = new Set<number>();
  private readonly ids = new Map<string, number>();
  private readonly edgeKeys = new Set<string>();
  truncated = false;

  node(name: string, version: string | null): number | null {
    const key = `${name}@${version ?? ""}`;
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    if (key.length > LOCK_NODE_CAP_CHARS || this.nodes.length >= LOCK_NODES_CAP) {
      this.truncated = true;
      return null;
    }
    const id = this.nodes.length;
    this.nodes.push(key);
    this.ids.set(key, id);
    return id;
  }

  edge(from: number, to: number): void {
    if (from === to) return;
    const k = `${from}>${to}`;
    if (this.edgeKeys.has(k)) return;
    if (this.edges.length >= LOCK_EDGES_CAP) {
      this.truncated = true;
      return;
    }
    this.edgeKeys.add(k);
    this.edges.push([from, to]);
  }

  graph(path: string, manager: LockManager, lockVersion: string | null): LockGraph {
    return {
      path,
      manager,
      lock_version: lockVersion,
      nodes: this.nodes,
      roots: [...this.roots].sort((a, b) => a - b),
      edges: this.edges,
      ...(this.truncated ? { truncated: true as const } : {}),
    };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const depNames = (v: unknown): string[] => (isRecord(v) ? Object.keys(v) : []);
const versionText = (v: unknown): string | null => (typeof v === "number" ? String(v) : str(v));
const versionNumber = (v: string | null): number => (v === null ? Number.NaN : Number.parseFloat(v));

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const EDGE_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * `package-lock.json` v2/v3: карта `packages` с ключами-путями (`""` – корень,
 * `node_modules/a`, `node_modules/a/node_modules/b`, `packages/app` – пакет
 * workspace). Зависимость `b` пакета по пути `p` – ближайший `…/node_modules/b`
 * вверх по цепочке вложенных `node_modules` (так npm и резолвит). Ключ без
 * `node_modules/` – пакет workspace: его зависимости прямые для репозитория
 * (список `workspaces` корня часто задан глобами, поэтому по нему не ходим).
 * Запись `link: true` – ссылка на такой пакет: путь ссылки ведет в узел цели,
 * и ребра из других пакетов проходят в workspace. v1 (без `packages`) – null.
 */
export function parseNpmLock(path: string, text: string): LockGraph | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json["packages"])) return null;
  const packages = json["packages"] as Record<string, unknown>;
  const lockVersion = versionText(json["lockfileVersion"]);
  if (!(versionNumber(lockVersion) >= 2)) return null;
  const b = new GraphBuilder();

  const isWorkspace = (p: string): boolean => p !== "" && !p.split("/").includes("node_modules");
  const nameOfPath = (p: string): string => {
    const i = p.lastIndexOf("node_modules/");
    return i >= 0 ? p.slice(i + "node_modules/".length) : p;
  };
  // узлы – все пакеты, кроме ссылок; имя: явное поле name или хвост пути
  const byPath = new Map<string, number>();
  const links: { from: string; to: string }[] = [];
  for (const [p, entry] of Object.entries(packages)) {
    if (p === "" || !isRecord(entry)) continue;
    if (entry["link"] === true) {
      const target = str(entry["resolved"]);
      if (target !== null) links.push({ from: p, to: target });
      continue;
    }
    const name = str(entry["name"]) ?? nameOfPath(p);
    const id = b.node(name, str(entry["version"]));
    if (id !== null) byPath.set(p, id);
  }
  for (const l of links) {
    const id = byPath.get(l.to);
    if (id !== undefined) byPath.set(l.from, id);
  }
  // резолв зависимости `dep` для пакета по пути `from`: вверх по node_modules
  const resolve = (from: string, dep: string): number | null => {
    let base = from;
    for (;;) {
      const candidate = base === "" ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
      const id = byPath.get(candidate);
      if (id !== undefined) return id;
      if (base === "") return null;
      const i = base.lastIndexOf("/node_modules/");
      base = i >= 0 ? base.slice(0, i) : base.includes("node_modules/") ? "" : "";
    }
  };
  // корни – зависимости корня и всех пакетов workspace
  for (const [p, entry] of Object.entries(packages)) {
    if (!isRecord(entry) || entry["link"] === true) continue;
    if (p !== "" && !isWorkspace(p)) continue;
    const fields = p === "" ? [...DEP_FIELDS, "peerDependencies"] : DEP_FIELDS;
    for (const field of fields) {
      for (const dep of depNames(entry[field])) {
        const id = resolve(p, dep);
        if (id !== null) b.roots.add(id);
      }
    }
  }
  // ребра – зависимости установленных пакетов (и пакетов workspace между собой)
  for (const [p, entry] of Object.entries(packages)) {
    if (p === "" || !isRecord(entry) || entry["link"] === true) continue;
    const from = byPath.get(p);
    if (from === undefined) continue;
    for (const field of EDGE_FIELDS) {
      for (const dep of depNames(entry[field])) {
        const to = resolve(p, dep);
        if (to !== null) b.edge(from, to);
      }
    }
  }
  return b.graph(path, "npm", lockVersion);
}

/** Хвост `(peer@ver)` и ведущий `/` у ключей pnpm отрезаются. */
const pnpmKey = (k: string): string => (k.startsWith("/") ? k.slice(1) : k).replace(/\(.*$/, "");

/** `name@1.2.3` и `@scope/name@1.2.3` → имя и версия; без `@` после первого символа – только имя. */
function splitNameVersion(key: string): { name: string; version: string | null } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, version: null };
  return { name: key.slice(0, at), version: key.slice(at + 1) || null };
}

/**
 * `pnpm-lock.yaml` v6+: `importers` – корни (`.` и пакеты workspace) с
 * прямыми зависимостями `{specifier, version}`; зависимости пакетов – в
 * `snapshots` (v9) или прямо в `packages` (v6–v8). Ключи вида `name@version`
 * (v9) или `/name@version` (v6) с возможным хвостом `(peer@ver)`. Версия
 * зависимости `name@1.2.3` вместо `1.2.3` – алиас `npm:` на другой пакет:
 * узел – настоящий пакет. v5 и старше (`/name/1.0.0`) – null.
 */
export function parsePnpmLock(path: string, text: string): LockGraph | null {
  let doc: unknown;
  try {
    doc = parseYamlSubset(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const lockVersion = versionText(doc["lockfileVersion"]);
  if (!(versionNumber(lockVersion) >= PNPM_LOCK_MIN_VERSION)) return null;
  const packages = isRecord(doc["packages"]) ? (doc["packages"] as Record<string, unknown>) : {};
  const snapshots = isRecord(doc["snapshots"]) ? (doc["snapshots"] as Record<string, unknown>) : null;
  const importers = isRecord(doc["importers"]) ? (doc["importers"] as Record<string, unknown>) : null;
  if (importers === null && Object.keys(packages).length === 0) return null;
  const b = new GraphBuilder();
  const nodeOfKey = (k: string): number | null => {
    const { name, version } = splitNameVersion(pnpmKey(k));
    return b.node(name, version);
  };
  // версия зависимости: `1.2.3`, `1.2.3(peer@x)`, `/name@1.2.3` (алиас), `link:../x` (workspace, без версии)
  const nodeOfDep = (name: string, spec: unknown): number | null => {
    const raw = typeof spec === "string" ? spec : isRecord(spec) ? str(spec["version"]) : null;
    if (raw === null || raw.startsWith("link:") || raw.startsWith("file:")) return b.node(name, null);
    const v = pnpmKey(raw);
    if (v.lastIndexOf("@") > 0) {
      const alias = splitNameVersion(v);
      return b.node(alias.name, alias.version);
    }
    return b.node(name, v || null);
  };
  for (const k of Object.keys(snapshots ?? packages)) nodeOfKey(k);
  // корни – прямые зависимости импортеров (корень и workspace) или верхнего уровня
  const rootSources: Record<string, unknown>[] = importers !== null ? Object.values(importers).filter(isRecord) : [doc];
  for (const src of rootSources) {
    for (const field of DEP_FIELDS) {
      const deps = src[field];
      if (!isRecord(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const id = nodeOfDep(name, spec);
        if (id !== null) b.roots.add(id);
      }
    }
  }
  // ребра – зависимости пакетов
  for (const [k, entry] of Object.entries(snapshots ?? packages)) {
    if (!isRecord(entry)) continue;
    const from = nodeOfKey(k);
    if (from === null) continue;
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const deps = entry[field];
      if (!isRecord(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const to = nodeOfDep(name, spec);
        if (to !== null) b.edge(from, to);
      }
    }
  }
  return b.graph(path, "pnpm", lockVersion);
}

export function parseLock(path: string, manager: LockManager, text: string): LockGraph | null {
  return manager === "npm" ? parseNpmLock(path, text) : parsePnpmLock(path, text);
}

/**
 * Факт графов по списку блобов клона и читателю содержимого. Файлы больше капа
 * размера не читаются и в кап числа файлов не входят. Корневой lock читается
 * первым (сортировка по глубине). Ни одного lock-файла или ни один не
 * разобрался – null (факта нет: без графа «Безопасность» считает находки как
 * раньше). Читатель бросает – файл пропускается.
 */
export async function collectLockGraph(
  blobs: readonly { path: string; size: number; sha: string }[],
  read: (sha: string) => Promise<string>,
): Promise<LockGraphFactValue | null> {
  const locks = blobs
    .map((b) => ({ ...b, manager: lockManagerOf(b.path) }))
    .filter((b): b is typeof b & { manager: LockManager } => b.manager !== null && b.size <= LOCK_FILE_CAP_BYTES)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  if (locks.length === 0) return null;
  const graphs: LockGraph[] = [];
  for (const lock of locks.slice(0, LOCK_FILES_CAP)) {
    try {
      const g = parseLock(lock.path, lock.manager, await read(lock.sha));
      if (g !== null && g.nodes.length > 0) graphs.push(g);
    } catch {
      /* блоб не прочитан – lock пропущен */
    }
  }
  if (graphs.length === 0) return null;
  return { graphs, ...(locks.length > LOCK_FILES_CAP ? { truncated: true as const } : {}) };
}
