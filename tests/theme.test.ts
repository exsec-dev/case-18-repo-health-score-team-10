// theme.test.ts — палитра В4.6 (блок Б1, контракт У37) проверяется
// АРИФМЕТИКОЙ по src/web/theme.css, а не рендером: снимков светлой темы в
// харнессе нет и не будет (решение владельца 20.09 — `shot.ts` снимает одну
// тему), значит доступность светлой темы обязана подтверждаться расчётом.
// Ограничение названо здесь и в отчёте вехи, а не замалчивается.
//
// Сверка идёт с ОЖИДАЕМОЙ таблицей значений палитрового раунда
// (reports/2026-09-20-ui-card-layout-and-palette-round.md часть 3), а не с
// голым порогом: «≥ 4,5» пропустило бы случайное потемнение токена мимо
// решения владельца. Модель композитинга сверена с пикселем в самом раунде
// на трёх контрольных точках, и на «до»-палитре этот же расчёт повторил все
// 23 пары отчёта до второго знака.
import { describe, expect, test } from "bun:test";
import { contrast, flatten, hex, pageBackground, parseColor, progressFill, progressTrack, textOnChip, textOnPage, themeTokens } from "./theme-contrast";

/** Порог WCAG: проза и числа мельче 18.66px bold — AA 4.5:1. */
const AA = 4.5;
/** Порог WCAG 1.4.11: нетекстовая графика (полосы, фокус-ринг) — 3:1. */
const GRAPHICS = 3;

// ---------------------------------------------------------------------------
// Ожидаемые значения — дословно из таблиц палитрового раунда.
// ---------------------------------------------------------------------------

/** Заливка `Progress` против дорожки (дорожка = base-generic на фоне страницы). */
const BARS: Record<"dark" | "light", Record<string, number>> = {
  dark: { positive: 4.4, warning: 6.19, danger: 3.47, misc: 3.08 },
  light: { positive: 3.07, warning: 3.5, danger: 4.15, misc: 3.93 },
};

/** Цветной текст против фона страницы. */
const TEXT: Record<"dark" | "light", Record<string, number>> = {
  dark: {
    "--g-color-text-secondary": 5.34,
    "--g-color-text-positive": 6.01,
    "--g-color-text-positive-heavy": 6.53,
    "--g-color-text-danger": 5.16,
    "--g-color-text-danger-heavy": 5.95,
    "--g-color-text-warning": 8.18,
    "--g-color-text-warning-heavy": 8.81,
    "--g-color-text-misc": 4.21,
    "--g-color-text-misc-heavy": 5.55,
    "--g-color-text-link": 5.37,
    "--g-color-text-complementary": 7,
    "--g-color-text-primary": 9.48,
  },
  light: {
    "--g-color-text-secondary": 5.32,
    "--g-color-text-positive": 5.14,
    "--g-color-text-positive-heavy": 5.94,
    "--g-color-text-danger": 4.63,
    "--g-color-text-danger-heavy": 6.32,
    "--g-color-text-warning": 4.97,
    "--g-color-text-warning-heavy": 5.8,
    "--g-color-text-misc": 5.59,
    "--g-color-text-misc-heavy": 7.09,
    "--g-color-text-link": 5.21,
    "--g-color-text-complementary": 8.52,
    "--g-color-text-primary": 15.08,
  },
};

/** Текст НА ЧИПЕ `Label theme=…`: фон чипа — base-<тон>-light поверх страницы. */
const CHIPS: Record<"dark" | "light", [label: string, token: string, tone: string, expected: number][]> = {
  dark: [
    ["success", "--g-color-text-positive-heavy", "positive", 4.71],
    ["warning", "--g-color-text-warning-heavy", "warning", 5.49],
    ["danger", "--g-color-text-danger-heavy", "danger", 4.92],
    ["normal", "--g-color-text-misc-heavy", "misc", 4.46],
    ["unknown", "--g-color-text-complementary", "neutral", 5.45],
  ],
  light: [
    ["success", "--g-color-text-positive-heavy", "positive", 5.26],
    ["warning", "--g-color-text-warning-heavy", "warning", 5.27],
    ["danger", "--g-color-text-danger-heavy", "danger", 4.88],
    ["normal", "--g-color-text-misc-heavy", "misc", 6],
    ["unknown", "--g-color-text-complementary", "neutral", 8.1],
  ],
};

const FOCUS: Record<"dark" | "light", number> = { dark: 4.21, light: 3.99 };

/**
 * ПОПРАВКА К РАУНДУ (найдена при исполнении Б1, идёт в отчёт вехи). Раунд
 * пишет «После правки: success 4,71 … normal 4,46 … — все выше AA», но
 * 4,46 < 4,5: текст чипа `Label theme="normal"` в ТЁМНОЙ теме не дотягивает
 * до AA на 0,04. Значение токена (`--g-color-text-misc-heavy: #9ab0c2`) —
 * часть пакета, принятого владельцем 20.09, поэтому исполнитель его не
 * двигает: арифметика зафиксирована в таблице CHIPS, а исключение названо
 * здесь вместо тихой правки токена или ослабленного порога. На фоне СТРАНИЦЫ
 * тот же токен даёт 5,55:1, то есть «проза ≥ AA» приёмки не нарушена;
 * недобор живёт только на чипе, где этим токеном набрано одно-два слова
 * (модель, ключи фактов). Поднять до ≥ AA — решение владельца, не воркера.
 */
const CHIP_KNOWN_BELOW_AA: Record<"dark" | "light", string[]> = { dark: ["normal"], light: [] };

/**
 * Два сознательно принятых исключения из порогов (решение владельца 20.09) —
 * они обязаны быть ИМЕНОВАННЫМИ, иначе «проза ≥ AA» станет ложью:
 *   - `--g-color-text-misc` в тёмной теме — 4,21:1 при правиле «прозой этим
 *     токеном не набирать» (несёт служебные подписи в одну строку и иконки,
 *     для них порог 3:1);
 *   - жёлтая полоса в СВЕТЛОЙ теме берёт 3:1 только уходом в янтарь — что и
 *     сделано (#a07c00, 3,50:1), то есть исключение закрыто ценой оттенка.
 */
const KNOWN_BELOW_AA: Record<"dark" | "light", string[]> = {
  dark: ["--g-color-text-misc"],
  light: [],
};

describe.each(["dark", "light"] as const)("палитра В4.6: тема %s", (theme) => {
  const tokens = themeTokens(theme);

  test("фон и дорожка Progress — те же опорные значения, что в раунде", () => {
    const expected = theme === "dark" ? { bg: "#343434", track: "#484848" } : { bg: "#ffffff", track: "#f2f2f2" };
    expect({ bg: hex(parseColor(pageBackground(tokens))), track: hex(progressTrack(tokens)) }).toEqual(expected);
  });

  test("заливка полос непрозрачна: Progress больше не смешивает цвет с дорожкой", () => {
    const withAlpha = Object.keys(BARS[theme]).filter((tone) => parseColor(tokens.get(`--g-color-base-${tone}-medium`)!).a < 1);
    expect(withAlpha).toEqual([]);
  });

  test("контраст полос совпадает с ожидаемой таблицей раунда и берёт 3:1", () => {
    const track = progressTrack(tokens);
    const got: Record<string, number> = {};
    for (const tone of Object.keys(BARS[theme])) got[tone] = contrast(progressFill(tokens, tone), track);
    expect(got).toEqual(BARS[theme]);
    for (const [tone, value] of Object.entries(got)) {
      expect(value, `полоса ${tone} в теме ${theme}`).toBeGreaterThanOrEqual(GRAPHICS);
    }
  });

  test("контраст цветного текста совпадает с ожидаемой таблицей раунда", () => {
    const got: Record<string, number> = {};
    for (const token of Object.keys(TEXT[theme])) got[token] = textOnPage(tokens, token);
    expect(got).toEqual(TEXT[theme]);
  });

  test("проза берёт AA 4.5:1 — кроме именованных исключений владельца", () => {
    const below = Object.entries(TEXT[theme])
      .filter(([, value]) => value < AA)
      .map(([token]) => token);
    expect(below.sort()).toEqual([...KNOWN_BELOW_AA[theme]].sort());
  });

  test("текст на чипах Label выше AA (яркость чипа взята из -heavy, альфа не поднята)", () => {
    const got: Record<string, number> = {};
    for (const [label, token, tone] of CHIPS[theme]) got[label] = textOnChip(tokens, token, tone);
    expect(got).toEqual(Object.fromEntries(CHIPS[theme].map(([label, , , expected]) => [label, expected])));
    const below = Object.entries(got)
      .filter(([, value]) => value < AA)
      .map(([label]) => label);
    // единственное расхождение с прозой раунда названо в CHIP_KNOWN_BELOW_AA
    expect(below.sort()).toEqual([...CHIP_KNOWN_BELOW_AA[theme]].sort());
  });

  test("альфа чипов не поднята: base-*-light остались на .2/.15 и .3", () => {
    const alphas = ["positive", "warning", "danger", "misc"].map((tone) => parseColor(tokens.get(`--g-color-base-${tone}-light`)!).a);
    expect(alphas).toEqual(theme === "dark" ? [0.2, 0.2, 0.2, 0.2] : [0.15, 0.3, 0.15, 0.15]);
  });

  test("фокус-ринг берёт порог нетекстовой графики", () => {
    const bg = parseColor(pageBackground(tokens));
    const ring = contrast(flatten([bg, tokens.get("--g-color-line-focus")!]), bg);
    expect(ring).toBe(FOCUS[theme]);
    expect(ring).toBeGreaterThanOrEqual(GRAPHICS);
  });

  test("охранный пункт 6: полоса покрытия (misc) не унифицирована с оценкой (positive)", () => {
    expect(hex(progressFill(tokens, "misc"))).not.toBe(hex(progressFill(tokens, "positive")));
  });

  test("line-generic не тронут — разделители остаются платформенными", () => {
    expect(tokens.get("--g-color-line-generic")).toBe(theme === "dark" ? "rgba(255, 255, 255, .15)" : "rgba(0, 0, 0, .1)");
  });
});

describe("палитра В4.6: границы правки", () => {
  test("локального hex в компонентах нет: только theme.css, logo.tsx и точка языка", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dir, "..", "src", "web");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (file === "theme.css" || file === "logo.tsx" || !/\.(tsx?|css)$/.test(file)) continue;
      const src = readFileSync(join(dir, file), "utf8");
      // «#rrggbb»/«#rgb» в коде или стилях — кроме упоминаний в комментариях
      const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/.test(withoutComments)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("оба блока тем по-прежнему специфичнее стоковых (.g-root.g-root_theme_*, 0-2-0)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(import.meta.dir, "..", "src", "web", "theme.css"), "utf8");
    expect(css).toContain(".g-root.g-root_theme_dark {");
    expect(css).toContain(".g-root.g-root_theme_light {");
  });
});
