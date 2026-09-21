// lang-filter.ts — опции фильтра языка рейтинга (В4.7, П2; круг 2 — Р2.1, Р2.2).
// Чистый модуль без React и uikit-рантайма: его проверяют тесты поведения.
import type { SelectOption } from "@gravity-ui/uikit";
import type { RatingResponse } from "./api";

/**
 * Значение опции «язык не определен» (`lang=` пустым в URL). Опции «все» нет:
 * все языки — это «ничего не выбрано» (параметра `lang` нет), решение владельца.
 */
export const LANG_NONE = " none";
export const LANG_NONE_TITLE = "не определен";

export interface LangOptionData {
  title: string;
  count: number | null;
  color: string | null;
}

export type Facets = RatingResponse["facets"]["languages"];

/**
 * Опции фильтра языка — из фасетов (по всему каталогу, без языкового
 * фильтра). Выбранный язык, которого нет в фасетах (старая ссылка на язык,
 * ушедший из каталога), остаётся опцией: иначе его нельзя было бы снять.
 * Круг 2 (Р2.2): «не определен» — всегда последней строкой, остальные — в
 * порядке фасетов (по убыванию числа, затем по имени).
 */
export function langOptions(facets: Facets, selected: string[]): SelectOption<LangOptionData>[] {
  const options: SelectOption<LangOptionData>[] = facets.map((f) => ({
    value: f.language === null ? LANG_NONE : f.language,
    text: f.language ?? LANG_NONE_TITLE,
    data: { title: f.language ?? LANG_NONE_TITLE, count: f.count, color: f.color },
  }));
  for (const value of selected) {
    if (!options.some((o) => o.value === value)) {
      const title = value === LANG_NONE ? LANG_NONE_TITLE : value;
      options.push({ value, text: title, data: { title, count: null, color: null } });
    }
  }
  return [...options.filter((o) => o.value !== LANG_NONE), ...options.filter((o) => o.value === LANG_NONE)];
}
