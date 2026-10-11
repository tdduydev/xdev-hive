import type { Health } from "@xdev-hive/contracts";

/** Dòng trạng thái hiện ở đầu trang. Tách ra để test không cần DOM. */
export function healthLabel(state: { data?: Health | undefined; error?: unknown; isPending: boolean }): string {
  if (state.isPending) return "Đang kết nối hub…";
  if (state.error || !state.data) return "Không kết nối được hub. Kiểm tra hub đã chạy ở cổng 3000.";
  return `Hub ${state.data.version} đang chạy`;
}
