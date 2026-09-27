// analysis.ts — состояние анализа на клиенте, ЧИСТЫЙ модуль без React (его
// проверяют тесты). Итог анализа узнаётся по ЗАДАНИЮ, а не по «появился ли скан
// с номером больше»: у сервера есть точный ответ `/api/me/jobs` (фаза, исход
// скана, изменилась ли публичная оценка).
//
// Правила:
//  - один опрос `/api/me/jobs` на вкладку (провайдер в App), все экраны —
//    строка «Моих репозиториев», карточка, «Задания» — читают один ответ;
//  - событие «анализ закончился» — ровно одно на задание, на любом экране,
//    в том числе после ухода со страницы запуска;
//  - базовая линия «уже видел» — первый УДАЧНЫЙ ответ: после F5 старые итоги
//    тостами не всплывают; итог задания, запущенного из этой вкладки, всплывает
//    и в нем (первый опрос мог не удаться);
//  - 401 останавливает опрос до подтверждения сессии через /api/me;
//  - прерванный перезапуском сервера анализ — не итог: задание вернулось в
//    очередь и повторится;
//  - «идёт анализ» — без обещания времени.
import type { MyJob } from "../api/me";

export interface JobsResponse {
  /** чей это ответ — расхождение с показанной личностью перечитывает /api/me */
  login?: string | null;
  active: MyJob[];
  recent: MyJob[];
}

export interface AnalysisTracker {
  /** первый ответ принят (базовая линия) */
  baseline: boolean;
  /** итоги каких заданий уже показаны (или были до базовой линии) */
  announced: ReadonlySet<number>;
  /**
   * Задания, запущенные из этой вкладки. Их итог объявляется и
   * в ответе, ставшем базовой линией: первый опрос мог не удаться, а анализ —
   * успеть закончиться до первого удачного ответа. Прочие итоги базовой
   * линии — прошлое, без тостов.
   */
  expected: ReadonlySet<number>;
  /** опрос остановлен ответом 401 — ждет подтверждения сессии через /api/me */
  halted: boolean;
}

export function newTracker(): AnalysisTracker {
  return { baseline: false, announced: new Set(), expected: new Set(), halted: false };
}

/** Задание запущено из этой вкладки: его итог будет объявлен и в ответе базовой линии. */
export function expectJob(t: AnalysisTracker, jobId: number): AnalysisTracker {
  if (t.announced.has(jobId) || t.expected.has(jobId)) return t;
  return { ...t, expected: new Set([...t.expected, jobId]) };
}

/** Ответ 401 на опрос заданий: опрос стоит до подтверждения сессии. */
export function haltOnLost(t: AnalysisTracker): AnalysisTracker {
  return { ...t, halted: true };
}

/**
 * `/api/me` подтвердил сессию: опрос, остановленный ответом 401, перезапускается
 * (ровно один раз). Та же личность — эффект опроса сам не перезапустился бы:
 * его зависимости не изменились.
 */
export function resumeOnSession(t: AnalysisTracker): { tracker: AnalysisTracker; resume: boolean } {
  return t.halted ? { tracker: { ...t, halted: false }, resume: true } : { tracker: t, resume: false };
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
  const expected = new Set(prev.expected);
  const finished: MyJob[] = [];
  for (const job of res.recent) {
    if (!FINISHED.has(job.phase) || announced.has(job.jobId)) continue;
    announced.add(job.jobId);
    if (prev.baseline || expected.has(job.jobId)) finished.push(job);
    expected.delete(job.jobId);
  }
  return { tracker: { ...prev, baseline: true, announced, expected }, finished };
}

/** Анализ репозитория, который идёт сейчас (у зрителя есть живое задание). */
export interface LiveAnalysis {
  jobId: number;
  phase: "queued" | "running";
  /** «затянулось» — признак сервера (аренда задания истекла) */
  stalled: boolean;
}

/** Живое задание зрителя по слагу, если есть. */
export function liveFor(res: JobsResponse | null, slug: string): LiveAnalysis | null {
  // «идет анализ» — только скан; AI-заявки (обзор, проверка) анализом не являются
  // и кнопку анализа не блокируют
  const job = res?.active.find((j) => j.slug === slug && (j.kind === undefined || j.kind === "scan"));
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
  // описание (LLM) и проверка на накрутку оценку не меняют — тост не должен
  // обещать «оценка обновлена», результат только в карточке
  if (job.kind === "check") {
    return job.phase === "failed"
      ? { theme: "danger", title: "Проверка не сформировалась", content: `${job.slug}: ${job.error ?? "причина – в «Заданиях»"}` }
      : { theme: "success", title: "Проверка готова", content: `${job.slug}: результат – в карточке репозитория` };
  }
  if (job.kind === "summary") {
    return job.phase === "failed"
      ? { theme: "danger", title: "Описание не сформировалось", content: `${job.slug}: ${job.error ?? "причина – в «Заданиях»"}` }
      : { theme: "success", title: "Описание готово", content: `${job.slug}: текст появился в карточке репозитория` };
  }
  if (job.phase === "failed") {
    return { theme: "danger", title: "Анализ завершился ошибкой", content: `${job.slug}: ${job.error ?? "причина – в «Заданиях»"}` };
  }
  // скан собрал не всё (например, клон уперся в лимит) и публичная оценка не
  // изменилась — не зеленый «готово» без оговорок
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
 * Ответ пришёл от имени другого пользователя (в соседней
 * вкладке вышли или вошли другим аккаунтом) — показанная личность устарела.
 */
export function identityChanged(shownLogin: string | null, res: JobsResponse): boolean {
  return res.login !== undefined && res.login !== null && shownLogin !== null && res.login !== shownLogin;
}
