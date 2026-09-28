// slots.ts — места под AI-описание, график истории оценки, бейдж и сравнение:
// контракты их полей, честные пустые состояния и чистые функции вида.
//
// Слот — ВИДИМОЕ место с честным состоянием «пока нет данных»: без выдуманных
// чисел и без мертвых кнопок: заявленная возможность должна подтверждаться
// работающим интерфейсом. Действие появляется только вместе с работающим сценарием.

import type { HistoryPoint, HistoryResponse } from "../summary/history-contract";
import { AI_SECTION_TITLE } from "./format";

/**
 * Контракты полей слотов. Ключ — слот, значение — имена полей, которые отдает
 * сервер (для `compare` — поля ответа сравнения). Проверяются тестом:
 * расхождение имён — сигнал пересогласовать слот, а не тихо переименовать.
 */
export const SLOT_CONTRACTS: Record<"aiSummary" | "scoreHistory" | "badge" | "compare", readonly string[]> = {
  /**
   * AI-описание: текст + набор `fact_ref` + версия хартии + версия модели.
   * Запуск — кнопкой; автоматически — только топ рейтинга за переключателем
   * AI_TOP_AUTO. LLM пишет только ТЕКСТ: каждая фраза привязана к `fact_ref`
   * и проходит валидатор, новых рекомендаций модель не порождает.
   */
  aiSummary: ["text", "factRefs", "charterVersion", "modelVersion", "generatedAt"],
  /**
   * История оценки. Публичная проекция по сканам: индекс и покрытие; полный Score —
   * только зрителю с правами, как на карточке. Источник — существующие строки
   * `scores`, новых сборов нет.
   */
  scoreHistory: ["points", "scanId", "finishedAt", "healthcraftIndex", "indexCoverage", "repoHealthScore", "modelVersion"],
  /**
   * Бейдж: версионированный публичный маршрут плюс SVG для README. В SVG не
   * попадает ничего, кроме числа, подписи и цвета; приватный и эвиктированный
   * репозиторий — 404, неотличимо от несуществующего.
   */
  badge: ["badgeUrl", "apiUrl", "healthcraftIndex", "modelVersion"],
  /**
   * Сравнение: `/compare`, `GET /api/compare` (`src/api/compare.ts`).
   * Сравнивается любой репозиторий, чью карточку зритель может открыть.
   * Имена — поля ответа (`CompareResponse`) и карточки в его элементах.
   */
  compare: ["slugs", "items", "healthcraftIndex", "indexCoverage", "categories", "rank", "computedAt"],
};

/**
 * Честные состояния слотов. Формулировки говорят, чего НЕТ и почему, ничего
 * не обещают по датам и обходятся без жаргона («скан», «факты», «tri-state»,
 * «версия модели»).
 */
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
  compare: {
    title: "Добавьте 2-3 репозитория",
    text:
      "Сервис поставит их оценки рядом и покажет, в каких категориях и за счет каких показателей каждый сильнее.",
  },
};

/**
 * Что показывает слот истории — по точкам и правам на историю, а не по правам
 * на AI-текст: история HealthCraft Index публична. Точка графика — оценка с
 * числом; одна точка линии не образует.
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
  // в подписи — анализы с числом индекса, то есть точки графика
  const n = drawn("healthcraftIndex");
  const word = n % 10 === 1 && n % 100 !== 11 ? "анализу" : "анализам";
  return {
    chart: true,
    count: `HealthCraft Index по ${n} ${word}`,
    full: fullOpen
      ? "пунктир – Repo Health Score: 6 категорий, включая CI/CD и Безопасность"
      : "Repo Health Score на графике виден, если вашему токену доступны и CI/CD, и Безопасность.",
    text: HISTORY_FOOTER,
  };
}

/**
 * Точки истории — по времени анализа, а не по номеру скана: номер растет с
 * каждой заявкой, а завершаются они не по порядку. Точки без времени — в конец,
 * в порядке номера.
 */
export function historyByTime(points: readonly HistoryPoint[]): HistoryPoint[] {
  const t = (p: HistoryPoint): number => (p.finishedAt === null ? Number.POSITIVE_INFINITY : Date.parse(p.finishedAt));
  return [...points].sort((a, b) => t(a) - t(b) || a.scanId - b.scanId);
}

/**
 * Подпись над «прежними описаниями» в истории: нужна только когда описаний
 * хотя бы 2, а между первым и последним меньше 2 дней. При 1 описании
 * сравнивать не с чем — подписи нет.
 */
export function aiNotesCaption(finishedAt: readonly (string | null)[], tooEarly: (dates: string[]) => boolean): string | null {
  const dates = finishedAt.filter((d): d is string => d !== null);
  if (dates.length < 2) return null;
  return tooEarly(dates) ? "Описания между анализами меньше 2 дней – о динамике судить рано." : null;
}

/**
 * Код для README: абсолютные адреса, картинка ведет на карточку. `rank` — вариант
 * «Индекс и место» (`badge.svg?style=rank`, сегмент лиги цветом металла).
 */
export function badgeMarkdown(publicBaseUrl: string, org: string, repo: string, style: "index" | "rank" = "index"): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const path = `${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const query = style === "rank" ? "?style=rank" : "";
  return `[![HealthCraft Index](${base}/api/v1/repos/${path}/badge.svg${query})](${base}/repo/${path})`;
}
