// Ширина текста шрифтом отчета, без зависимостей.
//
// pdfmake сам переносит строки, но несколько элементов вёрстки ему нужно
// знать заранее: ширину плашки `Label` (скруглённый прямоугольник рисуется
// canvas'ом под текстом) и число строк текста в строке категории (элементы
// строки центрируются по высоте отступом сверху — таблицы pdfmake
// вертикального выравнивания не умеют). Ширина считается по таблицам
// `cmap` и `hmtx` того же TTF, что встраивается в PDF; кернинг не
// учитывается — погрешность доли пункта, запас заложен в поля плашки.
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface FontMetrics {
  unitsPerEm: number;
  advance: (codepoint: number) => number;
}

function parseFont(file: string): FontMetrics {
  const buf = readFileSync(file);
  const u16 = (o: number) => buf.readUInt16BE(o);
  const u32 = (o: number) => buf.readUInt32BE(o);
  const tables = new Map<string, number>();
  for (let i = 0; i < u16(4); i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString("latin1", rec, rec + 4), u32(rec + 8));
  }
  const head = tables.get("head")!;
  const hhea = tables.get("hhea")!;
  const hmtx = tables.get("hmtx")!;
  const cmap = tables.get("cmap")!;
  const unitsPerEm = u16(head + 18);
  const metricsCount = u16(hhea + 34);
  const glyphOf = new Map<number, number>();
  for (let i = 0; i < u16(cmap + 2); i++) {
    const platform = u16(cmap + 4 + i * 8);
    const encoding = u16(cmap + 6 + i * 8);
    const off = cmap + u32(cmap + 8 + i * 8);
    const format = u16(off);
    if (format === 12) {
      for (let g = 0; g < u32(off + 12); g++) {
        const start = u32(off + 16 + g * 12);
        const end = u32(off + 20 + g * 12);
        const glyph = u32(off + 24 + g * 12);
        for (let c = start; c <= end; c++) glyphOf.set(c, glyph + (c - start));
      }
    } else if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1)) && glyphOf.size === 0) {
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
          const g = rangeOffset === 0 ? (c + delta) & 0xffff : u16(ranges + s * 2 + rangeOffset + (c - start) * 2);
          if (g !== 0) glyphOf.set(c, rangeOffset === 0 ? g : (g + delta) & 0xffff);
        }
      }
    }
  }
  const advanceOfGlyph = (g: number): number => u16(hmtx + Math.min(g, metricsCount - 1) * 4);
  return { unitsPerEm, advance: (cp) => advanceOfGlyph(glyphOf.get(cp) ?? 0) };
}

const cache = new Map<string, FontMetrics>();

function font(dir: string, file: string): FontMetrics {
  const key = join(dir, file);
  let m = cache.get(key);
  if (!m) {
    m = parseFont(key);
    cache.set(key, m);
  }
  return m;
}

export function textWidth(dir: string, file: string, text: string, size: number, characterSpacing = 0): number {
  const f = font(dir, file);
  let units = 0;
  let n = 0;
  for (const ch of text) {
    units += f.advance(ch.codePointAt(0)!);
    n++;
  }
  return (units * size) / f.unitsPerEm + characterSpacing * n;
}
