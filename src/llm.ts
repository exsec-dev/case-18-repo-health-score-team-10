// llm.ts — CallLlm-шов (перенос dndy-паттерна): провайдер выбирается
// конфигом, пер-channel переопределение — аргументом. Wall-clock фуз и
// честные ошибки; fail-soft остаётся за вызывающим.
import type { Config } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  usage: { in: number; out: number } | null;
}

export type CallLlm = (opts: {
  messages: ChatMessage[];
  role?: "main" | "side"; // main=MAIN_MODEL, side=SIDE_MODEL
  timeoutMs?: number;
}) => Promise<LlmResult>;

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

// z.ai — OpenAI-совместимый чат-эндпоинт (перенос из dndy, упрощён:
// без tools/стрима — для текстовых ролей их не нужно).
async function callZai(config: Config, opts: Parameters<CallLlm>[0]): Promise<LlmResult> {
  const key = requireKey(config);
  const model = opts.role === "side" ? config.llm.sideModel : config.llm.mainModel;
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const r = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: opts.messages, temperature: 0.4 }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`z.ai HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = d.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("z.ai: пустой ответ");
    return { text, usage: { in: d.usage?.prompt_tokens ?? 0, out: d.usage?.completion_tokens ?? 0 } };
  } finally {
    clearTimeout(kill);
  }
}

// YandexGPT — Foundation Models REST. Форма проверяется зондом при
// первом живом ключе (вопрос 3 канвы): модель-URI из folder_id.
async function callYandex(config: Config, opts: Parameters<CallLlm>[0]): Promise<LlmResult> {
  const key = requireKey(config);
  const folder = config.llm.yandexFolderId;
  if (!folder) throw new Error("YAGPT_FOLDER_ID не задан в .env");
  const rawModel = opts.role === "side" ? config.llm.sideModel : config.llm.mainModel;
  const modelUri = rawModel.includes("://") ? rawModel : `gpt://${folder}/${rawModel}`;
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const r = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Key": key },
      body: JSON.stringify({
        modelUri,
        completionOptions: { temperature: 0.4 },
        messages: opts.messages,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`YandexGPT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = (await r.json()) as {
      result?: { alternatives?: Array<{ message?: { content?: string } }>; usage?: { inputTextTokens?: string; completionTokens?: string } };
    };
    const text = d.result?.alternatives?.[0]?.message?.content ?? "";
    if (!text) throw new Error("YandexGPT: пустой ответ");
    return {
      text,
      usage: { in: Number(d.result?.usage?.inputTextTokens ?? 0), out: Number(d.result?.usage?.completionTokens ?? 0) },
    };
  } finally {
    clearTimeout(kill);
  }
}

export function makeLlm(config: Config, override?: (role: "main" | "side") => CallLlm): CallLlm {
  // override — пер-channel шов для тестов (прецедент dndy)
  if (override) return (opts) => override(opts.role ?? "main")(opts);
  return (opts) => (config.llm.provider === "yandex" ? callYandex(config, opts) : callZai(config, opts));
}
