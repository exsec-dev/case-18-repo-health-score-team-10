// report-pdf.test.ts — PDF-выгрузка отчёта (В4.7, контракт П1, блок Б4).
//
// 1. Содержание PDF = содержание MD. Текст собирается из описания документа
//    pdfmake ДО рендера и сравнивается с текстом эталонного MD фикстурных
//    карточек, из которого разметка снята ТЕСТОВЫМ хелпером (разбор MD в
//    тесте разрешён законом вехи; в продуктовом коде его нет). Тавтологию
//    «модель против модели» закрывают эталоны: они сняты в Б0 до модели.
// 2. Глифы: каждый символ строковых литералов генератора (src/report,
//    тексты правил src/score/recommend.ts, словари src/web/format.ts) и
//    эталонных MD есть в cmap всех четырёх начертаний Inter. Таблица cmap
//    читается здесь же, без зависимостей.
// 3. Политики pdfmake закрыты: URL — никогда, диск — только каталог шрифта.
// 4. Сбойный путь — честная 500 JSON без стека; неизвестный глиф во внешних
//    данных генерацию не роняет.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pdfmake from "pdfmake";
import { buildReportModel } from "../src/report/markdown";
import { BREAK, FONT_DIR, FONT_FILES, MAX_UNBROKEN, PDF_FAILED_MESSAGE, breakable, buildPdfDocument, pdfResponse, renderRepoPdf } from "../src/report/pdf";
import { REPORT_FIXTURES, fixtureCard, goldenPath } from "./report-fixtures";

const ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// тестовые хелперы: текст MD без разметки и текст описания pdfmake
// ---------------------------------------------------------------------------

/** Инлайн-разметка MD → текст: бэкслеш-эскейпы, `код`, **полужирный**, сущности. */
function mdInlineText(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length) {
      out += src[++i];
    } else if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      out += src.slice(i + 1, end);
      i = end;
    } else if (ch === "*" && src[i + 1] === "*") {
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Документ MD → поток текста: заголовки, абзацы, пункты, ячейки таблиц; строка выравнивания таблицы выброшена. */
function mdText(md: string): string {
  const parts: string[] = [];
  for (const raw of md.split("\n")) {
    if (raw === "" || /^\|(-{3}:?\|)+$/.test(raw)) continue;
    let line = raw.replace(/^#{1,3} /, "").replace(/^- /, "");
    if (line.startsWith("| ") && line.endsWith(" |")) {
      // ячейки делит неэкранированная черта; экранированная `\|` — часть значения
      const cells = line.slice(2, -2).split(/(?<!\\) \| /);
      parts.push(...cells.map(mdInlineText));
      continue;
    }
    // строка-курсив целиком (заголовок репозитория): `_..._`
    if (/^_.*_$/.test(line) && !line.endsWith("\\_")) line = line.slice(1, -1);
    parts.push(mdInlineText(line));
  }
  return normalize(parts.join(" "));
}

// U+200B — точка переноса вёрстки (breakable), не содержание: в сверку не идёт
const normalize = (s: string): string => s.replace(/​/g, "").replace(/\s+/g, " ").trim();

/**
 * Текст описания pdfmake: каждый блок, пункт списка и ячейка таблицы —
 * отдельная часть; фрагменты одной строки склеиваются без разделителя, как в
 * MD. Колонтитул — оформление, не содержание: в сверку не идёт.
 */
function pdfBlocksText(doc: Record<string, unknown>): string {
  const parts: string[] = [];
  const textOf = (value: unknown): string =>
    typeof value === "string" ? value : Array.isArray(value) ? value.map(textOf).join("") : value && typeof value === "object" ? textOf((value as { text?: unknown }).text ?? "") : "";
  for (const node of doc.content as Record<string, unknown>[]) {
    if ("text" in node) parts.push(textOf(node.text));
    if ("ul" in node) parts.push(...(node.ul as unknown[]).map(textOf));
    if ("table" in node) for (const row of (node.table as { body: unknown[][] }).body) parts.push(...row.map(textOf));
  }
  return normalize(parts.join(" "));
}

// ---------------------------------------------------------------------------
// cmap TrueType: формат 4 (BMP) и 12 (полный Unicode)
// ---------------------------------------------------------------------------

function cmapCodepoints(file: string): Set<number> {
  const buf = readFileSync(file);
  const u16 = (o: number) => buf.readUInt16BE(o);
  const u32 = (o: number) => buf.readUInt32BE(o);
  const numTables = u16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "cmap") cmap = u32(rec + 8);
  }
  if (cmap < 0) throw new Error(`${file}: нет таблицы cmap`);
  const out = new Set<number>();
  const subtables = u16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const platform = u16(cmap + 4 + i * 8);
    const encoding = u16(cmap + 6 + i * 8);
    if (platform !== 3 && platform !== 0) continue;
    const off = cmap + u32(cmap + 8 + i * 8);
    const format = u16(off);
    if (format === 4 && (platform === 0 || encoding === 1)) {
      const segX2 = u16(off + 6);
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + s * 2);
        const start = u16(starts + s * 2);
        const delta = u16(deltas + s * 2);
        const rangeOffset = u16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            const g = u16(ranges + s * 2 + rangeOffset + (c - start) * 2);
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = u32(off + 12);
      for (let g = 0; g < groups; g++) {
        const start = u32(off + 16 + g * 12);
        const end = u32(off + 20 + g * 12);
        const glyph = u32(off + 24 + g * 12);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
      }
    }
  }
  return out;
}

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Символы строковых литералов файла (комментарии не печатаются — они не в счёт). */
function literalChars(file: string): Set<string> {
  const src = stripComments(readFileSync(file, "utf8"));
  const chars = new Set<string>();
  for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    for (const ch of m[0].slice(1, -1)) if (ch.codePointAt(0)! >= 0x20) chars.add(ch);
  }
  return chars;
}

// ---------------------------------------------------------------------------

describe("П1: содержание PDF равно содержанию MD", () => {
  for (const name of REPORT_FIXTURES) {
    test(`${name}: текст описания pdfmake = текст эталонного MD без разметки`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const doc = buildPdfDocument(buildReportModel(card));
        expect(pdfBlocksText(doc)).toBe(mdText(readFileSync(goldenPath(name), "utf8")));
      } finally {
        close();
      }
    });
  }

  test("карточка без прав: закрытые каналы в PDF не раскрываются (ни чисел, ни фактов, ни правил)", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const text = pdfBlocksText(buildPdfDocument(buildReportModel(card)));
      for (const leak of ["cicd.runs", "cicd.configs", "appsec.findings", "grant-ci-runs", "pass_rate", "has_ci_yaml"]) expect(text).not.toContain(leak);
      expect(text).toContain("CI/CD – Недоступно");
    } finally {
      close();
    }
  });

  test("разметка MD в PDF — стилем, а не символами: код, курсив, полужирный", () => {
    const { card, close } = fixtureCard("grant-ci");
    try {
      const doc = buildPdfDocument(buildReportModel(card));
      const json = JSON.stringify(doc.content);
      expect(json).toContain('{"text":"grant-ci-runs","style":"code"}');
      expect(json).toContain('{"text":"CI [config] `only` | pipes","italics":true}');
      expect(json).toMatch(/\{"text":"HealthCraft Index \(4 категории\): 55 из 100 – требует внимания","bold":true\}/);
      expect(json).not.toContain("**");
      expect(json).not.toContain("\\\\[");
    } finally {
      close();
    }
  });
});

describe("П1 (приёмка HQ): ячейки таблиц переносятся и не вылезают за поле", () => {
  // Дефект приёмки HQ 21.09: JSON фактов без пробелов не переносился, и колонка
  // «Значение» «Доказательной базы» уходила за правый край — PDF терял
  // содержание, которое MD показывает целиком. Сверка текста его не ловила:
  // она читает описание ДО вёрстки.
  const longestUnbroken = (s: string): number => Math.max(0, ...s.split(new RegExp(`[\\s${BREAK}]+`)).map((w) => w.length));

  test("breakable: точки переноса после знаков структуры и внутри длинных слов, текст не меняется", () => {
    const json = '{"commits":2,"authors":2,"first":"2025-08-16T10:00:00Z","path":".sourcecraft/ci.yaml"}';
    const out = breakable(json);
    expect(out.replaceAll(BREAK, "")).toBe(json);
    expect(longestUnbroken(out)).toBeLessThanOrEqual(MAX_UNBROKEN);
    expect(breakable("x".repeat(100)).replaceAll(BREAK, "")).toBe("x".repeat(100));
    expect(longestUnbroken(breakable("x".repeat(100)))).toBeLessThanOrEqual(MAX_UNBROKEN);
    // короткие значения не трогаются: текстовый слой PDF без лишних пробелов
    for (const short of ["12:00", "CI/CD", "rest:cicd", "TODO/FIXME", "2026-09-16 12:00"]) expect(breakable(short)).toBe(short);
  });

  test.each([...REPORT_FIXTURES])("фикстура %s: ни в одной ячейке нет неразрывного куска длиннее порога", (name) => {
    const { card, close } = fixtureCard(name);
    try {
      const doc = buildPdfDocument(buildReportModel(card)) as { content: Record<string, unknown>[] };
      const textOf = (v: unknown): string =>
        typeof v === "string" ? v : Array.isArray(v) ? v.map(textOf).join("") : v && typeof v === "object" ? textOf((v as { text?: unknown }).text ?? "") : "";
      let cells = 0;
      for (const node of doc.content) {
        if (!("table" in node)) continue;
        for (const row of (node.table as { body: unknown[][] }).body.slice(1)) {
          for (const cell of row) {
            cells++;
            expect(longestUnbroken(textOf(cell))).toBeLessThanOrEqual(MAX_UNBROKEN);
          }
        }
      }
      // у never (скана нет) таблиц нет вовсе; у остальных — есть
      if (name !== "never") expect(cells).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});

describe("П1: шрифт Inter покрывает все символы генератора", () => {
  const fontCmaps = Object.values(FONT_FILES).map((f) => ({ file: f, cps: cmapCodepoints(join(FONT_DIR, f)) }));

  test("каталог шрифта — четыре начертания Inter и лицензия OFL", () => {
    expect(readdirSync(FONT_DIR).sort()).toEqual(["Inter-Italic.ttf", "Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-SemiBoldItalic.ttf", "LICENSE.txt"]);
    expect(readFileSync(join(FONT_DIR, "LICENSE.txt"), "utf8")).toContain("SIL Open Font License");
  });

  test("литералы src/report, recommend.ts, format.ts и эталонные MD рисуются всеми начертаниями", () => {
    const sources = [
      ...readdirSync(join(ROOT, "src", "report"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(ROOT, "src", "report", f)),
      join(ROOT, "src", "score", "recommend.ts"),
      join(ROOT, "src", "web", "format.ts"),
    ];
    const chars = new Set<string>();
    for (const file of sources) for (const ch of literalChars(file)) chars.add(ch);
    for (const name of REPORT_FIXTURES) for (const ch of readFileSync(goldenPath(name), "utf8")) if (ch !== "\n") chars.add(ch);
    // факт 21.09: кириллица и `→ ≤ … § « » – —` — они обязаны быть в наборе
    for (const must of ["→", "≤", "…", "§", "«", "»", "–", "—", "Д", "ю"]) expect(chars.has(must)).toBe(true);
    const missing = fontCmaps.map(({ file, cps }) => ({ file, missing: [...chars].filter((ch) => !cps.has(ch.codePointAt(0)!)) }));
    expect(missing).toEqual(fontCmaps.map(({ file }) => ({ file, missing: [] })));
  });
});

describe("П1: рендер, политики и сбойный путь", () => {
  test("рендер фикстуры с «→» — настоящий PDF за доли секунды", async () => {
    const { card, close } = fixtureCard("grant-ci");
    try {
      const started = performance.now();
      const pdf = await renderRepoPdf(card);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      close();
    }
  });

  test("неизвестный глиф во внешних данных (эмодзи, иероглифы в названии и языке) не роняет генерацию", async () => {
    const { card, close } = fixtureCard("anon");
    try {
      card.repo.title = "Проект 🚀 漢字 ✓";
      card.repo.language = "Язык ☃";
      const pdf = await renderRepoPdf(card);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      close();
    }
  });

  test("политика URL: pdfmake не ходит в сеть ни по какой ссылке из описания документа", async () => {
    // ссылка на ресурс живёт в словаре `images`: его pdfmake разрешает через URLResolver
    const attempt = pdfmake.createPdf({ images: { pixel: "https://example.invalid/pixel.png" }, content: [{ image: "pixel" }], defaultStyle: { font: "Inter" } }).getBuffer();
    await expect(attempt).rejects.toThrow(/Access to URL denied/);
  });

  test("политика диска: файл вне каталога шрифта не читается", async () => {
    const attempt = pdfmake.createPdf({ content: [{ image: join(ROOT, "package.json") }], defaultStyle: { font: "Inter" } }).getBuffer();
    await expect(attempt).rejects.toThrow(/Access to local file denied/);
  });

  test("успешный ответ: application/pdf и attachment с именем от слага", async () => {
    const { card, close } = fixtureCard("full");
    try {
      const res = await pdfResponse(card);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="m47-full-health.pdf"');
      expect(new Uint8Array(await res.arrayBuffer()).length).toBeGreaterThan(1000);
    } finally {
      close();
    }
  });

  test("сбой генерации — честная 500 JSON без стека, а не пустой или битый файл", async () => {
    const { card, close } = fixtureCard("full");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const res = await pdfResponse(card, async () => {
        throw new Error("boom at /secret/path/stack");
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: { code: "pdf_failed", message: PDF_FAILED_MESSAGE } });
      expect(body).not.toContain("boom");
      expect(body).not.toContain("at ");
      expect(errors.length).toBe(1);
    } finally {
      console.error = original;
      close();
    }
  });

  test("фронтенд не импортирует ни pdfmake, ни серверный отчёт (в бандл UI библиотека не попадает)", () => {
    const webDir = join(ROOT, "src", "web");
    for (const file of readdirSync(webDir).filter((f) => /\.tsx?$/.test(f))) {
      const src = readFileSync(join(webDir, file), "utf8");
      expect({ file, pdfmake: /from "pdfmake"/.test(src), report: /from "\.\.\/report\/(pdf|markdown)"/.test(src) }).toEqual({ file, pdfmake: false, report: false });
    }
  });
});
