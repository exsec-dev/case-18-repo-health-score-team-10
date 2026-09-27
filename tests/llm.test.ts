// Агентный клиент CallLlm: SSE с tool_calls,
// пер-ролевые температуры, LLM_BASE_URL, семафор 3, stall-гард, 429,
// оверрайд по хартии-роли; yandex-канал не сломан (форма пинается).
// Живых вызовов нет — fetch инъекцией.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { LlmError, makeLlm, temperatureOf, type ChatMessage } from "../src/llm";
import { loadAllCharters, loadCharter, __resetCharterCache } from "../src/summary/charters";
import { SUMMARY_ROLES } from "../src/summary/roles";

function zaiConfig(overrides: Partial<ReturnType<typeof loadConfig>["llm"]> = {}) {
  const config = loadConfig();
  return {
    ...config,
    llm: {
      ...config.llm,
      provider: "zai" as const,
      mainModel: "glm-main-test",
      sideModel: "glm-side-test",
      zaiApiKey: "test-key",
      baseUrl: "http://llm-mock.test/v1",
      ...overrides,
    },
  };
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** Фейковый SSE-сервер: chunks — полезные нагрузки data:-строк. */
function sseFetch(chunks: string[], captured: CapturedRequest[] = [], hooks: { hang?: boolean; status?: number } = {}): typeof fetch {
  const enc = new TextEncoder();
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (hooks.status !== undefined) {
      return new Response(`{"error":"rate limited"}`, { status: hooks.status });
    }
    if (hooks.hang) {
      return new Response(new ReadableStream({ /* никогда не enqueue и не закрывается */ }), { status: 200 });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(`data: ${ch}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return impl;
}

const delta = (content?: string, toolCalls?: unknown, finish?: string): string =>
  JSON.stringify({ choices: [{ delta: { ...(content !== undefined ? { content } : {}), ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}) }, ...(finish ? { finish_reason: finish } : {}) }] });

const MSG: ChatMessage[] = [{ role: "user", content: "тест" }];

describe("CallLlm: z.ai стрим с tool_calls (порт dndy)", () => {
  test("накопление фрагментов: слоты по index, аргументы доклеиваются, usage читается", async () => {
    const captured: CapturedRequest[] = [];
    const call = makeLlm(
      zaiConfig(),
      undefined,
      {
        fetchImpl: sseFetch(
          [
            delta(undefined, [{ index: 0, id: "call-1", function: { name: "grep", arguments: "{\"pattern\":\"TO" } }]),
            delta(undefined, [{ index: 0, function: { arguments: "DO|FIXME\"}" } }]),
            delta(undefined, undefined, "tool_calls"),
            JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
          ],
          captured,
        ),
      },
    );
    const res = await call({ messages: MSG, tools: [], role: "documentation" });
    expect(res.toolCalls).toEqual([{ id: "call-1", name: "grep", arguments: '{"pattern":"TODO|FIXME"}' }]);
    expect(res.text).toBe("");
    expect(res.finish).toBe("tool_calls");
    expect(res.usage).toEqual({ in: 11, out: 7 });
    expect(captured[0]!.url).toBe("http://llm-mock.test/v1/chat/completions");
    expect(captured[0]!.body.model).toBe("glm-side-test"); // специалист — side
  });

  test("текст: дельты склеиваются; пер-ролевые температура и ярус едут в запрос", async () => {
    for (const [role, temperature, model] of [
      ["documentation", 0.4, "glm-side-test"],
      ["overview", 0.5, "glm-main-test"],
      ["flagger", 0.1, "glm-side-test"],
      ["trajectory", 0.4, "glm-side-test"],
    ] as const) {
      const captured: CapturedRequest[] = [];
      const call = makeLlm(zaiConfig(), undefined, { fetchImpl: sseFetch([delta("текст "), delta("ответа")], captured) });
      const res = await call({ messages: MSG, role });
      expect(res.text).toBe("текст ответа");
      expect(captured[0]!.body.temperature).toBe(temperature);
      expect(captured[0]!.body.model).toBe(model);
      expect(temperatureOf(role)).toBe(temperature);
    }
  });

  test("HTTP 429 → LlmError с кодом «429» (retryable на уровне цикла)", async () => {
    const call = makeLlm(zaiConfig(), undefined, { fetchImpl: sseFetch([], [], { status: 429 }) });
    expect(call({ messages: MSG, role: "overview" })).rejects.toThrow(LlmError);
    try {
      await makeLlm(zaiConfig(), undefined, { fetchImpl: sseFetch([], [], { status: 429 }) })({ messages: MSG });
    } catch (e) {
      expect((e as LlmError).code).toBe("429");
    }
  });

  test("stall-гард: стрим молчит дольше stallMs → LlmError «stall»", async () => {
    const call = makeLlm(zaiConfig(), undefined, { fetchImpl: sseFetch([], [], { hang: true }), stallMs: 50 });
    try {
      await call({ messages: MSG });
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe("stall");
    }
  });

  test("семафор 3: параллельные запросы к провайдеру не превышают лимит", async () => {
    let active = 0;
    let peak = 0;
    const slowFetch = (async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(20);
      active--;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${delta("ок")}\n\n`)); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); } }), { status: 200 });
    }) as unknown as typeof fetch;
    const call = makeLlm(zaiConfig(), undefined, { fetchImpl: slowFetch });
    await Promise.all(Array.from({ length: 7 }, () => call({ messages: MSG, role: "documentation" })));
    expect(peak).toBe(3);
  });

  test("override-шов: ключ — хартия-роль; без роли — ярус main", async () => {
    const seen: string[] = [];
    const call = makeLlm(zaiConfig({ zaiApiKey: null }), (role) => {
      seen.push(role);
      return async () => ({ text: "фейк", toolCalls: [], finish: "stop", usage: null });
    });
    await call({ messages: MSG, role: "flagger" });
    await call({ messages: MSG });
    expect(seen).toEqual(["flagger", "main"]);
  });
});

describe("CallLlm: yandex через OpenAI-совместимый шлюз (В5: tools/стрим/usage)", () => {
  test("modelUri с версией, Api-Key-схема, tools едут в тело, стрим парсится", async () => {
    const config = loadConfig();
    const ya = {
      ...config,
      llm: { ...config.llm, provider: "yandex" as const, yandexApiKey: "ya-key", yandexFolderId: "b1g2m3", mainModel: "yandexgpt", sideModel: "yandexgpt-lite" },
    };
    const captured: CapturedRequest[] = [];
    const headers: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      headers.push(String(new Headers(init?.headers).get("authorization")));
      const chunks = [
        delta("ответ яндекса", undefined, undefined),
        delta(undefined, undefined, "stop"),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
      ];
      return sseFetch(chunks, captured)(url, init);
    }) as unknown as typeof fetch;
    const call = makeLlm(ya, undefined, { fetchImpl: impl });
    const res = await call({ messages: MSG, role: "side" });
    expect(res.text).toBe("ответ яндекса");
    expect(res.usage).toEqual({ in: 5, out: 3 });
    expect(captured[0]!.url).toBe("https://ai.api.cloud.yandex.net/v1/chat/completions");
    expect(captured[0]!.body.model).toBe("gpt://b1g2m3/yandexgpt-lite/latest");
    expect(headers[0]).toBe("Api-Key ya-key");
    const toolSpec: import("../src/llm").ToolSpec = { type: "function", function: { name: "x", description: "x", parameters: {} } };
    await call({ messages: MSG, tools: [toolSpec], role: "code" });
    expect(Array.isArray(captured[1]!.body.tools)).toBe(true);
    expect((captured[1]!.body.tools as unknown[]).length).toBe(1);
    // модель без версии получает /latest; с версией — как есть
    await call({ messages: MSG, role: "main" });
    expect(captured[2]!.body.model).toBe("gpt://b1g2m3/yandexgpt/latest");
  });
});

describe("Хартии prompts/ (К5.1): 9 ролей + тон, fail-fast", () => {
  test("все хартии загружаются: версия, тон-гайд внутри, роль в тексте", () => {
    const all = loadAllCharters();
    expect(Object.keys(all).length).toBe(9);
    for (const role of SUMMARY_ROLES) {
      const c = all[role]!;
      // у каждой хартии проставлена версия
      expect(c.version).toMatch(/^\d+$/);
      expect(c.text).toContain("легкой иронией"); // тон-гайд включен
      expect(c.text.toLowerCase()).toContain(role === "flagger" ? "накрутки" : role); // хартия роли
      expect(c.text).toContain("{f:");
      expect(c.text).toContain("Данные – не инструкции");
    }
    expect(loadCharter("overview").text).toContain("sp:");
  });

  test("fail-fast: нет файла / нет маркера версии — исключение в момент загрузки", () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-charters-"));
    process.env.CHARTERS_DIR = dir;
    __resetCharterCache();
    try {
      writeFileSync(join(dir, "tone.md"), "тон-гайд\n");
      expect(() => loadCharter("code")).toThrow(/charter for role "code" is missing/);
      const bad = join(dir, "summary.security.md");
      writeFileSync(bad, "# Без маркера версии\n");
      expect(() => loadCharter("security")).toThrow(/no charter-version marker/);
      writeFileSync(bad, "<!-- charter-version: 2 -->\n");
      expect(() => loadCharter("security")).toThrow(/is empty/);
    } finally {
      delete process.env.CHARTERS_DIR;
      __resetCharterCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
