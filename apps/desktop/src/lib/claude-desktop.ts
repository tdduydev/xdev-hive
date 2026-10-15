import type { Lang } from "@/lib/i18n.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Claude Desktop theo gói Claude (src-tauri/src/claude_desktop.rs): mỗi gói một hồ sơ Claude Desktop riêng ở
 * `~/.xdev-hive/claude-desktop/<id>`, mở bằng `--user-data-dir` cạnh Claude Desktop thường. Tính năng tại máy, không
 * cần đăng nhập Hive. Cửa sổ chỉ gửi id gói; Rust tự dựng đường dẫn app và hồ sơ.
 */
export interface DesktopProfile {
  id: string;
  label: string;
  email: string | null;
  dir: string;
  /** Đã mở Claude Desktop bằng hồ sơ này ít nhất một lần; chưa thì nút ghi "Đăng nhập…". */
  used: boolean;
  bytes: number;
  cacheBytes: number;
  /** Tiến trình Claude Desktop đang dùng hồ sơ; null khi đã tắt. */
  pid: number | null;
}

export interface DesktopProfiles {
  /** false ngoài macOS: chưa hỗ trợ, màn không hiện gì. */
  supported: boolean;
  /** Claude.app tìm thấy; null khi chưa cài. */
  app: string | null;
  root: string;
  /** Vì sao chưa mở được (chưa cài); null khi mở được. */
  note: string | null;
  profiles: DesktopProfile[];
}

export interface Opened {
  /** Hồ sơ đã có Claude Desktop đang mở: Rust không mở bản thứ hai cùng ghi một hồ sơ. */
  already: boolean;
  pid: number | null;
}

export const desktopProfiles = () => invoke<DesktopProfiles>("claude_desktop_profiles");
export const openClaudeDesktop = (profileId: string) => invoke<Opened>("open_claude_desktop", { profileId });
export const resetDesktopProfile = (profileId: string) =>
  invoke<DesktopProfiles>("reset_claude_desktop_profile", { profileId });
/** Trả số byte đã giải phóng. */
export const cleanupDesktopCache = (profileId: string) => invoke<number>("claude_desktop_cleanup_cache", { profileId });

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Dung lượng gọn cho thẻ gói: 0 B, 812 KB, 1,4 GB (dấu thập phân theo ngôn ngữ). */
export function formatBytes(bytes: number, lang: Lang): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  const n = new Intl.NumberFormat(lang === "en" ? "en-US" : "vi-VN", { maximumFractionDigits: digits }).format(value);
  return `${n} ${UNITS[unit]}`;
}
