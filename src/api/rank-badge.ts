// Значок места «ТОП-N» у репозитория в публичном рейтинге. Чистый модуль без
// БД и React (его может брать бандл web). По умолчанию 3 лиги с абсолютными
// порогами: золото ТОП-10, серебро ТОП-100, бронза ТОП-1000, ниже значка нет.
// Таблица уровней и политика равных – параметры (процентные уровни тоже есть).
//
// Значок зависит от ИНДЕКСА репо в выборке рейтинга, а не от `rank`: место
// между равными индексами ставится по алфавиту org/repo, и значок по `rank`
// дал бы «ТОП-10» только первому из двух репо с одинаковым индексом. Поэтому
// на вход – числа по той же выборке, что `rank`/`rankedTotal`:
//   above     – репо со СТРОГО большим индексом;
//   atOrAbove – репо с индексом ≥ своего, включая себя.
// Индекс в БД уже округлен до целого (roundTotal), так что сравнение
// сохраненных значений равно сравнению округленных.
//
// Правила:
// - порог уровня: `top` N – N мест; `percent` P – floor(P · rankedTotal / 100)
//   мест (вниз, иначе №1 из 50 получил бы «ТОП-1%», хотя это 2%);
// - политика равных: `strict` – уровень, только если atOrAbove ≤ N (равные на
//   границе без значка); `inclusive` – если above < N (равные на границе со
//   значком). В обоих случаях у равных значок одинаков;
// - `top` N – только когда в рейтинге больше N репо (иначе «ТОП-10 из 8» у
//   всех и ничего не значит); уровень с порогом 0 не выдается;
// - из подходящих берется лучший – с самым узким порогом, при равном пороге –
//   первый в таблице;
// - места нет (без индекса, приватный, internal, выбывший) – null.

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
 * 3 лиги с абсолютными порогами. На выборке ~28 тыс. репо с местом значок
 * получают около 3,5% из них.
 */
export const RANK_TIERS: readonly RankTier[] = [
  { id: "gold", kind: "top", n: 10, label: "ТОП-10" },
  { id: "silver", kind: "top", n: 100, label: "ТОП-100" },
  { id: "bronze", kind: "top", n: 1000, label: "ТОП-1000" },
];

/** Политика по умолчанию и в API. */
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
