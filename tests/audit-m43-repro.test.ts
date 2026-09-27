// Репро-тесты на контракт двух показателей: публичный HealthCraft Index
// (4 категории, веса 23/23/23/31) и полный Repo Health Score. Проверяются
// веса, имя публичного числа в рейтинге и API, отсутствие сохраненного
// полного итога в схеме и знак дельты рекомендаций.
// Живых запросов нет: только временные БД и чистые функции.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import * as model from "../src/score/model";
import { totalsFromCategories } from "../src/score/compute";
import { recommendFromFacts, recommendationText } from "../src/score/recommend";
import { DEFAULT_QUERY, getMeta, listRepos, parseReposQuery, type SortKey } from "../src/api/repos";
import { makeApiDb, seedRating, type ApiTestDb } from "./api-fixtures";

// Обертка репро: в обычном прогоне — `test.failing` (набор зеленый, пока
// дефект жив), под AUDIT_STRICT=1 — обычный `test`, красный до исправления.
const repro = process.env.AUDIT_STRICT ? test : test.failing;

const dbs: ApiTestDb[] = [];
afterAll(() => {
  for (const t of dbs) t.close();
});

function tempDb(): ApiTestDb {
  const t = makeApiDb();
  dbs.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// Публичные веса — ровно 23/23/23/31: ТЗ-веса 20/15/15/15/15/20 без CI и
// Security, перенормированные и округленные до целых.
// ---------------------------------------------------------------------------

describe("Ф3.1/Ф3.2: веса публичной четвёрки 23/23/23/31", () => {
  test("INDEX_WEIGHTS — именованная константа модели со значениями 23/23/23/31", () => {
    const w = (model as { INDEX_WEIGHTS?: Record<string, number> }).INDEX_WEIGHTS;
    expect(w).toEqual({ documentation: 23, activity: 23, issues: 23, code: 31 });
  });

  test("поведенчески: индекс четвёрки считается словарём 23/23/23/31, не перенормировкой 15/15/15/20", () => {
    // doc=50, act=50, iss=100, code=0: индекс = (23·0.5 + 23·0.5 + 23·1 + 31·0)/100·100
    // = ровно 46. Перенормировка 15/15/15/20 дала бы (15+15+15)/65·100 = 46.1538 —
    // различимо на четвёртом знаке.
    const totals = totalsFromCategories(
      {
        documentation: { score: 50 },
        activity: { score: 50 },
        issues: { score: 100 },
        code: { score: 0 },
        cicd: { score: null },
        security: { score: null },
      } as Parameters<typeof totalsFromCategories>[0],
      { codeEmpty: false, secretsCritical: false },
    ) as unknown as Record<string, number | null>;
    expect(totals["healthcraftIndex"]).toBeCloseTo(46, 4);
  });
});

// ---------------------------------------------------------------------------
// Рейтинг и API называют публичное число HealthCraft Index, а не Repo Health Score.
// ---------------------------------------------------------------------------

describe("Ф3.1/Ф3.5: публичное число зовётся HealthCraft Index", () => {
  test("items[] несёт healthcraftIndex (не score); сортировка sort=index валидна", () => {
    const t = tempDb();
    seedRating(t);
    const top = listRepos(t.db, { ...DEFAULT_QUERY, sort: "index" as SortKey }).items[0]! as unknown as Record<string, unknown>;
    expect(Object.hasOwn(top, "score")).toBe(false);
    expect(typeof top.healthcraftIndex).toBe("number");
    const parsed = parseReposQuery(new URLSearchParams("sort=index"));
    expect(parsed.ok).toBe(true);
  });

  test("/api/meta называет показатели: publicMetricTitle/fullMetricTitle и веса indexWeight/scoreWeight", () => {
    const t = tempDb();
    seedRating(t);
    const meta = getMeta(t.db) as unknown as Record<string, unknown> & {
      categories: Record<string, unknown>[];
    };
    expect(meta["publicMetricTitle"]).toBe("HealthCraft Index");
    expect(meta["fullMetricTitle"]).toBe("Repo Health Score");
    const four = meta.categories.filter((c) => c.key !== "cicd" && c.key !== "security");
    expect(four.map((c) => c.indexWeight)).toEqual([23, 23, 23, 31]);
    expect(meta.categories.every((c) => typeof c.scoreWeight === "number")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Схема не хранит сохраненный полный итог, только публичный индекс и его покрытие.
// ---------------------------------------------------------------------------

describe("Ф3.2/Ф3.3: в scores нет сохранённого полного итога", () => {
  test("PRAGMA table_info(scores): есть healthcraft_index, нет total_rating/total_full/coverage_full/markers", () => {
    const t = tempDb();
    const cols = ((t.db.query("PRAGMA table_info(scores)").all() as { name: string }[]).map((c) => c.name));
    expect(cols).toContain("healthcraft_index");
    expect(cols).toContain("index_coverage");
    for (const gone of ["total_rating", "total_full", "coverage_full", "markers"]) {
      expect(cols).not.toContain(gone);
    }
  });
});

// ---------------------------------------------------------------------------
// Signed-дельта переживает инверсию: прирост бывает отрицательным (плохие
// CI/Security ниже среднего остальных категорий), и рендер не должен
// превращать его в «+-2.5». Знак — контракт инъектируемого оценщика Δ.
// ---------------------------------------------------------------------------

describe("Ф3.4: signed-дельта рекомендаций", () => {
  // отрицательный Δ не доходит до выдачи — движок подавляет правила с
  // delta <= 0; контракт рендера минуса живет в чистой функции текстов
  test("отрицательный Δ подавлен движком; текстовая функция рендерит минус и цель по имени, без безусловного «+»", () => {
    const facts = new Map<string, unknown>([["docs.presence", { readme: true, license: false, contributing: true, codeowners: true }]]);
    const recs = recommendFromFacts(facts, {
      delta: () => ({ delta: -2.5, reason: null }),
      issuesScore: null,
    });
    expect(recs.find((r) => r.ruleId === "license-missing")).toBeUndefined();
    // минус — знак U+2212, десятичная запятая
    const texts = recommendationText("license-missing", { delta: -2.5, reason: null, channel: null })!;
    expect(texts.expectedImpact).toBe("−2,5 к HealthCraft Index");
    expect(texts.expectedImpact.startsWith("+")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима: без нее «AUDIT_STRICT=1 зеленый» — тавтология,
// потому что неисправленные дефекты стоят под `test.failing`.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
