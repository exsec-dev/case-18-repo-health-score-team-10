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
import { SESSION_LOST, useJson, useLatest, useVisible, type AsyncState, type MeResponse } from "./api";
import { finishedToast, identityChanged, liveFor, newTracker, pollDelay, trackJobs, type JobsResponse, type LiveAnalysis } from "./analysis";

/** Событие «задания изменились» (запуск анализа, добавление в избранное): опрос сразу, а не по таймеру. */
export const JOBS_CHANGED = "rh-jobs-changed";

export function announceJobsChanged(): void {
  window.dispatchEvent(new Event(JOBS_CHANGED));
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
}

const AnalysisContext = createContext<AnalysisValue>({ jobs: null, refresh: () => {}, live: () => null });

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

  const login = me.state.kind === "ok" ? me.state.data.login : me.state.kind === "loading" ? (me.state.stale?.login ?? null) : null;
  return (
    <SessionContext.Provider value={{ me: me.state, reloadMe }}>
      <AnalysisState login={login} visible={visible} onIdentityChanged={reloadMe}>
        {children}
      </AnalysisState>
    </SessionContext.Provider>
  );
}

function AnalysisState({ login, visible, onIdentityChanged, children }: { login: string | null; visible: boolean; onIdentityChanged: () => void; children: ReactNode }) {
  const toaster = useToaster();
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [tick, setTick] = useState(0);
  const tracker = useRef(newTracker());
  const identity = useLatest({ login, onIdentityChanged });
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    window.addEventListener(JOBS_CHANGED, refresh);
    return () => window.removeEventListener(JOBS_CHANGED, refresh);
  }, [refresh]);

  // смена личности — базовая линия заново (итоги чужого аккаунта не всплывают)
  useEffect(() => {
    tracker.current = newTracker();
    setJobs(null);
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
          // сессии нет — App перечитает /api/me и уберёт опрос
          identity.current.onIdentityChanged();
          return;
        }
        if (res.ok) next = (await res.json()) as JobsResponse;
      } catch {
        /* сеть — следующий тик */
      }
      if (stop) return;
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
          toaster.add({ name: `analysis-finished:${job.jobId}`, theme: t.theme, title: t.title, content: t.content });
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
  return <AnalysisContext.Provider value={{ jobs, refresh, live }}>{children}</AnalysisContext.Provider>;
}
