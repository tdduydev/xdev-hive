/*
 * Cầu nối tới Rust qua `window.__TAURI__` (withGlobalTauri trong tauri.conf.json). Lệnh nào cửa sổ được gọi do
 * capability quyết định (src-tauri/capabilities); ở đây chỉ gói lại cho có kiểu và để test thay bằng bản giả.
 */
declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
      window?: { getCurrentWindow(): { label: string } };
    };
  }
}

/** Cửa sổ cục bộ của app: `register` (đăng ký máy) và `app` (khung AppNav). Cửa sổ web của hub không nạp file này. */
export type WindowKind = "register" | "app";

/**
 * Cửa sổ đang chạy. Ngoài Tauri (`pnpm dev:ui` trong trình duyệt) thì đọc `?window=app` để xem được cả hai màn.
 */
export function windowKind(): WindowKind {
  const label =
    window.__TAURI__?.window?.getCurrentWindow().label ?? new URLSearchParams(location.search).get("window");
  return label === "app" ? "app" : "register";
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI__;
  if (!tauri) return Promise.reject(new Error("Chỉ chạy được trong app xDev Hive."));
  return tauri.core.invoke<T>(command, args);
}

export interface Registration {
  hub: string;
  token: string;
}

/** Tách địa chỉ hub và token từ lệnh `hive-worker register …` (bash, PowerShell, cmd, nhiều dòng). */
export const parseRegistration = (input: string) => invoke<Registration>("parse_registration", { input });

/** Đăng ký máy bằng sidecar. Thành công thì Rust ẩn cửa sổ đăng ký, bật worker và mở web của hub. */
export const registerWorker = (hub: string, token: string) => invoke<string>("register_worker", { hub, token });

/** Xin quyền thông báo một lần để báo mất kết nối với hub. Từ chối hay lỗi thì bỏ qua: app vẫn chạy được. */
export async function askNotificationPermission(): Promise<void> {
  try {
    const granted = await invoke<boolean>("plugin:notification|is_permission_granted");
    if (!granted) await invoke("plugin:notification|request_permission");
  } catch {
    /* Không có quyền thông báo thì khay vẫn hiện trạng thái. */
  }
}

/** Lỗi Rust trả về là chuỗi tiếng Việt; lỗi khác thì lấy message. */
export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}
