// logo.tsx — знак HealthCraft. Отсылка к SourceCraft без копии их знака:
// тот же красный и тот же наклон штрихов (~12°, как у их скобок и зигзага),
// но своя форма — наклонная плитка, пересечённая белой линией пульса
// (здоровье репозитория). Цвет знака — фирменный ассет логотипа, не токен
// интерфейса: в палитру UI он не попадает.
import type { SVGProps } from "react";

export const PRODUCT_NAME = "HealthCraft";

const MARK_RED = "#ff3333";

export function HealthCraftMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* плитка с наклоном 6/28 — угол штрихов знака SourceCraft */}
      <path d="M6 1h21.5l-5.8 26H.5z" fill={MARK_RED} />
      {/* пульс: плато — пик вверх — провал — плато, штрихи того же наклона */}
      <path
        d="M3.4 15.5h5.4l2.6-8.2 3.4 13.6 2.7-9.4 1.6 4h5.3"
        stroke="#fff"
        strokeWidth={2.4}
        strokeLinejoin="miter"
        strokeLinecap="butt"
      />
    </svg>
  );
}

/** Та же разметка строкой — для favicon (data URI), без React. */
export const HEALTHCRAFT_MARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none">` +
  `<path d="M6 1h21.5l-5.8 26H.5z" fill="${MARK_RED}"/>` +
  `<path d="M3.4 15.5h5.4l2.6-8.2 3.4 13.6 2.7-9.4 1.6 4h5.3" stroke="#fff" stroke-width="2.4" stroke-linejoin="miter"/>` +
  `</svg>`;
