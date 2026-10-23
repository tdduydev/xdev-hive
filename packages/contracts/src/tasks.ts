import { z } from "zod";
import { taskHistoryItem } from "./client-events.ts";
import { id, orgRoute, queryFlag } from "./common.ts";
import { run } from "./runs.ts";
import { cli } from "./worker-protocol.ts";

/**
 * `queued`, `running`, `awaiting_plan`, `review` do module runs đặt theo run mới nhất của task; người dùng chỉ đặt tay
 * `todo` và `done` (huỷ đi qua tasks.cancel để huỷ cả run đang chạy). `awaiting_plan`: dự án bật plan mode, agent đã
 * lập kế hoạch và đang chờ người duyệt.
 */
export const taskStatus = z.enum(["todo", "queued", "running", "awaiting_plan", "review", "done", "cancelled"]);
export type TaskStatus = z.output<typeof taskStatus>;

/** Loại task chọn nhánh `outcome.byType` của chính sách kết quả; bỏ trống thì dùng `outcome.default`. */
const taskType = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Loại task gồm chữ thường, số và gạch ngang.");

const title = z.string().trim().min(1, "Tiêu đề không được để trống.").max(200, "Tiêu đề dài tối đa 200 ký tự.");
const body = z.string().max(50_000, "Nội dung dài tối đa 50.000 ký tự.");

/** Mục checklist của task (specs/011 FR-027): bước nhỏ trong task thay vì task riêng trên bảng. */
export const taskChecklistItem = z.object({
  /** Ổn định qua các lần áp bản tách, để agent đánh dấu bằng `task_update` đúng mục. */
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(500),
  done: z.boolean().default(false),
  /** Mã requirement mục này làm (FR-001, R-3…). */
  requirementIds: z.array(z.string().max(40)).max(20).default([]),
});
export type TaskChecklistItem = z.output<typeof taskChecklistItem>;
export const TASK_CHECKLIST_MAX = 50;
export const TASK_DEPENDENCIES_MAX = 50;

/** Task đang chặn task này; `projectKey` để hiện "Chờ web-shop-12" khi khác dự án (D24). */
export const taskBlocker = z.object({
  id,
  key: z.string(),
  title: z.string(),
  status: taskStatus,
  projectId: id,
  projectKey: z.string(),
});
export type TaskBlocker = z.output<typeof taskBlocker>;

export const task = z.object({
  id,
  projectId: id,
  teamId: id,
  /** `<project key>-<số thứ tự>`; nhánh của run là `ai/<key>`. */
  key: z.string(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  type: z.string().nullable(),
  status: taskStatus,
  preferredCli: cli.nullable(),
  /** Nơi task sinh ra (web, issue GitHub/GitLab…). */
  source: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  // Thêm cho AI SDLC (specs/011); hub chưa có cột thì không trả, client coi như rỗng.
  checklist: z.array(taskChecklistItem).optional(),
  /** Task phải `done` trước khi task này chạy được; có thể khác dự án trong cùng tổ chức. */
  dependsOn: z.array(id).optional(),
  /** Phần của `dependsOn` chưa `done`. */
  blockedBy: z.array(taskBlocker).optional(),
});
export type Task = z.output<typeof task>;

export const taskCreateInput = z.object({
  projectId: id,
  title,
  body: body.default(""),
  type: taskType.optional(),
  preferredCli: cli.optional(),
});
export type TaskCreateInput = z.output<typeof taskCreateInput>;

export const taskUpdateInput = z.object({
  id,
  title: title.optional(),
  body: body.optional(),
  type: taskType.nullish(),
  preferredCli: cli.nullish(),
  status: z.enum(["todo", "done"]).optional(),
  /** Thay cả checklist. */
  checklist: z.array(taskChecklistItem).max(TASK_CHECKLIST_MAX, "Checklist tối đa 50 mục.").optional(),
});
export type TaskUpdateInput = z.output<typeof taskUpdateInput>;

// ---- Plan mode -----------------------------------------------------------------------------------------------

/**
 * Kế hoạch agent nộp qua tool MCP `plan_submit` trong run `plan`; người duyệt có thể sửa trước khi duyệt. Cùng một
 * schema cho tool, API và cột jsonb `plans.content`, nên kế hoạch đã lưu luôn đọc lại được.
 */
export const planContent = z.object({
  summary: z
    .string()
    .trim()
    .min(1, "Tóm tắt kế hoạch không được để trống.")
    .max(20_000)
    .describe("Tóm tắt cách làm: hiểu yêu cầu ra sao, hướng giải quyết chính."),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1, "Bước cần có tiêu đề.").max(500),
        detail: z.string().max(10_000).optional(),
      }),
    )
    .min(1, "Kế hoạch cần ít nhất một bước.")
    .max(100)
    .describe("Các bước sẽ làm, theo thứ tự."),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(500),
        change: z.enum(["add", "modify", "delete"]).optional(),
        reason: z.string().max(2000).optional(),
      }),
    )
    .max(500)
    .default([])
    .describe("File dự kiến đụng tới: đường dẫn, thêm/sửa/xoá, lý do."),
  risks: z.array(z.string().trim().min(1).max(4000)).max(100).default([]).describe("Rủi ro và cách giảm."),
  questions: z
    .array(z.string().trim().min(1).max(4000))
    .max(50)
    .default([])
    .describe("Câu hỏi cho người duyệt; trả lời trong ghi chú khi duyệt."),
});
export type PlanContent = z.output<typeof planContent>;

/** `superseded`: run chờ kế hoạch đã bị huỷ hoặc kết thúc trước khi có người quyết. */
export const planStatus = z.enum(["awaiting", "approved", "rejected", "superseded"]);
export type PlanStatus = z.output<typeof planStatus>;

export const plan = z.object({
  id,
  taskId: id,
  /** Run code chờ kế hoạch này; duyệt thì run này chạy tiếp theo kế hoạch. */
  runId: id,
  /** Run `plan` đã lập kế hoạch. */
  planRunId: id,
  /** Lần lập kế hoạch thứ mấy của task (lập lại sau khi bị từ chối thì tăng). */
  revision: z.number().int(),
  status: planStatus,
  /** Kế hoạch agent nộp. */
  content: planContent,
  /** Bản người duyệt đã sửa; null khi duyệt nguyên bản hoặc chưa duyệt. Run code dùng bản này nếu có. */
  editedContent: planContent.nullable(),
  /** Ghi chú khi duyệt, hoặc lý do khi từ chối. */
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Plan = z.output<typeof plan>;

export const planApproveInput = z.object({
  /** Task. */
  id,
  /** Kế hoạch người duyệt đang xem; kế hoạch đã đổi (lập lại) thì từ chối để không duyệt nhầm bản cũ. */
  planId: id,
  /** Chuỗi rỗng coi như không ghi chú. */
  note: z.string().trim().max(10_000, "Ghi chú dài tối đa 10.000 ký tự.").optional(),
  /** Kế hoạch đã sửa; bỏ trống là duyệt nguyên bản agent nộp. */
  content: planContent.optional(),
});
export type PlanApproveInput = z.output<typeof planApproveInput>;

export const planRejectInput = z.object({
  id,
  planId: id,
  reason: z.string().trim().min(1, "Cần ghi lý do từ chối.").max(10_000, "Lý do dài tối đa 10.000 ký tự."),
  /** Lập kế hoạch lại ngay, đưa lý do từ chối cho agent; không chọn thì task về todo. */
  replan: z.boolean().default(false),
});
export type PlanRejectInput = z.output<typeof planRejectInput>;

/**
 * Mọi lần lập kế hoạch của task, lần mới nhất trước, để người duyệt thấy các bản bị từ chối và lý do. `canDecide`:
 * người xem có quyền duyệt hay từ chối không (như quyền giao việc); web dựa vào đây để hiện màn chỉ đọc.
 */
export const planHistory = z.object({ plans: z.array(plan), canDecide: z.boolean() });
export type PlanHistory = z.output<typeof planHistory>;

/** Kết quả duyệt hay từ chối: kế hoạch sau khi quyết và run đang mang task (run code chạy tiếp, run đã huỷ, hoặc run lập lại). */
export const planDecision = z.object({ plan, run });
export type PlanDecision = z.output<typeof planDecision>;

export const plansContract = {
  get: orgRoute("GET", "/v1/tasks/{id}/plan", "Kế hoạch mới nhất của task (plan mode)", "tasks")
    .input(z.object({ id }))
    .output(plan),
  list: orgRoute("GET", "/v1/tasks/{id}/plans", "Các lần lập kế hoạch của task, mới nhất trước (plan mode)", "tasks")
    .input(z.object({ id }))
    .output(planHistory),
  approve: orgRoute(
    "POST",
    "/v1/tasks/{id}/plan/approve",
    "Duyệt kế hoạch, có thể kèm bản sửa và ghi chú; run code chạy theo kế hoạch đã duyệt (thành viên đội)",
    "tasks",
  )
    .input(planApproveInput)
    .output(planDecision),
  reject: orgRoute(
    "POST",
    "/v1/tasks/{id}/plan/reject",
    "Từ chối kế hoạch kèm lý do; chọn lập lại thì agent lập kế hoạch mới (thành viên đội)",
    "tasks",
  )
    .input(planRejectInput)
    .output(planDecision),
};

export const taskSetDependenciesInput = z
  .object({
    taskId: id,
    /** Thay cả danh sách; rỗng là bỏ mọi phụ thuộc. */
    dependsOn: z.array(id).max(TASK_DEPENDENCIES_MAX, "Task phụ thuộc tối đa 50 task."),
  })
  .refine((d) => !d.dependsOn.includes(d.taskId), {
    message: "Task không phụ thuộc chính nó.",
    path: ["dependsOn"],
  })
  .transform((d) => ({ ...d, dependsOn: [...new Set(d.dependsOn)] }));
export type TaskSetDependenciesInput = z.input<typeof taskSetDependenciesInput>;

export const tasksContract = {
  create: orgRoute("POST", "/v1/tasks", "Tạo task trong dự án (thành viên đội)", "tasks")
    .input(taskCreateInput)
    .output(task),
  list: orgRoute("GET", "/v1/tasks", "Task của một dự án, hoặc của mọi dự án mình thấy được", "tasks")
    // Bỏ trống projectId cho bảng việc chung của cả tổ chức (web /tasks).
    .input(
      z.object({
        projectId: id.optional(),
        status: taskStatus.optional(),
        /** Việc của tôi (app desktop): task mình tạo hoặc có run mình giao (chủ run, ADR 0017). */
        mine: queryFlag.optional(),
      }),
    )
    .output(z.array(task)),
  get: orgRoute("GET", "/v1/tasks/{id}", "Thông tin task", "tasks").input(z.object({ id })).output(task),
  update: orgRoute("PATCH", "/v1/tasks/{id}", "Sửa task (thành viên đội)", "tasks").input(taskUpdateInput).output(task),
  cancel: orgRoute("POST", "/v1/tasks/{id}/cancel", "Huỷ task và run đang chạy của nó (thành viên đội)", "tasks")
    .input(z.object({ id }))
    .output(task),
  setDependencies: orgRoute(
    "POST",
    "/v1/tasks/{taskId}/dependencies",
    "Đặt phụ thuộc của task, kể cả task dự án khác (cần quyền sửa task ở cả hai dự án; từ chối chu trình)",
    "tasks",
  )
    .input(taskSetDependenciesInput)
    .output(task),
  history: orgRoute(
    "GET",
    "/v1/tasks/{id}/history",
    "Lịch sử ghi của task: lần ghi từ client (nguồn, máy, giờ tạo, giờ nhận, lý do từ chối) và trạng thái run",
    "tasks",
  )
    .input(z.object({ id }))
    .output(z.array(taskHistoryItem)),
  plans: plansContract,
};
