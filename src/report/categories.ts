// categories.ts — порядок и названия категорий: одна копия для API, отчета и
// страницы карточки (В4.9, часть 2 гейта, предпосылка круга 1).
//
// Модуль чистый (без БД и сервера): его берет бандл web через
// `src/report/sections.ts`, поэтому значения живут здесь, а `src/api/repos.ts`
// их реэкспортирует — маршруты и формы API от переезда не меняются.
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
