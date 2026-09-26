// ownership.ts — В5.5 тур 2, W4 (ТЗ §7, ЗН-2): карта владельцев файлов.
// Справочный показатель категории «Состояние кода» (DISPLAY_ONLY, без веса):
// индекс, полный Score, покрытие и рекомендации от него не зависят.
//
// Вход — `git log --no-merges --name-only` bare-клона за OWNERSHIP_WINDOW_DAYS
// (клон живет только на время скана; закон 3 «код не храним» — в факт идут
// одни агрегаты по верхнеуровневым каталогам, ни путей файлов, ни кода).
// Единица изменения — «коммит тронул файл кода» (`isSourcePath`: без
// документов, lock-файлов и картинок, как строки кода М2.3): большие
// сгенерированные диффы не перевешивают, как было бы у счета строк.
// Коммиты роботов и сгенерированных всплесков синхронизации исключаются по
// sha — признак `robot2` (та же истина, что у bus factor и частоты коммитов;
// флаг `robot` v1 в timeline расчет игнорирует, AGENTS.md 23.09 «флаг по имени»).
// Окно — по дате автора (как bus factor): импорт зеркала со свежей датой
// коммитера не делает старую историю «изменениями за год».
//
// Приватность: человек — ключ по email (как bus factor и число авторов), но в
// факт и на экран идет только отображаемое имя из git; email — никогда (имя,
// похожее на email, маскируется).
import { isSourcePath } from "./source-path";

/** Окно изменений, дней. */
export const OWNERSHIP_WINDOW_DAYS = 365;
/** Порог «единственного владельца»: доля изменений главного автора каталога. */
export const OWNERSHIP_SINGLE_OWNER_SHARE = 0.8;
/** Каталогов в карте — самых изменяемых. */
export const OWNERSHIP_TOP_DIRS = 10;
/** Бюджет обхода: коммитов (свежие первыми; больше — обрезка с пометкой). */
export const OWNERSHIP_MAX_COMMITS = 5000;
/** Бюджет обхода: изменений «коммит × файл» (больше — обрезка с пометкой). */
export const OWNERSHIP_MAX_CHANGES = 100_000;
/** Имя корзины файлов в корне репозитория. */
export const OWNERSHIP_ROOT = ".";

/** Разделители записи `git log --format` (как у timeline). */
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

/** Разбор `git log --format=OWNERSHIP_LOG_FORMAT --name-only`. */
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

/** Отображаемое имя автора без email: имя-адрес маскируется, пустое — «(имя не указано)». */
export function displayAuthorName(name: string): string {
  const clean = name.replace(EMAIL_LIKE, "").replace(/\s+/g, " ").trim();
  return clean === "" ? "(имя не указано)" : clean;
}

/** Верхнеуровневый каталог пути; файл в корне — корзина OWNERSHIP_ROOT. */
export function topDir(path: string): string {
  const i = path.indexOf("/");
  return i > 0 ? path.slice(0, i) : OWNERSHIP_ROOT;
}

export interface OwnershipOptions {
  now: Date;
  /** sha, исключенные как робот или синхронизация (robot2 по timeline) */
  excluded: Set<string>;
  /** коммитов в логе было больше бюджета (git log вернул OWNERSHIP_MAX_COMMITS + 1) */
  commitsTruncated?: boolean;
  /** дата отсечения деградационного клона — окно могло не накрыть год */
  historyTruncatedSince?: string;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Значение факта `code.ownership` (чистая функция: тестируется на данных). */
export function aggregateOwnership(commits: OwnershipCommit[], opts: OwnershipOptions): Record<string, unknown> {
  const from = opts.now.getTime() - OWNERSHIP_WINDOW_DAYS * 86_400_000;
  const until = opts.now.getTime() + 86_400_000;
  // каталог → ключ автора → изменений; ключ автора → имя (самое частое)
  const byDir = new Map<string, Map<string, number>>();
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
      changes++;
    }
    if (changesTruncated) break;
  }
  const nameOf = (key: string): string => {
    const nm = names.get(key);
    const best = nm ? [...nm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "" : "";
    return displayAuthorName(best);
  };
  const dirs = [...byDir.entries()].map(([dir, authors]) => {
    const total = [...authors.values()].reduce((s, n) => s + n, 0);
    const [ownerKey, ownerN] = [...authors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    return { dir, changes: total, authors: authors.size, owner: nameOf(ownerKey), owner_share: round3(ownerN / total) };
  });
  dirs.sort((a, b) => b.changes - a.changes || a.dir.localeCompare(b.dir));
  const singleChanges = dirs.filter((d) => d.owner_share >= OWNERSHIP_SINGLE_OWNER_SHARE).reduce((s, d) => s + d.changes, 0);
  const truncated = opts.commitsTruncated ? "commits" : changesTruncated ? "changes" : null;
  return {
    window_days: OWNERSHIP_WINDOW_DAYS,
    threshold: OWNERSHIP_SINGLE_OWNER_SHARE,
    commits: counted,
    robot_commits_skipped: robotSkipped,
    changes,
    // доля изменений кода за окно в каталогах с единственным владельцем;
    // изменений нет — null при changes = 0 (данные «кода за год не меняли»)
    single_owner_share: changes > 0 ? round3(singleChanges / changes) : null,
    dirs_total: dirs.length,
    dirs_single_owner: dirs.filter((d) => d.owner_share >= OWNERSHIP_SINGLE_OWNER_SHARE).length,
    dirs: dirs.slice(0, OWNERSHIP_TOP_DIRS),
    ...(truncated ? { truncated, truncated_note: truncated === "commits" ? `only the latest ${OWNERSHIP_MAX_COMMITS} commits analysed` : `only the first ${OWNERSHIP_MAX_CHANGES} file changes analysed` } : {}),
    ...(opts.historyTruncatedSince && Date.parse(opts.historyTruncatedSince) > from ? { history_since: opts.historyTruncatedSince } : {}),
  };
}
