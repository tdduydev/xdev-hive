import { z } from "zod";
import { id, orgRoute } from "./common.ts";

const day = z.iso.date("Ngày phải có dạng YYYY-MM-DD.");

export const costGroupBy = z.enum(["day", "task", "cli", "machine"]);
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
  /** Ngày (YYYY-MM-DD), id task, tên CLI hoặc id máy; null khi run chưa có CLI hay máy. */
  key: z.string().nullable(),
});
export type CostGroup = z.output<typeof costGroup>;

export const costSummary = z.object({
  groupBy: costGroupBy,
  groups: z.array(costGroup),
  total: costTotals,
});
export type CostSummary = z.output<typeof costSummary>;

export const costsContract = {
  summary: orgRoute("GET", "/v1/costs/summary", "Token và chi phí của dự án theo khoảng ngày (quản trị đội)", "costs")
    .input(costSummaryInput)
    .output(costSummary),
};
