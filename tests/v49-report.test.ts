// v49-report.test.ts — трипвайры отчёта В4.9 (блок Б0; включаются блоками).
//
// 1. К9.2: закрытый словарь слов, запрещённых в ОСНОВНОМ тексте отчёта
//    (§4 исследования `reports/2026-09-22-m49-report-research.md`): жаргон
//    методики, слова движка, английские заметки расчёта, внутренние пути,
//    ISO-даты. Основной текст — всё до приложения «Расчет оценки и исходные
//    данные»: приложение для проверки и может называть поля данных.
// 2. К9.1: первый экран — показатель с плашкой вердикта, вклады категорий и
//    действия — есть у каждой фикстуры с оценкой и стоит до разбора.
//
// Трипвай включается в блоке, который его закрывает (`ENABLED`); до этого он
// `test.todo`, чтобы каждый коммит оставался зелёным.
import { describe, expect, test } from "bun:test";
import { renderRepoReport } from "../src/report/markdown";
import { REPORT_FIXTURES, fixtureCard } from "./report-fixtures";

const ENABLED = { dictionary: true, firstScreen: true };

/** Закрытый словарь К9.2: [что ищем, почему нельзя]. */
export const FORBIDDEN_MAIN_TEXT: [RegExp, string][] = [
  [/перенормир/iu, "перенормировка — слово методики"],
  [/(?<!\p{L})кап(ят|ом|а|у)?(?!\p{L})/iu, "«кап» — жаргон (потолок 49)"],
  [/ярус/iu, "деградационный ярус"],
  [/tri-state/iu, "tri-state"],
  [/(?<!\p{L})движ(ок|ка|ком|ке|ку)(?!\p{L})/iu, "движок/движка/движком (не «движения»)"],
  [/\(источник: rule\)/u, "«(источник: rule)»"],
  [/(?<![\p{L}_])kind(?![\p{L}_])/iu, "kind"],
  [/no-data/iu, "no-data"],
  [/Что это НЕ значит/u, "«Что это НЕ значит»"],
  [/reports\//u, "внутренний путь reports/"],
  [/\d{4}-\d{2}-\d{2}/u, "ISO-дата"],
  [/tracker not maintained|no declared CI|runs no-data|todo sample incomplete|completed_at missing|channel no-data|channels no-data|AppSec data unavailable|config-only cap|used updated_at/iu, "английская заметка расчета"],
  [/(?<![\p{L}\p{N}])Q\d+/u, "ключ открытого вопроса (Q14)"],
];

/** Основной текст MD — до приложения. */
export function mainText(md: string): string {
  const at = md.indexOf("\n## Приложение");
  return at === -1 ? md : md.slice(0, at);
}

/** Нарушения словаря в тексте: [почему, найденный фрагмент]. */
export function dictionaryHits(text: string): string[] {
  const hits: string[] = [];
  for (const [re, why] of FORBIDDEN_MAIN_TEXT) {
    const m = re.exec(text);
    if (m) hits.push(`${why}: «${text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)}»`);
  }
  return hits;
}

describe("К9.2: словарь запрещенных слов в основном тексте", () => {
  test("словарь ловит то, что должен, и не ловит «без движения»", () => {
    expect(dictionaryHits("задачи без движения более 90 дней")).toEqual([]);
    expect(dictionaryHits("Порядок задан движком")).toHaveLength(1);
    expect(dictionaryHits("кап 49 за секреты")).toHaveLength(1);
    expect(dictionaryHits("2026-09-16 12:00")).toHaveLength(1);
    expect(dictionaryHits("(tracker not maintained — category minimum (Q14))")).toHaveLength(2);
    expect(dictionaryHits("Сбой капитала")).toEqual([]);
  });
  for (const name of REPORT_FIXTURES) {
    (ENABLED.dictionary ? test : test.todo)(`${name}: в основном тексте нет слов словаря`, () => {
      const { card, close } = fixtureCard(name);
      try {
        expect(dictionaryHits(mainText(renderRepoReport(card)))).toEqual([]);
      } finally {
        close();
      }
    });
  }
});

describe("К9.1: первый экран у фикстур с оценкой", () => {
  for (const name of ["anon", "full", "grant-ci"] as const) {
    (ENABLED.firstScreen ? test : test.todo)(`${name}: показатель с плашкой, вердикт, вклады и действия — до разбора`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const md = renderRepoReport(card);
        const hero = md.search(/\*\*\d+ из 100 · (здоров|требует внимания|в зоне риска)\*\*/u);
        const verdict = md.search(/Репозиторий (в хорошем состоянии|требует внимания|в зоне риска)\./u);
        const contrib = md.indexOf("## Вклад категорий в оценку");
        const actions = md.indexOf("## Что сделать первым");
        const detail = md.indexOf("## Разбор по категориям");
        for (const at of [hero, verdict, contrib, actions, detail]) expect(at).toBeGreaterThan(-1);
        expect(hero).toBeLessThan(verdict);
        expect(verdict).toBeLessThan(contrib);
        expect(contrib).toBeLessThan(actions);
        expect(actions).toBeLessThan(detail);
      } finally {
        close();
      }
    });
  }
});
