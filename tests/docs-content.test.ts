// Содержимое раздела /docs (docs/guide): оглавление совпадает с файлами, все
// внутренние ссылки и якоря живые, текст соблюдает правила документации, PDF
// собирается. Падение здесь – ошибка в странице, а не в коде раздела.
import { describe, expect, test } from "bun:test";
import { loadDocs } from "../src/docs/load";
import type { DocBlock, DocLine } from "../src/docs/model";
import { linePlain } from "../src/docs/model";
import { renderDocsPdf } from "../src/docs/pdf";

const { bundle, errors } = loadDocs();

function pageText(blocks: DocBlock[]): string {
  const lines: DocLine[] = [];
  const walk = (bs: DocBlock[]) => {
    for (const b of bs) {
      if (b.kind === "heading" || b.kind === "paragraph") lines.push(b.content);
      else if (b.kind === "list") b.items.forEach(walk);
      else if (b.kind === "table") lines.push(...b.head, ...b.rows.flat());
      else if (b.kind === "note") walk(b.blocks);
      else if (b.kind === "code") lines.push([{ kind: "text", text: b.text }]);
    }
  };
  walk(blocks);
  return lines.map(linePlain).join("\n");
}

describe("документация docs/guide", () => {
  test("разбор без ошибок: оглавление, файлы, ссылки, якоря", () => {
    expect(errors).toEqual([]);
    expect(bundle.pages.length).toBeGreaterThanOrEqual(15);
  });

  test("заголовки страниц не повторяются", () => {
    const titles = bundle.pages.map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("типографика: без «ё» и длинного тире", () => {
    for (const page of bundle.pages) {
      const text = `${page.title}\n${pageText(page.blocks)}`;
      expect({ page: page.slug, yo: /[ёЁ]/.test(text), emDash: text.includes("—") }).toEqual({ page: page.slug, yo: false, emDash: false });
    }
  });

  test("читатель – пользователь сервиса: без хакатона, организаторов, жюри, проверяющих (кроме «Соответствия ТЗ»)", () => {
    const banned = /хакатон|организатор|жюри|проверяющ|конкурс/i;
    for (const page of bundle.pages) {
      if (page.slug === "tz-map") continue;
      // адрес клона репозитория оставлен как есть (согласовано), в код-блоках не ищем
      const text = pageText(page.blocks.filter((b) => b.kind !== "code"));
      const hit = banned.exec(text);
      expect({ page: page.slug, hit: hit?.[0] ?? null }).toEqual({ page: page.slug, hit: null });
    }
  });

  test("PDF собирается из всех страниц", async () => {
    const pdf = await renderDocsPdf(bundle, { date: "28.09.2026", siteUrl: "https://health-craft.ru/docs" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(50_000);
  }, 60_000);
});
