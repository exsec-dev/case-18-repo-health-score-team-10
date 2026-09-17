import type { SVGProps } from "react";

export const PRODUCT_NAME = "HealthCraft";

const MARK_RED = "#ff3333";
const MARK_VIEW_BOX = "0.75 0.75 26.5 26.5";

const MARK_PATH =
  "M14 1.2" +
  "C14.34 1.2 14.64 1.29 14.94 1.47" +
  "L23.82 6.68" +
  "C24.56 7.12 25 7.9 25 8.75" +
  "V18.25" +
  "C25 19.1 24.56 19.88 23.82 20.32" +
  "L14.94 25.53" +
  "C14.64 25.71 14.34 25.8 14 25.8" +
  "C13.66 25.8 13.36 25.71 13.06 25.53" +
  "L4.18 20.32" +
  "C3.44 19.88 3 19.1 3 18.25" +
  "V8.75" +
  "C3 7.9 3.44 7.12 4.18 6.68" +
  "L13.06 1.47" +
  "C13.36 1.29 13.66 1.2 14 1.2Z";

const PULSE_PATH =
  "M3 14.38 " +
  "H7.55 " +
  "L11.42 8.26 " +
  "L14.86 18.05 " +
  "L23.28 10.04 " +
  "H25";

const MARK_TRANSFORM = "matrix(1 0 0 1.039 0 -0.257)";

export function HealthCraftMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={MARK_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g transform={MARK_TRANSFORM}>
        <path d={MARK_PATH} fill={MARK_RED} />
        <path
          d={PULSE_PATH}
          stroke="#fff"
          strokeWidth={2.55}
          strokeLinejoin="round"
          strokeLinecap="butt"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}

export const HEALTHCRAFT_MARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEW_BOX}" fill="none">` +
  `<g transform="${MARK_TRANSFORM}">` +
  `<path d="${MARK_PATH}" fill="${MARK_RED}"/>` +
  `<path d="${PULSE_PATH}" fill="none" stroke="#fff" stroke-width="2.55" ` +
  `stroke-linejoin="round" stroke-linecap="butt" vector-effect="non-scaling-stroke"/>` +
  `</g>` +
  `</svg>`;
