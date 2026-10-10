import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cascade, classify, contrast, stripDeclarations } from "../design-system/tokens.mjs";

describe("design-system tokens", () => {
  it("applies the files in order, :root to both themes and dark only to dark", () => {
    const maps = cascade([
      `:root,[data-theme="light"]{--bg:#FFFFFF;--ink:#111111}[data-theme="dark"]{--bg:#000000}`,
      // A later layer on :root,[data-theme] overrides both themes, then its own dark block wins for dark.
      `:root,[data-theme]{--bg:#F7F6FA;--ink:var(--bg)}[data-theme="dark"]{--bg:#0E0E11}`,
      `@media (prefers-reduced-motion: reduce){:root{--bg:#123456}}`,
    ]);
    assert.equal(maps.light.get("bg"), "#F7F6FA");
    assert.equal(maps.dark.get("bg"), "#0E0E11");
    assert.equal(maps.light.get("ink"), "var(--bg)");
  });

  it("keeps colour references as aliases and resolves shadows to literals", () => {
    const { colors, shadows } = classify(cascade([
      `:root{--surface:#ffffff;--card:var(--surface);--line:rgba(35,28,55,.08);--ring-glass:inset 0 0 0 1px var(--line);--brand-gradient:linear-gradient(red,blue)}`,
      `[data-theme="dark"]{--surface:#1D1C20;--line:rgba(255,255,255,.08)}`,
    ]));
    assert.deepEqual(colors.find((c) => c.name === "card")?.value, "{surface}");
    assert.deepEqual(colors.find((c) => c.name === "surface")?.value, { light: "#ffffff", dark: "#1d1c20" });
    assert.deepEqual(shadows.find((s) => s.name === "ring-glass")?.value, {
      light: "inset 0 0 0 1px rgba(35,28,55,.08)",
      dark: "inset 0 0 0 1px rgba(255,255,255,.08)",
    });
    assert.equal(colors.some((c) => c.name === "brand-gradient"), false);
  });

  it("measures contrast with translucent text blended over its ground", () => {
    assert.equal(contrast("#000000", "#ffffff").toFixed(0), "21");
    assert.ok(contrast("rgba(255,255,255,.43)", "#0e0e11") < 4.5);
  });

  it("strips declared tokens and the rules they leave empty", () => {
    const { css, removed } = stripDeclarations(
      `@layer theme{:root,:host{--font-sans:Inter;--radius-md:8px;--spacing:.25rem}}.a{color:var(--bg-canvas)}:root{--bg-canvas:#fff}`,
      new Set(["font-sans", "radius-md", "bg-canvas"]),
    );
    assert.equal(removed, 3);
    assert.equal(css, `@layer theme{:root,:host{--spacing:.25rem}}.a{color:var(--bg-canvas)}`);
  });
});
