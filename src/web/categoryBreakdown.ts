// Разбивка балла категории для карточки (вариант C1 «Счет из веса», 18.10.2026).
//
// Единица раскрытия — баллы категории (сумма весов = 100): у показателя одно
// число «N из веса», и строки складываются в балл категории без формулы.
// Правила — те же, что у расчета (`score/compute.ts`):
//  - вес показателя без балла (нет данных, бонус тестов не применен) делится
//    между остальными пропорционально их весам — как `weighted()`;
//  - README составной: файл 0,3, объем 0,35, описанные шаги 0,35 (README_SPLIT,
//    README_QUALITY_SPLIT; шаги — установка, сборка, тесты по трети);
//  - поправки малой выборки (мало задач, мало кода) меняют балл после суммы
//    показателей — на карточке это отдельная строка: остаток «балл − сумма».
// Справочные показатели в балл не входят и идут отдельным списком.

import type { RepoCard } from "../api/repos";
import { displayOnly, fmtKb, submetricContext, submetricShownParts, submetricTitle, subweightKey } from "../report/submetrics";
import { fmtDecimal } from "./format";
import { README_QUALITY_SPLIT, README_SPLIT, SUBWEIGHTS, type CategoryKey } from "../score/model";

export interface BreakdownPart {
  title: string;
  value: string;
  earned: number;
  weight: number;
}

export interface BreakdownRow {
  sub: string;
  title: string;
  value: string;
  /** пояснение к значению (было скобкой в значении) — в подсказку строки */
  aside: string | null;
  /** counted — в балле; excluded — значение есть, но в балл не входит (нет балла) */
  state: "counted" | "excluded";
  /** балл показателя 0..1; null — вне расчета */
  score: number | null;
  /** вес в баллах категории после перераспределения; null — вне расчета */
  weight: number | null;
  /** набрано баллов категории; null — вне расчета */
  earned: number | null;
  /** части README; null — показатель не составной */
  parts: BreakdownPart[] | null;
}

export interface CategoryBreakdown {
  rows: BreakdownRow[];
  /** справочные: в балл не входят */
  refs: { sub: string; title: string; value: string; aside: string | null }[];
  /** сумма набранного по показателям */
  sum: number;
  /** поправка к сумме (балл − сумма), если она заметна (от 0,5); иначе null */
  adjustment: number | null;
}

const README_STEPS: [key: "install" | "build" | "test", word: string][] = [
  ["install", "установка"],
  ["build", "сборка"],
  ["test", "тесты"],
];

/**
 * Части README в баллах категории: файл, объем, описанные шаги; объем — остатком,
 * чтобы части сходились с баллом показателя. Наличие файла — по самому баллу, как
 * в расчете (`compute`: без файла балл 0, с файлом — не ниже доли наличия): факт
 * README мог не собраться, а файл засчитан по наличию в корне.
 */
function readmeParts(value: unknown, weight: number, earned: number, score: number): BreakdownPart[] {
  const v = (value ?? {}) as { bytes?: unknown; flags?: Record<string, unknown>; present?: unknown };
  const present = score >= README_SPLIT.presence - 1e-9;
  // объем и шаги известны, только если факт README собран
  const known = present && v.present !== false && typeof v.bytes === "number";
  const fileW = weight * README_SPLIT.presence;
  const sizeW = weight * README_SPLIT.quality * README_QUALITY_SPLIT.bytes;
  const stepsW = weight * README_SPLIT.quality * README_QUALITY_SPLIT.sections;
  const described = README_STEPS.filter(([k]) => v.flags?.[k] === true).map(([, w]) => w);
  const file = present ? fileW : 0;
  const steps = known ? (stepsW * described.length) / README_STEPS.length : 0;
  const size = Math.max(0, Math.min(sizeW, earned - file - steps));
  const stepsValue = !known ? "–" : described.length === 0 ? "не описаны" : described.length === README_STEPS.length ? "описаны" : `описаны: ${described.join(", ")}`;
  return [
    { title: "Файл", value: present ? "есть" : "нет", earned: file, weight: fileW },
    { title: "Объем", value: known ? fmtKb(v.bytes as number) : "–", earned: size, weight: sizeW },
    { title: "Шаги: установка, сборка, тесты", value: stepsValue, earned: steps, weight: stepsW },
  ];
}

export function categoryBreakdown(card: RepoCard, key: CategoryKey): CategoryBreakdown | null {
  const cat = card.score?.categories[key];
  if (!cat || cat.score === null || cat.score === undefined) return null;
  const weights = SUBWEIGHTS[key as keyof typeof SUBWEIGHTS] as Record<string, number> | undefined;
  if (!weights) return null;
  const ctx = submetricContext(card.score?.computedAt);
  const entries = Object.entries(cat.submetrics);
  const shown = (sub: string, entry: (typeof entries)[number][1]) => submetricShownParts(key, sub, entry, ctx);

  const weighted = entries.filter(([sub]) => !displayOnly(key, sub) && weights[subweightKey(sub)] !== undefined);
  // нет ни одного показателя из методики (например, «Задачи не ведутся» — минимум
  // категории одним показателем): балл держат показатели с баллом, поровну
  const fallback = weighted.length === 0;
  const scored = fallback ? entries.filter(([sub, e]) => !displayOnly(key, sub) && e.score !== null && e.score !== undefined) : weighted;
  const weightOf = (sub: string): number => (fallback ? 1 : weights[subweightKey(sub)]!);
  const counted = scored.filter(([, e]) => e.score !== null && e.score !== undefined);
  const total = counted.reduce((a, [sub]) => a + weightOf(sub), 0);

  const rows: BreakdownRow[] = scored.map(([sub, e]) => {
    const title = submetricTitle(key, sub);
    if (e.score === null || e.score === undefined || total === 0) {
      const { value, aside } = shown(sub, e);
      return { sub, title, value, aside, state: "excluded", score: null, weight: null, earned: null, parts: null };
    }
    const weight = (weightOf(sub) / total) * 100;
    const earned = weight * e.score;
    const parts = key === "documentation" && sub === "readme" ? readmeParts(e.value, weight, earned, e.score) : null;
    const { value, aside } = shown(sub, e);
    return { sub, title: parts ? "README" : title, value: parts ? "" : value, aside: parts ? null : aside, state: "counted", score: e.score, weight, earned, parts };
  });
  const refs = entries.filter(([sub]) => displayOnly(key, sub)).map(([sub, e]) => ({ sub, title: submetricTitle(key, sub), ...shown(sub, e) }));
  const sum = rows.reduce((a, r) => a + (r.earned ?? 0), 0);
  const diff = cat.score - sum;
  return {
    rows,
    refs,
    sum,
    adjustment: Math.abs(diff) >= 0.5 ? diff : null,
  };
}

/** «29,3», «25,0» — баллы категории с одним знаком; ноль после запятой не срезается: в столбце «25» и «7,9» стояли бы разряд мимо разряда. */
export function fmtPoints(v: number): string {
  // 29,25 после умножения весов – это 29,2499…: без сдвига строки «29,2 + 25»
  // не сходились бы с суммой «54,3»
  return fmtDecimal(Math.round(v * 10 + 1e-6) / 10, 1);
}

/** «+6,2», «−40,0» — поправка с тем же знаком после запятой. */
export function fmtSignedPoints(v: number): string {
  const s = fmtPoints(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}
