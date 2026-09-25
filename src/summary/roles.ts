// roles.ts — карта ролей AI-summary (спека В5 §3.1/§3.2, дефолт утверждён
// 22.09). Единственный источник: список ролей, температуры, ярус модели,
// скоуп фактов. Ключ override-шва фейков = хартия-роль (9 значений).
// Сущности создаются по типу входа (решение 22.09): контент-жила расширяет
// специалиста, синтез второго порядка — отдельная роль.

export const SPECIALIST_ROLES = ["documentation", "code", "activity", "issues", "cicd", "security"] as const;

export const SUMMARY_ROLES = [...SPECIALIST_ROLES, "overview", "trajectory", "flagger"] as const;

/**
 * В5.2 (Б2): категории публичного AI-обзора — те, что открыты всем (4 категории
 * HealthCraft Index). CI/CD и Безопасность — каналы с правами: их специалисты в
 * публичный прогон не входят, их факты и баллы во вход не попадают.
 */
export const PUBLIC_CATEGORIES = ["documentation", "code", "activity", "issues"] as const;
export const PUBLIC_SPECIALIST_ROLES = ["documentation", "code", "activity", "issues"] as const satisfies readonly (typeof SPECIALIST_ROLES)[number][];

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];
export type SummaryRole = (typeof SUMMARY_ROLES)[number];

/** Ярус модели: овервью — main, остальные — side (решение 22.09). */
export function modelTierOf(role: SummaryRole): "main" | "side" {
  return role === "overview" ? "main" : "side";
}

/** Пер-ролевые температуры (спека §3.3): специалисты 0.4, overview 0.5, flagger 0.1. */
export const ROLE_TEMPERATURE: Record<SummaryRole, number> = {
  documentation: 0.4,
  code: 0.4,
  activity: 0.4,
  issues: 0.4,
  cicd: 0.4,
  security: 0.4,
  overview: 0.5,
  trajectory: 0.4,
  flagger: 0.1,
};

/**
 * Скоуп фактов роли — КАТЕГОРИИ фактов (collectors/facts.ts categoryOf).
 * Ограда «чужой зоны» ловится механически: валидатор отбрасывает ссылку
 * {f:key} на факт вне скоупа роли (adversarial-кейс спеки §3.6 п.4).
 * security — только AppSec-факты, инструментов чтения кода нет (закон 5).
 */
export const ROLE_FACT_CATEGORIES: Record<SpecialistRole, readonly string[]> = {
  documentation: ["documentation"],
  code: ["code"],
  activity: ["activity"],
  issues: ["issues"],
  cicd: ["cicd"],
  security: ["security"],
};

/** Инструменты агента — только у специалистов; security — исключение (закон 5). */
export function toolsAllowed(role: SummaryRole): boolean {
  return (SPECIALIST_ROLES as readonly string[]).includes(role) && role !== "security";
}

/** Категории, чьи факты говорят о ритме и накрутке (вход флаггера). */
export const FLAGGER_CATEGORIES = ["activity"] as const;

/** Порог эволюции взглядов: экран динамики — при истории ≥ 2 дней (решение 22.09). */
export const EVOLUTION_MIN_HISTORY_MS = 2 * 24 * 3600_000;
