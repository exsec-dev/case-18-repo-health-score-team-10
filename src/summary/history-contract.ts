// history-contract.ts — общие типы и чистые правила истории В5 (К5.7/К5.16).
// Модуль БЕЗ серверных зависимостей: импортируется и сервером (api/history),
// и бандлом веба (RepoPage) — нельзя тянуть сюда bun:sqlite/node-модули.

export interface HistoryPoint {
  scanId: number;
  finishedAt: string | null;
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** полный итог — дериватив показанных категорий; не fullOpen → null */
  repoHealthScore: number | null;
  modelVersion: string;
  /** «на каком коммите измерено» (К5.17); у старых сканов честный null */
  headSha: string | null;
  /** В5.3 круг 3: на момент анализа в репозитории не было кода (правило codeEmpty) */
  codeEmpty: boolean;
}

export interface HistoryResponse {
  points: HistoryPoint[];
  /** версия модели, внутри которой точки сопоставимы */
  modelVersion: string;
  fullOpen: boolean;
}

export interface AiNoteHistoryItem {
  scanId: number;
  role: string;
  text: string;
  refs: string[];
  charterVersion: string;
  model: string;
  createdAt: string;
  headSha: string | null;
  /** дата скана, к которому относится взгляд (порог эволюции меряется ей) */
  scanFinishedAt: string | null;
}

export type AiNotesResponse =
  | { locked: true; reason: string }
  // В5.2 (Б2): какая версия текстов отдана — публичная (4 открытые категории) или полная
  | { locked: false; audience: "public" | "full"; notes: AiNoteHistoryItem[] };

/** Порог эволюции (решение 22.09): экран сравнения взглядов – при истории не меньше 2 дней. */
export function evolutionTooEarly(createdAtDates: string[], now: Date = new Date()): boolean {
  const times = createdAtDates.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return true;
  return Math.max(...times) - Math.min(...times) < 2 * 24 * 3600_000 - 60_000;
}
