import { describe, expect, it } from "vitest";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_PALETTES,
  type TerminalMode,
  type TerminalPalette,
  terminalTheme,
} from "./terminal-theme.ts";

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof TerminalPalette)[];

/** Màu chữ "mặc định" của CLI (black trên nền tối, white trên nền sáng) chỉ cần đọc được, không cần AA. */
const relaxed: Record<TerminalMode, string> = { light: "white", dark: "black" };

describe("terminal palettes", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`gives 16 distinct, readable ANSI colors (${mode})`, () => {
      const p = TERMINAL_PALETTES[mode];
      expect(new Set(ANSI.map((k) => p[k])).size).toBe(16);
      for (const k of ANSI) {
        const min = k === relaxed[mode] ? 3 : 4.5;
        expect(ratio(p[k], p.background), `${mode} ${k}`).toBeGreaterThanOrEqual(min);
      }
      expect(ratio(p.foreground, p.background)).toBeGreaterThanOrEqual(7);
      expect(ratio(p.cursor, p.background)).toBeGreaterThanOrEqual(3);
    });
  }

  it("falls back to the palette without a DOM root", () => {
    expect(terminalTheme("dark")).toBe(TERMINAL_PALETTES.dark);
  });
});

describe("terminal font", () => {
  it("keeps the app's mono font first and falls back to a Nerd Font for prompt icons", () => {
    const fonts = TERMINAL_FONT_FAMILY.split(",").map((f) => f.trim().replaceAll('"', ""));
    expect(fonts[0]).toBe("JetBrains Mono Variable");
    expect(fonts.some((f) => /Nerd Font|\bNF$/.test(f))).toBe(true);
    expect(fonts.at(-1)).toBe("monospace");
  });
});
