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
  // Tuỳ chọn để agent và review chéo cũ (không có rubric) vẫn nộp hợp lệ.
  checklist: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(300).describe("Mục kiểm, đúng chữ trong danh sách được giao."),
        passed: z.boolean(),
        note: z.string().trim().max(2000).nullable().optional().describe("Lý do khi không đạt; trích dòng nếu có."),
      }),
    )
    .max(30)
    .optional()
    .describe("Kết quả từng mục kiểm khi lời nhắc có danh sách mục kiểm (quy trình review code)."),
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
  /** Mục kiểm của checkpoint AI trong quy trình review code; rỗng là review chéo cũ. */
  rubric?: string[] | undefined;
  /** Đường dẫn trọng tâm của checkpoint; rỗng là cả diff. */
  focusPaths?: string[] | undefined;
  /** Ngưỡng và mức chặn của checkpoint; đứng sau quy tắc chung để thay câu "7 trở lên là đủ". */
  guidance?: string[] | undefined;
  /** Requirement và tiêu chí của task thuộc hạng mục AI SDLC. */
  specContext?: string[] | undefined;
}): string {
  const rubric = opts.rubric ?? [];
  const focus = opts.focusPaths ?? [];
  const spec = opts.specContext ?? [];
  return [
    `Bạn là reviewer cho task ${opts.taskKey}: ${opts.title}.`,
    ...(opts.body ? ["", "Mô tả task:", opts.body, ""] : []),
    ...(spec.length ? [...(opts.body ? [] : [""]), ...spec, ""] : []),
    `Worktree đang ở nhánh ${opts.branch} do một agent khác viết${opts.prUrl ? ` (PR: ${opts.prUrl})` : ""}.`,
    // Run review chạy chỉ đọc (Claude ở chế độ plan không chạy được lệnh): worker ghi sẵn diff vào file này.
    `Đọc diff so với nhánh chính trong file \`.hive-review.diff\` ở gốc worktree (worker đã tạo sẵn). Không có file đó thì dùng \`git diff origin/${opts.baseBranch}...HEAD\`.`,
    "Chỉ mở thêm file khác khi cần hiểu diff; không đọc toàn bộ repo.",
    ...(focus.length
      ? ["", "Tập trung vào các thay đổi khớp những đường dẫn sau; phần còn lại của diff chỉ đọc để hiểu ngữ cảnh:"]
      : []),
    ...focus.map((p) => `- ${p}`),
    ...(rubric.length ? ["", "Danh sách mục kiểm (đánh giá từng mục, đạt hay không, ghi chú khi không đạt):"] : []),
    ...rubric.map((c) => `- ${c}`),
    "",
    "Quy tắc:",
    "- Không sửa code, không commit, không push. Việc của bạn chỉ là đánh giá.",
    "- Chấm điểm 0–10: đúng yêu cầu của task, đúng logic, có test, an toàn, dễ đọc. 7 trở lên là đủ để merge.",
    ...(opts.guidance ?? []),
    "- Trước khi kết thúc, gọi tool MCP `review_submit` của xdev-hive đúng một lần với score, summary và findings",
    "  (mỗi phát hiện có file, line nếu có, severity là critical, major, minor hoặc info, và message).",
    ...(rubric.length
      ? ["- Gửi kèm checklist: mỗi mục kiểm ở trên một phần tử, label đúng chữ của mục, passed và note nếu không đạt."]
      : []),
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
