import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./prose.css", import.meta.url), "utf8");
const tokens = JSON.parse(
  readFileSync(new URL("../../../docs/design-system/tokens.json", import.meta.url), "utf8"),
) as {
  color: { tokens: { name: string; value: { light: string; dark: string } }[] };
};

/** Lấy khai báo `--name: value` trong khối `:root {…}` hay `.dark {…}` của prose.css. */
function vars(selector: string): Record<string, string> {
  const block = new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? "").trim()]));
}

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
const token = (name: string, mode: "light" | "dark") => {
  const value = tokens.color.tokens.find((t) => t.name === name)?.value[mode];
  if (!value) throw new Error(`thiếu token ${name}`);
  return value;
};

describe("syntax colors", () => {
  for (const [mode, selector, bgToken] of [
    ["light", ":root", "muted"],
    ["dark", ".dark", "background"],
  ] as const) {
    it(`reach WCAG AA on the code background (${mode})`, () => {
      const v = vars(selector);
      const bg = token(bgToken, mode);
      expect(v["code-bg"]).toBe(`var(--${bgToken})`);
      const colors = Object.entries(v).filter(([k]) => k === "code-fg" || k.startsWith("syn-"));
      expect(colors.length).toBeGreaterThanOrEqual(10);
      for (const [name, value] of colors) expect(ratio(value, bg), `${mode} --${name}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
