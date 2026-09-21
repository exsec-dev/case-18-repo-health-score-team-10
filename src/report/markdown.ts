// markdown.ts — отчёт по карточке: полный разбор (решение канвы «ж»).
// Чистая функция от ответа `/api/repos/{org}/{repo}` — ни БД, ни сети:
// страница и отчёт обязаны показывать одно и то же, поэтому источник
// данных один. Документ самодостаточен: его можно читать без сервиса.
//
// В4.7 (контракт П1): отчёт описывается МОДЕЛЬЮ блоков (`model.ts`) —
// `buildReportModel` строит её здесь, `renderRepoReport` сериализует в MD,
// `pdf.ts` рендерит ту же модель в PDF. MD-вывод байт-в-байт равен выводу
// до перевода на модель (эталоны tests/fixtures/report, снятые в Б0).
import {
  CATEGORY_ORDER,
  CATEGORY_TITLES,
  METHODOLOGY_PATH,
  type CardCategory,
  type CardEvidence,
  type CardRecommendation,
  type RepoCard,
} from "../api/repos";
import { COVERAGE_NULL_BELOW, INDEX_WEIGHTS, SCORE_WEIGHTS, type CategoryKey } from "../score/model";
// копии про Security и заглушки доступа — одни и те же на странице и в отчёте
import { SECURITY_PUBLIC_NOTE, accessLockText, contributionText, fmtSigned, gitLimitsText, roundFacts, scanStatusText, scanTriggerText, scoreWord, summaryLine } from "../web/format";
import {
  CELL_MAX_CHARS,
  cellValue,
  code,
  em,
  escaped,
  prepared,
  strong,
  text,
  type Block,
  type Inline,
  type InlineLine,
  type ReportModel,
  type TableColumn,
} from "./model";

export { SECURITY_PUBLIC_NOTE };

const NO_DATA = "нет данных";

/** MD-отчёт карточки: модель → markdown. */
export function renderRepoReport(card: RepoCard): string {
  return serializeMarkdown(buildReportModel(card));
}

/** Модель отчёта карточки — общий источник MD и PDF. */
export function buildReportModel(card: RepoCard): ReportModel {
  const blocks: Block[] = [
    ...headerSection(card),
    ...summarySection(card),
    ...categoriesTable(card),
    ...categoriesDetail(card),
    ...recommendationsSection(card),
    ...evidenceSection(card),
    ...methodSection(card),
  ];
  return { fileStem: `${card.repo.org}-${card.repo.repo}-health`, blocks };
}

// ---------- MD-сериализатор ----------

/** Модель → markdown: каждый блок, затем пустая строка; хвост обрезан до одного перевода строки. */
export function serializeMarkdown(model: ReportModel): string {
  const lines: string[] = [];
  for (const block of model.blocks) lines.push(...blockLines(block), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function blockLines(block: Block): string[] {
  switch (block.kind) {
    case "heading":
      return [`${"#".repeat(block.level)} ${lineMd(block.content)}`];
    case "paragraph":
      return block.lines.map(lineMd);
    case "list":
      return block.items.map((item) => `- ${lineMd(item)}`);
    case "table":
      return [
        `| ${block.columns.map((c) => c.title).join(" | ")} |`,
        `|${block.columns.map((c) => (c.align === "right" ? "---:" : "---")).join("|")}|`,
        ...block.rows.map((row) => `| ${row.map(lineMd).join(" | ")} |`),
      ];
  }
}

function lineMd(line: InlineLine): string {
  return line.map(inlineMd).join("");
}

function inlineMd(fragment: Inline): string {
  switch (fragment.kind) {
    case "text":
      return fragment.text;
    case "escaped":
      return mdEscape(fragment.text);
    case "code":
      return `\`${fragment.text}\``;
    case "em":
      return `_${mdEscape(fragment.text)}_`;
    case "strong":
      return `**${fragment.text}**`;
    case "cell":
      return cell(fragment.value);
    case "prepared":
      return fragment.md;
  }
}

/**
 * В4.4 (кластер K/З7): заголовки отчёта экранируются — title репозитория
 * контролируется платформой/владельцем, «![](url)» или <img> в нём не должны
 * становиться tracking-pixel'ем в выгрузке. Бэкслеш-эскейп MD-спецсимволов
 * разметки ссылок/картинок/выделения + HTML-уголки сущностями.
 */
function mdEscape(value: string): string {
  return value
    .replace(/([\\`*_\[\]()!#|])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- построители разделов ----------

const para = (...lines: InlineLine[]): Block => ({ kind: "paragraph", lines });
const line = (value: string): InlineLine => [text(value)];
const heading = (level: 1 | 2 | 3, ...content: Inline[]): Block => ({ kind: "heading", level, content });
const list = (items: InlineLine[]): Block => ({ kind: "list", items });
const table = (columns: [string, "left" | "right"][], rows: InlineLine[][]): Block => ({
  kind: "table",
  columns: columns.map(([title, align]): TableColumn => ({ title, align })),
  rows,
});

// ---------- 1. заголовок ----------

function headerSection(card: RepoCard): Block[] {
  const { repo, scan, score } = card;
  const out: Block[] = [heading(1, text("Repo Health: "), escaped(`${repo.org}/${repo.repo}`))];
  if (repo.title && repo.title !== repo.repo) out.push(para([em(repo.title)]));
  out.push(
    list([
      line(`Репозиторий: ${repo.webUrl}`),
      // Ф2.9: один язык (RU) — статусы и триггеры словами, как на карточке
      line(`Скан: ${scan ? `#${scan.id} от ${fmtDateTime(scan.finishedAt ?? scan.startedAt)} (статус ${scanStatusText(scan.status)}, запуск ${scanTriggerText(scan.trigger)})` : "не выполнялся"}`),
      line(`Модель: ${score ? score.modelVersion : "—"}`),
      [text("Язык: "), repo.language ? escaped(repo.language) : text("не определен"), text(`; лайки: ${num(repo.likes)}; форки: ${num(repo.forks)}`)],
      line(`Последняя активность: ${fmtDate(repo.lastActivityAt)}`),
    ]),
  );
  return out;
}

// ---------- 2. итог ----------

function summarySection(card: RepoCard): Block[] {
  const out: Block[] = [heading(2, text("Итог"))];
  const score = card.score;
  if (card.markers.gitLimits) out.push(para(line(gitLimitsText(card.markers.gitLimits))));
  // Ф2.9 (LOW-9): маркер codeEmpty — теми же словами, что на карточке
  if (card.markers.codeEmpty) {
    out.push(
      para(
        line(
          "В репозитории нет кода (ни одного файла): HealthCraft Index и Repo Health Score равны 0 – по методике это данные о проекте («проекта нет»), а не отсутствие оценки или сбой.",
        ),
      ),
    );
  }
  if (!score) {
    out.push(
      para(
        line("Репозиторий есть в каталоге, но еще не сканировался – фактов нет, поэтому нет и оценки."),
        line("Отсутствие оценки здесь означает отсутствие данных, а не плохое состояние репозитория."),
      ),
    );
    return out;
  }
  if (score.healthcraftIndex === null) {
    out.push(
      para([strong("Недостаточно данных для оценки."), text(` Покрытие данными – ${pct(score.indexCoverage)} при пороге ${pct(COVERAGE_NULL_BELOW)}.`)]),
      para(line("Это не ноль и не плохая оценка: при таком покрытии честного числа не существует.")),
      para(line("Каких данных не хватило:")),
      list(score.noData.map((raw) => line(humanNoData(raw)))),
    );
    return out;
  }

  const withDelta = card.recommendations.filter((r): r is CardRecommendation & { deltaScore: number } => r.deltaScore !== null);
  const top = withDelta.length > 0 ? withDelta.reduce((a, b) => ((a.deltaScore ?? 0) >= (b.deltaScore ?? 0) ? a : b)) : null;

  // В4.6 (У22): то же слово шкалы, что стоит у числа на карточке — отчёт и
  // страница обязаны говорить одно и то же (источник слова один, format.ts)
  out.push(
    para([
      strong(`HealthCraft Index (4 категории): ${Math.round(score.healthcraftIndex)} из 100 – ${scoreWord(score.healthcraftIndex)}`),
      text(` при покрытии данными ${pct(score.indexCoverage)}${card.markers.staleFacts ? " (часть фактов взята из истории при сбое канала)" : ""}.`),
    ]),
  );
  out.push(para(...fullScoreLine(card).map(line)));
  out.push(
    para(line("Индекс построен из публичных данных: CI/CD и Security в нем не участвуют по правилам платформы – разницу с полным показателем дают только они.")),
  );
  // В4.6 (У26/У13): СТРОКА ИТОГА берётся из общего генератора
  // (`src/web/format.ts`), чтобы на карточке и в отчёте стояла ОДНА
  // формулировка. Экранирование остаётся здесь: `top.problem` уходит в
  // генератор УЖЕ пропущенным через mdEscape — тот же, что у rec.problem
  // в разделе рекомендаций (S-2 круга 2 В4.4 не регрессирует).
  // В4.7 (П1): генератор зовётся ДВАЖДЫ — с экранированной проблемой для MD
  // и с сырой для плоского текста (PDF); разбора MD обратно нет.
  const summaryOf = (problem: (raw: string) => string): string =>
    summaryLine({
      categories: categoryEntries(card).map(([key, cat]) => ({ title: CATEGORY_TITLES[key], score: cat.score })),
      recommendations: card.recommendations.length,
      top: top ? { problem: problem(top.problem), impact: top.expectedImpact ?? fmtSigned(top.deltaScore) } : null,
    });
  out.push(para([prepared(summaryOf(mdEscape), summaryOf((raw) => raw))]));
  if (score.noData.length > 0) {
    out.push(para(line("Категории без данных (исключены с перенормировкой, показатели не занижены):")));
    out.push(list(score.noData.map((raw) => line(humanNoData(raw)))));
  }
  return out;
}

/**
 * Repo Health Score (6 категорий, с CI и Security) — отдельной строкой;
 * NULL — честно «недостаточно данных». Рядом — ФАКТИЧЕСКАЯ signed-дельта
 * с индексом: знак не обещается (плохие CI/Security опускают полный
 * показатель ниже индекса — инверсия законна, К-Ф3.4).
 */
function fullScoreLine(card: RepoCard): string[] {
  const score = card.score!;
  if (score.fullLocked) {
    return ["Repo Health Score (с CI и Security) виден зрителю с доступом к CI и Security этого репозитория."];
  }
  if (score.repoHealthScore === null || score.repoHealthCoverage === null) {
    return ["Repo Health Score (с CI и Security): недостаточно данных для оценки."];
  }
  const lines = [
    `Repo Health Score (6 категорий, с CI и Security): ${Math.round(score.repoHealthScore)} из 100 при покрытии данными ${pct(score.repoHealthCoverage)}.`,
  ];
  if (score.healthcraftIndex !== null) {
    const d = score.repoHealthScore - score.healthcraftIndex;
    // M-13: |Δ| < 0.05 — «разницы нет», не «+0.0» (паритет со страницей)
    lines.push(
      Math.abs(d) < 0.05
        ? "Разницы нет: CI и Security на этом скане нейтральны."
        : `Разницу с HealthCraft Index дают CI и Security: ${fmtSigned(d)} – вклад двух каналов при их фактических данных.`,
    );
  }
  return lines;
}

// ---------- 3. таблица категорий ----------

function categoriesTable(card: RepoCard): Block[] {
  if (!card.score) return [];
  const entries = categoryEntries(card);
  const dataWeight = entries.reduce((sum, [, c]) => (c.score === null ? sum : sum + c.weight), 0);
  const rows: InlineLine[][] = [];
  for (const [key, cat] of entries) {
    // В4.6 (У25, ДП6): у категории без данных вклад не нулевой, а НЕ СУЩЕСТВУЕТ:
    // вес выброшен и перенормирован. «0%» читалось как «категория дала ноль».
    const contribution = contributionText(cat.score, Math.round((cat.weight / Math.max(1, dataWeight)) * 100));
    // В4.6 круг 2 (Р12): ячейка «Статус» говорит «Недоступно» — то же слово,
    // что на карточке. «закрыто доступом» было ещё и тавтологией: причина
    // доступа стоит абзацем ниже, в разборе категории.
    const status = cat.locked !== undefined ? "Недоступно" : cat.score === null ? NO_DATA : cat.stale ? "данные из истории" : "данные есть";
    rows.push([line(CATEGORY_TITLES[key]), line(`${cat.weight}%`), line(cat.score === null ? "—" : round(cat.score)), line(contribution), line(status)]);
  }
  return [
    heading(2, text("Категории")),
    table(
      [
        ["Категория", "left"],
        ["Вес модели", "right"],
        ["Балл", "right"],
        ["Вклад после перенормировки", "right"],
        ["Статус", "left"],
      ],
      rows,
    ),
  ];
}

// ---------- 4. разбор по категориям ----------

function categoriesDetail(card: RepoCard): Block[] {
  if (!card.score) return [];
  const out: Block[] = [heading(2, text("Разбор по категориям"))];
  for (const [key, cat] of categoryEntries(card)) {
    const lock = accessLockText(cat.locked);
    // В4.6 круг 2 (Р12): заголовок разбора — тем же словом, что ячейка «Статус»
    out.push(heading(3, text(`${CATEGORY_TITLES[key]} – ${lock !== null ? "Недоступно" : cat.score === null ? NO_DATA : `${round(cat.score)} / 100`}`)));
    if (lock !== null) {
      out.push(para(line(lock)), para(line("HealthCraft Index эту категорию не учитывает.")));
      continue;
    }
    if (cat.score === null) {
      out.push(para(line(key === "security" ? SECURITY_PUBLIC_NOTE : humanNoData(`${key}: ${cat.no_data ?? ""}`))));
      out.push(para(line("Категория не снизила Score: ее вес выброшен, веса остальных категорий перенормированы.")));
      continue;
    }
    if (cat.no_data) out.push(para(line(humanNoData(`${key}: ${cat.no_data}`))));
    const subs = Object.entries(cat.submetrics);
    if (subs.length === 0) {
      out.push(para(line("Подметрики не рассчитывались.")));
      continue;
    }
    const rows: InlineLine[][] = [];
    for (const [subKey, sub] of subs) {
      // submetric приходит долей 0..1 — в отчёте показывается ×100, как и на странице
      const value = sub.score === null ? "—" : String(Math.round(sub.score * 100));
      // В4.6 круг 2 (Р20): значение подметрики округляется тем же правилом,
      // что на странице (`roundFacts`) — доли до 2 знаков, целые без хвоста.
      // Раздел «Доказательная база» ниже печатает значения СЫРЫМИ: там их
      // задача — воспроизводимость, а не читаемость.
      rows.push([line(subKey), line(value), [cellValue(roundFacts(sub.value))], [cellValue(sub.note ?? "")]]);
    }
    out.push(
      table(
        [
          ["Подметрика", "left"],
          ["Балл (0-100)", "right"],
          ["Значение", "left"],
          ["Примечание", "left"],
        ],
        rows,
      ),
    );
  }
  return out;
}

// ---------- 5. рекомендации ----------

function recommendationsSection(card: RepoCard): Block[] {
  const out: Block[] = [heading(2, text("Рекомендации"))];
  if (card.recommendations.length === 0) {
    out.push(para(line("Правила движка не нашли проблем на текущих фактах.")));
    return out;
  }
  out.push(
    para(
      line(
        "Порядок задан движком: сперва измеримый прирост показателя (HealthCraft Index или Repo Health Score – смотрите строку эффекта), " +
          "затем то, что открывает закрытую категорию, затем улучшения по уже собранным данным. Каждая рекомендация привязана к фактам.",
      ),
    ),
  );
  for (const rec of card.recommendations) {
    out.push(heading(3, text(`${rec.priority}. `), escaped(rec.problem)));
    const facts: Inline[] = [text("Факты: ")];
    rec.factRefs.forEach((r, i) => {
      if (i > 0) facts.push(text(", "));
      facts.push(code(r.key));
      if (r.missing) facts.push(text(" (факта нет по построению)"));
    });
    const items: InlineLine[] = [
      line(`Что сделать: ${rec.action}`),
      line(`Эффект: ${impact(rec)}`),
      facts,
      [text("Правило: "), code(rec.ruleId), text(` (источник: ${rec.source})`)],
    ];
    if (rec.factRefs.some((r) => r.missing)) items.push(line(SECURITY_PUBLIC_NOTE));
    out.push(list(items));
  }
  return out;
}

function impact(rec: CardRecommendation): string {
  // К-Ф1.2/К-Ф3.4: текст прироста уже содержит показатель, к которому он относится
  // («+N.N к HealthCraft Index» / «−N.N к Repo Health Score»)
  if (rec.deltaScore !== null) return rec.expectedImpact ?? fmtSigned(rec.deltaScore);
  if (rec.opensCategory) return `откроет категорию${rec.expectedImpact ? ` – ${rec.expectedImpact}` : ""}`;
  return rec.expectedImpact ?? "улучшение по уже собранным данным";
}

// ---------- 6. доказательная база ----------

function evidenceSection(card: RepoCard): Block[] {
  const out: Block[] = [heading(2, text("Доказательная база"))];
  if (card.evidence.length === 0) {
    out.push(para(line("Фактов по этому скану нет.")));
    return out;
  }
  out.push(
    para(
      line(
        "Каждое число выше получено из этих фактов. Тяжелые значения (история коммитов) показаны агрегатом – " +
          "сырье коммитов не хранится и не выгружается.",
      ),
    ),
  );
  out.push(
    table(
      [
        ["Факт (kind)", "left"],
        ["Категория", "left"],
        ["Статус", "left"],
        ["Источник", "left"],
        ["Собрано", "left"],
        ["Значение", "left"],
      ],
      card.evidence.map((fact) => [
        [code(fact.key)],
        line(fact.category),
        line(factStatus(fact)),
        line(fact.source),
        line(fmtDateTime(fact.collectedAt)),
        [cellValue(fact.value)],
      ]),
    ),
  );
  return out;
}

function factStatus(fact: CardEvidence): string {
  switch (fact.status) {
    case "ok":
      return "данные есть";
    case "no-data":
      return "данных нет";
    case "bad":
      return "сбой канала";
    default:
      return fact.status;
  }
}

// ---------- 7. как считается ----------

function methodSection(card: RepoCard): Block[] {
  const fullWeights = card.score
    ? categoryEntries(card)
        .map(([key, cat]) => `${CATEGORY_TITLES[key]} ${cat.weight}%`)
        .join(", ")
    : CATEGORY_ORDER.map((key) => `${CATEGORY_TITLES[key]} ${SCORE_WEIGHTS[key]}%`).join(", ");
  const indexWeights = (Object.keys(INDEX_WEIGHTS) as (keyof typeof INDEX_WEIGHTS)[])
    .map((key) => `${CATEGORY_TITLES[key]} ${INDEX_WEIGHTS[key]}%`)
    .join(", ");
  const item = (title: string, rest: string): InlineLine => [strong(title), text(rest)];
  return [
    heading(2, text("Как считается и что это не значит")),
    list([
      item(
        "Два показателя:",
        " HealthCraft Index – публичная проекция из 4 категорий (порядок в рейтинге), Repo Health Score – полный показатель из 6 категорий (кап 49 за критичные secrets). Полный считается на чтении из фактически показанных категорий и нигде не хранится.",
      ),
      item(
        "Веса HealthCraft Index (публичные 4 категории):",
        ` ${indexWeights} – перенормированная редукция весов полного показателя (источник и правило вывода – методика).`,
      ),
      item("Веса Repo Health Score (номинальные):", ` ${fullWeights}. Каждый показатель – взвешенное среднее баллов категорий, у которых есть данные.`),
      item(
        "Перенормировка (tri-state):",
        " категория без данных не получает ноль – ее вес выбрасывается, а веса остальных пересчитываются. Отсутствие данных никогда не ухудшает показатель.",
      ),
      item(
        "Порог «недостаточно данных»:",
        ` при покрытии ниже ${pct(COVERAGE_NULL_BELOW)} показатель не выставляется вовсе (значение NULL), потому что честного числа на таких данных нет.`,
      ),
      item(
        "CI/CD и Security:",
        ` в HealthCraft Index не входят (раны чужих репо и AppSec платформа публично не отдает); Repo Health Score с ними виден зрителю с доступом к этим данным. ${SECURITY_PUBLIC_NOTE}`,
      ),
      item(
        "Что это НЕ значит:",
        " показатели не измеряют популярность (лайки и форки в формулу не входят), не оценивают качество кода по существу и не заменяют ревью. Они измеряют наблюдаемые признаки здоровья репозитория теми данными, которые доступны.",
      ),
      item(
        "Ограничения методики:",
        " часть сигналов недоступна снаружи (статусы CI чужих репозиториев, AppSec без права доступа), крупные репозитории читаются деградационным ярусом с усеченной историей, а активность зеркал занижается детектором роботов не полностью.",
      ),
      item("Методика целиком:", ` ${METHODOLOGY_PATH} (раздел §12 – известные ограничения).`),
    ]),
    para(line(`Отчет сформирован детерминированно из фактов скана, без участия LLM.`)),
  ];
}

// ---------- утилиты ----------

function categoryEntries(card: RepoCard): [CategoryKey, CardCategory][] {
  const cats = card.score!.categories;
  return CATEGORY_ORDER.filter((key) => cats[key] !== undefined).map((key) => [key, cats[key]!]);
}

function round(x: number | null): string {
  if (x === null) return "—";
  return String(Math.round(x * 10) / 10);
}

function num(x: number | null): string {
  return x === null ? "—" : String(x);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Ячейка таблицы: переносы и вертикальные черты ломают markdown-таблицу. */
function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const flat = raw.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  return flat.length > CELL_MAX_CHARS ? `${flat.slice(0, CELL_MAX_CHARS)}…` : flat;
}

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function fmtDateTime(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}

/** Те же формулировки, что на странице: причины движка по-английски. */
function humanNoData(raw: string): string {
  const [category = "", ...rest] = raw.split(":");
  const reason = rest.join(":").trim();
  const prefix = category === "security" ? "" : `${CATEGORY_TITLES[category as CategoryKey] ?? category}: `;
  if (category === "security" || reason.startsWith("AppSec data unavailable")) return SECURITY_PUBLIC_NOTE;
  if (reason.startsWith("ci runs no-data")) {
    return `${prefix}прогоны CI недоступны (закрыты правами или их нет) – категория ограничена потолком 50.`;
  }
  if (reason === "git channel no-data") return `${prefix}git-канал не отдал данные (клон не удался или уперся в лимиты).`;
  if (reason === "git+rest channels no-data") return `${prefix}ни git-, ни REST-канал не отдали данных.`;
  if (reason === "issues channel no-data") return `${prefix}данные трекера задач недоступны.`;
  return `${prefix}${reason || NO_DATA}`;
}
