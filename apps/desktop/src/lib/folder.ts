/**
 * Thư mục dự án đang làm, dùng chung cho các màn (Môi trường, Token và ngữ cảnh). Tạm nhập tay và nhớ trong
 * localStorage cho tới khi có bộ chọn thư mục ở AppNav (specs/008-desktop-v2 T008).
 */
const KEY = "hive.folder";

export function readFolder(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveFolder(folder: string): void {
  try {
    localStorage.setItem(KEY, folder.trim());
  } catch {
    /* Không nhớ được thì vẫn dùng cho lần này. */
  }
}
