// Арифметика контраста по WCAG 2.1 над РЕАЛЬНЫМ src/web/theme.css. Не тест, а
// хелпер для tests/theme.test.ts и tests/audit-v46-repro.test.ts.
//
// Зачем арифметика, а не рендер: харнесс снимков снимает одну тему, поэтому
// доступность светлой подтверждается расчетом. Композитинг альфы считается
// так же, как его делает браузер (sRGB, поверх фактического фона); модель
// сверена с пикселем на трех контрольных точках (#527F50 заливка, #484848
// дорожка, #546472 полоса покрытия).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = "dark" | "light";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const THEME_CSS = join(import.meta.dir, "..", "src", "web", "theme.css");

/** Все `--g-color-*` одной темы из theme.css, как они там записаны. */
export function themeTokens(theme: Theme): Map<string, string> {
  const css = readFileSync(THEME_CSS, "utf8");
  const marker = `.g-root.g-root_theme_${theme} {`;
  const from = css.indexOf(marker);
  if (from < 0) throw new Error(`theme.css: блока ${marker} нет`);
  const to = css.indexOf("\n}", from);
  const block = css.slice(from + marker.length, to < 0 ? undefined : to);
  const out = new Map<string, string>();
  for (const line of block.split("\n")) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** `#rgb`/`#rrggbb`/`rgba(r, g, b, a)` → каналы 0..255 и альфа 0..1. */
export function parseColor(raw: string): Rgba {
  const value = raw.trim();
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(value);
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  throw new Error(`не цвет: ${raw}`);
}

/** Альфа-композитинг в sRGB — то же, что делает браузер, слой поверх слоя. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Фактический цвет пикселя: цепочка слоёв, снизу вверх — `hex(layers)`. */
export function flatten(layers: (string | Rgba)[]): Rgba {
  let acc = toRgba(layers[0]!);
  for (const layer of layers.slice(1)) acc = over(toRgba(layer), acc);
  return acc;
}

function toRgba(value: string | Rgba): Rgba {
  return typeof value === "string" ? parseColor(value) : value;
}

export function hex(color: Rgba): string {
  const to = (v: number): string => Math.round(v).toString(16).padStart(2, "0");
  return `#${to(color.r)}${to(color.g)}${to(color.b)}`;
}

/** Относительная яркость WCAG 2.1 (альфа обязана быть уже снята композитингом). */
export function luminance(color: Rgba): number {
  const chan = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(color.r) + 0.7152 * chan(color.g) + 0.0722 * chan(color.b);
}

/** Контраст двух ФАКТИЧЕСКИХ цветов, с двумя знаками. */
export function contrast(a: Rgba | string, b: Rgba | string): number {
  const la = luminance(toRgba(a));
  const lb = luminance(toRgba(b));
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.round(ratio * 100) / 100;
}

/** Фон страницы темы — первый слой любой цепочки. */
export function pageBackground(tokens: Map<string, string>): string {
  const bg = tokens.get("--g-color-base-background");
  if (bg === undefined) throw new Error("theme.css: нет --g-color-base-background");
  return bg;
}

/**
 * Дорожка `Progress`: uikit кладёт `--g-color-base-generic` на фон страницы
 * (Progress.css пина 7.49.0). Заливка полосы — `--g-color-base-<theme>-medium`
 * поверх дорожки.
 */
export function progressTrack(tokens: Map<string, string>): Rgba {
  return flatten([pageBackground(tokens), tokens.get("--g-color-base-generic")!]);
}

export function progressFill(tokens: Map<string, string>, tone: string): Rgba {
  return flatten([progressTrack(tokens), tokens.get(`--g-color-base-${tone}-medium`)!]);
}

/** Текст поверх фона страницы — самый частый случай. */
export function textOnPage(tokens: Map<string, string>, token: string): number {
  const bg = parseColor(pageBackground(tokens));
  return contrast(flatten([bg, tokens.get(token)!]), bg);
}

/** Текст на чипе `Label theme=…`: фон чипа — `base-<tone>-light` на фоне страницы. */
export function textOnChip(tokens: Map<string, string>, token: string, tone: string): number {
  const chip = flatten([pageBackground(tokens), tokens.get(`--g-color-base-${tone}-light`)!]);
  return contrast(flatten([chip, tokens.get(token)!]), chip);
}
