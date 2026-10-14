import type { LeaderAction } from "@xdev-hive/contracts";

/** Một dòng tiếng Việt nói đề xuất của Leader định làm gì, đủ để quyết định mà không mở web. */
export function describeAction(action: LeaderAction): string {
  switch (action.type) {
    case "task.create":
      return `Tạo việc “${action.title}”.`;
    case "run.dispatch":
      return `Giao task ${action.taskId.slice(0, 8)} cho agent chạy${action.cli ? ` bằng ${action.cli}` : ""}.`;
    case "run.cancel":
      return `Huỷ run ${action.runId.slice(0, 8)}.`;
    case "project.settings":
      return `Đổi cài đặt dự án ${action.projectKey}: ${Object.keys(action.patch).join(", ") || "không đổi trường nào"}.`;
    case "sdlc.item.create":
      return "Mở một hạng mục AI SDLC mới.";
  }
}

const RUN_STATE_LABEL: Record<string, string> = {
  queued: "đang chờ máy",
  planning: "đang lập kế hoạch",
  awaiting_plan: "chờ duyệt kế hoạch",
  leased: "đã giao máy",
  preparing: "đang chuẩn bị",
  running: "đang chạy",
  awaiting_input: "chờ bạn trả lời",
  verifying: "đang kiểm tra kết quả",
  succeeded: "thành công",
  no_changes: "xong, không có thay đổi",
  needs_review: "cần xem lại",
  failed: "thất bại",
  lost: "mất kết nối máy",
  cancelling: "đang huỷ",
  cancelled: "đã huỷ",
};

export const runStateLabel = (state: string) => RUN_STATE_LABEL[state] ?? state;

const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "chưa làm",
  queued: "đang chờ chạy",
  running: "đang chạy",
  awaiting_plan: "chờ duyệt kế hoạch",
  review: "chờ review",
  done: "xong",
  cancelled: "đã huỷ",
};

export const taskStatusLabel = (status: string) => TASK_STATUS_LABEL[status] ?? status;

/** Thời gian còn lại tới `iso`, cho giờ đặt lại quota. */
export function untilLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}g${String(minutes % 60).padStart(2, "0")}p` : `${minutes}p`;
}
