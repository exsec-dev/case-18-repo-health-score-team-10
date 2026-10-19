// Карта владельцев файлов – справочный показатель категории
// «Состояние кода» без веса: индекс, Score, покрытие и рекомендации от него не
// зависят.
//
// Вход – `git log --no-merges --name-only` bare-клона за OWNERSHIP_WINDOW_DAYS.
// Код не храним: в факт идут только агрегаты по каталогам верхнего уровня и
// их подкаталогам (второй уровень – для дерева на карточке), без путей файлов
// и кода.
// Единица изменения – «коммит тронул файл кода» (`isSourcePath`), а не строки:
// большие сгенерированные диффы не перевешивают.
// Коммиты роботов и всплески синхронизации исключаются по sha через признак
// `robot2` – тот же, что у bus factor и частоты коммитов (старый флаг `robot`
// в timeline расчет не использует).
// Окно считается по дате автора, как у bus factor: импорт зеркала со свежей
// датой коммитера не превращает старую историю в «изменения за год».
//
// Приватность: человек различается по email, но в факт и на экран идет только
// отображаемое имя из git; email – никогда (имя, похожее на email, маскируется).
import { isSourcePath } from "./source-path";

export const OWNERSHIP_WINDOW_DAYS = 365;
/** Порог «единственного владельца»: доля изменений главного автора каталога. */
export const OWNERSHIP_SINGLE_OWNER_SHARE = 0.8;
/** Сколько самых изменяемых каталогов попадает в карту. */
export const OWNERSHIP_TOP_DIRS = 10;
/** Сколько самых изменяемых подкаталогов у каталога карты (ветви дерева). */
export const OWNERSHIP_TOP_SUBDIRS = 5;
/** Сколько главных авторов каталога с долями попадает в факт (полоса долей на карточке). */
export const OWNERSHIP_TOP_AUTHORS = 3;
/** Бюджет обхода в коммитах (свежие первыми); сверх него – обрезка с пометкой. */
export const OWNERSHIP_MAX_COMMITS = 5000;
/** Бюджет обхода в изменениях «коммит × файл»; сверх него – обрезка с пометкой. */
export const OWNERSHIP_MAX_CHANGES = 100_000;
/** Корзина для файлов в корне репозитория. */
export const OWNERSHIP_ROOT = ".";

/** Разделители записей и полей – как у timeline. */
export const OWNERSHIP_LOG_FORMAT = "%x1e%H%x1f%an%x1f%ae%x1f%aI";

export interface OwnershipCommit {
  sha: string;
  name: string;
  email: string;
  authorDate: string;
  paths: string[];
}

/** Путь из вывода `--name-only`: с `core.quotepath=off` кавычки остаются только у путей со спецсимволами. */
function unquotePath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  }
  return raw;
}

export function parseOwnershipLog(stdout: string): OwnershipCommit[] {
  const out: OwnershipCommit[] = [];
  for (const rec of stdout.split("\x1e")) {
    if (!rec.trim()) continue;
    const lines = rec.split("\n");
    const [sha, name, email, date] = (lines[0] ?? "").split("\x1f");
    if (!sha) continue;
    const paths = lines
      .slice(1)
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l !== "")
      .map(unquotePath);
    out.push({ sha: sha.trim(), name: name ?? "", email: email ?? "", authorDate: date ?? "", paths });
  }
  return out;
}

const EMAIL_LIKE = /<?[^\s<>@]+@[^\s<>@]+>?/g;

/** Имя автора без email: адрес вырезается, пустое имя – «(имя не указано)». */
export function displayAuthorName(name: string): string {
  const clean = name.replace(EMAIL_LIKE, "").replace(/\s+/g, " ").trim();
  return clean === "" ? "(имя не указано)" : clean;
}

/** Верхнеуровневый каталог пути; файл в корне – OWNERSHIP_ROOT. */
export function topDir(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : OWNERSHIP_ROOT;
}

/** Подкаталог второго уровня («apps/web»); файл прямо в каталоге верхнего уровня или в корне – null. */
export function subDir(path: string): string | null {
  const parts = path.split("/");
  return parts.length >= 3 && parts[0] !== "" && parts[1] !== "" ? `${parts[0]}/${parts[1]}` : null;
}

export interface OwnershipOptions {
  now: Date;
  /** sha коммитов роботов и синхронизации (robot2 из timeline) */
  excluded: Set<string>;
  /** коммитов в логе было больше бюджета (git log вернул OWNERSHIP_MAX_COMMITS + 1) */
  commitsTruncated?: boolean;
  /** дата, с которой начинается усеченный клон, – окно могло не накрыть год */
  historyTruncatedSince?: string;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Значение факта `code.ownership`. */
export function aggregateOwnership(commits: OwnershipCommit[], opts: OwnershipOptions): Record<string, unknown> {
  const from = opts.now.getTime() - OWNERSHIP_WINDOW_DAYS * 86_400_000;
  const until = opts.now.getTime() + 86_400_000;
  // каталог → ключ автора → изменений; ключ автора → имя (самое частое)
  const byDir = new Map<string, Map<string, number>>();
  const bySub = new Map<string, Map<string, number>>();
  const names = new Map<string, Map<string, number>>();
  let changes = 0;
  let counted = 0;
  let robotSkipped = 0;
  let changesTruncated = false;
  for (const c of commits) {
    const at = Date.parse(c.authorDate);
    if (Number.isNaN(at) || at < from || at > until) continue;
    if (opts.excluded.has(c.sha)) {
      robotSkipped++;
      continue;
    }
    const code = c.paths.filter(isSourcePath);
    if (code.length === 0) continue;
    const key = (c.email || c.name).toLowerCase();
    if (key === "") continue;
    counted++;
    const nm = names.get(key) ?? new Map<string, number>();
    nm.set(c.name, (nm.get(c.name) ?? 0) + 1);
    names.set(key, nm);
    for (const p of code) {
      if (changes >= OWNERSHIP_MAX_CHANGES) {
        changesTruncated = true;
        break;
      }
      const dir = topDir(p);
      const m = byDir.get(dir) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + 1);
      byDir.set(dir, m);
      const sub = subDir(p);
      if (sub !== null) {
        const sm = bySub.get(sub) ?? new Map<string, number>();
        sm.set(key, (sm.get(key) ?? 0) + 1);
        bySub.set(sub, sm);
      }
      changes++;
    }
    if (changesTruncated) break;
  }
  const nameOf = (key: string): string => {
    const nm = names.get(key);
    const best = nm ? [...nm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" : "";
    return displayAuthorName(best);
  };
  const entry = (dir: string, authors: Map<string, number>) => {
    const total = [...authors.values()].reduce((s, n) => s + n, 0);
    const ranked = [...authors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [ownerKey, ownerN] = ranked[0]!;
    // доли главных авторов — для полосы долей; остальные — остатком «другие»
    const top_authors = ranked.slice(0, OWNERSHIP_TOP_AUTHORS).map(([k, n]) => ({ name: nameOf(k), share: round3(n / total) }));
    return { dir, changes: total, authors: authors.size, owner: nameOf(ownerKey), owner_share: round3(ownerN / total), top_authors };
  };
  const byChanges = (a: { changes: number; dir: string }, b: { changes: number; dir: string }): number => b.changes - a.changes || a.dir.localeCompare(b.dir);
  const dirs = [...byDir.entries()].map(([dir, authors]) => entry(dir, authors));
  dirs.sort(byChanges);
  // ветви дерева: самые изменяемые подкаталоги каталога карты (имя – последняя часть пути)
  const childrenOf = (dir: string) =>
    [...bySub.entries()]
      .filter(([sub]) => sub.startsWith(`${dir}/`))
      .map(([sub, authors]) => entry(sub.slice(dir.length + 1), authors))
      .sort(byChanges)
      .slice(0, OWNERSHIP_TOP_SUBDIRS);
  const singleChanges = dirs.filter((d) => d.owner_share >= OWNERSHIP_SINGLE_OWNER_SHARE).reduce((s, d) => s + d.changes, 0);
  const truncated = opts.commitsTruncated ? "commits" : changesTruncated ? "changes" : null;
  return {
    window_days: OWNERSHIP_WINDOW_DAYS,
    threshold: OWNERSHIP_SINGLE_OWNER_SHARE,
    commits: counted,
    robot_commits_skipped: robotSkipped,
    changes,
    // доля изменений кода в каталогах с единственным владельцем; null, если за
    // окно код не меняли – сам этот факт виден по changes = 0
    single_owner_share: changes > 0 ? round3(singleChanges / changes) : null,
    dirs_total: dirs.length,
    dirs_single_owner: dirs.filter((d) => d.owner_share >= OWNERSHIP_SINGLE_OWNER_SHARE).length,
    dirs: dirs.slice(0, OWNERSHIP_TOP_DIRS).map((d) => {
      const children = d.dir === OWNERSHIP_ROOT ? [] : childrenOf(d.dir);
      return children.length > 0 ? { ...d, children } : d;
    }),
    ...(truncated ? { truncated, truncated_note: truncated === "commits" ? `only the latest ${OWNERSHIP_MAX_COMMITS} commits analysed` : `only the first ${OWNERSHIP_MAX_CHANGES} file changes analysed` } : {}),
    ...(opts.historyTruncatedSince && Date.parse(opts.historyTruncatedSince) > from ? { history_since: opts.historyTruncatedSince } : {}),
  };
}
