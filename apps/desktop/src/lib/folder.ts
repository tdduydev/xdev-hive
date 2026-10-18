import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@/lib/tauri.ts";

/**
 * Thư mục làm việc dùng chung cho mọi màn (Tổng quan, Môi trường, Token và ngữ cảnh). Chọn ở AppNav (bộ chọn thư mục
 * của hệ điều hành) hoặc nhập tay ở từng màn; nhớ trong localStorage.
 */
const KEY = "hive.folder";
const listeners = new Set<() => void>();

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
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Thư mục đang chọn và hàm đổi; mọi màn đang mở đổi theo. */
export function useFolder(): [string, (folder: string) => void] {
  const folder = useSyncExternalStore(subscribe, readFolder, () => "");
  return [folder, useCallback((f: string) => saveFolder(f), [])];
}

/** Mở bộ chọn thư mục của hệ điều hành (tauri-plugin-dialog). Huỷ thì trả null. */
export async function pickFolder(title: string): Promise<string | null> {
  const picked = await invoke<string | string[] | null>("plugin:dialog|open", {
    options: { directory: true, multiple: false, title },
  });
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

/** "/Users/ha/Work/payment-api" → "~/Work/payment-api" khi biết thư mục nhà; không thì giữ nguyên. */
export function shortPath(folder: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/.exec(folder);
  return m ? `~${m[2]}` : folder;
}

export const folderName = (folder: string) => folder.split(/[/\\]/).filter(Boolean).at(-1) ?? folder;

/** Khoá để so hai thư mục: `/` thay `\`, bỏ dấu phân cách cuối, chữ thường với đường dẫn kiểu Windows (`C:`). */
export function folderKey(folder: string): string {
  let p = folder.trim().replace(/\\/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return /^[a-z]:/i.test(p) ? p.toLowerCase() : p;
}
