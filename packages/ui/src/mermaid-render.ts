import { type ProseLang, proseText } from "./prose-text.ts";

type Mermaid = typeof import("mermaid")["default"];
type MermaidConfig = Parameters<Mermaid["initialize"]>[0];

export type ThemeMode = "light" | "dark";

/** Token màu của app mà sơ đồ dùng; tên theo docs/design-system/tokens.json. */
export interface MermaidTokens {
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  primary: string;
  primaryForeground: string;
  border: string;
  warning: string;
  warningSoft: string;
  success: string;
  destructive: string;
  destructiveSoft: string;
  fontFamily: string;
}

/** Giá trị dự phòng khi chưa có CSS (test, trang chưa nạp styles): trùng tokens.json. */
export const FALLBACK_TOKENS: Record<ThemeMode, MermaidTokens> = {
  light: {
    foreground: "#0F1B31",
    card: "#FFFFFF",
    muted: "#EEF2F8",
    mutedForeground: "#55627A",
    accent: "#E6EEFF",
    primary: "#1C58FF",
    primaryForeground: "#FFFFFF",
    border: "#E2E7F0",
    warning: "#B45309",
    warningSoft: "#FFF4DB",
    success: "#16803D",
    destructive: "#C81E1E",
    destructiveSoft: "#FDECEC",
    fontFamily: '"Be Vietnam Pro", system-ui, sans-serif',
  },
  dark: {
    foreground: "#E8ECF8",
    card: "#111E36",
    muted: "#17253F",
    mutedForeground: "#8FA3C7",
    accent: "#16305A",
    primary: "#3FA9FF",
    primaryForeground: "#0A1322",
    border: "#1F2F4D",
    warning: "#FBBF24",
    warningSoft: "#3A2E10",
    success: "#4ADE80",
    destructive: "#F87171",
    destructiveSoft: "#3A1D24",
    fontFamily: '"Be Vietnam Pro", system-ui, sans-serif',
  },
};

export function currentMode(): ThemeMode {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** mermaid (khroma) chỉ đọc hex/rgb/hsl: biến CSS dạng khác (oklch, var lồng) thì dùng giá trị dự phòng. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

/** Đọc token đang áp dụng trên trang để sơ đồ đổi theo giao diện mà không chép màu vào mermaid. */
export function readTokens(mode: ThemeMode = currentMode()): MermaidTokens {
  const fallback = FALLBACK_TOKENS[mode];
  if (typeof document === "undefined") return fallback;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, dflt: string) => {
    const value = css.getPropertyValue(name).trim();
    return COLOR.test(value) ? value : dflt;
  };
  return {
    foreground: color("--foreground", fallback.foreground),
    card: color("--card", fallback.card),
    muted: color("--muted", fallback.muted),
    mutedForeground: color("--muted-foreground", fallback.mutedForeground),
    accent: color("--accent", fallback.accent),
    primary: color("--primary", fallback.primary),
    primaryForeground: color("--primary-foreground", fallback.primaryForeground),
    border: color("--border", fallback.border),
    warning: color("--warning", fallback.warning),
    warningSoft: color("--warning-soft", fallback.warningSoft),
    success: color("--success", fallback.success),
    destructive: color("--destructive", fallback.destructive),
    destructiveSoft: color("--destructive-soft", fallback.destructiveSoft),
    fontFamily: css.getPropertyValue("--font-sans").trim() || fallback.fontFamily,
  };
}

/**
 * Cấu hình mermaid theo token của app. Dùng theme `base` (chỉ theme này nhận themeVariables), nền node là màu accent nhạt,
 * viền và mũi tên theo màu chính; nền sơ đồ do khung của component quyết định nên svg được bỏ nền (stripSvgBackground).
 */
export function mermaidConfig(mode: ThemeMode, tokens: MermaidTokens = FALLBACK_TOKENS[mode]): MermaidConfig {
  return {
    startOnLoad: false,
    // mermaid tự lọc HTML và tắt sự kiện click trong sơ đồ (nội dung là chữ của người dùng).
    securityLevel: "strict",
    theme: "base",
    fontFamily: tokens.fontFamily,
    themeVariables: {
      darkMode: mode === "dark",
      background: tokens.card,
      fontFamily: tokens.fontFamily,
      fontSize: "14px",
      textColor: tokens.foreground,
      primaryColor: tokens.accent,
      primaryTextColor: tokens.foreground,
      primaryBorderColor: tokens.primary,
      secondaryColor: tokens.muted,
      secondaryTextColor: tokens.foreground,
      secondaryBorderColor: tokens.border,
      tertiaryColor: tokens.card,
      tertiaryTextColor: tokens.foreground,
      tertiaryBorderColor: tokens.border,
      lineColor: tokens.mutedForeground,
      mainBkg: tokens.accent,
      nodeBorder: tokens.primary,
      nodeTextColor: tokens.foreground,
      clusterBkg: tokens.muted,
      clusterBorder: tokens.border,
      titleColor: tokens.foreground,
      edgeLabelBackground: tokens.card,
      noteBkgColor: tokens.warningSoft,
      noteTextColor: tokens.foreground,
      noteBorderColor: tokens.warning,
      actorBkg: tokens.accent,
      actorBorder: tokens.primary,
      actorTextColor: tokens.foreground,
      actorLineColor: tokens.mutedForeground,
      signalColor: tokens.mutedForeground,
      signalTextColor: tokens.foreground,
      labelBoxBkgColor: tokens.muted,
      labelBoxBorderColor: tokens.border,
      labelTextColor: tokens.foreground,
      loopTextColor: tokens.foreground,
      activationBkgColor: tokens.muted,
      activationBorderColor: tokens.primary,
      sequenceNumberColor: tokens.primaryForeground,
      errorBkgColor: tokens.destructiveSoft,
      errorTextColor: tokens.destructive,
    },
  };
}

let loading: Promise<Mermaid> | null = null;
/** mermaid.initialize và render dùng chung trạng thái toàn cục: xếp hàng để hai sơ đồ khác theme không đè cấu hình nhau. */
let queue: Promise<unknown> = Promise.resolve();

/** Bỏ nền trắng mermaid gắn vào <svg>: nền do khung quyết định (sáng/tối). */
export function stripSvgBackground(svg: string): string {
  return svg.replace(/(<svg\b[^>]*\bstyle="[^"]*?)background-color:\s*[^;"]+;?\s*/, "$1");
}

/** Vẽ sơ đồ Mermaid thành SVG. Thư viện nặng nên chỉ tải khi trang có sơ đồ. */
export function renderMermaid(id: string, code: string, mode: ThemeMode = currentMode()): Promise<string> {
  const run = async () => {
    loading ??= import("mermaid").then((m) => m.default);
    const mermaid = await loading;
    mermaid.initialize(mermaidConfig(mode, readTokens(mode)));
    // Kiểm cú pháp trước: render lỗi để lại khung báo lỗi trong <body>.
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    return stripSvgBackground(svg);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/** Thông báo lỗi gọn; dòng đầu của lỗi mermaid giữ làm chi tiết vì nói rõ ký tự gây lỗi. */
export function describeMermaidError(error: unknown, lang: ProseLang = "vi"): { message: string; detail: string } {
  const t = proseText[lang];
  const raw = error instanceof Error ? error.message : String(error);
  const line = /line (\d+)/i.exec(raw)?.[1];
  return {
    message: line ? t.syntaxErrorAt(Number(line)) : t.syntaxError,
    detail: raw
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 3)
      .join("\n"),
  };
}
