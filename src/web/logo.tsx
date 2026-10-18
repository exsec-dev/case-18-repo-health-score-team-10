import type { SVGProps } from "react";

export const PRODUCT_NAME = "HealthCraft";

const MARK_RED = "#ff3333";
const MARK_VIEW_BOX = "0 0 28 28";

// Скобы «<» и «>» — рамка знака SourceCraft без изменений, сетка 28 × 28.
const FRAME_PATH =
  "M0 5.6L8.313 0L5.963 10.934L1.4 14L12.469 21.438L8.313 28L0 22.4Z" +
  "M24.293 12.45L26.6 14L15.53 21.438L19.687 28L28 22.4L28 6.563Z";

// Плюс на месте кавычек SourceCraft: перекладина на высоте их верхней
// перекладины, вертикаль 70% ширины с наклоном их штрихов (~12°), штрих 4,6.
// Концы перекладины параллельны скобам, зазор до скоб 2,81 — как у кавычек.
const PLUS_PATH =
  "M16.161 0.933L20.866 0.933L20.228 3.9L26.354 3.9L23.457 8.5L19.239 8.5" +
  "L18.601 11.467L13.896 11.467L14.534 8.5L9.362 8.5L10.351 3.9L15.523 3.9Z";

/** Знак в меню: красные скобы, плюс цвета бренда (белый в темной теме, черный в светлой). */
export function HealthCraftMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={MARK_VIEW_BOX} fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d={FRAME_PATH} fill={MARK_RED} />
      <path d={PLUS_PATH} style={{ fill: "var(--g-color-base-brand)" }} />
    </svg>
  );
}

// favicon — как у SourceCraft: тот же рисунок белым в красном круге
// (знак занимает 160,668 из 240, сдвиг 39,666).
export const HEALTHCRAFT_MARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" fill="none">` +
  `<circle cx="120" cy="120" r="120" fill="${MARK_RED}"/>` +
  `<g transform="translate(39.666 39.666) scale(5.738)" fill="#fff">` +
  `<path d="${FRAME_PATH}"/><path d="${PLUS_PATH}"/>` +
  `</g>` +
  `</svg>`;
