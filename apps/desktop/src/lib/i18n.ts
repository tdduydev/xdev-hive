import { useSyncExternalStore } from "react";

/**
 * Ngôn ngữ giao diện. Thiết kế v2 (docs/design-system/screens) có cặp chữ VI/EN cho mọi màn; web làm theo cách của
 * thiết kế: mỗi component giữ một từ điển `{ vi, en }` và lấy bản theo ngôn ngữ đang chọn bằng useT. Lỗi do hub trả về
 * vẫn là tiếng Việt.
 */
export type Lang = "vi" | "en";

const KEY = "hive.lang";
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "vi";
  } catch {
    return "vi";
  }
}

let current: Lang = typeof window === "undefined" ? "vi" : read();

function apply(lang: Lang) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
apply(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* Không lưu được thì vẫn đổi cho phiên hiện tại. */
  }
  apply(lang);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Nghe đổi ngôn ngữ ngoài React (vd. báo khay hệ thống). */
export const subscribeLang = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "vi");
}

/** Từ điển hai ngôn ngữ của một component; hai bản phải cùng khoá (TypeScript kiểm). */
export type Dict<T> = { vi: T; en: T };

/** Bản của từ điển theo ngôn ngữ đang chọn. Đặt từ điển ở cấp module để không tạo lại mỗi lần vẽ. */
export function useT<T>(dict: Dict<T>): T {
  return dict[useLang()];
}
