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

/** Порядок категорий на всех поверхностях — вес модели, затем ключ. */
export const CATEGORY_ORDER: CategoryKey[] = ["documentation", "cicd", "security", "activity", "issues", "code"];
