// Факт – единица данных скана: key = kind целиком, category – по префиксу kind,
// value = JSON, status ok/no-data/bad, source = канал, collectedAt в UTC.
// Здесь же реестр kinds с описанием формы значений.
import { deflateSync, inflateSync } from "node:zlib";
export type FactStatus = "ok" | "no-data" | "bad";

/**
 * Версия сборщика фактов, штамп `scans.collector_version`. Смена формы или
 * смысла факта – новая версия: ночная волна доочередит репо, чей последний
 * пригодный скан собран старым сборщиком (`scheduler.ts`). NULL в старых
 * строках читается как версия старше текущей.
 */
export const COLLECTOR_VERSION = 7;

/** Причина no-data хранится ключом `reason` внутри value (отдельной колонки нет).
 *  no-scan и incomplete – ветки AppSec: скана нет или не завершен; неполный
 *  ответ не означает отсутствие уязвимостей. */
export type NoDataReason = "access" | "limits" | "empty" | "no-scan" | "incomplete" | "other";

export interface Fact {
  /** kind целиком, напр. "docs.presence" */
  key: string;
  /** documentation|cicd|security|activity|issues|code|meta */
  category: string;
  /** JSON-сериализуемое значение – весь доказательный слой */
  value: unknown;
  status: FactStatus;
  /** git | rest:issues | rest:pulls | rest:comments | ... */
  source: string;
  /** UTC ISO 8601 */
  collectedAt: string;
}

/** kind → категория по префиксу до точки; неизвестный префикс – meta. */
const KIND_CATEGORIES: Record<string, string> = {
  docs: "documentation",
  cicd: "cicd",
  security: "security",
  appsec: "security",
  activity: "activity",
  issues: "issues",
  code: "code",
  tree: "code",
};

export function categoryOf(kind: string): string {
  const prefix = kind.split(".")[0]!;
  return KIND_CATEGORIES[prefix] ?? "meta";
}

/** Реестр kinds и форма их значений. */
export const KINDS = {
  // подтвержденное отсутствие файла – данные, а не no-data;
  // content_checked: license/contributing/codeowners засчитываются, только если
  // в файле не меньше 16 непробельных символов
  "docs.presence": "{readme,license,contributing,codeowners}: boolean, content_checked?",
  // flags – найденные секции README на русском и английском
  "docs.readme": "{bytes,sections,flags:{install,build,test}} | {present:false} когда README нет",
  // test_files – только непустые файлы тестов; source_unread – файлы кода,
  // строки которых не прочитаны (больше лимита текста или бинарные)
  "tree.stats": "{top_level:[{name,type}],file_count,bytes,loc,source_files?,source_loc?,test_files?,source_unread?}",
  // полный список .sourcecraft/** (по нему определяется CI); has_steps –
  // есть task хотя бы с одной непустой командой script/cube;
  // steps_note – если ci.yaml не разобрался
  "cicd.configs": "{paths:[...],has_ci_yaml:boolean,has_steps:boolean,steps_note?} — пустой paths = ок",
  // recent_runs – до 20 последних завершенных запусков, свежие первыми
  "cicd.runs": "{last_status,success_rate,duration_p50,runs_count,green_streak,recent_runs?:[{outcome:success|failure,at}]} | no-data",
  // по событию на коммит: автор и коммитер (имя, email, дата UTC) и признак робота
  "activity.git.timeline": "{events:[{sha,author,committer,robot,robot_reasons}]}",
  // history_truncated_since – только у усеченного клона
  "activity.git.summary":
    "{commits,authors,committers,robot_commits,robot_ratio,first_committed_at,last_committed_at,history_truncated_since?}",
  // даты 50 последних PR и релизов – из них считаются pulls_90d и releases_12m
  "activity.rest": "{contributors,releases,pulls_open,latest_release_at?,pulls_created_at:[...],releases_released_at:[...],fetched_note?}",
  // flow – 6 окон по 30 дней от старых к новым; окна раньше complete_since
  // (список обрезан лимитом страниц) получают null-счетчики
  "issues.stats":
    "{open,in_progress?,in_progress_note?,closed,closed_instant?,closed_counted?,median_close_days,stale_90d,fetched_count,flow?:{window_days,windows:[{from,created,closed,instant}],complete_since?}}",
  // старые сканы вместо answered/censored пишут with_comments
  "issues.comments_sample":
    "{issues,answered?,censored?,with_comments?,median_first_comment_delay_hours,delays_hours:[...]}",
  // count – только TODO, fixme – только FIXME, older_180d – по всем маркерам
  // (blame не больше чем по blamed_files файлам из todo_files); все счетчики –
  // по коду вне тестов, маркеры в тестах – отдельно в test_markers
  "code.todo": "{count,fixme,older_180d,todo_files,blamed_files,test_markers?}",
  // официальный AppSec API: только агрегаты и стабильные id; severity_counts
  // классифицирует платформа именованными фильтрами, числовые severity
  // хранятся как есть
  // sca – уязвимые пакеты по группам type=SCA (имя@версия из codeBlock, корзина
  // критичности платформы, движки); null с sca_note – корзины SCA не ответили
  "appsec.findings":
    "{severity_counts,resolved_share,secrets_critical,backlog:{open_groups,open_findings,engines,severity_raw_counts},provenance:{scan_uuid,commit_hash,time_finished,group_ids},sca?:{packages:[{name,version,severity,advisories,engines}],groups,unparsed,truncated?}|null,sca_note?} | no-data{reason}",
  // два справочных факта ниже в Score не идут и в READ_KINDS/PUBLIC_KINDS не
  // входят – пригодность скана от них не зависит.
  // Ревью PR (pr-review.ts): выборка до 10 последних PR, не черновиков;
  // pulls = 0 – «PR не используются» (это данные); сбой выборки – bad
  "activity.pr_review":
    "{pulls,statuses,status_note?,sampled,answered,median_first_response_hours,open_sampled,waiting_over_threshold,threshold_hours,review_comments_total,median_review_comments,comments_capped,appsec_comments,decisions,merged,median_merge_hours,merge_time_basis,requests} | no-data{reason} | bad",
  // карта владельцев файлов (ownership.ts): агрегаты по верхнеуровневым
  // каталогам за 365 дней без мерджей и роботов; только имя автора, без email
  "code.ownership":
    "{window_days,threshold,commits,robot_commits_skipped,changes,single_owner_share,dirs_total,dirs_single_owner,dirs:[{dir,changes,authors,owner,owner_share,top_authors:[{name,share}],children?:[{dir,changes,authors,owner,owner_share,top_authors}]}],truncated?,truncated_note?,history_since?} | bad",
  // зависимости из манифестов (deps.ts) – только для тематики рейтинга
  // (api/topics.ts); в Score не идет, в READ_KINDS/GIT_KINDS не входит,
  // без манифестов факта нет вовсе
  "tree.deps": "{manifests:[...],deps:[...],truncated?}",
  // граф зависимостей из lock-файлов (lockgraph.ts): узлы name@version, корни и
  // ребра индексами. Читает только «Безопасность» (подметрика уязвимых
  // зависимостей, OPTIONAL_KINDS в compute); в READ_KINDS/PUBLIC_KINDS не входит:
  // без lock-файла факта нет, и это не делает скан неполным
  "tree.lockgraph": "{graphs:[{path,manager,lock_version,nodes:[...],roots:[...],edges:[[from,to]],truncated?}],truncated?}",
} as const;

export type Kind = keyof typeof KINDS;

export function okFact(kind: Kind | string, value: unknown, source: string, collectedAt = new Date().toISOString()): Fact {
  return { key: kind, category: categoryOf(kind), value, status: "ok", source, collectedAt };
}

export function noDataFact(
  kind: Kind | string,
  reason: NoDataReason,
  source: string,
  detail?: string,
  collectedAt = new Date().toISOString(),
): Fact {
  const value: Record<string, unknown> = { reason };
  if (detail !== undefined) value.detail = detail;
  return { key: kind, category: categoryOf(kind), value, status: "no-data", source, collectedAt };
}

/** Сбой канала (429/5xx/сеть) – проблема доставки, а не отсутствие данных. */
export function badChannelFact(
  kind: Kind | string,
  source: string,
  detail?: string,
  collectedAt = new Date().toISOString(),
): Fact {
  const value: Record<string, unknown> = { reason: "bad-channel" };
  if (detail !== undefined) value.detail = detail;
  return { key: kind, category: categoryOf(kind), value, status: "bad", source, collectedAt };
}

/** kinds git-канала – для полного набора no-data при пустом или неудавшемся клоне. */
export const GIT_KINDS: string[] = [
  "activity.git.timeline",
  "activity.git.summary",
  "docs.presence",
  "docs.readme",
  "tree.stats",
  "cicd.configs",
  "code.todo",
];

// ---------------------------------------------------------------------------
// Сжатие timeline. Значение activity.git.timeline – вся история коммитов, до
// десятков мегабайт; zlib + base64 с префиксом `z:` уменьшает его на порядок.
// Чтение разворачивает по префиксу, несжатые старые строки читаются как есть.
// Пишет одно место – insertFacts (runner), читают effectiveFacts (compute) и
// карточка (repos); форма значения для них не меняется.
// ---------------------------------------------------------------------------

/** Факт ленты коммитов – хранится сжатым. */
export const TIMELINE_KIND = "activity.git.timeline";
/** Сжатые факты: лента коммитов и граф lock-файлов (тысячи узлов и ребер). */
export const COMPRESSED_KINDS: ReadonlySet<string> = new Set([TIMELINE_KIND, "tree.lockgraph"]);

export const FACT_Z_PREFIX = "z:";

/** Сериализация значения факта для БД. Timeline сжимается только при статусе
 *  ok: no-data значение маленькое, а его читают сырым (gitLimitsHit и
 *  json_extract в ratingEligibleSql), и `z:` их сломал бы. Без статуса – жмет. */
export function encodeFactValue(kind: string, value: unknown, status?: FactStatus): string {
  const json = JSON.stringify(value);
  if (!COMPRESSED_KINDS.has(kind)) return json;
  if (status === "no-data" || status === "bad") return json;
  return FACT_Z_PREFIX + Buffer.from(deflateSync(json, { level: 6 })).toString("base64");
}

/** Чтение facts.value: сжатое разворачивается, остальное парсится как JSON.
 *  Битое сжатое значение не роняет страницу – читатели видят его как no-data
 *  с причиной `other`. */
export function parseFactValue(raw: string): unknown {
  if (!raw.startsWith(FACT_Z_PREFIX)) return JSON.parse(raw);
  try {
    return JSON.parse(inflateSync(Buffer.from(raw.slice(FACT_Z_PREFIX.length), "base64")).toString("utf8"));
  } catch {
    return { reason: "other" };
  }
}

/**
 * Убирает из текста сбоя пути машины сервиса: временный клон
 * (`…/rh-clone-XXXX`) и прочие абсолютные пути заменяются меткой. Причина
 * сбоя видна пользователю в «Исходных данных» карточки и отчета.
 */
export function scrubDetail(detail: string): string {
  return detail
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"()]*rh-clone-[^\s'"()]*/g, "<временный клон>")
    .replace(/[A-Za-z]:\\[^\s'"()]+/g, "<путь>")
    .replace(/(?<![\w.])\/(?:tmp|var|home|root|Users)\/[^\s'"()]+/g, "<путь>");
}
