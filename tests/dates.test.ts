// Единый формат дат UI и отчета. `fmtDate` — поле без времени по смыслу:
// «15 сент. 2026»; `fmtDateTime` — «18 янв. 2023, 12:00» (дата, запятая, время
// HH:mm, 24 часа; UX 17.10 — было «12:00 18 янв. 2023»); `fmtTime` — «12:00».
// День без ведущего нуля, полный год, без «г.», месяцы — закрытой таблицей, пояс —
// локальный. Входы строятся из ЛОКАЛЬНЫХ дат, поэтому тест не зависит от
// часового пояса машины.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MONTHS_SHORT_RU, fmtDate, fmtDateTime, fmtDateTimeUtc, fmtTime } from "../src/web/format";

const local = (y: number, m: number, d: number, h = 0, min = 0): string => new Date(y, m, d, h, min).toISOString();

describe("П5: fmtDate – дата без времени", () => {
  test("все 12 месяцев – закрытой таблицей", () => {
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

  test("однозначный день без ведущего нуля; полночь – та же дата", () => {
    expect(fmtDate(local(2026, 8, 5, 9, 30))).toBe("5 сент. 2026");
    expect(fmtDate(local(2026, 0, 1, 0, 0))).toBe("1 янв. 2026");
  });

  test("чистая дата YYYY-MM-DD – локальная полночь, а не UTC (не съезжает на день назад)", () => {
    expect(fmtDate("2025-08-16")).toBe("16 авг. 2025");
    expect(fmtDateTime("2025-08-16")).toBe("16 авг. 2025, 00:00");
  });

  test("пусто – «–» (tri-state), невалидная строка – как пришла", () => {
    expect([fmtDate(null), fmtDate(undefined), fmtDate("")]).toEqual(["–", "–", "–"]);
    expect(fmtDate("не дата")).toBe("не дата");
    expect(fmtDate("2026-13-45")).toBe("2026-13-45");
  });
});

// UX 17.10: дата первой, время после запятой (было «время первым, без запятой»)
describe("П5: fmtDateTime – дата, затем время", () => {
  test("«18 янв. 2023, 12:00»: HH:mm, 24 часа, время после запятой, без «г.»", () => {
    expect(fmtDateTime(local(2023, 0, 18, 12, 0))).toBe("18 янв. 2023, 12:00");
    expect(fmtDateTime(local(2026, 8, 15, 23, 7))).toBe("15 сент. 2026, 23:07");
    expect(fmtDateTime(local(2026, 4, 3, 9, 5))).toBe("3 мая 2026, 09:05");
  });

  test("полночь – 00:00; все 12 месяцев", () => {
    expect(fmtDateTime(local(2026, 0, 1, 0, 0))).toBe("1 янв. 2026, 00:00");
    expect(Array.from({ length: 12 }, (_, m) => fmtDateTime(local(2025, m, 28, 18, 45)).split(" ")[1])).toEqual([...MONTHS_SHORT_RU]);
  });

  test("пусто – «–», невалидная строка – как пришла; запятая – только перед временем, «г.» нет ни в одном выводе", () => {
    expect([fmtDateTime(null), fmtDateTime(undefined), fmtDateTime("")]).toEqual(["–", "–", "–"]);
    expect(fmtDateTime("garbage")).toBe("garbage");
    for (let m = 0; m < 12; m++) {
      const date = fmtDate(local(2024, m, 9, 7, 3));
      const dateTime = fmtDateTime(local(2024, m, 9, 7, 3));
      expect({ m, dateComma: date.includes(","), dateTime, year: / г\./.test(`${date} ${dateTime}`) }).toEqual({
        m,
        dateComma: false,
        dateTime: `${date}, 07:03`,
        year: false,
      });
    }
  });
});

// UX 17.10: новый fmtTime — только время; fmtDateTimeUtc — дата, запятая, время и «UTC»
describe("П5: fmtTime и fmtDateTimeUtc", () => {
  test("fmtTime – «12:00» (локальное, HH:mm); пусто – «–», невалидная – как пришла", () => {
    expect(fmtTime(local(2023, 0, 18, 12, 0))).toBe("12:00");
    expect(fmtTime(local(2026, 4, 3, 9, 5))).toBe("09:05");
    expect([fmtTime(null), fmtTime(undefined), fmtTime("")]).toEqual(["–", "–", "–"]);
    expect(fmtTime("garbage")).toBe("garbage");
  });

  test("fmtDateTimeUtc – «16 сент. 2026, 12:00 UTC» независимо от пояса машины", () => {
    expect(fmtDateTimeUtc("2026-09-16T12:00:00Z")).toBe("16 сент. 2026, 12:00 UTC");
    expect(fmtDateTimeUtc("2026-05-03T09:05:00Z")).toBe("3 мая 2026, 09:05 UTC");
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

  // отчет (MD и PDF, включая приложение) печатает даты теми же форматтерами, что UI
  test("отчет берет форматтеры дат из web/format, своих срезов ISO нет", () => {
    const dir = join(import.meta.dir, "..", "src", "report");
    const build = readFileSync(join(dir, "build.ts"), "utf8");
    const importBlock = build.slice(build.indexOf("import {"), build.indexOf('} from "../web/format"'));
    const all = ["build.ts", "markdown.ts", "pdf.ts", "model.ts"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect({
      importsDate: /\bfmtDate\b/.test(importBlock) && /\bfmtDateTime\b/.test(importBlock),
      localDate: all.includes("iso.slice(0, 10)"),
      localDateTime: all.includes('iso.replace("T", " ")'),
    }).toEqual({ importsDate: true, localDate: false, localDateTime: false });
  });

  // в кабинете дата последней активности — лишний реквизит; на карточке и в
  // рейтинге она остается
  test("в кабинете даты последней активности нет (В4.8 круг 3; было – решение В4 «без времени»)", () => {
    expect(readFileSync(join(webDir, "MePage.tsx"), "utf8")).not.toContain("{fmtDate(entry.lastActivityAt)}");
  });
});
