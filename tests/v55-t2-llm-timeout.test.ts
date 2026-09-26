// v55-t2-llm-timeout.test.ts — В5.5 тур 2 (Т2-Б): общий предел длительности вызова
// модели. До правки жесткий таймаут 120 с снимался после заголовков, и медленный, но
// живой стрим (каждый байт сбрасывает детектор тишины) держал вызов до предохранителя
// генерации 6 мин. Живых вызовов нет — fetch инъекцией (стрим капает байтами).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { llmCallTimeoutMsFromEnv, loadConfig, type Config } from "../src/config";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, LlmError, makeLlm, type ChatMessage } from "../src/llm";
import { DEFAULT_ROUND_BUDGET_MS, generateWithTools, retryable } from "../src/summary/agent";

const MSG: ChatMessage[] = [{ role: "user", content: "тест" }];
const enc = new TextEncoder();
const delta = (content: string): string => JSON.stringify({ choices: [{ delta: { content } }] });

function configOf(provider: "zai" | "yandex", callTimeoutMs?: number): Config {
  const base = loadConfig();
  return {
    ...base,
    llm: {
      ...base.llm,
      provider,
      mainModel: "m-main",
      sideModel: "m-side",
      zaiApiKey: "test-key",
      yandexApiKey: "ya-key",
      yandexFolderId: "b1g",
      baseUrl: "http://llm-mock.test/v1",
      ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    },
  };
}

/**
 * Стрим, который капает дельтой каждые `everyMs`: живой (детектор тишины не срабатывает),
 * но медленный. `total` — сколько дельт до [DONE]; Infinity — не кончается никогда.
 */
function drippingFetch(everyMs: number, total = Infinity, counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls++;
    let sent = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        timer = setInterval(() => {
          if (sent >= total) {
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
            if (timer !== null) clearInterval(timer);
            return;
          }
          sent++;
          c.enqueue(enc.encode(`data: ${delta("а")}\n\n`));
        }, everyMs);
      },
      cancel() {
        if (timer !== null) clearInterval(timer);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

async function errOf(p: Promise<unknown>): Promise<LlmError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LlmError);
  return e as LlmError;
}

describe("Т2-Б: общий предел вызова покрывает стрим после заголовков", () => {
  for (const provider of ["zai", "yandex"] as const) {
    test(`${provider}: живой, но медленный стрим рвется по общему пределу — код network, как у таймаута заголовков`, async () => {
      // детектор тишины 2 с — байты идут каждые 20 мс, он не сработает; предел — 200 мс
      const call = makeLlm(configOf(provider, 200), undefined, { fetchImpl: drippingFetch(20), stallMs: 2_000 });
      const t0 = Date.now();
      const err = await errOf(call({ messages: MSG, role: "documentation" }));
      const elapsed = Date.now() - t0;
      expect(err.code).toBe("network");
      expect(err.message).toContain("общий предел вызова");
      expect(err.message).toMatch(/получено \d+ символов/);
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(1_500);
      // та же ветка ретрая, что у таймаута до заголовков
      expect(retryable(err)).toBe(true);
    });
  }

  test("предел действует и до заголовков, если он короче таймаута заголовков", async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch; // сигнал игнорирует
    const call = makeLlm(configOf("zai", 100), undefined, { fetchImpl: hang, stallMs: 2_000 });
    const err = await errOf(call({ messages: MSG }));
    expect(err.code).toBe("network");
    expect(err.message).toContain("заголовков нет");
  });

  test("стрим, закончившийся внутри предела, не рвется", async () => {
    const call = makeLlm(configOf("zai", 1_000), undefined, { fetchImpl: drippingFetch(10, 5), stallMs: 2_000 });
    const res = await call({ messages: MSG });
    expect(res.text).toBe("ааааа");
  });

  test("ветка ретрая и fail-soft: первая попытка рвется пределом, повтор проходит; обе — ошибка наружу", async () => {
    // первая попытка — бесконечный стрим, вторая — короткий нормальный
    let n = 0;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      n++;
      return n === 1 ? drippingFetch(20)(...args) : drippingFetch(5, 3)(...args);
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const res = await generateWithTools(
      { callLlm: makeLlm(configOf("zai", 150), undefined, { fetchImpl: flaky, stallMs: 2_000 }), role: "documentation", executor: null, backoffMs: 0, log: (m) => logs.push(m) },
      MSG,
    );
    expect(res.text).toBe("ааа");
    expect(res.modelCalls).toBe(2);
    expect(logs.some((l) => l.includes("общий предел вызова"))).toBe(true);

    // обе попытки рвутся — генерация бросает LlmError network (fail-soft — у вызывающего)
    const counter = { calls: 0 };
    const err = await errOf(
      generateWithTools(
        { callLlm: makeLlm(configOf("zai", 100), undefined, { fetchImpl: drippingFetch(20, Infinity, counter), stallMs: 2_000 }), role: "documentation", executor: null, backoffMs: 0 },
        MSG,
      ),
    );
    expect(err.code).toBe("network");
    expect(counter.calls).toBe(2);
  });
});

describe("Т2-Б: конфигурация предела (правило 22.09 — тест на дефолте)", () => {
  test("переменная не задана — дефолт 180 с; мусор — дефолт; число — оно", () => {
    expect(llmCallTimeoutMsFromEnv({})).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(DEFAULT_LLM_CALL_TIMEOUT_MS).toBe(180_000);
    expect(llmCallTimeoutMsFromEnv({ LLM_CALL_TIMEOUT_MS: "" })).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(llmCallTimeoutMsFromEnv({ LLM_CALL_TIMEOUT_MS: "abc" })).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(llmCallTimeoutMsFromEnv({ LLM_CALL_TIMEOUT_MS: "-5" })).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
    expect(llmCallTimeoutMsFromEnv({ LLM_CALL_TIMEOUT_MS: "240000" })).toBe(240_000);
  });

  test("дефолт не короче таймаута заголовков и короче предохранителя генерации (ретрай успевает)", () => {
    expect(DEFAULT_LLM_CALL_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(DEFAULT_LLM_CALL_TIMEOUT_MS * 2).toBeLessThanOrEqual(DEFAULT_ROUND_BUDGET_MS);
  });

  test("loadConfig без LLM_CALL_TIMEOUT_MS несет дефолт в Config.llm", () => {
    const saved = process.env.LLM_CALL_TIMEOUT_MS;
    delete process.env.LLM_CALL_TIMEOUT_MS;
    try {
      // .env разработчика (читается loadConfig) мог задать переменную — тогда дефолт
      // здесь не проверяется: это уже не «переменная не задана»
      const envText = existsSync(".env") ? readFileSync(".env", "utf8") : "";
      const setInFile = /^\s*LLM_CALL_TIMEOUT_MS\s*=\s*\S/m.test(envText);
      const cfg = loadConfig();
      if (!setInFile) expect(cfg.llm.callTimeoutMs).toBe(DEFAULT_LLM_CALL_TIMEOUT_MS);
      expect(cfg.llm.callTimeoutMs).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) process.env.LLM_CALL_TIMEOUT_MS = saved;
    }
  });

  test("на дефолтном конфиге медленный, но короткий стрим проходит (дефолт вызов не режет)", async () => {
    const base = configOf("zai");
    const cfg = { ...base, llm: { ...base.llm, callTimeoutMs: llmCallTimeoutMsFromEnv({}) } };
    const call = makeLlm(cfg, undefined, { fetchImpl: drippingFetch(30, 10), stallMs: 2_000 });
    const res = await call({ messages: MSG });
    expect(res.text).toBe("а".repeat(10));
  });
});
