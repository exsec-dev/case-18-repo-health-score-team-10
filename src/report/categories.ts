// Порядок и названия категорий — одна копия для API, отчета и страницы карточки.
// Модуль чистый (без БД и сервера): его берет web-бандл через `src/report/sections.ts`,
// поэтому значения живут здесь, а `src/api/repos.ts` их реэкспортирует.
import type { CategoryKey } from "../score/model";

export const CATEGORY_TITLES: Record<CategoryKey, string> = {
  documentation: "Документация",
  cicd: "CI/CD",
  security: "Безопасность",
  activity: "Активность",
  issues: "Задачи",
  code: "Состояние кода",
};

/**
 * Порядок категорий на всех поверхностях (19.10.2026): сначала четыре публичные в
 * порядке HealthCraft Index, затем закрытые CI/CD и Безопасность — как в ТЗ (п. 3.1).
 */
export const CATEGORY_ORDER: CategoryKey[] = ["documentation", "activity", "issues", "code", "cicd", "security"];
