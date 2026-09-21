// analysis.ts — В4.8.5 (К8.5.1): состояние анализа на клиенте — ЧИСТЫЙ модуль
// без React (его проверяют тесты). Итог анализа узнаётся по ЗАДАНИЮ, а не по
// «появился ли скан с номером больше»: у сервера есть точный ответ
// `/api/me/jobs` (фаза, исход скана, изменилась ли публичная оценка).
//
// Правила:
//  - один опрос `/api/me/jobs` на вкладку (провайдер в App), все экраны —
//    строка «Моих репозиториев», карточка, «Задания» — читают один ответ;
//  - событие «анализ закончился» — ровно одно на задание, из любого экрана,
//    в том числе после ухода со страницы запуска;
//  - базовая линия «уже видел» — первый ответ: после F5 старые итоги тостами
//    не всплывают;
//  - прерванный перезапуском сервера анализ — не итог: задание вернулось в
//    очередь и повторится (К8.5.2a);
//  - «идёт анализ» — без обещания времени (§2-В5).
import type { MyJob } from "../api/me";

export interface JobsResponse {
  /** К8.5.8: чей это ответ — расхождение с показанной личностью перечитывает /api/me */
  login?: string | null;
  active: MyJob[];
  recent: MyJob[];
}

export interface AnalysisTracker {
  /** первый ответ принят (базовая линия) */
  baseline: boolean;
  /** итоги каких заданий уже показаны (или были до базовой линии) */
  announced: ReadonlySet<number>;
}

export function newTracker(): AnalysisTracker {
  return { baseline: false, announced: new Set() };
}

const FINISHED: ReadonlySet<MyJob["phase"]> = new Set(["done", "failed"]);

/**
 * Принять ответ `/api/me/jobs`: новые итоги (задания `done`/`failed`, которых
 * ещё не объявляли) — ровно по одному разу. Отказанные предпроверкой
 * (`refused`) итогом анализа не считаются: человек увидел отказ сразу, в
 * ответе на запуск.
 */
export function trackJobs(prev: AnalysisTracker, res: JobsResponse): { tracker: AnalysisTracker; finished: MyJob[] } {
  const announced = new Set(prev.announced);
  const finished: MyJob[] = [];
  for (const job of res.recent) {
    if (!FINISHED.has(job.phase) || announced.has(job.jobId)) continue;
    announced.add(job.jobId);
    if (prev.baseline) finished.push(job);
  }
  return { tracker: { baseline: true, announced }, finished };
}

/** Анализ репозитория, который идёт сейчас (у зрителя есть живое задание). */
export interface LiveAnalysis {
  jobId: number;
  phase: "queued" | "running";
  /** «затянулось» — признак сервера (лиз задания истёк), К8.5.2b */
  stalled: boolean;
}

/** Живое задание зрителя по слагу, если есть. */
export function liveFor(res: JobsResponse | null, slug: string): LiveAnalysis | null {
  const job = res?.active.find((j) => j.slug === slug);
  if (!job) return null;
  return { jobId: job.jobId, phase: job.phase === "running" ? "running" : "queued", stalled: job.stalled === true };
}

/** Тост об итоге анализа: одна формулировка на все экраны. */
export interface FinishedToast {
  theme: "success" | "info" | "danger";
  title: string;
  content: string;
}

export function finishedToast(job: MyJob): FinishedToast {
  if (job.phase === "failed") {
    return { theme: "danger", title: "Анализ завершился ошибкой", content: `${job.slug}: ${job.error ?? "причина – в «Заданиях»"}` };
  }
  // С4-10: скан собрал не всё (например, клон уперся в лимит) и публичная
  // оценка не изменилась — не зеленый «готово» без оговорок
  if (job.scoreChanged === false) {
    const partial = job.outcome === "partial" ? ", данные собраны не полностью" : "";
    return { theme: "info", title: "Анализ завершен", content: `${job.slug}: публичная оценка не изменилась${partial}` };
  }
  return { theme: "success", title: "Анализ завершен", content: `${job.slug}: оценка обновлена` };
}

/** Слаги, чьи данные нужно перечитать после итогов (строка списка, карточка). */
export function finishedSlugs(finished: MyJob[]): Set<string> {
  return new Set(finished.map((j) => j.slug));
}

/** Интервал опроса: чаще, пока идёт анализ; реже в покое. */
export const POLL_ACTIVE_MS = 3_000;
export const POLL_IDLE_MS = 15_000;

export function pollDelay(res: JobsResponse | null): number {
  return res !== null && res.active.length > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/**
 * К8.5.8 (С9-1): ответ пришёл от имени другого пользователя (в соседней
 * вкладке вышли или вошли другим аккаунтом) — показанная личность устарела.
 */
export function identityChanged(shownLogin: string | null, res: JobsResponse): boolean {
  return res.login !== undefined && res.login !== null && shownLogin !== null && res.login !== shownLogin;
}
