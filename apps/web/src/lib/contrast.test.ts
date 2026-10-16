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

/** "tên/80" là token ở độ mờ 80% trên nền `bg`, đúng màu trình duyệt vẽ cho class như `text-sidebar-foreground/80`. */
function shown(spec: string, bg: string, theme: Theme): string {
  const [name = spec, percent] = spec.split("/");
  const fg = token(name, theme);
  if (!percent) return fg;
  const alpha = Number(percent) / 100;
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const back = token(bg, theme);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(alpha * channel(fg, i) + (1 - alpha) * channel(back, i))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// [chữ hoặc viền, nền, tỉ lệ tối thiểu]: chữ 4.5 (WCAG AA), viền điều khiển, vòng focus và icon 3 (WCAG 1.4.11).
const pairs: [string, string, number][] = [
  ...["background", "card", "muted"].map((bg): [string, string, number] => ["foreground", bg, 4.5]),
  ...["background", "card", "muted"].map((bg): [string, string, number] => ["muted-foreground", bg, 4.5]),
  ...["background", "card"].map((bg): [string, string, number] => ["primary", bg, 4.5]),
  ...["background", "card"].map((bg): [string, string, number] => ["input", bg, 3]),
  ...["background", "card"].map((bg): [string, string, number] => ["ring", bg, 3]),
  ["primary-foreground", "primary", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["background", "destructive", 4.5],
  ["destructive", "card", 4.5],
  ["destructive", "destructive-soft", 4.5],
  ["success", "card", 4.5],
  ["success", "success-soft", 4.5],
  ["warning", "card", 4.5],
  ["warning", "warning-soft", 4.5],
  // Sidebar navy ở cả hai theme: chữ thường, nhãn nhóm (80%), mục rê chuột, mục đang mở, số đếm, focus.
  ["sidebar-foreground", "sidebar", 4.5],
  ["sidebar-foreground/80", "sidebar", 4.5],
  ["sidebar-foreground", "sidebar-accent", 4.5],
  ["sidebar-accent-foreground", "sidebar", 4.5],
  ["sidebar-accent-foreground", "sidebar-accent", 4.5],
  ["sidebar-accent-foreground", "sidebar-active", 4.5],
  ["sidebar-active-icon", "sidebar-active", 3],
  ["sidebar-primary-foreground", "sidebar-primary", 4.5],
  ["sidebar-ring", "sidebar", 3],
  // Trạng thái trong sidebar (chấm worker, lỗi đăng xuất) và chữ trên ô lục giác navy của agent, máy.
  ...["sidebar-success", "sidebar-warning", "sidebar-destructive"].map((fg): [string, string, number] => [
    fg,
    "sidebar",
    4.5,
  ]),
  ["sidebar-active-icon", "sidebar-accent", 4.5],
];

describe.each(themes)("WCAG contrast ratios for theme %s", (theme) => {
  it.each(pairs)("%s on %s meets %s:1", (fg, bg, min) => {
    expect(ratio(shown(fg, bg, theme), token(bg, theme))).toBeGreaterThanOrEqual(min);
  });
});

describe("styles.css matches tokens.json", () => {
  // Giá trị sáng nằm trong `:root {`, giá trị tối trong `.dark {`.
  const darkAt = css.indexOf(".dark {");
  const themeAt = css.indexOf("@theme inline");
  const blocks: Record<Theme, string> = {
    light: css.slice(css.indexOf(":root {"), darkAt),
    dark: css.slice(darkAt, themeAt),
  };
  const names = tokensFile.color.tokens.map((t) => t.name);

  it.each(themes.flatMap((theme) => names.map((name): [Theme, string] => [theme, name])))("%s: %s", (theme, name) => {
    const entry = tokensFile.color.tokens.find((t) => t.name === name);
    // Token chỉ có một giá trị (màu nền logo) không lặp lại trong khối tối.
    const block = theme === "dark" && typeof entry?.value === "string" ? blocks.light : blocks[theme];
    const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
    if (!found) throw new Error(`Thiếu --${name} ở theme ${theme}`);
    expect((found[1] ?? "").trim().toLowerCase()).toBe(token(name, theme).toLowerCase());
  });
});
