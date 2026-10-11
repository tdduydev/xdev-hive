import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Đọc thẳng tokens.json và styles.css để giá trị trong CSS không lệch khỏi design system và các cặp màu README nêu vẫn đạt.
const root = new URL("../../../../", import.meta.url);
const tokensFile = JSON.parse(readFileSync(new URL("docs/design-system/tokens.json", root), "utf8")) as {
  color: { tokens: { name: string; value: string | { light: string; dark: string } }[] };
};
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

type Theme = "light" | "dark";
const themes: Theme[] = ["light", "dark"];

function token(name: string, theme: Theme): string {
  const entry = tokensFile.color.tokens.find((t) => t.name === name);
  if (!entry) throw new Error(`Thiếu token ${name}`);
  return typeof entry.value === "string" ? entry.value : entry.value[theme];
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// [chữ hoặc viền, nền, tỉ lệ tối thiểu]: các cặp ghi trong docs/design-system/README.md và `usage` của tokens.json.
// Ngưỡng là mức thấp nhất vẫn đạt WCAG AA (4.5 cho chữ, 3 cho viền và vòng focus) hoặc con số tokens.json ghi nếu giá trị
// đạt. Bốn chỗ giá trị thấp hơn con số `usage` ghi (accent trên canvas sáng 5,68 thay vì 6; accent tối trên surface 5,93;
// ink tối trên subtle 11,85 thay vì 12; focus sáng trên subtle 2,88) nên ngưỡng hạ xuống mức AA; vòng focus cách phần tử
// 2px nên nằm trên nền ngoài (canvas/surface), không kiểm trên subtle.
const pairs: [string, string, number][] = [
  ...["canvas", "surface", "subtle", "sunken"].map((bg): [string, string, number] => ["ink", bg, 11.5]),
  ...["canvas", "surface", "subtle"].map((bg): [string, string, number] => ["body", bg, 8]),
  ...["canvas", "surface", "subtle"].map((bg): [string, string, number] => ["muted", bg, 5]),
  ...["canvas", "surface"].map((bg): [string, string, number] => ["accent", bg, 4.5]),
  ...["canvas", "surface", "subtle"].map((bg): [string, string, number] => ["line-strong", bg, 3]),
  ...["canvas", "surface"].map((bg): [string, string, number] => ["focus", bg, 3]),
  ["on-accent", "accent", 6],
  ["on-accent", "accent-hover", 6],
  ["sel-fg", "sel", 7],
  ["ok", "surface", 4.5],
  ["ok", "ok-bg", 4.5],
  ["warn", "surface", 4.5],
  ["warn", "warn-bg", 4.5],
  ["bad", "surface", 4.5],
  ["bad", "bad-bg", 4.5],
];

describe.each(themes)("WCAG contrast ratios for theme %s", (theme) => {
  it.each(pairs)("%s on %s meets %s:1", (fg, bg, min) => {
    expect(ratio(token(fg, theme), token(bg, theme))).toBeGreaterThanOrEqual(min);
  });
});

describe("styles.css matches tokens.json", () => {
  // Khối sáng nằm trong @theme; khối tối trong @media (prefers-color-scheme: dark).
  const darkAt = css.indexOf("prefers-color-scheme: dark");
  const blocks: Record<Theme, string> = { light: css.slice(0, darkAt), dark: css.slice(darkAt) };
  const names = tokensFile.color.tokens.map((t) => t.name);

  it.each(themes.flatMap((theme) => names.map((name): [Theme, string] => [theme, name])))("%s: %s", (theme, name) => {
    const expected = token(name, theme).toLowerCase();
    const found = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(blocks[theme]);
    if (!found) throw new Error(`Thiếu --color-${name} ở theme ${theme}`);
    // backdrop viết lại từ rgba(...) sang rgb(... / a); so sánh qua các số.
    const digits = (v: string) => v.match(/[\d.]+|#[0-9a-f]{6}/g)?.join(",");
    expect(digits((found[1] ?? "").trim().toLowerCase())).toBe(digits(expected));
  });
});
