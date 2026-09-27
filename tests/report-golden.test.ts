// MD-отчет фикстурных карточек байт-в-байт равен эталонам
// tests/fixtures/report/*.md: рефакторинг сборки отчета обязан сохранить вывод
// до байта, эталоны меняются только осознанно. `.gitattributes` держит эталоны
// в LF (`tests/fixtures/** -text`): при core.autocrlf=true без него новое
// рабочее дерево получило бы CRLF, и сверка падала бы на ровном месте.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderRepoReport } from "../src/report/markdown";
import { REPORT_FIXTURES, fixtureCard, goldenPath } from "./report-fixtures";

describe("MD-отчёт: эталоны фикстурных карточек", () => {
  for (const name of REPORT_FIXTURES) {
    test(`${name}: вывод равен эталону байт-в-байт`, () => {
      const golden = readFileSync(goldenPath(name), "utf8");
      const { card, close } = fixtureCard(name);
      try {
        expect(golden.includes("\r")).toBe(false);
        expect(renderRepoReport(card)).toBe(golden);
      } finally {
        close();
      }
    });
  }
});
