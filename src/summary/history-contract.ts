// Общие типы и правила истории сканов и AI-взглядов.
// Модуль БЕЗ серверных зависимостей: импортируется и сервером (api/history),
// и бандлом веба (RepoPage) — нельзя тянуть сюда bun:sqlite/node-модули.

import type { ScoreChange } from "./score-change";

export type { ScoreCategoryChange, ScoreChange, ScoreSubChange } from "./score-change";

export interface HistoryPoint {
  scanId: number;
  finishedAt: string | null;
  healthcraftIndex: number | null;
  indexCoverage: number;
  /** полный итог — дериватив показанных категорий; не fullOpen → null */
  repoHealthScore: number | null;
  modelVersion: string;
  /** на каком коммите измерено; у старых сканов null */
  headSha: string | null;
  /** на момент анализа в репозитории не было кода (правило codeEmpty) */
  codeEmpty: boolean;
  /** почему оценка изменилась к предыдущей точке истории; у первой точки null */
  change: ScoreChange | null;
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
  // какая версия текстов отдана — публичная (4 открытые категории) или полная
  | { locked: false; audience: "public" | "full"; notes: AiNoteHistoryItem[] };

/** Экран сравнения взглядов показывается при истории не меньше 2 дней. */
export function evolutionTooEarly(createdAtDates: string[], now: Date = new Date()): boolean {
  const times = createdAtDates.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return true;
  return Math.max(...times) - Math.min(...times) < 2 * 24 * 3600_000 - 60_000;
}
