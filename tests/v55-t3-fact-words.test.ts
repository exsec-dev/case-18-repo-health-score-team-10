// V5.5 tour 3 (item 11, variant A): a recommendation's fact in words over the raw
// value. Behavioral: numbers and words on known fact values (rule 21.09/23.09),
// fallback pairs for other facts, nothing for non-ok facts, UI language rule.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { factWords } from "../src/report/factWords";

describe("factWords: facts referenced by recommendation rules", () => {
  test("docs.presence names each anchor file with yes/no", () => {
    const w = factWords("docs.presence", "ok", { readme: true, license: false, contributing: false, codeowners: true, content_checked: true });
    expect(w).toEqual([
      "README – есть, LICENSE – нет",
      "CONTRIBUTING – нет, CODEOWNERS – есть",
      "Файл засчитывается, если в нем не меньше 16 значимых символов",
    ]);
  });

  test("docs.readme: size, sections and launch sections; absent README said plainly", () => {
    expect(factWords("docs.readme", "ok", { bytes: 27663, sections: 15, flags: { install: false, build: true, test: false } })).toEqual([
      "README – 27 КБ, разделов с заголовками – 15",
      "Разделы о запуске: установка – нет, сборка – есть, тесты – нет",
    ]);
    expect(factWords("docs.readme", "ok", { present: false })).toEqual(["README в репозитории нет"]);
  });

  test("cicd.configs and cicd.runs in words (seconds -> minutes, share -> percent)", () => {
    expect(factWords("cicd.configs", "ok", { paths: [], has_ci_yaml: false, has_steps: false })).toEqual(["Файл .sourcecraft/ci.yaml – нет"]);
    expect(factWords("cicd.runs", "ok", { last_status: "failure", success_rate: 0.8, duration_p50: 330, runs_count: 20, green_streak: 0 })).toEqual([
      "Последний запуск – с ошибкой",
      "Успешных – 80% из 20 запусков",
      "Типичная длительность – 5,5 мин, успешных подряд – 0",
    ]);
    expect(factWords("cicd.runs", "ok", { runs_count: 0 })).toEqual(["Запусков CI нет"]);
  });

  test("issues.stats: counts, instant closes named, median close unit, stale", () => {
    expect(factWords("issues.stats", "ok", { open: 57, in_progress: 1, closed: 223, closed_instant: 6, median_close_days: 0.45, stale_90d: 0 })).toEqual([
      "Открыто – 57 (в работе 1), закрыто – 223 (быстрее часа – 6, в расчет не входят)",
      "Типичное время закрытия – 0,5 дня",
      "Открытых без обновлений дольше 90 дней – 0",
    ]);
    expect(factWords("issues.stats", "ok", { open: 0, closed: 0 })).toEqual(["Задач в трекере нет"]);
  });

  test("tree.stats, code.todo (test markers named), appsec.findings", () => {
    expect(factWords("tree.stats", "ok", { file_count: 120, source_files: 80, test_files: 12, loc: 9000, source_loc: 7000 })).toEqual([
      "Файлов – 120, из них с кодом – 80, тестов – 12",
      "Строк кода – 7 000",
    ]);
    expect(factWords("code.todo", "ok", { count: 1, fixme: 0, older_180d: 0, todo_files: 1, test_markers: 29 })).toEqual([
      "Пометок TODO – 1, FIXME – 0 (файлов кода с пометками – 1)",
      "Старше 180 дней – 0",
      "В файлах тестов еще 29 – в счет не входят",
    ]);
    expect(
      factWords("appsec.findings", "ok", {
        severity_counts: { critical: 24, high: 41, medium: 51, low: 10 },
        resolved_share: 0,
        secrets_critical: false,
        backlog: { engines: { Trivy: 63, grype: 63 } },
      }),
    ).toEqual([
      "Открытых находок: критичных – 24, высоких – 41, средних – 51, низких – 10",
      "Закрыто находок – 0%, утекшие критичные секреты – нет",
      "Анализаторы: Trivy – 63, grype – 63",
    ]);
  });
});

describe("factWords: fallback and non-ok facts", () => {
  test("unknown fact key -> field – value pairs, at most 8 lines", () => {
    expect(factWords("x.unknown", "ok", { a: 1, b: { c: true } })).toEqual(["a – 1", "b.c – да"]);
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i]));
    const w = factWords("x.many", "ok", many);
    expect(w.length).toBe(9);
    expect(w[8]).toBe("и еще 4 – в исходных данных");
  });

  test("non-ok fact gives no words (the popover shows status and reason itself)", () => {
    expect(factWords("cicd.runs", "no-data", { reason: "access" })).toEqual([]);
    expect(factWords("docs.presence", "bad", null)).toEqual([]);
  });

  test("UI language rule: no long dash, no yo in the module texts", () => {
    const src = readFileSync("src/report/factWords.ts", "utf8");
    const strings = src.match(/`[^`]*`|"[^"\n]*"/g) ?? [];
    for (const raw of strings) {
      const s = raw.replaceAll('"—"', ""); // the no-data glyph is allowed
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/[ёЁ]/);
    }
  });

  test("card popover shows words and keeps raw data under a collapsible", () => {
    const card = readFileSync("src/web/RepoPage.tsx", "utf8");
    expect(card).toContain("factWords(fact.key, fact.status, fact.value)");
    expect(card).toContain('<Disclosure size="m" summary="Исходные данные" className="rh-proof__raw-toggle">');
  });
});
