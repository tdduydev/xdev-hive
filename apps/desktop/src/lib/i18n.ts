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

export const writeRepoText = {
  vi: {
    search: "Tìm theo từ và theo nghĩa",
    searchAction: "Tìm tài liệu",
    clearSearch: "Xoá tìm kiếm",
    noResults: "Không tìm thấy tài liệu phù hợp.",
    keyword: "Đang tìm theo từ; hub chưa cấu hình tìm theo nghĩa.",
    hybrid: "Kết quả kết hợp tìm theo từ và theo nghĩa.",
    resolveConflict: "Giải quyết xung đột",
    conflictUnavailable: "Không tìm thấy xung đột bạn có quyền quản lý. Hãy tải lại trạng thái tài liệu.",
    back: "Về trình soạn",
    refresh: "Tải lại trạng thái",
    repo: "Mở file trên repo",
    extract: "Xem bản trích trên hub",
    folders: "Tài liệu theo thư mục repo",
    noHome: "Chưa có nhà",
    commit: "Mở commit trên repo",
  },
  en: {
    search: "Search by words and meaning",
    searchAction: "Search documents",
    clearSearch: "Clear search",
    noResults: "No matching documents.",
    keyword: "Searching by words; semantic search is not configured on the hub.",
    hybrid: "Results combine keyword and semantic search.",
    resolveConflict: "Resolve conflict",
    conflictUnavailable: "No conflict you can manage was found. Refresh the document status.",
    back: "Back to editor",
    refresh: "Refresh status",
    repo: "Open file in repository",
    extract: "View extract on hub",
    folders: "Documents by repository folder",
    noHome: "No home",
    commit: "Open commit in repository",
  },
} satisfies Dict<Record<string, string>>;
