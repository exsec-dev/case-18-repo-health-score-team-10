// dates.test.ts — единый формат дат UI (В4.7, контракт П5, блок Б8).
// `fmtDate` — поле без времени по смыслу: «15 сент. 2026»; `fmtDateTime` —
// «12:00 18 янв. 2023» (время HH:mm первым, 24 часа). День без ведущего
// нуля, полный год, без запятой и «г.», месяцы — закрытой таблицей, пояс —
// локальный. Входы строятся из ЛОКАЛЬНЫХ дат, поэтому тест не зависит от
// часового пояса машины. MD-отчёт форматтеры UI не использует (свои, срез ISO).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MONTHS_SHORT_RU, fmtDate, fmtDateTime } from "../src/web/format";

const local = (y: number, m: number, d: number, h = 0, min = 0): string => new Date(y, m, d, h, min).toISOString();

describe("П5: fmtDate — дата без времени", () => {
  test("все 12 месяцев — закрытой таблицей", () => {
    expect(MONTHS_SHORT_RU).toEqual(["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."]);
    expect(Array.from({ length: 12 }, (_, m) => fmtDate(local(2026, m, 15, 12)))).toEqual([
      "15 янв. 2026",
      "15 февр. 2026",
      "15 мар. 2026",
      "15 апр. 2026",
      "15 мая 2026",
      "15 июн. 2026",
      "15 июл. 2026",
      "15 авг. 2026",
      "15 сент. 2026",
      "15 окт. 2026",
      "15 нояб. 2026",
      "15 дек. 2026",
    ]);
  });

  test("однозначный день без ведущего нуля; полночь — та же дата", () => {
    expect(fmtDate(local(2026, 8, 5, 9, 30))).toBe("5 сент. 2026");
    expect(fmtDate(local(2026, 0, 1, 0, 0))).toBe("1 янв. 2026");
  });

  test("чистая дата YYYY-MM-DD — локальная полночь, а не UTC (не съезжает на день назад)", () => {
    expect(fmtDate("2025-08-16")).toBe("16 авг. 2025");
    expect(fmtDateTime("2025-08-16")).toBe("00:00 16 авг. 2025");
  });

  test("пусто — «—» (tri-state), невалидная строка — как пришла", () => {
    expect([fmtDate(null), fmtDate(undefined), fmtDate("")]).toEqual(["—", "—", "—"]);
    expect(fmtDate("не дата")).toBe("не дата");
    expect(fmtDate("2026-13-45")).toBe("2026-13-45");
  });
});

describe("П5: fmtDateTime — время первым", () => {
  test("«12:00 18 янв. 2023»: HH:mm, 24 часа, без запятой и «г.»", () => {
    expect(fmtDateTime(local(2023, 0, 18, 12, 0))).toBe("12:00 18 янв. 2023");
    expect(fmtDateTime(local(2026, 8, 15, 23, 7))).toBe("23:07 15 сент. 2026");
    expect(fmtDateTime(local(2026, 4, 3, 9, 5))).toBe("09:05 3 мая 2026");
  });

  test("полночь — 00:00; все 12 месяцев", () => {
    expect(fmtDateTime(local(2026, 0, 1, 0, 0))).toBe("00:00 1 янв. 2026");
    expect(Array.from({ length: 12 }, (_, m) => fmtDateTime(local(2025, m, 28, 18, 45)).split(" ")[2])).toEqual([...MONTHS_SHORT_RU]);
  });

  test("пусто — «—», невалидная строка — как пришла; ни запятых, ни «г.» ни в одном выводе", () => {
    expect([fmtDateTime(null), fmtDateTime(undefined), fmtDateTime("")]).toEqual(["—", "—", "—"]);
    expect(fmtDateTime("garbage")).toBe("garbage");
    for (let m = 0; m < 12; m++) {
      const out = [fmtDate(local(2024, m, 9, 7, 3)), fmtDateTime(local(2024, m, 9, 7, 3))].join(" ");
      expect({ m, comma: out.includes(","), year: / г\./.test(out) }).toEqual({ m, comma: false, year: false });
    }
  });
});

describe("П5: один шов на все экраны, MD не тронут", () => {
  const webDir = join(import.meta.dir, "..", "src", "web");

  test("экраны не форматируют даты сами: ни toLocaleDateString, ни toLocaleString с датой, ни Intl.DateTimeFormat", () => {
    for (const file of readdirSync(webDir).filter((f) => /\.tsx?$/.test(f))) {
      const src = readFileSync(join(webDir, file), "utf8");
      expect({ file, local: /toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat|toLocaleString\([^)]*(day|month|hour)/.test(src) }).toEqual({ file, local: false });
    }
  });

  test("отчет держит свои форматтеры (срез ISO) и общие из web/format не импортирует", () => {
    const md = readFileSync(join(import.meta.dir, "..", "src", "report", "markdown.ts"), "utf8");
    const importLine = md.split("\n").find((l) => l.includes('from "../web/format"')) ?? "";
    expect({ importsDate: /\bfmtDate(Time)?\b/.test(importLine), localDate: md.includes('return iso ? iso.slice(0, 10) : "—";'), localDateTime: md.includes('return iso ? iso.replace("T", " ").slice(0, 16) : "—";') }).toEqual({
      importsDate: false,
      localDate: true,
      localDateTime: true,
    });
  });

  test("у последней активности в кабинете времени нет (решение В4)", () => {
    expect(readFileSync(join(webDir, "MePage.tsx"), "utf8")).toContain("активность {fmtDate(entry.lastActivityAt)}");
  });
});
