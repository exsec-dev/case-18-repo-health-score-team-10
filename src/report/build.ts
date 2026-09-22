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
import { CATEGORY_ORDER, CATEGORY_TITLES, type CardCategory, type CardEvidence, type CardRecommendation, type RepoCard } from "../api/repos";
import { COVERAGE_NULL_BELOW, INDEX_WEIGHTS, SCORE_WEIGHTS, SUBWEIGHTS, type CategoryKey } from "../score/model";
import {
  CONTRIBUTIONS_REST,
  CONTRIBUTIONS_TITLE,
  SCORE_SCALE,
  categoryContributions,
  contributionsNote,
  lossParts,
  closeDateText,
  NOT_IN_SCORE,
  fmtContribution,
  fmtCoverage,
  fmtDate,
  fmtDateTime,
  fmtDecimal,
  fmtLoss,
  fmtScore,
  gitLimitsText,
  lockedCategoryText,
  noDataReason,
  scanStatusText,
  scanTriggerText,
  scoreLabelTheme,
  scoreTheme,
  scoreWord,
  securityNoDataReason,
  sentence,
  type Contributions,
} from "../web/format";
import { code, em, escaped, strong, text, type ActionItem, type Block, type CategoryRow, type Chip, type HeroNote, type HeroSecondary, type InlineLine, type ReportModel, type TableColumn } from "./model";
import { displayOnly, submetricContext, submetricNote, submetricShownValue, submetricTitle, subweightKey, type SubmetricContext } from "./submetrics";

/** Отчета без оценки нет (решение владельца 22.09): текст отказа маршрутов. */
export const REPORT_NO_SCORE = "Отчет появится после первого анализа: пока у репозитория нет оценки, собирать в документ нечего.";

const INDEX = "HealthCraft Index";
const FULL = "Repo Health Score";
const DOC = "Отчет HealthCraft";
const PUBLIC: CategoryKey[] = CATEGORY_ORDER.filter((k) => k in INDEX_WEIGHTS);
const NBSP = "\u00a0";
/** Действий на первом экране — не больше трех (эталон вида). */
export const FIRST_ACTIONS = 3;

// ---------- показатель, который печатается крупно (К9.1) ----------

interface Metric {
  name: typeof INDEX | typeof FULL;
  value: number | null;
  keys: CategoryKey[];
  weight: (key: CategoryKey) => number;
}

/**
 * Зрителю с обоими показателями крупно — Repo Health Score, HealthCraft
 * Index строкой ниже; анониму и зрителю без прав — Index (решение
 * владельца 22.09). Полный показатель без данных — крупно Index.
 */
function bigMetric(card: RepoCard): Metric {
  const score = card.score!;
  const index: Metric = { name: INDEX, value: score.healthcraftIndex, keys: PUBLIC, weight: (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS] ?? 0 };
  if (score.fullLocked || score.repoHealthScore === null) return index;
  return { name: FULL, value: score.repoHealthScore, keys: CATEGORY_ORDER, weight: (k) => score.categories[k]?.weight ?? SCORE_WEIGHTS[k] };
}

function contributionsOf(card: RepoCard, metric: Metric): Contributions | null {
  const cats = card.score!.categories;
  return categoryContributions(
    metric.keys.map((key) => ({ key, title: CATEGORY_TITLES[key], score: cats[key]?.score ?? null, weight: metric.weight(key) })),
    metric.value,
    { codeEmpty: card.markers.codeEmpty },
  );
}

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

/**
 * «Почему» у категории: 1-2 показателя с наименьшим баллом словами словаря
 * подметрик (название – значение); примечание расчета, если оно объясняет
 * балл (трекер пуст); потолок CI — причиной. Без новой методики.
 */
export function whyText(key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): string {
  if (key === "cicd" && cat.no_data) return noDataReason(key, cat.no_data);
  const subs = Object.entries(cat.submetrics);
  for (const [sub, entry] of subs) {
    const remark = submetricNote(key, sub, entry.note)?.remark;
    if (remark) return remark;
  }
  const weakest = subs
    .map(([sub, entry], i) => ({ sub, entry, i }))
    .filter(({ sub, entry }) => !displayOnly(key, sub) && typeof entry.score === "number" && entry.score < 0.995)
    .sort((a, b) => a.entry.score! - b.entry.score! || a.i - b.i)
    .slice(0, 2);
  if (weakest.length === 0) return "Все показатели категории на максимуме.";
  return weakest.map(({ sub, entry }) => `${submetricTitle(key, sub)} – ${submetricShownValue(key, sub, entry, ctx)}.`).join(" ");
}

/** Плашка балла категории/показателя — как `Label` UI. */
export function scoreChip(value: number | null): Chip {
  return { theme: scoreLabelTheme(value), text: value === null ? "Нет данных" : sentence(scoreWord(value)) };
}

/** Строка категории: балл и плашка; закрытая — фраза по доступу; пустая — причина + опорная фраза. */
function categoryRow(card: RepoCard, key: CategoryKey, cat: CardCategory, ctx: SubmetricContext): CategoryRow {
  const name = CATEGORY_TITLES[key];
  if (cat.locked !== undefined) return { name, score: null, scoreText: "—", chip: scoreChip(null), why: lockedCategoryText(cat.locked, card.viewer?.auth) };
  if (cat.score === null) {
    const reason = key === "security" ? securityNoDataReason(card.evidence.find((e) => e.key === "appsec.findings")) : noDataReason(key, cat.no_data);
    return { name, score: null, scoreText: "—", chip: scoreChip(null), why: `${reason} ${NOT_IN_SCORE}` };
  }
  return { name, score: cat.score, scoreText: fmtScore(cat.score), chip: scoreChip(cat.score), why: whyText(key, cat, ctx) };
}

// ---------- ограничения данных (Д4, Д5) ----------

function closeDateNote(card: RepoCard): string | null {
  const stats = card.evidence.find((e) => e.key === "issues.stats" && e.status === "ok");
  return closeDateText((stats?.value as { close_date_note?: unknown } | null)?.close_date_note);
}

/** «Ограничения данных» — только ограничения данных (закрытые категории сюда не входят). */
function limitations(card: RepoCard): string[] {
  const out: string[] = [];
  const close = closeDateNote(card);
  if (close) out.push(close);
  if (card.markers.historyTruncatedSince) {
    // Г1.7 гейта: причина не в размере репозитория — сервис читает окно истории
    out.push(`История коммитов загружена частично: сервис читает только недавнюю историю – с ${fmtDate(card.markers.historyTruncatedSince)}.`);
  }
  if (card.markers.staleFacts) out.push("Часть данных взята из прошлого анализа: источник не ответил. Оценка от этого не выросла и не снизилась.");
  if (card.markers.gitLimits) out.push(gitLimitsText(card.markers.gitLimits));
  return out;
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

/** Правило → показатель разбора, к которому ведет ссылка «действие N». */
const RULE_SUBMETRIC: Record<string, string> = {
  "license-missing": "documentation.license",
  "contributing-missing": "documentation.contributing",
  "codeowners-missing": "documentation.codeowners",
  "readme-missing": "documentation.readme",
  "readme-sections-missing": "documentation.readme",
  "ci-missing": "cicd.config",
  "ci-no-steps": "cicd.config",
  "grant-ci-runs": "cicd.pass_rate",
  "fix-red-runs": "cicd.pass_rate",
  "speed-up-pipeline": "cicd.duration",
  "appsec-critical": "security.density",
  "start-tracker": "issues.tracker_unused",
  "reduce-stale-issues": "issues.stale",
  "speed-up-issue-close": "issues.close_days",
  "resolve-old-todos": "code.old_share",
};

// ---------- построитель ----------

const para = (...lines: InlineLine[]): Block => ({ kind: "paragraph", lines });
const line = (value: string): InlineLine => [text(value)];
const h2 = (value: string): Block => ({ kind: "heading", level: 2, content: [text(value)] });
const h3 = (value: string): Block => ({ kind: "heading", level: 3, content: [text(value)] });
const col = (title: string, align: "left" | "right" = "left", width?: number): TableColumn => ({ title, align, width });

/** Модель отчёта карточки — общий источник MD и PDF. */
export function buildReportModel(card: RepoCard): ReportModel {
  const slug = `${card.repo.org}/${card.repo.repo}`;
  const dateIso = card.score?.computedAt ?? card.scan?.finishedAt ?? card.scan?.startedAt ?? null;
  const date = dateIso ? fmtDate(dateIso) : null;
  // Решение владельца 22.09 (круг 3 гейта): отчет без оценки не выдается —
  // собирать в документ нечего, а в интерфейсе кнопки выгрузки у такого
  // репозитория и не было. Маршруты `.md` и `.pdf` отказывают до сборки
  // (`server.ts`), здесь — страховка контракта.
  const blocks: Block[] = [headerBlock(card, date)];
  if (!card.score) {
    throw new Error(REPORT_NO_SCORE);
  } else {
    const metric = bigMetric(card);
    if (metric.value === null) blocks.push(...indexNullSection(card));
    else blocks.push(...scoredSection(card, metric));
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
  return { theme: "unknown", text: card.score.fullLocked ? "Публичный" : "Полный" };
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

// ---------- оценка есть, индекса нет (покрытие ниже порога) ----------

function indexNullSection(card: RepoCard): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const collected = fmtCoverage(score.indexCoverage);
  const threshold = fmtCoverage(COVERAGE_NULL_BELOW);
  const notes: HeroNote[] = [{ line: line("Отсутствие оценки означает недостаток данных, а не плохое состояние репозитория.") }];
  if (score.fullLocked) notes.push({ line: line(`Полная оценка ${FULL} с категориями CI/CD и Безопасность видна участникам репозитория.`), info: true });
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
    h2("Данные по категориям"),
    categoriesBlock(card, ctx),
    h2("Что сделать"),
  ];
  if (card.recommendations.length > 0) out.push({ kind: "actions", compact: false, items: card.recommendations.map((r, i) => actionItem(r, i + 1)) });
  out.push(para(line(`Оценка рассчитывается при объеме данных от ${threshold}.`)));
  const limits = limitations(card);
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));
  out.push(...appendix(card, null));
  return out;
}

// ---------- полный отчёт ----------

function scoredSection(card: RepoCard, metric: Metric): Block[] {
  const score = card.score!;
  const ctx = submetricContext(score.computedAt);
  const value = metric.value!;
  const cats = card.score!.categories;
  const contributions = contributionsOf(card, metric);
  const notes: HeroNote[] = [];
  const near = thresholdNote(value);
  if (near) notes.push({ line: line(near) });
  // Круг 2, п.3 (вариант 2 владельца): пояснение к числам — ОДНОЙ строкой под
  // обоими показателями, с иконкой информации. Полного показателя зритель не
  // видит — остается только фраза про индекс и путь к полной оценке (Г1.15).
  let secondary: HeroSecondary | null = null;
  if (metric.name === INDEX) {
    notes.push({
      line: line(
        score.fullLocked
          ? `${INDEX} считается по открытым данным – по нему строится рейтинг. Полная оценка ${FULL} с категориями CI/CD и Безопасность видна участникам репозитория: войдите и добавьте персональный токен доступа в Настройках.`
          : `${INDEX} считается по открытым данным – по нему строится рейтинг. ${FULL}: данных для оценки недостаточно.`,
      ),
      info: true,
    });
  } else {
    notes.push({
      line: line(`${FULL} учитывает 6 категорий, включая CI/CD и Безопасность. ${INDEX} считается по открытым данным – по нему строится рейтинг.`),
      info: true,
    });
    secondary = {
      label: INDEX,
      value: score.healthcraftIndex === null ? null : Math.round(score.healthcraftIndex),
      noneText: "Оценки нет",
      chip: score.healthcraftIndex === null ? null : scoreChip(score.healthcraftIndex),
      note: null,
    };
  }
  const out: Block[] = [
    {
      kind: "hero",
      label: metric.name,
      value: Math.round(value),
      noneText: "Оценки нет",
      chip: scoreChip(value),
      secondary,
      // В3 гейта: предложения общего вывода под оценкой в отчете нет
      verdict: null,
      notes,
    },
    contributionsBlock(contributions, metric.name),
    h2("Категории"),
    categoriesBlock(card, ctx),
  ];
  // В11 и В15 гейта: блока «Что сделать первым» нет, раздел рекомендаций один
  // и стоит сразу после категорий.
  const recs = card.recommendations;
  out.push(h2("Рекомендации"));
  if (recs.length === 0) {
    out.push(para(line("По собранным данным улучшать нечего.")));
  } else {
    // п.8 круга 2: вводной строки у раздела нет (вместе с ней ушло и ложное
    // обещание порядка «по убыванию влияния» — Г1.2)
    out.push({ kind: "actions", compact: true, items: recs.map((r, i) => actionItem(r, i + 1)) });
  }
  const limits = limitations(card);
  // п.9 круга 2: ограничения данных — такие же примечания, как под таблицами
  if (limits.length > 0) out.push(h2("Ограничения данных"), ...limits.map((l) => ({ kind: "paragraph" as const, tone: "note" as const, lines: [line(l)] })));

  out.push(...detailSection(card, ctx));
  out.push(...methodSection(card, metric, contributions));
  out.push(...appendix(card, metric));
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
  // заголовок, строка вместо полосы и строка потерь — общие с карточкой (format.ts, К9.12)
  // п.6 круга 2: в отчете к заголовку добавлен показатель — полоса строится то
  // по Repo Health Score, то по HealthCraft Index, и по ней это должно быть видно
  const title = metricName ? `${CONTRIBUTIONS_TITLE} – ${metricName}` : CONTRIBUTIONS_TITLE;
  if (c === null) return { kind: "contributions", title, segments: [], rest: null, zones: zones(), note: "Вклады категорий не рассчитаны: у показателя нет категорий с данными." };
  const note = contributionsNote(c);
  if (c.kind !== "bar") return { kind: "contributions", title, segments: [], rest: null, zones: zones(), note };
  return {
    kind: "contributions",
    title,
    segments: c.segments.map((s) => ({ title: s.title, value: fmtContribution(s.tenths), share: s.tenths / 1000 })),
    rest: { title: CONTRIBUTIONS_REST, value: String(c.missing), share: c.missing / 100 },
    zones: zones(),
    note: null,
  };
}

function categoriesBlock(card: RepoCard, ctx: SubmetricContext): Block {
  const cats = card.score!.categories;
  return {
    kind: "categories",
    columns: ["Категория", "Балл", "Уровень", "Почему"],
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

function detailBlock(card: RepoCard, key: CategoryKey, cat: CardCategory, ctx: SubmetricContext, actionOf: Map<string, number>): Block {
  const rows: InlineLine[][] = [];
  const reference: string[] = [];
  const remarks: string[] = [];
  const weights = SUBWEIGHTS[key] as Record<string, number>;
  for (const [sub, entry] of Object.entries(cat.submetrics)) {
    const value = submetricShownValue(key, sub, entry, ctx, cat.submetrics);
    const remark = submetricNote(key, sub, entry.note)?.remark;
    if (remark) remarks.push(remark);
    if (displayOnly(key, sub)) {
      if (value !== "—") reference.push(`${submetricTitle(key, sub)} – ${value}`);
      continue;
    }
    const action = actionOf.get(`${key}.${sub}`);
    const weight = weights[subweightKey(sub)];
    rows.push([
      line(submetricTitle(key, sub)),
      action ? [text(value), text(` (действие ${action})`)] : line(value),
      line(entry.score === null || entry.score === undefined ? "—" : String(Math.round(entry.score * 100))),
      line(weight === undefined ? "—" : `${Math.round(weight * 100)}%`),
    ]);
  }
  if (key === "cicd" && cat.no_data) remarks.push(noDataReason(key, cat.no_data));
  if (key === "issues") {
    const close = closeDateNote(card);
    if (close) remarks.push(close);
  }
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

function methodSection(card: RepoCard, metric: Metric, c: Contributions | null): Block[] {
  const indexWeights = weightsText(PUBLIC, (k) => INDEX_WEIGHTS[k as keyof typeof INDEX_WEIGHTS]);
  const fullWeights = weightsText(CATEGORY_ORDER, (k) => SCORE_WEIGHTS[k]);
  const sum =
    c?.kind === "bar"
      ? ` В этом отчете: ${c.segments.map((s) => `${s.title} ${fmtContribution(s.tenths)}`).join(", ")} = ${c.total}.`
      : "";
  const items: InlineLine[] = [
    line("Оценка складывается из 4 категорий: документация, активность, задачи и состояние кода. Участникам репозитория видны еще 2 – CI/CD и безопасность."),
    line("Каждая категория получает балл от 0 до 100 из нескольких показателей. Например, для документации: README, лицензия, CONTRIBUTING, CODEOWNERS."),
    line(`${INDEX} – взвешенное среднее баллов категорий: ${indexWeights}.${metric.name === INDEX ? sum : ""}`),
    line(`${FULL} учитывает 6 категорий: ${fullWeights}. Если в коде найдены утекшие секреты, он не выше 49.${metric.name === FULL ? sum : ""}`),
    line(`Шкала: ${SCORE_SCALE.map((z) => `${z.word} ${z.range}`).join(", ")}.`),
    line(`Категория без данных не получает 0: она в оценке не участвует и ее не снижает. Если данных меньше ${fmtCoverage(COVERAGE_NULL_BELOW)}, оценка не рассчитывается.`),
    line("Популярность (реакции и ответвления) в оценку не входит, качество кода по существу не оценивается – только наблюдаемые признаки ухода за ним. Расчет и исходные данные – в приложении."),
  ];
  void card;
  return [h2("Как считается"), { kind: "list", items }];
}

// ---------- приложение (К9.4) ----------

const APPENDIX_TITLE = "Приложение. Расчет оценки и исходные данные";

function appendix(card: RepoCard, metric: Metric | null): Block[] {
  const out: Block[] = [{ kind: "appendix", title: APPENDIX_TITLE, intro: "В приложении приведен расчет оценки и источники чисел отчета. Баллы и доли показаны с точностью до десятых." }];
  out.push(...appendixA(card, metric));
  out.push(...appendixB(card, metric));
  out.push(...appendixC(card));
  out.push(...appendixD(card));
  return out;
}

const pct1 = (share: number): string => `${fmtDecimal(share * 100, 1)}%`;

function appendixA(card: RepoCard, metric: Metric | null): Block[] {
  const score = card.score!;
  const cats = score.categories;
  const out: Block[] = [h3("А. Расчет итоговой оценки")];
  const contributions = metric === null ? null : contributionsOf(card, metric);
  if (metric !== null && metric.value !== null) {
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
        rows.push([line(CATEGORY_TITLES[key]), line(cat.score === null ? "—" : fmtDecimal(cat.score, 1)), line("не входит"), line("—")]);
        continue;
      }
      const share = metric.weight(key) / wsum;
      const part = tenths.has(key) ? tenths.get(key)! / 10 : cat.score * share;
      total += part;
      rows.push([line(CATEGORY_TITLES[key]), line(fmtDecimal(cat.score, 1)), line(pct1(share)), line(fmtDecimal(part, 1))]);
    }
    const shown = Math.round(metric.value);
    const sumText = fmtDecimal(total, 1);
    rows.push([line("Итого"), line(""), line("100%"), line(Number(sumText.replace(",", ".")) === shown ? String(shown) : `${sumText} ≈ ${shown}`)]);
    out.push({
      kind: "table",
      columns: [col("Категория", "left", 184), col("Балл", "right", 84), col(`Вес в ${metric.name}`, "right", 114), col("Баллов в итог", "right")],
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
    if (Math.round(total) > Math.round(metric.value)) out.push({ kind: "paragraph", tone: "fine", lines: [line(`Итог ограничен ${Math.round(metric.value)} баллами: AppSec нашел утекшие секреты.`)] });
  }
  for (const key of CATEGORY_ORDER) {
    const cat = cats[key];
    if (!cat || cat.locked !== undefined || cat.score === null) continue;
    out.push(...categoryCalc(key, cat));
  }
  return out;
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
  return [title, { kind: "table", columns: [col("Показатель", "left", 184), col("Балл", "right", 84), col("Вес", "right", 114), col("Баллов в категорию", "right")], rows, total: true }];
}

const SOURCE_WORDS: [RegExp, string][] = [
  [/^git$/, "история git"],
  [/^rest:/, "API SourceCraft"],
  [/^appsec/, "AppSec SourceCraft"],
];

function sourceWord(source: string): string {
  return SOURCE_WORDS.find(([re]) => re.test(source))?.[1] ?? source;
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

function appendixB(card: RepoCard, metric: Metric | null): Block[] {
  const score = card.score!;
  const cats = score.categories;
  const rows: InlineLine[][] = [];
  const at = `расчет оценки, ${fmtDateTime(score.computedAt)}`;
  if (metric !== null && metric.value !== null) {
    rows.push([[strong(`${metric.name} ${Math.round(metric.value)}`)], line("сумма по категориям: балл × вес, приложение А"), line("баллы категорий"), line(at), line("—")]);
  } else {
    rows.push([[strong(`Собрано ${fmtCoverage(score.indexCoverage)} данных`)], line("вес категорий с данными из 65 весовых пунктов 4 открытых категорий"), [code("scores.index_coverage"), text(` → ${fmtDecimal(score.indexCoverage, 3, { trim: true })}`)], line(at), line("—")]);
  }
  const truncated = card.markers.historyTruncatedSince ? `история загружена с ${fmtDate(card.markers.historyTruncatedSince)}` : null;
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
      rows.push([
        line(`${submetricTitle(key, sub)}: ${shown}`),
        line(displayOnly(key, sub) || weight === undefined ? "справочно, в балл не входит" : `балл показателя × вес ${fmtDecimal(weight * 100, 0)}% в балле категории`),
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
  "activity.rest.contributors": "счетчик API; в оценке — число авторов из истории git",
  "activity.git.timeline.truncated": "история обрезана окном сбора, а не статусом анализа",
};

/** Г1.20: служебная заметка коллектора по-английски — читателю по-русски. */
function rawFieldValue(field: string, value: string): string {
  const m = /^completed_at missing on (\d+)\/(\d+) closed/.exec(value);
  if (field === "close_date_note" && m) return `дата закрытия не передана у ${m[1]} из ${m[2]} закрытых задач, использована дата последнего изменения`;
  return value;
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
  for (const fact of card.evidence as CardEvidence[]) {
    const catTitle = CATEGORY_TITLES[fact.category as CategoryKey] ?? fact.category;
    out.push({ kind: "paragraph", tone: "caption", lines: [[code(fact.key), text(` – ${catTitle}, ${factStatusWord(fact.status)}, ${sourceWord(fact.source)}, ${fmtDateTime(fact.collectedAt)}`)]] });
    out.push({
      kind: "table",
      columns: [col("Поле", "left", 180), col("Значение")],
      rows: flatten(fact.value).map(([k, v]) => {
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
    [line("Язык"), repo.language ? [escaped(repo.language)] : line("не определен")],
    [line("Реакции"), line(repo.likes === null ? "—" : String(repo.likes))],
    [line("Ответвления"), line(repo.forks === null ? "—" : String(repo.forks))],
    [line("Последняя активность"), line(fmtDate(repo.lastActivityAt))],
  );
  return [
    h3("Г. Версия методики, номер анализа и режим запуска"),
    { kind: "table", columns: [col("Поле", "left", 180), col("Значение")], rows, small: true },
  ];
}
