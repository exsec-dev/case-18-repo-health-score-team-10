// Построитель модели отчета по карточке. Чистая функция от ответа
// `/api/repos/{org}/{repo}` — ни БД, ни сети: страница и отчет показывают одно и
// то же из одного источника. Модель общая для MD и PDF (`model.ts`), рендеры —
// `markdown.ts` и `pdf.ts`.
//
// Вердикт, «почему» у категории, ограничения и «Как считается» — шаблоны из
// фактов и баллов (закрытый набор ниже), а не LLM; действия — только
// рекомендации движка. Каждое число отчета прослеживается до факта в
// приложении (А — расчет, Б — источники, В — исходные данные, Г — паспорт анализа).
//
// Порядок разделов: шапка → показатели → вклад категорий → категории →
// рекомендации → ограничения данных → проверка на накрутку и AI-обзор → разбор
// → «Как считается» → приложение (в PDF с новой страницы).
import { CATEGORY_ORDER, CATEGORY_TITLES, CHANNEL_TREE_KEY, type CardCategory, type CardEvidence, type CardRecommendation, type RepoCard } from "../api/repos";
import { COVERAGE_NULL_BELOW, INDEX_WEIGHTS, SCORE_WEIGHTS, SEVERITY_WEIGHTS, SUBWEIGHTS, type CategoryKey } from "../score/model";
import {
  SCORE_SCALE,
  fmtContribution,
  fmtCoverage,
  fmtDateUtc as fmtDate,
  fmtDateTimeUtc as fmtDateTime,
  fmtDecimal,
  fmtLoss,
  fmtScore,
  fmtSigned,
  fullScorePath,
  AI_SECTION_TITLE,
  AI_STALE_REPORT_TEXT,
  FRAUD_EXPLAIN,
  FRAUD_TITLE,
  aiModelName,
  aiNotesStale,
  aiParagraphs,
  aiRoleTitle,
  fraudFactorFact,
  fraudFactorValue,
  fraudCheckStale,
  fraudFactorTitle,
  noDataReason,
  pathText,
  scanStatusText,
  scanTriggerText,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  type Contributions,
  roundScore, AI_DISCLAIMER, AI_OVERVIEW_REJECTED,
  CI_CAP_TEXT,
  CI_CAP_TITLE,
  STALE_CATEGORY_MARK,
  rankText,
} from "../web/format";
import { code, em, escaped, strong, text, type ActionItem, type Block, type CategoryRow, type Chip, type HeroNote, type HeroSecondary, type InlineLine, type ReportModel, type TableColumn } from "./model";
import {
  FULL,
  INDEX,
  PUBLIC,
  RULE_SUBMETRIC,
  adjustmentText,
  categoryWhy,
  closeDateNote,
  analysisDate,
  contributionBar,
  contributionsOf,
  factValue,
  historyTruncatedSince,
  limitations,
  metricsOf,
  sourceWord,
  withValue,
  type Metric,
  type ShownMetric,
  submetricWeightText,
  noRecommendationsText,
  strengthsLine,
  ownershipView,
} from "./sections";
import { displayOnly, submetricContext, submetricNote, submetricShownValue, submetricTitle, subweightKey, type SubmetricContext } from "./submetrics";

// основание, ограничения, вклады и таблица правил живут в `sections.ts` (их
// берет и карточка); `whyText` реэкспортируется для тестов
export { whyText } from "./sections";

/** Текст отказа маршрутов: отчета без оценки нет. */
export const REPORT_NO_SCORE = "Отчет появится после первого анализа: пока у репозитория нет оценки, собирать в документ нечего.";

const DOC = "Отчет HealthCraft";
const NBSP = "\u00a0";
/** Действий на первом экране — не больше трех. */
export const FIRST_ACTIONS = 3;

// ---------- шаблоны (закрытый набор) ----------

/** Действие-кандидат для строки порога: номер в разделе «Рекомендации» и эффект в шкале показателя. */
export interface ThresholdAction {
  n: number;
  action: string;
  delta: number;
}

/**
 * Строка «близко к порогу» — если показатель в пределах 2 баллов от границы зоны.
 * Ниже границы строка называет первое действие, которое одно переводит оценку в
 * следующую зону. Эффекты не складываются — каждый посчитан при прочих равных;
 * `actions` — только с эффектом в шкале этого показателя (`thresholdActions`).
 */
export function thresholdNote(value: number, actions: readonly ThresholdAction[] = []): string | null {
  const v = roundScore(value);
  const [success, warning] = [SCORE_SCALE[0]!, SCORE_SCALE[1]!];
  const bounds: [number, string, string][] = [
    [Number(success.range.split("-")[0]), success.word, warning.word],
    [Number(warning.range.split("-")[0]), warning.word, SCORE_SCALE[2]!.word],
  ];
  for (const [t, upperZone, lowerZone] of bounds) {
    if (v >= t && v - t <= 2) return `${t} – нижняя граница зоны «${upperZone}»: при ${t - 1} баллах оценка относилась бы к зоне «${lowerZone}».`;
    if (v < t && t - v <= 2) {
      const base = `${t - 1} – верхняя граница зоны «${lowerZone}»: при ${t} баллах оценка относилась бы к зоне «${upperZone}».`;
      const lift = actions.find((a) => a.delta > 0 && roundScore(value + a.delta) >= t);
      return lift ? `${base} Рекомендация ${lift.n} одна переводит оценку в эту зону: «${lift.action.replace(/\.\s*$/, "")}» (${fmtSigned(lift.delta)}).` : base;
    }
  }
  return null;
}

/**
 * Действия с эффектом в шкале показателя: у правила без канала эффект
 * посчитан в HealthCraft Index, у канального (CI/CD, AppSec) — в Repo Health Score.
 */
export function thresholdActions(recs: readonly CardRecommendation[], metric: string): ThresholdAction[] {
  return recs.flatMap((r, i) =>
    r.deltaScore !== null && (metric === INDEX ? r.channel === null : r.channel !== null) ? [{ n: i + 1, action: r.action, delta: r.deltaScore }] : [],
  );
}

/** Плашка балла категории/показателя — как `Label` UI. */
export function scoreChip(value: number | null): Chip {
  return { theme: scoreLabelTheme(value), text: value === null ? "Нет данных" : sentence(scoreWord(value)) };
}

/** Строка категории: балл и плашка; основание — `categoryWhy` (одна копия с карточкой). */
function categoryRow(card: RepoCard, key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): CategoryRow {
  const name = CATEGORY_TITLES[key];
  const why = categoryWhy(card, key, ctx);
  // закрытая зрителю категория — «Недоступно», а не «нет данных»
  if (cat.locked !== undefined) return { name, score: null, scoreText: "—", chip: { theme: "unknown", text: "Недоступно" }, why, mark: null };
  // то же условие и тот же текст, что у плашки категории на карточке
  // (`cardView` → `c.stale`, `STALE_CATEGORY_MARK`)
  const mark: Chip | null = cat.stale === true ? { theme: "warning", text: STALE_CATEGORY_MARK } : null;
  if (cat.score === null) return { name, score: null, scoreText: "—", chip: scoreChip(null), why, mark };
  return { name, score: cat.score, scoreText: fmtScore(cat.score), chip: scoreChip(cat.score), why, mark };
}

// ---------- действия ----------

/** Эффект действия: число к показателю — с подписью «ожидаемый эффект»; без числа — словами правила. */
function actionItem(rec: CardRecommendation, n: number): ActionItem {
  const numeric = rec.deltaScore !== null;
  const effect = rec.expectedImpact ?? "повысит балл категории";
  return {
    n,
    title: [escaped(rec.action.replace(/\.\s*$/, ""))],
    why: [escaped(rec.problem)],
    effect,
    effectNote: numeric ? "ожидаемый эффект" : null,
  };
}

// ---------- построитель ----------

const para = (...lines: InlineLine[]): Block => ({ kind: "paragraph", lines });
const line = (value: string): InlineLine => [text(value)];
const h2 = (value: string): Block => ({ kind: "heading", level: 2, content: [text(value)] });
const h3 = (value: string): Block => ({ kind: "heading", level: 3, content: [text(value)] });
const col = (title: string, align: "left" | "right" = "left", width?: number): TableColumn => ({ title, align, width });

/** Модель отчета карточки — общий источник MD и PDF. */
export function buildReportModel(card: RepoCard): ReportModel {
  const slug = `${card.repo.org}/${card.repo.repo}`;
  const dateIso = analysisDate(card);
  const date = dateIso ? fmtDate(dateIso) : null;
  // отчет без оценки не выдается — собирать в документ нечего. Маршруты `.md` и
  // `.pdf` отказывают еще до сборки (`server.ts`), здесь — страховка
  const blocks: Block[] = [headerBlock(card, date)];
  if (!card.score) {
    throw new Error(REPORT_NO_SCORE);
  } else {
    const metrics = metricsOf(card);
    if (withValue(metrics).length === 0) blocks.push(...indexNullSection(card));
    else blocks.push(...scoredSection(card, metrics));
  }
  return {
    title: `Repo Health: ${slug}`,
    fileStem: `${card.repo.org}-${card.repo.repo}-health`,
    footer: `${slug} – ${DOC.charAt(0).toLowerCase()}${DOC.slice(1)}${date ? ` от ${date}` : ""}`,
    runningHead: [slug, `${DOC}${date ? `, ${date}` : ""}`],
    aiSummary: null,
    blocks,
  };
}

/**
 * Плашка рядом с названием документа: «Полная оценка», когда зрителю доступен
 * Repo Health Score, иначе «Публичная оценка». Без оценки доступ еще не
 * известен — плашки нет.
 */
function docChip(card: RepoCard): Chip | null {
  if (!card.score) return null;
  // плашка называет оценку, а не репозиторий: просто «Публичный» путался бы с
  // видимостью репозитория на карточке
  return { theme: "unknown", text: card.score.fullLocked ? "Публичная оценка" : "Полная оценка" };
}

function headerBlock(card: RepoCard, date: string | null): Block {
  const { repo } = card;
  const host = repo.webUrl.replace(/^https?:\/\//, "");
  return {
    kind: "header",
    slug: `${repo.org}/${repo.repo}`,
    title: repo.title && repo.title !== repo.repo ? [em(repo.title)] : null,
    link: { text: host, url: repo.webUrl },
    doc: DOC,
    docChip: docChip(card),
    date,
  };
}

/**
 * Путь к полной оценке — той же строкой, что под закрытым Repo Health Score на
 * карточке (`fullScorePath`), по типу зрителя; в документе без ссылки.
 */
function fullPathText(card: RepoCard): string {
  return pathText(fullScorePath(card.viewer?.auth, [card.access.cicd, card.access.appsec]));
}

/**
 * Предупреждение «CI настроен, но запусков не видно»: на карточке оно внизу
 * плашки Repo Health Score, в отчете — строкой под показателями, тем же текстом
 * (`CI_CAP_*`) и при том же признаке (`markers.ciConfigOnlyCap`). Так отчет
 * говорит об этом в тех же местах, что карточка: у показателя, в основании
 * CI/CD и в рекомендации.
 */
function ciCapNotes(card: RepoCard): HeroNote[] {
  return card.markers.ciConfigOnlyCap ? [{ line: [strong(`${CI_CAP_TITLE}.`), text(` ${CI_CAP_TEXT}`)] }] : [];
}

// ---------- оценка есть, индекса нет (покрытие ниже порога) ----------

function indexNullSection(card: RepoCard): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const collected = fmtCoverage(score.indexCoverage);
  const threshold = fmtCoverage(COVERAGE_NULL_BELOW);
  const notes: HeroNote[] = [{ line: line("Отсутствие оценки означает недостаток данных, а не плохое состояние репозитория.") }];
  if (score.fullLocked) notes.push({ line: line(`Полная оценка ${FULL}, включающая CI/CD и Безопасность, видна участникам репозитория. ${fullPathText(card)}`), info: true });
  notes.push(...ciCapNotes(card));
  const out: Block[] = [
    {
      kind: "hero",
      label: INDEX,
      value: null,
      noneText: "Оценки нет",
      chip: null,
      secondary: null,
      verdict: `Собрано ${collected} данных, а оценка рассчитывается начиная с ${threshold}.`,
      notes,
    },
    { kind: "coverage", title: "Объем собранных данных", share: score.indexCoverage, threshold: COVERAGE_NULL_BELOW, collected: `собрано ${collected}`, thresholdText: `порог ${threshold}: с него рассчитывается оценка` },
    // те же имена разделов, что в обычном отчете и на карточке
    h2("Категории"),
    // сильные и слабые стороны — одна копия с карточкой
    ...(strengthsLine(card) !== null ? [para(line(strengthsLine(card)!))] : []),
    categoriesBlock(card, ctx),
    h2("Рекомендации"),
  ];
  if (card.recommendations.length > 0) out.push({ kind: "actions", compact: false, items: card.recommendations.map((r, i) => actionItem(r, i + 1)) });
  // без рекомендаций — та же фраза, что на карточке
  else out.push(para(line(noRecommendationsText(card))));
  out.push(para(line(`Оценка рассчитывается при объеме данных от ${threshold}.`)));
  const limits = limitations(card);
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));
  // проверка на накрутку и AI-обзор — после ограничений данных, до разбора и приложений
  out.push(...fraudBlock(card), ...aiBlock(card));
  out.push(...appendix(card, []));
  return out;
}

// ---------- полный отчет ----------

function scoredSection(card: RepoCard, metrics: Metric[]): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const shown = withValue(metrics);
  const contributions = new Map(shown.map((m) => [m.name, contributionsOf(card, m)] as const));
  const notes: HeroNote[] = [];
  // строка «близко к порогу» относится к конкретному числу: когда чисел два,
  // она называет свой показатель
  for (const m of shown) {
    const near = thresholdNote(m.value, thresholdActions(card.recommendations, m.name));
    if (near) notes.push({ line: line(shown.length > 1 ? `${m.name}: ${near}` : near) });
  }
  // пояснение к числам — одной строкой под обоими показателями, с иконкой
  // информации; публичный показатель и здесь называется первым
  const hasIndex = shown.some((m) => m.name === INDEX);
  const hasFull = shown.some((m) => m.name === FULL);
  const publicFirst = `${INDEX} считается по открытым данным – по нему строится рейтинг.`;
  notes.push({
    line: line(
      hasIndex && hasFull
        ? `${publicFirst} ${FULL} учитывает 6 категорий, включая CI/CD и Безопасность.`
        : hasIndex
          ? score.fullLocked
            ? `${publicFirst} Полная оценка ${FULL}, включающая CI/CD и Безопасность, видна участникам репозитория. ${fullPathText(card)}`
            : `${publicFirst} ${FULL}: данных для оценки недостаточно.`
          : // полный доступ есть, индекса нет
            `${INDEX} считается по открытым данным – по нему строится рейтинг, но открытых данных собрано меньше ${fmtCoverage(COVERAGE_NULL_BELOW)}, поэтому он не рассчитан. ${FULL} учитывает 6 категорий, включая CI/CD и Безопасность.`,
    ),
    info: true,
  });
  notes.push(...ciCapNotes(card));
  const head = metrics[0]!;
  const second = metrics[1];
  const secondary: HeroSecondary | null = second
    ? { label: second.name, value: second.value === null ? null : roundScore(second.value), noneText: "Оценки нет", chip: second.value === null ? null : scoreChip(second.value), note: null }
    : null;
  const out: Block[] = [
    {
      kind: "hero",
      label: head.name,
      value: head.value === null ? null : roundScore(head.value),
      noneText: "Оценки нет",
      chip: head.value === null ? null : scoreChip(head.value),
      secondary,
      // общего вывода под оценкой в отчете нет
      verdict: null,
      notes,
    },
    // полос вклада столько же, сколько показателей со значением, и в том же
    // порядке: сначала публичный
    ...shown.map((m) => contributionsBlock(contributions.get(m.name)!, m.name)),
    h2("Категории"),
    // сильные и слабые стороны — одна копия с карточкой
    ...(strengthsLine(card) !== null ? [para(line(strengthsLine(card)!))] : []),
    categoriesBlock(card, ctx),
  ];
  // раздел рекомендаций один и стоит сразу после категорий
  const recs = card.recommendations;
  out.push(h2("Рекомендации"));
  if (recs.length === 0) {
    out.push(para(line(noRecommendationsText(card))));
  } else {
    // без вводной строки: порядок рекомендаций не обещает «по убыванию влияния»
    out.push({ kind: "actions", compact: true, items: recs.map((r, i) => actionItem(r, i + 1)) });
  }
  const limits = limitations(card);
  // ограничения данных — такие же примечания на подложке, как под таблицами
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));
  // проверка на накрутку и AI-обзор — после ограничений данных, до разбора и приложений
  out.push(...fraudBlock(card), ...aiBlock(card));

  out.push(...detailSection(card, ctx));
  out.push(...methodSection(shown, contributions));
  out.push(...appendix(card, shown));
  return out;
}

function recWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "рекомендация" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "рекомендации" : "рекомендаций";
}

/** Шкала 3 зон под полосой: слева направо — от риска к здоровью (легенда `SCORE_SCALE`). */
function zones(): { theme: "danger" | "warning" | "success"; text: string; share: number }[] {
  return [...SCORE_SCALE].reverse().map((z) => {
    const [from, to] = z.range.split("-").map(Number) as [number, number];
    return { theme: z.theme, text: `${z.word} ${z.range}`, share: (to === 100 ? to - from : to - from + 1) / 100 };
  });
}

function contributionsBlock(c: Contributions | null, metricName?: string): Block {
  // заголовок, сегменты и строка вместо полосы — общие с карточкой (`sections.ts`)
  const bar = contributionBar(c, metricName);
  return { kind: "contributions", title: bar.title, segments: bar.segments.map(({ title, value, share }) => ({ title, value, share })), rest: bar.rest, zones: zones(), note: bar.note };
}

function categoriesBlock(card: RepoCard, ctx: SubmetricContext): Block {
  const cats = card.score!.categories;
  return {
    kind: "categories",
    columns: ["Категория", "Балл", "Уровень", "Основание"],
    rows: CATEGORY_ORDER.filter((k) => cats[k] !== undefined).map((k) => categoryRow(card, k, cats[k]!, ctx)),
  };
}

// ---------- разбор по категориям ----------

function detailSection(card: RepoCard, ctx: SubmetricContext): Block[] {
  const cats = card.score!.categories;
  const keys = CATEGORY_ORDER.filter((k) => cats[k] !== undefined);
  const withData = keys.filter((k) => cats[k]!.locked === undefined && cats[k]!.score !== null).sort((a, b) => cats[a]!.score! - cats[b]!.score! || keys.indexOf(a) - keys.indexOf(b));
  const without = keys.filter((k) => !withData.includes(k));
  const actionOf = new Map<string, number>();
  card.recommendations.forEach((r, i) => {
    const target = RULE_SUBMETRIC[r.ruleId];
    if (target && !actionOf.has(target)) actionOf.set(target, i + 1);
  });
  const out: Block[] = [h2("Разбор по категориям")];
  for (const key of withData) {
    out.push(detailBlock(card, key, cats[key]!, ctx, actionOf));
    // карта владельцев — под разбором «Состояния кода»
    if (key === "code") out.push(...ownershipBlocks(cats[key]!));
  }
  for (const key of without) {
    const row = categoryRow(card, key, cats[key]!, ctx);
    out.push({ kind: "detail", title: row.name, scoreText: "—", chip: row.chip, table: null, notes: [line(row.why)] });
  }
  return out;
}

/**
 * Карта владельцев файлов — подпись, таблица (4 колонки, как все таблицы
 * основного текста) и сноска. Сборка строк — `ownershipView` (одна копия с карточкой); имена
 * каталогов и авторов — внешние строки, экранируются (`escaped`); длинное имя
 * в PDF переносится (`breakable` ячеек таблицы).
 */
function ownershipBlocks(cat: CardCategory): Block[] {
  const view = ownershipView(cat);
  if (!view) return [];
  return [
    { kind: "paragraph", tone: "caption", lines: [line(view.caption)] },
    {
      kind: "table",
      columns: [col("Каталог", "left", 170), col("Главный автор", "left", 170), col("Доля главного автора", "right", 90), col("Авторов", "right")],
      rows: view.rows.map((r) => [[escaped(r.dir)], [escaped(r.owner)], line(r.single ? `${r.share}, единственный` : r.share), line(r.authors)]),
    },
    { kind: "paragraph", tone: "fine", lines: [line(view.notes.join(" "))] },
  ];
}

/** Причина «данных нет» из самого факта (`{reason, detail}` реестра фактов) — по-русски. */
const NO_DATA_FACT_REASON: Record<string, string> = {
  access: "у сервиса нет прав на эти данные",
  limits: "данные больше лимита сервиса",
  empty: "источник вернул пустой ответ",
  "no-scan": "проверка не запускалась",
  incomplete: "источник отдал данные не полностью",
  "bad-channel": "источник не ответил",
  other: "источник данных не дал",
};

function noDataFactReason(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as { reason?: unknown }).reason;
  return typeof raw === "string" ? (NO_DATA_FACT_REASON[raw] ?? null) : null;
}

/** Число из факта — только настоящее число (сырые поля бывают строками и null). */
const numOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Примечание, которое делает число категории пересчитываемым вручную: окно
 * частоты коммитов и веса важности в плотности находок (без них «38 на 10 тыс.
 * строк» не сходится с числом находок).
 */
function categoryRemark(card: RepoCard, key: CategoryKey, cat: CardCategory): string | null {
  if (key === "activity") {
    const freq = numOf(cat.submetrics["freq"]?.value);
    const c90 = numOf(cat.submetrics["commits_90d"]?.value);
    if (freq === null || c90 === null) return null;
    return `Частота коммитов считается по последним 90 дням: ${fmtDecimal(c90, 0)} ÷ 3 = ${fmtDecimal(freq, 1, { trim: true })} в месяц. Коммиты за год показаны справочно и в балл не входят.`;
  }
  if (key === "security") {
    const per10k = numOf(cat.submetrics["density"]?.value);
    if (per10k === null) return null;
    const counts = (factValue(card, "appsec.findings")?.severity_counts ?? null) as Record<string, unknown> | null;
    // плотность считается по дереву того скана, по которому взяты находки;
    // делитель — строки кода (`source_loc`), у старых фактов — весь `loc`
    const codeLines = (v: Record<string, unknown> | null): number | null => (v === null ? null : "source_loc" in v ? numOf(v.source_loc) : numOf(v.loc));
    const loc = codeLines(factValue(card, CHANNEL_TREE_KEY)) ?? codeLines(factValue(card, "tree.stats"));
    if (counts === null || loc === null || loc <= 0) return null;
    const words: Record<string, string> = { critical: "критичная", high: "высокая", medium: "средняя", low: "низкая" };
    const parts: string[] = [];
    let weighted = 0;
    for (const [level, weight] of Object.entries(SEVERITY_WEIGHTS)) {
      const n = numOf(counts[level]) ?? 0;
      if (n === 0) continue;
      weighted += weight * n;
      parts.push(`${words[level] ?? level} ${n} × ${weight}`);
    }
    if (parts.length === 0) return null;
    return `Находки считаются с весом важности: ${parts.join(", ")} = ${fmtDecimal(weighted, 1, { trim: true })} на ${fmtDecimal(loc, 0)} строк кода, то есть ${fmtDecimal(per10k, 1, { trim: true })} на 10 тыс. строк.`;
  }
  return null;
}

function detailBlock(card: RepoCard, key: CategoryKey, cat: CardCategory, ctx: SubmetricContext, actionOf: Map<string, number>): Block {
  const rows: InlineLine[][] = [];
  const reference: string[] = [];
  const remarks: string[] = [];
  for (const [sub, entry] of Object.entries(cat.submetrics)) {
    const value = submetricShownValue(key, sub, entry, ctx, cat.submetrics);
    const remark = submetricNote(key, sub, entry.note)?.remark;
    if (remark) remarks.push(remark);
    if (displayOnly(key, sub)) {
      if (value !== "—") reference.push(`${submetricTitle(key, sub)} – ${value}`);
      continue;
    }
    const action = actionOf.get(`${key}.${sub}`);
    rows.push([
      line(submetricTitle(key, sub)),
      action ? [text(value), text(` (действие ${action})`)] : line(value),
      line(entry.score === null || entry.score === undefined ? "—" : String(Math.round(entry.score * 100))),
      line(submetricWeightText(key, sub)),
    ]);
  }
  if (key === "cicd" && cat.no_data) remarks.push(noDataReason(key, cat.no_data));
  // сжатие малой выборки и потолок — своей фразой
  const adjusted = adjustmentText(cat);
  if (adjusted) remarks.push(adjusted);
  // причина нехватки данных CI одна и берется из самого факта — теми же словами,
  // что в приложении В
  if (key === "cicd") {
    const runs = card.evidence.find((e) => e.key === "cicd.runs");
    const why = runs && runs.status !== "ok" ? noDataFactReason(runs.value) : null;
    if (why) remarks.push(`Результаты запусков CI сервис не получил: ${why}. Та же причина стоит в приложении В, у исходных данных о запусках.`);
  }
  if (key === "issues") {
    const close = closeDateNote(card);
    if (close) remarks.push(close);
  }
  const extra = categoryRemark(card, key, cat);
  if (extra) remarks.push(extra);
  const notes: InlineLine[] = [];
  for (const r of remarks) notes.push([text("Примечание. "), text(r)]);
  if (reference.length > 0) notes.push([text("Справочно, в балл не входит: "), text(`${reference.join("; ")}.`)]);
  return {
    kind: "detail",
    title: CATEGORY_TITLES[key],
    scoreText: fmtScore(cat.score),
    chip: scoreChip(cat.score),
    table: rows.length === 0 ? null : { columns: [col("Показатель", "left", 166), col("Значение", "left", 225), col("Балл", "right", 42), col("Вес", "right", 48)], rows },
    notes,
  };
}

// ---------- как считается ----------

function weightsText(keys: CategoryKey[], weightOf: (k: CategoryKey) => number): string {
  return keys.map((k) => `${CATEGORY_TITLES[k]} ${weightOf(k)}%`).join(", ");
}

function methodSection(shown: ShownMetric[], contributions: Map<string, Contributions | null>): Block[] {
  const indexWeights = weightsText(PUBLIC, (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS]);
  const fullWeights = weightsText(CATEGORY_ORDER, (k) => SCORE_WEIGHTS[k]);
  /** «В этом отчете: …» — только у показателя, который в этом документе посчитан. */
  const sumOf = (name: string): string => {
    const c = contributions.get(name);
    return c?.kind === "bar" ? ` В этом отчете: ${c.segments.map((s) => `${s.title} ${fmtContribution(s.tenths)}`).join(", ")} = ${c.total}.` : "";
  };
  const hasIndex = shown.some((m) => m.name === INDEX);
  const hasFull = shown.some((m) => m.name === FULL);
  // первая строка описывает ровно те показатели, которые есть в этом документе:
  // «из 4 категорий» в полном отчете спорило бы с первым экраном и приложением А
  const first = hasIndex && hasFull
    ? `В отчете 2 показателя: ${INDEX} – по 4 открытым категориям (документация, активность, задачи и состояние кода), ${FULL} – по всем 6, включая CI/CD и Безопасность.`
    : hasFull
      ? `В отчете 1 показатель – ${FULL}: он складывается из 6 категорий (документация, CI/CD, Безопасность, активность, задачи и состояние кода).`
      : "Оценка складывается из 4 категорий: документация, активность, задачи и состояние кода. Участникам репозитория видны еще 2 – CI/CD и Безопасность.";
  const items: InlineLine[] = [
    line(first),
    line("Каждая категория получает балл от 0 до 100 из нескольких показателей. Например, для документации: README, лицензия, CONTRIBUTING, CODEOWNERS."),
    line(`${INDEX} – взвешенное среднее баллов категорий: ${indexWeights}.${sumOf(INDEX)}`),
    line(`${FULL} учитывает 6 категорий: ${fullWeights}. Если в коде найдены утекшие секреты, он не выше 49.${sumOf(FULL)}`),
    line(`Шкала: ${SCORE_SCALE.map((z) => `${z.word} ${z.range}`).join(", ")}.`),
    line(`Категория без данных не получает 0: она в оценке не участвует и ее не снижает. Если данных меньше ${fmtCoverage(COVERAGE_NULL_BELOW)}, оценка не рассчитывается.`),
    line("Популярность (реакции и ответвления) в оценку не входит, качество кода по существу не оценивается – только наблюдаемые признаки ухода за ним. Расчет и исходные данные – в приложении."),
  ];
  return [h2("Как считается"), { kind: "list", items }];
}

// ---------- приложение ----------

const APPENDIX_TITLE = "Приложение. Расчет оценки и исходные данные";

function appendix(card: RepoCard, shown: ShownMetric[]): Block[] {
  const out: Block[] = [{ kind: "appendix", title: APPENDIX_TITLE, intro: "В приложении приведен расчет оценки и источники чисел отчета. Баллы и доли показаны с точностью до десятых." }];
  out.push(...appendixA(card, shown));
  out.push(...appendixB(card, shown));
  out.push(...appendixC(card));
  out.push(...appendixD(card));
  return out;
}

const pct1 = (share: number): string => `${fmtDecimal(share * 100, 1)}%`;

/**
 * Расчет одного показателя: строка на категорию, «Итого» числом. Ширина
 * набора PDF (499 pt) не дает удвоить столбцы одной таблицы, поэтому у
 * каждого показателя своя таблица — публичная первой.
 */
function metricCalc(card: RepoCard, metric: ShownMetric, named: boolean): Block[] {
  const cats = card.score!.categories;
  const contributions = contributionsOf(card, metric);
  const withData = metric.keys.filter((k) => cats[k]?.score !== null && cats[k]?.score !== undefined);
  const wsum = withData.reduce((s, k) => s + metric.weight(k), 0);
  // десятые вкладов берутся из той же функции, что полоса первого экрана
  // (`categoryContributions`, метод наибольшего остатка): иначе приложение и
  // полоса расходятся на 0,1-0,2, а строки не складываются в «Итого»
  const tenths = new Map<string, number>();
  if (contributions !== null && contributions.kind !== "empty") for (const seg of contributions.segments) tenths.set(seg.key, seg.tenths);
  const rows: InlineLine[][] = [];
  let total = 0;
  for (const key of CATEGORY_ORDER) {
    const cat = cats[key];
    if (!cat) continue;
    const inMetric = metric.keys.includes(key);
    if (!inMetric || cat.score === null) {
      // «не входит» — про состав показателя, «нет данных» — про данные: у
      // категории показателя без данных первое читалось как исключение из
      // методики, хотя вес просто перешел к остальным
      rows.push([line(CATEGORY_TITLES[key]), line(cat.score === null ? "—" : fmtDecimal(cat.score, 1)), line(inMetric ? "нет данных" : "не входит"), line("—")]);
      continue;
    }
    const share = metric.weight(key) / wsum;
    const part = tenths.has(key) ? tenths.get(key)! / 10 : cat.score * share;
    total += part;
    rows.push([line(CATEGORY_TITLES[key]), line(fmtDecimal(cat.score, 1)), line(pct1(share)), line(fmtDecimal(part, 1))]);
  }
  const value = roundScore(metric.value);
  const sumText = fmtDecimal(total, 1);
  rows.push([line("Итого"), line(""), line("100%"), line(Number(sumText.replace(",", ".")) === value ? String(value) : `${sumText} ≈ ${value}`)]);
  const out: Block[] = [];
  // подзаголовок нужен, только когда таблиц две: иначе показатель назван в шапке столбца
  if (named) out.push({ kind: "paragraph", tone: "subhead", lines: [[strong(`Расчет ${metric.name}`)]] });
  out.push({
    kind: "table",
    // если таблиц две, каждая подписана показателем — повторять его в шапке столбца незачем
    columns: [col("Категория", "left", 184), col("Балл", "right", 84), col(named ? "Вес" : `Вес в ${metric.name}`, "right", 114), col("Баллов в итог", "right")],
    rows,
    total: true,
  });
  const weights =
    metric.name === INDEX
      ? `Веса ${INDEX}: ${weightsText(PUBLIC, (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS])}.`
      : `Веса ${FULL}: ${weightsText(CATEGORY_ORDER, (k) => SCORE_WEIGHTS[k])}.`;
  const tail = metric.name === INDEX ? " CI/CD и Безопасность в HealthCraft Index не участвуют и его не снижают." : "";
  out.push({
    kind: "paragraph",
    tone: "fine",
    lines: [line(`Баллов в итог = балл × вес. ${weights} Вес категории без данных делится между остальными пропорционально: такая категория в оценке не участвует и ее не снижает.${tail}`)],
  });
  // у репо без кода итог 0 по правилу «кода нет», а не по потолку секретов —
  // строка про AppSec здесь была бы ложной
  if (card.markers.codeEmpty) out.push({ kind: "paragraph", tone: "fine", lines: [line(`Итог – ${value}: в репозитории нет кода, поэтому оценка 0 (правило «кода нет», Q&A №13); баллы категорий выше – справочно.`)] });
  else if (roundScore(total) > value) out.push({ kind: "paragraph", tone: "fine", lines: [line(`Итог ограничен ${value} баллами: AppSec нашел утекшие секреты.`)] });
  return out;
}

function appendixA(card: RepoCard, shown: ShownMetric[]): Block[] {
  const score = card.score!;
  const cats = score.categories;
  const out: Block[] = [h3("А. Расчет итоговой оценки")];
  for (const metric of shown) out.push(...metricCalc(card, metric, shown.length > 1));
  if (shown.length === 0) out.push(...coverageCalc(card));
  for (const key of CATEGORY_ORDER) {
    const cat = cats[key];
    if (!cat || cat.locked !== undefined || cat.score === null) continue;
    out.push(...categoryCalc(key, cat));
  }
  return out;
}

/**
 * Расчет «собрано N% данных» строками, в которых видно каждое число: вес каждой
 * из 4 открытых категорий, есть ли по ней данные, и итог «M из 65».
 */
function coverageCalc(card: RepoCard): Block[] {
  const score = card.score!;
  const cats = score.categories;
  const rows: InlineLine[][] = [];
  let collected = 0;
  let base = 0;
  for (const key of PUBLIC) {
    const weight = SCORE_WEIGHTS[key];
    base += weight;
    const has = cats[key]?.score !== null && cats[key]?.score !== undefined;
    if (has) collected += weight;
    rows.push([line(CATEGORY_TITLES[key]), line(String(weight)), line(has ? "есть" : "нет"), line(has ? String(weight) : "—")]);
  }
  rows.push([line("Итого"), line(String(base)), line(""), line(String(collected))]);
  return [
    { kind: "paragraph", tone: "subhead", lines: [[strong("Объем собранных данных")]] },
    {
      kind: "table",
      columns: [col("Открытая категория", "left", 184), col("Вес", "right", 84), col("Данные", "right", 114), col("Весовых пунктов с данными", "right")],
      rows,
      total: true,
    },
    {
      kind: "paragraph",
      tone: "fine",
      lines: [
        line(
          `Объем данных = вес категорий с данными ÷ вес 4 открытых категорий: ${collected} ÷ ${base} = ${fmtCoverage(score.indexCoverage)}. Веса здесь – веса ${FULL}: в ${INDEX} они пересчитаны на сотню.`,
        ),
      ],
    },
  ];
}

/**
 * Балл категории из показателей: вес × балл; особое правило (трекер пуст) — строкой.
 * CI, у которого видно 0 запусков, — это данные («не запускался»), и он попадает
 * сюда строками таблицы; CI без видимых запусков — категория без данных, сюда не
 * попадает. Поправка к среднему (сжатие малой выборки, потолок «Безопасности») —
 * своей строкой таблицы, чтобы строки складывались в «Итого».
 */
function categoryCalc(key: CategoryKey, cat: CardCategory): Block[] {
  const title: Block = { kind: "paragraph", tone: "subhead", lines: [[strong(`Балл категории ${CATEGORY_TITLES[key]}`)]] };
  if (key === "issues" && "tracker_unused" in cat.submetrics) {
    return [title, { kind: "paragraph", tone: "fine", lines: [line(`Задач в трекере нет, поэтому категория получает минимальный балл: ${fmtDecimal(cat.score!, 1)}.`)] }];
  }
  const weights = SUBWEIGHTS[key] as Record<string, number>;
  const parts = Object.entries(cat.submetrics)
    .filter(([sub, e]) => !displayOnly(key, sub) && typeof e.score === "number" && weights[subweightKey(sub)] !== undefined)
    .map(([sub, e]) => ({ sub, score: e.score as number, w: weights[subweightKey(sub)]! }));
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  if (parts.length === 0 || wsum === 0) return [title, { kind: "paragraph", tone: "fine", lines: [line(`Балл категории – ${fmtDecimal(cat.score!, 1)}.`)] }];
  const rows: InlineLine[][] = parts.map((p) => [line(submetricTitle(key, p.sub)), line(fmtDecimal(p.score * 100, 1)), line(pct1(p.w / wsum)), line(fmtDecimal((p.score * 100 * p.w) / wsum, 1))]);
  const adj = cat.adjustment;
  if (adj) {
    // строка поправки: сколько она сняла со взвешенной суммы (сумма столбца = итог)
    const title =
      adj.kind === "small-sample"
        ? `Мало закрытых задач: ${adj.n} из ${adj.full}`
        : adj.kind === "small-code"
          ? `Мало кода: ${adj.loc} из ${adj.full} строк`
          : `Потолок: открытые находки ${adj.level === "critical" ? "critical" : "high"}`;
    rows.push([line(title), line(""), line(""), line(fmtDecimal(cat.score! - adj.raw, 1))]);
  }
  rows.push([line("Итого"), line(""), line("100%"), line(fmtDecimal(cat.score!, 1))]);
  const out: Block[] = [title, { kind: "table", columns: [col("Показатель", "left", 184), col("Балл", "right", 84), col("Вес", "right", 114), col("Баллов в категорию", "right")], rows, total: true }];
  // в разборе по категориям стоит номинальный вес показателя, здесь — вес после
  // перераспределения; они различаются, только когда у какого-то показателя
  // категории нет данных, — это и объясняет строка
  if (Math.abs(wsum - 1) > 0.0005) {
    const ex = parts[0]!;
    out.push({
      kind: "paragraph",
      tone: "fine",
      lines: [
        line(
          `Показатель без данных в расчет не идет, его вес делится между остальными пропорционально, поэтому доли здесь отличаются от номинальных: у «${submetricTitle(key, ex.sub)}» номинальный вес ${Math.round(ex.w * 100)}% (он и стоит в разборе по категориям), в расчете – ${pct1(ex.w / wsum)}.`,
        ),
      ],
    });
  }
  return out;
}

function sourcesOf(card: RepoCard, key: CategoryKey): string {
  const facts = card.evidence.filter((e) => e.category === key);
  if (facts.length === 0) return `расчет оценки, ${fmtDateTime(card.score!.computedAt)}`;
  const words = [...new Set(facts.map((f) => sourceWord(f.source)))].join(", ");
  const last = facts.map((f) => f.collectedAt).sort().at(-1)!;
  return `${words}, ${fmtDateTime(last)}`;
}

/** Сырое значение подметрики — «поле → значение» (приложение Б, без нового словаря). */
function rawValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  return flatten(value)
    .map(([k, v]) => (k === "" ? v : `${k} ${v}`))
    .join(", ");
}

function appendixB(card: RepoCard, shown: ShownMetric[]): Block[] {
  const score = card.score!;
  const cats = score.categories;
  const rows: InlineLine[][] = [];
  const at = `расчет оценки, ${fmtDateTime(score.computedAt)}`;
  // для двух шкал удваивается только итоговая строка (публичная первой): баллы
  // категорий и их показателей у обеих шкал одни и те же
  if (shown.length > 0) {
    for (const metric of shown) {
      rows.push([
        [strong(`${metric.name} ${roundScore(metric.value)}`)],
        line(`сумма по ${metric.keys.length === PUBLIC.length ? "4 открытым категориям" : "6 категориям"}: балл × вес, приложение А`),
        line("баллы категорий"),
        line(at),
        line("—"),
      ]);
    }
  } else {
    // ссылка на расчет приложения А, где напечатано каждое слагаемое
    rows.push([[strong(`Собрано ${fmtCoverage(score.indexCoverage)} данных`)], line("вес открытых категорий с данными ÷ вес 4 открытых категорий, приложение А"), [code("scores.index_coverage"), text(` → ${fmtDecimal(score.indexCoverage, 3, { trim: true })}`)], line(at), line("—")]);
  }
  const since = historyTruncatedSince(card);
  const truncated = since ? `история загружена с ${fmtDate(since)}` : null;
  const close = closeDateNote(card);
  const ctx = submetricContext(score.computedAt);
  for (const key of CATEGORY_ORDER) {
    const cat = cats[key];
    if (!cat || cat.locked !== undefined || cat.score === null) continue;
    const limit = cat.stale ? "данные прошлого анализа" : key === "cicd" && cat.no_data ? "результаты запусков недоступны" : "—";
    rows.push([[strong(`${CATEGORY_TITLES[key]} ${fmtScore(cat.score)}`)], line("сумма по показателям: балл × вес, приложение А"), [code(`${key}.score`), text(` → ${fmtDecimal(cat.score, 4, { trim: true })}`)], line(at), line(limit)]);
    for (const [sub, entry] of Object.entries(cat.submetrics)) {
      const shown = submetricShownValue(key, sub, entry, ctx, cat.submetrics);
      const subLimit = key === "issues" && sub === "close_days" && close ? "дата закрытия заменена датой изменения" : key === "activity" && truncated ? truncated : "—";
      // «Порядок расчета» у показателя — с каким весом он входит в балл категории
      const weight = (SUBWEIGHTS[key] as Record<string, number>)[subweightKey(sub)];
      // у «Трекер не ведется» веса нет не потому, что он справочный, а потому,
      // что балл категории просто равен его баллу
      const order =
        key === "issues" && sub === "tracker_unused"
          ? "задач в трекере нет: балл категории равен баллу этого показателя, приложение А"
          : displayOnly(key, sub) || weight === undefined
            ? "справочно, в балл не входит"
            : `балл показателя × вес ${fmtDecimal(weight * 100, 0)}% в балле категории`;
      rows.push([
        line(`${submetricTitle(key, sub)}: ${shown}`),
        line(order),
        // `activity.fresh` — метка времени в мс: читателю показывается дата, а не 13 цифр
        [code(`${key}.${sub}`), text(` → ${key === "activity" && sub === "fresh" && typeof entry.value === "number" ? fmtDateTime(new Date(entry.value).toISOString()) : rawValue(entry.value)}${typeof entry.score === "number" ? `; балл ${fmtDecimal(entry.score * 100, 1, { trim: true })}` : ""}`)],
        line(sourcesOf(card, key)),
        line(subLimit),
      ]);
    }
  }
  return [
    h3("Б. Источники чисел отчета"),
    {
      kind: "table",
      columns: [col("Число в отчете", "left", 92), col("Порядок расчета", "left", 90), col("Исходное поле → значение", "left", 130), col("Источник, время", "left", 84), col("Ограничение")],
      rows,
      small: true,
    },
  ];
}

// ---------- В. исходные данные: таблицы «поле – значение», без JSON ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function scalarText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : fmtDecimal(v, 4, { trim: true });
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v === "string") return ISO_DATE.test(v) ? (v.length === 10 ? fmtDate(v) : fmtDateTime(v)) : v;
  return String(v);
}

function countWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "значение" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "значения" : "значений";
}

/** Значение факта → пары «поле – значение»: объекты раскрываются по точке, длинные списки — счетчиком. */
export function flatten(value: unknown, prefix = ""): [string, string][] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [[prefix, "нет"]];
    const scalars = value.every((v) => v === null || typeof v !== "object");
    if (scalars && value.length <= 5) return [[prefix, value.map(scalarText).join(", ")]];
    return [[prefix, `${value.length} ${countWord(value.length)}`]];
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.truncated === true && typeof obj.preview === "string") return [[prefix, `значение больше 4 КБ (${obj.bytes} байт) – в отчет не выгружается`]];
    const entries = Object.entries(obj);
    if (entries.length === 0) return [[prefix, "—"]];
    return entries.flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, scalarText(value)]];
}

/**
 * Сырые поля приложения В, которые читаются как противоречие основному тексту.
 * Значение не меняется — рядом с именем поля появляется короткое пояснение, что
 * это за число и почему оно другое.
 */
const RAW_FIELD_NOTE: Record<string, string> = {
  "activity.rest.contributors": "счетчик API; в оценке – число авторов из истории git",
  // поле стоит «да» у каждого анализа — это не флаг обрезки истории, а форма
  // ответа: сами коммиты в документ не выгружаются
  "activity.git.timeline.truncated": "поле ответа: сами коммиты в документ не выгружаются, показан итог",
  // «старых» бывает больше, чем «всего», потому что поля считают разное
  "code.todo.count": "пометок TODO в коде (без файлов тестов), без FIXME",
  "code.todo.fixme": "пометок FIXME в коде (без файлов тестов)",
  "code.todo.older_180d": "пометок TODO и FIXME старше 180 дней (из count + fixme)",
  "code.todo.todo_files": "файлов кода с пометками",
  "code.todo.blamed_files": "файлов, у которых удалось прочитать даты пометок",
  // пометки в тестах в счетчик долга не входят — показываются отдельным числом
  "code.todo.test_markers": "пометок в файлах тестов; в счетчики выше не входят",
  // выборка задач для времени первого ответа — не число задач в трекере
  "issues.comments_sample.issues": "задач в выборке для времени первого ответа; число задач трекера – в issues.stats",
  // поля справочных показателей динамики
  "cicd.runs.recent_runs": "последние завершенные запуски, исход и время: по ним считается стабильность CI в динамике",
  "issues.stats.flow.window_days": "длина окна потока задач, дней",
  "issues.stats.flow.windows": "окна за 180 дней: создано, закрыто и закрыто быстрее часа (такие задачи не входят ни в созданные, ни в закрытые)",
  "issues.stats.flow.complete_since": "список задач обрезан: окна раньше этой даты не покрыты",
};

/** Служебная заметка коллектора по-английски — читателю по-русски. */
function rawFieldValue(field: string, value: string): string {
  const m = /^completed_at missing on (\d+)\/(\d+) closed/.exec(value);
  if (field === "close_date_note" && m) return `дата закрытия не передана у ${m[1]} из ${m[2]} закрытых задач, использована дата последнего изменения`;
  if (field === "reason") return NO_DATA_FACT_REASON[value] ?? value;
  if (field === "last_status") return RUN_STATUS_WORD[value] ?? value;
  if (field === "detail" || field.endsWith(".detail")) return detailWords(value);
  return value;
}

/** Служебная подробность отказа источника — по-русски, код ответа сохраняется. */
function detailWords(value: string): string {
  const status = /^status (\d+(?:\/\d+)?)$/.exec(value);
  if (status) return `ответ API ${status[1]}`;
  const on = /^([\d/]+) on [\w/,\s]+$/.exec(value);
  if (on) return `ответ API ${on[1]}`;
  if (value === "no SOURCECRAFT_TOKEN") return "токена SourceCraft у сервиса нет";
  return value;
}

/** Статус последнего прогона CI — словами: английских значений в документе нет. */
const RUN_STATUS_WORD: Record<string, string> = {
  success: "успешно",
  failure: "с ошибкой",
  failed: "с ошибкой",
  cancelled: "отменен",
  canceled: "отменен",
  running: "идет",
  pending: "в очереди",
  unknown: "неизвестен",
};

/**
 * Служебные ветви сырых значений, которые ничего не доказывают читателю
 * (идентификаторы запуска проверки AppSec). Сами данные не вычищаются —
 * приложение показывает сырые значения, — убираются только служебные ветви.
 */
const RAW_FIELD_SKIP = [/^provenance(\.|$)/];

function rawFieldShown(field: string): boolean {
  return !RAW_FIELD_SKIP.some((re) => re.test(field));
}

/** Раздел о подозрении на накрутку — только при флаге; это подозрение, а не оценка. */
function fraudBlock(card: RepoCard): Block[] {
  const fraud = card.ai?.fraud;
  // флаггер может вернуть факторы при flag: false (валидатор это пропускает) —
  // подозрение печатается только при флаге, как в кабинете (`MePage.tsx`)
  if (fraud === undefined || fraud === null || fraud.flag !== true || fraud.factors.length === 0) return [];
  const out: Block[] = [h2(FRAUD_TITLE)];
  out.push(para(line(FRAUD_EXPLAIN)));
  // флаг прошлого анализа не выдается за текущий
  if (fraudCheckStale(card.ai?.check)) out.push(para(line("Проверка выполнена по прошлому анализу – после нее репозиторий анализировался снова.")));
  // текст фактора строит код из факта (та же функция, что на карточке);
  // формулировка модели — только если факта нет
  const factOf = (key: string): unknown => fraudFactorValue(key, fraud.signals, card.evidence, fraud.inputs);
  out.push({
    kind: "list",
    items: fraud.factors.map((f) => [strong(fraudFactorTitle(f.key)), text(` – ${fraudFactorFact(f.key, factOf(f.key), (iso) => fmtDate(iso)) ?? f.note}`)] as InlineLine),
  });
  return out;
}


/**
 * AI-описание печатается тем же зрителям, что видят его на карточке: маршрут
 * отчета строит ту же карточку, а `card.ai` приходит только с правами на полный
 * Score (на приватном репозитории — владельцу). Текст — тот же валидированный,
 * что на карточке; модель — официальным названием.
 */
function aiBlock(card: RepoCard): Block[] {
  const ai = card.ai;
  if (ai === undefined || ai === null) return [];
  const notes = [...(ai.overview ? [{ title: null as string | null, note: ai.overview }] : []), ...ai.specialists.map((n) => ({ title: aiRoleTitle(n.role), note: n }))];
  if (notes.length === 0) return [];
  const out: Block[] = [h2(AI_SECTION_TITLE)];
  // обзор по прошлому анализу — плашкой сразу под заголовком, как метка «Устарел»
  // на карточке: иначе цифры текста спорят с таблицами того же документа
  if (aiNotesStale(ai)) out.push({ kind: "paragraph", tone: "note", lines: [[strong("Обзор устарел:"), text(` ${AI_STALE_REPORT_TEXT}`)]] });
  // отказ проверки общего обзора печатается и в отчете, как на карточке
  if (!ai.overview && ai.specialists.length > 0) out.push(para(line(AI_OVERVIEW_REJECTED)));
  for (const { title, note } of notes) {
    if (title !== null) out.push({ kind: "paragraph", tone: "subhead", lines: [[strong(title)]] });
    out.push(para(...aiParagraphs(note.text).map((l) => [escaped(l)] as InlineLine)));
  }
  // разборы, не прошедшие проверку фактами, — как на карточке и до строки с
  // моделью и датой (без траектории и без «нет фактов»)
  const failed = (ai.failures ?? []).filter((f) => f.role !== "trajectory" && !f.reason.startsWith("нет фактов"));
  if (failed.length > 0) out.push({ kind: "paragraph", tone: "fine", lines: failed.map((f) => line(`Разбор «${aiRoleTitle(f.role)}» не прошел проверку фактами.`)) });
  const models = [...new Set(notes.map((n) => aiModelName(n.note.model)))].join(", ");
  const when = ai.generatedAt ? ` от ${fmtDate(ai.generatedAt)}` : "";
  out.push({
    kind: "paragraph",
    tone: "fine",
    lines: [line(`Текст написан моделью ${models} по фактам анализа${when}; каждое утверждение проверено по фактам. ${AI_DISCLAIMER}`)],
  });
  return out;
}

function factStatusWord(status: string): string {
  return status === "ok" ? "данные есть" : status === "no-data" ? "данных нет" : status === "bad" ? "источник не ответил" : status;
}

function appendixC(card: RepoCard): Block[] {
  const out: Block[] = [h3("В. Исходные данные")];
  if (card.evidence.length === 0) {
    out.push(para(line("Исходных данных по этому анализу нет.")));
    return out;
  }
  out.push({ kind: "paragraph", tone: "fine", lines: [line("Данные анализа в виде таблиц «поле – значение». История коммитов показана итогом, сами коммиты сервис не хранит.")] });
  // дерево канального скана идет своим ключом и на одном скане повторяет
  // публичное `tree.stats` слово в слово — вторая такая таблица не нужна
  const publicTree = card.evidence.find((e) => e.key === "tree.stats");
  const facts = (card.evidence as CardEvidence[]).filter(
    (f) => !(f.key === CHANNEL_TREE_KEY && publicTree !== undefined && JSON.stringify(f.value) === JSON.stringify(publicTree.value)),
  );
  for (const fact of facts) {
    const catTitle = CATEGORY_TITLES[fact.category as CategoryKey] ?? fact.category;
    const caption = fact.key === CHANNEL_TREE_KEY ? " (дерево того анализа, по которому посчитана плотность находок)" : "";
    out.push({ kind: "paragraph", tone: "caption", lines: [[code(fact.key), text(` – ${catTitle}, ${factStatusWord(fact.status)}, ${sourceWord(fact.source)}, ${fmtDateTime(fact.collectedAt)}${caption}`)]] });
    out.push({
      kind: "table",
      columns: [col("Поле", "left", 180), col("Значение")],
      rows: flatten(fact.value)
        .filter(([k]) => rawFieldShown(k))
        .map(([k, v]) => {
          const note = RAW_FIELD_NOTE[`${fact.key}.${k}`];
          return [[text(k === "" ? "значение" : k), ...(note ? [text(` – ${note}`)] : [])], [escaped(rawFieldValue(k, v))]];
        }),
      small: true,
    });
  }
  return out;
}

function appendixD(card: RepoCard): Block[] {
  const { repo, scan, score } = card;
  const rows: InlineLine[][] = [
    [line("Версия методики"), line(score?.modelVersion ?? "—")],
    [line("Оценка рассчитана"), line(score ? fmtDateTime(score.computedAt) : "—")],
  ];
  if (scan) {
    rows.push(
      [line("Последний анализ"), line(`#${scan.id}, завершен ${fmtDateTime(scan.finishedAt ?? scan.startedAt)}`)],
      [line("Статус анализа"), line(scanStatusText(scan.status))],
      [line("Режим запуска"), line(scanTriggerText(scan.trigger))],
    );
  }
  // место в рейтинге — то же число и то же правило, что в паспорте карточки
  // (`rankText`): «#N из M» или причина, по которой места нет
  if (score) rows.push([line("Место в рейтинге"), line(rankText(repo.visibility, score))]);
  rows.push(
    // язык приходит из каталога SourceCraft, а не из скачанного репозитория, —
    // поэтому он есть и там, где скачать репозиторий не удалось
    [line("Язык (по каталогу SourceCraft)"), repo.language ? [escaped(repo.language)] : line("не определен")],
    [line("Реакции"), line(repo.likes === null ? "—" : String(repo.likes))],
    [line("Ответвления"), line(repo.forks === null ? "—" : String(repo.forks))],
    [line("Последняя активность"), line(fmtDate(repo.lastActivityAt))],
  );
  return [
    h3("Г. Версия методики, номер анализа и режим запуска"),
    { kind: "table", columns: [col("Поле", "left", 180), col("Значение")], rows, small: true },
  ];
}
