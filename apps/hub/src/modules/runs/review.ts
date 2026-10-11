import { z } from "zod";

/** Đầu vào của tool review_submit; cũng là dạng `data` của run_event `review_report`. */
export const reviewReportInput = z.object({
  score: z.number().min(0).max(10).describe("Điểm 0–10 cho thay đổi trong PR."),
  summary: z.string().min(1).max(20_000).describe("Tóm tắt nhận xét: thay đổi làm gì, chất lượng, rủi ro chính."),
  findings: z
    .array(
      z.object({
        file: z.string().min(1).max(500),
        line: z.number().int().positive().optional(),
        severity: z.enum(["critical", "major", "minor", "info"]),
        message: z.string().min(1).max(4000),
      }),
    )
    .max(200)
    .default([])
    .describe("Các phát hiện cụ thể theo file."),
});
export type ReviewReport = z.output<typeof reviewReportInput>;

/** Bình luận lên PR chỉ hiện chừng này phát hiện; đủ báo người xem, không biến PR thành bãi rác. */
export const MAX_COMMENT_FINDINGS = 20;

/** Đọc lại báo cáo đã lưu; dữ liệu hỏng (không qua tool) thì coi như chưa nộp. */
export function parseReviewReport(data: unknown): ReviewReport | null {
  const r = reviewReportInput.safeParse(data);
  return r.success ? r.data : null;
}

export function reviewPrompt(opts: {
  taskKey: string;
  title: string;
  body: string | null;
  branch: string;
  baseBranch: string;
  prUrl: string | null;
}): string {
  return [
    `Bạn là reviewer cho task ${opts.taskKey}: ${opts.title}.`,
    ...(opts.body ? ["", "Mô tả task:", opts.body, ""] : []),
    `Worktree đang ở nhánh ${opts.branch} do một agent khác viết${opts.prUrl ? ` (PR: ${opts.prUrl})` : ""}.`,
    `Đọc diff so với nhánh chính bằng \`git diff origin/${opts.baseBranch}...HEAD\`.`,
    "Chỉ mở thêm file khác khi cần hiểu diff; không đọc toàn bộ repo.",
    "",
    "Quy tắc:",
    "- Không sửa code, không commit, không push. Việc của bạn chỉ là đánh giá.",
    "- Chấm điểm 0–10: đúng yêu cầu của task, đúng logic, có test, an toàn, dễ đọc. 7 trở lên là đủ để merge.",
    "- Trước khi kết thúc, gọi tool MCP `review_submit` của xdev-hive đúng một lần với score, summary và findings",
    "  (mỗi phát hiện có file, line nếu có, severity là critical, major, minor hoặc info, và message).",
    "- Không gọi review_submit thì review bị coi là không có kết quả.",
  ].join("\n");
}

/** Số PR/MR lấy từ URL hub lưu khi mở PR (GitHub `/pull/12`, GitLab `/merge_requests/12`). */
export function prNumberOf(url: string | null): number | null {
  const m = url ? /\/(?:pull|merge_requests)\/(\d+)\/?$/.exec(url) : null;
  return m?.[1] ? Number(m[1]) : null;
}

const SEVERITY: Record<ReviewReport["findings"][number]["severity"], string> = {
  critical: "🔴 nghiêm trọng",
  major: "🟠 lớn",
  minor: "🟡 nhỏ",
  info: "🔵 ghi chú",
};

export function reviewComment(report: ReviewReport, opts: { by: string | null; minScore: number | null }): string {
  const who = opts.by ? ` bởi ${opts.by}` : "";
  const threshold = opts.minScore !== null ? ` (ngưỡng ${opts.minScore})` : "";
  const shown = report.findings.slice(0, MAX_COMMENT_FINDINGS);
  const lines = [`### Review chéo${who}: ${report.score}/10${threshold}`, "", report.summary.slice(0, 8000)];
  if (shown.length) {
    lines.push("", `**Phát hiện** (${report.findings.length}):`);
    for (const f of shown) {
      const at = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- ${SEVERITY[f.severity]} \`${at}\`: ${f.message.slice(0, 1000)}`);
    }
    if (report.findings.length > shown.length) {
      lines.push(`- … và ${report.findings.length - shown.length} phát hiện khác (xem trong run review trên hub).`);
    }
  }
  return lines.join("\n");
}
