// Значок места (чистая функция): 3 лиги – золото ТОП-10, серебро ТОП-100,
// бронза ТОП-1000, равные – strict. Значок – функция индекса в выборке рейтинга (above /
// atOrAbove / всего), а не одного места: у равных индексов он одинаков при
// обеих политиках. Каждая граница лиги проверяется с обеих сторон; лучший
// уровень — самый узкий порог; нет места — нет значка.
import { describe, expect, test } from "bun:test";
import { RANK_TIERS, RANK_TIE_POLICY, rankBadge, tierCutoff, type RankTier, type RankTiePolicy } from "../src/api/rank-badge";

/** Репо без равных на месте rank: выше rank−1, не ниже rank. */
const unique = (rank: number, total: number) => ({ above: rank - 1, atOrAbove: rank, rankedTotal: total });
const tierOf = (standing: Parameters<typeof rankBadge>[0], ties?: RankTiePolicy, tiers?: readonly RankTier[]): string | null =>
  rankBadge(standing, { ties, tiers })?.tier ?? null;
const POLICIES: RankTiePolicy[] = ["strict", "inclusive"];

// размер рейтинга на реальной БД
const N = 28_285;

describe("rankBadge: нет места — нет значка", () => {
  test("null/undefined — null", () => {
    expect(rankBadge(null)).toBeNull();
    expect(rankBadge(undefined)).toBeNull();
  });

  test("несогласованное положение — null, а не значок", () => {
    expect(rankBadge({ above: 3, atOrAbove: 3, rankedTotal: 100 })).toBeNull(); // сам репо не учтен
    expect(rankBadge({ above: 0, atOrAbove: 101, rankedTotal: 100 })).toBeNull();
    expect(rankBadge({ above: -1, atOrAbove: 1, rankedTotal: 100 })).toBeNull();
    expect(rankBadge({ above: 0.5, atOrAbove: 1, rankedTotal: 100 })).toBeNull();
  });
});

describe("rankBadge: лиги по умолчанию (решение владельца 27.09)", () => {
  test("3 лиги, только абсолютные пороги; политика по умолчанию — strict", () => {
    expect(RANK_TIERS.map((t) => [t.id, t.kind, t.n, t.label])).toEqual([
      ["gold", "top", 10, "ТОП-10"],
      ["silver", "top", 100, "ТОП-100"],
      ["bronze", "top", 1000, "ТОП-1000"],
    ]);
    expect(RANK_TIE_POLICY).toBe("strict");
    const tie = { above: 9, atOrAbove: 11, rankedTotal: N };
    expect(rankBadge(tie)).toEqual(rankBadge(tie, { ties: "strict" }));
  });

  test("подписи — по правилам языка UI (цифры, дефис, без «ё» и длинного тире)", () => {
    for (const t of RANK_TIERS) expect(/[—ё]/.test(t.label)).toBe(false);
    expect(rankBadge(unique(3, N))).toEqual({ tier: "gold", label: "ТОП-10" });
    expect(rankBadge(unique(30, N))).toEqual({ tier: "silver", label: "ТОП-100" });
    expect(rankBadge(unique(300, N))).toEqual({ tier: "bronze", label: "ТОП-1000" });
  });

  for (const ties of POLICIES) {
    test(`${ties}: без равных каждая граница лиги с обеих сторон (включительно)`, () => {
      expect(tierOf(unique(1, N), ties)).toBe("gold");
      expect(tierOf(unique(10, N), ties)).toBe("gold");
      expect(tierOf(unique(11, N), ties)).toBe("silver");
      expect(tierOf(unique(100, N), ties)).toBe("silver");
      expect(tierOf(unique(101, N), ties)).toBe("bronze");
      expect(tierOf(unique(1000, N), ties)).toBe("bronze");
      // ниже бронзы значка нет
      expect(tierOf(unique(1001, N), ties)).toBeNull();
      expect(tierOf(unique(N, N), ties)).toBeNull();
    });
  }
});

describe("rankBadge: равные индексы на границе", () => {
  // реальные случаи: индекс 76 – места 10-11, индекс 62 – места 93-122
  test("strict: равные на границе все без значка лиги — берут следующую", () => {
    expect(tierOf({ above: 9, atOrAbove: 11, rankedTotal: N }, "strict")).toBe("silver");
    expect(tierOf({ above: 92, atOrAbove: 122, rankedTotal: N }, "strict")).toBe("bronze");
    expect(tierOf({ above: 990, atOrAbove: 1020, rankedTotal: N }, "strict")).toBeNull();
    // равные кончаются ровно на 10-м — значок есть
    expect(tierOf({ above: 7, atOrAbove: 10, rankedTotal: N }, "strict")).toBe("gold");
  });

  test("inclusive: равные на границе все со значком лиги", () => {
    expect(tierOf({ above: 9, atOrAbove: 11, rankedTotal: N }, "inclusive")).toBe("gold");
    expect(tierOf({ above: 92, atOrAbove: 122, rankedTotal: N }, "inclusive")).toBe("silver");
    expect(tierOf({ above: 990, atOrAbove: 1020, rankedTotal: N }, "inclusive")).toBe("bronze");
    // выше уже 10 — золота нет
    expect(tierOf({ above: 10, atOrAbove: 12, rankedTotal: N }, "inclusive")).toBe("silver");
  });
});

describe("rankBadge: малые рейтинги, лучший уровень, параметры", () => {
  test("лига ТОП-N — только когда в рейтинге больше N репо", () => {
    // «ТОП-10 из 10» — значок у всех, он ничего не значит
    expect(tierOf(unique(1, 10))).toBeNull();
    expect(tierOf(unique(10, 11))).toBe("gold");
    expect(tierOf(unique(50, 100))).toBeNull();
    expect(tierOf(unique(50, 150))).toBe("silver");
    expect(tierOf(unique(500, 1000))).toBeNull();
    expect(tierOf(unique(500, 1001))).toBe("bronze");
  });

  test("процентный порог (в параметре) — вниз: №1 из 50 не «ТОП-1%» (это 2%)", () => {
    const pct: RankTier = { id: "silver", kind: "percent", n: 1, label: "ТОП-1%" };
    expect(tierCutoff(pct, 50)).toBe(0);
    expect(tierOf(unique(1, 50), undefined, [pct])).toBeNull();
    // 150 репо: 1% = 1,5 → 1 место; при ceil было бы 2
    expect(tierCutoff(pct, 150)).toBe(1);
    expect(tierOf(unique(1, 150), undefined, [pct])).toBe("silver");
    expect(tierOf(unique(2, 150), undefined, [pct])).toBeNull();
  });

  test("лучший — самый узкий порог, а не порядок таблицы; при равном пороге — первый", () => {
    const tiers: RankTier[] = [
      { id: "gold", kind: "top", n: 10, label: "ТОП-10" },
      { id: "silver", kind: "percent", n: 1, label: "ТОП-1%" },
    ];
    // 500 репо: ТОП-10 — 10 мест, ТОП-1% — 5 мест: №5 — «ТОП-1%», №6 — «ТОП-10»
    expect(tierOf(unique(5, 500), undefined, tiers)).toBe("silver");
    expect(tierOf(unique(6, 500), undefined, tiers)).toBe("gold");
    // 1 000 репо: оба порога ровно 10 мест — первый в таблице
    expect(tierOf(unique(10, 1_000), undefined, tiers)).toBe("gold");
  });

  test("таблица и политика — параметры: пустая таблица — значка нет", () => {
    const tiers: RankTier[] = [
      { id: "gold", kind: "top", n: 3, label: "ТОП-3" },
      { id: "bronze", kind: "percent", n: 25, label: "ТОП-25%" },
    ];
    expect(rankBadge(unique(3, 40), { tiers })).toEqual({ tier: "gold", label: "ТОП-3" });
    expect(tierOf(unique(10, 40), undefined, tiers)).toBe("bronze");
    expect(tierOf(unique(11, 40), undefined, tiers)).toBeNull();
    expect(tierOf(unique(1, 40), undefined, [])).toBeNull();
    expect(tierOf({ above: 2, atOrAbove: 5, rankedTotal: 40 }, "strict", tiers)).toBe("bronze");
    expect(tierOf({ above: 2, atOrAbove: 5, rankedTotal: 40 }, "inclusive", tiers)).toBe("gold");
  });
});
