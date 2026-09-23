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
import { REPORT_NO_SCORE } from "../src/report/build";
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
          // Г1.1 гейта: «баллов в итог» — те же десятые, что в полосе вкладов
          // (наибольший остаток), поэтому строки складываются в показатель РОВНО
          // и «Итого» печатается числом; «≈» остается только у потолка за секреты.
          expect(total).toMatch(new RegExp(`(^|≈ )${hero.value}$`));
          if (!total.includes("≈")) {
            const parts = calc.rows
              .slice(0, -1)
              .map((r) => r.at(-1)!.map((f) => f.text).join(""))
              .filter((v) => v !== "—");
            const sum = parts.reduce((acc, v) => acc + Number(v.replace(",", ".")), 0);
            expect(Math.round(sum * 10) / 10).toBe(hero.value);
          }
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

describe("Д3: без оценки отчета нет, пустое состояние остается на карточке", () => {
  const t: ApiTestDb = makeApiDb();
  afterAll(() => t.close());

  // Решение владельца 22.09 (круг 3 гейта): «Не выдавать отчет, если оценки
  // нет». Прежде документ повторял пустое состояние карточки (Д3), но получить
  // его в продукте было нельзя — кнопки выгрузки у такого репозитория нет.
  // Тексты пустого состояния остались общими с карточкой (`noScoreText`).
  test("скан был, но непригоден для рейтинга (как qipparu/2 #6397): карточка без оценки, отчет не собирается", () => {
    const repoId = seedRepo(t, { org: "d3", repo: "ineligible" });
    const scanId = scoredScan(t, repoId, { status: "partial", facts: cardFacts(), ratingEligible: false });
    const card = getRepoCard(t.db, "d3", "ineligible")!;
    expect({ score: card.score, scan: card.scan?.id }).toEqual({ score: null, scan: scanId });
    expect(() => renderRepoReport(card)).toThrow(REPORT_NO_SCORE);
    const { title, description } = noScoreText(card.scan);
    // ПЕРЕВЕРНУТО С ЗАМЕНОЙ (В4.9 ч.2, А10, Г2.3): без «скана» и «фактов»
    expect(title).toBe("Оценки пока нет");
    expect(description).toBe("Анализ прошел, но данных для оценки не хватило. Это не плохая оценка: при следующем анализе данные соберутся заново.");
    expect(`${title} ${description}`).not.toMatch(/скан|факт/i);
  });

  test("скана не было — отчета тоже нет, карточка говорит «еще не сканировался»", () => {
    seedRepo(t, { org: "d3", repo: "never" });
    const card = getRepoCard(t.db, "d3", "never")!;
    expect(card.scan).toBeNull();
    expect(() => renderRepoReport(card)).toThrow(REPORT_NO_SCORE);
    expect(noScoreText(null).title).toBe("Репозиторий есть в каталоге, но еще не сканировался");
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
      // Г1.7 гейта: причина не в размере репозитория — сервис читает окно истории
      expect(limits).toContain("История коммитов загружена частично: сервис читает только недавнюю историю – с 16 авг. 2025.");
      expect(md).toContain("| Статус анализа | полный |");
    } finally {
      t.close();
    }
  });
});

// Приемка HQ 22.09: в приложении Б `activity.fresh` печатался меткой времени
// в миллисекундах («→ 1789510426000») — поле читателю показывается датой.
describe("приложение Б: метки времени показываются датой", () => {
  for (const name of REPORT_FIXTURES.filter((n) => n !== "never")) {
    test(`${name}: в MD нет 13-значных меток времени`, () => {
      const { card, close } = fixtureCard(name);
      try {
        expect(renderRepoReport(card).match(/\b\d{13}\b/g) ?? []).toEqual([]);
      } finally {
        close();
      }
    });
  }
});
