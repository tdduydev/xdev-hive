import { useSyncExternalStore } from "react";

const KEY = "hive.nav.collapsed";
const listeners = new Set<() => void>();

/** null: chưa chọn, menu tự thu gọn ở màn cần chỗ (Tài liệu, Soạn tài liệu); true/false: người dùng đã chọn. */
function read(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

export function setNavCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, collapsed ? "1" : "0");
  } catch {
    /* Không lưu được thì vẫn đổi trong phiên này qua listener. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lựa chọn thu gọn menu đã lưu (giữ qua lần mở app), null khi chưa chọn. */
export function useNavCollapsed(): boolean | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
