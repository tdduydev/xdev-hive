import { invoke } from "@/lib/tauri.ts";

/** Kiểu khớp với src-tauri/src/doctor.rs (serde camelCase). */
export type CheckKind = "cli" | "runtime" | "tool" | "dependency";
export type CheckStatus = "ok" | "outdated" | "mismatch" | "missing" | "optional";

export interface CheckItem {
  id: string;
  name: string;
  kind: CheckKind;
  required: boolean;
  need: string | null;
  have: string | null;
  status: CheckStatus;
  /** File dự án đặt ra yêu cầu; rỗng là yêu cầu chung của máy. */
  source: string;
  install: { command: string; runnable: boolean; admin: boolean } | null;
}

export interface InstallResult {
  ok: boolean;
  code: number | null;
  output: string;
}

const folderArg = (folder: string) => (folder.trim() ? folder.trim() : null);

export const scanEnvironment = (folder: string) =>
  invoke<CheckItem[]>("scan_environment", { folder: folderArg(folder) });

/** Chỉ gửi id: Rust tự sinh lại lệnh của mục, không nhận chuỗi lệnh từ giao diện. */
export const runInstall = (id: string, folder: string) =>
  invoke<InstallResult>("run_install", { id, folder: folderArg(folder) });

/** Mục cần xử lý trước: thiếu, cũ, rồi không bắt buộc, cuối cùng là đủ. */
const ORDER: Record<CheckStatus, number> = { missing: 0, outdated: 1, mismatch: 2, optional: 3, ok: 4 };

export const sortChecks = (items: CheckItem[]) =>
  [...items].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

export const needsAction = (item: CheckItem) =>
  item.status === "missing" || item.status === "outdated" || item.status === "mismatch";

/** Điểm ở vòng tròn: số mục bắt buộc đã đủ trên tổng số mục bắt buộc. */
export function readiness(items: CheckItem[]): { ready: number; required: number } {
  const required = items.filter((i) => i.required);
  return { ready: required.filter((i) => i.status === "ok").length, required: required.length };
}
