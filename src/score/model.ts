// model.ts — константы score-модели (§3 анкеры, §4 веса — Б3; чистая
// функция, все числа фиксированы и меняются только со сменой
// MODEL_VERSION). Версия модели на каждом расчёте (жюри 13.2.2).
export const MODEL_VERSION = "2.0.0-m2";

/** noreply-домены автоматизации (§7.2; список — часть модели). */
export const NOREPLY_DOMAINS: string[] = ["github.com", "users.noreply.github.com", "noreply.github.com"];

/** Author-паттерны роботов (§7.2): имя содержит подстроку. */
export const ROBOT_NAME_MARKERS: string[] = ["[bot]", "-bot", "dependabot", "renovate", "allcontributors"];
