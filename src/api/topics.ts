// Тематика репозитория для фильтра рейтинга.
//
// В API SourceCraft у репозитория тем нет, поэтому тематика выводится правилами
// из трех источников: ключевые слова в адресе, заголовке и описании; основной
// язык платформы; зависимости из манифестов клона (факт `tree.deps`:
// package.json, requirements.txt, go.mod и прочие). Тем у репозитория может быть
// несколько или ни одной. На оценку и место тематика не влияет – это только
// навигация по каталогу. Чистый модуль без БД и React: его берут сервер
// (`repos.ts`, `jobs/topics.ts`) и бандл web (`Rating.tsx`, `ratingParams.ts`).
//
// При изменении правил поднимается TOPIC_RULES_VERSION: сервер при старте
// пересчитывает темы всех репозиториев, если версия в meta отстала.

export const TOPIC_RULES_VERSION = "1";

export type TopicId = "bot" | "web" | "ml" | "game" | "edu" | "mobile" | "devops" | "lib";

export interface TopicRule {
  id: TopicId;
  title: string;
  /** ключевые слова адреса/заголовка/описания (целыми словами, без учета регистра) */
  words: RegExp;
  /** языки платформы, которые сами по себе дают тему */
  languages: readonly string[];
  /** имена зависимостей (в нижнем регистре, без версии и scope) */
  deps: readonly string[];
}

// \b в JS не знает кириллицы: границы слов – через \p{L}\p{N} с флагом u
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const words = (src: string): RegExp => new RegExp(`${B}(?:${src})${E}`, "iu");

export const TOPIC_RULES: readonly TopicRule[] = [
  {
    id: "bot",
    title: "Боты",
    words: words("bots?|tg-?bots?|telegram|discord|vk-?bots?|aiogram|telebot|chat-?bots?|бот\\p{L}*|телеграм\\p{L}*|чат-?бот\\p{L}*"),
    languages: [],
    deps: ["aiogram", "python-telegram-bot", "telebot", "pytelegrambotapi", "telethon", "pyrogram", "vkbottle", "telegraf", "grammy", "node-telegram-bot-api", "discord.py", "discord.js", "telegram-bot-api", "go-telegram-bot-api", "tgbotapi"],
  },
  {
    id: "web",
    title: "Веб",
    words: words(
      "web|website|site|landing|frontend|backend|fullstack|api|rest|django|flask|fastapi|react|vue|nuxt|next\\.?js|svelte|angular|express|laravel|spring|сайт\\p{L}*|веб\\p{L}*|лендинг\\p{L}*|интернет-магазин\\p{L}*|бэкенд\\p{L}*|фронтенд\\p{L}*",
    ),
    languages: ["HTML", "CSS", "SCSS", "Vue", "Svelte", "PHP", "Blade", "Twig"],
    deps: [
      "django", "flask", "fastapi", "starlette", "aiohttp", "tornado", "sanic",
      "express", "koa", "fastify", "hapi", "react", "react-dom", "vue", "nuxt", "next", "svelte", "angular", "core", "@angular/core", "@nestjs/core",
      "gin", "echo", "fiber", "chi", "mux", "laravel", "framework", "symfony", "spring-boot-starter-web", "actix-web", "axum", "rocket", "warp", "rails", "sinatra",
    ],
  },
  {
    id: "ml",
    title: "ML и данные",
    words: words(
      "ml|ai|llm|gpt|rag|nlp|cv|neural|pytorch|tensorflow|sklearn|dataset|datasets|yolo|machine learning|deep learning|data science|нейро\\p{L}*|нейросет\\p{L}*|датасет\\p{L}*|машинн\\p{L}+ обучени\\p{L}*|анализ данных|распознавани\\p{L}*",
    ),
    languages: ["Jupyter Notebook"],
    deps: [
      "torch", "pytorch", "tensorflow", "keras", "scikit-learn", "sklearn", "transformers", "langchain", "langchain-core", "llama-index", "openai", "anthropic",
      "numpy", "pandas", "scipy", "xgboost", "lightgbm", "catboost", "sentence-transformers", "ultralytics", "opencv-python", "cv2", "spacy", "nltk", "gensim", "statsmodels", "polars",
    ],
  },
  {
    id: "game",
    title: "Игры",
    words: words("games?|gamedev|unity|godot|pygame|arcade|roguelike|platformer|игр\\p{L}*|геймдев\\p{L}*"),
    languages: ["GDScript"],
    deps: ["pygame", "arcade", "phaser", "pixi.js", "bevy", "raylib", "love", "ebiten", "ebitengine"],
  },
  {
    id: "edu",
    title: "Учебные",
    words: words(
      "labs?|laba|homeworks?|hw\\d*|courses?|coursework|lessons?|practice|practicum|lyceum|yandexlyceum|exam|olymp\\p{L}*|study|students?|лаб\\p{L}*|курс\\p{L}*|урок\\p{L}*|учебн\\p{L}*|домашн\\p{L}*|задани\\p{L}*|практикум\\p{L}*|лице\\p{L}*|семинар\\p{L}*|олимпиад\\p{L}*|студент\\p{L}*|диплом\\p{L}*",
    ),
    languages: [],
    deps: [],
  },
  {
    id: "mobile",
    title: "Мобильные",
    words: words("android|ios|flutter|mobile|react native|kotlin multiplatform|swiftui|мобильн\\p{L}*"),
    languages: ["Dart", "Swift", "Objective-C"],
    deps: ["flutter", "react-native", "expo", "androidx.core", "androidx.appcompat", "androidx.compose.ui", "com.android.application", "com.android.library"],
  },
  {
    id: "devops",
    title: "DevOps",
    words: words(
      "docker|kubernetes|k8s|helm|terraform|ansible|devops|infra|infrastructure|deploy\\p{L}*|runners?|monitoring|prometheus|grafana|nginx|containers?|ci-?cd|контейнер\\p{L}*|инфраструктур\\p{L}*|деплой\\p{L}*|мониторинг\\p{L}*",
    ),
    languages: ["HCL", "Dockerfile", "Jsonnet"],
    deps: ["ansible", "ansible-core", "docker", "kubernetes", "client-go", "prometheus-client", "prom-client", "terraform"],
  },
  {
    id: "lib",
    title: "Инструменты",
    words: words(
      "library|libs?|sdk|framework|toolkit|cli|plugins?|extensions?|parser|wrapper|utils?|utilities|библиотек\\p{L}*|фреймворк\\p{L}*|плагин\\p{L}*|утилит\\p{L}*|инструмент\\p{L}*|расширени\\p{L}*",
    ),
    languages: [],
    deps: ["click", "typer", "commander", "yargs", "cobra", "clap", "urfave/cli", "cli"],
  },
];

export const TOPIC_IDS: readonly TopicId[] = TOPIC_RULES.map((r) => r.id);
export const TOPIC_TITLES: Record<TopicId, string> = Object.fromEntries(TOPIC_RULES.map((r) => [r.id, r.title])) as Record<TopicId, string>;

export function isTopicId(value: string): value is TopicId {
  return (TOPIC_IDS as readonly string[]).includes(value);
}

export interface TopicInput {
  /** адрес org/repo – дефисы, подчеркивания и точки считаются разделителями слов */
  slug: string;
  title?: string | null;
  description?: string | null;
  language?: string | null;
  /** имена зависимостей из манифестов клона (факт `tree.deps`); регистр и версии не важны */
  deps?: readonly string[] | null;
}

/**
 * Имя зависимости к ключу правил: нижний регистр, без версии, без scope у npm
 * (`@nestjs/core` → `core` И полное `@nestjs/core`), у Go-модулей – последний
 * сегмент пути и пара «владелец/имя».
 */
export function depKeys(raw: string): string[] {
  const name = raw.trim().toLowerCase().replace(/[\s=<>~!^@]+[\d.*].*$/, "");
  if (name === "") return [];
  const keys = new Set<string>([name]);
  if (name.startsWith("@")) keys.add(name.slice(name.indexOf("/") + 1));
  if (name.includes("/")) {
    const parts = name.split("/").filter((p) => p !== "");
    const last = parts[parts.length - 1];
    if (last !== undefined) {
      keys.add(last.replace(/^v\d+$/, "") || last);
      if (parts.length >= 2 && /^v\d+$/.test(last)) keys.add(parts[parts.length - 2]!);
      if (parts.length >= 2) keys.add(`${parts[parts.length - 2]}/${last}`);
    }
  }
  if (name.includes(":")) keys.add(name.slice(name.lastIndexOf(":") + 1));
  return [...keys].filter((k) => k !== "");
}

/** Темы репозитория по правилам, в порядке TOPIC_RULES; пустой список – тем нет. */
export function classifyTopics(input: TopicInput): TopicId[] {
  const slugWords = input.slug.replace(/[-_./]+/g, " ");
  const text = `${slugWords} ${input.slug} ${input.title ?? ""} ${input.description ?? ""}`;
  const language = input.language ?? null;
  const deps = new Set<string>();
  for (const d of input.deps ?? []) for (const k of depKeys(d)) deps.add(k);
  const out: TopicId[] = [];
  for (const rule of TOPIC_RULES) {
    const byLanguage = language !== null && rule.languages.includes(language);
    const byDeps = rule.deps.some((d) => deps.has(d));
    if (byLanguage || byDeps || rule.words.test(text)) out.push(rule.id);
  }
  return out;
}

/** Хранение в одной колонке `repos.topics` вида «,bot,web,»: фильтр одним LIKE. */
export function encodeTopics(ids: readonly TopicId[]): string | null {
  return ids.length === 0 ? null : `,${ids.join(",")},`;
}

export function decodeTopics(value: string | null | undefined): TopicId[] {
  return (value ?? "").split(",").filter(isTopicId);
}
