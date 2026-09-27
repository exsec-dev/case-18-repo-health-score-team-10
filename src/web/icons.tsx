// icons.tsx — свои иконки там, где в @gravity-ui/icons нужной нет.
//
// Trophy: в наборе Gravity кубка нет (`Cup` — чашка, `Medal` и `CrownDiamond` — не то).
// Рисунок в сетке иконок Gravity: 16×16, линия 1,5, скругленные концы. Цвет — currentColor,
// поэтому плашка лиги красит иконку цветом текста. Совместима с `Icon data={…}` uikit
// (svgr-компонент: viewBox берется из возвращаемого элемента).
import type { SVGProps } from "react";

export function Trophy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 16 16" {...props}>
      <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {/* чаша */}
        <path d="M4.75 1.75h6.5v4a3.25 3.25 0 0 1-6.5 0z" />
        {/* ручки */}
        <path d="M4.75 3.25H3.5A1.5 1.5 0 0 0 2 4.75V5a2.5 2.5 0 0 0 2.5 2.5h.6" />
        <path d="M11.25 3.25h1.25A1.5 1.5 0 0 1 14 4.75V5a2.5 2.5 0 0 1-2.5 2.5h-.6" />
        {/* ножка и подставка */}
        <path d="M8 9v3.25" />
        <path d="M5.75 12.25h4.5v2h-4.5z" />
      </g>
    </svg>
  );
}
