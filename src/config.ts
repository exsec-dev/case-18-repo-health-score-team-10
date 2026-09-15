// config.ts — env → конфиг. Fail-soft на старте (проверка при
// использовании — хакатон: сервер обязан подниматься и без ключей),
// честные сообщения об ошибках в момент обращения.
export interface Config {
  port: number;
  dataDir: string;
  sourcecraftToken: string | null;
  llm: {
    provider: "yandex" | "zai";
    mainModel: string;
    sideModel: string;
    yandexApiKey: string | null;
    yandexFolderId: string | null;
    zaiApiKey: string | null;
  };
}

function envFile(): Record<string, string> {
  try {
    const raw = require("node:fs").readFileSync(".env", "utf8") as string;
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq > 0) out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const env = { ...envFile(), ...process.env } as Record<string, string>;
  const provider = env.LLM_PROVIDER === "zai" ? "zai" : "yandex";
  const mainModel = env.MAIN_MODEL ?? (provider === "yandex" ? "yandexgpt" : "glm-5.3");
  return {
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8418,
    dataDir: env.DATA_DIR ?? "data",
    sourcecraftToken: env.SOURCECRAFT_TOKEN ?? null,
    llm: {
      provider,
      mainModel,
      sideModel: env.SIDE_MODEL ?? mainModel,
      yandexApiKey: env.YAGPT_API_KEY ?? null,
      yandexFolderId: env.YAGPT_FOLDER_ID ?? null,
      zaiApiKey: env.ZAI_API_KEY ?? null,
    },
  };
}
