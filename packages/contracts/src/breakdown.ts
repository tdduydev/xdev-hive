import type { z } from "zod";
import type { BreakdownError, BreakdownParser, breakdownTask, SdlcDecomposition, sdlcBreakdown } from "./sdlc.ts";

/**
 * Bộ đọc/ghi tài liệu tách việc (specs/011 D8, D24): thuần, dùng ở hub (luật `breakdown`, `coverage`, áp baseline) và
 * ở màn Duyệt bản tách. Bản tách là kết quả tính từ Markdown, không lưu nguồn thứ hai. Schema nằm ở sdlc.ts vì nó là
 * một phần của API.
 */
export type BreakdownTask = z.output<typeof breakdownTask>;
export type Breakdown = z.output<typeof sdlcBreakdown>;

/** Dự án của hạng mục: thẻ `[@key]` ngoài danh sách là lỗi; task không có thẻ thuộc dự án chính. */
export interface BreakdownContext {
  homeProject: string;
  projects: readonly string[];
}

export type BreakdownResult =
  | { ok: true; breakdown: Breakdown; errors: [] }
  | { ok: false; breakdown: null; errors: BreakdownError[] };

/** Độ phủ "đã lên kế hoạch" của bản tách: requirement có ít nhất một task chứa nó. */
export interface BreakdownCoverage {
  total: { requirements: number; planned: number };
  byProject: { project: string; requirements: number; planned: number }[];
  /** Requirement chưa có task, theo thứ tự xuất hiện. */
  missing: string[];
}

// T003 viết thân các hàm dưới; khung có sẵn để hub và UI viết theo chữ ký trước khi bộ đọc xong.
const notYet = (): never => {
  throw new Error("Bộ đọc bản tách task chưa có (specs/011 T003).");
};

/**
 * Đọc tài liệu tách việc thành bản tách: task, phụ thuộc, đợt (sắp topo), requirement theo `requirementId`, dự án của
 * task. Lỗi có số dòng, viết tiếng Việt ("Dòng 42: T009 phụ thuộc T099 không có.").
 */
export function parseBreakdown(
  _markdown: string,
  _decomposition: Pick<SdlcDecomposition, "parser" | "granularity" | "requirementId" | "maxTasks" | "maxChecklist">,
  _context: BreakdownContext,
): BreakdownResult {
  return notYet();
}

/** Ghi bản tách về Markdown theo định dạng của bộ đọc; đọc–ghi–đọc giữ nguyên cấu trúc. */
export function writeBreakdown(_breakdown: Breakdown, _parser: BreakdownParser): string {
  return notYet();
}

/** Độ phủ requirement của bản tách, tổng và theo dự án. */
export function coverage(_requirements: readonly string[], _breakdown: Breakdown): BreakdownCoverage {
  return notYet();
}
