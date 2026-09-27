/**
 * Исход запуска CI по перечню `Run.Status` из спеки SourceCraft; каждое
 * значение – своя ветка. Статуса `running` в спеке нет: идущий запуск –
 * `processing`. Модуль без зависимостей – его берут сборщик REST и движок
 * рекомендаций.
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
