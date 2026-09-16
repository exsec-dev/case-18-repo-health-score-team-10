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
import { COVERAGE_NULL_BELOW, type CategoryKey } from "../score/model";
// копии про Security и заглушки доступа — одни и те же на странице и в отчёте
import { SECURITY_PUBLIC_NOTE, accessLockText } from "../web/format";

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

function headerSection(card: RepoCard): string[] {
  const { repo, scan, score } = card;
  const out = [`# Repo Health: ${repo.org}/${repo.repo}`, ""];
  if (repo.title && repo.title !== repo.repo) out.push(`_${repo.title}_`, "");
  out.push(
    `- Репозиторий: ${repo.webUrl}`,
    `- Скан: ${scan ? `#${scan.id} от ${fmtDateTime(scan.finishedAt ?? scan.startedAt)} (статус ${scan.status}, запуск ${scan.trigger})` : "не выполнялся"}`,
    `- Модель: ${score ? score.modelVersion : "—"}`,
    `- Язык: ${repo.language ?? "не определён"}; лайки: ${num(repo.likes)}; форки: ${num(repo.forks)}`,
    `- Последняя активность: ${fmtDate(repo.lastActivityAt)}`,
    "",
  );
  return out;
}

// ---------- 2. итог ----------

function summarySection(card: RepoCard): string[] {
  const out = ["## Итог", ""];
  const score = card.score;
  if (!score) {
    out.push(
      "Репозиторий есть в каталоге, но ещё не сканировался — фактов нет, поэтому нет и Score.",
      "Отсутствие оценки здесь означает отсутствие данных, а не плохое состояние репозитория.",
      "",
    );
    return out;
  }
  if (score.totalRating === null) {
    out.push(
      `**Недостаточно данных для оценки.** Покрытие данными — ${pct(score.coverageRating)} при пороге ${pct(COVERAGE_NULL_BELOW)}.`,
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
  const withDelta = card.recommendations.filter((r) => r.deltaScore !== null);
  const top = withDelta.length > 0 ? withDelta.reduce((a, b) => ((a.deltaScore ?? 0) >= (b.deltaScore ?? 0) ? a : b)) : null;

  out.push(
    `**Score в рейтинге (4 категории): ${Math.round(score.totalRating)} из 100** при покрытии данными ${pct(score.coverageRating)}` +
      `${card.markers.staleFacts ? " (часть фактов взята из истории при сбое канала)" : ""}.`,
    "",
  );
  out.push(...fullScoreLine(card), "");
  if (best && worst) {
    out.push(
      `Сильнее всего — ${CATEGORY_TITLES[best[0]]} (${round(best[1].score)}), слабее всего — ` +
        `${CATEGORY_TITLES[worst[0]]} (${round(worst[1].score)}).`,
      "",
    );
  }
  out.push(
    `Рекомендаций: ${card.recommendations.length}` +
      `${top ? `; наибольший измеримый прирост даёт «${top.problem}» (+${round(top.deltaScore)} Score)` : ""}.`,
    "",
  );
  if (score.noData.length > 0) {
    out.push("Категории без данных (исключены с перенормировкой, Score не занижен):", "");
    out.push(...score.noData.map((raw) => `- ${humanNoData(raw)}`), "");
  }
  return out;
}

/** Полный Score (6 категорий) — отдельной строкой; NULL — честно «недостаточно данных». */
function fullScoreLine(card: RepoCard): string[] {
  const score = card.score!;
  if (score.fullLocked) {
    return ["Полный Score (с CI и Security) виден зрителю с доступом к CI и Security этого репозитория."];
  }
  if (score.totalFull === null || score.coverageFull === null) {
    return ["Полный Score (с CI и Security): недостаточно данных для оценки."];
  }
  return [`Полный Score (с CI и Security): ${Math.round(score.totalFull)} из 100 при покрытии данными ${pct(score.coverageFull)}.`];
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
    const status = cat.locked !== undefined ? "закрыто доступом" : cat.score === null ? NO_DATA : cat.stale ? "данные из истории (stale)" : "данные есть";
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
      out.push(lock, "", "Score в рейтинге эту категорию не учитывает.", "");
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
    "Порядок задан движком: сперва измеримый прирост Score, затем то, что открывает закрытую категорию, " +
      "затем улучшения по уже собранным данным. Каждая рекомендация привязана к фактам.",
    "",
  );
  for (const rec of card.recommendations) {
    out.push(`### ${rec.priority}. ${rec.problem}`, "");
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
  if (rec.deltaScore !== null) return `+${round(rec.deltaScore)} Score${rec.expectedImpact ? ` — ${rec.expectedImpact}` : ""}`;
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
  const weights = card.score
    ? categoryEntries(card)
        .map(([key, cat]) => `${CATEGORY_TITLES[key]} ${cat.weight}%`)
        .join(", ")
    : CATEGORY_ORDER.map((key) => CATEGORY_TITLES[key]).join(", ");
  return [
    "## Как считается и что это не значит",
    "",
    `- **Веса категорий (номинальные):** ${weights}. Score — взвешенное среднее баллов категорий, у которых есть данные.`,
    "- **Перенормировка (tri-state):** категория без данных не получает ноль — её вес выбрасывается, а веса остальных пересчитываются. Отсутствие данных никогда не ухудшает Score.",
    `- **Порог «недостаточно данных»:** при покрытии ниже ${pct(COVERAGE_NULL_BELOW)} Score не выставляется вовсе (значение NULL), потому что честного числа на таких данных нет.`,
    `- **CI/CD и Security:** в Score в рейтинге не входят (4 категории); полный Score с ними виден зрителю с доступом к этим данным. ${SECURITY_PUBLIC_NOTE}`,
    "- **Что это НЕ значит:** Score не измеряет популярность (лайки и форки в формулу не входят), не оценивает качество кода по существу и не заменяет ревью. Он измеряет наблюдаемые признаки здоровья репозитория теми данными, которые доступны публично.",
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
