// audit-m43-repro.test.ts — воспроизведение находок вехи В4.3 (Ф3):
// контракт двух показателей HealthCraft Index / Repo Health Score.
// Закон вехи — reports/2026-09-17-fix-plan.md ревизия 6, Часть 2
// «В4.3 = Ф3» и Часть 3 «К-Ф3»; решения — TASK.md §2 от 18.09
// («Два отдельных рейтинга», «Веса публичной четвёрки», «CI/Sec-компенсация
// отвергнута», «Иерархия чисел»); синтез критик-раунда —
// reports/2026-09-18-critics-two-ratings-favorites.md.
//
// Б0 покрывает ЧЕТЫРЕ находки:
//   Ф3.1/Ф3.2 — публичные веса ровно 23/23/23/31: именованная константа
//               INDEX_WEIGHTS + поведенческая проверка totalsFromCategories
//               (до Б1 константы не существует — шов: import * as model);
//   Ф3.1/Ф3.5 — рейтинг и API называют публичное число HealthCraft Index,
//               не Repo Health Score: items[] несёт healthcraftIndex (не
//               score), sort=index валиден, /api/meta — имена показателей;
//   Ф3.2/Ф3.3 — актуальная схема не хранит полный total: в scores нет
//               total_rating/total_full/coverage_full/markers, есть
//               healthcraft_index/index_coverage;
//   Ф3.4      — signed-дельта рекомендаций переживает инверсию: плохие
//               CI/Security дают минус, движок не рендерит «+» безусловно.
//
// На Б0-коммите находки стоят под обёрткой `repro` (в строгом режиме —
// красные); обёртка снимается в блоке, закрывшем находку, сами
// утверждения при этом не меняются. Строгий режим — для команды приёмки:
//   AUDIT_STRICT=1 bun test tests/audit-m43-repro.test.ts
//
// Живых запросов нет: только временные БД и чистые функции.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import * as model from "../src/score/model";
import { totalsFromCategories } from "../src/score/compute";
import { recommendFromFacts } from "../src/score/recommend";
import { DEFAULT_QUERY, getMeta, listRepos, parseReposQuery, type SortKey } from "../src/api/repos";
import { makeApiDb, seedRating, type ApiTestDb } from "./api-fixtures";

// Обёртка строгого режима (как в audit-m42a/m42b-repro): в обычном прогоне —
// `test.failing` (набор зелёный, красноты в CI нет), под AUDIT_STRICT=1 —
// обычный `test`, то есть красный, пока находка не закрыта.
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
// Ф3.1/Ф3.2. Публичные веса — ровно 23/23/23/31 (решение Алексея 18.09:
// перенормированная редукция ТЗ-весов 20/15/15/15/15/20, округление целых).
// ---------------------------------------------------------------------------

describe("Ф3.1/Ф3.2: веса публичной четвёрки 23/23/23/31", () => {
  // закрыто блоком Б1 — обёртка `repro` снята, утверждение не менялось
  test("INDEX_WEIGHTS — именованная константа модели со значениями 23/23/23/31", () => {
    const w = (model as { INDEX_WEIGHTS?: Record<string, number> }).INDEX_WEIGHTS;
    expect(w).toEqual({ documentation: 23, activity: 23, issues: 23, code: 31 });
  });

  // закрыто блоком Б1 — обёртка `repro` снята, утверждение не менялось
  test("поведенчески: индекс четвёрки считается словарём 23/23/23/31, не перенормировкой 15/15/15/20", () => {
    // doc=50, act=50, iss=100, code=0: индекс = (23·0.5 + 23·0.5 + 23·1 + 31·0)/100·100
    // = ровно 46. Старая перенормировка давала (15+15+15)/65·100 = 46.1538 —
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
// Ф3.1/Ф3.5. Рейтинг и API называют публичное число HealthCraft Index.
// ---------------------------------------------------------------------------

describe("Ф3.1/Ф3.5: публичное число зовётся HealthCraft Index", () => {
  repro("items[] несёт healthcraftIndex (не score); сортировка sort=index валидна", () => {
    const t = tempDb();
    seedRating(t);
    const top = listRepos(t.db, { ...DEFAULT_QUERY, sort: "index" as SortKey }).items[0]! as unknown as Record<string, unknown>;
    expect(Object.hasOwn(top, "score")).toBe(false);
    expect(typeof top.healthcraftIndex).toBe("number");
    const parsed = parseReposQuery(new URLSearchParams("sort=index"));
    expect(parsed.ok).toBe(true);
  });

  repro("/api/meta называет показатели: publicMetricTitle/fullMetricTitle и веса indexWeight/scoreWeight", () => {
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
// Ф3.2/Ф3.3. Актуальная схема не содержит сохранённый полный total.
// ---------------------------------------------------------------------------

describe("Ф3.2/Ф3.3: в scores нет сохранённого полного итога", () => {
  repro("PRAGMA table_info(scores): есть healthcraft_index, нет total_rating/total_full/coverage_full/markers", () => {
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
// Ф3.4. Signed-дельта переживает инверсию: при отрицательном приросте
// (плохие CI/Security ниже среднего остальных категорий) движок обязан
// показать минус — сейчас recommend.ts рендерит «+» безусловно («+-2.5»).
// Оценщик Δ инъектируется (К-Ф1.2) — знак его контракт, рендер не имеет
// права его терять.
// ---------------------------------------------------------------------------

describe("Ф3.4: signed-дельта рекомендаций", () => {
  // закрыто блоком Б1 — обёртка `repro` снята, утверждение не менялось
  test("отрицательный Δ рендерится минусом и называет цель по имени, без безусловного «+»", () => {
    const facts = new Map<string, unknown>([["docs.presence", { readme: true, license: false, contributing: true, codeowners: true }]]);
    const recs = recommendFromFacts(facts, {
      delta: () => ({ delta: -2.5, reason: null }),
      issuesScore: null,
    });
    const rec = recs.find((r) => r.ruleId === "license-missing")!;
    expect(rec.expectedImpact).toBe("-2.5 к HealthCraft Index");
    expect(rec.expectedImpact!.startsWith("+")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Самопроверка строгого режима (Т1 круга 2 В4.2-port-fix — тот же приём):
// без неё «AUDIT_STRICT=1 зелёный» — тавтология, потому что незакрытые находки
// стоят под `test.failing`. На Б0-коммите этот тест красный вместе с ними.
// ---------------------------------------------------------------------------

if (process.env.AUDIT_STRICT) {
  test("строгий режим: ни одной находки под repro/test.failing — зелёный значит «закрыто»", () => {
    const src = readFileSync(import.meta.path, "utf8");
    const parked = src.match(/^[ \t]*(repro|test\.failing)\(/gm) ?? [];
    expect({ parked, wrapperIsPlainTest: repro === test }).toEqual({ parked: [], wrapperIsPlainTest: true });
  });
}
