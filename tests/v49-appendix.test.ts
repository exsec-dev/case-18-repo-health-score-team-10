// v49-appendix.test.ts — приложение и отчет без оценки (В4.9, блок Б6: К9.4, К9.1, Д3, Д4).
//
// 1. К9.4 (трекер-закон): путь «число → факт» для каждого числа первого
//    экрана и разбора — поведенческий тест на фикстурах: итог, балл каждой
//    категории и каждый показатель разбора имеют строку в приложении Б, точное
//    значение там округляется в показанное, а сумма «баллов в итог» приложения А
//    дает показатель.
// 2. Д3 «как сейчас в UI»: отчет и карточка говорят одно и то же для «скан
//    был, оценки нет» (скан непригоден для рейтинга, как #6397 у `qipparu/2`) и
//    «скана не было» — тест на временной БД; правило выбора скана не менялось.
// 3. Д4: усеченная история — в «Ограничениях данных», статус «полный» ей не противоречит.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { buildReportModel } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import { noScoreText } from "../src/web/format";
import { cardFacts, makeApiDb, seedRepo, type ApiTestDb } from "./api-fixtures";
import { REPORT_FIXTURES, fixtureCard, scoredScan } from "./report-fixtures";

const num = (s: string): number => Number(s.replace("−", "-").replace(",", "."));

describe("К9.4: каждое число отчета прослеживается до поля в приложении", () => {
  for (const name of REPORT_FIXTURES.filter((n) => n !== "never")) {
    test(`${name}: итог, категории и показатели разбора — строками приложения Б; сумма приложения А = показатель`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const model = buildReportModel(card);
        const appendixAt = model.blocks.findIndex((b) => b.kind === "appendix");
        expect(appendixAt).toBeGreaterThan(0);
        const tables = model.blocks.slice(appendixAt).filter((b) => b.kind === "table");
        const sourcesTable = tables.find((b) => b.kind === "table" && b.columns[0]?.title === "Число в отчете");
        expect(sourcesTable).toBeDefined();
        if (sourcesTable?.kind !== "table") return;
        const firstCell = (row: { text: string }[][]) => row[0]!.map((f) => f.text).join("");
        const rows = sourcesTable.rows.map((r) => ({ label: firstCell(r), field: r[2]!.map((f) => f.text).join("") }));

        // баллы категорий первого экрана → строки «Категория N» с точным значением поля
        const cats = model.blocks.find((b) => b.kind === "categories");
        if (cats?.kind !== "categories") throw new Error("нет строк категорий");
        for (const row of cats.rows.filter((r) => r.score !== null)) {
          const src = rows.find((r) => r.label === `${row.name} ${row.scoreText}`);
          expect({ category: row.name, traced: src !== undefined }).toEqual({ category: row.name, traced: true });
          const exact = num(src!.field.split("→")[1]!.trim());
          expect(Math.round(exact)).toBe(Number(row.scoreText));
        }
        // каждый показатель разбора → строка «Название: значение»
        for (const detail of model.blocks.filter((b) => b.kind === "detail")) {
          if (detail.kind !== "detail" || !detail.table) continue;
          for (const r of detail.table.rows) {
            const title = r[0]!.map((f) => f.text).join("");
            expect({ sub: title, traced: rows.some((x) => x.label.startsWith(`${title}: `)) }).toEqual({ sub: title, traced: true });
          }
        }
        // крупный показатель: строка Б и сумма приложения А
        const hero = model.blocks.find((b) => b.kind === "hero");
        if (hero?.kind === "hero" && hero.value !== null) {
          expect(rows.some((r) => r.label === `${hero.label} ${hero.value}`)).toBe(true);
          const calc = tables.find((b) => b.kind === "table" && b.columns[0]?.title === "Категория");
          if (calc?.kind !== "table") throw new Error("нет таблицы А");
          const total = calc.rows.at(-1)!.at(-1)!.map((f) => f.text).join("");
          expect(total).toMatch(new RegExp(` ≈ ${hero.value}$`));
          const sum = calc.rows.slice(0, -1).reduce((s, r) => s + (r[3]![0]!.text === "—" ? 0 : num(r[3]![0]!.text)), 0);
          expect(Math.abs(sum - num(total.split(" ≈ ")[0]!))).toBeLessThan(0.35);
        }
      } finally {
        close();
      }
    });
  }

  test("в приложении нет JSON: значения фактов — «поле – значение», длинные списки — счетчиком", () => {
    const { card, close } = fixtureCard("full");
    try {
      const appendix = renderRepoReport(card).split("## Приложение")[1]!;
      expect(appendix).not.toMatch(/\{"|":\s*[\[{"\d]/);
      expect(appendix).toContain("| severity_counts.critical | 1 |");
      expect(appendix).toContain("| events | 6 |");
    } finally {
      close();
    }
  });
});

describe("Д3: отчет повторяет пустое состояние карточки", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  test("скан был, но непригоден для рейтинга (как qipparu/2 #6397): карточка без оценки, отчет — «Скан был – данных не хватило»", () => {
    const repoId = seedRepo(t, { org: "d3", repo: "ineligible" });
    // скан с оценкой, но непригодный: у публичного репо правило К-Ф1.1 его не берет
    const scanId = scoredScan(t, repoId, { status: "partial", facts: cardFacts(), ratingEligible: false });
    const card = getRepoCard(t.db, "d3", "ineligible")!;
    expect({ score: card.score, scan: card.scan?.id }).toEqual({ score: null, scan: scanId });
    const md = renderRepoReport(card);
    const { title, description } = noScoreText(card.scan);
    expect(title).toBe("Скан был – данных для оценки не хватило");
    expect(md).toContain(`${title}.`);
    expect(md).toContain(description);
    expect(md).toContain("отсутствие данных, а не плохая оценка");
    expect(md).toContain("Следующий анализ соберет факты заново.");
    // без покрытия, баллов и «Как считается»; не «еще не сканировался»
    for (const absent of ["еще не сканировался", "## Категории", "Собрано", "## Как считается", "улучшать нечего"]) expect(md).not.toContain(absent);
  });

  test("скана не было — «еще не сканировался», как на карточке", () => {
    seedRepo(t, { org: "d3", repo: "never" });
    const card = getRepoCard(t.db, "d3", "never")!;
    expect(card.scan).toBeNull();
    const md = renderRepoReport(card);
    expect(md).toContain(`${noScoreText(null).title}.`);
    expect(md).toContain(noScoreText(null).description);
    expect(md).not.toContain("Скан был");
  });

  test("карточка берет те же тексты (одна функция `noScoreText`)", () => {
    const page = readFileSync(join(import.meta.dir, "..", "src", "web", "RepoPage.tsx"), "utf8");
    expect(page).toContain("title={noScoreText(card.scan).title}");
    expect(page).toContain("description={noScoreText(card.scan).description}");
    expect(page).not.toContain('"Скан был – данных для оценки не хватило"');
  });
});

describe("Д4: усеченная история — ограничение данных, статус «полный» ей не противоречит", () => {
  test("полный скан с усеченной историей: в «Ограничениях данных» — дата начала истории", () => {
    const t = makeApiDb();
    try {
      const repoId = seedRepo(t, { org: "d4", repo: "big" });
      scoredScan(t, repoId, { status: "ok", facts: cardFacts() });
      const md = renderRepoReport(getRepoCard(t.db, "d4", "big")!);
      const limits = md.slice(md.indexOf("## Ограничения данных"), md.indexOf("## Разбор"));
      expect(limits).toContain("История коммитов загружена частично: для крупных репозиториев загружается только недавняя история – с 16 авг. 2025.");
      expect(md).toContain("| Статус анализа | полный |");
    } finally {
      t.close();
    }
  });
});
