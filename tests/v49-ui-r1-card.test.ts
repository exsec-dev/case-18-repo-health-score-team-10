// Страница репозитория = отчет по данным. Поведенческие тесты на данных, а не
// на исходнике: view-модель карточки `cardView`
// сравнивается с моделью документа `buildReportModel` на фикстурах отчета
// (`REPORT_FIXTURES`, включая `full-null`). Плюс путь к полной оценке по трем
// типам зрителя, цвет категории по ключу, видимость, шаги кабинета.
import { afterAll, describe, expect, test } from "bun:test";
import type { RepoCard } from "../src/api/repos";
import { buildReportModel } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import type { Block, Inline } from "../src/report/model";
import { CATEGORY_TITLES } from "../src/report/categories";
import { CATEGORY_COLOR, SOURCE_DATA_LABEL, cardView, categoryColorClass, lockedView, recommendationLabel, visibilityPill } from "../src/web/cardView";
import { ACCESS_LOCK_SHORT, ACCESS_LOCK_TEXT, NOT_IN_SCORE, fullScorePath, pathText } from "../src/web/format";
import { REPORT_FIXTURES, fixtureCard, type FixtureCard } from "./report-fixtures";

const opened: FixtureCard[] = [];
afterAll(() => opened.forEach((f) => f.close()));
function card(name: (typeof REPORT_FIXTURES)[number]): RepoCard {
  const f = fixtureCard(name);
  opened.push(f);
  return f.card;
}

const lineText = (line: Inline[]): string => line.map((i) => i.text).join("");
const blocksOf = <K extends Block["kind"]>(blocks: Block[], kind: K): Extract<Block, { kind: K }>[] => blocks.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind);

/** Абзацы раздела «Ограничения данных» документа (заголовок h2 и примечания под ним). */
function reportLimitations(blocks: Block[]): string[] {
  const at = blocks.findIndex((b) => b.kind === "heading" && lineText(b.content) === "Ограничения данных");
  if (at < 0) return [];
  const out: string[] = [];
  for (const b of blocks.slice(at + 1)) {
    if (b.kind !== "paragraph" || b.tone !== "note") break;
    out.push(b.lines.map(lineText).join(" "));
  }
  return out;
}

describe("инвариант 1: карточка = отчет по данным (REPORT_FIXTURES)", () => {
  for (const name of REPORT_FIXTURES) {
    test(`${name}: вклады, основания, ограничения, путь к полной оценке, рекомендации — те же, что в документе`, () => {
      const c = card(name);
      const model = buildReportModel(c);
      const view = cardView(c);

      // полосы вклада – те же заголовки, сегменты, остаток и строка вместо полосы
      const bars = blocksOf(model.blocks, "contributions");
      expect(view.contributions.map(({ title, segments, rest, note }) => ({ title, segments: segments.map(({ title, value, share }) => ({ title, value, share })), rest, note }))).toEqual(
        // на карточке вклад без «+» – то же число, что подпись сегмента в документе
        bars.map(({ title, segments, rest, note }) => ({ title, segments: segments.map((s) => ({ ...s, value: s.value.replace(/^\+/, "") })), rest, note })),
      );
      // цвет сегмента — по ключу категории (один на карточке и в панели рейтинга)
      for (const bar of view.contributions) for (const s of bar.segments) expect(s.colorClass).toBe(`rh-cat-color_${s.key}`);

      // строки категорий – основание, балл и плашка как в колонках PDF
      const rows = blocksOf(model.blocks, "categories")[0]!.rows;
      for (const cat of view.categories) {
        const row = rows.find((r) => r.name === cat.title)!;
        expect({ key: cat.key, why: cat.why, scoreText: cat.scoreText, chip: cat.chip }).toEqual({ key: cat.key, why: row.why, scoreText: row.scoreText, chip: row.chip });
      }
      // закрытые — не строками карточки, но в документе их строки есть; вместе — все категории
      const locked = Object.entries(c.score!.categories).filter(([, v]) => v.locked !== undefined);
      expect(view.categories.length + locked.length).toBe(rows.length);

      // «Ограничения данных» – тем же текстом, что PDF
      expect(view.limitations).toEqual(reportLimitations(model.blocks));

      // путь к полной оценке – та же строка, что в документе
      const hero = blocksOf(model.blocks, "hero")[0]!;
      const notes = hero.notes.map((n) => lineText(n.line)).join(" ");
      if (view.fullPath) expect(notes).toContain(pathText(view.fullPath));
      else expect(c.score!.fullLocked).toBe(false);

      // номер, эффект и подпись эффекта – как в документе
      const actions = blocksOf(model.blocks, "actions").flatMap((a) => a.items);
      expect(view.recommendations.map(({ n, effect, effectNote }) => ({ n, effect, effectNote }))).toEqual(actions.map(({ n, effect, effectNote }) => ({ n, effect, effectNote })));

      // «анализ» в шапке – та же дата, что в шапке документа
      expect(view.analysisAt).toBe(c.score?.computedAt ?? c.scan?.finishedAt ?? null);
    });
  }
});

describe("tri-state и доступ на карточке (инварианты 2, 3)", () => {
  test("категория без данных — «—» и «Нет данных», причина с опорной фразой, не 0", () => {
    for (const name of REPORT_FIXTURES) {
      for (const cat of cardView(card(name)).categories.filter((x) => x.score === null)) {
        expect({ scoreText: cat.scoreText, chip: cat.chip }).toEqual({ scoreText: "—", chip: { theme: "unknown", text: "Нет данных" } });
        expect(cat.why.endsWith(NOT_IN_SCORE)).toBe(true);
      }
    }
  });

  test("закрытые зрителю каналы: ни строк, ни сегментов, ни чисел CI/CD и Безопасности", () => {
    const view = cardView(card("anon"));
    expect(view.categories.map((c) => c.key)).not.toContain("cicd");
    expect(view.categories.map((c) => c.key)).not.toContain("security");
    for (const bar of view.contributions) for (const s of bar.segments) expect(["cicd", "security"]).not.toContain(s.key);
    // одно предложение без заголовка, путь по типу зрителя
    expect(view.locked).toEqual({ text: "CI/CD и Безопасность видны участникам репозитория после входа и добавления персонального токена доступа." });
  });

  test("Т3: вошедшему без токена — путь без «входа»", () => {
    const base = card("anon");
    const c: RepoCard = { ...base, viewer: { own: false, auth: "no-pat" } };
    expect(lockedView(c)).toEqual({ text: "CI/CD и Безопасность видны участникам репозитория после добавления персонального токена доступа." });
  });

  test("одна закрытая категория у зрителя с токеном — единственное число и причина отказа", () => {
    const c = card("grant-ci");
    // сначала «только участникам», затем причина; «к ней» согласовано с одной категорией
    expect(lockedView(c)).toEqual({ text: "Безопасность видна только участникам репозитория, а у вашего токена к ней нет доступа." });
  });

  test("разные причины двух категорий у зрителя с токеном — по предложению на категорию", () => {
    const base = card("anon");
    const cats = { ...base.score!.categories, cicd: { ...base.score!.categories.cicd, locked: "pat-expired" as const }, security: { ...base.score!.categories.security, locked: "denied" as const } };
    const mixed: RepoCard = { ...base, viewer: { own: false, auth: "pat" }, score: { ...base.score!, categories: cats } };
    expect(lockedView(mixed)!.text).toBe(
      "CI/CD видна только участникам репозитория. SourceCraft отклонил ваш токен – обновите его в Настройках. Безопасность видна только участникам репозитория, а у вашего токена к ней нет доступа.",
    );
  });

  test("полный доступ: плашки закрытых нет, полоса Repo Health Score с 6 категориями и новыми тонами", () => {
    const view = cardView(card("full"));
    expect(view.locked).toBeNull();
    expect(view.fullPath).toBeNull();
    const full = view.contributions.find((b) => b.title === "Вклад категорий в Repo Health Score")!;
    const keys = full.segments.map((s) => s.key);
    expect(keys).toContain("cicd");
    expect(keys).toContain("security");
  });
});

describe("путь к полной оценке по 3 типам зрителя (А2, Е2): карточка и MD — одна строка", () => {
  test("не вошел: «Войдите…», слово «Настройках» — ссылка, под строкой кнопка входа", () => {
    const c = card("anon");
    const view = cardView(c);
    expect(view.signIn).toBe(true);
    expect(pathText(view.fullPath!)).toBe("Войдите через Я ID и добавьте персональный токен доступа в Настройках.");
    expect(view.fullPath!.filter((p) => p.settings).map((p) => p.text)).toEqual(["Настройках"]);
    expect(renderRepoReport(c)).toContain(pathText(view.fullPath!));
  });

  test("вошел без токена: без «войдите» и без хвоста про CI/CD (Е5); кнопки входа нет", () => {
    const anon = card("anon");
    const c: RepoCard = { ...anon, viewer: { own: false, auth: "no-pat" } };
    const view = cardView(c);
    expect(view.signIn).toBe(false);
    expect(pathText(view.fullPath!)).toBe("Добавьте персональный токен доступа в Настройках.");
    expect(pathText(view.fullPath!)).not.toMatch(/войдите/i);
    const md = renderRepoReport(c);
    expect(md).toContain(pathText(view.fullPath!));
    expect(md).not.toMatch(/войдите/i);
    // строка закрытой категории в документе — той же строкой пути (одна копия)
    expect(ACCESS_LOCK_TEXT["no-pat"]).toBe(`Данные видны участникам репозитория. ${pathText(fullScorePath("no-pat", ["no-pat"]))}`);
  });

  test("токен есть, прав нет: причина без призыва, ссылки нет", () => {
    const c = card("grant-ci");
    const view = cardView(c);
    expect(view.signIn).toBe(false);
    expect(view.fullPath).toEqual([{ text: ACCESS_LOCK_SHORT.denied }]);
    expect(renderRepoReport(c)).toContain(`видна участникам репозитория. ${ACCESS_LOCK_SHORT.denied}`);
  });

  test("первый закрытый канал решает: CI, затем Безопасность; истекший токен — его причина", () => {
    expect(fullScorePath("pat", ["granted", "check-failed"])).toEqual([{ text: ACCESS_LOCK_SHORT["check-failed"] }]);
    expect(fullScorePath("pat", ["pat-expired", "denied"])).toEqual([{ text: ACCESS_LOCK_SHORT["pat-expired"] }]);
    expect(pathText(fullScorePath(undefined, ["no-pat", "no-pat"]))).toMatch(/^Войдите через Я ID/);
  });
});

describe("рекомендации: основание словами (А5)", () => {
  test("правило с записью — «подметрика – значение»; без записи — «Исходные данные»", () => {
    const c = card("grant-ci");
    const labels = new Map(c.recommendations.map((r) => [r.ruleId, recommendationLabel(c, r)]));
    const license = c.recommendations.find((r) => r.ruleId === "license-missing");
    if (license) expect(labels.get("license-missing")).toBe("Лицензия – нет");
    for (const label of labels.values()) expect(label === SOURCE_DATA_LABEL || /^.+ – .+$/.test(label)).toBe(true);
    const unknown = { ...c.recommendations[0]!, ruleId: "code-empty" };
    expect(recommendationLabel(c, unknown)).toBe(SOURCE_DATA_LABEL);
  });

  test("номера — порядок выдачи движка, 1..N", () => {
    const view = cardView(card("full"));
    expect(view.recommendations.map((r) => r.n)).toEqual(view.recommendations.map((_, i) => i + 1));
  });
});

describe("предупреждения наверху не повторяют «Ограничения данных» (А6)", () => {
  test("данные прошлого анализа, лимит и усеченная история — только внизу; нет кода и потолок CI — наверху", () => {
    const base = card("anon");
    const c: RepoCard = {
      ...base,
      markers: {
        ...base.markers,
        staleFacts: true,
        codeEmpty: true,
        ciConfigOnlyCap: true,
        gitLimits: { cloneMaxBytes: 1, cloneTimeoutMs: 1, degradeEnabled: false, degradeSinceMonths: 0, degradeMaxBytes: 0, degradeTimeoutMs: 0 },
      },
    };
    const view = cardView(c);
    // «нет кода» сказано в плашке индекса, сверху не повторяется
    expect(view.topMarkers).toEqual(["ci-cap"]);
    expect(view.limitations.some((l) => l.startsWith("Часть данных взята из прошлого анализа"))).toBe(true);
    expect(view.limitations.some((l) => l.startsWith("Репозиторий больше лимита сервиса"))).toBe(true);
  });
});

describe("цвет категории — по ключу (А3)", () => {
  test("6 категорий — 6 разных классов; неизвестный ключ — нейтральный", () => {
    const classes = Object.keys(CATEGORY_TITLES).map(categoryColorClass);
    expect(new Set(classes).size).toBe(6);
    expect(classes).toEqual(Object.values(CATEGORY_COLOR));
    expect(categoryColorClass("popularity")).toBe("rh-cat-color_none");
  });
});

describe("плашка видимости (А7, В2): все значения SourceCraft и явное «неизвестно»", () => {
  test("public / internal / private — своя плашка; unknown и мусор — без плашки", () => {
    expect(visibilityPill("public")?.text).toBe("Публичный");
    expect(visibilityPill("internal")?.text).toBe("Внутренний");
    expect(visibilityPill("private")?.text).toBe("Приватный");
    expect(visibilityPill("unknown")).toBeNull();
    expect(visibilityPill(null)).toBeNull();
    expect(visibilityPill("friends")).toBeNull();
  });

  test("карточка берет видимость из поля ответа", () => {
    expect(cardView(card("anon")).visibility).toBe("public");
  });
});
