// Тексты ошибок языком продукта. Клиентский словарь «код ошибки / HTTP-статус /
// сетевой сбой → русский текст» проверяется таблицей «каждый код сервера →
// текст»; серверные `message` – по исходнику: без длинного тире, «ё», кодов,
// «HTTP N», «PAT», имен переменных и регулярок.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, mutateJson } from "../src/web/api";
import { authErrorText, errorText } from "../src/web/format";
import { JOB_ERRORS } from "../src/jobs/scheduler";

const ROOT = join(import.meta.dir, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Запрещено в текстах для человека: длинное тире, «ё», коды статусов, жаргон и имена переменных. */
const FORBIDDEN = /—|ё|Ё|HTTP \d|\(HTTP|\bPAT\b|APP_SECRET|YA_CLIENT|Origin|endpoint|\[a-z0-9|Failed to fetch/;
/** Латиница допустима только в именах продукта и форматов. */
const latinLeft = (text: string): string => text.replace(/SourceCraft|Security|CI\/CD|PDF|Markdown|Я ID|org\/repo/g, "");

const SERVER_FILES = ["src/server.ts", "src/api/me.ts", "src/api/repos.ts"];
const codes = [...new Set(SERVER_FILES.flatMap((f) => [...read(f).matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]!)))];

describe("К8.5.4: клиентский словарь ошибок", () => {
  test("каждый код ошибки сервера → русский текст без запрещенных знаков и латиницы (и без сообщения сервера)", () => {
    expect(codes.length).toBeGreaterThan(15);
    const bad = codes
      .map((code) => ({ code, text: errorText({ status: 400, code, message: null }) }))
      .filter(({ text }) => text === "" || FORBIDDEN.test(text) || /[A-Za-z]/.test(latinLeft(text)));
    expect(bad).toEqual([]);
  });

  test("статусы без ответа сервера: сеть, прокси 502 при деплое, 5xx, 429 с Retry-After", () => {
    const texts = [0, 401, 403, 404, 429, 500, 502, 503, 504].map((status) => errorText({ status, code: null, message: null }));
    expect(texts.filter((t) => FORBIDDEN.test(t) || /[A-Za-z]/.test(latinLeft(t)))).toEqual([]);
    expect(errorText({ status: 429, code: "rate_limited", message: "не больше 30 открытий карточки в минуту – попробуйте чуть позже", retryAfter: "42" })).toBe(
      "Не больше 30 открытий карточки в минуту – попробуйте чуть позже. Повторить можно через 42 с.",
    );
  });

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("fetchJson: сетевой сбой (TypeError) и не-JSON 502 → текст словаря, а не «Failed to fetch» / «HTTP 502»", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const net = await fetchJson("/api/repos").catch((e: Error) => e.message);
    globalThis.fetch = (async () => new Response("<html>Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const proxy = await fetchJson("/api/repos").catch((e: Error) => e.message);
    const mutation = await mutateJson("/api/me/favorites", "PUT", {}).catch((e: Error) => e.message);
    expect({ net, proxy, mutation }).toEqual({
      net: "Нет связи с сервером – проверьте подключение и повторите",
      proxy: "Сервис временно недоступен – повторите через минуту",
      mutation: "Сервис временно недоступен – повторите через минуту",
    });
  });

  test("С1-6: причины неудачного входа — словами, без кодов провайдера", () => {
    for (const raw of ["state", "no_code", "access_denied", "invalid_scope"]) {
      const text = authErrorText(raw);
      expect({ raw, forbidden: FORBIDDEN.test(text), code: text.includes(raw) }).toEqual({ raw, forbidden: false, code: false });
    }
  });
});

describe("К8.5.4: серверные сообщения — языком продукта", () => {
  test("ни одного запрещенного знака или жаргона в `message` и отказах сервера (server.ts, me.ts, repos.ts, ya.ts)", () => {
    const offenders: string[] = [];
    for (const f of [...SERVER_FILES, "src/auth/ya.ts"]) {
      const code = strip(read(f));
      const literals = [
        ...code.matchAll(/message: ([`"][^`"]*[`"])/g),
        ...code.matchAll(/(?:badQuery|notFound|forbidden|rateLimited|unauthorized)\(\s*([`"][^`"]*[`"])/g),
        ...code.matchAll(/error: ([`"][^`"]*[`"]) \}/g),
      ].map((m) => m[1]!);
      for (const lit of literals) if (FORBIDDEN.test(lit) || /ожидается \[|ожидался (GET|PUT|POST)/.test(lit)) offenders.push(`${f}: ${lit}`);
    }
    expect(offenders).toEqual([]);
  });

  test("С4-12: причина упавшего задания — каналы словами, не git/rest/appsec", () => {
    expect(JOB_ERRORS.channels(["git", "rest", "appsec"])).toBe("сбор данных не удался: скачивание репозитория, данные SourceCraft, Безопасность");
  });

  test("С2-5/С2-6: настройки токена без «GET /user» и с причиной «не читается»; тексты посева не тронуты (§2-В4)", () => {
    const me = strip(read("src/web/MePage.tsx"));
    expect(me.includes("GET /user")).toBe(false);
    expect(me).toContain("сохраненный токен больше не читается после смены ключа сервиса");
    // UX 17.10: посева избранного нет — тост ведет в «Мои репозитории»
    expect(me).toContain("Репозитории, доступные токену, – в разделе «Мои репозитории».");
    expect(me).not.toContain("Посев избранного");
  });
});
