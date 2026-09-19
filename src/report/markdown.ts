// markdown.ts — MD-отчёт по карточке: полный разбор (решение канвы «ж»).
// Чистая функция от ответа `/api/repos/{org}/{repo}` — ни БД, ни сети:
// страница и отчёт обязаны показывать одно и то же, поэтому источник
// данных один. Документ самодостаточен: его можно читать без сервиса,
// и он же станет телом PDF в В6.
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
import { SECURITY_PUBLIC_NOTE, accessLockText, fmtSigned, gitLimitsText, scanStatusText, scanTriggerText, scoreWord } from "../web/format";

export { SECURITY_PUBLIC_NOTE };

const NO_DATA = "нет данных";

export function renderRepoReport(card: RepoCard): string {
  const lines: string[] = [];
  lines.push(...headerSection(card));
  lines.push(...summarySection(card));
  lines.push(...categoriesTable(card));
  lines.push(...categoriesDetail(card));
  lines.push(...recommendationsSection(card));
  lines.push(...evidenceSection(card));
  lines.push(...methodSection(card));
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------- 1. заголовок ----------

/**
 * В4.4 (кластер K/З7): заголовки отчёта экранируются — title репозитория
 * контролируется платформой/владельцем, «![](url)» или <img> в нём не должны
 * становиться tracking-pixel'ем в выгрузке. Бэкслеш-эскейп MD-спецсимволов
 * разметки ссылок/картинок/выделения + HTML-уголки сущностями.
 */
function mdEscape(text: string): string {
  return text
    .replace(/([\\`*_\[\]()!#|])/g, "\\$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function headerSection(card: RepoCard): string[] {
  const { repo, scan, score } = card;
  const out = [`# Repo Health: ${mdEscape(`${repo.org}/${repo.repo}`)}`, ""];
  if (repo.title && repo.title !== repo.repo) out.push(`_${mdEscape(repo.title)}_`, "");
  out.push(
    `- Репозиторий: ${repo.webUrl}`,
    // Ф2.9: один язык (RU) — статусы и триггеры словами, как на карточке
    `- Скан: ${scan ? `#${scan.id} от ${fmtDateTime(scan.finishedAt ?? scan.startedAt)} (статус ${scanStatusText(scan.status)}, запуск ${scanTriggerText(scan.trigger)})` : "не выполнялся"}`,
    `- Модель: ${score ? score.modelVersion : "—"}`,
    `- Язык: ${repo.language ? mdEscape(repo.language) : "не определён"}; лайки: ${num(repo.likes)}; форки: ${num(repo.forks)}`,
    `- Последняя активность: ${fmtDate(repo.lastActivityAt)}`,
    "",
  );
  return out;
}

// ---------- 2. итог ----------

function summarySection(card: RepoCard): string[] {
  const out = ["## Итог", ""];
  const score = card.score;
  if (card.markers.gitLimits) out.push(gitLimitsText(card.markers.gitLimits), "");
  // Ф2.9 (LOW-9): маркер codeEmpty — теми же словами, что на карточке
  if (card.markers.codeEmpty) {
    out.push(
      "В репозитории нет кода (ни одного файла): HealthCraft Index и Repo Health Score равны 0 — по методике это данные о проекте («проекта нет»), а не отсутствие оценки или сбой.",
      "",
    );
  }
  if (!score) {
    out.push(
      "Репозиторий есть в каталоге, но ещё не сканировался — фактов нет, поэтому нет и оценки.",
      "Отсутствие оценки здесь означает отсутствие данных, а не плохое состояние репозитория.",
      "",
    );
    return out;
  }
  if (score.healthcraftIndex === null) {
    out.push(
      `**Недостаточно данных для оценки.** Покрытие данными — ${pct(score.indexCoverage)} при пороге ${pct(COVERAGE_NULL_BELOW)}.`,
      "",
      "Это не ноль и не плохая оценка: при таком покрытии честного числа не существует.",
      "",
      "Каких данных не хватило:",
      "",
      ...score.noData.map((raw) => `- ${humanNoData(raw)}`),
      "",
    );
    return out;
  }

  const scored = categoryEntries(card).filter(([, c]) => c.score !== null) as [CategoryKey, CardCategory][];
  const best = [...scored].sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))[0];
  const worst = [...scored].sort((a, b) => (a[1].score ?? 0) - (b[1].score ?? 0))[0];
  const withDelta = card.recommendations.filter((r): r is CardRecommendation & { deltaScore: number } => r.deltaScore !== null);
  const top = withDelta.length > 0 ? withDelta.reduce((a, b) => ((a.deltaScore ?? 0) >= (b.deltaScore ?? 0) ? a : b)) : null;

  // В4.6 (У22): то же слово шкалы, что стоит у числа на карточке — отчёт и
  // страница обязаны говорить одно и то же (источник слова один, format.ts)
  out.push(
    `**HealthCraft Index (4 категории): ${Math.round(score.healthcraftIndex)} из 100 – ${scoreWord(score.healthcraftIndex)}** ` +
      `при покрытии данными ${pct(score.indexCoverage)}` +
      `${card.markers.staleFacts ? " (часть фактов взята из истории при сбое канала)" : ""}.`,
    "",
  );
  out.push(...fullScoreLine(card), "");
  out.push(
    "Индекс построен из публичных данных: CI/CD и Security в нём не участвуют по правилам платформы — разницу с полным показателем дают только они.",
    "",
  );
  if (best && worst) {
    out.push(
      `Сильнее всего — ${CATEGORY_TITLES[best[0]]} (${round(best[1].score)}), слабее всего — ` +
        `${CATEGORY_TITLES[worst[0]]} (${round(worst[1].score)}).`,
      "",
    );
  }
  out.push(
    `Рекомендаций: ${card.recommendations.length}` +
      // S-2 (круг 2 В4.4): тот же mdEscape, что у rec.problem в разделе рекомендаций —
      // непоследовательности защиты больше нет
      `${top ? `; наибольший измеримый прирост даёт «${mdEscape(top.problem)}» (${top.expectedImpact ?? fmtSigned(top.deltaScore)})` : ""}.`,
    "",
  );
  if (score.noData.length > 0) {
    out.push("Категории без данных (исключены с перенормировкой, показатели не занижены):", "");
    out.push(...score.noData.map((raw) => `- ${humanNoData(raw)}`), "");
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
        : `Разницу с HealthCraft Index дают CI и Security: ${fmtSigned(d)} — вклад двух каналов при их фактических данных.`,
    );
  }
  return lines;
}

// ---------- 3. таблица категорий ----------

function categoriesTable(card: RepoCard): string[] {
  if (!card.score) return [];
  const entries = categoryEntries(card);
  const dataWeight = entries.reduce((sum, [, c]) => (c.score === null ? sum : sum + c.weight), 0);
  const out = [
    "## Категории",
    "",
    "| Категория | Вес модели | Балл | Вклад после перенормировки | Статус |",
    "|---|---:|---:|---:|---|",
  ];
  for (const [key, cat] of entries) {
    const contribution = cat.score === null ? "0%" : `${Math.round((cat.weight / Math.max(1, dataWeight)) * 100)}%`;
    const status = cat.locked !== undefined ? "закрыто доступом" : cat.score === null ? NO_DATA : cat.stale ? "данные из истории" : "данные есть";
    out.push(`| ${CATEGORY_TITLES[key]} | ${cat.weight}% | ${cat.score === null ? "—" : round(cat.score)} | ${contribution} | ${status} |`);
  }
  out.push("");
  return out;
}

// ---------- 4. разбор по категориям ----------

function categoriesDetail(card: RepoCard): string[] {
  if (!card.score) return [];
  const out = ["## Разбор по категориям", ""];
  for (const [key, cat] of categoryEntries(card)) {
    const lock = accessLockText(cat.locked);
    out.push(`### ${CATEGORY_TITLES[key]} — ${lock !== null ? "закрыто" : cat.score === null ? NO_DATA : `${round(cat.score)} / 100`}`, "");
    if (lock !== null) {
      out.push(lock, "", "HealthCraft Index эту категорию не учитывает.", "");
      continue;
    }
    if (cat.score === null) {
      out.push(key === "security" ? SECURITY_PUBLIC_NOTE : humanNoData(`${key}: ${cat.no_data ?? ""}`), "");
      out.push("Категория не снизила Score: её вес выброшен, веса остальных категорий перенормированы.", "");
      continue;
    }
    if (cat.no_data) out.push(humanNoData(`${key}: ${cat.no_data}`), "");
    const subs = Object.entries(cat.submetrics);
    if (subs.length === 0) {
      out.push("Подметрики не рассчитывались.", "");
      continue;
    }
    out.push("| Подметрика | Балл (0–100) | Значение | Примечание |", "|---|---:|---|---|");
    for (const [subKey, sub] of subs) {
      // submetric приходит долей 0..1 — в отчёте показывается ×100, как и на странице
      const value = sub.score === null ? "—" : String(Math.round(sub.score * 100));
      out.push(`| ${subKey} | ${value} | ${cell(sub.value)} | ${cell(sub.note ?? "")} |`);
    }
    out.push("");
  }
  return out;
}

// ---------- 5. рекомендации ----------

function recommendationsSection(card: RepoCard): string[] {
  const out = ["## Рекомендации", ""];
  if (card.recommendations.length === 0) {
    out.push("Правила движка не нашли проблем на текущих фактах.", "");
    return out;
  }
  out.push(
    "Порядок задан движком: сперва измеримый прирост показателя (HealthCraft Index или Repo Health Score — смотрите строку эффекта), " +
      "затем то, что открывает закрытую категорию, затем улучшения по уже собранным данным. Каждая рекомендация привязана к фактам.",
    "",
  );
  for (const rec of card.recommendations) {
    out.push(`### ${rec.priority}. ${mdEscape(rec.problem)}`, "");
    out.push(`- Что сделать: ${rec.action}`);
    out.push(`- Эффект: ${impact(rec)}`);
    out.push(`- Факты: ${rec.factRefs.map((r) => `\`${r.key}\`${r.missing ? " (факта нет по построению)" : ""}`).join(", ")}`);
    out.push(`- Правило: \`${rec.ruleId}\` (источник: ${rec.source})`);
    if (rec.factRefs.some((r) => r.missing)) out.push(`- ${SECURITY_PUBLIC_NOTE}`);
    out.push("");
  }
  return out;
}

function impact(rec: CardRecommendation): string {
  // К-Ф1.2/К-Ф3.4: текст прироста уже содержит показатель, к которому он относится
  // («+N.N к HealthCraft Index» / «−N.N к Repo Health Score»)
  if (rec.deltaScore !== null) return rec.expectedImpact ?? fmtSigned(rec.deltaScore);
  if (rec.opensCategory) return `откроет категорию${rec.expectedImpact ? ` — ${rec.expectedImpact}` : ""}`;
  return rec.expectedImpact ?? "улучшение по уже собранным данным";
}

// ---------- 6. доказательная база ----------

function evidenceSection(card: RepoCard): string[] {
  const out = ["## Доказательная база", ""];
  if (card.evidence.length === 0) {
    out.push("Фактов по этому скану нет.", "");
    return out;
  }
  out.push(
    "Каждое число выше получено из этих фактов. Тяжёлые значения (история коммитов) показаны агрегатом — " +
      "сырьё коммитов не хранится и не выгружается.",
    "",
    "| Факт (kind) | Категория | Статус | Источник | Собрано | Значение |",
    "|---|---|---|---|---|---|",
  );
  for (const fact of card.evidence) {
    out.push(
      `| \`${fact.key}\` | ${fact.category} | ${factStatus(fact)} | ${fact.source} | ${fmtDateTime(fact.collectedAt)} | ${cell(fact.value)} |`,
    );
  }
  out.push("");
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

function methodSection(card: RepoCard): string[] {
  const fullWeights = card.score
    ? categoryEntries(card)
        .map(([key, cat]) => `${CATEGORY_TITLES[key]} ${cat.weight}%`)
        .join(", ")
    : CATEGORY_ORDER.map((key) => `${CATEGORY_TITLES[key]} ${SCORE_WEIGHTS[key]}%`).join(", ");
  const indexWeights = (Object.keys(INDEX_WEIGHTS) as (keyof typeof INDEX_WEIGHTS)[])
    .map((key) => `${CATEGORY_TITLES[key]} ${INDEX_WEIGHTS[key]}%`)
    .join(", ");
  return [
    "## Как считается и что это не значит",
    "",
    "- **Два показателя:** HealthCraft Index — публичная проекция из 4 категорий (порядок в рейтинге), Repo Health Score — полный показатель из 6 категорий (кап 49 за критичные secrets). Полный считается на чтении из фактически показанных категорий и нигде не хранится.",
    `- **Веса HealthCraft Index (публичная четвёрка):** ${indexWeights} — перенормированная редукция весов полного показателя (источник и правило вывода — методика).`,
    `- **Веса Repo Health Score (номинальные):** ${fullWeights}. Каждый показатель — взвешенное среднее баллов категорий, у которых есть данные.`,
    "- **Перенормировка (tri-state):** категория без данных не получает ноль — её вес выбрасывается, а веса остальных пересчитываются. Отсутствие данных никогда не ухудшает показатель.",
    `- **Порог «недостаточно данных»:** при покрытии ниже ${pct(COVERAGE_NULL_BELOW)} показатель не выставляется вовсе (значение NULL), потому что честного числа на таких данных нет.`,
    `- **CI/CD и Security:** в HealthCraft Index не входят (раны чужих репо и AppSec платформа публично не отдаёт); Repo Health Score с ними виден зрителю с доступом к этим данным. ${SECURITY_PUBLIC_NOTE}`,
    "- **Что это НЕ значит:** показатели не измеряют популярность (лайки и форки в формулу не входят), не оценивают качество кода по существу и не заменяют ревью. Они измеряют наблюдаемые признаки здоровья репозитория теми данными, которые доступны.",
    "- **Ограничения методики:** часть сигналов недоступна снаружи (статусы CI чужих репозиториев, AppSec без права доступа), крупные репозитории читаются деградационным ярусом с усечённой историей, а активность зеркал занижается детектором роботов не полностью.",
    `- **Методика целиком:** ${METHODOLOGY_PATH} (раздел §12 — известные ограничения).`,
    "",
    `Отчёт сформирован детерминированно из фактов скана, без участия LLM.`,
    "",
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
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
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
    return `${prefix}прогоны CI недоступны (закрыты правами или их нет) — категория ограничена потолком 50.`;
  }
  if (reason === "git channel no-data") return `${prefix}git-канал не отдал данные (клон не удался или упёрся в лимиты).`;
  if (reason === "git+rest channels no-data") return `${prefix}ни git-, ни REST-канал не отдали данных.`;
  if (reason === "issues channel no-data") return `${prefix}данные трекера задач недоступны.`;
  return `${prefix}${reason || NO_DATA}`;
}
