import { type PlanContent, planContent } from "@xdev-hive/contracts";

/** Đọc lại kế hoạch đã lưu trong run_event `plan_report`; dữ liệu hỏng (không qua tool) thì coi như chưa nộp. */
export function parsePlanReport(data: unknown): PlanContent | null {
  const r = planContent.safeParse(data);
  return r.success ? r.data : null;
}

export function planPrompt(opts: {
  taskKey: string;
  title: string;
  body: string | null;
  baseBranch: string;
  /** Kế hoạch lần trước của task bị từ chối (markdown) và lý do, để lần lập mới không lặp lại. */
  rejected: { plan: string; reason: string | null } | null;
}): string {
  const lines = [
    `Bạn lập kế hoạch cho task ${opts.taskKey}: ${opts.title}.`,
    ...(opts.body ? ["", "Mô tả task:", opts.body, ""] : []),
    `Worktree đang ở nhánh chính ${opts.baseBranch}. Đọc phần code cần để hiểu việc phải làm; không đọc toàn bộ repo.`,
    "",
    "Quy tắc:",
    "- Chỉ đọc. Không sửa file, không commit, không push: người duyệt xem kế hoạch rồi một run khác mới viết code.",
    "- Trước khi kết thúc, gọi tool MCP `plan_submit` của xdev-hive đúng một lần với summary (hiểu yêu cầu ra sao,",
    "  hướng làm chính), steps (các bước theo thứ tự, mỗi bước có title và detail nếu cần), files (file dự kiến đụng:",
    "  path, change là add, modify hoặc delete, và reason), risks (rủi ro và cách giảm), questions (điều chưa rõ cần",
    "  người duyệt trả lời).",
    "- Không gọi plan_submit thì kế hoạch bị coi là không có và task không chạy tiếp.",
  ];
  if (opts.rejected) {
    lines.push(
      "",
      "Kế hoạch lần trước của task này đã bị người duyệt từ chối.",
      ...(opts.rejected.reason ? [`Lý do: ${opts.rejected.reason}`] : []),
      "",
      "Kế hoạch bị từ chối:",
      opts.rejected.plan,
      "",
      "Lập kế hoạch mới có tính tới lý do trên.",
    );
  }
  return lines.join("\n");
}

/** Phần prompt của run code chạy theo kế hoạch đã duyệt. */
export function approvedPlanPrompt(plan: string, note: string | null): string {
  return [
    "Kế hoạch đã được người duyệt chấp thuận. Làm theo kế hoạch này; cần làm khác thì ghi rõ lý do trong báo cáo",
    "task_update.",
    "",
    plan,
    ...(note ? ["", `Ghi chú của người duyệt: ${note}`] : []),
  ].join("\n");
}
