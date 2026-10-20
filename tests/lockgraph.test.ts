// Граф зависимостей из lock-файлов (collectors/lockgraph.ts) и сопоставление
// с уязвимыми пакетами SCA (score/deps-graph.ts). Фикстура – настоящий
// package-lock.json v3 тестового репо kibitkina-p/hc-sca-probe: прямые
// lodash/minimist/express, транзитивные qs/body-parser/... через express.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectLockGraph, lockManagerOf, parseNpmLock, parsePnpmLock, LOCK_FILES_CAP, LOCK_NODES_CAP, LOCK_NODE_CAP_CHARS } from "../src/collectors/lockgraph";
import { parseYamlSubset } from "../src/collectors/yamlmini";
import { isNpmShapedName, matchVulnerableDependencies, VIA_CAP } from "../src/score/deps-graph";
import type { AppsecScaPackage } from "../src/collectors/appsec";
import { DEPS_TRANSITIVE_WEIGHT, SEVERITY_WEIGHTS } from "../src/score/model";

const FIX = join(import.meta.dir, "fixtures/lockgraph");
const npmLock = readFileSync(join(FIX, "hc-sca-probe.package-lock.json"), "utf8");

const nameOf = (node: string) => node.slice(0, node.lastIndexOf("@"));

describe("lockManagerOf: какие файлы считаются lock-файлами", () => {
  test("package-lock, npm-shrinkwrap, pnpm-lock в корне и до 2 каталогов; node_modules и vendor – нет", () => {
    expect(lockManagerOf("package-lock.json")).toBe("npm");
    expect(lockManagerOf("npm-shrinkwrap.json")).toBe("npm");
    expect(lockManagerOf("pnpm-lock.yaml")).toBe("pnpm");
    expect(lockManagerOf("apps/web/package-lock.json")).toBe("npm");
    expect(lockManagerOf("a/b/c/package-lock.json")).toBeNull();
    expect(lockManagerOf("node_modules/x/package-lock.json")).toBeNull();
    expect(lockManagerOf("vendor/package-lock.json")).toBeNull();
    expect(lockManagerOf("yarn.lock")).toBeNull();
    expect(lockManagerOf("package.json")).toBeNull();
  });
});

describe("parseNpmLock: package-lock.json v3 живого тестового репо", () => {
  const g = parseNpmLock("package-lock.json", npmLock)!;

  test("узлы – все пакеты lock, корни – 3 прямые зависимости", () => {
    expect(g).not.toBeNull();
    expect(g.manager).toBe("npm");
    expect(g.lock_version).toBe("3");
    // 53 записи packages минус корень ""
    expect(g.nodes).toHaveLength(52);
    expect(g.roots.map((i) => g.nodes[i]).sort()).toEqual(["express@4.17.1", "lodash@4.17.15", "minimist@1.2.0"]);
    expect(g.truncated).toBeUndefined();
  });

  test("ребра: express → body-parser → qs; у листа qs ребер нет", () => {
    const id = (node: string) => g.nodes.indexOf(node);
    const outOf = (node: string) => g.edges.filter(([f]) => f === id(node)).map(([, t]) => nameOf(g.nodes[t]!));
    expect(outOf("express@4.17.1")).toContain("body-parser");
    expect(outOf("body-parser@1.19.0")).toContain("qs");
    expect(outOf("qs@6.7.0")).toEqual([]);
    expect(g.edges.length).toBeGreaterThan(60);
  });

  test("v1 (без packages) и не-JSON – без графа", () => {
    expect(parseNpmLock("package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1" } } }))).toBeNull();
    expect(parseNpmLock("package-lock.json", "{ not json")).toBeNull();
  });

  test("вложенные node_modules: зависимость резолвится в ближайшую копию вверх по цепочке", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { a: "1.0.0", c: "2.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { c: "1.0.0" } },
        // у a своя копия c@1 внутри — a → c@1, а не корневой c@2
        "node_modules/a/node_modules/c": { version: "1.0.0" },
        "node_modules/c": { version: "2.0.0", dependencies: { d: "1.0.0" } },
        "node_modules/d": { version: "1.0.0" },
      },
    };
    const n = parseNpmLock("package-lock.json", JSON.stringify(lock))!;
    const id = (node: string) => n.nodes.indexOf(node);
    expect(n.roots.map((i) => n.nodes[i]).sort()).toEqual(["a@1.0.0", "c@2.0.0"]);
    expect(n.edges).toContainEqual([id("a@1.0.0"), id("c@1.0.0")]);
    expect(n.edges).not.toContainEqual([id("a@1.0.0"), id("c@2.0.0")]);
    expect(n.edges).toContainEqual([id("c@2.0.0"), id("d@1.0.0")]);
  });

  test("workspaces по глобу: пакеты без node_modules в пути – корни; link ведет в пакет workspace, ребра проходят сквозь него", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["packages/*"], devDependencies: { typescript: "5.0.0" } },
        "packages/app": { name: "app", version: "0.0.1", dependencies: { express: "4.17.1", lib: "0.0.1" } },
        "packages/lib": { name: "lib", version: "0.0.1", dependencies: { qs: "6.7.0" } },
        "node_modules/app": { resolved: "packages/app", link: true },
        "node_modules/lib": { resolved: "packages/lib", link: true },
        "node_modules/typescript": { version: "5.0.0", dev: true },
        "node_modules/express": { version: "4.17.1", dependencies: { qs: "6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      },
    };
    const n = parseNpmLock("package-lock.json", JSON.stringify(lock))!;
    const names = (ids: number[]) => ids.map((i) => n.nodes[i]).sort();
    // ссылки узлами не становятся
    expect(n.nodes).not.toContain("app@");
    expect(names(n.roots)).toEqual(["express@4.17.1", "lib@0.0.1", "qs@6.7.0", "typescript@5.0.0"]);
    const id = (node: string) => n.nodes.indexOf(node);
    // app → lib через link, lib → qs
    expect(n.edges).toContainEqual([id("app@0.0.1"), id("lib@0.0.1")]);
    expect(n.edges).toContainEqual([id("lib@0.0.1"), id("qs@6.7.0")]);
    const r = matchVulnerableDependencies({ packages: [{ name: "qs", version: "6.7.0", severity: "high", advisories: 1, engines: [] }] }, { graphs: [n] });
    expect(r.direct).toBe(1);
  });

  test("lockfileVersion ниже 2 и имя длиннее капа – без графа или с пометкой truncated", () => {
    expect(parseNpmLock("package-lock.json", JSON.stringify({ lockfileVersion: 1, packages: { "": {} } }))).toBeNull();
    const long = "x".repeat(LOCK_NODE_CAP_CHARS + 10);
    const n = parseNpmLock("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0" }, [`node_modules/${long}`]: { version: "1.0.0" } } }))!;
    expect(n.nodes).toEqual(["a@1.0.0"]);
    expect(n.truncated).toBe(true);
  });

  test("кап узлов: граф обрезается и помечается truncated", () => {
    const packages: Record<string, unknown> = { "": { dependencies: { p0: "1" } } };
    for (let i = 0; i < LOCK_NODES_CAP + 50; i++) packages[`node_modules/p${i}`] = { version: "1.0.0" };
    const n = parseNpmLock("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }))!;
    expect(n.nodes).toHaveLength(LOCK_NODES_CAP);
    expect(n.truncated).toBe(true);
  });
});

describe("parsePnpmLock: pnpm-lock.yaml v9 и v6", () => {
  const v9 = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        specifier: 4.17.1
        version: 4.17.1
    devDependencies:
      '@types/node':
        specifier: ^20
        version: 20.1.0

packages:
  body-parser@1.19.0:
    resolution: {integrity: sha512-a}
  express@4.17.1:
    resolution: {integrity: sha512-b}
  qs@6.7.0:
    resolution: {integrity: sha512-c}
  '@types/node@20.1.0':
    resolution: {integrity: sha512-d}

snapshots:
  body-parser@1.19.0:
    dependencies:
      qs: 6.7.0
  express@4.17.1:
    dependencies:
      body-parser: 1.19.0
  qs@6.7.0: {}
  '@types/node@20.1.0': {}
`;
  test("v9: корни из importers, ребра из snapshots, scoped-имена", () => {
    const g = parsePnpmLock("pnpm-lock.yaml", v9)!;
    expect(g.manager).toBe("pnpm");
    expect(g.lock_version).toBe("9.0");
    expect(g.roots.map((i) => g.nodes[i]).sort()).toEqual(["@types/node@20.1.0", "express@4.17.1"]);
    const id = (node: string) => g.nodes.indexOf(node);
    expect(g.edges).toContainEqual([id("express@4.17.1"), id("body-parser@1.19.0")]);
    expect(g.edges).toContainEqual([id("body-parser@1.19.0"), id("qs@6.7.0")]);
  });

  test("v6: ключи с ведущим слешем и зависимости прямо в packages; peer-хвост отрезается", () => {
    const v6 = `lockfileVersion: '6.0'

dependencies:
  express:
    specifier: 4.17.1
    version: 4.17.1(supports-color@9.0.0)

packages:
  /express@4.17.1(supports-color@9.0.0):
    resolution: {integrity: sha512-b}
    dependencies:
      body-parser: 1.19.0
  /body-parser@1.19.0:
    resolution: {integrity: sha512-a}
`;
    const g = parsePnpmLock("pnpm-lock.yaml", v6)!;
    expect(g.nodes).toContain("express@4.17.1");
    expect(g.roots.map((i) => g.nodes[i])).toEqual(["express@4.17.1"]);
    const id = (node: string) => g.nodes.indexOf(node);
    expect(g.edges).toContainEqual([id("express@4.17.1"), id("body-parser@1.19.0")]);
  });

  test("не YAML или без пакетов – без графа", () => {
    expect(parsePnpmLock("pnpm-lock.yaml", "\t- bad")).toBeNull();
    expect(parsePnpmLock("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")).toBeNull();
  });

  test("v5 (`/name/1.0.0`) не поддерживается – null, а не граф из мусорных узлов", () => {
    const v5 = `lockfileVersion: 5.4

specifiers:
  express: 4.17.1

dependencies:
  express: 4.17.1

packages:
  /express/4.17.1:
    resolution: {integrity: sha512-b}
    dependencies:
      qs: 6.7.0
  /qs/6.7.0:
    resolution: {integrity: sha512-c}
`;
    expect(parsePnpmLock("pnpm-lock.yaml", v5)).toBeNull();
    expect(parsePnpmLock("pnpm-lock.yaml", "packages:\n  /a/1.0.0:\n    resolution: {integrity: x}\n")).toBeNull();
  });

  test("v6 без importers: devDependencies и optionalDependencies верхнего уровня – тоже корни", () => {
    const v6 = `lockfileVersion: '6.0'

devDependencies:
  minimist:
    specifier: 1.2.0
    version: 1.2.0

packages:
  /minimist@1.2.0:
    resolution: {integrity: sha512-a}
`;
    const g = parsePnpmLock("pnpm-lock.yaml", v6)!;
    expect(g.roots.map((i) => g.nodes[i])).toEqual(["minimist@1.2.0"]);
  });

  test("алиас npm: версия вида name@1.2.3 – узел настоящего пакета, и в корнях, и в ребрах", () => {
    const v9 = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      my-lodash:
        specifier: npm:lodash@4.17.15
        version: lodash@4.17.15
      wrapper:
        specifier: 1.0.0
        version: 1.0.0

packages:
  lodash@4.17.15:
    resolution: {integrity: sha512-a}
  wrapper@1.0.0:
    resolution: {integrity: sha512-b}

snapshots:
  lodash@4.17.15: {}
  wrapper@1.0.0:
    dependencies:
      my-lodash: lodash@4.17.15
`;
    const g = parsePnpmLock("pnpm-lock.yaml", v9)!;
    expect(g.nodes).not.toContain("my-lodash@lodash@4.17.15");
    expect(g.roots.map((i) => g.nodes[i]).sort()).toEqual(["lodash@4.17.15", "wrapper@1.0.0"]);
    const id = (node: string) => g.nodes.indexOf(node);
    expect(g.edges).toContainEqual([id("wrapper@1.0.0"), id("lodash@4.17.15")]);
    const r = matchVulnerableDependencies({ packages: [{ name: "lodash", version: "4.17.15", severity: "high", advisories: 1, engines: [] }] }, { graphs: [g] });
    expect(r.direct).toBe(1);
  });
});

describe("yamlmini на содержимом lock-файла: ключи с двоеточием и длинные строки", () => {
  test("ключ с `:` внутри (адрес git-зависимости) без кавычек читается целиком", () => {
    const doc = parseYamlSubset("packages:\n  foo@https://codeload.github.com/x/y/tar.gz/abc:\n    resolution: {tarball: x}\n  a: b\n") as any;
    expect(Object.keys(doc.packages)).toEqual(["foo@https://codeload.github.com/x/y/tar.gz/abc", "a"]);
    expect(doc.packages.a).toBe("b");
    // «key:value» без пробела – по-прежнему не отображение
    expect(() => parseYamlSubset("a:b\n")).toThrow();
  });

  test("строка из мегабайта пробелов без двоеточия не подвешивает парсер (нет квадратичного отката)", () => {
    const text = `lockfileVersion: '9.0'\n${"a" + " ".repeat(1_000_000) + "b"}\n`;
    const t0 = Date.now();
    expect(() => parseYamlSubset(text)).toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("collectLockGraph: факт по блобам клона", () => {
  const blobs = (paths: string[]) => paths.map((path, i) => ({ path, sha: `sha${i}`, size: 1000 }));
  const reader = (contentByPath: Record<string, string>, paths: string[]) => async (sha: string) => contentByPath[paths[Number(sha.slice(3))]!]!;

  test("нет lock-файлов – null; корневой lock читается первым; лишние сверх капа – truncated", async () => {
    expect(await collectLockGraph(blobs(["package.json", "src/a.ts"]), async () => "")).toBeNull();
    const paths = ["b/package-lock.json", "package-lock.json", "a/package-lock.json", "c/package-lock.json", "d/package-lock.json"];
    const content: Record<string, string> = {};
    for (const p of paths) content[p] = npmLock;
    const fact = (await collectLockGraph(blobs(paths), reader(content, paths)))!;
    expect(fact.graphs[0]!.path).toBe("package-lock.json");
    expect(fact.graphs).toHaveLength(LOCK_FILES_CAP);
    expect(fact.truncated).toBe(true);
  });

  test("неразобранный или нечитаемый lock пропускается; все пропущены – null", async () => {
    const paths = ["package-lock.json", "app/pnpm-lock.yaml"];
    const content = { "package-lock.json": "{ broken", "app/pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
    expect(await collectLockGraph(blobs(paths), reader(content, paths))).toBeNull();
    expect(
      await collectLockGraph(blobs(paths), async () => {
        throw new Error("cat-file failed");
      }),
    ).toBeNull();
  });

  test("файл больше капа размера не читается и не занимает место в капе числа файлов", async () => {
    const fact = await collectLockGraph([{ path: "package-lock.json", sha: "x", size: 10 * 1024 * 1024 }], async () => npmLock);
    expect(fact).toBeNull();
    const paths = ["package-lock.json", "a/package-lock.json", "b/package-lock.json", "c/package-lock.json", "d/package-lock.json"];
    const list = paths.map((path, i) => ({ path, sha: `sha${i}`, size: i === 0 ? 10 * 1024 * 1024 : 1000 }));
    const f2 = (await collectLockGraph(list, async () => npmLock))!;
    expect(f2.graphs.map((g) => g.path)).toEqual(["a/package-lock.json", "b/package-lock.json", "c/package-lock.json", "d/package-lock.json"]);
    expect(f2.truncated).toBeUndefined();
  });
});

describe("matchVulnerableDependencies: пакеты SCA против графа", () => {
  const graph = { graphs: [parseNpmLock("package-lock.json", npmLock)!] };
  const pkg = (name: string, version: string | null, severity: AppsecScaPackage["severity"] = "high"): AppsecScaPackage => ({ name, version, severity, advisories: 1, engines: ["Trivy"] });

  test("живой набор тестового репо: 3 прямых, 6 транзитивных через express, цепочка до qs", () => {
    const sca = {
      packages: [
        pkg("lodash", "4.17.15", "critical"),
        pkg("minimist", "1.2.0", "critical"),
        pkg("express", "4.17.1", "medium"),
        pkg("qs", "6.7.0", "high"),
        pkg("body-parser", "1.19.0", "high"),
        pkg("cookie", "0.4.0", "low"),
        pkg("path-to-regexp", "0.1.7", "high"),
        pkg("send", "0.17.1", "medium"),
        pkg("serve-static", "1.14.1", "medium"),
      ],
    };
    const r = matchVulnerableDependencies(sca, graph);
    expect(r.direct).toBe(3);
    expect(r.transitive).toBe(6);
    expect(r.unmatched).toBe(0);
    const qs = r.packages.find((p) => p.name === "qs")!;
    expect(qs.direct).toBe(false);
    // express зависит от qs и напрямую, и через body-parser: цепочка – кратчайшая
    expect(qs.via).toEqual(["express"]);
    expect(qs.lock).toBe("package-lock.json");
    const cookie = r.packages.find((p) => p.name === "cookie")!;
    expect(cookie.via).toEqual(["express"]);
    expect(r.packages.find((p) => p.name === "lodash")!.direct).toBe(true);
    // вклад: прямые полным весом, транзитивные половиной
    const expected =
      SEVERITY_WEIGHTS.critical * 2 +
      SEVERITY_WEIGHTS.medium +
      (SEVERITY_WEIGHTS.high * 3 + SEVERITY_WEIGHTS.low + SEVERITY_WEIGHTS.medium * 2) * DEPS_TRANSITIVE_WEIGHT;
    expect(r.weighted).toBeCloseTo(expected, 6);
    // порядок – по вкладу, худшие первыми
    expect(r.packages[0]!.severity).toBe("critical");
    expect(r.managers).toEqual(["npm"]);
    expect(r.graph_truncated).toBe(false);
  });

  test("пакета нет в графе – несопоставлен и весит как прямой", () => {
    const r = matchVulnerableDependencies({ packages: [pkg("left-pad", "1.0.0", "high")] }, graph);
    expect(r.unmatched).toBe(1);
    expect(r.packages.every((p) => p.direct === null && p.weight === SEVERITY_WEIGHTS.high)).toBe(true);
  });

  test("версию уже подняли (qs 6.7.0 в SCA, в lock-файле 6.7.3) – не прямой и не в сумме, пока AppSec не перепроверит", () => {
    const bumped = { graphs: [{ ...graph.graphs[0]!, nodes: graph.graphs[0]!.nodes.map((n) => (n === "qs@6.7.0" ? "qs@6.7.3" : n)) }] };
    const r = matchVulnerableDependencies({ packages: [pkg("qs", "6.7.0", "critical"), pkg("lodash", "4.17.15", "low")] }, bumped);
    expect(r).toMatchObject({ updated: 1, unmatched: 0, direct: 1, transitive: 0 });
    expect(r.packages.map((p) => p.name)).toEqual(["lodash"]);
    expect(r.weighted).toBe(SEVERITY_WEIGHTS.low);
    // в исходном графе тот же qs – транзитивный через express, половина веса
    const before = matchVulnerableDependencies({ packages: [pkg("qs", "6.7.0", "critical")] }, graph);
    expect(before).toMatchObject({ updated: 0, transitive: 1, weighted: SEVERITY_WEIGHTS.critical * DEPS_TRANSITIVE_WEIGHT });
    // старая версия осталась только осиротевшей записью, новая живая – тоже «обновлен»
    const g = { graphs: [{ path: "package-lock.json", manager: "npm" as const, lock_version: "3", nodes: ["a@1", "qs@6.7.0", "qs@6.7.3"], roots: [0], edges: [[0, 2]] as [number, number][] }] };
    expect(matchVulnerableDependencies({ packages: [pkg("qs", "6.7.0", "high")] }, g)).toMatchObject({ updated: 1, unmatched: 0, weighted: 0 });
    // имя есть только в осиротевшей записи другой версии – как не найден
    const dead = { graphs: [{ path: "package-lock.json", manager: "npm" as const, lock_version: "3", nodes: ["a@1", "qs@6.7.3"], roots: [0], edges: [] as [number, number][] }] };
    expect(matchVulnerableDependencies({ packages: [pkg("qs", "6.7.0", "high")] }, dead)).toMatchObject({ updated: 0, unmatched: 1, weighted: SEVERITY_WEIGHTS.high });
  });

  test("пакет без версии в SCA сопоставляется по имени; узел без версии в графе – тоже", () => {
    const r = matchVulnerableDependencies({ packages: [pkg("qs", null, "high")] }, graph);
    expect(r.transitive).toBe(1);
    const g2 = { graphs: [{ path: "pnpm-lock.yaml", manager: "pnpm" as const, lock_version: "9.0", nodes: ["ws-lib@", "dep@1.0.0"], roots: [0], edges: [[0, 1]] as [number, number][] }] };
    const r2 = matchVulnerableDependencies({ packages: [pkg("ws-lib", "2.0.0", "low")] }, g2);
    expect(r2.direct).toBe(1);
  });

  test("узел есть, но от корней недостижим (осиротевшая запись) – как не найден", () => {
    const g = { graphs: [{ path: "package-lock.json", manager: "npm" as const, lock_version: "3", nodes: ["a@1", "orphan@1"], roots: [0], edges: [] as [number, number][] }] };
    const r = matchVulnerableDependencies({ packages: [pkg("orphan", "1", "low")] }, g);
    expect(r.unmatched).toBe(1);
  });

  test("несколько графов: берется первый, где пакет достижим от корней, а не первый, где есть осиротевший узел", () => {
    const orphan = { path: "package-lock.json", manager: "npm" as const, lock_version: "3", nodes: ["a@1", "qs@6.7.0"], roots: [0], edges: [] as [number, number][] };
    const reachable = { path: "app/package-lock.json", manager: "npm" as const, lock_version: "3", nodes: ["qs@6.7.0"], roots: [0], edges: [] as [number, number][] };
    const r = matchVulnerableDependencies({ packages: [pkg("qs", "6.7.0", "high")] }, { graphs: [orphan, reachable] });
    expect(r.direct).toBe(1);
    expect(r.packages[0]!.lock).toBe("app/package-lock.json");
  });

  test("пакеты других экосистем (Go, Maven) – вне графа: без веса, но в списке; имена npm/PyPI – кандидаты", () => {
    expect(isNpmShapedName("lodash")).toBe(true);
    expect(isNpmShapedName("@scope/pkg")).toBe(true);
    expect(isNpmShapedName("requests")).toBe(true);
    expect(isNpmShapedName("github.com/gin-gonic/gin")).toBe(false);
    expect(isNpmShapedName("org.apache:commons")).toBe(false);
    const r = matchVulnerableDependencies({ packages: [pkg("github.com/gin-gonic/gin", "1.9.0", "critical"), pkg("left-pad", "1.0.0", "low")] }, graph);
    expect(r.outside).toBe(1);
    expect(r.unmatched).toBe(1);
    expect(r.weighted).toBe(SEVERITY_WEIGHTS.low);
    expect(r.packages.find((p) => p.name.startsWith("github.com"))).toMatchObject({ outside: true, direct: null, weight: 0 });
  });

  test("экосистема из факта: пакеты PyPI рядом с package-lock – вне графа, даже если имя совпало с пакетом npm", () => {
    const py = (name: string, version: string, severity: AppsecScaPackage["severity"]) => ({ ...pkg(name, version, severity), ecosystem: "pypi" });
    const r = matchVulnerableDependencies({ packages: [py("Django", "3.2.0", "critical"), py("requests", "2.19.0", "high"), py("qs", "6.7.0", "high"), { ...pkg("cookie", "0.4.0", "low"), ecosystem: "npm" }] }, graph);
    expect(r).toMatchObject({ outside: 3, unmatched: 0, transitive: 1, weighted: SEVERITY_WEIGHTS.low * DEPS_TRANSITIVE_WEIGHT });
    expect(r.packages.filter((p) => p.outside).map((p) => p.name).sort()).toEqual(["Django", "qs", "requests"]);
    // без поля ecosystem (старый факт) – прежнее правило формы имени: requests – кандидат графа
    const legacy = matchVulnerableDependencies({ packages: [pkg("requests", "2.19.0", "high")] }, graph);
    expect(legacy).toMatchObject({ outside: 0, unmatched: 1 });
  });

  test("цепочка в показе не длиннее VIA_CAP", () => {
    const nodes = Array.from({ length: VIA_CAP + 5 }, (_, i) => `n${i}@1`);
    const edges = nodes.slice(1).map((_, i) => [i, i + 1] as [number, number]);
    const g = { path: "package-lock.json", manager: "npm" as const, lock_version: "3", nodes, roots: [0], edges };
    const r = matchVulnerableDependencies({ packages: [pkg(`n${VIA_CAP + 4}`, "1", "low")] }, { graphs: [g] });
    expect(r.packages[0]!.via).toHaveLength(VIA_CAP);
    expect(r.packages[0]!.direct).toBe(false);
  });

  test("обрезанный граф помечает отчет", () => {
    const g = { graphs: [{ ...graph.graphs[0]!, truncated: true as const }] };
    expect(matchVulnerableDependencies({ packages: [] }, g).graph_truncated).toBe(true);
    expect(matchVulnerableDependencies({ packages: [] }, { ...graph, truncated: true }).graph_truncated).toBe(true);
  });
});
