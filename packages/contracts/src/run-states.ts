// Trạng thái run và nhóm trạng thái, không import zod: web dùng ở router và bảng việc (bundle đầu), import cả
// `@xdev-hive/contracts` sẽ kéo zod và mọi schema vào trang đầu. runs.ts dựng schema zod từ các danh sách này.

/** Máy trạng thái của run (docs/architecture.md mục 4.1). */
export const RUN_STATES = [
  "queued",
  "planning",
  "awaiting_plan",
  "leased",
  "preparing",
  "running",
  "awaiting_input",
  "verifying",
  "succeeded",
  "no_changes",
  "needs_review",
  "failed",
  "lost",
  "cancelling",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Trạng thái không đổi nữa; run ở đây không giữ lease và không nhận gói của worker. */
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded",
  "no_changes",
  "needs_review",
  "failed",
  "cancelled",
];

/** Nhóm trạng thái để lọc danh sách run; web và hub dùng chung một cách chia. */
export const RUN_STATUS_GROUP_NAMES = ["active", "waiting", "succeeded", "failed", "cancelled"] as const;
export type RunStatusGroup = (typeof RUN_STATUS_GROUP_NAMES)[number];
export const RUN_STATUS_GROUPS: Record<RunStatusGroup, readonly RunState[]> = {
  active: ["queued", "planning", "leased", "preparing", "running", "verifying", "cancelling"],
  /** Cần người: duyệt kế hoạch, trả lời agent, xem kết quả. */
  waiting: ["awaiting_plan", "awaiting_input", "needs_review"],
  succeeded: ["succeeded", "no_changes"],
  failed: ["failed", "lost"],
  cancelled: ["cancelled"],
};

export const isRunStatusGroup = (value: unknown): value is RunStatusGroup =>
  (RUN_STATUS_GROUP_NAMES as readonly unknown[]).includes(value);
