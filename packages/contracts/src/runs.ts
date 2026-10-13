import { z } from "zod";
import { id, orgRoute, queryFlag } from "./common.ts";
import { outcomeCheck, routingEffort, taskTier } from "./projects.ts";
import { RUN_STATES, RUN_STATUS_GROUP_NAMES } from "./run-states.ts";
import { cli, exploreUsage, rtkUsage } from "./worker-protocol.ts";

export { RUN_STATUS_GROUPS, TERMINAL_RUN_STATES } from "./run-states.ts";

export const runState = z.enum(RUN_STATES);
export type RunState = z.output<typeof runState>;

/**
 * `review`: review chéo; `plan`: lập kế hoạch; `leader`: trả lời chat và đề xuất hành động; `sdlc`: bước agent của
 * hạng mục AI SDLC (soạn tài liệu trong worktree tạm, không đẩy; specs/011 FR-010); `brief`: viết lại bản tóm tắt repo của dự án (ADR 0022).
 */
export const runKind = z.enum(["code", "review", "plan", "leader", "doccheck", "docassist", "sdlc", "brief"]);

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
  /** Id gói (tài khoản CLI trên máy) đã chạy run, theo worker báo; null khi dùng đăng nhập mặc định hay worker cũ. */
  accountId: z.string().nullable(),
});
export type RunCost = z.output<typeof runCost>;

/** Khảo sát trước lần sửa đầu tiên của lần thử gần nhất; null khi CLI không báo được (chỉ Claude báo) hay worker cũ. */
export const runExplore = exploreUsage;
export type RunExplore = z.output<typeof runExplore>;

/**
 * Model và effort hub đã chọn cho lần thử đang giao và vì sao (định tuyến theo cấp độ task). `reasons` là các câu
 * tiếng Việt đã viết sẵn để trang run hiện nguyên văn.
 */
export const runRouting = z.object({
  tier: taskTier,
  /** Cấp độ trước khi nâng vì thử lại; khác `tier` là đã nâng. */
  baseTier: taskTier,
  /** Nơi quyết định cấp độ: người đặt tay, nhãn task, kế hoạch, loại task, mô tả, hay mặc định. */
  source: z.enum(["manual", "label", "plan", "type", "description", "default"]),
  model: z.string().nullable(),
  effort: routingEffort.nullable(),
  advisor: z.string().nullable(),
  maxTurns: z.number().int().nullable(),
  reasons: z.array(z.string()),
});
export type RunRouting = z.output<typeof runRouting>;

/** Token RTK đã tiết kiệm ở lần thử gần nhất; null khi run không dùng RTK (máy không có, tắt trong dự án, CLI khác Claude) hay worker cũ. */
export const runRtk = rtkUsage;
export type RunRtk = z.output<typeof runRtk>;

export const run = z.object({
  id,
  taskId: id.nullable(),
  projectId: id,
  teamId: id,
  kind: runKind,
  /** Run review/plan trỏ tới run cha; leader run gắn với thread. null với run code. */
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
  /** Cấp độ task do người đặt tay cho run này; null là hub tự suy. */
  tier: taskTier.nullable().optional(),
  /** Lựa chọn model/effort của lần thử đang giao; null với run chưa giao hoặc không qua định tuyến. */
  routing: runRouting.nullable().optional(),
  /** Máy người dùng chỉ định; null là hub tự chọn. */
  pinnedMachineId: id.nullable(),
  branch: z.string(),
  policySnapshot: z.array(outcomeCheck),
  result: runResultView.nullable(),
  headSha: z.string().nullable(),
  prUrl: z.string().nullable(),
  timeoutSec: z.number().int(),
  cost: runCost,
  explore: runExplore.nullable(),
  rtk: runRtk.nullable(),
  createdBy: z.string(),
  /** Chủ run: người giao run, và chỉ máy của họ hoặc máy dùng chung chạy được. null là run của đội (Leader, gate AI, webhook). */
  ownerUserId: z.string().nullable(),
  /** Máy nhận run phải có mọi nhãn này (specs/011 FR-041). Hub chưa có cột thì không trả, coi như rỗng. */
  requiredLabels: z.array(z.string()).optional(),
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
  /**
   * Chỉ dẫn thêm là sự kiện `steer` (`input`, `by`, `sent`: đã gửi tới máy; `delivered` luôn false vì bảng chỉ thêm).
   * Đã vào agent hay chưa nằm ở sự kiện `steer_result` sau đó, có `steerId` bằng `id` của sự kiện `steer`, `applied`
   * và `reason`. Không có `steer_result` là worker chưa trả lời (worker cũ, run đã xong): coi như chưa áp dụng.
   */
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

/**
 * Mã lỗi CONFLICT khi hub không tạo run code (specs/011 FR-028, FR-029). Đặt ở đây chứ không ở sdlc.ts vì đây là lỗi
 * của `runs.start` (và mọi đường tạo run qua `queueRun`), và sdlc.ts import tasks.ts, tasks.ts import file này.
 */
export const SDLC_GATE_BLOCKED = "SDLC_GATE_BLOCKED";
export const TASK_DEPENDENCIES_OPEN = "TASK_DEPENDENCIES_OPEN";

/** Một lý do chặn: tài liệu chưa có baseline, task phụ thuộc chưa xong, hoặc dự án đã tắt AI SDLC. */
export const runGateMissing = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact"),
    /** Key tài liệu hub. */
    docKey: z.string(),
    /** "plan.md (Plan)", "contract refund-api". */
    name: z.string(),
    phase: z.string(),
    /** `revoked`: đang duyệt lại sau khi thu hồi tự duyệt. */
    reason: z.enum(["no_baseline", "revoked"]),
  }),
  z.object({ kind: z.literal("dependency"), taskId: id, key: z.string(), status: z.string() }),
  z.object({ kind: z.literal("project"), projectId: id, key: z.string() }),
]);
export type RunGateMissing = z.output<typeof runGateMissing>;
export const runGateErrorData = z
  .object({ code: z.string(), itemId: id.optional(), missing: z.array(runGateMissing).optional() })
  .optional();

export const runStartInput = z.object({
  taskId: id,
  /** Bỏ trống thì dùng CLI ưa thích của task, rồi tới bất kỳ CLI nào máy có. */
  cli: cli.optional(),
  /** Ghi đè model cấu hình của dự án cho run này. */
  model: z.string().trim().min(1).max(200).nullable().optional(),
  /** Đặt tay cấp độ task (thay cấp hub tự suy): chọn model, effort và số lượt tối đa theo cài đặt định tuyến. */
  tier: taskTier.optional(),
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

export const runStatusGroup = z.enum(RUN_STATUS_GROUP_NAMES);
export type RunStatusGroup = z.output<typeof runStatusGroup>;

export const runSearchInput = z.object({
  status: runStatusGroup.optional(),
  projectId: id.optional(),
  cli: cli.optional(),
  machineId: id.optional(),
  /** Run mình giao (chủ run, ADR 0017), cho mục Việc của tôi của app desktop. */
  mine: queryFlag.optional(),
  /** `nextCursor` của trang trước; bỏ trống là trang đầu. */
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RunSearchInput = z.output<typeof runSearchInput>;

/** Run trong danh sách, kèm mã và tiêu đề task để không phải tải cả danh sách task. */
export const runListItem = run.extend({ taskKey: z.string(), taskTitle: z.string() });
export type RunListItem = z.output<typeof runListItem>;

export const runSearchResult = z.object({
  items: z.array(runListItem),
  /** Id run cuối của trang; null khi đã hết. */
  nextCursor: id.nullable(),
  /**
   * Máy đã chạy run mình thấy được, để làm ô lọc theo máy (người không quản trị đội không gọi được machines.list).
   * Chỉ có ở trang đầu; trang sau trả mảng rỗng.
   */
  machines: z.array(z.object({ id, name: z.string() })),
});
export type RunSearchResult = z.output<typeof runSearchResult>;

export const runsContract = {
  start: orgRoute("POST", "/v1/runs", "Giao task cho agent (thành viên đội)", "runs")
    .errors({
      CONFLICT: { message: "Dữ liệu bị trùng hoặc xung đột.", data: runGateErrorData },
    })
    .input(runStartInput)
    .output(run),
  list: orgRoute("GET", "/v1/tasks/{taskId}/runs", "Các run của task, mới nhất trước", "runs")
    .input(z.object({ taskId: id }))
    .output(z.array(run)),
  latest: orgRoute("GET", "/v1/runs", "Run code mới nhất của mỗi task, lọc theo dự án", "runs")
    // Bảng việc cần run gần nhất của mọi task trong một lần gọi, thay vì gọi runs.list cho từng task.
    .input(z.object({ projectId: id.optional() }))
    .output(z.array(run)),
  search: orgRoute(
    "GET",
    "/v1/runs/search",
    "Run mình thấy được, mới nhất trước, lọc theo trạng thái, dự án, CLI, máy; phân trang bằng con trỏ",
    "runs",
  )
    .input(runSearchInput)
    .output(runSearchResult),
  get: orgRoute("GET", "/v1/runs/{id}", "Thông tin run", "runs").input(z.object({ id })).output(run),
  cancel: orgRoute(
    "POST",
    "/v1/runs/{id}/cancel",
    "Huỷ run (chủ run, quản trị đội; run của đội thì thành viên đội)",
    "runs",
  )
    .input(z.object({ id }))
    .output(run),
  steer: orgRoute(
    "POST",
    "/v1/runs/{id}/steer",
    "Gửi chỉ dẫn cho agent của run (chủ run; run của đội thì quản trị đội)",
    "runs",
  )
    .input(runSteerInput)
    .output(z.object({ status: runSteerStatus })),
  events: orgRoute("GET", "/v1/runs/{id}/events", "Sự kiện của run sau con trỏ `after`", "runs")
    .input(z.object({ id, after: cursor, limit }))
    .output(z.array(runEventView)),
  logs: orgRoute("GET", "/v1/runs/{id}/logs", "Đoạn log của run sau con trỏ `after`", "runs")
    .input(z.object({ id, after: cursor, limit }))
    .output(z.array(runLogChunk)),
};
