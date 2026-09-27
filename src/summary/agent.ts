// Агентный цикл специалистов. Инструменты — только у специалистов (security — без
// инструментов: только данные AppSec); overview/trajectory/flagger зовутся без цикла,
// их вход уже собран. Бюджеты: вызовы инструментов, wall-clock фуз на ВСЮ генерацию,
// максимум 2 попытки на retryable-ошибки с бэкоффом. Агрегатный кап всей генерации
// (48 вызовов / 6 минут) держит конвейер (pipeline.ts).
import type { CallLlm, ChatMessage, ToolSpec } from "../llm";
import { LlmError } from "../llm";
import type { SummaryRole } from "./roles";

/** Вызовов инструментов на одну генерацию. */
export const TOOL_BUDGET = 12;
/** Попыток всей генерации: одна повторная — только на retryable. */
export const MAX_ATTEMPTS = 2;
/** Дефолтный wall-clock фуз одной генерации. */
export const DEFAULT_ROUND_BUDGET_MS = 6 * 60_000;
/** Бэкофф перед повторной попыткой (429/сеть), мс. */
export const RETRY_BACKOFF_MS = 1_000;
/** Потолок паузы по Retry-After провайдера, мс. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** 429/5xx и транспортные срывы — повторяем; остальное — форма/патология. */
export function retryable(e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  if (["network", "stall", "stream_closed", "empty", "no_body"].includes(e.code)) return true;
  if (/^\d{3}$/.test(e.code)) {
    const n = Number(e.code);
    return n === 429 || n >= 500;
  }
  return false;
}

const SALVAGE_SUFFIX =
  "\n\n(Бюджет инструментов исчерпан: больше вызовов не будет. Ответь финальным текстом по формату хартии на основе того, что уже известно. Инструменты и вопросы в ответе не упоминай.)";

/** Суффикс дописывается к ПОСЛЕДНЕМУ сообщению, а не новым: чередование ролей не ломается. */
function withSalvageSuffix(messages: ChatMessage[], suffix: string): ChatMessage[] {
  const patched = [...messages];
  const last = patched[patched.length - 1];
  if (last === undefined) return patched;
  if (last.role === "tool") {
    patched[patched.length - 1] = { role: "tool", toolCallId: last.toolCallId, content: `${last.content}\n${suffix}` };
  } else if (last.role === "assistant" || last.role === "user" || last.role === "system") {
    patched[patched.length - 1] = { role: last.role, content: `${last.content}\n${suffix}` };
  }
  return patched;
}

export interface AgentDeps {
  callLlm: CallLlm;
  role: SummaryRole;
  /** исполнение инструментов (дедуп/капы — внутри); null → генерация без инструментов */
  executor: { specs: ToolSpec[]; execute: (name: string, args: unknown) => Promise<string>; budgetLeft: () => number } | null;
  /** wall-clock фуз всей генерации (тесты ставят маленький) */
  roundBudgetMs?: number;
  /** бэкофф перед повтором (тесты ставят 0) */
  backoffMs?: number;
  log?: (message: string) => void;
}

export interface AgentResult {
  text: string;
  /** всего вызовов модели (включая ретраи и salvage-раунд) */
  modelCalls: number;
  /** вызовов инструментов исполнено (дедуп внутри — отдельная статистика) */
  toolCalls: number;
}

/**
 * Одна генерация роли: цикл tool_calls до исчерпания бюджета, salvage-раунд
 * без инструментов в конце, повтор только на retryable-ошибки. При успехе текст
 * всегда непустой; форму ответа проверяет валидатор уже после.
 */
export async function generateWithTools(deps: AgentDeps, messages: ChatMessage[]): Promise<AgentResult> {
  const budgetMs = deps.roundBudgetMs ?? DEFAULT_ROUND_BUDGET_MS;
  const backoffMs = deps.backoffMs ?? RETRY_BACKOFF_MS;
  const useTools = deps.executor !== null;
  let modelCalls = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // фуз на всю генерацию: обрыв сигналом рвет и текущий запрос
    const ac = new AbortController();
    const fuse = setTimeout(() => ac.abort(), budgetMs);
    try {
      let toolCalls = 0;
      let loop: ChatMessage[] = messages;
      // один путь кода для инструментов: без не-стримингового фолбэка и без
      // разбора маркеров из текста
      for (let iter = 0; ; iter++) {
        const salvage = useTools && iter >= TOOL_BUDGET - 1;
        modelCalls++; // в бюджет идет каждая попытка, включая неудачные
        const res = await deps.callLlm({
          messages: salvage ? withSalvageSuffix(loop, SALVAGE_SUFFIX) : loop,
          tools: useTools && !salvage ? deps.executor!.specs : undefined,
          role: deps.role,
          signal: ac.signal,
        });
        if (res.toolCalls.length === 0 || !useTools || salvage) {
          if (salvage && res.text.length === 0) {
            throw new LlmError("tool_budget", "salvage-вызов вернулся без текста — генерация не собрана");
          }
          if (res.text.length === 0) {
            throw new LlmError("empty", "модель ответила вызовами без текста при пустом наборе инструментов");
          }
          return { text: res.text, modelCalls, toolCalls };
        }
        const answers: ChatMessage[] = [ { role: "assistant", content: res.text, toolCalls: res.toolCalls } ];
        for (const tc of res.toolCalls) {
          let args: unknown = null;
          try {
            args = tc.arguments.length > 0 ? JSON.parse(tc.arguments) : null;
          } catch {
            args = { __raw: tc.arguments };
          }
          const content = await deps.executor!.execute(tc.name, args);
          answers.push({ role: "tool", toolCallId: tc.id, content });
          toolCalls++;
        }
        loop = [...loop, ...answers];
      }
    } catch (e) {
      const lastAttempt = attempt >= MAX_ATTEMPTS;
      if (!retryable(e) || lastAttempt) throw e;
      deps.log?.(`[${deps.role}] retryable error, attempt ${attempt}/${MAX_ATTEMPTS}: ${String((e as Error).message).slice(0, 120)}`);
      // Retry-After провайдера уважается, но не дольше RETRY_AFTER_CAP_MS:
      // ожидание не должно съесть фуз генерации
      const asked = e instanceof LlmError ? e.retryAfterMs : null;
      await new Promise((r) => setTimeout(r, asked === null ? backoffMs : Math.max(backoffMs, Math.min(asked, RETRY_AFTER_CAP_MS))));
    } finally {
      clearTimeout(fuse);
    }
  }
  // недостижимо (последняя попытка бросает), но TS требует возврат
  throw new LlmError("internal", "unreachable: generation loop fell through");
}
