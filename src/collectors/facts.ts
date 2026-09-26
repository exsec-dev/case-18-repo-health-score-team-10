// facts.ts — тип факта + kinds-реестр В1 (мини) + категорийный мап.
import { deflateSync, inflateSync } from "node:zlib";
// Контракт плана В1: key = kind целиком, category = мап префикса,
// value = JSON, status ok/no-data/bad, source = канал, collected_at UTC.
// Реестр — const-словарь здесь (не отдельный файл): форма значений
// документируется на месте, В2 расширит.
export type FactStatus = "ok" | "no-data" | "bad";

/**
 * В5.3-М (Н1): версия сборщика фактов, штамп `scans.collector_version`.
 * 1 — сканы до правок М2 (`8053062`), 2 — после М2, 3 — сборщик модели
 * 4.3.0-hci (blame по sha, маркеры в комментариях, файлы тестов, задачи в
 * работе и мгновенно закрытые, открытые группы AppSec, содержимое документов),
 * 4 — сборщик модели 4.3.1-hci (В5.5 тур 1, М1: маркеры техдолга только в коде
 * вне тестов, пропущенные в тестах — аддитивным `test_markers` в `code.todo`),
 * 5 — сборщик модели 4.4.0-hci (В5.5 тур 2, ТП-1/ТП-9: аддитивные
 * `cicd.runs.recent_runs` — исход и момент последних завершенных запусков — и
 * `issues.stats.flow` — создано/закрыто по 30-дневным окнам за 180 дней; ЗН-2 —
 * новые справочные факты `activity.pr_review` и `code.ownership`, W4).
 * В старых строках — NULL («до учета», читается как старше текущего). Смена
 * формы или смысла факта — новая версия: ночная волна доочередит репо, чей
 * последний пригодный скан собран старым сборщиком (`scheduler.ts`).
 */
export const COLLECTOR_VERSION = 5;

/** no-data reason — ключ внутри value-JSON (отдельной колонки нет).
 *  В4/Б2: no-scan/incomplete — ветки AppSec (скана нет/не завершён,
 *  неполный ответ ≠ отсутствие уязвимостей). */
export type NoDataReason = "access" | "limits" | "empty" | "no-scan" | "incomplete" | "other";

export interface Fact {
  /** kind целиком, напр. "docs.presence" */
  key: string;
  /** documentation|cicd|security|activity|issues|code|meta */
  category: string;
  /** JSON-сериализуемое значение — весь доказательный слой */
  value: unknown;
  status: FactStatus;
  /** git | rest:issues | rest:pulls | rest:comments | ... */
  source: string;
  /** UTC ISO 8601 */
  collectedAt: string;
}

/** kind → категория: префикс до точки по таблице плана В1. */
const KIND_CATEGORIES: Record<string, string> = {
  docs: "documentation",
  cicd: "cicd",
  security: "security",
  appsec: "security", // appsec.findings (В4/Б2) — категория Security
  activity: "activity",
  issues: "issues",
  code: "code",
  tree: "code",
};

export function categoryOf(kind: string): string {
  const prefix = kind.split(".")[0]!;
  return KIND_CATEGORIES[prefix] ?? "meta";
}

/** Мини-реестр kinds В1+В2 (план, раздел «Контракты»). Формы значений: */
export const KINDS = {
  // булевы ok-факты; подтверждённое ОТСУТСТВИЕ файла = данные, НЕ no-data
  // content_checked (сборщик 3, Р4в): license/contributing/codeowners —
  // только файл с ≥16 непробельными символами
  "docs.presence": "{readme,license,contributing,codeowners}: boolean, content_checked?",
  // flags — словарь секций RU+EN §7.4 (install/build/test)
  "docs.readme": "{bytes,sections,flags:{install,build,test}} | {present:false} когда README нет",
  // сборщик 3, круг 2: test_files — только непустые файлы тестов (К2);
  // source_unread — файлы кода, строки которых не прочитаны (больше лимита
  // текста или бинарные, К3)
  "tree.stats": "{top_level:[{name,type}],file_count,bytes,loc,source_files?,source_loc?,test_files?,source_unread?}",
  // полный список .sourcecraft/** (канон CI-детекта) + has_ci_yaml +
  // has_steps (§7.4: ≥1 task с ≥1 непустой командой script/cube);
  // steps_note при неудачном парсинге ci.yaml
  "cicd.configs": "{paths:[...],has_ci_yaml:boolean,has_steps:boolean,steps_note?} — пустой paths = ок",
  // сборщик 5 (ТП-1): recent_runs — до 20 последних завершенных, свежие первыми
  "cicd.runs": "{last_status,success_rate,duration_p50,runs_count,green_streak,recent_runs?:[{outcome:success|failure,at}]} | no-data",
  // событийный JSON: author+committer (имя+email+дата UTC) + robot per-commit
  "activity.git.timeline": "{events:[{sha,author,committer,robot,robot_reasons}]}",
  // history_truncated_since — только у деградационного клона (§5.7)
  "activity.git.summary":
    "{commits,authors,committers,robot_commits,robot_ratio,first_committed_at,last_committed_at,history_truncated_since?}",
  // событийные даты (§7.4): топ-50 недавних pulls created_at /
  // релизов released_at desc — источник pulls_90d/releases_12m
  "activity.rest": "{contributors,releases,pulls_open,latest_release_at?,pulls_created_at:[...],releases_released_at:[...],fetched_note?}",
  // сборщик 5 (ТП-9): flow — 6 окон по 30 дней от старых к новым; окно раньше
  // complete_since (обрезка списка капом страниц) — null-счетчики
  "issues.stats":
    "{open,in_progress?,in_progress_note?,closed,closed_instant?,closed_counted?,median_close_days,stale_90d,fetched_count,flow?:{window_days,windows:[{from,created,closed,instant}],complete_since?}}",
  // сборщик 3 (Н14а): answered + censored; сборщик до 3 — with_comments
  "issues.comments_sample":
    "{issues,answered?,censored?,with_comments?,median_first_comment_delay_hours,delays_hours:[...]}",
  // семантика (сверено с кодом В1, uikit 21+6=27): count — только TODO,
  // fixme — только FIXME, older_180d — по ВСЕМ маркерам (TODO+FIXME,
  // blame-бюджет ≤ blamed_files файлов из todo_files)
  // сборщик 4 (М1, 4.3.1-hci): count/fixme/older_180d/todo_files — только код
  // вне тестов; test_markers — маркеры, пропущенные в файлах тестов
  "code.todo": "{count,fixme,older_180d,todo_files,blamed_files,test_markers?}",
  // В4/Б2 — официальный AppSec API (только агрегаты и стабильные id;
  // severity_counts классифицирует ПЛАТФОРМА именованными фильтрами,
  // числовые severity хранятся как raw без декодирования)
  "appsec.findings":
    "{severity_counts,resolved_share,secrets_critical,backlog:{open_groups,open_findings,engines,severity_raw_counts},provenance:{scan_uuid,commit_hash,time_finished,group_ids}} | no-data{reason}",
  // В5.5 тур 2 (W4, ЗН-2) — справочные (DISPLAY_ONLY), в Score не идут,
  // в READ_KINDS/PUBLIC_KINDS не входят (пригодность скана от них не зависит).
  // review и bottlenecks PR (pr-review.ts): выборка до 10 последних PR не
  // черновиков; pulls = 0 — «PR не используются» (данные); сбой выборки — bad
  "activity.pr_review":
    "{pulls,statuses,status_note?,sampled,answered,median_first_response_hours,open_sampled,waiting_over_threshold,threshold_hours,review_comments_total,median_review_comments,comments_capped,appsec_comments,decisions,merged,median_merge_hours,merge_time_basis,requests} | no-data{reason} | bad",
  // карта владельцев файлов (ownership.ts): агрегаты по верхнеуровневым
  // каталогам за 365 дней без мерджей и роботов; только имя автора, без email
  "code.ownership":
    "{window_days,threshold,commits,robot_commits_skipped,changes,single_owner_share,dirs_total,dirs_single_owner,dirs:[{dir,changes,authors,owner,owner_share}],truncated?,truncated_note?,history_since?} | bad",
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

/** Сбой канала (429/5xx/сеть): трубa, не отсутствие данных — риск-факт скана. */
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

/** kinds git-канала — для полного набора no-data при пустом/неудавшемся клоне. */
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
// В4.4 (кластер C код-аудита): компрессия timeline. Строки
// activity.git.timeline замерены до 21.9 МБ (полная история коммитов без
// капа); zlib-сжатие с префиксом `z:` + base64 режет их на порядок, чтение
// прозрачно разворачивает по префиксу — старые (несжатые) строки читаются
// как раньше. Удаления сканов/фактов НЕТ (история — В5); цена парса на
// чтении остаётся — В6-кандидат (З3 аудита). Точка записи одна —
// insertFacts (runner), точки чтения — effectiveFacts (compute) и карточка
// (repos): ни один потребитель формы значения не меняется.
// ---------------------------------------------------------------------------

/** Крупный факт, хранимый сжатым (единственный в реестре). */
export const TIMELINE_KIND = "activity.git.timeline";

/** Префикс сжатого значения в facts.value. */
export const FACT_Z_PREFIX = "z:";

/** Сериализация значения факта для БД; timeline сжимается ТОЛЬКО при статусе
 *  ok (круг 2 В4.4: no-data значение — маленький plain JSON, сжатие не нужно,
 *  а его сырые читатели — gitLimitsHit и json_extract в ratingEligibleSql —
 *  на `z:` отдают 500 и крэш стартового рескора). Вызов без статуса (старые
 *  callers и тесты) ведёт себя как в круге 1 — жмёт. */
export function encodeFactValue(kind: string, value: unknown, status?: FactStatus): string {
  const json = JSON.stringify(value);
  if (kind !== TIMELINE_KIND) return json;
  if (status === "no-data" || status === "bad") return json;
  return FACT_Z_PREFIX + Buffer.from(deflateSync(json, { level: 6 })).toString("base64");
}

/** Прозрачное чтение facts.value: сжатое (префикс) разворачивается, старое парсится как было.
 *  Прод-7 (круг 2): битое сжатое значение — мусорный ввод, поверхность не роняет;
 *  читатели трактуют его как no-data с общей причиной `other`. */
export function parseFactValue(raw: string): unknown {
  if (!raw.startsWith(FACT_Z_PREFIX)) return JSON.parse(raw);
  try {
    return JSON.parse(inflateSync(Buffer.from(raw.slice(FACT_Z_PREFIX.length), "base64")).toString("utf8"));
  } catch {
    return { reason: "other" };
  }
}

/**
 * М2.7 аудита В5.3: текст сбоя без путей машины сервиса — временный клон
 * (`…/rh-clone-XXXX`) и прочие абсолютные пути заменяются меткой. Причина
 * сбоя видна пользователю в «Исходных данных» карточки и отчета.
 */
export function scrubDetail(detail: string): string {
  return detail
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"()]*rh-clone-[^\s'"()]*/g, "<временный клон>")
    .replace(/[A-Za-z]:\\[^\s'"()]+/g, "<путь>")
    .replace(/(?<![\w.])\/(?:tmp|var|home|root|Users)\/[^\s'"()]+/g, "<путь>");
}
