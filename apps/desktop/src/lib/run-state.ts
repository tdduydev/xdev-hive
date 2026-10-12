import type { RunState } from "@xdev-hive/contracts";
import type { Dict } from "@/lib/i18n.ts";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "sel";

/** Run chưa xong: Lượt chạy và Việc của tôi tự hỏi lại hub, nhãn trạng thái có chấm. */
export const ACTIVE: ReadonlySet<string> = new Set<RunState>([
  "queued",
  "leased",
  "preparing",
  "running",
  "awaiting_input",
  "verifying",
  "cancelling",
  "planning",
  "awaiting_plan",
]);

const TONE: Partial<Record<string, Tone>> = {
  succeeded: "ok",
  no_changes: "neutral",
  needs_review: "warn",
  failed: "bad",
  lost: "bad",
  cancelled: "neutral",
};
export const stateTone = (state: string): Tone => (ACTIVE.has(state) ? "sel" : (TONE[state] ?? "neutral"));

/** Tên trạng thái run cho người xem, mọi màn của app dùng chung. */
export const RUN_STATE_TEXT: Dict<Record<RunState, string>> = {
  vi: {
    queued: "Chờ máy",
    leased: "Đã nhận",
    preparing: "Chuẩn bị",
    running: "Đang chạy",
    awaiting_input: "Chờ trả lời",
    verifying: "Đang kiểm",
    cancelling: "Đang huỷ",
    planning: "Lập kế hoạch",
    awaiting_plan: "Chờ duyệt kế hoạch",
    succeeded: "Xong",
    no_changes: "Không đổi gì",
    needs_review: "Cần xem",
    failed: "Lỗi",
    lost: "Mất máy",
    cancelled: "Đã huỷ",
  },
  en: {
    queued: "Waiting for a machine",
    leased: "Accepted",
    preparing: "Preparing",
    running: "Running",
    awaiting_input: "Waiting for input",
    verifying: "Verifying",
    cancelling: "Cancelling",
    planning: "Planning",
    awaiting_plan: "Plan awaiting approval",
    succeeded: "Done",
    no_changes: "No changes",
    needs_review: "Needs review",
    failed: "Failed",
    lost: "Machine lost",
    cancelled: "Cancelled",
  },
};
