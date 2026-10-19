// Тематика рейтинга: правила классификации (api/topics.ts), разбор манифестов
// зависимостей (collectors/deps.ts), пересчет в repos.topics (jobs/topics.ts),
// фильтр и фасет рейтинга (api/repos.ts), адрес и плашки (web/ratingParams.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { classifyTopics, decodeTopics, depKeys, encodeTopics, TOPIC_IDS } from "../src/api/topics";
import { collectDeps, isManifestPath, parseManifest } from "../src/collectors/deps";
import { DEFAULT_QUERY, listRepos, parseReposQuery, type ReposQuery } from "../src/api/repos";
import { backfillTopics, refreshRepoTopics } from "../src/jobs/topics";
import { activeRatingFilters, normalizeRatingSearch, resetFiltersHref, topicOptions, topicSummary } from "../src/web/ratingParams";
import { makeApiDb, seedRepo, seedScan, seedScore, type ApiTestDb } from "./api-fixtures";

describe("classifyTopics: слова целиком, язык и зависимости", () => {
  test("ключевые слова адреса и описания, дефисы – разделители, «работа» – не бот", () => {
    expect(classifyTopics({ slug: "user/tg-bot-weather", description: "Телеграм-бот погоды", language: "Python" })).toEqual(["bot"]);
    expect(classifyTopics({ slug: "acme/crm", description: "Работа с базой клиентов" })).toEqual([]);
    expect(classifyTopics({ slug: "spbu/lab_3", description: "Лабораторная работа по деревьям", language: "C++" })).toEqual(["edu"]);
  });

  test("язык сам по себе дает тему; темы складываются в порядке правил", () => {
    expect(classifyTopics({ slug: "acme/landing", language: "HTML" })).toEqual(["web"]);
    expect(classifyTopics({ slug: "hse/ml-course", description: "Курс по машинному обучению", language: "Jupyter Notebook" })).toEqual(["ml", "edu"]);
    expect(classifyTopics({ slug: "acme/infra", description: "Terraform для стенда", language: "HCL" })).toEqual(["devops"]);
  });

  test("зависимости: aiogram – бот, django – веб, torch – ML, @nestjs/core и go-модуль по последнему сегменту", () => {
    expect(classifyTopics({ slug: "acme/x", deps: ["aiogram==3.1"] })).toEqual(["bot"]);
    expect(classifyTopics({ slug: "acme/x", deps: ["Django>=4", "psycopg2"] })).toEqual(["web"]);
    expect(classifyTopics({ slug: "acme/x", deps: ["torch", "numpy"] })).toEqual(["ml"]);
    expect(classifyTopics({ slug: "acme/x", deps: ["@nestjs/core"] })).toEqual(["web"]);
    expect(classifyTopics({ slug: "acme/x", deps: ["github.com/gin-gonic/gin"] })).toEqual(["web"]);
    expect(depKeys("github.com/go-telegram-bot-api/telegram-bot-api/v5")).toContain("telegram-bot-api");
  });

  test("кодирование «,bot,web,» и обратно; неизвестные id отбрасываются", () => {
    expect(encodeTopics([])).toBeNull();
    expect(decodeTopics(null)).toEqual([]);
    expect(decodeTopics(encodeTopics(["bot", "web"]))).toEqual(["bot", "web"]);
    expect(decodeTopics(",bot,nope,")).toEqual(["bot"]);
    expect(TOPIC_IDS).toHaveLength(8);
  });
});

describe("parseManifest: имена пакетов из разных экосистем", () => {
  test("package.json, requirements.txt, pyproject, go.mod, Cargo, pom, gradle, Gemfile, pubspec, csproj", () => {
    expect(parseManifest("package.json", JSON.stringify({ dependencies: { react: "^18", "@nestjs/core": "10" }, devDependencies: { vitest: "1" } })).sort()).toEqual(["@nestjs/core", "react", "vitest"]);
    expect(parseManifest("requirements.txt", "# deps\nDjango>=4.2\naiogram==3.1 ; python_version>'3.9'\n-r base.txt\n")).toEqual(["Django", "aiogram"]);
    expect(parseManifest("pyproject.toml", 'dependencies = [\n  "fastapi>=0.1",\n  "uvicorn[standard]",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\ntorch = "2.0"\n').sort()).toEqual(["fastapi", "torch", "uvicorn"]);
    expect(parseManifest("go.mod", "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/sys v0.1.0 // indirect\n)\n")).toEqual(["github.com/gin-gonic/gin", "golang.org/x/sys"]);
    expect(parseManifest("Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\naxum = "0.7"\nserde = { version = "1" }\n\n[dependencies.tokio]\nversion = "1"\n').sort()).toEqual(["axum", "serde", "tokio"]);
    expect(parseManifest("pom.xml", "<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>")).toEqual(["org.springframework.boot:spring-boot-starter-web"]);
    expect(parseManifest("build.gradle.kts", 'implementation("androidx.core:core-ktx:1.12.0")\nid("com.android.application")')).toEqual(["androidx.core:core-ktx", "com.android.application"]);
    expect(parseManifest("Gemfile", "source 'x'\ngem 'rails', '~> 7'\ngem \"pg\"\n")).toEqual(["rails", "pg"]);
    expect(parseManifest("pubspec.yaml", "dependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0\ndev_dependencies:\n  test: any\n")).toEqual(["flutter", "http", "test"]);
    expect(parseManifest("app.csproj", '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13" /></ItemGroup></Project>')).toEqual(["Newtonsoft.Json"]);
    expect(parseManifest("README.md", "anything")).toEqual([]);
    expect(parseManifest("package.json", "{not json")).toEqual([]);
  });

  test("манифест по имени и глубине; node_modules и vendor не считаются", () => {
    expect(isManifestPath("package.json")).toBe(true);
    expect(isManifestPath("apps/web/package.json")).toBe(true);
    expect(isManifestPath("a/b/c/package.json")).toBe(false);
    expect(isManifestPath("node_modules/x/package.json")).toBe(false);
    expect(isManifestPath("requirements-dev.txt")).toBe(true);
    expect(isManifestPath("src/main.go")).toBe(false);
  });

  test("collectDeps: читает манифесты по sha, нечитаемый пропускает, без манифестов – null", async () => {
    const blobs = [
      { path: "package.json", sha: "a", size: 10 },
      { path: "requirements.txt", sha: "b", size: 10 },
      { path: "src/x.ts", sha: "c", size: 10 },
    ];
    const read = async (sha: string) => {
      if (sha === "a") return JSON.stringify({ dependencies: { express: "4" } });
      throw new Error("nope");
    };
    expect(await collectDeps(blobs, read)).toEqual({ manifests: ["package.json"], deps: ["express"] });
    expect(await collectDeps([{ path: "src/x.ts", sha: "c", size: 1 }], read)).toBeNull();
  });
});

describe("repos.topics: пересчет, фильтр, фасет, адрес", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());
  const seed = (repo: string, total: number, opts: { language?: string | null; title?: string; description?: string | null; deps?: string[] } = {}): number => {
    const repoId = seedRepo(t, { org: "f", repo, language: opts.language ?? null, title: opts.title ?? repo });
    if (opts.description !== undefined) t.db.query("UPDATE repos SET description = ? WHERE id = ?").run(opts.description, repoId);
    const scanId = seedScan(t, repoId, { facts: opts.deps ? [{ key: "tree.deps", source: "git", value: { manifests: ["package.json"], deps: opts.deps } }] : [] });
    seedScore(t, repoId, scanId, { total });
    return repoId;
  };
  const botId = seed("weather-bot", 90, { description: "Телеграм-бот погоды", language: "Python" });
  const webId = seed("crm", 80, { description: "Работа с клиентами", deps: ["django"] });
  const noneId = seed("plain", 70, { description: "Просто код" });
  const eduId = seed("lab-2", 60, { language: "HTML" }); // веб по языку, учебный по адресу

  test("refreshRepoTopics пишет «,bot,» и учитывает зависимости из факта", () => {
    for (const id of [botId, webId, noneId, eduId]) refreshRepoTopics(t.db, id);
    const topics = (id: number) => (t.db.query("SELECT topics FROM repos WHERE id = ?").get(id) as { topics: string | null }).topics;
    expect(topics(botId)).toBe(",bot,");
    expect(topics(webId)).toBe(",web,");
    expect(topics(noneId)).toBeNull();
    expect(topics(eduId)).toBe(",web,edu,");
  });

  test("backfillTopics: один раз на версию правил, повтор – null", () => {
    t.db.query("UPDATE repos SET topics = NULL").run();
    expect(backfillTopics(t.db)).toBe(3);
    expect(backfillTopics(t.db)).toBeNull();
  });

  const all = (patch: Partial<ReposQuery> = {}) => listRepos(t.db, { ...DEFAULT_QUERY, perPage: 100, ...patch });
  const names = (r: ReturnType<typeof all>) => r.items.map((i) => i.repo);

  test("фильтр по теме – ИЛИ по нескольким; место не меняется; фасет считает все темы", () => {
    expect(names(all({ topic: ["bot"] }))).toEqual(["weather-bot"]);
    expect(names(all({ topic: ["bot", "edu"] }))).toEqual(["weather-bot", "lab-2"]);
    expect(all({ topic: ["bot", "edu"] }).items.map((i) => i.rank)).toEqual([1, 4]);
    expect(names(all({ topic: ["game"] }))).toEqual([]);
    const facets = all().facets.topics;
    expect(facets.map((f) => f.id)).toEqual([...TOPIC_IDS]);
    expect(Object.fromEntries(facets.map((f) => [f.id, f.count]))).toMatchObject({ bot: 1, web: 2, edu: 1, game: 0 });
    // фасет – по поиску, но без фильтров
    expect(all({ topic: ["bot"] }).facets.topics.find((f) => f.id === "web")?.count).toBe(2);
  });

  test("parseReposQuery: topic повторяемый, неизвестный – 400", () => {
    const ok = parseReposQuery(new URLSearchParams("topic=bot&topic=web&topic=bot"));
    expect(ok.ok && ok.query.topic).toEqual(["bot", "web"]);
    expect(parseReposQuery(new URLSearchParams("topic=nope")).ok).toBe(false);
  });

  test("адрес: нормализация, активные фильтры, сброс, плашки", () => {
    expect(normalizeRatingSearch("?topic=bot&topic=nope&topic=bot")).toEqual({ search: "topic=bot", changed: true });
    expect(normalizeRatingSearch("?topic=web").changed).toBe(false);
    expect(activeRatingFilters("?topic=web")).toEqual(["тематика"]);
    expect(resetFiltersHref("?topic=web&sort=likes")).toBe("/?sort=likes");
    const options = topicOptions({ topics: [{ id: "bot", count: 3 }, { id: "web", count: 0 }] }, ["web"]);
    expect(options.map((o) => o.value)).toEqual(["bot", "web"]); // web с нулем виден, потому что выбран
    expect(options.map((o) => o.title)).toEqual(["Боты", "Веб"]);
    expect(topicOptions(null, []).map((o) => o.count)).toEqual(Array(TOPIC_IDS.length).fill(null));
    expect(topicSummary([])).toBe("");
    expect(topicSummary(["bot"])).toBe("Боты");
    expect(topicSummary(["bot", "web", "ml"])).toBe("Боты +2");
  });
});
