// Зависимости репозитория из манифестов пакетных менеджеров – факт `tree.deps`
// для тематики рейтинга (api/topics.ts). Читаются только известные файлы в
// корне и на глубину до 2 каталогов, не больше DEPS_MANIFEST_CAP штук и
// DEPS_FILE_CAP_BYTES каждый; разбор нестрогий: нужны имена пакетов, а не
// точные версии. Ошибочный разбор одного файла факт не роняет.

/** Сколько манифестов читается на репозиторий (монорепо: по одному на пакет не нужно). */
export const DEPS_MANIFEST_CAP = 8;
/** Кап одного манифеста, байт: lock-файлы и гигантские pom не читаются. */
export const DEPS_FILE_CAP_BYTES = 256 * 1024;
/** Кап имен зависимостей в факте. */
export const DEPS_NAMES_CAP = 200;
/** Глубина пути манифеста: корень и до 2 каталогов (`apps/web/package.json`). */
export const DEPS_MAX_DEPTH = 2;

const MANIFEST_NAMES: readonly RegExp[] = [
  /^package\.json$/i,
  /^requirements[\w.-]*\.txt$/i,
  /^pyproject\.toml$/i,
  /^pipfile$/i,
  /^setup\.py$/i,
  /^go\.mod$/i,
  /^cargo\.toml$/i,
  /^pom\.xml$/i,
  /^build\.gradle(\.kts)?$/i,
  /^composer\.json$/i,
  /^gemfile$/i,
  /^pubspec\.yaml$/i,
  /^mix\.exs$/i,
  /^.+\.csproj$/i,
];

/** Манифест ли это по имени файла и глубине пути. */
export function isManifestPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.length - 1 > DEPS_MAX_DEPTH) return false;
  if (parts.some((p) => p === "node_modules" || p === "vendor" || p === ".git")) return false;
  const name = parts[parts.length - 1]!;
  return MANIFEST_NAMES.some((re) => re.test(name));
}

const addAll = (out: Set<string>, names: Iterable<string>) => {
  for (const n of names) {
    const name = n.trim();
    if (name !== "" && name.length <= 100) out.add(name);
  }
};

function jsonKeys(text: string, fields: readonly string[]): string[] {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const out: string[] = [];
    for (const f of fields) {
      const v = obj[f];
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(...Object.keys(v as Record<string, unknown>));
    }
    return out;
  } catch {
    return [];
  }
}

/** Имя пакета из строки requirements/pyproject: до версии, маркера или extras. */
const pyName = (line: string): string | null => {
  const s = line.trim();
  if (s === "" || s.startsWith("#") || s.startsWith("-")) return null;
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1]! : null;
};

/**
 * Имена зависимостей из текста манифеста по его имени файла. Неизвестный файл
 * или неразборчивый текст – пустой список.
 */
export function parseManifest(path: string, text: string): string[] {
  const name = path.split("/").pop()!.toLowerCase();
  const out = new Set<string>();
  if (name === "package.json") addAll(out, jsonKeys(text, ["dependencies", "devDependencies", "peerDependencies"]));
  else if (name === "composer.json") addAll(out, jsonKeys(text, ["require", "require-dev"]));
  else if (/^requirements[\w.-]*\.txt$/.test(name)) {
    for (const line of text.split("\n")) {
      const n = pyName(line);
      if (n) out.add(n);
    }
  } else if (name === "pyproject.toml" || name === "pipfile") {
    // массив dependencies = ["fastapi>=0.1", ...] и таблицы [tool.poetry.dependencies] / [packages]
    // конец массива – `]` в конце строки: `"uvicorn[standard]",` внутри массива не закрывает его
    for (const m of text.matchAll(/^\s*(?:dependencies|dev-dependencies|optional-dependencies\.\w+)\s*=\s*\[([\s\S]*?)\]\s*$/gm)) {
      for (const q of m[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const n = pyName(q[1] ?? q[2] ?? "");
        if (n) out.add(n);
      }
    }
    for (const m of text.matchAll(/^\[(?:tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.\w+\.dependencies|packages|dev-packages|project\.optional-dependencies)\]\s*\n([\s\S]*?)(?=^\[|$(?![\r\n]))/gm)) {
      for (const line of m[1]!.split("\n")) {
        const k = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
        if (k && k[1]!.toLowerCase() !== "python") out.add(k[1]!);
      }
    }
  } else if (name === "setup.py") {
    for (const m of text.matchAll(/install_requires\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const q of m[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const n = pyName(q[1] ?? q[2] ?? "");
        if (n) out.add(n);
      }
    }
  } else if (name === "go.mod") {
    for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[\d.]/gm)) out.add(m[1]!);
  } else if (name === "cargo.toml") {
    for (const m of text.matchAll(/^\[(?:dependencies|dev-dependencies|build-dependencies)\]\s*\n([\s\S]*?)(?=^\[|$(?![\r\n]))/gm)) {
      for (const line of m[1]!.split("\n")) {
        const k = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
        if (k) out.add(k[1]!);
      }
    }
    for (const m of text.matchAll(/^\[dependencies\.([A-Za-z0-9._-]+)\]/gm)) out.add(m[1]!);
  } else if (name === "pom.xml") {
    for (const m of text.matchAll(/<dependency>[\s\S]*?<groupId>\s*([^<\s]+)\s*<\/groupId>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) out.add(`${m[1]}:${m[2]}`);
  } else if (name === "build.gradle" || name === "build.gradle.kts") {
    for (const m of text.matchAll(/(?:implementation|api|compile|testImplementation|runtimeOnly|kapt|ksp)\s*\(?\s*["']([^"':]+:[^"':]+)(?::[^"']*)?["']/g)) out.add(m[1]!);
    for (const m of text.matchAll(/id\s*\(?\s*["']([a-z][a-z0-9.-]+)["']/g)) out.add(m[1]!);
  } else if (name === "gemfile") {
    for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) out.add(m[1]!);
  } else if (name === "pubspec.yaml") {
    for (const m of text.matchAll(/^(?:dependencies|dev_dependencies):\s*\n((?:[ \t]+[^\n]*\n?)*)/gm)) {
      for (const line of m[1]!.split("\n")) {
        const k = line.match(/^[ \t]{2}([A-Za-z0-9_]+)\s*:/);
        if (k) out.add(k[1]!);
      }
    }
  } else if (name === "mix.exs") {
    for (const m of text.matchAll(/\{\s*:([a-z_0-9]+)\s*,/g)) out.add(m[1]!);
  } else if (name.endsWith(".csproj")) {
    for (const m of text.matchAll(/<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g)) out.add(m[1]!);
  }
  return [...out];
}

export interface DepsFactValue {
  /** прочитанные манифесты (пути от корня) */
  manifests: string[];
  /** имена зависимостей, уникальные, не больше DEPS_NAMES_CAP */
  deps: string[];
  /** манифестов больше капа или имен больше капа – список неполный */
  truncated?: true;
}

/**
 * Факт зависимостей по списку блобов клона и читателю содержимого. Читатель
 * бросает – манифест пропускается. Ни одного манифеста – null (факта нет).
 */
export async function collectDeps(
  blobs: readonly { path: string; size: number; sha: string }[],
  read: (sha: string) => Promise<string>,
): Promise<DepsFactValue | null> {
  const manifests = blobs.filter((b) => isManifestPath(b.path) && b.size <= DEPS_FILE_CAP_BYTES).sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  if (manifests.length === 0) return null;
  const chosen = manifests.slice(0, DEPS_MANIFEST_CAP);
  const names = new Set<string>();
  const readPaths: string[] = [];
  for (const b of chosen) {
    try {
      for (const n of parseManifest(b.path, await read(b.sha))) names.add(n);
      readPaths.push(b.path);
    } catch {
      /* блоб не прочитан – манифест пропущен */
    }
  }
  const deps = [...names].sort();
  const truncated = manifests.length > DEPS_MANIFEST_CAP || deps.length > DEPS_NAMES_CAP;
  return { manifests: readPaths, deps: deps.slice(0, DEPS_NAMES_CAP), ...(truncated ? { truncated: true as const } : {}) };
}
