// rank-badge.ts — В5.9 Б (развитие идеи №15): значок места «ТОП-N» у
// репозитория в публичном рейтинге. Чистый модуль без БД и React (его может
// брать бандл web). По умолчанию — решение владельца 27.09 (Екатерина): 3
// лиги, только абсолютные пороги — золото ТОП-10, серебро ТОП-100, бронза
// ТОП-1000; ниже бронзы значка нет; равные — политика strict. Таблица и
// политика остаются параметрами функции (процентные уровни она тоже умеет).
//
// Значок — функция ИНДЕКСА репо в выборке рейтинга, а не одного `rank`
// (дополнение HQ 27.09 из дизайн-аудита): место между равными индексами
// ставится по алфавиту org/repo, и значок по `rank` дал бы «ТОП-10» только
// первому из двух репо с одинаковым индексом (копия БД 27.09: индекс 76
// занимает места 10-11, индекс 62 — места 93-122). Поэтому на вход — числа
// по той же выборке, что `rank`/`rankedTotal` (`ratingPlace` карточки и SVG,
// проход по рейтингу в `listRepos`):
//   above     — репо со СТРОГО бОльшим индексом;
//   atOrAbove — репо с индексом ≥ своего, включая себя.
// Индекс в БД хранится уже округленным до целого (compute.ts, roundTotal),
// поэтому сравнение сохраненных значений = сравнение округленных.
//
// Правила:
// - порог N уровня: `top` — N мест; `percent` P (только в параметре, не в
//   таблице по умолчанию) — floor(P · rankedTotal / 100) мест (вниз: «в ТОП-1%»
//   не обещает больше 1%; при ceil №1 из 50 получил бы «ТОП-1%», хотя это 2%);
// - политика равных: `strict` — уровень, только если atOrAbove ≤ N (все
//   равные на границе без значка); `inclusive` — если above < N (все равные
//   на границе со значком). В обоих случаях у равных значок одинаков;
// - `top` N — только когда в рейтинге больше N репо (иначе «ТОП-10 из 8» —
//   значок у всех, он ничего не значит); уровень с порогом 0 не выдается;
// - из подходящих берется ЛУЧШИЙ — с самым узким порогом; при равном пороге —
//   первый в таблице;
// - места нет (без индекса, приватный, internal, выбывший) — null.

export type RankTierKind = "top" | "percent";

/** Лига значка — ключ, по которому UI и SVG красят значок («металл»). */
export type RankLeague = "gold" | "silver" | "bronze";

export interface RankTier {
  /** лига: стабильный ключ для UI и SVG */
  id: RankLeague;
  kind: RankTierKind;
  /** top — число мест; percent — процент рейтинга */
  n: number;
  /** подпись значка (правила языка UI: цифры, дефис) */
  label: string;
}

export interface RankBadge {
  tier: RankLeague;
  /** подпись: «ТОП-10», «ТОП-100», «ТОП-1000» */
  label: string;
}

/** Политика равных индексов на границе уровня — см. шапку модуля. */
export type RankTiePolicy = "strict" | "inclusive";

/** Положение индекса репо в выборке рейтинга (та же выборка, что rank/rankedTotal). */
export interface RankStanding {
  above: number;
  atOrAbove: number;
  rankedTotal: number;
}

/**
 * Решение владельца 27.09 (Екатерина): 3 лиги, только абсолютные пороги.
 * Копия БД 27.09 (28 285 репо с местом), strict: золото 9 репо (индекс
 * 77-87), серебро 83 (63-76), бронза 897 (54-62), всего 989 (3,5%); при
 * inclusive было бы 11 / 111 / 1 187 — отчет воркера Б.
 */
export const RANK_TIERS: readonly RankTier[] = [
  { id: "gold", kind: "top", n: 10, label: "ТОП-10" },
  { id: "silver", kind: "top", n: 100, label: "ТОП-100" },
  { id: "bronze", kind: "top", n: 1000, label: "ТОП-1000" },
];

/** Политика по умолчанию и в API — `strict` (решение владельца 27.09). */
export const RANK_TIE_POLICY: RankTiePolicy = "strict";

/** Порог уровня в местах при данном размере рейтинга; 0 — уровень не выдается. */
export function tierCutoff(tier: RankTier, rankedTotal: number): number {
  switch (tier.kind) {
    case "top":
      return rankedTotal > tier.n ? tier.n : 0;
    case "percent":
      return Math.floor((tier.n * rankedTotal) / 100);
  }
}

export function rankBadge(
  standing: RankStanding | null | undefined,
  opts: { tiers?: readonly RankTier[]; ties?: RankTiePolicy } = {},
): RankBadge | null {
  if (standing === null || standing === undefined) return null;
  const { above, atOrAbove, rankedTotal } = standing;
  if (![above, atOrAbove, rankedTotal].every(Number.isInteger)) return null;
  if (above < 0 || atOrAbove <= above || atOrAbove > rankedTotal) return null;
  const ties = opts.ties ?? RANK_TIE_POLICY;
  let best: { tier: RankTier; cutoff: number } | null = null;
  for (const tier of opts.tiers ?? RANK_TIERS) {
    const cutoff = tierCutoff(tier, rankedTotal);
    if (cutoff < 1) continue;
    const fits = ties === "strict" ? atOrAbove <= cutoff : above < cutoff;
    if (!fits) continue;
    if (best === null || cutoff < best.cutoff) best = { tier, cutoff };
  }
  return best === null ? null : { tier: best.tier.id, label: best.tier.label };
}
