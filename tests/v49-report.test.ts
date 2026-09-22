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
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getRepoCard } from "../src/api/repos";
import { renderRepoReport } from "../src/report/markdown";
import { REPORT_NO_SCORE } from "../src/report/build";
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

// Б8: тот же словарь — на пяти живых репозиториях исследования. Только по КОПИИ
// живой БД (`VACUUM INTO` с readonly-хендла) и только по явной переменной:
//   V49_LIVE_DATA_DIR=<каталог копии> bun test tests/v49-report.test.ts
// Копия открывается readonly — тест ничего в нее не пишет.
const LIVE_DIR = process.env.V49_LIVE_DATA_DIR;
// Круг 3 гейта (решение владельца 22.09): без оценки отчет не выдается, поэтому
// `qipparu/2` вышел из набора снимаемых документов — по нему проверяется отказ.
const LIVE_REPOS = ["bayselonarrend/openintegrations", "divkit/divkit", "sourcecraft/template-tg-bot", "gravity-ui/uikit"];
const LIVE_NO_SCORE = "qipparu/2";

(LIVE_DIR ? describe : describe.skip)("К9.2 на живых репозиториях (копия БД)", () => {
  for (const slug of LIVE_REPOS) {
    for (const viewer of ["anon", "full"] as const) {
      test(`${slug} (${viewer}): в основном тексте нет слов словаря`, () => {
        const db = new Database(join(LIVE_DIR!, "repo-health.db"), { readonly: true });
        try {
          const [org, repo] = slug.split("/") as [string, string];
          const card =
            viewer === "full"
              ? getRepoCard(db, org, repo, { access: { cicd: "granted", appsec: "granted", repo: "granted" }, viewerAuth: "pat" })
              : getRepoCard(db, org, repo);
          expect(card).not.toBeNull();
          expect(dictionaryHits(mainText(renderRepoReport(card!)))).toEqual([]);
        } finally {
          db.close();
        }
      });
    }
  }

  test(`${LIVE_NO_SCORE}: оценки нет — документ не собирается (круг 3 гейта)`, () => {
    const db = new Database(join(LIVE_DIR!, "repo-health.db"), { readonly: true });
    try {
      const [org, repo] = LIVE_NO_SCORE.split("/") as [string, string];
      const card = getRepoCard(db, org, repo);
      expect(card).not.toBeNull();
      expect(card!.score).toBeNull();
      expect(() => renderRepoReport(card!)).toThrow(REPORT_NO_SCORE);
    } finally {
      db.close();
    }
  });
});

describe("К9.6: MD читается в рендере", () => {
  for (const name of REPORT_FIXTURES) {
    test(`${name}: без HTML, таблицы основного текста не шире 4 колонок, без переносов «два пробела»`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const md = renderRepoReport(card);
        const main = mainText(md);
        expect(md).not.toMatch(/<\/?[a-z][^>]*>/i);
        const widths = main
          .split("\n")
          .filter((l) => l.startsWith("| "))
          .map((l) => l.split(/(?<!\\)\|/).length - 2);
        for (const w of widths) expect(w).toBeLessThanOrEqual(4);
        expect(md).not.toMatch(/ {2}$/m);
        // первый экран строкой «**N из 100 · слово**» или «**Оценки нет**»
        expect(main).toMatch(/: \*\*(\d+ из 100 · (здоров|требует внимания|в зоне риска)|Оценки нет)\*\*/);
      } finally {
        close();
      }
    });
  }
});

describe("К9.1: первый экран у фикстур с оценкой", () => {
  for (const name of ["anon", "full", "grant-ci"] as const) {
    // Гейт 22.09: вердикта-предложения под оценкой в отчете больше нет (В3),
    // блок «Что сделать первым» снят, раздел рекомендаций один и стоит сразу
    // после категорий (В11, В15). Порядок первого экрана проверяется по ним.
    (ENABLED.firstScreen ? test : test.todo)(`${name}: показатель с плашкой, вклады и рекомендации — до разбора`, () => {
      const { card, close } = fixtureCard(name);
      try {
        const md = renderRepoReport(card);
        const hero = md.search(/\*\*\d+ из 100 · (здоров|требует внимания|в зоне риска)\*\*/u);
        const contrib = md.indexOf("## Вклад категорий в ");
        const cats = md.indexOf("## Категории");
        const actions = md.indexOf("## Рекомендации");
        const detail = md.indexOf("## Разбор по категориям");
        for (const at of [hero, contrib, cats, actions, detail]) expect(at).toBeGreaterThan(-1);
        expect(md).not.toMatch(/Репозиторий (в хорошем состоянии|требует внимания|в зоне риска)\./u);
        expect(hero).toBeLessThan(contrib);
        expect(contrib).toBeLessThan(cats);
        expect(cats).toBeLessThan(actions);
        expect(actions).toBeLessThan(detail);
      } finally {
        close();
      }
    });
  }
});
