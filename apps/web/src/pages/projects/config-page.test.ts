import { describe, expect, it } from "vitest";
import { formatValue, parseInput } from "@/pages/projects/config-page.tsx";

describe("config page helpers", () => {
  it("shows unset values with the given label and objects as JSON", () => {
    expect(formatValue(null, "Chua dat")).toBe("Chua dat");
    expect(formatValue("review", "-")).toBe("review");
    expect(formatValue(5, "-")).toBe("5");
    expect(formatValue([{ event: "pre" }], "-")).toBe('[{"event":"pre"}]');
  });

  it("reads numbers, booleans and JSON, falls back to text, and treats blank as remove", () => {
    expect(parseInput("5")).toEqual({ value: 5 });
    expect(parseInput("false")).toEqual({ value: false });
    expect(parseInput("auto")).toEqual({ value: "auto" });
    expect(parseInput("  ")).toBeNull();
  });
});
