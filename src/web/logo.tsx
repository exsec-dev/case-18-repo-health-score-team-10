import type { SVGProps } from "react";

export const PRODUCT_NAME = "HealthCraft";

const MARK_RED = "#ff3333";
const MARK_VIEW_BOX = "0 0 28 28";

// Скобы «<» и «>» — рамка знака SourceCraft без изменений, сетка 28 × 28.
const FRAME_PATH =
  "M0 5.6L8.313 0L5.963 10.934L1.4 14L12.469 21.438L8.313 28L0 22.4Z" +
  "M24.293 12.45L26.6 14L15.53 21.438L19.687 28L28 22.4L28 6.563Z";

// Пульс на месте кавычек SourceCraft: ломаная со штрихом 2,5, полки на высоте
// внутреннего угла левой скобы (низ 10,934). Нисходящие штрихи и левый торец
// параллельны верхнему шипу левой скобы (~12°), восходящие и правый торец —
// выемке правой скобы (~32°). Зазор до скоб 2 с обеих сторон.
const PULSE_PATH =
  "M8.546 8.434L10.723 8.434L15.23 1.277L17.241 10.635L18.627 8.434L24.458 8.434" +
  "L22.884 10.934L20.007 10.934L16.087 17.16L14.075 7.802L12.103 10.934L8.009 10.934Z";

/** Знак в меню: красные скобы, пульс цвета бренда (белый в темной теме, черный в светлой). */
export function HealthCraftMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={MARK_VIEW_BOX} fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d={FRAME_PATH} fill={MARK_RED} />
      <path d={PULSE_PATH} style={{ fill: "var(--g-color-base-brand)" }} />
    </svg>
  );
}

// favicon — как у SourceCraft: тот же рисунок белым в красном круге
// (знак занимает 160,668 из 240, сдвиг 39,666).
export const HEALTHCRAFT_MARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" fill="none">` +
  `<circle cx="120" cy="120" r="120" fill="${MARK_RED}"/>` +
  `<g transform="translate(39.666 39.666) scale(5.738)" fill="#fff">` +
  `<path d="${FRAME_PATH}"/><path d="${PULSE_PATH}"/>` +
  `</g>` +
  `</svg>`;
