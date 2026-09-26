// session.tsx — В4.8.5: общее состояние приложения на вкладку.
//  - Сессия (К8.5.8): одно состояние `/api/me` на всё приложение. 401 любого
//    `/api/me/*` (событие SESSION_LOST из api.ts), возврат во вкладку
//    (`visibilitychange`) и расхождение `login` в ответе `/api/me/jobs` с
//    показанной личностью (смена аккаунта в соседней вкладке, С9-1)
//    перечитывают `/api/me` — rail, «Задания» и страницы переходят в «вы
//    вышли» или к новой личности вместе. Анонимная вкладка смену аккаунта в
//    соседней узнаёт только на возврате во вкладку (граница — отчёт вехи).
//  - Анализ (К8.5.1): ОДИН опрос `/api/me/jobs` на вкладку (пауза в скрытой
//    вкладке), итог — по заданию; тост об итоге — один, из любого экрана,
//    в том числе после ухода со страницы запуска. Страницы узнают об итоге
//    событием и перечитывают только своё (строку, карточку).
import { useToaster } from "@gravity-ui/uikit";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { MyJob } from "../api/me";
import { navigate, repoHref } from "./router";
import { SESSION_LOST, useJson, useLatest, useVisible, type AsyncState, type MeResponse } from "./api";
import {
  expectJob,
  finishedToast,
  haltOnLost,
  identityChanged,
  liveFor,
  newTracker,
  pollDelay,
  resumeOnSession,
  trackJobs,
  type JobsResponse,
  type LiveAnalysis,
} from "./analysis";

/** Событие «задания изменились» (запуск анализа, добавление в избранное): опрос сразу, а не по таймеру. */
export const JOBS_CHANGED = "rh-jobs-changed";

export function announceJobsChanged(): void {
  window.dispatchEvent(new Event(JOBS_CHANGED));
}

/** Круг 2 (Н5): событие «вкладка запустила задание» — detail: jobId; его итог объявится и в ответе базовой линии. */
export const JOB_STARTED = "rh-job-started";

export function announceJobStarted(jobId: number | undefined): void {
  if (typeof jobId === "number") window.dispatchEvent(new CustomEvent(JOB_STARTED, { detail: jobId }));
}

/** Событие «анализ закончился»: detail — закончившиеся задания (MyJob[]); страницы перечитывают только своё. */
export const ANALYSIS_FINISHED = "rh-analysis-finished";

interface SessionValue {
  me: AsyncState<MeResponse>;
  reloadMe: () => void;
}

const SessionContext = createContext<SessionValue>({ me: { kind: "loading" }, reloadMe: () => {} });

interface AnalysisValue {
  jobs: JobsResponse | null;
  refresh: () => void;
  live: (slug: string) => LiveAnalysis | null;
  /** С9-13: последний опрос заданий не удался (сеть, 5xx) — показанное могло устареть */
  failing: boolean;
}

const AnalysisContext = createContext<AnalysisValue>({ jobs: null, refresh: () => {}, live: () => null, failing: false });

/** Текущая сессия: одно состояние `/api/me` на всё приложение. */
export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/** Задания зрителя: один опрос на вкладку. */
export function useAnalysis(): AnalysisValue {
  return useContext(AnalysisContext);
}

/** Задания, чей анализ закончился (событие ANALYSIS_FINISHED), — колбэк страницы. */
export function useAnalysisFinished(onFinished: (jobs: MyJob[]) => void): void {
  const cb = useLatest(onFinished);
  useEffect(() => {
    const handler = (e: Event) => cb.current((e as CustomEvent<MyJob[]>).detail);
    window.addEventListener(ANALYSIS_FINISHED, handler);
    return () => window.removeEventListener(ANALYSIS_FINISHED, handler);
  }, [cb]);
}

export function AppState({ children }: { children: ReactNode }) {
  const me = useJson<MeResponse>("/api/me", { keepPrevious: true });
  const visible = useVisible();
  const reloadMe = me.reload;

  // К8.5.8: 401 на /api/me/* и возврат во вкладку — перечитать сессию
  useEffect(() => {
    window.addEventListener(SESSION_LOST, reloadMe);
    return () => window.removeEventListener(SESSION_LOST, reloadMe);
  }, [reloadMe]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) reloadMe();
    wasVisible.current = visible;
  }, [visible, reloadMe]);

  // Круг 2 (Н5): каждый удачный ответ /api/me — подтверждение сессии; опрос
  // заданий, остановленный 401, по нему перезапускается
  const [sessionEpoch, setSessionEpoch] = useState(0);
  useEffect(() => {
    if (me.state.kind === "ok") setSessionEpoch((n) => n + 1);
  }, [me.state]);

  const login = me.state.kind === "ok" ? me.state.data.login : me.state.kind === "loading" ? (me.state.stale?.login ?? null) : null;
  return (
    <SessionContext.Provider value={{ me: me.state, reloadMe }}>
      <AnalysisState login={login} visible={visible} sessionEpoch={sessionEpoch} onIdentityChanged={reloadMe}>
        {children}
      </AnalysisState>
    </SessionContext.Provider>
  );
}

function AnalysisState({
  login,
  visible,
  sessionEpoch,
  onIdentityChanged,
  children,
}: {
  login: string | null;
  visible: boolean;
  sessionEpoch: number;
  onIdentityChanged: () => void;
  children: ReactNode;
}) {
  const toaster = useToaster();
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [failing, setFailing] = useState(false);
  const tracker = useRef(newTracker());
  const identity = useLatest({ login, onIdentityChanged });
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    window.addEventListener(JOBS_CHANGED, refresh);
    return () => window.removeEventListener(JOBS_CHANGED, refresh);
  }, [refresh]);

  // Круг 2 (Н5): задание, запущенное из этой вкладки, — его итог объявится и
  // тогда, когда первый удачный ответ опроса станет базовой линией
  useEffect(() => {
    const onStarted = (e: Event) => {
      const jobId = (e as CustomEvent<unknown>).detail;
      if (typeof jobId === "number") tracker.current = expectJob(tracker.current, jobId);
    };
    window.addEventListener(JOB_STARTED, onStarted);
    return () => window.removeEventListener(JOB_STARTED, onStarted);
  }, []);

  // Круг 2 (Н5): опрос, остановленный 401, перезапускается, когда /api/me
  // подтвердил сессию (та же личность — эффект опроса сам не перезапустился бы)
  useEffect(() => {
    const r = resumeOnSession(tracker.current);
    tracker.current = r.tracker;
    if (r.resume) refresh();
  }, [sessionEpoch, refresh]);

  // смена личности — базовая линия заново (итоги чужого аккаунта не всплывают)
  useEffect(() => {
    tracker.current = newTracker();
    setJobs(null);
    setFailing(false);
  }, [login]);

  useEffect(() => {
    // аноним не опрашивает вовсе (401-зонд мусорил бы консоль — планка харнесса);
    // скрытая вкладка — пауза, возврат во вкладку — опрос сразу
    if (login === null || !visible) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next: JobsResponse | null = null;
      try {
        const res = await fetch("/api/me/jobs");
        if (res.status === 401) {
          // сессии нет — App перечитает /api/me и уберёт опрос; подтвердит
          // сессию — опрос перезапустится (круг 2, Н5)
          tracker.current = haltOnLost(tracker.current);
          identity.current.onIdentityChanged();
          return;
        }
        if (res.ok) next = (await res.json()) as JobsResponse;
      } catch {
        /* сеть — следующий тик */
      }
      if (stop) return;
      // С9-13: сбой опроса не молчит — «Задания» помечают, что список мог устареть
      setFailing(next === null);
      if (next !== null) {
        if (identityChanged(identity.current.login, next)) {
          identity.current.onIdentityChanged();
          return;
        }
        const out = trackJobs(tracker.current, next);
        tracker.current = out.tracker;
        setJobs(next);
        for (const job of out.finished) {
          const t = finishedToast(job);
          // круг 5 тура 3 (находка 27 аудита): из тоста итога — сразу к карточке (кроме
          // случая, когда зритель уже на ней)
          const [org, repo] = job.slug.split("/");
          const href = org && repo ? repoHref(org, repo) : null;
          const here = href !== null && window.location.pathname === href;
          toaster.add({
            name: `analysis-finished:${job.jobId}`,
            theme: t.theme,
            title: t.title,
            content: t.content,
            actions: href !== null && !here ? [{ label: "Открыть карточку", onClick: () => navigate(href), removeAfterClick: true }] : undefined,
          });
        }
        if (out.finished.length > 0) window.dispatchEvent(new CustomEvent(ANALYSIS_FINISHED, { detail: out.finished }));
      }
      timer = setTimeout(() => void poll(), pollDelay(next));
    };
    void poll();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [login, visible, tick, toaster, identity]);

  const live = useCallback((slug: string) => liveFor(jobs, slug), [jobs]);
  return <AnalysisContext.Provider value={{ jobs, refresh, live, failing }}>{children}</AnalysisContext.Provider>;
}
