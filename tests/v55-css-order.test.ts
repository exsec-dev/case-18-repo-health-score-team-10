// In the production bundle our layout.css must come AFTER the CSS of uikit components
// (they import their CSS inside their JS modules); otherwise uikit wins every
// equal-specificity override: blue external-link icon in the rating, plain rank and index
// numbers, 430px placeholders. Dev mode loads CSS in another order, so only a production
// build shows it. Behavioral: build the real production bundle and check the order.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("production CSS bundle: our styles after uikit component styles", () => {
  test("no uikit component rule below the first rule of layout.css", async () => {
    const out = mkdtempSync(join(tmpdir(), "rh-css-order-"));
    try {
      const res = await Bun.build({ entrypoints: ["src/web/index.html"], outdir: out, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
      expect(res.success).toBe(true);
      const css = readdirSync(out).filter((f) => f.endsWith(".css"));
      expect(css.length).toBe(1);
      const text = readFileSync(join(out, css[0]!), "utf8");
      const ours = text.indexOf(".rh-page");
      expect(ours).toBeGreaterThan(0);
      // component rules of uikit/navigation, e.g. ".g-link_view_normal{", ".gn-aside-header__aside{";
      // our own layout.css overrides that start with ".g-" always mention ".rh-" in the same selector
      const tail = text.slice(ours);
      const foreign = [...tail.matchAll(/\}((?:\.g|\.gn)-[^{}]*)\{/g)].map((m) => m[1]!).filter((sel) => !sel.includes(".rh-") && !sel.startsWith(".g-alert.g-card_theme_info") && !sel.startsWith(".g-help-mark"));
      expect(foreign).toEqual([]);
      // concrete overrides that were lost this way
      expect(text.indexOf(".rh-rating-ext")).toBeGreaterThan(text.indexOf(".g-link_view_normal"));
      expect(text.indexOf(".rh-empty.g-placeholder-container")).toBeGreaterThan(text.indexOf(".g-placeholder-container_direction_row"));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
