import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { outcomeCheck } from "./projects.ts";
import { cli } from "./worker-protocol.ts";

/** Máy trạng thái của run (docs/architecture.md mục 4.1). */
export const runState = z.enum([
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
]);
export type RunState = z.output<typeof runState>;

/** Trạng thái không đổi nữa; run ở đây không giữ lease và không nhận gói của worker. */
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded",
  "no_changes",
  "needs_review",
  "failed",
  "cancelled",
];

export const runKind = z.enum(["code", "review"]);

/** Kết quả một bước kiểm tra của chính sách kết quả ở bước verifying. */
export const checkOutcome = z.object({
  check: z.string(),
  required: z.boolean(),
  /** null khi hub chưa hỗ trợ kiểm tra này (command, ci), hoặc review chéo đang tắt hay chưa có kết quả. */
  passed: z.boolean().nullable(),
  /** Bỏ qua theo điều kiện review: không ảnh hưởng kết luận chính sách. */
  skipped: z.boolean().optional(),
  message: z.string(),
});
export type CheckOutcome = z.output<typeof checkOutcome>;

export const runResultView = z.object({
  exit: z.number().int().nullable(),
  commitCount: z.number().int().nullable(),
  changedFiles: z.array(z.string()),
  checks: z.array(checkOutcome),
  /** Lý do run không thành công, viết cho người xem. */
  reasons: z.array(z.string()),
});
export type RunResultView = z.output<typeof runResultView>;

/** Token và chi phí luỹ kế của run qua mọi lần thử, từ sự kiện cost của worker. */
export const runCost = z.object({
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  cacheRead: z.number().int(),
  cacheWrite: z.number().int(),
  /** null khi CLI không báo USD (Codex, Gemini). */
  costUsd: z.number().nullable(),
  turns: z.number().int().nullable(),
});
export type RunCost = z.output<typeof runCost>;

export const run = z.object({
  id,
  taskId: id,
  projectId: id,
  teamId: id,
  kind: runKind,
  /** Run review chéo: run code mà nó review. null với run code. */
  parentRunId: id.nullable(),
  state: runState,
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  /** Máy đang giữ (hoặc giữ lần cuối) run. */
  machineId: id.nullable(),
  /** Tên máy để hiện cho người xem (người không quản trị đội không gọi được machines.list); null khi chưa có máy. */
  machineName: z.string().nullable(),
  /** CLI yêu cầu; null là máy nào có CLI cũng được. */
  cli: cli.nullable(),
  model: z.string().nullable(),
  /** Máy người dùng chỉ định; null là hub tự chọn. */
  pinnedMachineId: id.nullable(),
  branch: z.string(),
  policySnapshot: z.array(outcomeCheck),
  result: runResultView.nullable(),
  headSha: z.string().nullable(),
  prUrl: z.string().nullable(),
  timeoutSec: z.number().int(),
  cost: runCost,
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Run = z.output<typeof run>;

export const runEventView = z.object({
  /** Tăng dần trong toàn hub; dùng làm con trỏ `after`. */
  id: z.number().int(),
  attempt: z.number().int(),
  /** seq của worker; null với sự kiện do hub ghi (chuyển trạng thái). */
  seq: z.number().int().nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type RunEventView = z.output<typeof runEventView>;

export const runLogChunk = z.object({
  id: z.number().int(),
  attempt: z.number().int(),
  offset: z.number().int(),
  /** base64, vì log có thể chứa byte không phải UTF-8. */
  bytes: z.string(),
  createdAt: z.iso.datetime(),
});
export type RunLogChunk = z.output<typeof runLogChunk>;

// Tham số query của GET luôn là chuỗi; coerce để OpenAPI nhận được số.
const cursor = z.coerce.number().int().min(0).default(0);
const limit = z.coerce.number().int().min(1).max(1000).default(500);

export const runStartInput = z.object({
  taskId: id,
  /** Bỏ trống thì dùng CLI ưa thích của task, rồi tới bất kỳ CLI nào máy có. */
  cli: cli.optional(),
  /** Ghi đè model cấu hình của dự án cho run này. */
  model: z.string().trim().min(1).max(200).nullable().optional(),
  /** Chỉ giao cho máy này (máy của đội sở hữu dự án). */
  machineId: id.optional(),
});
export type RunStartInput = z.output<typeof runStartInput>;

export const runSteerInput = z.object({
  id,
  input: z.string().trim().min(1, "Chỉ dẫn không được để trống.").max(4000, "Chỉ dẫn dài tối đa 4.000 ký tự."),
});
export type RunSteerInput = z.output<typeof runSteerInput>;

/**
 * sent: đã gửi tới máy đang chạy agent. pending: run chưa tới máy, chỉ dẫn vào prompt khi giao. closing: run đang kiểm
 * kết quả, đang huỷ hoặc đã xong nên không nhận nữa.
 */
export const runSteerStatus = z.enum(["sent", "pending", "closing"]);
export type RunSteerStatus = z.output<typeof runSteerStatus>;

export const runsContract = {
  start: orgRoute("POST", "/v1/runs", "Giao task cho agent (thành viên đội)", "runs").input(runStartInput).output(run),
  list: orgRoute("GET", "/v1/tasks/{taskId}/runs", "Các run của task, mới nhất trước", "runs")
    .input(z.object({ taskId: id }))
    .output(z.array(run)),
  latest: orgRoute("GET", "/v1/runs", "Run code mới nhất của mỗi task, lọc theo dự án", "runs")
    // Bảng việc cần run gần nhất của mọi task trong một lần gọi, thay vì gọi runs.list cho từng task.
    .input(z.object({ projectId: id.optional() }))
    .output(z.array(run)),
  get: orgRoute("GET", "/v1/runs/{id}", "Thông tin run", "runs").input(z.object({ id })).output(run),
  cancel: orgRoute("POST", "/v1/runs/{id}/cancel", "Huỷ run (thành viên đội)", "runs")
    .input(z.object({ id }))
    .output(run),
  steer: orgRoute("POST", "/v1/runs/{id}/steer", "Gửi chỉ dẫn cho agent của run (thành viên đội)", "runs")
    .input(runSteerInput)
    .output(z.object({ status: runSteerStatus })),
  events: orgRoute("GET", "/v1/runs/{id}/events", "Sự kiện của run sau con trỏ `after`", "runs")
    .input(z.object({ id, after: cursor, limit }))
    .output(z.array(runEventView)),
  logs: orgRoute("GET", "/v1/runs/{id}/logs", "Đoạn log của run sau con trỏ `after`", "runs")
    .input(z.object({ id, after: cursor, limit }))
    .output(z.array(runLogChunk)),
};
