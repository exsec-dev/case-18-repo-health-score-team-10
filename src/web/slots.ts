// slots.ts — МЕСТА под поверхности вехи В5 (контракт У18 вехи В4.6).
//
// Зачем слоты заранее: В5 приносит AI-summary, график истории Score, публичный
// badge и раздел сравнения репозиториев. Если их места не заложить сейчас,
// звёздочка полезет переверстывать страницы вместо того, чтобы наполнять
// готовые места данными — а окно до неё измеряется днями.
//
// Что такое слот по определению вехи: ВИДИМОЕ место с честным состоянием
// «пока нет данных». Без выдуманных чисел и без мёртвых кнопок — ровно тот
// дефект (мёртвая кнопка PDF), который эта же веха убирает, и прямой риск по
// критерию ТЗ 13.4 «подтверждение заявленных возможностей». Поэтому в слотах
// нет ни одного контроля: форма ступени описана словами, а действие появится вместе
// со сценарием.
//
// Имена полей — ИЗ СПЕКИ В5 (reports/2026-09-20-m5-plan.md), а не свои: если
// они разъедутся, В5 переделает слоты, и работа этой вехи потеряется.
// Источники: К5.4 (AI-summary и ступень оп-ина), К5.7 (история Score),
// К5.8 (публичный API и badge), К5.15 (сравнение репозиториев).

import type { HistoryPoint, HistoryResponse } from "../summary/history-contract";
import { AI_SECTION_TITLE } from "./format";

/**
 * Контракты полей слотов. Ключ — слот, значение — имена полей, которые В5
 * обязана отдать (или, для `compare`, имена столбцов сравнения). Проверяются
 * тестом: расхождение имён с этим списком — сигнал, что спека В5 изменилась и
 * слот надо пересогласовать, а не тихо переименовать.
 */
export const SLOT_CONTRACTS: Record<"aiSummary" | "scoreHistory" | "badge" | "compare", readonly string[]> = {
  /**
   * К5.4. Хранение: текст + набор `fact_ref` + версия хартии + версия модели
   * (решение о схеме — за владельцем, процедура миграции 1.3). Ступень
   * запуска: по умолчанию кнопка, плюс per-repo оп-ин, после которого summary
   * пересчитывается автоматически при следующем скане этого репозитория.
   * Закон 1 остаётся: LLM пишет ТЕКСТ, каждая фраза привязана к `fact_ref`
   * и проходит валидатор; новых рекомендаций модель не порождает.
   */
  // В5.2 (Б3): оп-ин автообновления удален
  aiSummary: ["text", "factRefs", "charterVersion", "modelVersion", "generatedAt"],
  /**
   * К5.7. Публичная проекция по сканам: индекс и покрытие; полный Score —
   * только зрителю с правами, как на карточке. Источник — существующие строки
   * `scores`, новых сборов нет.
   */
  scoreHistory: ["points", "scanId", "finishedAt", "healthcraftIndex", "indexCoverage", "repoHealthScore", "modelVersion"],
  /**
   * К5.8. Версионированный публичный маршрут плюс SVG для README. В SVG не
   * попадает ничего, кроме числа, подписи и цвета; приватный и эвиктированный
   * репозиторий — 404, неотличимо от несуществующего.
   */
  badge: ["badgeUrl", "apiUrl", "healthcraftIndex", "modelVersion"],
  /**
   * К5.15 (SHOULD, решение владельца 20.09 — вопрос 25, вариант (а)).
   * В5.3 круг 4 (TASK.md §2 25.09): раздел появился вместе с работающим
   * сценарием — `/compare`, `GET /api/compare` (`src/api/compare.ts`,
   * `ComparePage.tsx`). «По публичной проекции» вытеснено решением А2:
   * сравнивается любой репозиторий, чью карточку зритель может открыть.
   * Имена — поля ответа (`CompareResponse`) и карточки в его элементах.
   */
  compare: ["slugs", "items", "healthcraftIndex", "indexCoverage", "categories", "rank", "computedAt"],
};

/**
 * Честные состояния слотов. Формулировки говорят, чего НЕТ и почему, и ничего
 * не обещают по датам: «появится в В5» — внутренний жаргон проекта, зрителю он
 * ничего не объясняет.
 */
// Ступень 4 (В-8, §2 23.09): тексты без жаргона («скан», «факты», «tri-state»,
// «версия модели») и без обещаний кнопок и настроек; вид карточек прежний.
export const SLOT_EMPTY: Record<keyof typeof SLOT_CONTRACTS, { title: string; text: string }> = {
  aiSummary: {
    title: AI_SECTION_TITLE,
    text:
      "Пока не сформировано. Это будет короткий пересказ оценки обычным языком: " +
      "числа по-прежнему считает сервис, описание их только объясняет и на оценку не влияет.",
  },
  scoreHistory: {
    title: "История оценки",
    text:
      "Пока показывать нечего: по текущей версии методики у репозитория еще нет оценок. " +
      "График будет пополняться после каждого анализа.",
  },
  badge: {
    title: "Бейдж для README",
    text: "Бейдж выдается только публичным репозиториям из рейтинга.",
  },
  // В5.3 круг 4: пустое состояние раздела «Сравнение» (продуктовый Т3)
  compare: {
    title: "Добавьте 2-3 репозитория",
    text:
      "Сервис поставит их оценки рядом и покажет, в каких категориях и за счет каких показателей каждый сильнее.",
  },
};

/**
 * К-2 В5.3: что показывает слот истории — по точкам и правам на историю, а не по
 * правам на AI-текст (история HealthCraft Index публична; прежняя подпись брала
 * `card.ai === undefined` и у зрителя без прав печатала «показывать нечего» под
 * нарисованным графиком). Правило AGENTS.md 23.09: пустое состояние — тестом на
 * данных. Точка графика — оценка с числом; одна точка линии не образует.
 */
export interface ScoreHistoryView {
  chart: boolean;
  /** подпись под графиком — сколько анализов на нем */
  count: string | null;
  /** что с Repo Health Score: пунктир (права есть) или кому он виден */
  full: string | null;
  text: string;
}

const HISTORY_ONE =
  "Пока есть 1 оценка по текущей версии методики – для графика нужны хотя бы 2. Новая точка появляется после каждого анализа.";
const HISTORY_FOOTER = "На графике – оценки по текущей версии методики; где данных не было, линия прерывается.";

export function scoreHistoryView(data: Pick<HistoryResponse, "points" | "fullOpen"> | null): ScoreHistoryView {
  const points = data?.points ?? [];
  const fullOpen = data?.fullOpen === true;
  const drawn = (key: "healthcraftIndex" | "repoHealthScore"): number => points.filter((p) => p[key] !== null).length;
  const best = Math.max(drawn("healthcraftIndex"), fullOpen ? drawn("repoHealthScore") : 0);
  if (best === 0) return { chart: false, count: null, full: null, text: SLOT_EMPTY.scoreHistory.text };
  if (best === 1) return { chart: false, count: null, full: null, text: HISTORY_ONE };
  // ревью В5.3 (25.09): число о размере выборки — анализы с числом индекса (точки графика)
  const n = drawn("healthcraftIndex");
  const word = n % 10 === 1 && n % 100 !== 11 ? "анализу" : "анализам";
  return {
    chart: true,
    count: `HealthCraft Index по ${n} ${word}`,
    full: fullOpen
      ? "пунктир – Repo Health Score: 6 категорий, включая CI/CD и Безопасность"
      : "Repo Health Score на графике виден участникам репозитория.",
    text: HISTORY_FOOTER,
  };
}

/**
 * В5.3 круг 3 (О12): точки истории — по времени анализа, а не по номеру скана
 * (номер растет с каждой заявкой, а завершаются они не по порядку: 19.09 стоял
 * перед 18.09). Точки без времени — в конец, в порядке номера.
 */
export function historyByTime(points: readonly HistoryPoint[]): HistoryPoint[] {
  const t = (p: HistoryPoint): number => (p.finishedAt === null ? Number.POSITIVE_INFINITY : Date.parse(p.finishedAt));
  return [...points].sort((a, b) => t(a) - t(b) || a.scanId - b.scanId);
}

/**
 * Вид блока «прежних описаний» в истории (О11, §2 24.09 выбор 4-A): описание
 * каждого анализа стоит в его строке; подпись над списком нужна только когда
 * описаний хотя бы 2, а между первым и последним меньше 2 дней. При 1 описании
 * сравнивать не с чем — подписи нет (прежний текст «истории меньше 2 дней»
 * называл не ту причину).
 */
export function aiNotesCaption(finishedAt: readonly (string | null)[], tooEarly: (dates: string[]) => boolean): string | null {
  const dates = finishedAt.filter((d): d is string => d !== null);
  if (dates.length < 2) return null;
  return tooEarly(dates) ? "Описания между анализами меньше 2 дней – о динамике судить рано." : null;
}

/** Код для README (О5): абсолютные адреса, картинка ведет на карточку. */
export function badgeMarkdown(publicBaseUrl: string, org: string, repo: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const path = `${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  return `[![HealthCraft Index](${base}/api/v1/repos/${path}/badge.svg)](${base}/repo/${path})`;
}
