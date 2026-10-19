// Карта ролей AI-сводки — единственный источник: список ролей, температуры, ярус
// модели, скоуп фактов. Ключ override-шва фейков в тестах = роль хартии (9 значений).
// Роли делятся по типу входа: специалист читает факты и контент своей категории,
// синтез второго порядка (overview, trajectory, flagger) — отдельные роли.

export const SPECIALIST_ROLES = ["documentation", "code", "activity", "issues", "cicd", "security"] as const;

export const SUMMARY_ROLES = [...SPECIALIST_ROLES, "overview", "trajectory", "flagger"] as const;

/**
 * Категории публичного AI-обзора — открытые всем 4 категории HealthCraft Index.
 * CI/CD и Безопасность видны только с правами: их специалисты в публичный прогон
 * не входят, их факты и баллы во вход не попадают.
 */
export const PUBLIC_CATEGORIES = ["documentation", "code", "activity", "issues"] as const;
export const PUBLIC_SPECIALIST_ROLES = ["documentation", "code", "activity", "issues"] as const satisfies readonly (typeof SPECIALIST_ROLES)[number][];

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];
export type SummaryRole = (typeof SUMMARY_ROLES)[number];

/** Ярус модели: overview — main, остальные — side. */
export function modelTierOf(role: SummaryRole): "main" | "side" {
  return role === "overview" ? "main" : "side";
}

/** Специалистам 0.4, overview чуть свободнее (0.5), flagger детерминирован (0). */
export const ROLE_TEMPERATURE: Record<SummaryRole, number> = {
  documentation: 0.4,
  code: 0.4,
  activity: 0.4,
  issues: 0.4,
  cicd: 0.4,
  security: 0.4,
  overview: 0.5,
  trajectory: 0.4,
  flagger: 0,
};

/**
 * Скоуп фактов роли — КАТЕГОРИИ фактов (collectors/facts.ts categoryOf).
 * Выход в «чужую зону» ловится механически: валидатор отбрасывает ссылку
 * {f:key} на факт вне скоупа роли.
 * security — только данные AppSec, инструментов чтения кода нет: своего сканирования не делаем.
 */
export const ROLE_FACT_CATEGORIES: Record<SpecialistRole, readonly string[]> = {
  documentation: ["documentation"],
  code: ["code"],
  activity: ["activity"],
  issues: ["issues"],
  cicd: ["cicd"],
  security: ["security"],
};

/** Инструменты агента — только у специалистов, кроме security (только данные AppSec)
 *  и issues (трекер в клоне не лежит: роль живет на фактах). */
export function toolsAllowed(role: SummaryRole): boolean {
  return (SPECIALIST_ROLES as readonly string[]).includes(role) && role !== "security" && role !== "issues";
}

/** Категории, чьи факты говорят о ритме и накрутке (вход флаггера). */
export const FLAGGER_CATEGORIES = ["activity"] as const;

/** Экран динамики взглядов показывается при истории ≥ 2 дней. */
export const EVOLUTION_MIN_HISTORY_MS = 2 * 24 * 3600_000;
