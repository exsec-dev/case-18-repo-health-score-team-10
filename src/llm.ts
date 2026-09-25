// llm.ts — CallLlm-шов: провайдер выбирается конфигом, пер-role
// переопределение — аргументом (ключ шва = хартия-роль В5, 9 значений, плюс
// ярусы main/side для старых вызовов). Wall-clock фуз и честные ошибки;
// fail-soft остаётся за вызывающим.
//
// В5 (Б1): агентный клиент с tool_calls портирован из dndy-llama (стрим,
// накопление фрагментов по index, stall-гард 120 с, LlmError с кодами,
// инъекция fetch для тестов); LLM_BASE_URL — конфиг, не хардкод
// (локальный дев-цикл Ollama/LM Studio/vLLM, К5.19); семафор 3 на параллельные
// запросы к провайдеру; 429/5xx/сеть — retryable на уровне цикла (спека §3.3).
// YandexGPT — прежний нек-стриминговый путь (tools на нём не поддержаны —
// честная ошибка), температуры пер-ролевые применяются к обоим провайдерам.
import type { Config } from "./config";
import type { SummaryRole } from "./summary/roles";
import { modelTierOf, ROLE_TEMPERATURE } from "./summary/roles";

export interface ToolCallOut {
  id: string;
  name: string;
  /** аргументы — сырой JSON-строкой: парсит исполнитель, не транспорт */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallOut[] }
  | { role: "tool"; toolCallId: string; content: string };

/** OpenAI function-tool declaration. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResult {
  text: string;
  /** непуст, если модель закончила вызовами инструментов (или выдала их с finish stop) */
  toolCalls: ToolCallOut[];
  finish: string | null;
  usage: { in: number; out: number } | null;
}

/** Ключ роли вызова: ярусы (legacy) или хартия-роль В5. */
export type LlmRoleKey = "main" | "side" | SummaryRole;

export class LlmError extends Error {
  readonly code: string;
  readonly raw: string | null;
  /** В5.2 (Б7): пауза, которую просит провайдер (Retry-After у 429/503), мс; null — не прислал */
  readonly retryAfterMs: number | null;

  constructor(code: string, message: string, raw: string | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.raw = raw;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After: секунды или HTTP-дата → мс; мусор и прошлое — null. */
export function retryAfterMsOf(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const sec = Number(header.trim());
  if (Number.isFinite(sec)) return sec >= 0 ? Math.round(sec * 1000) : null;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? at - now : null;
}

export type CallLlm = (opts: {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  role?: LlmRoleKey;
  timeoutMs?: number;
  /** обрыв снаружи (wall-clock фуз цикла): рвёт запрос вместе с раундом */
  signal?: AbortSignal;
}) => Promise<LlmResult>;

/** Температура вызова: хартия-роль → пер-ролевая, ярусы → 0.4 (прежнее поведение). */
export function temperatureOf(role: LlmRoleKey): number {
  return role === "main" || role === "side" ? 0.4 : ROLE_TEMPERATURE[role];
}

function requireKey(config: Config): string {
  const { provider, yandexApiKey, zaiApiKey } = config.llm;
  const key = provider === "yandex" ? yandexApiKey : zaiApiKey;
  if (!key) {
    throw new Error(
      provider === "yandex"
        ? "YAGPT_API_KEY не задан в .env (YandexGPT недоступен)"
        : "ZAI_API_KEY не задан в .env (z.ai недоступен)",
    );
  }
  return key;
}

// ---------- семафор параллелизма провайдера (спека §3.3: не больше 3) ----------

/**
 * Приоритет вызова модели (В5.2, аудит очереди О1, 25.09). Семафор — один на процесс, а циклы
 * заявок с В5.2 разведены: без приоритета проверка пользователя стояла в общей FIFO-очереди за
 * вызовами чужих обзоров и обзоров топа, и ожидание съедало ее предохранитель (ложное
 * «AI-провайдер недоступен»). Порядок: `check` (проверка оценки пользователя, секунды) →
 * `interactive` (обзор пользователя) → `background` (полоса рейтинга: топ-10). Внутри
 * приоритета — порядок прихода. Фоновым вызовам достается не больше `BACKGROUND_MAX` мест.
 */
export type LlmPriority = "check" | "interactive" | "background";
const PRIORITY_RANK: Record<LlmPriority, number> = { check: 0, interactive: 1, background: 2 };

interface GateWaiter {
  rank: number;
  seq: number;
  background: boolean;
  grant: () => void;
}

export class ProviderGate {
  private busy = 0;
  private busyBackground = 0;
  private seq = 0;
  private readonly waiters: GateWaiter[] = [];

  constructor(
    private readonly capacity: number,
    private readonly backgroundMax: number,
  ) {}

  /** Занятые места (для тестов и логов). */
  get inFlight(): number {
    return this.busy;
  }

  async run<T>(fn: () => Promise<T>, priority: LlmPriority = "interactive", signal?: AbortSignal): Promise<T> {
    const background = priority === "background";
    await this.acquire(PRIORITY_RANK[priority], background, signal);
    try {
      return await fn();
    } finally {
      this.busy--;
      if (background) this.busyBackground--;
      this.pump();
    }
  }

  private acquire(rank: number, background: boolean, signal?: AbortSignal): Promise<void> {
    // аудит О1: ожидание места слушает отмену — предохранитель снимает ожидающего, а не
    // оставляет его занять место после того, как задание уже закрыто
    if (signal?.aborted) return Promise.reject(new LlmError("aborted", "вызов отменён (бюджет генерации)"));
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = { rank, seq: this.seq++, background, grant: resolve };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i < 0) return; // место уже выдано — отмену обработает сам вызов
        this.waiters.splice(i, 1);
        reject(new LlmError("aborted", "вызов отменён (бюджет генерации)"));
      };
      waiter.grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** Выдать свободные места: сначала высший приоритет, внутри — порядок прихода. */
  private pump(): void {
    while (this.busy < this.capacity) {
      let best = -1;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]!;
        if (w.background && this.busyBackground >= this.backgroundMax) continue;
        const b = best < 0 ? null : this.waiters[best]!;
        if (b === null || w.rank < b.rank || (w.rank === b.rank && w.seq < b.seq)) best = i;
      }
      if (best < 0) return;
      const [w] = this.waiters.splice(best, 1);
      this.busy++;
      if (w!.background) this.busyBackground++;
      w!.grant();
    }
  }
}

export const PROVIDER_CONCURRENCY = 3;
/** Фоновой полосе (топ рейтинга) — не больше 1 места из 3: остальные держатся за пользователями. */
export const BACKGROUND_MAX = 1;
const providerGate = new ProviderGate(PROVIDER_CONCURRENCY, BACKGROUND_MAX);

// ---------- z.ai: OpenAI-совместимый стрим с tool_calls (порт dndy-llama) ----------

export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
/** OpenAI-совместимый шлюз YandexGPT (tools, стрим, usage — как у z.ai). */
export const DEFAULT_YANDEX_BASE_URL = "https://ai.api.cloud.yandex.net/v1";
const DEFAULT_STALL_MS = 120_000;

interface ZaiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  /** bearer (z.ai, дефолт) | api-key (YandexGPT: `Authorization: Api-Key …`) */
  authScheme?: "bearer" | "api-key";
  fetchImpl?: typeof fetch;
  stallMs?: number;
}

function excerpt(s: string, n = 300): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

function wireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

interface ToolSlot {
  id: string;
  name: string;
  args: string;
}

/** Накопление фрагментов tool_calls: слоты по index, аргументы доклеиваются. */
function accumulateToolCalls(slots: Map<number, ToolSlot>, tcs: unknown): void {
  if (!Array.isArray(tcs)) return;
  for (const raw of tcs) {
    if (typeof raw !== "object" || raw === null) continue;
    const tc = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } | null };
    const idx = typeof tc.index === "number" && Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : 0;
    let slot = slots.get(idx);
    if (!slot) {
      slot = { id: "", name: "", args: "" };
      slots.set(idx, slot);
    }
    if (typeof tc.id === "string" && tc.id.length > 0) slot.id = tc.id;
    if (tc.function) {
      if (typeof tc.function.name === "string" && tc.function.name.length > 0) {
        slot.name = slot.name.length === 0 ? tc.function.name : slot.name;
      }
      if (typeof tc.function.arguments === "string") slot.args += tc.function.arguments;
    }
  }
}

async function callZai(o: ZaiOptions, opts: Parameters<CallLlm>[0]): Promise<LlmResult> {
  const stallMs = o.stallMs ?? DEFAULT_STALL_MS;
  const ac = new AbortController();
  const onOuterAbort = (): void => ac.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (opts.signal?.aborted) ac.abort();
  const hard = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // stall-сигнал resolve-only (никогда не rejected — проигравшая сторона
  // гонок ниже не рождает unhandled rejection)
  let stallNow: (() => void) | null = null;
  const stalled = new Promise<"stall">((res) => {
    stallNow = () => res("stall");
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      stallNow?.();
      ac.abort();
      reader?.cancel().catch(() => {});
    }, stallMs);
  };

  let resp: Response | "stall";
  try {
    arm(); // таймер с самого fetch: ожидание заголовков тоже покрыто
    resp = await Promise.race([
      (o.fetchImpl ?? fetch)(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: o.authScheme === "api-key" ? `Api-Key ${o.apiKey}` : `Bearer ${o.apiKey}`,
        },
        body: JSON.stringify({
          model: o.model,
          messages: wireMessages(opts.messages),
          ...(opts.tools !== undefined && opts.tools.length > 0 ? { tools: opts.tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: "disabled" },
          temperature: o.temperature,
        }),
        signal: ac.signal,
      }),
      stalled,
    ]);
  } catch (e) {
    if (opts.signal?.aborted) throw new LlmError("aborted", "вызов отменён (бюджет генерации)");
    throw new LlmError("network", `сеть: ${(e as Error).message}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
    clearTimeout(hard);
  }
  if (resp === "stall") {
    throw new LlmError("stall", `модель молчит: ни одного байта за ${Math.round(stallMs / 1000)} с (ожидание ответа)`);
  }
  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    throw new LlmError(String(resp.status), `HTTP ${resp.status}: ${excerpt(raw)}`, raw, retryAfterMsOf(resp.headers.get("retry-after")));
  }
  if (resp.body === null) {
    throw new LlmError("no_body", "пустое тело ответа");
  }

  reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const toolSlots = new Map<number, ToolSlot>();
  let usage: { in: number; out: number } | null = null;
  let finish: string | null = null;
  let done = false;

  try {
    arm();
    outer: while (true) {
      const chunk = await Promise.race([reader.read(), stalled]);
      if (chunk === "stall") {
        throw new LlmError("stall", `стрим замолчал на ${Math.round(stallMs / 1000)} с (получено ${text.length} символов)`);
      }
      const { done: streamDone, value } = chunk;
      if (streamDone) break;
      arm(); // любой байт сбрасывает детектор мёртвой трубы
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw.startsWith("data:")) continue;
        const data = raw.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break outer;
        }
        let j: unknown;
        try {
          j = JSON.parse(data);
        } catch {
          continue; // keep-alive шум терпим
        }
        const parsed = j as {
          choices?: Array<{ delta?: { content?: string; tool_calls?: unknown }; finish_reason?: string | null }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) text += delta;
        if (choice?.delta?.tool_calls !== undefined) accumulateToolCalls(toolSlots, choice.delta.tool_calls);
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (parsed.usage) {
          usage = { in: parsed.usage.prompt_tokens ?? 0, out: parsed.usage.completion_tokens ?? 0 };
        }
      }
    }
  } catch (e) {
    // В5.2 (Б7, долг аудита В5.1, reliability «мелочь 1»): обрыв в фазе стрима — те же
    // коды, что в фазе запроса; сырой DOMException в outcomes и логи не едет
    if (e instanceof LlmError) throw e;
    if (opts.signal?.aborted) throw new LlmError("aborted", "вызов отменён (бюджет генерации)");
    throw new LlmError("network", `сеть (стрим): ${(e as Error).message}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
    clearTimeout(hard);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  const toolCalls = [...toolSlots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => ({ id: s.id, name: s.name, arguments: s.args }))
    .filter((tc) => tc.id.length > 0 && tc.name.length > 0);
  if (text.length === 0 && toolCalls.length === 0) {
    throw new LlmError("empty", done ? "пустой ответ модели" : `стрим оборван без контента (finish=${finish})`);
  }
  if (!done && finish === null && toolCalls.length === 0) {
    throw new LlmError("stream_closed", `стрим оборван на середине (получено ${text.length} символов)`);
  }
  return { text, toolCalls, finish, usage };
}

// ---------- YandexGPT: прежний нек-стриминговый путь (логика не тронута) ----------

export interface MakeLlmOptions {
  /** инъекция fetch для тестов (только zai-путь) */
  fetchImpl?: typeof fetch;
  /** stall-гард, мс (тесты ставят маленький) */
  stallMs?: number;
  /** В5.2 (аудит очереди О1): приоритет вызовов этого клиента в семафоре провайдера */
  priority?: LlmPriority;
}

export function makeLlm(config: Config, override?: (role: LlmRoleKey) => CallLlm, opts: MakeLlmOptions = {}): CallLlm {
  // override — пер-role шов для тестов/фейков (хартия-роль или ярус → свой вызов)
  if (override) return (callOpts) => override(callOpts.role ?? "main")(callOpts);
  return (callOpts) => {
    const role = callOpts.role ?? "main";
    const model =
      role === "main" || role === "overview"
        ? config.llm.mainModel
        : role === "side"
          ? config.llm.sideModel
          : modelTierOf(role) === "main"
            ? config.llm.mainModel
            : config.llm.sideModel;
    const temperature = temperatureOf(role);
    if (config.llm.provider === "yandex") {
      // YandexGPT через OpenAI-совместимый шлюз ai.api.cloud.yandex.net:
      // tools, стрим и usage — как у z.ai; модель — полный URI с версией.
      const folder = config.llm.yandexFolderId;
      if (!folder) throw new Error("YAGPT_FOLDER_ID не задан в .env");
      const yandex: ZaiOptions = {
        apiKey: requireKey(config),
        model: `gpt://${folder}/${model}${model.includes("/") ? "" : "/latest"}`,
        baseUrl: DEFAULT_YANDEX_BASE_URL,
        authScheme: "api-key",
        temperature,
        fetchImpl: opts.fetchImpl,
        stallMs: opts.stallMs,
      };
      return providerGate.run(() => callZai(yandex, callOpts), opts.priority, callOpts.signal);
    }
    const zai: ZaiOptions = {
      apiKey: requireKey(config),
      model,
      baseUrl: config.llm.baseUrl ?? DEFAULT_ZAI_BASE_URL,
      temperature,
      fetchImpl: opts.fetchImpl,
      stallMs: opts.stallMs,
    };
    return providerGate.run(() => callZai(zai, callOpts), opts.priority, callOpts.signal);
  };
}
