// «Лестница к зеленой зоне». Эффекты рекомендаций на карточке считаются по
// отдельности и не складываются (перенормировка), поэтому лестница — НАКОПИТЕЛЬНЫЙ
// пересчет: на текущих (уже подмененных) фактах считаем Δ каждого публичного
// presence-правила, берем наибольший > 0, применяем его подмену, пересчитываем
// модель и повторяем, пока ОКРУГЛЕННЫЙ HealthCraft Index не станет ≥ 70 (граница
// зоны «здоров», `scoreTheme`) или не кончатся правила с положительным Δ.
//
// Границы:
//  - только публичный канал (HealthCraft Index, 4 категории): CI/AppSec-правила
//    меняют Repo Health Score, который видит не всякий зритель, и в лестницу не входят;
//  - порядок ЖАДНЫЙ (наибольший Δ на каждом шаге), не оптимальный по числу шагов;
//  - обещается только то, что подтвердил пересчет (docs/guide/method/recommendations.md): шаг
//    с Δ ≤ 0 не выводится, как и рекомендация с «+0,0»;
//  - числа гипотетические: не хранятся в БД, не пишутся в scores/recommendations,
//    не попадают в /api/v1 — считаются при чтении карточки.
//
// Условия и подмены правил — ТА ЖЕ таблица `presencePatches`, что у движка
// рекомендаций, Δ — та же формула (`round4(после − до)`), поэтому первый шаг
// лестницы равен Δ соответствующей рекомендации карточки.
import { computeFromFacts, type ComputeInput, type Scores } from "./compute";
import { presencePatches, publicActivationRules, round4 } from "./recommend";
import { roundScore } from "../web/format";

/** Граница зоны «здоров» — по округленному показанному числу (`scoreTheme`: ≥ 70). */
export const LADDER_TARGET = 70;

/** Предохранитель цикла: правил конечное число, каждое снимает свое условие. */
export const LADDER_MAX_STEPS = 12;

export interface LadderStep {
  ruleId: string;
  /** прирост индекса ИМЕННО на этом шаге (на фактах после предыдущих шагов), round4 — как `deltaScore` рекомендации */
  delta: number;
  /** HealthCraft Index после шага (накопительно), round4; на экране — округленным, как индекс карточки */
  indexAfter: number;
}

export interface Ladder {
  /** HealthCraft Index на фактах скана, round4 (на экране — округленным) */
  start: number;
  target: typeof LADDER_TARGET;
  steps: LadderStep[];
  /** округленный индекс после последнего шага ≥ target */
  reached: boolean;
  /** почему цель не достигнута: правила с положительным Δ кончились; null — достигнута */
  unreachedReason: "no-positive-rules" | null;
  /** активационные правила (открывают категорию, числа нет) — словами отдельно */
  withoutNumber: string[];
}

const indexOf = (s: Scores): number | null => s.healthcraftIndex;

/**
 * Лестница на эффективных фактах скана. null — лестницы нет: репозиторий уже
 * в зоне (округленный индекс ≥ 70), в нем нет кода, индекса нет (NULL), либо нет
 * ни одного шага с числом и ни одного активационного правила.
 * `input` и `now` — те же, что у движка рекомендаций этого скана (`recommend`).
 */
export function ladderFromFacts(ok: Map<string, unknown>, input: ComputeInput, now: Date): Ladder | null {
  const base = computeFromFacts(ok, input, now);
  const startIndex = indexOf(base);
  if (base.codeEmpty || startIndex === null) return null;
  if (roundScore(startIndex) >= LADDER_TARGET) return null;

  const steps: LadderStep[] = [];
  let facts = ok;
  let current = base;
  let currentIndex = startIndex;
  while (steps.length < LADDER_MAX_STEPS && roundScore(currentIndex) < LADDER_TARGET) {
    let best: { ruleId: string; delta: number; facts: Map<string, unknown>; scores: Scores; index: number } | null = null;
    // условия правил — на текущих фактах (add-tests предлагается, только когда «Код» оценен)
    for (const p of presencePatches(facts, { pub: true, codeScored: current.categories.code.score !== null })) {
      if (p.channel !== null) continue;
      const next = new Map(facts);
      p.patch(next);
      const after = computeFromFacts(next, input, now);
      const a = indexOf(after);
      if (a === null) continue;
      const delta = round4(a - currentIndex);
      if (delta <= 0) continue;
      // равные Δ — по ruleId, как `orderRecommendations`
      if (best === null || delta > best.delta || (delta === best.delta && p.ruleId.localeCompare(best.ruleId) < 0)) {
        best = { ruleId: p.ruleId, delta, facts: next, scores: after, index: a };
      }
    }
    if (best === null) break;
    steps.push({ ruleId: best.ruleId, delta: best.delta, indexAfter: round4(best.index) });
    facts = best.facts;
    current = best.scores;
    currentIndex = best.index;
  }

  const withoutNumber = publicActivationRules(ok).map((a) => a.ruleId);
  if (steps.length === 0 && withoutNumber.length === 0) return null;
  const reached = roundScore(currentIndex) >= LADDER_TARGET;
  return {
    start: round4(startIndex),
    target: LADDER_TARGET,
    steps,
    reached,
    unreachedReason: reached ? null : "no-positive-rules",
    withoutNumber,
  };
}
