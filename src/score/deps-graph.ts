// Сопоставление уязвимых пакетов SCA (факт appsec.findings.sca) с графом
// зависимостей клона (факт tree.lockgraph): прямая зависимость или
// транзитивная, и через какую прямую она попала в проект. Чистые функции без
// БД – их зовут расчет (подметрика «Уязвимые зависимости», compute.ts) и
// рекомендации (recommend.ts), поэтому текст совета всегда сходится с баллом.
//
// Правила сопоставления:
// - пакет ищется по имени и версии; версия в графе пустая (link:, workspace) –
//   по имени;
// - пакет с таким именем в графе есть, но версии из SCA среди узлов нет –
//   «обновлен»: SCA берется из последней проверки AppSec, граф – из lock-файла
//   на HEAD, и разработчик уже поднял версию (qs 6.7.0 → 6.7.3). Об уязвимости
//   новой версии данных нет, а нет данных – не наказание: пакет в сумму не
//   входит и в список не попадает (счетчик `updated`); находка остается в
//   плотности находок до следующей проверки AppSec, которая и проверит новую
//   версию;
// - прямой – если узел среди корней (прямые зависимости корня и workspace);
// - цепочка – кратчайший путь от любого корня (BFS по ребрам), первая прямая
//   зависимость цепочки – «через кого»;
// - несопоставленный пакет (имени в графе нет, граф обрезан) весит как прямой –
//   худший случай, а не пропуск: SCA его нашел;
// - пакет другой экосистемы, которую прочитанные lock-файлы (только npm и
//   pnpm) не описывают, – «вне графа»: считается и показывается, но не
//   взвешивается – граф о нем ничего не знает, и карать репозиторий за
//   наличие JS-lock-файла рядом с Python- или Go-кодом нельзя. Экосистема
//   берется из факта (`ecosystem`, метка движка SCA); у старых фактов без нее –
//   по форме имени: Go `github.com/x/y` и Maven `g:a` вне графа, а имена
//   PyPI/npm неотличимы, поэтому пакет без `/` и `:` – кандидат графа.
import type { LockGraph, LockGraphFactValue } from "../collectors/lockgraph";
import type { AppsecScaPackage, AppsecScaSeverity } from "../collectors/appsec";
import { DEPS_TRANSITIVE_WEIGHT, SEVERITY_WEIGHTS } from "./model";

export interface VulnerableDependency {
  name: string;
  version: string | null;
  severity: AppsecScaSeverity;
  /** число групп SCA (advisories) по пакету, по всем движкам */
  advisories: number;
  /** прямая зависимость репозитория; null – в графе не найден или вне экосистемы графа */
  direct: boolean | null;
  /** пакет экосистемы, которую прочитанные lock-файлы не описывают */
  outside: boolean;
  /** цепочка от прямой зависимости до пакета (имена), для транзитивных; пустая – прямая или не найден */
  via: string[];
  /** lock-файл, в котором найден */
  lock: string | null;
  /** вклад в взвешенную сумму: вес критичности × (1 | DEPS_TRANSITIVE_WEIGHT) */
  weight: number;
}

export interface DepsReport {
  packages: VulnerableDependency[];
  direct: number;
  transitive: number;
  unmatched: number;
  /** пакеты других экосистем – без веса */
  outside: number;
  /** пакеты, чьей версии из SCA в графе уже нет (обновлены после проверки AppSec), – вне списка и суммы */
  updated: number;
  /** взвешенная сумма по всем пакетам (несопоставленные – как прямые) */
  weighted: number;
  /** граф обрезан капами или lock-файлов больше капа – сопоставление неполное */
  graph_truncated: boolean;
  /** менеджеры прочитанных lock-файлов */
  managers: string[];
}

/** Цепочка в показе – не длиннее этого (глубокая цепочка – шум, а не улика). */
export const VIA_CAP = 8;

/** Имя пакета npm/pnpm: `name` или `@scope/name` – без `/` вне скоупа и без `:` (Maven), `github.com/x/y` (Go). */
export function isNpmShapedName(name: string): boolean {
  return /^(@[^/@:\s]+\/)?[^/@:\s]+$/.test(name);
}

interface Indexed {
  graph: LockGraph;
  byName: Map<string, number[]>;
  /** кратчайшая цепочка до узла от корней: имена узлов от первой прямой до самого узла */
  chainOf: (id: number) => string[] | null;
}

const nameOf = (node: string): string => {
  const at = node.lastIndexOf("@");
  return at <= 0 ? node : node.slice(0, at);
};
const versionOf = (node: string): string | null => {
  const at = node.lastIndexOf("@");
  return at <= 0 ? null : node.slice(at + 1) || null;
};

function index(graph: LockGraph): Indexed {
  const byName = new Map<string, number[]>();
  graph.nodes.forEach((n, i) => {
    const list = byName.get(nameOf(n));
    if (list) list.push(i);
    else byName.set(nameOf(n), [i]);
  });
  const out = new Map<number, number[]>();
  for (const [from, to] of graph.edges) {
    const list = out.get(from);
    if (list) list.push(to);
    else out.set(from, [to]);
  }
  // BFS от всех корней один раз: parent[id] – откуда пришли; корни – сами себе начало
  const parent = new Map<number, number>();
  const queue: number[] = [];
  for (const r of graph.roots) {
    if (!parent.has(r)) {
      parent.set(r, -1);
      queue.push(r);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    for (const next of out.get(cur) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, cur);
      queue.push(next);
    }
  }
  const chainOf = (id: number): string[] | null => {
    if (!parent.has(id)) return null;
    const chain: string[] = [];
    let cur: number | undefined = id;
    while (cur !== undefined && cur !== -1) {
      chain.push(nameOf(graph.nodes[cur]!));
      cur = parent.get(cur);
    }
    return chain.reverse();
  };
  return { graph, byName, chainOf };
}

/**
 * Узел пакета в графе: по имени и версии; без версии в графе или в SCA – по
 * имени. `other-version` – имя в графе есть, а версии из SCA нет (обновлен).
 */
function findNode(ix: Indexed, name: string, version: string | null): number | "other-version" | null {
  const ids = ix.byName.get(name);
  if (!ids) return null;
  if (version !== null) {
    const exact = ids.find((i) => versionOf(ix.graph.nodes[i]!) === version);
    if (exact !== undefined) return exact;
  }
  const loose = ids.find((i) => versionOf(ix.graph.nodes[i]!) === null);
  if (loose !== undefined) return loose;
  return version === null ? ids[0]! : "other-version";
}

/** Экосистемы, которые описывают прочитанные lock-файлы (менеджеры npm и pnpm). */
const GRAPH_ECOSYSTEMS: ReadonlySet<string> = new Set(["npm"]);

/**
 * Отчет по уязвимым пакетам против графов lock-файлов. Пакеты сортируются по
 * вкладу (убывание), затем по имени – тот же порядок у совета и в отчете.
 */
export function matchVulnerableDependencies(sca: { packages: AppsecScaPackage[] }, lockgraph: LockGraphFactValue): DepsReport {
  const indexed = lockgraph.graphs.map(index);
  const packages: VulnerableDependency[] = [];
  let direct = 0;
  let transitive = 0;
  let unmatched = 0;
  let weighted = 0;
  let outside = 0;
  let updated = 0;
  // прочитанные графы – только npm/pnpm: экосистема из факта, если движок ее
  // назвал; у старых фактов и пакетов без метки – по форме имени
  const covered = (p: AppsecScaPackage): boolean => (typeof p.ecosystem === "string" ? GRAPH_ECOSYSTEMS.has(p.ecosystem) : isNpmShapedName(p.name));
  for (const p of sca.packages) {
    // пакет другой экосистемы граф не описывает: совпадение имени с пакетом npm
    // (requests, six) – случайность, а не сопоставление
    const inScope = covered(p);
    // первый граф, где пакет достижим от корней; узел есть, но осиротел
    // (запись lock без входящих ребер) – ищем дальше, иначе как не найден
    let found: { ix: Indexed; chain: string[] } | null = null;
    let otherVersion = false;
    for (const ix of inScope ? indexed : []) {
      const id = findNode(ix, p.name, p.version);
      if (id === null) continue;
      const chain = id === "other-version" ? null : ix.chainOf(id);
      if (chain !== null) {
        found = { ix, chain };
        break;
      }
      // версии из SCA нет (или ее узел осиротел), а пакет с этим именем в графе
      // живой (достижим от корней) – версию уже подняли
      if (p.version !== null && ix.byName.get(p.name)!.some((i) => versionOf(ix.graph.nodes[i]!) !== p.version && ix.chainOf(i) !== null)) otherVersion = true;
    }
    if (found === null && otherVersion) {
      updated++;
      continue;
    }
    const isOutside = found === null && !inScope;
    const chain = found?.chain ?? null;
    const isDirect = chain === null ? null : chain.length === 1;
    const base = SEVERITY_WEIGHTS[p.severity];
    const weight = isOutside ? 0 : isDirect === false ? base * DEPS_TRANSITIVE_WEIGHT : base;
    if (isOutside) outside++;
    else if (isDirect === null) unmatched++;
    else if (isDirect) direct++;
    else transitive++;
    weighted += weight;
    packages.push({
      name: p.name,
      version: p.version,
      severity: p.severity,
      advisories: p.advisories,
      direct: isDirect,
      outside: isOutside,
      via: isDirect === false ? chain!.slice(0, -1).slice(0, VIA_CAP) : [],
      lock: found !== null ? found.ix.graph.path : null,
      weight,
    });
  }
  packages.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  return {
    packages,
    direct,
    transitive,
    unmatched,
    outside,
    updated,
    weighted: Math.round(weighted * 1000) / 1000,
    graph_truncated: lockgraph.truncated === true || lockgraph.graphs.some((g) => g.truncated === true),
    managers: [...new Set(lockgraph.graphs.map((g) => g.manager))],
  };
}
