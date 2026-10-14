// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  describeMermaidError,
  FALLBACK_TOKENS,
  mermaidConfig,
  readTokens,
  stripSvgBackground,
} from "./mermaid-render.ts";

describe("mermaid theme", () => {
  it("follows light/dark mode and the design tokens", () => {
    const light = mermaidConfig("light");
    const dark = mermaidConfig("dark");
    expect(light.theme).toBe("base");
    expect(light.themeVariables?.darkMode).toBe(false);
    expect(dark.themeVariables?.darkMode).toBe(true);
    expect(light.themeVariables?.primaryBorderColor).toBe(FALLBACK_TOKENS.light.primary);
    expect(dark.themeVariables?.primaryBorderColor).toBe(FALLBACK_TOKENS.dark.primary);
    expect(light.themeVariables?.textColor).not.toBe(dark.themeVariables?.textColor);
  });

  it("keeps mermaid in strict mode so user text cannot inject HTML", () => {
    expect(mermaidConfig("light").securityLevel).toBe("strict");
  });

  it("uses the app UI font", () => {
    const config = mermaidConfig("light", { ...FALLBACK_TOKENS.light, fontFamily: "Inter, sans-serif" });
    expect(config.fontFamily).toBe("Inter, sans-serif");
    expect(config.themeVariables?.fontFamily).toBe("Inter, sans-serif");
  });
});

describe("readTokens", () => {
  it("reads CSS variables from the page and falls back for values mermaid cannot parse", () => {
    document.documentElement.style.setProperty("--primary", "#123456");
    document.documentElement.style.setProperty("--border", "oklch(0.9 0 0)");
    const tokens = readTokens("light");
    expect(tokens.primary).toBe("#123456");
    expect(tokens.border).toBe(FALLBACK_TOKENS.light.border);
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--border");
  });
});

describe("svg and errors", () => {
  it("drops the background mermaid paints on the svg", () => {
    expect(stripSvgBackground('<svg id="a" style="max-width: 10px; background-color: white;"><g/></svg>')).toBe(
      '<svg id="a" style="max-width: 10px; "><g/></svg>',
    );
  });

  it("explains syntax errors briefly in Vietnamese with the offending line", () => {
    const error = new Error("Parse error on line 3:\n...A --> \n-----^\nExpecting 'SEMI'");
    const out = describeMermaidError(error, "vi");
    expect(out.message).toBe("Sơ đồ có lỗi cú pháp ở dòng 3");
    expect(out.detail).toContain("Parse error on line 3");
    expect(describeMermaidError(new Error("boom"), "vi").message).toBe("Sơ đồ có lỗi cú pháp");
    expect(describeMermaidError(error, "en").message).toBe("The diagram has a syntax error on line 3");
  });
});
