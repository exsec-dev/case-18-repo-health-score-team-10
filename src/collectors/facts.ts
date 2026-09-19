// facts.ts — тип факта + kinds-реестр В1 (мини) + категорийный мап.
import { deflateSync, inflateSync } from "node:zlib";
// Контракт плана В1: key = kind целиком, category = мап префикса,
// value = JSON, status ok/no-data/bad, source = канал, collected_at UTC.
// Реестр — const-словарь здесь (не отдельный файл): форма значений
// документируется на месте, В2 расширит.
export type FactStatus = "ok" | "no-data" | "bad";

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
  "docs.presence": "{readme,license,contributing,codeowners}: boolean",
  // flags — словарь секций RU+EN §7.4 (install/build/test)
  "docs.readme": "{bytes,sections,flags:{install,build,test}} | {present:false} когда README нет",
  "tree.stats": "{top_level:[{name,type}],file_count,bytes,loc}",
  // полный список .sourcecraft/** (канон CI-детекта) + has_ci_yaml +
  // has_steps (§7.4: ≥1 task с ≥1 непустой командой script/cube);
  // steps_note при неудачном парсинге ci.yaml
  "cicd.configs": "{paths:[...],has_ci_yaml:boolean,has_steps:boolean,steps_note?} — пустой paths = ок",
  "cicd.runs": "{last_status,success_rate,duration_p50,runs_count} | no-data",
  // событийный JSON: author+committer (имя+email+дата UTC) + robot per-commit
  "activity.git.timeline": "{events:[{sha,author,committer,robot,robot_reasons}]}",
  // history_truncated_since — только у деградационного клона (§5.7)
  "activity.git.summary":
    "{commits,authors,committers,robot_commits,robot_ratio,first_committed_at,last_committed_at,history_truncated_since?}",
  // событийные даты (§7.4): топ-50 недавних pulls created_at /
  // релизов released_at desc — источник pulls_90d/releases_12m
  "activity.rest": "{contributors,releases,pulls_open,latest_release_at?,pulls_created_at:[...],releases_released_at:[...],fetched_note?}",
  "issues.stats":
    "{open,closed,median_close_days,stale_90d,fetched_count}",
  "issues.comments_sample":
    "{issues,with_comments,median_first_comment_delay_hours,delays_hours:[...]}",
  // семантика (сверено с кодом В1, uikit 21+6=27): count — только TODO,
  // fixme — только FIXME, older_180d — по ВСЕМ маркерам (TODO+FIXME,
  // blame-бюджет ≤ blamed_files файлов из todo_files)
  "code.todo": "{count,fixme,older_180d,todo_files,blamed_files}",
  // В4/Б2 — официальный AppSec API (только агрегаты и стабильные id;
  // severity_counts классифицирует ПЛАТФОРМА именованными фильтрами,
  // числовые severity хранятся как raw без декодирования)
  "appsec.findings":
    "{severity_counts,resolved_share,secrets_critical,backlog:{open_groups,open_findings,engines,severity_raw_counts},provenance:{scan_uuid,commit_hash,time_finished,group_ids}} | no-data{reason}",
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

/** Сериализация значения факта для БД; timeline — zlib+base64 с префиксом. */
export function encodeFactValue(kind: string, value: unknown): string {
  const json = JSON.stringify(value);
  if (kind !== TIMELINE_KIND) return json;
  return FACT_Z_PREFIX + Buffer.from(deflateSync(json, { level: 6 })).toString("base64");
}

/** Прозрачное чтение facts.value: сжатое (префикс) разворачивается, старое парсится как было. */
export function parseFactValue(raw: string): unknown {
  if (!raw.startsWith(FACT_Z_PREFIX)) return JSON.parse(raw);
  return JSON.parse(inflateSync(Buffer.from(raw.slice(FACT_Z_PREFIX.length), "base64")).toString("utf8"));
}
