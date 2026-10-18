// illustrations.tsx — иллюстрации пустых состояний в визуальном языке заглушек
// SourceCraft: 120×120, без цвета и градиентов. Фон — рваная угловатая фигура с
// вырезами основным цветом с прозрачностью 0,2; сюжет — сплошные осколки
// (треугольники и параллелограммы) с зазорами между ними, слегка под наклоном.
// Ресурсы платформы не переносим — фигуры свои. Цвет — цвет текста темы
// (layout.css, `.rh-illustration`): белый в темной, черный в светлой.
import type { SVGProps } from "react";

type IllustrationProps = SVGProps<SVGSVGElement>;

/** Фоновые фигуры: неровный контур с вырезами внутрь. */
const BACK_A = "30,40 70,18 66,44 92,30 96,54 84,96 42,90 58,74 22,82";
const BACK_B = "24,34 62,20 58,44 94,40 88,88 50,98 54,76 20,70";

function Frame({ back, children, ...props }: IllustrationProps & { back: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="rh-illustration" {...props}>
      <polygon points={back} fill="currentColor" fillOpacity={0.2} />
      <g fill="currentColor">{children}</g>
    </svg>
  );
}

/** «Не найдено» (404, репозиторий не найден): плитка, расколотая по диагонали, и черта под ней. */
export function NotFoundIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_A} {...props}>
      <polygon points="38,38 80,32 40,74" />
      <polygon points="86,38 84,78 46,82" />
      <polygon points="58,90 96,86 94,96 56,100" />
    </Frame>
  );
}

/** «Ничего не нашлось»: квадратная лупа и ручка отдельным осколком. */
export function SearchIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_B} {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M30 26 72 22 76 64 34 68Z M40 35 64 33 66 56 42 58Z" />
      <polygon points="70,70 76,64 100,90 94,96" />
    </Frame>
  );
}

/** Сравнение: три наклонных столбца по возрастанию, низ — по одной наклонной линии. */
export function CompareIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_A} {...props}>
      <polygon points="27,64 44,61 46,94 29,96" />
      <polygon points="51,46 68,42 70,91 53,93" />
      <polygon points="75,28 92,24 93,88 77,90" />
    </Frame>
  );
}

/** Нужен вход: голова-ромб и цельные плечи. */
export function IdentityIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_B} {...props}>
      <polygon points="58,22 74,36 60,52 44,38" />
      <polygon points="42,60 78,62 90,92 30,94" />
    </Frame>
  );
}

/** Пусто: открытый ящик и откинутая крышка. */
export function EmptyIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_A} {...props}>
      <polygon points="32,62 88,58 82,96 38,98" />
      <polygon points="28,50 66,34 70,42 32,58" />
      <polygon points="74,40 92,46 88,52 72,48" />
    </Frame>
  );
}

/** Готово: галочка одним сплошным осколком. */
export function SuccessIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_B} {...props}>
      <polygon points="26,60 36,50 52,66 86,28 96,38 52,84" />
    </Frame>
  );
}

/** В очереди: песочные часы из двух треугольников и основания. */
export function QueueIllustration(props: IllustrationProps) {
  return (
    <Frame back={BACK_A} {...props}>
      <polygon points="36,29 84,25 62,59" />
      <polygon points="58,59 86,89 38,93" />
      <polygon points="32,97 90,93 90,99 32,103" />
    </Frame>
  );
}
