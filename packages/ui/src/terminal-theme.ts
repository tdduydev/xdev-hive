export type TerminalMode = "light" | "dark";

/** Bảng màu xterm.js (khoá theo ITheme). Dùng chung cho terminal của app desktop và Terminal Leader trên web. */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * 16 màu ANSI cho nền `--card` của từng chế độ (tokens.json). Chế độ sáng đặt màu "bright" đậm hơn màu thường vì chữ
 * sáng hơn nền trắng thì không đọc được; mỗi màu (trừ black ở chế độ tối và white ở chế độ sáng, vốn là màu nền/chữ
 * của CLI) đạt tương phản WCAG AA 4.5:1 với nền, test ở terminal-theme.test.ts.
 */
export const TERMINAL_PALETTES: Record<TerminalMode, TerminalPalette> = {
  light: {
    background: "#FFFFFF",
    foreground: "#0F1B31",
    cursor: "#1C58FF",
    cursorAccent: "#FFFFFF",
    selectionBackground: "#BFDBFE",
    selectionInactiveBackground: "#E2E7F0",
    black: "#0F172A",
    red: "#C81E1E",
    green: "#15803D",
    yellow: "#A16207",
    blue: "#1C58FF",
    magenta: "#A21CAF",
    cyan: "#0E7490",
    white: "#64748B",
    brightBlack: "#475569",
    brightRed: "#991B1B",
    brightGreen: "#166534",
    brightYellow: "#854D0E",
    brightBlue: "#1E3A8A",
    brightMagenta: "#86198F",
    brightCyan: "#155E75",
    brightWhite: "#334155",
  },
  dark: {
    background: "#111E36",
    foreground: "#E8ECF8",
    cursor: "#3FA9FF",
    cursorAccent: "#111E36",
    selectionBackground: "#2F4A7A",
    selectionInactiveBackground: "#1F2F4D",
    black: "#64748B",
    red: "#F87171",
    green: "#4ADE80",
    yellow: "#FBBF24",
    blue: "#3FA9FF",
    magenta: "#E879F9",
    cyan: "#22D3EE",
    white: "#CBD5E1",
    brightBlack: "#94A3B8",
    brightRed: "#FCA5A5",
    brightGreen: "#86EFAC",
    brightYellow: "#FDE047",
    brightBlue: "#93C5FD",
    brightMagenta: "#F0ABFC",
    brightCyan: "#67E8F9",
    brightWhite: "#FFFFFF",
  },
};

/** Cỡ chữ chọn được trên thanh trên của terminal. */
export const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 16, 18] as const;
export const TERMINAL_DEFAULT_FONT_SIZE = 13;

/**
 * Font mono của app. xterm vẽ từng ô cố định nên ligature của font (=>, !=) làm lệch ký tự khi gõ: tắt bằng
 * `fontVariantLigatures` ở CSS của terminal, không đổi font.
 */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';

/**
 * Bảng màu theo chế độ; nền, chữ và con trỏ lấy từ token đang áp dụng trên trang (nếu có) để khớp tuỳ biến theme,
 * màu ANSI giữ cố định vì đã kiểm tương phản.
 */
export function terminalTheme(mode: TerminalMode, root?: Element | null): TerminalPalette {
  const palette = TERMINAL_PALETTES[mode];
  if (!root || typeof getComputedStyle === "undefined") return palette;
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const background = v("--card", palette.background);
  return {
    ...palette,
    background,
    cursorAccent: background,
    foreground: v("--foreground", palette.foreground),
    cursor: v("--primary", palette.cursor),
  };
}
