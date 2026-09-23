// build.ts — построитель модели отчёта по карточке (В4.9, К9.1-К9.8, Д3-Д5).
//
// Чистая функция от ответа `/api/repos/{org}/{repo}` — ни БД, ни сети:
// страница и отчёт показывают одно и то же, источник данных один. Модель
// общая для MD и PDF (`model.ts`), рендеры — `markdown.ts` и `pdf.ts`.
//
// Трекер-закон: вердикт, «почему» у категории, ограничения и «Как
// считается» — шаблоны из фактов и баллов (закрытый набор ниже), не LLM;
// действия — только рекомендации движка. Каждое число отчёта
// прослеживается до факта в приложении (А — расчет, Б — источники, В —
// исходные данные, Г — паспорт анализа).
//
// Порядок разделов — по эталону вида (круг 4): шапка → показатель с плашкой
// и вердиктом → «Вклад категорий в оценку» → категории → «Что сделать
// первым» → «Ограничения данных» → разбор → все рекомендации → «Как
// считается» → приложение (в PDF с новой страницы).
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
  fullScorePath,
  noDataReason,
  pathText,
  scanStatusText,
  scanTriggerText,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  sentence,
  type Contributions,
} from "../web/format";
import { code, em, escaped, strong, text, type ActionItem, type Block, type CategoryRow, type Chip, type HeroNote, type HeroSecondary, type InlineLine, type ReportModel, type TableColumn } from "./model";
import {
  FULL,
  INDEX,
  PUBLIC,
  RULE_SUBMETRIC,
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
} from "./sections";
import { displayOnly, submetricContext, submetricNote, submetricShownValue, submetricTitle, subweightKey, type SubmetricContext } from "./submetrics";

// В4.9, часть 2 гейта: основание, ограничения, вклады и таблица правил живут в
// `sections.ts` (их берет и карточка); `whyText` реэкспортируется для тестов.
export { whyText } from "./sections";

/** Отчета без оценки нет (решение владельца 22.09): текст отказа маршрутов. */
export const REPORT_NO_SCORE = "Отчет появится после первого анализа: пока у репозитория нет оценки, собирать в документ нечего.";

const DOC = "Отчет HealthCraft";
const NBSP = "\u00a0";
/** Действий на первом экране — не больше трех (эталон вида). */
export const FIRST_ACTIONS = 3;

// ---------- шаблоны (закрытый набор, К9.1) ----------

/** Строка «близко к порогу» — если показатель в пределах 2 баллов от границы зоны. */
export function thresholdNote(value: number): string | null {
  const v = Math.round(value);
  const [success, warning] = [SCORE_SCALE[0]!, SCORE_SCALE[1]!];
  const bounds: [number, string, string][] = [
    [Number(success.range.split("-")[0]), success.word, warning.word],
    [Number(warning.range.split("-")[0]), warning.word, SCORE_SCALE[2]!.word],
  ];
  for (const [t, upperZone, lowerZone] of bounds) {
    if (v >= t && v - t <= 2) return `${t} – нижняя граница зоны «${upperZone}»: при ${t - 1} баллах оценка относилась бы к зоне «${lowerZone}».`;
    if (v < t && t - v <= 2) return `${t - 1} – верхняя граница зоны «${lowerZone}»: при ${t} баллах оценка относилась бы к зоне «${upperZone}».`;
  }
  return null;
}

/** Плашка балла категории/показателя — как `Label` UI. */
export function scoreChip(value: number | null): Chip {
  return { theme: scoreLabelTheme(value), text: value === null ? "Нет данных" : sentence(scoreWord(value)) };
}

/** Строка категории: балл и плашка; основание — `categoryWhy` (одна копия с карточкой). */
function categoryRow(card: RepoCard, key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): CategoryRow {
  const name = CATEGORY_TITLES[key];
  const why = categoryWhy(card, key, ctx);
  // Ступень 4 (В-9): закрытая зрителю категория — «Недоступно», а не «нет данных»
  if (cat.locked !== undefined) return { name, score: null, scoreText: "—", chip: { theme: "unknown", text: "Недоступно" }, why };
  if (cat.score === null) return { name, score: null, scoreText: "—", chip: scoreChip(null), why };
  return { name, score: cat.score, scoreText: fmtScore(cat.score), chip: scoreChip(cat.score), why };
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

/** Модель отчёта карточки — общий источник MD и PDF. */
export function buildReportModel(card: RepoCard): ReportModel {
  const slug = `${card.repo.org}/${card.repo.repo}`;
  const dateIso = analysisDate(card);
  const date = dateIso ? fmtDate(dateIso) : null;
  // Решение владельца 22.09 (круг 3 гейта): отчет без оценки не выдается —
  // собирать в документ нечего, а в интерфейсе кнопки выгрузки у такого
  // репозитория и не было. Маршруты `.md` и `.pdf` отказывают до сборки
  // (`server.ts`), здесь — страховка контракта.
  const blocks: Block[] = [headerBlock(card, date)];
  if (!card.score) {
    throw new Error(REPORT_NO_SCORE);
  } else {
    const metrics = metricsOf(card);
    if (withValue(metrics).length === 0) blocks.push(...indexNullSection(card));
    else blocks.push(...scoredSection(card, metrics));
    blocks.push(...fraudBlock(card));
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
 * В2 гейта: плашка рядом с названием документа — «Полный», когда зрителю
 * доступен Repo Health Score (закрытые категории открыты), иначе
 * «Публичный». Без оценки доступ ещё не известен — плашки нет.
 */
function docChip(card: RepoCard): Chip | null {
  if (!card.score) return null;
  // В4.9 ч.2 (Е1): «Полный»/«Публичный» совпадали с видимостью «Публичный»
  // на карточке — плашка называет оценку, а не репозиторий
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
 * В4.9 ч.2 (Е2, §2 23.09 ответ 1): путь к полной оценке — той же строкой, что
 * под закрытым Repo Health Score на карточке (`fullScorePath`), по типу
 * зрителя; в документе без ссылки.
 */
function fullPathText(card: RepoCard): string {
  return pathText(fullScorePath(card.viewer?.auth, [card.access.cicd, card.access.appsec]));
}

// ---------- оценка есть, индекса нет (покрытие ниже порога) ----------

function indexNullSection(card: RepoCard): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const collected = fmtCoverage(score.indexCoverage);
  const threshold = fmtCoverage(COVERAGE_NULL_BELOW);
  const notes: HeroNote[] = [{ line: line("Отсутствие оценки означает недостаток данных, а не плохое состояние репозитория.") }];
  if (score.fullLocked) notes.push({ line: line(`Полная оценка ${FULL}, включающая CI/CD и Безопасность, видна участникам репозитория. ${fullPathText(card)}`), info: true });
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
    // Ступень 4 (Ф21): те же имена разделов, что в обычном отчете и на карточке
    h2("Категории"),
    categoriesBlock(card, ctx),
    h2("Рекомендации"),
  ];
  if (card.recommendations.length > 0) out.push({ kind: "actions", compact: false, items: card.recommendations.map((r, i) => actionItem(r, i + 1)) });
  // ревью кода R1: без рекомендаций — та же фраза, что на карточке (инвариант «карточка = отчет»)
  else out.push(para(line(noRecommendationsText(card))));
  out.push(para(line(`Оценка рассчитывается при объеме данных от ${threshold}.`)));
  const limits = limitations(card);
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));
  out.push(...appendix(card, []));
  return out;
}

// ---------- полный отчёт ----------

function scoredSection(card: RepoCard, metrics: Metric[]): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const shown = withValue(metrics);
  const contributions = new Map(shown.map((m) => [m.name, contributionsOf(card, m)] as const));
  const notes: HeroNote[] = [];
  // строка «близко к порогу» относится к конкретному числу: когда чисел два,
  // она называет свой показатель
  for (const m of shown) {
    const near = thresholdNote(m.value);
    if (near) notes.push({ line: line(shown.length > 1 ? `${m.name}: ${near}` : near) });
  }
  // Круг 2, п.3 (вариант 2 владельца): пояснение к числам — ОДНОЙ строкой под
  // обоими показателями, с иконкой информации. Круг 4: и в ней публичный
  // показатель называется первым.
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
          : // пункт 7 блока А круга 4: полный доступ есть, индекса нет
            `${INDEX} считается по открытым данным – по нему строится рейтинг, но открытых данных собрано меньше ${fmtCoverage(COVERAGE_NULL_BELOW)}, поэтому он не рассчитан. ${FULL} учитывает 6 категорий, включая CI/CD и Безопасность.`,
    ),
    info: true,
  });
  const head = metrics[0]!;
  const second = metrics[1];
  const secondary: HeroSecondary | null = second
    ? { label: second.name, value: second.value === null ? null : Math.round(second.value), noneText: "Оценки нет", chip: second.value === null ? null : scoreChip(second.value), note: null }
    : null;
  const out: Block[] = [
    {
      kind: "hero",
      label: head.name,
      value: head.value === null ? null : Math.round(head.value),
      noneText: "Оценки нет",
      chip: head.value === null ? null : scoreChip(head.value),
      secondary,
      // В3 гейта: предложения общего вывода под оценкой в отчете нет
      verdict: null,
      notes,
    },
    // полос вклада столько же, сколько показателей со значением, и в том же
    // порядке: сначала публичный
    ...shown.map((m) => contributionsBlock(contributions.get(m.name)!, m.name)),
    h2("Категории"),
    categoriesBlock(card, ctx),
  ];
  // В11 и В15 гейта: блока «Что сделать первым» нет, раздел рекомендаций один
  // и стоит сразу после категорий.
  const recs = card.recommendations;
  out.push(h2("Рекомендации"));
  if (recs.length === 0) {
    out.push(para(line(noRecommendationsText(card))));
  } else {
    // п.8 круга 2: вводной строки у раздела нет (вместе с ней ушло и ложное
    // обещание порядка «по убыванию влияния» — Г1.2)
    out.push({ kind: "actions", compact: true, items: recs.map((r, i) => actionItem(r, i + 1)) });
  }
  const limits = limitations(card);
  // п.9 круга 2: ограничения данных — такие же примечания, как под таблицами
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));

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
  // заголовок, сегменты и строка вместо полосы — общие с карточкой (`sections.ts`, А3)
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
  for (const key of withData) out.push(detailBlock(card, key, cats[key]!, ctx, actionOf));
  for (const key of without) {
    const row = categoryRow(card, key, cats[key]!, ctx);
    out.push({ kind: "detail", title: row.name, scoreText: "—", chip: row.chip, table: null, notes: [line(row.why)] });
  }
  return out;
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
 * Примечание, которое делает число категории пересчитываемым по приложению:
 * А8 (окно частоты коммитов не объявлено) и А9 (плотность находок взвешена по
 * важности, поэтому «38 на 10 тыс. строк» не сходится с числом находок).
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
    // плотность считается по дереву того скана, по которому взяты находки
    const loc = numOf(factValue(card, CHANNEL_TREE_KEY)?.loc) ?? numOf(factValue(card, "tree.stats")?.loc);
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
  // А4 аудита: нехватку данных CI документ объяснял в трех местах по-разному, а
  // точную причину прятал сырым полем приложения В. Причина одна и берется из
  // самого факта — здесь она названа теми же словами, что в приложении.
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

// ---------- как считается (К9.3) ----------

function weightsText(keys: CategoryKey[], weightOf: (k: CategoryKey) => number): string {
  return keys.map((k) => `${CATEGORY_TITLES[k]} ${weightOf(k)}%`).join(", ");
}

function methodSection(shown: ShownMetric[], contributions: Map<string, Contributions | null>): Block[] {
  const indexWeights = weightsText(PUBLIC, (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS]);
  const fullWeights = weightsText(CATEGORY_ORDER, (k) => SCORE_WEIGHTS[k]);
  /** «В этом отчете: …» — только у показателя, который в ЭТОМ документе посчитан. */
  const sumOf = (name: string): string => {
    const c = contributions.get(name);
    return c?.kind === "bar" ? ` В этом отчете: ${c.segments.map((s) => `${s.title} ${fmtContribution(s.tenths)}`).join(", ")} = ${c.total}.` : "";
  };
  const hasIndex = shown.some((m) => m.name === INDEX);
  const hasFull = shown.some((m) => m.name === FULL);
  // А2 аудита: первая строка описывает ровно те показатели, которые есть в
  // ЭТОМ документе, — «оценка складывается из 4 категорий» в полном отчете
  // спорило и с первым экраном, и с шестью строками приложения А.
  const first = hasIndex && hasFull
    ? `В отчете 2 показателя: ${INDEX} – по 4 открытым категориям (документация, активность, задачи и состояние кода), ${FULL} – по всем 6, включая CI/CD и Безопасность.`
    : hasFull
      ? `В отчете один показатель – ${FULL}: он складывается из 6 категорий (документация, CI/CD, Безопасность, активность, задачи и состояние кода).`
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

// ---------- приложение (К9.4) ----------

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
 * каждого показателя своя таблица — публичная первой (круг 4 блока А).
 */
function metricCalc(card: RepoCard, metric: ShownMetric, named: boolean): Block[] {
  const cats = card.score!.categories;
  const contributions = contributionsOf(card, metric);
  const withData = metric.keys.filter((k) => cats[k]?.score !== null && cats[k]?.score !== undefined);
  const wsum = withData.reduce((s, k) => s + metric.weight(k), 0);
  // Г1.1: десятые вкладов берутся из той же функции, что полоса первого
  // экрана (`categoryContributions`, метод наибольшего остатка). Иначе
  // приложение и полоса расходились на 0,1-0,2, а строки приложения не
  // складывались в собственное «Итого» (69,8 при показателе 70).
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
  const value = Math.round(metric.value);
  const sumText = fmtDecimal(total, 1);
  rows.push([line("Итого"), line(""), line("100%"), line(Number(sumText.replace(",", ".")) === value ? String(value) : `${sumText} ≈ ${value}`)]);
  const out: Block[] = [];
  // подзаголовок нужен, только когда таблиц две: иначе показатель назван в шапке столбца
  if (named) out.push({ kind: "paragraph", tone: "subhead", lines: [[strong(`Расчет ${metric.name}`)]] });
  out.push({
    kind: "table",
    // п.6 круга 5: таблиц две и каждая подписана показателем — повторять его в шапке столбца незачем
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
  if (Math.round(total) > value) out.push({ kind: "paragraph", tone: "fine", lines: [line(`Итог ограничен ${value} баллами: AppSec нашел утекшие секреты.`)] });
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
 * А7 аудита: «собрано N% данных» объяснялось «65 весовыми пунктами», а
 * такого числа в документе не было. Здесь объем данных считается строками, в
 * которых каждое число видно: вес каждой из 4 открытых категорий, есть по
 * ней данные или нет, и итог «M из 65».
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

/** Балл категории из показателей: вес × балл; особые правила (трекер пуст, CI без запусков) — строкой. */
function categoryCalc(key: CategoryKey, cat: CardCategory): Block[] {
  const title: Block = { kind: "paragraph", tone: "subhead", lines: [[strong(`Балл категории ${CATEGORY_TITLES[key]}`)]] };
  if (key === "issues" && "tracker_unused" in cat.submetrics) {
    return [title, { kind: "paragraph", tone: "fine", lines: [line(`Задач в трекере нет, поэтому категория получает минимальный балл: ${fmtDecimal(cat.score!, 1)}.`)] }];
  }
  if (key === "cicd" && cat.no_data) {
    return [title, { kind: "paragraph", tone: "fine", lines: [line(`Результаты запусков CI недоступны, поэтому балл категории – половина балла конфигурации CI: ${fmtDecimal(cat.score!, 1)}.`)] }];
  }
  const weights = SUBWEIGHTS[key] as Record<string, number>;
  const parts = Object.entries(cat.submetrics)
    .filter(([sub, e]) => !displayOnly(key, sub) && typeof e.score === "number" && weights[subweightKey(sub)] !== undefined)
    .map(([sub, e]) => ({ sub, score: e.score as number, w: weights[subweightKey(sub)]! }));
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  if (parts.length === 0 || wsum === 0) return [title, { kind: "paragraph", tone: "fine", lines: [line(`Балл категории – ${fmtDecimal(cat.score!, 1)}.`)] }];
  const rows: InlineLine[][] = parts.map((p) => [line(submetricTitle(key, p.sub)), line(fmtDecimal(p.score * 100, 1)), line(pct1(p.w / wsum)), line(fmtDecimal((p.score * 100 * p.w) / wsum, 1))]);
  rows.push([line("Итого"), line(""), line("100%"), line(fmtDecimal(cat.score!, 1))]);
  const out: Block[] = [title, { kind: "table", columns: [col("Показатель", "left", 184), col("Балл", "right", 84), col("Вес", "right", 114), col("Баллов в категорию", "right")], rows, total: true }];
  // А5 аудита: в разборе по категориям стоит номинальный вес показателя, здесь
  // — вес после перераспределения. Оба числа верны; отличаются они только
  // тогда, когда у показателя категории нет данных, — об этом и строка.
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
  // Круг 4 блока А: удваивается ТОЛЬКО строка самого показателя (публичная
  // первой) — балл категории и балл показателя у обеих шкал один.
  if (shown.length > 0) {
    for (const metric of shown) {
      rows.push([
        [strong(`${metric.name} ${Math.round(metric.value)}`)],
        line(`сумма по ${metric.keys.length === PUBLIC.length ? "4 открытым категориям" : "6 категориям"}: балл × вес, приложение А`),
        line("баллы категорий"),
        line(at),
        line("—"),
      ]);
    }
  } else {
    // А7 аудита: «65 весовых пунктов» заменено ссылкой на расчет приложения А,
    // где каждое слагаемое напечатано
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
      // Г1.11 гейта: столбец «Порядок расчета» у показателей стоял пустым —
      // пишем, с каким весом показатель входит в балл категории
      const weight = (SUBWEIGHTS[key] as Record<string, number>)[subweightKey(sub)];
      // А10 аудита: у «Трекер не ведется» стояло «справочно, в балл не входит»
      // и тут же «балл 6» — тот самый балл категории. Веса у показателя нет не
      // потому, что он справочный, а потому, что балл категории равен его баллу.
      const order =
        key === "issues" && sub === "tracker_unused"
          ? "задач в трекере нет: балл категории равен баллу этого показателя, приложение А"
          : displayOnly(key, sub) || weight === undefined
            ? "справочно, в балл не входит"
            : `балл показателя × вес ${fmtDecimal(weight * 100, 0)}% в балле категории`;
      rows.push([
        line(`${submetricTitle(key, sub)}: ${shown}`),
        line(order),
        // приемка HQ 22.09: `activity.fresh` — метка времени (мс), читателю — дата, не 13 цифр
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
 * Г1.20 гейта: сырые поля приложения В, которые читаются как противоречие
 * основному тексту. Значение не меняется — рядом с именем поля появляется
 * короткое пояснение, что это за число и почему оно другое.
 */
const RAW_FIELD_NOTE: Record<string, string> = {
  "activity.rest.contributors": "счетчик API; в оценке – число авторов из истории git",
  // А11 аудита: поле стоит «да» у каждого анализа — это не флаг обрезки
  // истории, а форма ответа: коммиты в документ не выгружаются
  "activity.git.timeline.truncated": "поле ответа: сами коммиты в документ не выгружаются, показан итог",
  // А12 аудита: «старых» больше, чем «всего», потому что поля считают разное
  "code.todo.count": "пометок TODO, без FIXME",
  "code.todo.fixme": "пометок FIXME",
  "code.todo.older_180d": "пометок TODO и FIXME старше 180 дней (из count + fixme)",
  "code.todo.todo_files": "файлов с пометками",
  "code.todo.blamed_files": "файлов, у которых удалось прочитать даты пометок",
  // А15 аудита: выборка задач для времени первого ответа — не число задач в трекере
  "issues.comments_sample.issues": "задач в выборке для времени первого ответа; число задач трекера – в issues.stats",
};

/** Г1.20, А6: служебная заметка коллектора по-английски — читателю по-русски. */
function rawFieldValue(field: string, value: string): string {
  const m = /^completed_at missing on (\d+)\/(\d+) closed/.exec(value);
  if (field === "close_date_note" && m) return `дата закрытия не передана у ${m[1]} из ${m[2]} закрытых задач, использована дата последнего изменения`;
  if (field === "reason") return NO_DATA_FACT_REASON[value] ?? value;
  if (field === "last_status") return RUN_STATUS_WORD[value] ?? value;
  if (field === "detail" || field.endsWith(".detail")) return detailWords(value);
  return value;
}

/** А6: служебная подробность отказа источника — по-русски, число ответа сохраняется. */
function detailWords(value: string): string {
  const status = /^status (\d+(?:\/\d+)?)$/.exec(value);
  if (status) return `ответ API ${status[1]}`;
  const on = /^([\d/]+) on [\w/,\s]+$/.exec(value);
  if (on) return `ответ API ${on[1]}`;
  if (value === "no SOURCECRAFT_TOKEN") return "токена SourceCraft у сервиса нет";
  return value;
}

/** Статус последнего прогона CI — словами (А6: английских значений в документе нет). */
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
 * А6 аудита: служебные ветви сырых значений, которые ничего не доказывают
 * читателю (идентификаторы запуска проверки AppSec). Сами данные не
 * вычищаются — К9.4 требует показывать сырые значения, — убираются только
 * служебные ветви.
 */
const RAW_FIELD_SKIP = [/^provenance(\.|$)/];

function rawFieldShown(field: string): boolean {
  return !RAW_FIELD_SKIP.some((re) => re.test(field));
}

/** В5 (К5.10): раздел фрода — только при флаге; подозрение, не оценка.
 *  23.09: портирован в модель отчёта В4.9 при мерже v5 → main. */
function fraudBlock(card: RepoCard): Block[] {
  const fraud = card.ai?.fraud;
  if (fraud === undefined || fraud === null || fraud.factors.length === 0) return [];
  const out: Block[] = [h2("Подозрение на искусственную активность")];
  out.push(para(line("Автоматический анализ нашёл pattern'ы, похожие на накрутку активности. Это подозрение для проверки человеком, а не приговор: оценка репозитория от него не меняется.")));
  out.push({ kind: "list", items: fraud.factors.map((f) => [strong(f.key), text(` – ${f.note}`)] as InlineLine) });
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
  // А6 аудита: дерево канального скана едет своим ключом и на одном скане
  // повторяет публичное `tree.stats` слово в слово — второй такой таблицы в
  // документе быть не должно.
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
  rows.push(
    // А14 аудита: язык приходит из каталога SourceCraft, а не из скачанного
    // репозитория, — поэтому он есть и там, где скачать репозиторий не удалось
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
