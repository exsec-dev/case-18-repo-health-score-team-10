// AI prose must not leak the kitchen of the score: (a) Latin internal keys, (b) raw
// shares / 2+ decimals, (c) methodology jargon. Behavioural tests on validateOutput:
// two real leaking texts are rejected with a reason; ordinary texts (README/CONTRIBUTING
// in caps, whole percents, one decimal, dates, versions, fact numbers) pass. There is
// no numeric corridor: digits are legal, only the FORM of writing them is checked.
import { describe, expect, test } from "bun:test";
import type { FactInput } from "../src/summary/validator";
import { internalKeyLeaks, jargonLeaks, rawNumberLeaks, stripMarkers, validateOutput } from "../src/summary/validator";
import { loadAllCharters } from "../src/summary/charters";

const POINTS: FactInput[] = [
  {
    key: "scores.points",
    value: [
      { date: "2026-09-20T10:00:00Z", headSha: "a1b2c3d", index: 58, coverage: 1, categories: { documentation: 53.29, code: 70, activity: 61, issues: 40 } },
      { date: "2026-09-27T10:00:00Z", headSha: "e4f5a6b", index: 61, coverage: 1, categories: { documentation: 64.75, code: 70, activity: 61, issues: 40 } },
    ],
  },
];
const DOCS: FactInput[] = [
  { key: "docs.presence", value: { readme: true, license: true, contributing: false, codeowners: false, content_checked: true } },
  { key: "docs.readme", value: { bytes: 8000, sections: 5, flags: { install: true, build: false, test: false } } },
];
const CODE: FactInput[] = [
  { key: "code.todo", value: { count: 4, fixme: 1, older_180d: 2, todo_files: 3, blamed_files: 3 } },
  {
    key: "tree.stats",
    value: { top_level: [{ name: "src", type: "dir" }, { name: "tests", type: "dir" }, { name: "docs", type: "dir" }], file_count: 120, bytes: 1, loc: 9000 },
  },
];
const CICD: FactInput[] = [
  { key: "cicd.configs", value: { paths: [".sourcecraft/ci.yaml"], has_ci_yaml: true, has_steps: true } },
  { key: "cicd.runs", value: { last_status: "success", success_rate: 0.866, duration_p50: 306, runs_count: 30, green_streak: 5 } },
];

function reasonsOf(role: Parameters<typeof validateOutput>[0]["role"], text: string, facts: FactInput[], segments: string[] = []): string[] {
  return validateOutput({ role, text, facts, segments }).reasons;
}

describe("audit quotes (finding N5) are rejected with a reason", () => {
  test("trajectory: 'documentation поднялась с 53,29% до 64,75%. Покрытие ... на уровне 1'", () => {
    const text =
      "documentation поднялась с 53,29% до 64,75% {f:scores.points}. Покрытие остается стабильным на уровне 1 {f:scores.points}.";
    const res = validateOutput({ role: "trajectory", text, facts: POINTS });
    expect(res.ok).toBe(false);
    const keys = res.reasons.find((r) => r.startsWith("внутренние ключи"));
    expect(keys).toBeDefined();
    expect(keys).toContain("documentation");
    // the reason teaches the fix for the retry prompt
    expect(keys).toContain("Документация");
    const raw = res.reasons.find((r) => r.startsWith("сырые числа"));
    expect(raw).toBeDefined();
    expect(raw).toContain("53,29");
    expect(raw).toContain("64,75");
    expect(raw).toContain("уровне 1");
    expect(raw).toContain("процент");
  });

  test("overview: 'отсутствие якорных файлов contributing и codeowners'", () => {
    const text =
      "Проект описан подробно, но процесс участия не оформлен: отсутствие якорных файлов contributing и codeowners {sp:documentation:1}.";
    const res = validateOutput({ role: "overview", text, facts: DOCS, segments: ["sp:documentation:1"] });
    expect(res.ok).toBe(false);
    const keys = res.reasons.find((r) => r.startsWith("внутренние ключи"));
    expect(keys).toContain("contributing");
    expect(keys).toContain("codeowners");
    const jargon = res.reasons.find((r) => r.startsWith("жаргон методики"));
    expect(jargon).toContain("якорных");
  });

  test("the fixed wording of both quotes passes", () => {
    expect(
      validateOutput({
        role: "trajectory",
        text: "Документация выросла с 53 до 65 баллов за неделю {f:scores.points}, данные по-прежнему есть по всем категориям {f:scores.points}.",
        facts: POINTS,
      }).ok,
    ).toBe(true);
    expect(
      validateOutput({
        role: "overview",
        text: "Проект описан подробно, но нет правил участия (CONTRIBUTING) и владельцев кода (CODEOWNERS) {sp:documentation:1}.",
        facts: DOCS,
        segments: ["sp:documentation:1"],
      }).ok,
    ).toBe(true);
  });
});

describe("(a) Latin internal keys", () => {
  test("category, submetric and fact keys in lowercase Latin prose are leaks", () => {
    for (const leak of ["documentation", "cicd", "security", "activity", "issues", "code", "todo_total", "stale_share", "docs.presence", "issues.stats", "code.todo.count", "pass_rate", "robot_ratio", "coverage"]) {
      expect(internalKeyLeaks(`Показатель ${leak} заметно вырос.`, [])).toEqual([leak]);
    }
    const res = validateOutput({ role: "code", text: "Всего todo_total = 4, пометки старые {f:code.todo}.", facts: CODE });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("todo_total");
  });

  test("file names in caps (as in the UI), words with capitals and CI/CD are not keys", () => {
    const text = "README описывает установку {f:docs.readme}, LICENSE на месте, а CONTRIBUTING и CODEOWNERS нет {f:docs.presence}.";
    expect(validateOutput({ role: "documentation", text, facts: DOCS }).ok).toBe(true);
    expect(internalKeyLeaks("Настройки CI/CD, HealthCraft Index и Bus factor проекта; AppSec молчит.", [])).toEqual([]);
  });

  test("a marker {f:docs.presence} is not a leak: Latin inside markers is stripped before the check", () => {
    const text = "Обязательные файлы на месте {f:docs.presence}, README подробный {f:docs.readme}.";
    expect(stripMarkers(text)).not.toContain("docs.presence");
    const res = validateOutput({ role: "documentation", text, facts: DOCS });
    expect(res.ok).toBe(true);
    expect(res.refs).toEqual(["docs.presence", "docs.readme"]);
  });

  test("directory and file names from facts, paths and file names with extensions are data, not keys", () => {
    // 'tests' / 'docs' are top-level directories in tree.stats — the code specialist may name them
    const code = "В корне лежат src, tests и docs {f:tree.stats}; 4 пометки TODO в коде {f:code.todo}.";
    expect(validateOutput({ role: "code", text: code, facts: CODE }).ok).toBe(true);
    // a directory named as a directory (seen through tools, not in facts)
    expect(internalKeyLeaks("Отчеты лежат в каталоге coverage, его стоит убрать из репозитория.", [])).toEqual([]);
    const ci = "Конфигурация .sourcecraft/ci.yaml объявляет шаги {f:cicd.configs}, 87% запусков успешны {f:cicd.runs}.";
    expect(validateOutput({ role: "cicd", text: ci, facts: CICD }).ok).toBe(true);
  });
});

describe("(b) raw numbers: 2+ decimals and shares without percent", () => {
  test("2+ decimals are rejected", () => {
    expect(rawNumberLeaks("Доля выросла до 53,29%.")).toEqual(["53,29"]);
    expect(rawNumberLeaks("Коэффициент 0,4512 по выборке.")).toEqual(["0,4512"]);
    expect(rawNumberLeaks("Медиана 48.85 дня.")).toEqual(["48.85"]);
  });

  test("a share written as 'на уровне 1' or a fraction 0,xx next to доля/покрытие/уровень is rejected", () => {
    expect(rawNumberLeaks("Покрытие держится на уровне 1.")).toEqual(["уровне 1"]);
    expect(rawNumberLeaks("Покрытие на уровне 0,75 – данных не хватает.")).toHaveLength(1);
    expect(rawNumberLeaks("Доля роботов 0,4 – заметная.")).toEqual(["Доля роботов 0,4"]);
    const res = validateOutput({ role: "cicd", text: "Доля успешных запусков 0,87 {f:cicd.runs}, конфигурация есть {f:cicd.configs}.", facts: CICD });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("сырые числа");
  });

  test("whole percents, one decimal, fact numbers, dates, versions and ranges pass", () => {
    const ok = [
      "87% запусков успешны, медиана сборки 5,1 мин.",
      "Доля зависших задач 12%, медиана закрытия 0,5 дня.",
      "Индекс вырос с 53 до 65 баллов, покрытие 100%.",
      "Замеры 25.09 и 27.09.2026, модель 4.4.0-hci.",
      "Зона риска – баллы 0-39, 4 категории из 6.",
      "Из 14 задач открыто 4, 1 ответ из 50.",
      "Уровень 1 из 3 по шкале критичности не встречается.",
      "Документация выросла с 53,3 до 64,8 балла.",
    ];
    for (const text of ok) expect(rawNumberLeaks(text)).toEqual([]);
  });
});

describe("(c) methodology jargon", () => {
  test("якорн*, подметрик*, перенормир*, сжат* к минимуму are rejected", () => {
    expect(jargonLeaks("Нет якорного файла.")).toHaveLength(1);
    expect(jargonLeaks("Эта подметрика не весит.")).toHaveLength(1);
    expect(jargonLeaks("После перенормировки вес вырос.")).toHaveLength(1);
    expect(jargonLeaks("Балл сжат к минимуму.")).toHaveLength(1);
    const res = validateOutput({ role: "documentation", text: "Подметрика README в норме {f:docs.readme}.", facts: DOCS });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("жаргон методики");
  });

  test("ordinary words close to the jargon pass", () => {
    expect(jargonLeaks("Метрики стабильны, текст сжат своими словами, якорь проекта – README.")).toEqual([]);
  });
});

describe("real formulations from tests and fixtures pass unchanged", () => {
  const cases: Array<[Parameters<typeof validateOutput>[0]["role"], string, FactInput[]]> = [
    ["documentation", "README покрывает установку {f:docs.presence}.", DOCS],
    ["code", "В коде 4 TODO-пометки {f:code.todo}, темы долга повторяются.", CODE],
    ["activity", "Проект коммитили 2 автора {f:activity.git.summary}.", [{ key: "activity.git.summary", value: { commits: 12, authors: 2 } }]],
    ["activity", "2 автора коммитили до 10.09.2026 {f:activity.git.summary}, ритм ровный.", [{ key: "activity.git.summary", value: { commits: 12, authors: 2 } }]],
    ["activity", "Основной автор – Extended2008, репозиторий case-18 собирается автоматикой.{f:activity.git.summary}", [{ key: "activity.git.summary", value: { commits: 12, authors: 2 } }]],
    ["issues", "Из 14 задач открыто 4 {f:issues.stats}.", [{ key: "issues.stats", value: { open: 4, closed: 10 } }]],
    ["cicd", "Конфиг CI объявляет шаги {f:cicd.configs}.", CICD],
    ["trajectory", "Индекс вырос на 2 пункта между замерами {f:scores.points}.", POINTS],
    ["trajectory", "Индекс держится на 61, покрытие на 1 – проект топчется на месте {f:scores.points}.", POINTS],
  ];
  for (const [role, text, facts] of cases) {
    test(`${role}: ${text.slice(0, 50)}`, () => {
      expect(reasonsOf(role, text, facts)).toEqual([]);
    });
  }
});

describe("charters carry the rule with a bad -> good example (versions +1)", () => {
  const all = loadAllCharters();
  test("versions bumped for all prose roles; flagger (JSON) unchanged", () => {
    expect(all.activity.version).toBe("13");
    expect(all.cicd.version).toBe("14");
    expect(all.code.version).toBe("17");
    expect(all.documentation.version).toBe("8");
    expect(all.issues.version).toBe("14");
    expect(all.security.version).toBe("10");
    expect(all.overview.version).toBe("18");
    expect(all.trajectory.version).toBe("10");
    expect(all.flagger.version).toBe("6");
  });

  test("every prose charter names the three leak classes and the example", () => {
    for (const role of ["activity", "cicd", "code", "documentation", "issues", "security", "overview", "trajectory"] as const) {
      const t = all[role].text;
      expect(t).toContain("Язык читателя, а не кухня оценки");
      expect(t).toContain("«documentation поднялась с 53,29% до 64,75%»");
      expect(t).toContain("«Документация выросла с 53 до 65 баллов»");
      expect(t).toContain("целыми процентами");
      expect(t).toContain("«якорный файл», «подметрика», «перенормировка»");
      expect(t).not.toContain("—");
      expect(t).not.toMatch(/[ёЁ]/);
    }
    expect(all.trajectory.text).toContain("«Покрытие остается стабильным на уровне 1»");
    expect(all.overview.text).toContain("«отсутствие якорных файлов contributing и\ncodeowners»");
    // the documentation charter no longer teaches the leak itself
    expect(all.documentation.text).not.toContain("якорные файлы есть");
    expect(all.documentation.text).toContain("CONTRIBUTING, CODEOWNERS");
  });
});
