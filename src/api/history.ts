// history.ts — история оценки и история LLM-взглядов (В5, К5.7/К5.16).
// Проекция из строк scores + scans.head_sha, новых сборов нет. Публичная
// часть (индекс и покрытие) — всем; полный Score — только зрителю с правами
// на полный Score (как на карточке). Tri-state: точка без числа — честная
// NULL-точка, не ноль. Тексты AI — никогда не публичны (решение 22.09).
import type { Database } from "bun:sqlite";
import { parseFactValue } from "../collectors/facts";
import { MODEL_VERSION } from "../score/model";
import { totalsFromCategories, type CategoryScore } from "../score/compute";
import { NO_PAT_ACCESS, type AccessResult } from "../auth/access";

import type { AiNoteHistoryItem, AiNotesResponse, HistoryPoint, HistoryResponse } from "../summary/history-contract";

export type { AiNoteHistoryItem, AiNotesResponse, HistoryPoint, HistoryResponse };

interface ScoreHistoryRow {
  scan_id: number;
  healthcraft_index: number | null;
  index_coverage: number;
  categories: string;
  code_empty: number | null;
  derived: string | null;
  finished_at: string | null;
  head_sha: string | null;
}

function secretsCriticalOf(db: Database, scanId: number): boolean {
  const row = db.query("SELECT value, status FROM facts WHERE scan_id = ? AND key = 'appsec.findings'").get(scanId) as
    | { value: string; status: string }
    | null;
  if (!row || row.status !== "ok") return false;
  return (parseFactValue(row.value) as { secrets_critical?: unknown } | null)?.secrets_critical === true;
}

function totalsOf(db: Database, row: ScoreHistoryRow): { score: number | null; coverage: number } {
  const cats = JSON.parse(row.categories) as Record<string, CategoryScore>;
  // кап критичных секретов применяется тем же правилом, что и при скане:
  // флаг читается из фактов ЭТОГО скана — исторический итог не переписывается
  const totals = totalsFromCategories(cats as never, { codeEmpty: row.code_empty === 1, secretsCritical: secretsCriticalOf(db, row.scan_id) });
  return { score: totals.repoHealthScore, coverage: totals.repoHealthCoverage };
}

/**
 * Публичная проекция истории: строки текущей MODEL_VERSION (честное
 * ограничение: оценка сопоставима только внутри одной версии модели),
 * по возрастанию сканов. null = репо не видно (404 неотличимо).
 */
export function getRepoHistory(db: Database, org: string, repo: string, opts: { access?: AccessResult } = {}): HistoryResponse | null {
  const r = db
    .query("SELECT id, rating_active, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?")
    .get(org, repo) as { id: number; rating_active: number; visibility: string } | null;
  if (!r) return null;
  if (r.visibility === "public" ? r.rating_active !== 1 : (opts.access ?? NO_PAT_ACCESS).repo !== "granted") return null;
  const access = opts.access ?? NO_PAT_ACCESS;
  const fullOpen = access.cicd === "granted" && access.appsec === "granted";
  const rows = db
    .query(
      `SELECT sc.scan_id, sc.healthcraft_index, sc.index_coverage, sc.categories, sc.code_empty, sc.derived,
              s.finished_at, s.head_sha
       FROM scores sc JOIN scans s ON s.id = sc.scan_id
       WHERE sc.repo_id = ? AND sc.model_version = ?
       ORDER BY sc.scan_id ASC`,
    )
    .all(r.id, MODEL_VERSION) as ScoreHistoryRow[];
  const points: HistoryPoint[] = rows.map((row) => {
    // полный итог — из записанных категорий этой строки и её же фактов
    // (тот же дериватив, что на карточке); не fullOpen → null
    const { score } = fullOpen ? totalsOf(db, row) : { score: null };
    return {
      scanId: row.scan_id,
      finishedAt: row.finished_at,
      healthcraftIndex: row.healthcraft_index,
      indexCoverage: row.index_coverage,
      repoHealthScore: score === null ? null : Math.round(score * 10) / 10,
      modelVersion: MODEL_VERSION,
      headSha: row.head_sha,
    };
  });
  return { points, modelVersion: MODEL_VERSION, fullOpen };
}

// ---------- история LLM-взглядов (К5.16) ----------

/**
 * История взглядов: append-строки ai_notes по всем сканам (пользователь
 * видит эволюцию). В5.1 (Прод-З2): LIMIT последних 50 строк — append-лог
 * растёт линейно со сканами, неограниченная выдача не нужна никому.
 * ВИДИМОСТЬ: репо не видно → null (404); видно, но полный Score закрыт →
 * locked (текст не публичен, решение 22.09).
 */
export function getAiNotesHistory(db: Database, org: string, repo: string, opts: { access?: AccessResult } = {}): AiNotesResponse | null {
  const r = db
    .query("SELECT id, rating_active, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?")
    .get(org, repo) as { id: number; rating_active: number; visibility: string } | null;
  if (!r) return null;
  if (r.visibility === "public" ? r.rating_active !== 1 : (opts.access ?? NO_PAT_ACCESS).repo !== "granted") return null;
  const access = opts.access ?? NO_PAT_ACCESS;
  if (!(access.cicd === "granted" && access.appsec === "granted")) {
    return { locked: true, reason: "AI-текст не является публичным – он виден только зрителям с правами на полный Score" };
  }
  const rows = db
    .query(
      `SELECT n.scan_id, n.role, n.text, n.fact_refs, n.charter_version, n.model, n.created_at, s.head_sha, s.finished_at
       FROM ai_notes n JOIN scans s ON s.id = n.scan_id
       WHERE n.repo_id = ?
       ORDER BY n.scan_id DESC, n.id DESC
       LIMIT 50`,
    )
    .all(r.id) as { scan_id: number; role: string; text: string; fact_refs: string; charter_version: string; model: string; created_at: string; head_sha: string | null; finished_at: string | null }[];
  rows.reverse(); // хронология по возрастанию, как прежде
  return {
    locked: false,
    notes: rows.map((row) => ({
      scanId: row.scan_id,
      role: row.role,
      text: row.text,
      refs: (JSON.parse(row.fact_refs) as string[]) ?? [],
      charterVersion: row.charter_version,
      model: row.model,
      createdAt: row.created_at,
      headSha: row.head_sha,
      scanFinishedAt: row.finished_at,
    })),
  };
}
