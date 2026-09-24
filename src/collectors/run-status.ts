// run-status.ts — исход запуска CI по перечню спеки (чистый модуль: его берут
// сборщик REST и движок рекомендаций).
/**
 * Исход запуска CI по перечню `Run.Status` спеки SourceCraft (М2.5 аудита
 * В5.3; правило AGENTS.md 22.09 — каждое значение своей веткой). До правки
 * код ждал статус `running`, которого в спеке нет, и идущие запуски
 * (`processing`) считались провалом.
 */
export type RunOutcome = "success" | "failure" | "neutral" | "pending" | "unknown";

export function runOutcome(status: string | null | undefined): RunOutcome {
  switch (status) {
    case "success":
      return "success";
    case "failed":
    case "timeout":
      return "failure";
    case "canceled":
    case "skipped":
    case "rejected":
      return "neutral";
    case "created":
    case "prepared":
    case "processing":
    case "awaiting_approval":
      return "pending";
    default:
      return "unknown";
  }
}
