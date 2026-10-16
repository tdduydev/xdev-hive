// Màn chat dự phòng: Leader (cuộc trò chuyện, đề xuất chờ duyệt) và form "Giao việc". Đường dẫn chính xác, không theo tiền tố.
export const procedures: readonly string[] = [
  "/rpc/leader/threads/list",
  "/rpc/leader/threads/create",
  "/rpc/leader/threads/get",
  "/rpc/leader/threads/send",
  "/rpc/leader/approvals/list",
  "/rpc/leader/approvals/approve",
  "/rpc/leader/approvals/reject",
  "/rpc/projects/list",
  "/rpc/tasks/create",
  "/rpc/runs/start",
];
