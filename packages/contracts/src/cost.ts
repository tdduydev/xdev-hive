import { z } from "zod";
import { id, orgRoute } from "./common.ts";

const day = z.iso.date("Ngày phải có dạng YYYY-MM-DD.");

export const costGroupBy = z.enum(["day", "task", "cli", "machine", "account"]);
export type CostGroupBy = z.output<typeof costGroupBy>;

export const costSummaryInput = z
  .object({
    projectId: id,
    /** Ngày đầu và ngày cuối (tính cả hai), theo ngày tạo run, giờ UTC. */
    from: day,
    to: day,
    groupBy: costGroupBy.default("day"),
  })
  .refine((v) => v.from <= v.to, { message: "Ngày bắt đầu phải trước ngày kết thúc.", path: ["from"] });
export type CostSummaryInput = z.output<typeof costSummaryInput>;

export const costTotals = z.object({
  runs: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  /** Tổng USD của các run có báo USD; Codex và Gemini không báo nên không có trong tổng này. */
  costUsd: z.number(),
});
export type CostTotals = z.output<typeof costTotals>;

export const costGroup = costTotals.extend({
  /** Ngày (YYYY-MM-DD), id task, tên CLI, id máy hoặc id gói; null khi run chưa có CLI, máy hay gói (đăng nhập mặc định). */
  key: z.string().nullable(),
});
export type CostGroup = z.output<typeof costGroup>;

/**
 * "Khảo sát trước khi sửa" của run code trong khoảng ngày (ADR 0022): phần agent đọc repo trước lần sửa file đầu tiên.
 * Chỉ tính run có số đo (Claude, worker mới); run chưa sửa gì tính cả lần chạy. `costShare` và `costUsd` là ước tính:
 * token khảo sát nhân hệ số giá của Claude (đọc cache 0,1, ghi cache 1,25, output 5 lần input) chia cho cả run.
 */
export const costExplore = z.object({
  runs: z.number().int(),
  /** Số run đã sửa file; còn lại là run chưa sửa gì. */
  edited: z.number().int(),
  turns: z.number().int(),
  totalTurns: z.number().int(),
  tokens: z.number().int(),
  totalTokens: z.number().int(),
  costShare: z.number().min(0).max(1),
  costUsd: z.number(),
});
export type CostExplore = z.output<typeof costExplore>;

export const costSummary = z.object({
  groupBy: costGroupBy,
  groups: z.array(costGroup),
  total: costTotals,
  /** null khi trong khoảng ngày không có run code nào có số đo. */
  explore: costExplore.nullable(),
});
export type CostSummary = z.output<typeof costSummary>;

export const budgetStopReason = z.enum(["per_run_usd", "per_task_usd", "max_turns"]);
export const budgetStoppedRun = z.object({
  runId: id,
  taskId: id,
  taskKey: z.string(),
  taskTitle: z.string(),
  reason: budgetStopReason,
  measured: z.number(),
  limit: z.number(),
  stoppedAt: z.iso.datetime(),
});
export type BudgetStoppedRun = z.output<typeof budgetStoppedRun>;

export const costsContract = {
  summary: orgRoute("GET", "/v1/costs/summary", "Token và chi phí của dự án theo khoảng ngày (quản trị đội)", "costs")
    .input(costSummaryInput)
    .output(costSummary),
  budgetStopped: orgRoute(
    "GET",
    "/v1/costs/budget-stopped",
    "Run bị dừng vì vượt ngân sách của dự án (quản trị đội)",
    "costs",
  )
    .input(z.object({ projectId: id }))
    .output(z.array(budgetStoppedRun)),
};
