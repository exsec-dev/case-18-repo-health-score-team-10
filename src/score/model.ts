// Константы модели оценки: анкеры нормировки, веса, особые случаи
// (docs/methodology.md, §4 и §11). Все числа фиксированы ради воспроизводимости:
// любая правка, меняющая смысл балла (формула, анкер, признак робота,
// классификация факта), — новая MODEL_VERSION с пересчетом. Анкеры откалиброваны
// по живой выборке репозиториев. Модель описывает ДВА показателя: полный
// Repo Health Score (6 категорий, SCORE_WEIGHTS) и публичный HealthCraft Index
// (4 категории, INDEX_WEIGHTS). История версий — docs/methodology.md §8.
export const MODEL_VERSION = "4.5.0-hci";

/**
 * Стабильность CI в динамике — доля успешных у последних
 * CI_STABILITY_WINDOW завершенных запусков против стольких же предыдущих.
 * Окно 10: одна смена исхода — 10 п.п., ниже порога сдвиг не засчитывается.
 * Меньше 2 × 10 завершенных — окно делится пополам, но не меньше
 * CI_STABILITY_MIN_WINDOW (при 5 запусках на окно одна смена исхода — 20 п.п.,
 * меньшая выборка — шум); меньше 2 × 5 — «нет данных: мало запусков».
 * Сдвиг доли от CI_STABILITY_DELTA (15 п.п.) — «стабильнее»/«хуже»: при окне 10
 * это 2 запуска из 10, при окне 5 — 1. Справочно, без веса.
 */
export const CI_STABILITY_WINDOW = 10;
export const CI_STABILITY_MIN_WINDOW = 5;
export const CI_STABILITY_DELTA = 0.15;

/**
 * Динамика задач — 6 скользящих окон по 30 дней от момента
 * анализа (180 дней). Окна, а не календарные месяцы: баланс за 90 дней — ровно
 * сумма 3 последних окон, без неполного текущего месяца. Направление по
 * балансу «создано − закрыто» за 90 дней: стабилен, если |баланс| не больше
 * max(ISSUE_BACKLOG_STABLE_ABS, ISSUE_BACKLOG_STABLE_SHARE × (создано + закрыто)) —
 * пара задач или 10% оборота не считается трендом. Справочно, без веса.
 */
export const ISSUE_FLOW_WINDOW_DAYS = 30;
export const ISSUE_FLOW_WINDOWS = 6;
export const ISSUE_BACKLOG_WINDOWS = 3;
export const ISSUE_BACKLOG_STABLE_ABS = 2;
export const ISSUE_BACKLOG_STABLE_SHARE = 0.1;

/**
 * Bus factor — справочный показатель БЕЗ веса: сколько авторов-людей покрывают
 * долю BUS_FACTOR_SHARE их коммитов за последние BUS_FACTOR_WINDOW_DAYS дней
 * (по датам автора); нет коммитов в окне — null (no-data).
 */
export const BUS_FACTOR_WINDOW_DAYS = 90;
export const BUS_FACTOR_SHARE = 0.5;

/**
 * Публичный рейтинг = 4 категории: по указанию организаторов CI/CD и Security
 * в общий рейтинг не входят и видны на карточке только зрителям с доступом
 * к этим каналам. Номинальный вес четверки = 15+15+15+20 = 65 из 100.
 */
export const PUBLIC_CATEGORIES: CategoryKey[] = ["documentation", "activity", "issues", "code"];

/**
 * noreply-адреса автоматизации (список — часть модели), только точное совпадение.
 * `users.noreply.github.com` — приватная почта ЧЕЛОВЕКА на GitHub (коммит через
 * веб или со скрытым адресом), не автоматизация; боты на нем
 * (`dependabot[bot]@…`) ловятся маркерами имени.
 */
export const NOREPLY_DOMAINS: string[] = ["noreply.github.com"];
export const ROBOT_EMAILS: string[] = ["noreply@github.com"];

/** Паттерны роботов: имя или емейл автора содержит подстроку. */
export const ROBOT_NAME_MARKERS: string[] = ["[bot]", "-bot", "dependabot", "renovate", "allcontributors"];

// ---------- нормировка: анкерные таблицы ----------

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
  // здесь first.x < x < last.x, поэтому отрезок находится всегда
  let i = 1;
  while (x > anchors[i]!.x) i++;
  const a = anchors[i]!;
  const b = anchors[i - 1]!;
  return b.y + ((x - b.x) / (a.x - b.x)) * (a.y - b.y);
}

/** Лог-интерполяция по log10(x+1) (0-анкер сохраняет смысл: x=0 → первый y). */
export function anchorScoreLog(anchors: Anchor[], x: number): number {
  return anchorScore(anchors.map((a) => ({ x: Math.log10(a.x + 1), y: a.y })), Math.log10(Math.max(0, x) + 1));
}

/** fresh: месяцы с последнего коммита человека (без синков) по дате автора. */
export const FRESH_MONTHS: Anchor[] = [
  { x: 1, y: 1.0 },
  { x: 6, y: 0.7 },
  { x: 12, y: 0.45 },
  { x: 24, y: 0.1 },
];

/** commits/мес := commits_90d/3 (коммиты людей без синков, по датам автора); 30/мес ≈ 1.0. */
export function commitsPerMonthScore(x: number): number {
  return Math.min(1, Math.log10(x + 1) / Math.log10(31));
}

/**
 * contributors (лог): 1→0.2 (соло-пол), 10→0.6, 100→1.0, выше плоско.
 * Расчет зовет функцию только при x ≥ 1; пол держит Math.max.
 */
export function contributorsScore(x: number): number {
  return Math.min(1, 0.2 + 0.4 * Math.log10(Math.max(1, x)));
}

/** readme bytes: 500Б→0.2, 2КБ→0.6, 20КБ→1.0, выше плоско (объем сверх этого — уже не качество). */
export const README_BYTES: Anchor[] = [
  // пустой README — 0, а не пол 0,2
  { x: 0, y: 0 },
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
  // закрыть все — максимум, а не 0,95
  { x: 1, y: 1 },
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

/**
 * Полная выборка трекера: с этого числа задач балл «Задач» считается без
 * сжатия к минимуму ISSUES_TRACKER_UNUSED.
 */
export const ISSUES_FULL_SAMPLE = 10;

/** Минимальный знаменатель доли старых TODO: одна старая пометка не обрушивает категорию. */
export const OLD_SHARE_MIN_BASE = 5;

/**
 * Доля файлов тестов среди файлов кода: 5% — 0,5; 15% — 0,8; от 30% — максимум.
 * «Тесты» — бонус: нет непустых тестов — подметрика вне расчета, а не 0; есть —
 * входит в «Код» с весом 0,3, только если поднимает балл (`compute.ts`, `scoreCode`).
 */
export const TEST_SHARE: Anchor[] = [
  { x: 0, y: 0 },
  { x: 0.05, y: 0.5 },
  { x: 0.15, y: 0.8 },
  { x: 0.3, y: 1 },
];

/**
 * Плавное сжатие малого кода к нейтрали: `Код = 50 + (сырой − 50) × min(1, строк / 200)`.
 * Одна строка `main.py` дает «Коду» почти ровно 50, а не 100; порога и ступени
 * по числу строк нет. Строки — `source_loc`, у старых фактов — `loc`.
 */
export const CODE_FULL_LOC = 200;
export const CODE_NEUTRAL = 50;

/**
 * Потолок «Безопасности» при открытых находках — после взвешивания: открытая
 * critical — не выше 40, открытая high — не выше 69. На большом репо плотность
 * почти не замечает пару критичных находок, потолок замечает.
 */
export const SECURITY_OPEN_CAPS = { critical: 40, high: 69 } as const;

/** записей в корне репозитория (top_level), за крайними анкерами плоско. */
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

// ---------- веса (фиксированные, без адаптивных пересчетов) ----------

export type CategoryKey = "security" | "activity" | "documentation" | "cicd" | "issues" | "code";

/** Публичная четвёрка HealthCraft Index (ключи PUBLIC_CATEGORIES). */
export type IndexCategoryKey = "documentation" | "activity" | "issues" | "code";

/**
 * Repo Health Score — номинальные веса ТЗ: Security 20, Активность 15,
 * Документация 15, CI/CD 15, Issues 15, Code 20. Капы – утекшие секреты 49,
 * открытые критичные находки AppSec 69 – применяются только к этому показателю.
 */
export const SCORE_WEIGHTS: Record<CategoryKey, number> = {
  security: 20,
  activity: 15,
  documentation: 15,
  cicd: 15,
  issues: 15,
  code: 20,
};

/**
 * HealthCraft Index — собственные веса публичной четверки: SCORE_WEIGHTS,
 * перенормированные на массу четверки (15+15+15+20 = 65 → 100) и округленные
 * до целых (15/65·100 ≈ 23.08 → 23; 20/65·100 ≈ 30.77 → 31).
 * Смена весов = новая MODEL_VERSION + пересчет.
 */
export const INDEX_WEIGHTS: Record<IndexCategoryKey, number> = {
  documentation: 23,
  activity: 23,
  issues: 23,
  code: 31,
};

/**
 * Знаменатели coverage — номинальная масса весов SCORE_WEIGHTS с данными:
 * индекс считается от массы публичной четвёрки (65 из 100), полный Score —
 * от всей сотни. Семантика tri-state одна: coverage ниже порога → итог
 * NULL, «нет данных» не наказывает ни один показатель.
 */
export const INDEX_COVERAGE_BASE = 65;
export const FULL_COVERAGE_BASE = 100;

export const SUBWEIGHTS = {
  documentation: { readme: 0.45, license: 0.25, contributing: 0.15, codeowners: 0.15 },
  cicd: { config: 0.3, pass_rate: 0.45, duration: 0.25 },
  security: { density: 0.5, resolved: 0.3, secrets: 0.2 },
  activity: { fresh: 0.35, freq: 0.25, contributors: 0.2, pulls: 0.1, releases: 0.1 },
  issues: { stale: 0.3, close_days: 0.3, resolution: 0.3, first_resp: 0.1 },
  // корень — второстепенный признак, поэтому вес всего 0,1
  code: { density: 0.35, old_share: 0.25, tests: 0.3, root: 0.1 },
} as const;

/** readme = presence 0.3 + quality 0.7; quality = bytes 0.5 + sections 0.5. */
export const README_SPLIT = { presence: 0.3, quality: 0.7 } as const;
export const README_QUALITY_SPLIT = { bytes: 0.5, sections: 0.5 } as const;

// ---------- особые случаи ----------

/**
 * Ленты свежести прогонов: pass_rate считается по
 * взвешенной доле успеха — чем свежее прогон, тем он весомее. Вес ленты
 * действует до `days` дней возраста прогона; старше последней ленты — 0
 * («после года 0»). Сумма весов не нормируется: взвешенная доля
 * инвариантна к масштабу.
 */
export const CI_RECENCY_BANDS: ReadonlyArray<{ days: number; w: number }> = [
  { days: 3, w: 30 },
  { days: 13, w: 20 },
  { days: 43, w: 10 },
  { days: 133, w: 5 },
  { days: 363, w: 2.5 },
];

/** критичные secrets-находки → жесткий кап total ≤ 49 (паттерн CHAOSS/OpenSSF). */
export const SECRETS_CRITICAL_TOTAL_CAP = 49;

/**
 * Открытые критичные находки AppSec → кап total ≤ 69 (4.5.0): верх зоны «требует
 * внимания». Потолок категории 40 при весе 20 снимает с итога не больше 12 баллов,
 * и репозиторий с критичными уязвимостями оставался бы «здоров».
 */
export const CRITICAL_FINDINGS_TOTAL_CAP = 69;

/** severity-веса плотности на 10К LOC. */
export const SEVERITY_WEIGHTS = { critical: 8, high: 4, medium: 2, low: 1 } as const;

/** coverage ниже порога → итог NULL («недостаточно данных»). */
export const COVERAGE_NULL_BELOW = 0.4;

const anchorMin = (a: Anchor[]): number => Math.min(...a.map((x) => x.y));

/**
 * Вычислимый минимум категории «Задачи» по анкерам — все субметрики на худших
 * узлах БЕЗ перенормировки: 0.3·0.1(stale) + 0.3·0(close) + 0.3·0.1(resolution)
 * + 0.1·0(first) = 6 (в двоичной арифметике — 6.000000000000001).
 */
export const ISSUES_ANCHOR_MIN = 100 * (
  SUBWEIGHTS.issues.stale * anchorMin(STALE_SHARE) +
  SUBWEIGHTS.issues.close_days * anchorMin(CLOSE_DAYS) +
  SUBWEIGHTS.issues.resolution * anchorMin(RESOLVED_SHARE) +
  SUBWEIGHTS.issues.first_resp * anchorMin(FIRST_COMMENT_H)
);

/**
 * Issues 0/0 = данные «трекер не ведется»: балл = вычислимый минимум категории
 * (ISSUES_ANCHOR_MIN). Минимум — нижняя грань любых честных данных, поэтому
 * «ведение ≥ пустоты» выполняется по построению. Записан точным числом 6:
 * сравнения на равенство с 6.000000000000001 хрупки; совпадение с минимумом держит тест.
 */
export const ISSUES_TRACKER_UNUSED = 6;
