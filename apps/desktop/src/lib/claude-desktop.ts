import { invoke } from "@/lib/tauri.ts";

/**
 * Chuyển Claude Desktop giữa các gói Claude (src-tauri/src/claude_desktop.rs). Mọi gói dùng chung một hồ sơ Claude
 * Desktop; chuyển gói chỉ đổi phần đăng nhập, MCP, sessions và dự án trên máy giữ nguyên. Đăng nhập của từng gói lưu ở
 * `~/.xdev-hive/claude-desktop/<id>/auth`. Tính năng tại máy, không cần đăng nhập Hive. Cửa sổ chỉ gửi id gói.
 */
export interface DesktopProfile {
  id: string;
  label: string;
  email: string | null;
  /** Đã lưu đăng nhập Claude Desktop của gói; chưa thì chuyển sang sẽ mở ở màn đăng nhập. */
  saved: boolean;
  /** Gói Claude Desktop đang dùng. */
  active: boolean;
  /** Đọc được tài khoản Claude của gói (`.claude.json`) nên đăng nhập tự gắn vào gói; false thì cần ghi nhận tay. */
  accountKnown: boolean;
}

/** Tài khoản Claude Desktop đang đăng nhập. */
export interface SignedIn {
  /** Account uuid. */
  account: string;
  email: string | null;
  /** Gói có cùng tài khoản; null khi không gói nào khớp. */
  plan: string | null;
}

/** Vừa đăng nhập tài khoản không phải của gói đang chờ. */
export interface Mismatch {
  /** Email, hay uuid khi không gói nào biết tài khoản này. */
  account: string;
  /** Gói đang chờ đăng nhập. */
  expected: string;
  /** Gói đã nhận đăng nhập này; null khi chưa lưu vào đâu. */
  adopted: string | null;
}

/** Bước của lần chuyển đang chạy (src-tauri/src/claude_desktop/job.rs). */
export type SwitchStep = "preparing" | "quitting" | "forceQuitting" | "backingUp" | "swapping" | "launching";

export interface SwitchProgress {
  step: SwitchStep;
  /** Gói đang chuyển sang; null khi khôi phục bản ban đầu. */
  target: string | null;
  /** Phần trăm của bước sao lưu. */
  percent: number | null;
  /** Giây từ lúc bắt đầu. */
  elapsed: number;
  /** Đã bấm Huỷ, đang dừng. */
  cancelling: boolean;
  /** false khi đang mở lại app: đã đổi xong, không còn gì để huỷ. */
  cancellable: boolean;
}

export interface DesktopProfiles {
  /** false ngoài macOS và Windows: chưa hỗ trợ, màn không hiện gì. */
  supported: boolean;
  /** Claude Desktop tìm thấy (Claude.app, claude.exe hay gói Microsoft Store); null khi chưa cài. */
  app: string | null;
  /** Vì sao chưa chuyển được (chưa cài); null khi chuyển được. */
  note: string | null;
  /** PID Claude Desktop đang chạy; null khi đã tắt. */
  running: number | null;
  /** Bản sao lưu cả hồ sơ lúc mới dùng tính năng; null khi chưa chuyển lần nào. */
  backup: string | null;
  /** Gói còn hồ sơ riêng kiểu cũ (mỗi gói một Claude Desktop) cần đổi sang cách mới. */
  legacy: string[];
  profiles: DesktopProfile[];
  /** null khi Claude Desktop chưa đăng nhập. */
  signedIn: SignedIn | null;
  mismatch: Mismatch | null;
  /** Lần chuyển đang chạy (từ cửa sổ hay khay); null khi không có. */
  switching: SwitchProgress | null;
}

export interface Switched {
  /** `stillRunning`: Claude Desktop không thoát kịp, chưa đổi gì; hỏi người dùng có buộc thoát không. */
  status: "switched" | "already" | "stillRunning";
  /** Gói chưa lưu đăng nhập: Claude Desktop mở ở màn đăng nhập. */
  needsLogin: boolean;
}

export const desktopProfiles = () => invoke<DesktopProfiles>("claude_desktop_profiles");
/** `force`: người dùng đã đồng ý buộc thoát Claude Desktop nếu nó không tự thoát. */
export const switchClaudeDesktop = (profileId: string, force = false) =>
  invoke<Switched>("switch_claude_desktop", { profileId, force });
export const restoreClaudeDesktop = (force = false) => invoke<Switched>("restore_claude_desktop", { force });
export const adoptClaudeDesktop = (profileId: string) => invoke<DesktopProfiles>("adopt_claude_desktop", { profileId });
export const forgetClaudeDesktop = (profileId: string) =>
  invoke<DesktopProfiles>("forget_claude_desktop", { profileId });
/** Đăng xuất Claude Desktop khỏi gói đang dùng: thoát app, bỏ đăng nhập của gói, mở lại ở màn đăng nhập. */
export const signOutClaudeDesktop = (profileId: string, force = false) =>
  invoke<Switched>("sign_out_claude_desktop", { profileId, force });
export const dismissClaudeDesktopMismatch = () => invoke<DesktopProfiles>("dismiss_claude_desktop_mismatch");
export const migrateClaudeDesktopProfiles = () => invoke<DesktopProfiles>("migrate_claude_desktop_profiles");
/** Lần chuyển chạy nền nên cửa sổ hỏi tiến độ riêng; null khi đã xong. */
export const switchProgress = () => invoke<SwitchProgress | null>("claude_desktop_switch_progress");
/** false khi không còn gì để huỷ (đã xong hay đang mở lại app). */
export const cancelSwitch = () => invoke<boolean>("cancel_claude_desktop_switch");
/** Đường dẫn, cỡ và tiến trình để gửi người hỗ trợ; không có token. */
export const diagnoseClaudeDesktop = () => invoke<string>("claude_desktop_diagnose");
