import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { cli } from "./worker-protocol.ts";

/**
 * `queued`, `running`, `review` do module runs đặt theo run mới nhất của task; người dùng chỉ đặt tay `todo` và `done`
 * (huỷ đi qua tasks.cancel để huỷ cả run đang chạy).
 */
export const taskStatus = z.enum(["todo", "queued", "running", "review", "done", "cancelled"]);
export type TaskStatus = z.output<typeof taskStatus>;

/** Loại task chọn nhánh `outcome.byType` của chính sách kết quả; bỏ trống thì dùng `outcome.default`. */
const taskType = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Loại task gồm chữ thường, số và gạch ngang.");

const title = z.string().trim().min(1, "Tiêu đề không được để trống.").max(200, "Tiêu đề dài tối đa 200 ký tự.");
const body = z.string().max(50_000, "Nội dung dài tối đa 50.000 ký tự.");

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
});
export type TaskUpdateInput = z.output<typeof taskUpdateInput>;

export const tasksContract = {
  create: orgRoute("POST", "/v1/tasks", "Tạo task trong dự án (thành viên đội)", "tasks")
    .input(taskCreateInput)
    .output(task),
  list: orgRoute("GET", "/v1/tasks", "Task của một dự án", "tasks")
    .input(z.object({ projectId: id, status: taskStatus.optional() }))
    .output(z.array(task)),
  get: orgRoute("GET", "/v1/tasks/{id}", "Thông tin task", "tasks").input(z.object({ id })).output(task),
  update: orgRoute("PATCH", "/v1/tasks/{id}", "Sửa task (thành viên đội)", "tasks").input(taskUpdateInput).output(task),
  cancel: orgRoute("POST", "/v1/tasks/{id}/cancel", "Huỷ task và run đang chạy của nó (thành viên đội)", "tasks")
    .input(z.object({ id }))
    .output(task),
};
