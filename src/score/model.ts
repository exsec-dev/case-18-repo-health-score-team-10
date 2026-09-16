// model.ts — константы score-модели (§3 анкеры, §4 веса, §5 особые
// случаи; чистая функция, все числа фиксированы и меняются только со
// сменой MODEL_VERSION — воспроизводимость, жюри 13.2.2). Анкеры
// откалиброваны по живой выборке (драфт В2, Приложение А) и заморожены.
export const MODEL_VERSION = "3.0.0-m4";

/**
 * Публичный рейтинг = 4 категории (17.09, Алексей, Q&A №1: «в общий
 * рейтинг CI/CD и Security метрики вкладывать нельзя»): CI и Security
 * считаются только в own-режиме (токен юзера). Публичный доступный
 * максимум весов = 15+15+15+20 = 65 → PUBLIC_MAX.
 */
export const PUBLIC_CATEGORIES: CategoryKey[] = ["documentation", "activity", "issues", "code"];

/** noreply-домены автоматизации (§7.2; список — часть модели). */
export const NOREPLY_DOMAINS: string[] = ["github.com", "users.noreply.github.com", "noreply.github.com"];

/** Author-паттерны роботов (§7.2): имя содержит подстроку. */
export const ROBOT_NAME_MARKERS: string[] = ["[bot]", "-bot", "dependabot", "renovate", "allcontributors"];

// ---------- нормировка: анкерные таблицы (§3) ----------

/** Кусочно-линейная интерполяция; за крайними анкерами — плоско (последним значением). */
export interface Anchor {
  x: number;
  y: number;
}

export function anchorScore(anchors: Anchor[], x: number): number {
  const first = anchors[0]!;
  if (x <= first.x) return first.y;
  const last = anchors[anchors.length - 1]!;
  if (x >= last.x) return last.y;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i]!;
    if (x <= a.x) {
      const b = anchors[i - 1]!;
      const t = (x - b.x) / (a.x - b.x);
      return b.y + t * (a.y - b.y);
    }
  }
  return last.y;
}

/** Лог-интерполяция по log10(x+1) (0-анкер сохраняет смысл: x=0 → первый y). */
export function anchorScoreLog(anchors: Anchor[], x: number): number {
  return anchorScore(anchors.map((a) => ({ x: Math.log10(a.x + 1), y: a.y })), Math.log10(Math.max(0, x) + 1));
}

/** fresh: месяцы с последнего НЕ-sync author-коммита (наклоны выровнены, v0.2 №8). */
export const FRESH_MONTHS: Anchor[] = [
  { x: 1, y: 1.0 },
  { x: 6, y: 0.7 },
  { x: 12, y: 0.45 },
  { x: 24, y: 0.1 },
];

/** commits/мес := commits_90d/3 (human не-sync, author-даты): формула, 30/мес ≈ 1.0. */
export function commitsPerMonthScore(x: number): number {
  return Math.min(1, Math.log10(x + 1) / Math.log10(31));
}

/** contributors (лог): 1→0.2 (соло-пол), 10→0.6, 100→1.0, выше плоско. */
export function contributorsScore(x: number): number {
  if (x < 1) return 0.2;
  return Math.min(1, 0.2 + 0.4 * Math.log10(x));
}

/** readme bytes: <500Б→0.2, 2КБ→0.6, 20КБ→1.0, выше плоско (рабочий кап от воды). */
export const README_BYTES: Anchor[] = [
  { x: 500, y: 0.2 },
  { x: 2048, y: 0.6 },
  { x: 20480, y: 1.0 },
];

/** pass_rate по окну прогонов. */
export const PASS_RATE: Anchor[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.4 },
  { x: 0.9, y: 0.85 },
  { x: 1.0, y: 1.0 },
];

/** медианная длительность пайплайна, минуты. */
export const DURATION_MIN: Anchor[] = [
  { x: 2, y: 1.0 },
  { x: 5, y: 0.8 },
  { x: 15, y: 0.5 },
  { x: 30, y: 0.2 },
];

/** severity-плотность на 10К LOC (w: crit=8, high=4, med=2, low=1 — в compute). */
export const SEVERITY_PER_10K: Anchor[] = [
  { x: 0, y: 1.0 },
  { x: 2, y: 0.8 },
  { x: 5, y: 0.6 },
  { x: 10, y: 0.4 },
  { x: 20, y: 0.1 },
];

/** resolved_share находок. */
export const RESOLVED_SHARE: Anchor[] = [
  { x: 0, y: 0.1 },
  { x: 0.5, y: 0.55 },
  { x: 0.9, y: 0.95 },
];

/** stale_share открытых issues. */
export const STALE_SHARE: Anchor[] = [
  { x: 0, y: 1.0 },
  { x: 0.5, y: 0.5 },
  { x: 1.0, y: 0.1 },
];

/** медианное время до закрытия issue, дни. */
export const CLOSE_DAYS: Anchor[] = [
  { x: 2, y: 1.0 },
  { x: 7, y: 0.85 },
  { x: 30, y: 0.5 },
  { x: 90, y: 0.2 },
  { x: 180, y: 0 },
];

/** медианная задержка первого комментария, часы. */
export const FIRST_COMMENT_H: Anchor[] = [
  { x: 24, y: 1.0 },
  { x: 72, y: 0.7 },
  { x: 168, y: 0.4 },
  { x: 720, y: 0 },
];

/** плотность TODO/FIXME на KLOC. */
export const TODO_PER_KLOC: Anchor[] = [
  { x: 0, y: 1.0 },
  { x: 2, y: 0.8 },
  { x: 10, y: 0.5 },
  { x: 30, y: 0.25 },
  { x: 60, y: 0 },
];

/** доля TODO старше 180 дней (blame). */
export const OLD_SHARE: Anchor[] = [
  { x: 0, y: 1.0 },
  { x: 0.3, y: 0.7 },
  { x: 0.8, y: 0.1 },
];

/** записей в корне репозитория (top_level, лог-шкала духом — плоские края). */
export const ROOT_ENTRIES: Anchor[] = [
  { x: 15, y: 1.0 },
  { x: 40, y: 0.6 },
  { x: 100, y: 0.2 },
];

/** MR за 90 дней (лог; 0 → 0.2 — отсутствие потока не ноль). */
export const PULLS_90D: Anchor[] = [
  { x: 0, y: 0.2 },
  { x: 5, y: 0.6 },
  { x: 30, y: 1.0 },
];

/** релизы за 12 месяцев (лог). */
export const RELEASES_12M: Anchor[] = [
  { x: 0, y: 0.2 },
  { x: 2, y: 0.6 },
  { x: 6, y: 1.0 },
];

// ---------- веса (§4; фикс — без адаптивных пересчётов) ----------

export type CategoryKey = "security" | "activity" | "documentation" | "cicd" | "issues" | "code";

export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
  security: 20,
  activity: 15,
  documentation: 15,
  cicd: 15,
  issues: 15,
  code: 20,
};

export const SUBWEIGHTS = {
  documentation: { readme: 0.45, license: 0.25, contributing: 0.15, codeowners: 0.15 },
  cicd: { config: 0.3, pass_rate: 0.45, duration: 0.25 },
  security: { density: 0.5, resolved: 0.3, secrets: 0.2 },
  activity: { fresh: 0.35, freq: 0.25, contributors: 0.2, pulls: 0.1, releases: 0.1 },
  issues: { stale: 0.3, close_days: 0.3, resolution: 0.3, first_resp: 0.1 },
  code: { density: 0.4, old_share: 0.35, root: 0.25 },
} as const;

/** readme = presence 0.3 + quality 0.7; quality = bytes 0.5 + sections 0.5. */
export const README_SPLIT = { presence: 0.3, quality: 0.7 } as const;
export const README_QUALITY_SPLIT = { bytes: 0.5, sections: 0.5 } as const;

// ---------- особые случаи (§5) ----------

/** CI «конфиг без прогонов»: категория = конфиг-скор × 0.5 → потолок 50 (В2-9). */
export const CI_CONFIG_ONLY_FACTOR = 0.5;

/** критичные secrets-находки → жёсткий кап total ≤ 49 (В2-8, CHAOSS/OpenSSF-паттерн). */
export const SECRETS_CRITICAL_TOTAL_CAP = 49;

/** severity-веса плотности на 10К LOC. */
export const SEVERITY_WEIGHTS = { critical: 8, high: 4, medium: 2, low: 1 } as const;

/** режимный максимум coverage: публично 4 категории = 65 весов; свой репо — все 6 = 1.0 (В4/Б4). */
export const COVERAGE_MODE_MAX: Record<"public" | "own", number> = { public: 0.65, own: 1.0 };

/** coverage ниже порога → Score = NULL («недостаточно данных», В2-6). */
export const COVERAGE_NULL_BELOW = 0.4;

const anchorMin = (a: Anchor[]): number => Math.min(...a.map((x) => x.y));

/**
 * Issues 0/0 = данные «трекер не ведётся»: скор = вычислимый минимум
 * категории по анкерам — все субметрики на худших узлах БЕЗ перенормировки
 * (перенормировка no-data субметрик поднимает частичный минимум выше
 * полного; полный минимум — нижняя грань любых честных данных, что и
 * гарантирует монотонность «ведение ≥ пустоты» по построению, Q14/§5.3).
 * ≈6: 0.3·0.1(stale) + 0.3·0(close) + 0.3·0.1(resolution) + 0.1·0(first).
 */
export const ISSUES_TRACKER_UNUSED = 100 * (
  SUBWEIGHTS.issues.stale * anchorMin(STALE_SHARE) +
  SUBWEIGHTS.issues.close_days * anchorMin(CLOSE_DAYS) +
  SUBWEIGHTS.issues.resolution * anchorMin(RESOLVED_SHARE) +
  SUBWEIGHTS.issues.first_resp * anchorMin(FIRST_COMMENT_H)
);
