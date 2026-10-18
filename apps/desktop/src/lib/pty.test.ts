import { TERMINAL_PALETTES } from "@xdev-hive/ui/terminal-theme";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTermFontSize,
  getTermThemePref,
  openTermLink,
  setTermFontSize,
  setTermThemePref,
  termTheme,
} from "@/lib/pty.ts";

afterEach(() => {
  setTermThemePref("dark");
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--card");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("termTheme", () => {
  it("follows the light/dark mode with a full ANSI palette when set to follow the app", () => {
    setTermThemePref("app");
    const light = termTheme();
    document.documentElement.classList.add("dark");
    const dark = termTheme();
    expect(light.background).not.toBe(dark.background);
    expect(light.red).not.toBe(dark.red);
    expect(dark.brightBlack).toBeTruthy();
  });

  it("is dark by default, even in a light app", () => {
    localStorage.clear();
    expect(getTermThemePref()).toBe("dark");
    expect(termTheme().background).toBe(TERMINAL_PALETTES.dark.background);
  });

  it("does not take the light page's card colour for a dark terminal", () => {
    document.documentElement.style.setProperty("--card", "#ffffff");
    setTermThemePref("dark");
    expect(termTheme().background).toBe(TERMINAL_PALETTES.dark.background);
  });

  it("can stay light in a dark app", () => {
    document.documentElement.classList.add("dark");
    setTermThemePref("light");
    expect(termTheme().background).toBe(TERMINAL_PALETTES.light.background);
  });

  it("remembers the choice and ignores unknown stored values", () => {
    setTermThemePref("light");
    expect(getTermThemePref()).toBe("light");
    localStorage.setItem("hive.terminal.theme", "neon");
    expect(getTermThemePref()).toBe("dark");
  });
});

describe("font size", () => {
  it("falls back to the default for values outside the list", () => {
    localStorage.setItem("hive.terminal.fontSize", "99");
    expect(getTermFontSize()).toBe(13);
  });

  it("remembers the chosen size", () => {
    setTermFontSize(16);
    expect(getTermFontSize()).toBe(16);
  });
});

describe("openTermLink", () => {
  it("opens only http(s) links", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = new MouseEvent("click");
    openTermLink(event, "https://hive.xdev.vn/docs");
    openTermLink(event, "file:///etc/passwd");
    openTermLink(event, "javascript:alert(1)");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://hive.xdev.vn/docs", "_blank", "noopener,noreferrer");
  });
});
