// «Почему изменилась оценка»: разбивка разницы двух анализов по категориям
// (summary/score-change) и ее слова на карточке (web/scoreChangeView).
import { describe, expect, test } from "bun:test";
import { apportion, decompose, scoreChange, type ScoreSnapshot } from "../src/summary/score-change";
import { INDEX_WEIGHTS } from "../src/score/model";
import { bridgeOf, categoryPhrase, changeLine, dayOptions, defaultPair, subInline } from "../src/web/scoreChangeView";
import type { HistoryPoint } from "../src/summary/history-contract";
import type { CategoryKey } from "../src/score/model";

type Cats = Partial<Record<CategoryKey, number | null>>;

/** Итог по весам категорий с данными — тем же правилом, что расчет оценки. */
function total(c: Cats, w: Partial<Record<CategoryKey, number>>): number {
  const ks = (Object.keys(w) as CategoryKey[]).filter((k) => typeof c[k] === "number");
  return ks.reduce((a, k) => a + w[k]! * c[k]!, 0) / ks.reduce((a, k) => a + w[k]!, 0);
}

function snap(scanId: number, cats: Cats, extra: Partial<ScoreSnapshot> = {}): ScoreSnapshot {
  const categories: ScoreSnapshot["categories"] = {};
  for (const [k, v] of Object.entries(cats)) categories[k] = { score: v ?? null, submetrics: {} };
  const index = Object.keys(INDEX_WEIGHTS).some((k) => typeof cats[k as CategoryKey] === "number") ? Math.round(total(cats, INDEX_WEIGHTS)) : null;
  return { scanId, finishedAt: `2026-10-${String(scanId).padStart(2, "0")}T10:00:00Z`, categories, codeEmpty: false, healthcraftIndex: index, repoHealthScore: null, fullCap: null, ...extra };
}

describe("разбивка разницы по категориям", () => {
  test("те же категории с данными: вклады в сумме дают разницу итогов", () => {
    const a: Cats = { documentation: 59.5, activity: 72.8, issues: 6, code: 99.5 };
    const b: Cats = { documentation: 100, activity: 72.8, issues: 6, code: 99.2 };
    const parts = decompose(a, b, INDEX_WEIGHTS)!;
    const sum = [...parts.values()].reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(total(b, INDEX_WEIGHTS) - total(a, INDEX_WEIGHTS), 9);
    expect(parts.get("documentation")!).toBeCloseTo(9.315, 3);
  });

  test("категория получила данные: разбивка все равно точная", () => {
    const a: Cats = { documentation: 50, activity: 82, issues: null, code: 97 };
    const b: Cats = { documentation: 50, activity: 76, issues: 13, code: 97 };
    const parts = decompose(a, b, INDEX_WEIGHTS)!;
    const sum = [...parts.values()].reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(total(b, INDEX_WEIGHTS) - total(a, INDEX_WEIGHTS), 9);
    // новая слабая категория тянет итог вниз
    expect(parts.get("issues")!).toBeLessThan(-10);
  });

  test("категория потеряла данные: разбивка точная", () => {
    const a: Cats = { documentation: 40, activity: 60, issues: 90, code: 70 };
    const b: Cats = { documentation: 45, activity: 60, issues: null, code: 70 };
    const sum = [...decompose(a, b, INDEX_WEIGHTS)!.values()].reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(total(b, INDEX_WEIGHTS) - total(a, INDEX_WEIGHTS), 9);
  });

  test("целые вклады в сумме равны разнице показанных чисел", () => {
    const parts = new Map<CategoryKey, number>([
      ["documentation", 9.3],
      ["code", -0.1],
      ["activity", 0.4],
    ]);
    const whole = apportion(parts, 9);
    expect([...whole.values()].reduce((x, y) => x + y, 0)).toBe(9);
    expect(whole.get("documentation")).toBe(9);
    expect(apportion(parts, 11).get("documentation")).toBeGreaterThanOrEqual(10);
    expect([...apportion(parts, 8).values()].reduce((x, y) => x + y, 0)).toBe(8);
  });
});

describe("разница двух анализов", () => {
  test("рост документации: категория с вкладом, без лишних категорий", () => {
    const c = scoreChange(snap(19, { documentation: 59.5, activity: 72.8, issues: 6, code: 99.5 }), snap(20, { documentation: 100, activity: 72.8, issues: 6, code: 99.2 }), false);
    expect(c.special).toBeNull();
    expect(c.categories.map((x) => [x.key, x.index])).toEqual([["documentation", 9]]);
    expect(c.categories.reduce((a, x) => a + (x.index ?? 0), 0)).toBe(c.index.to! - c.index.from!);
  });

  test("закрытые каналы не протекают: без прав CI/CD и Безопасности нет", () => {
    const a = snap(1, { documentation: 50, activity: 50, issues: 50, code: 50, cicd: 20, security: 40 });
    const b = snap(2, { documentation: 50, activity: 50, issues: 50, code: 50, cicd: 90, security: 80 });
    expect(scoreChange(a, b, false).categories).toEqual([]);
    expect(scoreChange(a, b, false).full).toBeNull();
  });

  test("появился код — особый переход без разбивки", () => {
    const c = scoreChange(snap(1, { code: 0 }, { codeEmpty: true, healthcraftIndex: 0 }), snap(2, { documentation: 40, activity: 40, issues: null, code: 57 }), false);
    expect(c.special).toBe("code-appeared");
    expect(c.categories).toEqual([]);
  });

  test("Repo Health Score: категория с нулевым вкладом в индекс остается в разбивке полного", () => {
    // документация +2: индекс 50 → 50,46 (показано 50 → 50, вклад 0), полный 50,4 → 50,7
    // (показано 50 → 51) — единица полного достается документации
    const cats: Cats = { documentation: 50, activity: 50, issues: 50, code: 50, cicd: 50, security: 50 };
    const a = snap(1, cats, { repoHealthScore: 50.4 });
    const b = snap(2, { ...cats, documentation: 52 }, { repoHealthScore: 50.7 });
    const c = scoreChange(a, b, true);
    expect(c.categories.map((k) => [k.key, k.index, k.full])).toEqual([["documentation", 0, 1]]);
    const bridge = bridgeOf(c, "full")!;
    expect(bridge.from + bridge.steps.reduce((x, s) => x + s.value, 0)).toBe(bridge.to);
  });

  test("кап полного итога: вклады Repo Health Score не считаются", () => {
    const cats: Cats = { documentation: 90, activity: 90, issues: 90, code: 90, cicd: 90, security: 90 };
    const a = snap(1, cats, { repoHealthScore: 49, fullCap: 49 });
    const b = snap(2, { ...cats, documentation: 95 }, { repoHealthScore: 49, fullCap: 49 });
    const c = scoreChange(a, b, true);
    expect(c.fullCapped).toBe(true);
    expect(c.categories.every((x) => x.full === null)).toBe(true);
  });
});

describe("слова на карточке", () => {
  const point = (scanId: number, change: HistoryPoint["change"], hci: number): HistoryPoint => ({
    scanId,
    finishedAt: `2026-10-${String(scanId).padStart(2, "0")}T10:00:00Z`,
    healthcraftIndex: hci,
    indexCoverage: 1,
    repoHealthScore: null,
    modelVersion: "test",
    headSha: null,
    codeEmpty: false,
    change,
  });

  test("название показателя внутри фразы: без скобок, аббревиатуры как есть", () => {
    expect(subInline("README (наличие и качество)")).toBe("README");
    expect(subInline("Плотность TODO/FIXME в коде")).toBe("плотность TODO/FIXME в коде");
    expect(subInline("CONTRIBUTING")).toBe("CONTRIBUTING");
  });

  test("строка под анализом и мостик по умолчанию — последнее изменение", () => {
    const a = snap(19, { documentation: 59.5, activity: 72.8, issues: 6, code: 99.5 });
    const b = snap(20, { documentation: 100, activity: 72.8, issues: 6, code: 99.2 });
    b.categories.documentation!.submetrics = { contributing: { score: 1, value: null } };
    a.categories.documentation!.submetrics = { contributing: { score: 0, value: null } };
    const change = scoreChange(a, b, false);
    const points = [point(19, null, 60), point(20, change, 69), point(21, scoreChange(b, { ...b, scanId: 21 }, false), 69)];
    expect(changeLine(points[1]!, false)).toBe("Документация +9: появился CONTRIBUTING");
    expect(changeLine(points[2]!, false)).toBeNull();
    // пара по умолчанию: от конца дня перед последним изменением до последнего анализа
    expect(defaultPair(points, false)).toEqual({ from: 19, to: 21 });
    const bridge = bridgeOf(change, "index")!;
    expect(bridge.from + bridge.steps.reduce((x, s) => x + s.value, 0)).toBe(bridge.to);
  });

  test("фраза категории — без чисел: файлы появились, остальное направлением", () => {
    const c = {
      key: "documentation" as const,
      from: 24,
      to: 100,
      kind: "changed" as const,
      index: 17,
      full: null,
      subs: [
        { key: "license", title: "Лицензия", from: "нет", to: "есть", better: true },
        { key: "contributing", title: "CONTRIBUTING", from: "нет", to: "есть", better: true },
        { key: "readme", title: "README (наличие и качество)", from: "4,7 КБ", to: "35,2 КБ", better: true },
      ],
    };
    expect(categoryPhrase(c)).toBe("появились лицензия и CONTRIBUTING, README подробнее");
    expect(categoryPhrase({ ...c, key: "code", subs: [{ key: "density", title: "Плотность TODO/FIXME в коде", from: "1", to: "3", better: false }] })).toBe("TODO/FIXME в коде встречаются чаще");
    expect(categoryPhrase({ ...c, kind: "appeared", from: null, to: 13, subs: [] })).toBe("появились данные – категория учтена в оценке с баллом 13");
  });

  // заготовка категории для фраз: ключ, баллы и показатели
  const cat = (key: "documentation" | "activity" | "issues" | "code" | "security", subs: { key: string; title?: string; from: string; to: string; better: boolean }[], from: number | null = 40, to: number | null = 30) => ({
    key,
    from,
    to,
    kind: (from === null ? "appeared" : to === null ? "gone" : "changed") as "changed" | "appeared" | "gone",
    index: -3,
    full: null,
    subs: subs.map((s) => ({ title: s.key, ...s })),
  });

  test("задачи с баллом 0 — словами, а не «вошла с баллом 0»", () => {
    expect(categoryPhrase(cat("issues", [], null, 0))).toBe("появились данные – задачи не ведутся или ни одна не закрыта");
    expect(categoryPhrase(cat("documentation", [], null, 0))).toBe("появились данные – категория учтена в оценке с баллом 0");
    expect(categoryPhrase(cat("issues", [], 12, 0))).toBe("задачи не ведутся или ни одна не закрыта");
    expect(categoryPhrase(cat("code", [], 60, null))).toBe("данных больше нет – категория не учитывается в оценке");
  });

  test("малая выборка задач: смысл поправки, без повтора рядом", () => {
    const worse = cat("issues", [
      { key: "close_days", from: "1,2 дня", to: "4 дня", better: false },
      { key: "resolution", from: "80%", to: "60%", better: false },
      { key: "adjustment.small-sample", from: "достаточно", to: "3 из 10", better: false },
    ]);
    expect(categoryPhrase(worse)).toBe("задачи закрывают медленнее, доля решенных задач ниже, закрытых задач мало для надежной оценки");
    // ни одна задача не закрыта — время закрытия и доля решенных этим уже сказаны
    const none = cat("issues", [
      { key: "adjustment.small-sample", from: "2 из 10", to: "0 из 10", better: false },
      { key: "close_days", from: "0 дней", to: "ни одна задача не закрыта", better: false },
      { key: "resolution", from: "67%", to: "0%", better: false },
    ]);
    expect(categoryPhrase(none)).toBe("ни одна задача не закрыта");
    expect(categoryPhrase(cat("issues", [{ key: "adjustment.small-sample", from: "2 из 10", to: "5 из 10", better: false }]))).toBe("закрытых задач стало больше");
    expect(categoryPhrase(cat("issues", [{ key: "adjustment.small-sample", from: "5 из 10", to: "достаточно", better: true }]))).toBe("закрытых задач достаточно для надежной оценки");
    expect(categoryPhrase(cat("issues", [{ key: "adjustment.small-sample", from: "8 из 10", to: "2 из 3 дней", better: false }]))).toBe("задачи закрывали только в два разных дня");
  });

  test("малый код: поправка появилась без смены объема — «кода мало», а не «кода стало меньше»", () => {
    const sc = (from: string, to: string, better: boolean) => categoryPhrase(cat("code", [{ key: "adjustment.small-code", from, to, better }]));
    expect(sc("достаточно", "160 из 200 строк", false)).toBe("кода мало для надежной оценки");
    expect(sc("161 из 200 строк", "93 из 200 строк", false)).toBe("кода стало меньше");
    expect(sc("43 из 200 строк", "46 из 200 строк", true)).toBe("кода стало больше");
    expect(sc("150 из 200 строк", "достаточно", true)).toBe("кода достаточно для надежной оценки");
  });

  test("показатели без названных изменений: мелкий сдвиг и смена набора показателей", () => {
    expect(categoryPhrase(cat("activity", [], 28.4, 28.1))).toBe("небольшие изменения показателей");
    expect(categoryPhrase(cat("activity", [], 22.1, 17.6))).toBe("изменился набор учтенных показателей");
  });

  test("файлы: род и число, пропавшие — «больше нет», README наравне с файлами", () => {
    const doc = (subs: { key: string; from: string; to: string; better: boolean }[]) => categoryPhrase(cat("documentation", subs));
    const yes = { from: "нет", to: "есть", better: true };
    const no = { from: "есть", to: "нет", better: false };
    expect(doc([{ key: "license", ...yes }])).toBe("появилась лицензия");
    expect(doc([{ key: "codeowners", ...yes }])).toBe("появился CODEOWNERS");
    expect(doc([{ key: "license", ...no }, { key: "contributing", ...no }])).toBe("больше нет лицензии и CONTRIBUTING");
    expect(doc([{ key: "license", ...yes }, { key: "readme", from: "нет файла", to: "0,1 КБ, 2 раздела", better: true }])).toBe("появились лицензия и README");
    expect(doc([{ key: "readme", from: "0,9 КБ, 0 разделов", to: "нет файла", better: false }])).toBe("больше нет README");
    expect(doc([{ key: "readme", from: "4,7 КБ", to: "2,1 КБ", better: false }])).toBe("README менее подробный");
  });

  test("активность, CI и AppSec: точные слова направления", () => {
    expect(categoryPhrase(cat("activity", [{ key: "fresh", from: "3 дня", to: "40 дней", better: false }, { key: "freq", from: "6 в месяц", to: "2 в месяц", better: false }]))).toBe("с последнего коммита прошло больше времени, меньше коммитов в месяц");
    expect(categoryPhrase(cat("code", [{ key: "root", from: "12 элементов", to: "30 элементов", better: false }, { key: "old_share", from: "10%", to: "40%", better: false }]))).toBe("в корне репозитория больше файлов и папок, доля старых TODO выше");
    expect(categoryPhrase({ ...cat("security", [{ key: "adjustment.open-findings-cap", from: "нет", to: "не выше 40", better: false }]), key: "security" })).toBe("открытые критичные находки AppSec ограничивают балл");
    expect(categoryPhrase({ ...cat("security", [{ key: "adjustment.open-findings-cap", from: "не выше 69", to: "нет", better: true }]), key: "security" })).toBe("открытые находки AppSec больше не ограничивают балл");
    expect(categoryPhrase({ ...cat("security", [{ key: "secrets", from: "найдены", to: "не найдены", better: true }]), key: "security" })).toBe("критичные утечки секретов больше не найдены");
    expect(categoryPhrase({ ...cat("security", [{ key: "config", from: "ci.yaml без команд", to: "ci.yaml с командами", better: true }]), key: "cicd" })).toBe("в ci.yaml появились команды");
  });

  test("дни в полях выбора: один пункт на день — его последний анализ", () => {
    const at = (scanId: number, iso: string): HistoryPoint => ({ ...point(scanId, null, 50), finishedAt: iso });
    const days = dayOptions([at(1, "2026-10-19T08:00:00Z"), at(2, "2026-10-19T12:00:00Z"), at(3, "2026-10-20T12:00:00Z")]);
    expect(days.map((d) => d.scanId)).toEqual([2, 3]);
  });

  test("пара по умолчанию — по последнему изменению индекса, а не только Repo Health Score", () => {
    const at = (scanId: number, day: string, change: HistoryPoint["change"], hci: number, rhs: number): HistoryPoint => ({
      ...point(scanId, change, hci),
      finishedAt: `2026-10-${day}T10:00:00Z`,
      repoHealthScore: rhs,
    });
    const idx = scoreChange(snap(1, { documentation: 40, activity: 60, issues: 60, code: 60 }), snap(2, { documentation: 80, activity: 60, issues: 60, code: 60 }), false);
    const full: HistoryPoint["change"] = { fromScanId: 2, fromFinishedAt: null, index: { from: 69, to: 69 }, full: { from: 61, to: 60 }, special: null, fullCapped: false, categories: [] };
    const points = [at(1, "17", null, 60, 61), at(2, "18", idx, 69, 61), at(3, "19", full, 69, 60)];
    expect(defaultPair(points, true)).toEqual({ from: 1, to: 3 });
  });
});
