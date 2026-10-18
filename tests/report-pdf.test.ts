// PDF-выгрузка отчета.
//
// 1. Содержание PDF = содержание MD (обход всего дерева описания pdfmake —
//    стеки, колонки, таблицы, списки; canvas текста не несет).
//    Сравниваются слова и числа по порядку: MD печатает первый экран строкой
//    `**70 из 100 · здоров**`, PDF — числом и плашкой «Здоров»; разметка,
//    регистр и знаки препинания в сверку не идут, слова — идут. MD фикстур
//    закреплен эталонами (report-golden.test.ts), поэтому сверка PDF с MD
//    той же карточки — сверка с эталоном.
// 2. Глифы: каждый символ строковых литералов генератора (src/report,
//    тексты правил src/score/recommend.ts, словари src/web/format.ts),
//    эталонных MD и синтетической строки обязательных символов есть в cmap
//    всех четырёх начертаний Inter. Таблица cmap читается здесь же.
// 3. Политики pdfmake закрыты: URL — никогда, диск — только каталог шрифта.
// 4. Сбойный путь — честная 500 JSON без стека; неизвестный глиф во внешних
//    данных генерацию не роняет.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pdfmake from "pdfmake";
import { buildReportModel, renderRepoReport } from "../src/report/markdown";
import { BREAK, COLORS, FONT_DIR, FONT_FILES, MAX_UNBROKEN, PDF_FAILED_MESSAGE, breakable, buildPdfDocument, pdfResponse, renderRepoPdf } from "../src/report/pdf";
import { REPORT_FIXTURES, fixtureCard, goldenPath } from "./report-fixtures";

const ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// тестовые хелперы: слова MD без разметки и слова всего дерева pdfmake
// ---------------------------------------------------------------------------

/** Слова и числа по порядку: буквы и цифры, без регистра; разметка и пунктуация не в счет. */
export function words(text: string): string[] {
  return (text.replace(/​/g, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** MD → слова: адреса ссылок `](url)` и HTML-сущности — не текст читателя. */
export function mdWords(md: string): string[] {
  return words(md.replace(/\]\([^)]*\)/g, "]").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

/** Все строки `text` дерева описания pdfmake — по порядку документа. */
export function pdfTreeText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) pdfTreeText(n, out);
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("text" in o) pdfTreeText(o.text, out);
    for (const key of ["stack", "columns", "ul", "ol"]) if (key in o) pdfTreeText(o[key], out);
    if ("table" in o) pdfTreeText((o.table as { body: unknown }).body, out);
  }
  return out;
}

const pdfWords = (doc: Record<string, unknown>): string[] => words(pdfTreeText(doc.content).join(" "));

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

describe("П1: содержание PDF равно содержанию MD", () => {
  for (const name of REPORT_FIXTURES) {
    test(`${name}: слова всего дерева pdfmake = слова MD (эталон) по порядку`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const md = renderRepoReport(card);
        expect(md).toBe(readFileSync(goldenPath(name), "utf8"));
        const doc = buildPdfDocument(buildReportModel(card));
        expect(pdfWords(doc)).toEqual(mdWords(md));
      } finally {
        close();
      }
    });
  }

  test("обход дерева видит вложенные узлы: подписи полосы, плашки, строки категорий, карточки действий", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const text = pdfTreeText(buildPdfDocument(buildReportModel(card)).content).join(" ");
      for (const s of ["Вклад категорий в", "не набрано", "здоров 70-100", "Требует внимания", "Видна участникам репозитория.", "Ожидаемый эффект"]) expect(text).toContain(s);
    } finally {
      close();
    }
  });

  test("карточка без прав: закрытые каналы в PDF не раскрываются (ни чисел, ни фактов, ни правил)", () => {
    const { card, close } = fixtureCard("anon");
    try {
      const text = pdfTreeText(buildPdfDocument(buildReportModel(card)).content).join(" ");
      for (const leak of ["cicd.runs", "cicd.configs", "appsec.findings", "grant-ci-runs", "pass_rate", "has_ci_yaml", "Настройте CI", "Подключите проверку AppSec"]) expect(text).not.toContain(leak);
      // закрытая категория анониму — «Недоступно» (не «Нет данных») и «Видна
      // участникам репозитория.», без чисел
      expect(text).toMatch(/CI\/CD\s+–\s+Недоступно\s+Видна участникам репозитория\./);
    } finally {
      close();
    }
  });

  test("разметка MD в PDF – стилем, а не символами: код, курсив, полужирный, ссылка", () => {
    const { card, close } = fixtureCard("grant-ci");
    try {
      const doc = buildPdfDocument(buildReportModel(card));
      const json = JSON.stringify(doc.content);
      expect(json).toContain(`{"text":"docs.presence","color":"${COLORS.muted}","fontSize":7}`);
      expect(json).toContain('{"text":"CI [config] `only` | pipes","italics":true}');
      // полужирное в отчете — заголовок действия; имя категории — обычным начертанием
      expect(json).toMatch(/"text":\[[^\]]*"bold":true[^\]]*\],"fontSize":8\.5/);
      expect(json).toMatch(/\{"text":"(Документация|Задачи|Активность|Состояние кода)","color":"#262626"/);
      expect(json).toContain(`"link":"${card.repo.webUrl}"`);
      expect(json).not.toContain("**");
      expect(json).not.toContain("\\\\[");
      expect(json).not.toContain("](");
    } finally {
      close();
    }
  });
});

describe("П1 (приёмка HQ): ячейки таблиц переносятся и не вылезают за поле", () => {
  // длинное значение без пробелов не переносится и уходит за правый край —
  // PDF теряет содержание, которое MD показывает
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

  test.each([...REPORT_FIXTURES])("фикстура %s: ни в одной ячейке ни одной таблицы (включая вложенные) нет неразрывного куска длиннее порога", (name) => {
    const { card, close } = fixtureCard(name);
    try {
      const doc = buildPdfDocument(buildReportModel(card));
      let cells = 0;
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!node || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if ("table" in o) {
          for (const row of (o.table as { body: unknown[][] }).body.slice(1)) {
            for (const cell of row) {
              cells++;
              expect(longestUnbroken(pdfTreeText(cell).join(" "))).toBeLessThanOrEqual(MAX_UNBROKEN);
            }
          }
        }
        for (const key of ["stack", "columns"]) if (key in o) visit(o[key]);
      };
      visit(doc.content);
      // у never (скана нет) таблиц нет вовсе; у остальных — есть
      if (name !== "never") expect(cells).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  test("в PDF нет JSON: значения фактов – таблицами «поле – значение» (К9.4)", () => {
    const { card, close } = fixtureCard("full");
    try {
      const text = pdfTreeText(buildPdfDocument(buildReportModel(card)).content).join(" ");
      expect(text).not.toMatch(/\{"|":\s*[\[{"\d]/);
    } finally {
      close();
    }
  });
});

describe("П1: шрифт Inter покрывает все символы генератора", () => {
  const fontCmaps = Object.values(FONT_FILES).map((f) => ({ file: f, cps: cmapCodepoints(join(FONT_DIR, f)) }));

  test("каталог шрифта – четыре начертания Inter и лицензия OFL", () => {
    expect(readdirSync(FONT_DIR).sort()).toEqual(["Inter-Italic.ttf", "Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-SemiBoldItalic.ttf", "LICENSE.txt"]);
    expect(readFileSync(join(FONT_DIR, "LICENSE.txt"), "utf8")).toContain("SIL Open Font License");
  });

  test("литералы src/report, recommend.ts, format.ts, эталонные MD и обязательные символы рисуются всеми начертаниями", () => {
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
    // синтетическая строка обязательных символов: «→» и «≤» могут прийти во
    // внешних данных, «−» (U+2212) — минус русских чисел
    for (const ch of "→≤…§«»––−≈×· ДЮю") chars.add(ch);
    for (const must of ["→", "≤", "…", "§", "«", "»", "–", "–", "−", "≈", "×", "·", "Д", "ю"]) expect(chars.has(must)).toBe(true);
    const missing = fontCmaps.map(({ file, cps }) => ({ file, missing: [...chars].filter((ch) => !cps.has(ch.codePointAt(0)!)) }));
    expect(missing).toEqual(fontCmaps.map(({ file }) => ({ file, missing: [] })));
  });
});


describe("П1: рендер, политики и сбойный путь", () => {
  test("рендер фикстуры с «→» – настоящий PDF за доли секунды", async () => {
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

  test("сбой генерации – честная 500 JSON без стека, а не пустой или битый файл", async () => {
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
