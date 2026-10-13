import { afterEach, describe, expect, it, vi } from "vitest";
import { getTermFontSize, openTermLink, setTermFontSize, termTheme } from "@/lib/pty.ts";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("termTheme", () => {
  it("follows the light/dark mode with a full ANSI palette", () => {
    const light = termTheme();
    document.documentElement.classList.add("dark");
    const dark = termTheme();
    expect(light.background).not.toBe(dark.background);
    expect(light.red).not.toBe(dark.red);
    expect(dark.brightBlack).toBeTruthy();
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
