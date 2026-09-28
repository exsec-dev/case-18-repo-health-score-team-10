// Детерминированный движок рекомендаций (ТЗ 3.3, docs/methodology.md §6):
// правило = (условие на фактах -> шаблон), каждая фраза привязана к fact_refs.
// Числовой прирост есть ТОЛЬКО у presence-правил: это реальная разность
// computeFromFacts на подмененных фактах и на фактах скана, с перенормировкой
// и капом 49, а не номинальный вес. Активационные правила идут без числа:
// они «открывают категорию».
// Порядок: правила серьезности (appsec-critical, fix-red-runs) -> числовые Δ по
// убыванию -> активационные по весу категории -> прочие скор-правила.
// LLM здесь ничего не решает.
// Одна выдача на скан; правило несет channel (cicd | appsec | null = публичное),
// и карточка скрывает правила закрытых зрителю каналов. Δ правил с channel
// относится к Repo Health Score, остальных – к HealthCraft Index.
// Движок – чистая recommendFromFacts(ok, ctx) с внешним оценщиком Δ: карточка
// собирает канальные правила на ПОКАЗАННЫХ фактах (CI/Security из своих сканов)
// своим оценщиком, а порядок для обеих выдач задает одна orderRecommendations.
// Тексты правил – ОДНА чистая функция `recommendationText` (ключ правила +
// параметры из фактов): движок зовет ее при записи, карточка (`api/repos.ts`) –
// при чтении, поэтому новые формулировки видны без пересчета.
import type { Database } from "bun:sqlite";
import { AppsecFindingsValue, DocsPresenceValue, DocsReadmeValue } from "./fact-shapes";
import { SCORE_WEIGHTS, CategoryKey, OLD_SHARE_MIN_BASE, SECRETS_CRITICAL_TOTAL_CAP, CRITICAL_FINDINGS_TOTAL_CAP } from "./model";
import { compute, computeFromFacts, effectiveFacts, licensePresent, totalCapFlags, type ComputeInput, Scores } from "./compute";
import { issuesClosedCounted } from "./derived";
import { fmtDecimal, fmtScore, fmtSigned } from "../web/format";
import { runOutcome } from "../collectors/run-status";

/** Канал правила: данные, видимые только зрителю с доступом. */
export type RecommendationChannel = "cicd" | "appsec";

export interface Recommendation {
  ruleId: string;
  kind: "presence" | "activation" | "score";
  priority: number;
  problem: string;
  action: string;
  factRefs: string[];
  expectedImpact: string;
  deltaScore: number | null;
  opensCategory: CategoryKey | null;
  /** null = публичное правило (видно всем) */
  channel: RecommendationChannel | null;
}

export interface RecommendOptions {
  now?: Date;
  /** предвычисленный Scores (hook считает compute один раз) */
  scores?: Scores;
}

export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Почему прирост presence-правила равен нулю (текст – `recommendationText`).
 * `no-runs` – CI-правило при невидимых запусках: числа нет, эффект текстом
 * «оценка появится с запусками».
 */
export type DeltaReason = "code-empty" | "no-total" | "cap" | "cap-critical" | "no-runs";

/** Реальный прирост итога правила при подмене фактов; reason – причина Δ = 0. */
export type DeltaEvaluator = (
  channel: RecommendationChannel | null,
  patch: (facts: Map<string, unknown>) => void,
) => { delta: number; reason: DeltaReason | null };

export interface RecommendFactsContext {
  delta: DeltaEvaluator;
  /** балл категории Issues – для текста start-tracker */
  issuesScore: number | null;
  /** "channel" – только правила каналов CI/Security (так их собирает карточка) */
  only?: "all" | "channel";
  /**
   * В репозитории нет кода (пустой или без файлов): по разъяснению организаторов
   * оценка 0, и совет один – добавить код. Трекер и россыпь presence-правил
   * с эффектом «+0,0» такому репо ничего не дают.
   */
  codeEmpty?: boolean;
  /**
   * Баллы категорий той же оценки. Скор-правило срабатывает только у оцененной
   * категории: «повысит балл» категории без балла формула дать не может.
   * Не передано – правила не фильтруются.
   */
  categoryScores?: Partial<Record<CategoryKey, number | null>>;
  /**
   * Число авторов той же оценки (`activity.contributors`) – только для текста
   * `codeowners-missing`; условие правила и его эффект от него не зависят.
   */
  authors?: number | null;
}

// ---------- тексты правил: одна функция для записи и чтения ----------

/** README: разделы, которые ищет сервис (флаги факта `docs.readme`). */
export type ReadmeSection = "install" | "build" | "test";

/** Параметры шаблона — все восстанавливаются из фактов и баллов того же скана. */
export interface RecommendationParams {
  /** presence: прирост показателя (знаковый) */
  delta?: number;
  /** presence: почему прирост 0 */
  reason?: DeltaReason | null;
  /** presence: канал правила — к какому показателю прирост */
  channel?: RecommendationChannel | null;
  /** readme-sections-missing: каких разделов нет (флаги `docs.readme`) */
  missing?: ReadmeSection[];
  /** start-tracker: балл категории Задачи */
  issuesScore?: number | null;
  /** speed-up-pipeline: медиана длительности, минуты */
  minutes?: number;
  /** appsec-critical: есть утекшие секреты (потолок 49 действует только при них) */
  secrets?: boolean;
  /**
   * appsec-critical / appsec-high: потолок категории, который держат находки
   * этого уровня сейчас (40 / 69), или null – балл ниже потолка
   */
  capLimit?: number | null;
  /** appsec-critical / appsec-high: устранение находок уровня поднимет балл категории (по пересчету) */
  gain?: boolean;
  /** resolve-old-todos: пометок старше 180 дней и всего */
  older?: number;
  total?: number;
  /** reduce-stale-issues: доля открытых задач без движения, % */
  percent?: number;
  /** speed-up-issue-close: медиана закрытия, дни */
  days?: number;
  /** codeowners-missing: число авторов той же оценки */
  authors?: number | null;
}

/** Части текста: действие – глагол, problem – причина, expectedImpact – эффект. */
export interface RecommendationText {
  action: string;
  problem: string;
  expectedImpact: string;
}

const DELTA_REASON_TEXT: Record<DeltaReason, string> = {
  "code-empty": "в репозитории нет кода",
  "no-total": "оценка появится, когда данных станет больше",
  cap: "Repo Health Score ограничен 49 баллами из-за утекших секретов",
  "cap-critical": "Repo Health Score ограничен 69 баллами, пока открыты критичные находки AppSec",
  "no-runs": "CI/CD: оценка появится с запусками",
};

const SECTION_WORDS: Record<ReadmeSection, { title: string; en: string; about: string }> = {
  install: { title: "Установка", en: "Install", about: "установке" },
  build: { title: "Сборка", en: "Build", about: "сборке" },
  test: { title: "Тесты", en: "Test", about: "тестах" },
};

const joinAnd = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} и ${items.at(-1)}`);

/** До скольких авторов совет CODEOWNERS звучит как задел на будущее (меняет текст, не условие правила). */
export const CODEOWNERS_FEW_AUTHORS = 2;

/** Родительный падеж после «из N»: из 1 пометки, из 5 пометок, из 21 пометки. */
const fromWord = (n: number, one: string, many: string): string => (n % 10 === 1 && n % 100 !== 11 ? one : many);

/** Дни: 1 день, 2 дня, 5 дней; дробное — родительный ед. («48,8 дня»), как в словаре подметрик. */
const daysWord = (n: number): string => {
  if (!Number.isInteger(n)) return "дня";
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "день" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "дня" : "дней";
};

const categoryImpact = (title: string): string => `повысит балл категории «${title}»`;

function presenceImpact(p: RecommendationParams): string | null {
  // запуски не видны – эффект словами, без числа (CI без запусков не оценивается)
  if (p.reason === "no-runs") return DELTA_REASON_TEXT["no-runs"];
  if (typeof p.delta !== "number") return null;
  const scope = p.channel ? "к Repo Health Score" : "к HealthCraft Index";
  return `${fmtSigned(p.delta)} ${scope}${p.reason ? ` – ${DELTA_REASON_TEXT[p.reason]}` : ""}`;
}

/**
 * Совет по открытым находкам AppSec уровня critical или high – текстом по факту.
 * Потолок держит балл – «снимет потолок N»; балл ниже потолка и устранение его
 * поднимет – «повысит балл»; не поднимет (плотность на полу от прочих находок) –
 * роста не обещаем.
 */
function appsecLevelText(p: RecommendationParams, action: string, what: string, totalCap: number | null = null): RecommendationText | null {
  if (p.capLimit === undefined || typeof p.gain !== "boolean") return null;
  const capped = typeof p.capLimit === "number";
  // критичные находки держат и потолок итога (4.5.0): о нем – всегда, он действует при любом балле категории
  const totalNote = totalCap !== null ? ` Repo Health Score при этом не выше ${totalCap}.` : "";
  const categoryPart = capped
    ? `снимет потолок ${p.capLimit} с категории «Безопасность»`
    : p.gain
      ? categoryImpact("Безопасность")
      : null;
  const totalPart = totalCap !== null ? `ограничение Repo Health Score в ${totalCap} баллов` : null;
  return {
    action,
    problem: capped ? `AppSec нашел в коде ${what}. Пока они открыты, балл категории «Безопасность» не выше ${p.capLimit}.${totalNote}` : `AppSec нашел в коде ${what}.${totalNote}`,
    expectedImpact:
      categoryPart && totalPart
        ? `${categoryPart} и снимет ${totalPart}`
        : totalPart
          ? `снимет ${totalPart}; балл категории «Безопасность» от этого не вырастет: его снижают и другие находки`
          : (categoryPart ?? "балл категории «Безопасность» от этого не вырастет: его снижают и другие находки"),
  };
}

/** Доля файлов тестов, для которой совет `add-tests` считает эффект. */
export const ADD_TESTS_SHARE = 0.1;

/** Эпоха для пересчета «Безопасности»: категория от времени не зависит. */
const SECURITY_EPOCH = new Date(0);

/**
 * Что даст устранение открытых находок уровня – по пересчету категории:
 * держат ли они сейчас потолок и вырастет ли балл.
 */
export function appsecFixEffect(ok: Map<string, unknown>, level: "critical" | "high"): { capLimit: number | null; gain: boolean } {
  const before = computeFromFacts(ok, { scanId: 0, repoId: 0 }, SECURITY_EPOCH).categories.security;
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue;
  const facts = new Map(ok);
  facts.set("appsec.findings", { ...appsec, severity_counts: { ...(appsec.severity_counts ?? {}), [level]: 0 } });
  const after = computeFromFacts(facts, { scanId: 0, repoId: 0 }, SECURITY_EPOCH).categories.security;
  const adj = before.adjustment;
  const capLimit = adj?.kind === "open-findings-cap" && adj.level === level ? adj.limit : null;
  const gain = before.score !== null && after.score !== null && after.score > before.score + 1e-9;
  return { capLimit, gain };
}

/**
 * Тексты правила по ключу и параметрам. null – ключ неизвестен или параметр
 * не восстановился: тогда карточка показывает сохраненный текст.
 * Тон формальный, термины – как в интерфейсе SourceCraft.
 */
export function recommendationText(ruleId: string, p: RecommendationParams): RecommendationText | null {
  const presence = (action: string, problem: string): RecommendationText | null => {
    const impact = presenceImpact(p);
    return impact === null ? null : { action, problem, expectedImpact: impact };
  };
  switch (ruleId) {
    case "license-missing":
      return presence("Добавьте файл лицензии", "В репозитории нет лицензии: без нее другие не могут законно использовать код. Подойдет, например, MIT или Apache-2.0.");
    case "contributing-missing":
      return presence("Добавьте файл CONTRIBUTING.md", "Не описано, как предложить изменения. Файл с порядком работы упростит начало новым участникам.");
    case "codeowners-missing":
      // у проекта из 1-2 авторов ответственный и так понятен: совет звучит как
      // задел на будущее, а не как дефект
      if (typeof p.authors === "number" && p.authors >= 1 && p.authors <= CODEOWNERS_FEW_AUTHORS) {
        return presence(
          "Добавьте файл CODEOWNERS",
          `У проекта ${p.authors} ${p.authors === 1 ? "автор" : "автора"}, и кто отвечает за код, пока понятно без файла. Когда появятся соавторы, CODEOWNERS сразу направит их предложения изменений к ответственным; для начала хватит одной строки с логином автора.`,
        );
      }
      return presence("Добавьте файл CODEOWNERS", "Не указано, кто отвечает за код. С CODEOWNERS предложения изменений сразу попадают к ответственным.");
    case "readme-missing":
      return presence("Добавьте файл README.md", "В репозитории нет README – описания проекта и порядка запуска. Его первым читает любой новый участник.");
    case "readme-sections-missing": {
      const missing = (p.missing ?? []).filter((k) => k in SECTION_WORDS);
      if (missing.length === 0) return null;
      const many = missing.length > 1;
      const titles = joinAnd(missing.map((k) => `«${SECTION_WORDS[k].title}»`));
      const about = missing.map((k, i) => (i === 0 ? `${k === "install" ? "об" : "о"} ${SECTION_WORDS[k].about}` : SECTION_WORDS[k].about));
      return presence(
        `Добавьте в README ${many ? "разделы" : "раздел"} ${titles}`,
        `В README нет ${many ? "разделов" : "раздела"} ${joinAnd(about)}. Сервис находит ${many ? "их по заголовкам" : "его по заголовку"} ${titles} или ${joinAnd(missing.map((k) => `«${SECTION_WORDS[k].en}»`))}.`,
      );
    }
    case "ci-missing":
      // у зеркала сборка может жить у источника; признака «зеркало» в методике нет,
      // поэтому оговорка стоит у правила всегда и говорит, что именно оценивается
      return presence(
        "Настройте CI",
        "Нет файла .sourcecraft/ci.yaml: изменения не собираются и не проверяются автоматически. Если репозиторий – зеркало, сборка может идти у источника, но сервис оценивает только CI в SourceCraft.",
      );
    case "ci-no-steps":
      return presence("Добавьте команды в ci.yaml", "Файл .sourcecraft/ci.yaml есть, но в нем нет ни одной задачи с командой, поэтому CI ничего не проверяет.");
    case "add-code":
      return {
        action: "Добавьте код проекта",
        problem: "В репозитории нет кода. Такой репозиторий получает оценку 0: оценивать пока нечего.",
        expectedImpact: "оценка появится после анализа репозитория с кодом",
      };
    case "start-tracker":
      if (typeof p.issuesScore !== "number") return null;
      return {
        action: "Ведите задачи в трекере",
        problem: "В трекере нет ни одной задачи. По задачам видно, как быстро проект отвечает пользователям.",
        expectedImpact: `${categoryImpact("Задачи")} (сейчас ${fmtScore(p.issuesScore)} из 100)`,
      };
    case "connect-appsec":
      return {
        action: "Подключите проверку AppSec",
        problem: "Данных AppSec по репозиторию нет: проверка не подключена или не завершена. Если она уже идет, проверьте у токена право src.repositories.useAppSecScan.",
        expectedImpact: "добавит в Repo Health Score категорию «Безопасность»",
      };
    case "grant-ci-runs":
      return {
        action: "Откройте доступ к результатам CI",
        problem: "CI настроен, но результаты запусков сервису недоступны. Для своего репозитория добавьте в Настройках токен с правом читать запуски CI.",
        expectedImpact: "CI/CD: сейчас не оцениваем – с результатами запусков категория откроется",
      };
    case "fix-red-runs":
      return { action: "Почините CI", problem: "Последний запуск CI завершился ошибкой или успешны меньше 90% запусков.", expectedImpact: categoryImpact("CI/CD") };
    case "ci-never-ran":
      // CI заявлен, запуски видны, а их 0
      return {
        action: "Запустите CI",
        problem: "Файл .sourcecraft/ci.yaml с командами есть, но CI ни разу не запускался: изменения не проверяются автоматически.",
        expectedImpact: categoryImpact("CI/CD"),
      };
    case "speed-up-pipeline":
      if (typeof p.minutes !== "number") return null;
      return {
        action: "Ускорьте CI",
        problem: `Обычно запуск CI длится ${fmtDecimal(p.minutes, 1, { trim: true })} мин. Кеш зависимостей и параллельные задачи сократят ожидание.`,
        expectedImpact: categoryImpact("CI/CD"),
      };
    case "appsec-critical":
      if (typeof p.secrets !== "boolean") return null;
      // потолок 49 действует только при утекших секретах – без них его не обещаем
      if (p.secrets) {
        return {
          action: "Устраните утечки секретов",
          problem: "AppSec нашел в коде утекшие ключи или пароли. Пока они в коде, Repo Health Score не может быть выше 49: замените секреты и удалите их из кода.",
          expectedImpact: "снимет ограничение Repo Health Score в 49 баллов",
        };
      }
      return appsecLevelText(p, "Устраните критичные находки AppSec", "критичные уязвимости", CRITICAL_FINDINGS_TOTAL_CAP);
    case "appsec-high":
      // открытые high без critical держат потолок 69 – без этого правила совета о них не было бы
      return appsecLevelText(p, "Устраните находки AppSec высокой важности", "уязвимости высокой важности");
    case "resolve-old-todos":
      if (typeof p.older !== "number" || typeof p.total !== "number") return null;
      return {
        action: "Разберите устаревшие пометки TODO и FIXME",
        problem: `${p.older} из ${p.total} ${fromWord(p.total, "пометки", "пометок")} старше 180 дней. Выполните отложенные работы, перенесите их в задачи или удалите пометки.`,
        expectedImpact: categoryImpact("Состояние кода"),
      };
    case "reduce-stale-issues":
      if (typeof p.percent !== "number") return null;
      return {
        action: "Разберите задачи без движения",
        problem: `${p.percent}% открытых задач без движения более 90 дней. Закройте неактуальные, по остальным дайте ответ и назначьте ответственного.`,
        expectedImpact: categoryImpact("Задачи"),
      };
    case "add-tests":
      // «Тесты» – бонус «Кода»; эффект – пересчет для тестов в 10% файлов кода
      return presence(
        "Добавьте тесты",
        "В репозитории нет файлов тестов. Сервис находит их в каталогах test, tests и spec и по именам test_*, *_test.*, *.test.*, *.spec.*; пустые файлы не засчитываются. Эффект посчитан для тестов в 10% файлов кода.",
      );
    case "speed-up-issue-close": {
      if (typeof p.days !== "number") return null;
      // число то же и в том же виде, что в таблице показателей (десятые, `fmtDecimal`):
      // иначе совет говорил бы «49 дней», а таблица «48,8 дня»
      const days = Math.round(p.days * 10) / 10;
      return {
        action: "Ускорьте обработку новых задач",
        problem: `Типичный срок закрытия задачи – ${fmtDecimal(days, 1, { trim: true })} ${daysWord(days)}. Назначьте ответственного за разбор, добавьте шаблоны и метки приоритета.`,
        expectedImpact: categoryImpact("Задачи"),
      };
    }
    default:
      return null;
  }
}

/**
 * Параметры шаблона правила из эффективных фактов скана (те же, что видел
 * движок при записи). Presence-прирост и его причина — из сохраненных
 * колонок (`delta`, `reason`), они не восстанавливаются из фактов.
 */
export function recommendationParams(ruleId: string, ok: Map<string, unknown>, extra: RecommendationParams = {}): RecommendationParams {
  const p: RecommendationParams = { ...extra };
  if (ruleId === "readme-sections-missing") {
    const readme = ok.get("docs.readme") as { flags?: Record<string, unknown>; present?: unknown } | undefined;
    if (readme && readme.present !== false) {
      const flags = readme.flags ?? {};
      p.missing = (["install", "build", "test"] as ReadmeSection[]).filter((k) => flags[k] !== true);
    }
  }
  if (ruleId === "speed-up-pipeline") {
    const runs = ok.get("cicd.runs") as { duration_p50?: unknown } | undefined;
    if (typeof runs?.duration_p50 === "number") p.minutes = runs.duration_p50 / 60;
  }
  if (ruleId === "appsec-critical") {
    const appsec = ok.get("appsec.findings") as { secrets_critical?: unknown } | undefined;
    if (appsec) p.secrets = appsec.secrets_critical === true;
  }
  if ((ruleId === "appsec-critical" || ruleId === "appsec-high") && ok.has("appsec.findings")) {
    Object.assign(p, appsecFixEffect(ok, ruleId === "appsec-critical" ? "critical" : "high"));
  }
  if (ruleId === "resolve-old-todos") {
    const todo = ok.get("code.todo") as { older_180d?: unknown; count?: unknown; fixme?: unknown } | undefined;
    if (todo) {
      p.total = ((todo.count ?? 0) as number) + ((todo.fixme ?? 0) as number);
      p.older = (todo.older_180d ?? 0) as number;
    }
  }
  if (ruleId === "reduce-stale-issues" || ruleId === "speed-up-issue-close") {
    const stats = ok.get("issues.stats") as { open?: unknown; stale_90d?: unknown; median_close_days?: unknown } | undefined;
    if (stats && typeof stats.open === "number" && stats.open > 0) p.percent = Math.round((((stats.stale_90d ?? 0) as number) / Math.max(1, stats.open)) * 100);
    if (typeof stats?.median_close_days === "number") p.days = stats.median_close_days;
  }
  return p;
}

/** Порядок score-правил – общий для движка и объединенной выдачи карточки. */
export const SCORE_RULE_ORDER = ["appsec-critical", "fix-red-runs", "appsec-high", "ci-never-ran", "speed-up-pipeline", "resolve-old-todos", "reduce-stale-issues", "speed-up-issue-close"];

/**
 * Правила серьезности – первыми во всей выдаче, до presence: утечки секретов и
 * критичные находки AppSec (`appsec-critical`), затем красный CI. Как в примере
 * ТЗ 3.3: критичная уязвимость – высокий приоритет, а не шестая строка после
 * «Добавьте CODEOWNERS».
 */
export const SEVERITY_RULES = ["appsec-critical", "fix-red-runs"];

interface Orderable {
  ruleId: string;
  kind: string;
  deltaScore: number | null;
  opensCategory: string | null;
  priority: number;
}

/**
 * Порядок выдачи. Вход – одна или несколько выдач, каждая уже в порядке движка
 * (у карточки: сохраненные публичные правила и канальные правила на показанных
 * фактах). presence с числовым Δ – по убыванию Δ, затем rule_id; presence со
 * скрытым Δ (null) – после них по rule_id (позиция не раскрывает величину);
 * активационные – по весу категории по убыванию, затем rule_id; score-правила –
 * слиянием выдач по SCORE_RULE_ORDER (правило вне списка сохраняет место в своей
 * выдаче). Правила серьезности (SEVERITY_RULES) – в начало всей выдачи, прочие
 * score-правила – в конец. Номера 1..N.
 */
export function orderRecommendations<T extends Orderable>(...lists: T[][]): T[] {
  const all = lists.flat();
  const presence = all.filter((r) => r.kind === "presence");
  const activation = all.filter((r) => r.kind === "activation");
  presence.sort((a, b) => {
    if (a.deltaScore === null || b.deltaScore === null) {
      if (a.deltaScore !== b.deltaScore) return a.deltaScore === null ? 1 : -1;
      return a.ruleId.localeCompare(b.ruleId);
    }
    return b.deltaScore - a.deltaScore || a.ruleId.localeCompare(b.ruleId);
  });
  activation.sort(
    (a, b) =>
      SCORE_WEIGHTS[(b.opensCategory ?? "issues") as CategoryKey] - SCORE_WEIGHTS[(a.opensCategory ?? "issues") as CategoryKey] ||
      a.ruleId.localeCompare(b.ruleId),
  );
  let scoreRules: T[] = [];
  for (const list of lists) {
    const next = list.filter((r) => r.kind === "score");
    const merged: T[] = [];
    let i = 0;
    let j = 0;
    while (i < scoreRules.length || j < next.length) {
      if (j >= next.length) merged.push(scoreRules[i++]!);
      else if (i >= scoreRules.length) merged.push(next[j++]!);
      else {
        const ra = SCORE_RULE_ORDER.indexOf(scoreRules[i]!.ruleId);
        const rb = SCORE_RULE_ORDER.indexOf(next[j]!.ruleId);
        if (ra !== -1 && rb !== -1 && rb < ra) merged.push(next[j++]!);
        else merged.push(scoreRules[i++]!);
      }
    }
    scoreRules = merged;
  }
  const severity = SEVERITY_RULES.flatMap((id) => scoreRules.filter((r) => r.ruleId === id));
  const rest = scoreRules.filter((r) => !SEVERITY_RULES.includes(r.ruleId));
  const out = [...severity, ...presence, ...activation, ...rest];
  out.forEach((r, i) => (r.priority = i + 1));
  return out;
}

export function recommend(db: Database, scanId: number, opts: RecommendOptions = {}): Recommendation[] {
  const scores = opts.scores ?? compute(db, scanId, { now: opts.now });
  // те же факты, из которых посчитан Score (включая замещение историей):
  // рекомендация не противоречит числу на карточке
  const eff = effectiveFacts(db, scanId, scores.repoId);
  const ok = eff.ok;

  // ---------- presence-правила (реальный Δ итога) ----------
  // Δ = итог на подмененных фактах минус итог на фактах скана: правила без канала –
  // к HealthCraft Index (4 категории, с перенормировкой), канальные – к полному
  // Score (с капом 49). Один вызов computeFromFacts на правило; подмены –
  // таблица `presencePatches`.
  const now = opts.now ?? new Date(scores.computedAt);
  const input = { scanId, repoId: scores.repoId, stale: eff.stale, staleCats: eff.staleCats, emptyRepo: eff.emptyRepo };
  const base = computeFromFacts(ok, input, now);
  const realDelta = factsDeltaEvaluator(ok, input, now, base);
  const categoryScores = Object.fromEntries(Object.entries(base.categories).map(([k, c]) => [k, c.score])) as Record<CategoryKey, number | null>;
  return recommendFromFacts(ok, { delta: realDelta, issuesScore: scores.categories.issues.score, codeEmpty: base.codeEmpty, categoryScores, authors: authorsOf(scores.categories.activity) });
}

/**
 * Реальный прирост правила: итог на подмененных фактах минус итог `base` на
 * исходных. Отдельная функция, чтобы лестница (`score/ladder.ts`) считала Δ шага
 * той же формулой, что движок.
 */
export function factsDeltaEvaluator(ok: Map<string, unknown>, input: ComputeInput, now: Date, base: Scores = computeFromFacts(ok, input, now)): DeltaEvaluator {
  const caps = totalCapFlags(ok.get("appsec.findings"));
  return (channel, patch) => {
    const facts = new Map(ok);
    patch(facts);
    const after = computeFromFacts(facts, input, now);
    const pick = (s: Scores) => (channel === null ? s.healthcraftIndex : s.repoHealthScore);
    if (base.codeEmpty) return { delta: 0, reason: "code-empty" };
    const b = pick(base);
    const a = pick(after);
    if (b === null || a === null) return { delta: 0, reason: "no-total" };
    const delta = round4(a - b);
    if (delta === 0 && channel !== null) {
      if (caps.secretsCritical && b >= SECRETS_CRITICAL_TOTAL_CAP) return { delta: 0, reason: "cap" };
      if (caps.criticalOpen && b >= CRITICAL_FINDINGS_TOTAL_CAP) return { delta: 0, reason: "cap-critical" };
    }
    return { delta, reason: null };
  };
}

/** Подмена фактов «совет выполнен». */
export type FactsPatch = (facts: Map<string, unknown>) => void;

/**
 * Presence-правило как данные: условие срабатывания уже проверено на фактах,
 * `patch` – подмена «совет выполнен». ОДНА таблица для движка
 * (`recommendFromFacts`) и лестницы (`score/ladder.ts`): лестница не может
 * разойтись с рекомендациями ни условием, ни подменой.
 */
export interface PresencePatch {
  ruleId: string;
  factRefs: string[];
  patch: FactsPatch;
  /** null – публичное правило (Δ к HealthCraft Index) */
  channel: RecommendationChannel | null;
  /** CI: запуски не видны или все идут – числа нет, эффект словами */
  noRuns?: boolean;
}

/**
 * Presence-правила, чьи условия выполнены на фактах `ok`, в порядке движка.
 * `pub` – включать публичные правила (без канала); `codeScored` – категория «Код»
 * оценена (условие `add-tests`). CI-правила (канал cicd) – всегда.
 */
export function presencePatches(ok: Map<string, unknown>, opts: { pub: boolean; codeScored: boolean }): PresencePatch[] {
  const out: PresencePatch[] = [];
  const withPresence = (field: keyof DocsPresenceValue) => (facts: Map<string, unknown>) => {
    facts.set("docs.presence", { ...(facts.get("docs.presence") as DocsPresenceValue), [field]: true });
  };

  const presence_ = ok.get("docs.presence") as DocsPresenceValue | undefined;
  if (opts.pub && presence_) {
    // тот же признак, что в расчете (`licensePresent`): лицензия под именем
    // COPYING в старых фактах уже учтена в балле, и совета с «+0» нет
    if (!licensePresent(ok)) out.push({ ruleId: "license-missing", factRefs: ["docs.presence"], patch: withPresence("license"), channel: null });
    if (presence_.contributing !== true) out.push({ ruleId: "contributing-missing", factRefs: ["docs.presence"], patch: withPresence("contributing"), channel: null });
    if (presence_.codeowners !== true) out.push({ ruleId: "codeowners-missing", factRefs: ["docs.presence"], patch: withPresence("codeowners"), channel: null });
    const readme = ok.get("docs.readme") as DocsReadmeValue | undefined;
    if (presence_.readme !== true) {
      // обещаем только появление README: присутствие без объема и разделов
      out.push({
        ruleId: "readme-missing",
        factRefs: ["docs.presence", "docs.readme"],
        patch: (facts) => {
          withPresence("readme")(facts);
          facts.set("docs.readme", { present: true, bytes: 0, flags: {} });
        },
        channel: null,
      });
    } else if (readme && (readme as { present?: boolean }).present !== false) {
      const flags = readme.flags ?? {};
      const missing = ["install", "build", "test"].filter((k) => flags[k as keyof typeof flags] !== true);
      if (missing.length > 0) {
        out.push({
          ruleId: "readme-sections-missing",
          factRefs: ["docs.readme"],
          patch: (facts) => {
            const current = facts.get("docs.readme") as { flags?: Record<string, unknown> };
            facts.set("docs.readme", { ...current, flags: { ...(current.flags ?? {}), ...Object.fromEntries(missing.map((k) => [k, true])) } });
          },
          channel: null,
        });
      }
    }
  }
  // «Код» оценен, сборщик посчитал тесты, и непустых нет. Эффект – реальный
  // пересчет с тестами в 10% файлов кода; «Тесты» – бонус, и если он балл не
  // поднимает, совета с «+0» нет (фильтр `delta > 0` у всех presence-правил)
  const treeFact = ok.get("tree.stats") as { source_files?: unknown; test_files?: unknown } | undefined;
  if (opts.pub && opts.codeScored && treeFact && treeFact.test_files === 0 && typeof treeFact.source_files === "number" && treeFact.source_files > 0) {
    const sourceFiles = treeFact.source_files;
    out.push({
      ruleId: "add-tests",
      factRefs: ["tree.stats"],
      patch: (facts) => {
        facts.set("tree.stats", { ...(facts.get("tree.stats") as object), test_files: Math.max(1, Math.round(sourceFiles * ADD_TESTS_SHARE)) });
      },
      channel: null,
    });
  }
  const cicdCfg = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown; steps_note?: unknown } | undefined;
  // CI-правила – канал cicd: вес CI есть только в полном Score, поэтому правило
  // видит лишь зритель с доступом к CI
  if (cicdCfg && !ciUnparsedOf(cicdCfg) && !(cicdCfg.has_ci_yaml === true && cicdCfg.has_steps === true)) {
    const hasYaml = cicdCfg.has_ci_yaml === true;
    const runsFact = ok.get("cicd.runs");
    // запуски видны, но все идут (ни одного завершенного): CI после правки будет
    // «нет данных», и число дала бы перенормировка, а не CI
    const rp = runsFact as { runs_count?: unknown; runs_total?: unknown } | undefined;
    const runsPending = rp !== undefined && rp.runs_count === 0 && typeof rp.runs_total === "number" && rp.runs_total > 0;
    out.push({
      ruleId: hasYaml ? "ci-no-steps" : "ci-missing",
      factRefs: ["cicd.configs"],
      patch: (facts) => {
        facts.set("cicd.configs", hasYaml ? { ...(facts.get("cicd.configs") as object), has_steps: true } : { has_ci_yaml: true, has_steps: true });
      },
      channel: "cicd",
      // запуски не видны – CI «нет данных» при любом конфиге, и совет не обещает
      // числа: прирост дала бы перенормировка, а не CI
      noRuns: runsFact === undefined || runsPending,
    });
  }
  return out;
}

/** ci.yaml не разобран – неизвестно, есть ли шаги; совета «добавьте команды» нет, как нет и балла. */
function ciUnparsedOf(cicdCfg: { has_ci_yaml?: unknown; has_steps?: unknown; steps_note?: unknown } | undefined): boolean {
  return cicdCfg?.has_ci_yaml === true && (typeof cicdCfg.has_steps !== "boolean" || typeof cicdCfg.steps_note === "string");
}

/**
 * Публичные активационные правила (без числа, «открывает категорию»), чьи
 * условия выполнены на фактах, – одно условие для движка и лестницы.
 */
export function publicActivationRules(ok: Map<string, unknown>): { ruleId: string; opens: CategoryKey; factRefs: string[] }[] {
  const stats = ok.get("issues.stats") as { open?: unknown; closed?: unknown } | undefined;
  return stats && (stats.open ?? 0) === 0 && (stats.closed ?? 0) === 0 ? [{ ruleId: "start-tracker", opens: "issues", factRefs: ["issues.stats"] }] : [];
}

/** Чистый движок правил на эффективных фактах (без БД). */
export function recommendFromFacts(ok: Map<string, unknown>, ctx: RecommendFactsContext): Recommendation[] {
  const pub = ctx.only !== "channel";
  if (ctx.codeEmpty === true) return pub ? [act("add-code", "code", ["tree.stats"], {})] : [];
  const realDelta = ctx.delta;
  // скор-правило – только у оцененной категории (без сведений о баллах – без фильтра)
  const scored = (cat: CategoryKey): boolean => ctx.categoryScores === undefined || (ctx.categoryScores[cat] ?? null) !== null;
  const presence: Recommendation[] = [];
  const activation: Recommendation[] = [];
  const scoreRules: Recommendation[] = [];
  const presenceRule = (ruleId: string, factRefs: string[], patch: FactsPatch, channel: RecommendationChannel | null = null) => {
    const real = realDelta(channel, patch);
    // рекомендация с эффектом «+0,0» не выводится вовсе – ни без причины, ни с ней
    // (cap 49, итог NULL): совет, который пересчет не подтверждает числом, – не
    // рекомендация. Отрицательная дельта (перенормировка против совета) отсекается
    // тем же порогом.
    if (real.delta <= 0) return;
    const texts = recommendationText(ruleId, recommendationParams(ruleId, ok, { delta: real.delta, reason: real.reason, channel, authors: ctx.authors }))!;
    presence.push({ ruleId, kind: "presence", priority: 0, ...texts, factRefs, deltaScore: real.delta, opensCategory: null, channel });
  };

  // условия и подмены presence-правил – таблица `presencePatches` (общая с лестницей)
  for (const p of presencePatches(ok, { pub, codeScored: scored("code") })) {
    if (p.noRuns) {
      const texts = recommendationText(p.ruleId, recommendationParams(p.ruleId, ok, { reason: "no-runs", channel: p.channel }))!;
      presence.push({ ruleId: p.ruleId, kind: "presence", priority: 0, ...texts, factRefs: p.factRefs, deltaScore: null, opensCategory: null, channel: p.channel });
    } else {
      presenceRule(p.ruleId, p.factRefs, p.patch, p.channel);
    }
  }
  const cicdCfg = ok.get("cicd.configs") as { has_ci_yaml?: unknown; has_steps?: unknown; steps_note?: unknown } | undefined;
  const ciUnparsed = ciUnparsedOf(cicdCfg);
  const runsFact = ok.get("cicd.runs");

  // ---------- активационные (без числа; «открывает категорию») ----------
  if (pub) {
    for (const a of publicActivationRules(ok)) activation.push(act(a.ruleId, a.opens, a.factRefs, { issuesScore: ctx.issuesScore ?? 0 }));
  }
  if (!ok.has("appsec.findings")) {
    // нейтральный текст: рекомендацию видит только зритель с доступом к Security,
    // а данных AppSec у скана нет – ни подключения, ни скана
    activation.push(act("connect-appsec", "security", ["appsec.findings"], {}, "appsec"));
  }
  if (!runsFact && cicdCfg?.has_ci_yaml === true && cicdCfg?.has_steps === true) {
    activation.push(act("grant-ci-runs", "cicd", ["cicd.runs", "cicd.configs"], {}, "cicd"));
  }

  // ---------- скор-правила (после появления данных; влияние текстом) ----------
  const score = (ruleId: string, factRefs: string[], channel: RecommendationChannel | null = null) =>
    scoreRules.push(mkScore(ruleId, factRefs, recommendationParams(ruleId, ok), channel));
  // CI-правила – только при ci.yaml со шагами и оцененной CI (те же условия, что
  // у балла): без конфига «почините CI» формула вырастить не может
  const ciDeclared = cicdCfg?.has_ci_yaml === true && cicdCfg.has_steps === true && !ciUnparsed;
  const rc = runsFact as { runs_count?: unknown; runs_total?: unknown } | undefined;
  if (ciDeclared && rc !== undefined && rc.runs_count === 0 && !(typeof rc.runs_total === "number" && rc.runs_total > 0) && scored("cicd")) {
    // запуски видны, их 0 – «CI заявлен, но не запускался»
    score("ci-never-ran", ["cicd.runs", "cicd.configs"], "cicd");
  }
  if (ciDeclared && scored("cicd") && runsFact && typeof (runsFact as { runs_count?: unknown }).runs_count === "number" && (runsFact as { runs_count?: number }).runs_count! > 0) {
    const rf = runsFact as { last_status?: unknown; success_rate?: unknown; weighted_success_rate?: unknown; duration_p50?: unknown };
    // условие – от той же доли, что считает балл (взвешенная свежестью, иначе
    // простая); идущий запуск ошибкой не считается. Поле взвешенной доли есть и
    // пусто – все запуски старше года: балл говорит «за год не запускался», и
    // советов про красный или долгий CI нет
    const staleOnly = "weighted_success_rate" in rf && rf.weighted_success_rate === null;
    const passInput = typeof rf.weighted_success_rate === "number" ? rf.weighted_success_rate : rf.success_rate;
    // last_status – последний ЗАВЕРШЕННЫЙ запуск; провал – по перечню статусов API (runOutcome)
    const lastFailed = runOutcome(typeof rf.last_status === "string" ? rf.last_status : null) === "failure";
    if (!staleOnly && (lastFailed || (typeof passInput === "number" && passInput < 0.9))) score("fix-red-runs", ["cicd.runs"], "cicd");
    if (!staleOnly && typeof rf.duration_p50 === "number" && rf.duration_p50 > 15 * 60) score("speed-up-pipeline", ["cicd.runs"], "cicd");
  }
  const appsec = ok.get("appsec.findings") as AppsecFindingsValue | undefined;
  if (appsec) {
    const crit = (appsec.severity_counts?.critical as number | undefined) ?? 0;
    // утечка секретов – всегда (потолок 49 действует на итог при любой категории);
    // критичные находки – при оцененной «Безопасности» (они держат потолок категории 40)
    if (appsec.secrets_critical === true || (crit > 0 && scored("security"))) score("appsec-critical", ["appsec.findings"], "appsec");
    // открытые high без critical – свой совет (потолок 69)
    const high = (appsec.severity_counts?.high as number | undefined) ?? 0;
    if (crit === 0 && high > 0 && scored("security")) score("appsec-high", ["appsec.findings"], "appsec");
  }
  const todo = ok.get("code.todo") as { older_180d?: unknown; count?: unknown; fixme?: unknown; blamed_files?: unknown; todo_note?: unknown } | undefined;
  if (pub && scored("code") && todo && todo.todo_note !== "incomplete" && typeof todo.blamed_files === "number" && todo.blamed_files > 0) {
    // та же доля, что в балле (derived.ts: знаменатель не меньше OLD_SHARE_MIN_BASE)
    const total = ((todo.count ?? 0) as number) + ((todo.fixme ?? 0) as number);
    const older = (todo.older_180d ?? 0) as number;
    if (total > 0 && older / Math.max(total, OLD_SHARE_MIN_BASE) >= 0.3) score("resolve-old-todos", ["code.todo"]);
  }
  const statsFull = ok.get("issues.stats") as { open?: unknown; closed?: unknown; closed_counted?: unknown; stale_90d?: unknown; median_close_days?: unknown } | undefined;
  const openCount = typeof statsFull?.open === "number" ? statsFull.open : 0;
  // при 0 закрытых (проживших ≥ 1 ч) медианы закрытия нет – «ускорьте закрытие»
  // не про что. «Разберите зависшие» – при открытых зависших независимо от
  // закрытых: совет велит закрыть неактуальные, а закрытие растит засчитанную
  // выборку и снимает сжатие
  const closedCounted = issuesClosedCounted(statsFull) ?? 0;
  if (pub && scored("issues") && statsFull && openCount > 0) {
    const share = ((statsFull.stale_90d ?? 0) as number) / Math.max(1, openCount);
    if (share >= 0.5) score("reduce-stale-issues", ["issues.stats"]);
    if (closedCounted > 0 && typeof statsFull.median_close_days === "number" && statsFull.median_close_days >= 30) score("speed-up-issue-close", ["issues.stats"]);
  }

  return orderRecommendations([...presence, ...activation, ...scoreRules]);
}

/** Показатель «Число авторов» оценки (`activity.contributors`) – для текста CODEOWNERS. */
export function authorsOf(activity: { submetrics?: Record<string, { value?: unknown }> } | undefined): number | null {
  const v = activity?.submetrics?.["contributors"]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function act(ruleId: string, opens: CategoryKey, factRefs: string[], params: RecommendationParams, channel: RecommendationChannel | null = null): Recommendation {
  const texts = recommendationText(ruleId, params)!;
  return { ruleId, kind: "activation", priority: 0, ...texts, factRefs, deltaScore: null, opensCategory: opens, channel };
}

function mkScore(ruleId: string, factRefs: string[], params: RecommendationParams, channel: RecommendationChannel | null = null): Recommendation {
  const texts = recommendationText(ruleId, params)!;
  return { ruleId, kind: "score", priority: 0, ...texts, factRefs, deltaScore: null, opensCategory: null, channel };
}

/** PK (scan_id, model_version, rule_id) – пересчет не дублирует строки. */
export function writeRecommendations(db: Database, scanId: number, modelVersion: string, recs: Recommendation[]): void {
  const stmt = db.query(
    `INSERT OR REPLACE INTO recommendations
       (scan_id, model_version, rule_id, priority, problem, action, fact_ref, expected_impact, delta_score, opens_category, source, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?)`,
  );
  // одна выдача на скан: пересчет заменяет набор целиком (исчезнувшее
  // правило не остается висеть от прошлого прогона)
  db.query("DELETE FROM recommendations WHERE scan_id = ? AND model_version = ?").run(scanId, modelVersion);
  for (const r of recs) {
    stmt.run(scanId, modelVersion, r.ruleId, r.priority, r.problem, r.action, r.factRefs.join(","), r.expectedImpact, r.deltaScore, r.opensCategory, r.channel);
  }
}
