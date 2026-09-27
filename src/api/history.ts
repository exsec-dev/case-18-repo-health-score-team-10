// История оценки и история AI-обзоров репозитория – проекция уже записанных
// scores и scans, новых сборов нет. Индекс и покрытие видят все, полный Score –
// только зритель с правами на него (как на карточке). Точка без числа – NULL,
// а не ноль.
import type { Database } from "bun:sqlite";
import { parseFactValue } from "../collectors/facts";
import { MODEL_VERSION } from "../score/model";
import { totalsFromCategories, type CategoryScore } from "../score/compute";
import { NO_PAT_ACCESS, type AccessResult } from "../auth/access";
import type { AiAudience } from "../db";

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

/**
 * Сканы репо с критичными секретами (флаг ok-факта appsec.findings) – одним
 * запросом на репо, а не на каждую точку истории.
 */
function secretsCriticalScans(db: Database, repoId: number): Set<number> {
  const rows = db
    .query(
      "SELECT f.scan_id, f.value FROM facts f JOIN scans s ON s.id = f.scan_id WHERE s.repo_id = ? AND f.key = 'appsec.findings' AND f.status = 'ok'",
    )
    .all(repoId) as { scan_id: number; value: string }[];
  const out = new Set<number>();
  for (const r of rows) {
    if ((parseFactValue(r.value) as { secrets_critical?: unknown } | null)?.secrets_critical === true) out.add(r.scan_id);
  }
  return out;
}

function totalsOf(row: ScoreHistoryRow, secretsCritical: boolean): { score: number | null; coverage: number } {
  const cats = JSON.parse(row.categories) as Record<string, CategoryScore>;
  // кап критичных секретов применяется тем же правилом, что и при скане:
  // флаг читается из фактов ЭТОГО скана — исторический итог не переписывается
  const totals = totalsFromCategories(cats as never, { codeEmpty: row.code_empty === 1, secretsCritical });
  return { score: totals.repoHealthScore, coverage: totals.repoHealthCoverage };
}

/**
 * История по возрастанию сканов, только строки текущей MODEL_VERSION: оценки
 * сопоставимы лишь внутри одной версии модели. null – репо не видно (404).
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
  const secrets = fullOpen ? secretsCriticalScans(db, r.id) : new Set<number>();
  const points: HistoryPoint[] = rows.map((row) => {
    // полный итог – из записанных категорий этой строки и ее же фактов,
    // тем же расчетом, что на карточке
    const { score } = fullOpen ? totalsOf(row, secrets.has(row.scan_id)) : { score: null };
    return {
      scanId: row.scan_id,
      finishedAt: row.finished_at,
      healthcraftIndex: row.healthcraft_index,
      indexCoverage: row.index_coverage,
      repoHealthScore: score === null ? null : Math.round(score * 10) / 10,
      modelVersion: MODEL_VERSION,
      headSha: row.head_sha,
      // помечаем точку «без кода», чтобы переход от нулей к первому пушу не читался ростом
      codeEmpty: row.code_empty === 1,
    };
  });
  return { points, modelVersion: MODEL_VERSION, fullOpen };
}

// ---------- история AI-обзоров ----------

/**
 * История AI-обзоров по сканам. Лог ai_notes растет со сканами, поэтому
 * отдаются только последние 50 строк.
 * Видимость: репо не видно → null (404). Зритель с полным Score получает
 * полные тексты (если их нет – публичные у публичного репо); остальные –
 * только публичные тексты публичного репо; закрытый репо без полного Score →
 * locked. Заметки проверки на накрутку (flagger) – не обзор, в историю не входят.
 */
export function getAiNotesHistory(db: Database, org: string, repo: string, opts: { access?: AccessResult } = {}): AiNotesResponse | null {
  const r = db
    .query("SELECT id, rating_active, visibility FROM repos WHERE org_slug = ? AND repo_slug = ?")
    .get(org, repo) as { id: number; rating_active: number; visibility: string } | null;
  if (!r) return null;
  if (r.visibility === "public" ? r.rating_active !== 1 : (opts.access ?? NO_PAT_ACCESS).repo !== "granted") return null;
  const access = opts.access ?? NO_PAT_ACCESS;
  const fullOpen = access.cicd === "granted" && access.appsec === "granted";
  const audiences: AiAudience[] = fullOpen ? (r.visibility === "public" ? ["full", "public"] : ["full"]) : r.visibility === "public" ? ["public"] : [];
  if (audiences.length === 0) {
    return { locked: true, reason: "AI-текст этого репозитория виден только зрителям с правами на полный Score" };
  }
  const has = (a: AiAudience): boolean =>
    db.query("SELECT 1 FROM ai_notes WHERE repo_id = ? AND role != 'flagger' AND audience = ? LIMIT 1").get(r.id, a) !== null;
  const audience = audiences.find(has) ?? audiences[0]!;
  const rows = db
    .query(
      `SELECT n.scan_id, n.role, n.text, n.fact_refs, n.charter_version, n.model, n.created_at, s.head_sha, s.finished_at
       FROM ai_notes n JOIN scans s ON s.id = n.scan_id
       WHERE n.repo_id = ? AND n.role != 'flagger' AND n.audience = ?
       ORDER BY n.scan_id DESC, n.id DESC
       LIMIT 50`,
    )
    .all(r.id, audience) as { scan_id: number; role: string; text: string; fact_refs: string; charter_version: string; model: string; created_at: string; head_sha: string | null; finished_at: string | null }[];
  rows.reverse(); // выбирали последние, отдаем по возрастанию
  return {
    locked: false,
    audience,
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
