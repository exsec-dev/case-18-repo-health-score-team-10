// An AI review made on a previous scan is marked stale in the MD and PDF report,
// like the "Устарел" label on the card. Behavioral on card data: marked only when a
// newer scan exists.
import { describe, expect, test } from "bun:test";
import type { RepoCard } from "../src/api/repos";
import { buildReportModel, renderRepoReport } from "../src/report/markdown";
import { buildPdfDocument } from "../src/report/pdf";
import { AI_STALE_REPORT_TEXT, aiNotesStale } from "../src/web/format";
import { fixtureCard } from "./report-fixtures";

const withAi = (card: RepoCard, scanId: number, latestScanId: number | null): RepoCard =>
  ({
    ...card,
    ai: {
      scanId,
      audience: "full",
      generatedAt: "2026-09-25T17:32:00Z",
      overview: { role: "overview", text: "В репозитории 196 пометок TODO.", refs: [], charterVersion: "1", model: "yandexgpt/latest", createdAt: "2026-09-25T17:32:00Z" },
      specialists: [],
      failures: [],
      jobActive: false,
      cooldownUntil: null,
      check: { active: false, scanId: null, checkedAt: null, failure: null, retryable: false, latestScanId, oldRules: false },
      fraud: null,
    },
  }) as unknown as RepoCard;

function treeText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) treeText(n, out);
  else if (node !== null && typeof node === "object") for (const v of Object.values(node)) treeText(v, out);
  return out;
}

describe("stale AI review in the report", () => {
  test("condition: stale only when a newer scan exists", () => {
    expect(aiNotesStale({ scanId: 1, check: { latestScanId: 2 } })).toBe(true);
    expect(aiNotesStale({ scanId: 2, check: { latestScanId: 2 } })).toBe(false);
    expect(aiNotesStale({ scanId: 2, check: { latestScanId: null } })).toBe(false);
    expect(aiNotesStale(null)).toBe(false);
  });

  test("MD and PDF carry the stale note right under the AI section title", async () => {
    const { card, close } = fixtureCard("full");
    try {
      const stale = withAi(card, 1, 2);
      const md = renderRepoReport(stale);
      expect(md).toContain(`**Обзор устарел:** ${AI_STALE_REPORT_TEXT}`);
      // the note precedes the AI text itself
      expect(md.indexOf("Обзор устарел:")).toBeLessThan(md.indexOf("196 пометок TODO"));
      const pdf = treeText(buildPdfDocument(buildReportModel(stale)).content).join("");
      expect(pdf).toContain("Обзор устарел:");
      expect(pdf).toContain("цифры в тексте могут не совпадать");
    } finally {
      close();
    }
  });

  test("fresh review (same scan) or unknown latest scan -> no note", () => {
    const { card, close } = fixtureCard("full");
    try {
      for (const c of [withAi(card, 2, 2), withAi(card, 2, null)]) {
        const md = renderRepoReport(c);
        expect(md).toContain("196 пометок TODO"); // the AI section is printed
        expect(md).not.toContain("Обзор устарел");
      }
    } finally {
      close();
    }
  });

  test("UI language rule in the note text", () => {
    expect(AI_STALE_REPORT_TEXT).not.toContain("—");
    expect(AI_STALE_REPORT_TEXT).not.toMatch(/[ёЁ]/);
  });
});
