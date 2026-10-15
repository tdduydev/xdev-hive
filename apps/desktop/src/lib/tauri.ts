/*
 * Cầu nối tới Rust qua `window.__TAURI__` (withGlobalTauri trong tauri.conf.json). Lệnh nào cửa sổ được gọi do
 * capability quyết định (src-tauri/capabilities); ở đây chỉ gói lại cho có kiểu và để test thay bằng bản giả.
 */
declare global {
  /** Gắn lúc build giao diện (vite.config.ts). */
  const __BUILD_SHA__: string;
  const __BUILD_TIME__: string;
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
      window?: { getCurrentWindow(): { label: string } };
      event?: { listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> };
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

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
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
/** Mở trình duyệt để đăng nhập trên hub; xong thì máy đã đăng ký và tài khoản đã liên kết. Trả tên máy. */
export const browserLogin = (hub: string) => invoke<string>("browser_login", { hub });

/** Kiểm địa chỉ hub bằng /api/v1/health trước khi dùng; lỗi là câu hướng dẫn (chứng chỉ, sai giao thức, không tới được). */
export const hubCheck = (hub: string) => invoke<string>("hub_check", { hub });

/** Kiểu khớp với `HubChange` trong src-tauri/src/lib.rs. */
export interface HubChange {
  hub: string;
  changed: boolean;
  needsRegister: boolean;
}

/** Chuyển máy đã đăng ký sang địa chỉ hub mới khi hub đó nhận đăng ký cũ; không nhận thì báo `needsRegister`. */
export const hubChange = (hub: string) => invoke<HubChange>("hub_change", { hub });

/** Hai địa chỉ là một hub, so như Rust: bỏ khoảng trắng, `/` cuối, chữ hoa ở giao thức và tên máy, cổng mặc định. */
export function sameHub(a: string, b: string): boolean {
  const norm = (raw: string) => {
    try {
      const url = new URL(raw.trim());
      return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      return raw.trim();
    }
  };
  return norm(a) === norm(b);
}

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

/** Trạng thái worker do Rust phát (WorkerView trong src-tauri/src/lib.rs). */
export type WorkerKind = "stopped" | "starting" | "connecting" | "online" | "disconnected" | "stopping" | "failed";
export interface WorkerView {
  kind: WorkerKind;
  label: string;
  detail: string | null;
  wanted: boolean;
  hub: string | null;
}

export const workerState = () => invoke<WorkerView | null>("worker_state");

/** Nghe một sự kiện của Rust; ngoài Tauri thì không làm gì. Trả hàm huỷ nghe. */
export function onTauriEvent<T>(event: string, handler: (payload: T) => void): () => void {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** Nghe sự kiện "worker-state". */
export const onWorkerState = (handler: (view: WorkerView) => void) => onTauriEvent("worker-state", handler);

/** Báo Rust ngôn ngữ của giao diện để chữ trên khay đổi theo. Lỗi (ngoài Tauri) thì bỏ qua. */
export function syncTrayLang(lang: string): void {
  void invoke("set_lang", { lang }).catch(() => {});
}

export interface WorkspaceMeta {
  folder: string;
  name: string;
  isGit: boolean;
  branch: string | null;
  remote: string | null;
}
export const workspaceMeta = (folder: string) => invoke<WorkspaceMeta>("workspace_meta", { folder });

export interface HubCA {
  hub: string;
  name: string;
  fingerprint: string;
  previousFingerprint: string | null;
}
export const hubCAInspect = (hub: string) => invoke<HubCA>("hub_ca_inspect", { hub });
export const hubCATrust = (hub: string, fingerprint: string) => invoke<void>("hub_ca_trust", { hub, fingerprint });
export const hubCAForget = () => invoke<void>("hub_ca_forget");
