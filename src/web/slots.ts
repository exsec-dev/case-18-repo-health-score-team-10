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
      "числа по-прежнему считает сервис, AI-обзор их только объясняет и на оценку не влияет.",
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
  "Пока есть одна оценка по текущей версии методики – график появится со вторым анализом. Новая оценка появляется после каждого анализа.";
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
 * Шкала графика по данным, а не 0–100: на 0–100 падение 95 → 87 занимало 10px, и
 * линия выглядела прямой. Края — с запасом 5 баллов, округлены до 10; размах не
 * меньше 20 баллов. Пороги зон 40 и 70 рисуются, только если попадают внутрь.
 */
export function historyDomain(values: readonly number[]): { lo: number; hi: number; ticks: number[]; thresholds: number[] } {
  if (values.length === 0) return { lo: 0, hi: 100, ticks: [0, 50, 100], thresholds: [40, 70] };
  let lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10);
  let hi = Math.min(100, Math.ceil((Math.max(...values) + 5) / 10) * 10);
  while (hi - lo < 20) {
    if (lo > 0) lo -= 10;
    else hi += 10;
  }
  const step = hi - lo > 40 ? 20 : 10;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== hi) ticks.push(hi);
  return { lo, hi, ticks, thresholds: [40, 70].filter((g) => g > lo && g < hi) };
}

/**
 * Подпись под графиком, когда порогов на шкале нет: все точки в одной зоне — это
 * сказано словами, иначе цвет линии без порогов ничего не объяснял бы.
 */
export function historyZoneNote(values: readonly number[], thresholds: readonly number[]): string | null {
  if (values.length === 0 || thresholds.length > 0) return null;
  const r = values.map((v) => Math.round(v));
  if (r.every((v) => v >= 70)) return "Весь график в зоне «Здоров» (от 70).";
  if (r.every((v) => v < 40)) return "Весь график в зоне риска (ниже 40).";
  if (r.every((v) => v >= 40 && v < 70)) return "Весь график в зоне «Требует внимания» (40-69).";
  return null;
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
  return tooEarly(dates) ? "Между AI-обзорами меньше 2 дней – о динамике судить рано." : null;
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
