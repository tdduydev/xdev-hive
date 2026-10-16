import { invoke } from "@/lib/tauri.ts";

/** Cài đặt bật/tắt của app, lưu ở Rust (src-tauri/src/settings.rs) vì Rust đọc chúng cả khi chưa có cửa sổ nào. */
export interface AppSettings {
  startWorker: boolean;
  hideOnClose: boolean;
  notifyRuns: boolean;
  notifyApprovals: boolean;
  notifyQuestions: boolean;
  notifyOffline: boolean;
}

export type SettingKey = keyof AppSettings;

export const appSettings = () => invoke<AppSettings>("app_settings");
export const setAppSetting = (key: SettingKey, value: boolean) =>
  invoke<AppSettings>("set_app_setting", { key, value });
