// Даты отчета — по Москве во всех местах (руководство: «Даты в отчете указаны
// по Москве»). Раньше «Ограничения данных» и сноска карты владельцев печатали
// начало усеченной истории в поясе процесса (в Docker — UTC), а приложение —
// по Москве: момент около полуночи по Москве расходился в одном отчете на сутки.
// Карточка (веб) по-прежнему показывает пояс браузера.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildReportModel } from "../src/report/build";
import { renderRepoReport } from "../src/report/markdown";
import { buildPdfDocument } from "../src/report/pdf";
import { limitationItems, ownershipView } from "../src/report/sections";
import { fmtDateReport } from "../src/web/format";
import type { RepoCard } from "../src/api/repos";
import { fixtureCard } from "./report-fixtures";

// 20 марта 22:30 UTC = 21 марта 01:30 по Москве
const AT = "2026-03-20T22:30:00Z";
const MSK = "21 мар. 2026";
const UTC_DAY = "20 мар. 2026";

const prevTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

/** Карточка `full` с одним и тем же моментом в начале истории, сноске владельцев и последней активности. */
function cardAt(at: string): { card: RepoCard; close: () => void } {
  const { card, close } = fixtureCard("full");
  const c = structuredClone(card);
  c.markers.historyTruncatedSince = at;
  c.repo.lastActivityAt = at;
  (c.score!.categories.code!.submetrics.ownership!.value as Record<string, unknown>).history_since = at;
  return { card: c, close };
}

describe("даты отчета по Москве", () => {
  test("момент около полуночи по Москве — одна дата во всех местах MD", () => {
    const { card, close } = cardAt(AT);
    try {
      const md = renderRepoReport(card);
      expect(md).toContain(`сервис читает только недавнюю историю – с ${MSK}.`);
      expect(md).toContain(`История загружена с ${MSK} – окно короче года.`);
      expect(md).toContain(`история загружена с ${MSK}`);
      expect(md).toContain(`| Последняя активность | ${MSK} |`);
      expect(md).not.toContain(UTC_DAY);
    } finally {
      close();
    }
  });

  test("PDF — те же даты", () => {
    const { card, close } = cardAt(AT);
    try {
      const doc = JSON.stringify(buildPdfDocument(buildReportModel(card))).replace(/​/g, "");
      expect(doc).toContain(MSK);
      expect(doc).not.toContain(UTC_DAY);
    } finally {
      close();
    }
  });

  test("карточка (веб) — пояс браузера, как и было", () => {
    const { card, close } = cardAt(AT);
    try {
      const history = limitationItems(card).find((l) => l.kind === "history");
      expect(history?.text).toContain(UTC_DAY);
      expect(ownershipView(card.score!.categories.code)?.notes.join(" ")).toContain(UTC_DAY);
    } finally {
      close();
    }
  });

  test("fmtDateReport: момент — по Москве, чистая дата — как есть в любом поясе", () => {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Yekaterinburg", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      expect(fmtDateReport(AT)).toBe(MSK);
      expect(fmtDateReport("2025-08-16")).toBe("16 авг. 2025");
    }
    process.env.TZ = "UTC";
    expect(fmtDateReport("2026-13-45")).toBe("2026-13-45");
    expect(fmtDateReport(null)).toBe("–");
  });
});
