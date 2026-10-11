import type { Task, TaskCreateInput, TaskStatus, TaskUpdateInput } from "@xdev-hive/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireTeamRole, type TeamRole, teamRoleOf } from "../tenancy/index.ts";
import { tasks } from "./schema.ts";

export type TaskRow = typeof tasks.$inferSelect;

const notFound = () => new NotFoundError("TASK_NOT_FOUND", "Không tìm thấy task trong tổ chức.");
const projectNotFound = () => new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");

export function toTask(t: TaskRow): Task {
  return {
    id: t.id,
    projectId: t.projectId,
    teamId: t.teamId,
    key: t.key,
    number: t.number,
    title: t.title,
    body: t.body,
    type: t.type,
    status: t.status,
    preferredCli: t.preferredCli,
    source: t.source,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Task trong tổ chức của context, không kiểm quyền: dành cho job và module runs (đã kiểm quyền ở chỗ khác). */
export async function loadTask(tx: Tx, id: string): Promise<TaskRow | null> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
  return row ?? null;
}

/** Task mà người dùng có ít nhất vai trò `min` trong đội sở hữu; không thấy được thì báo như không tồn tại. */
export async function taskForUser(tx: Tx, userId: string, id: string, min: TeamRole): Promise<TaskRow> {
  const row = await loadTask(tx, id);
  if (!row || !(await teamRoleOf(tx, userId, row.teamId))) throw notFound();
  await requireTeamRole(tx, userId, row.teamId, min);
  return row;
}

/**
 * Task theo key (vd. `HD-12`) mà người dùng có ít nhất vai trò `min`; agent và CLI biết task qua key chứ không qua id.
 * Key chép lúc tạo nên dự án đổi key rồi trùng key cũ thì có thể ra hai dòng; lấy task mới nhất.
 */
export async function taskByKeyForUser(tx: Tx, userId: string, key: string, min: TeamRole): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.key, key)).orderBy(desc(tasks.createdAt)).limit(1);
  if (!row || !(await teamRoleOf(tx, userId, row.teamId))) throw notFound();
  await requireTeamRole(tx, userId, row.teamId, min);
  return row;
}

/** Đổi trạng thái task do run quyết định. Task đã huỷ thì giữ nguyên: run kết thúc muộn không mở lại task. */
export async function setTaskStatus(tx: Tx, id: string, status: TaskStatus): Promise<void> {
  await tx
    .update(tasks)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(tasks.id, id), sql`${tasks.status} <> 'cancelled'`));
}

export async function createTask(
  tx: Tx,
  userId: string,
  input: TaskCreateInput,
  source: Record<string, unknown> = { kind: "web" },
): Promise<Task> {
  const project = await loadProject(tx, input.projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId))) throw projectNotFound();
  await requireTeamRole(tx, userId, project.teamId, "member");
  if (project.state === "archived") throw new ConflictError("PROJECT_ARCHIVED", "Dự án đã lưu trữ, không thêm task.");
  // Khoá theo dự án tới hết transaction để hai task tạo cùng lúc không lấy cùng số thứ tự.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tasks:${project.id}`}, 0))`);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${tasks.number}), 0) + 1` })
    .from(tasks)
    .where(eq(tasks.projectId, project.id));
  const number = Number(next);
  const [row] = await tx
    .insert(tasks)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: project.teamId,
      projectId: project.id,
      number,
      key: `${project.key}-${number}`,
      title: input.title,
      body: input.body,
      type: input.type ?? null,
      preferredCli: input.preferredCli ?? null,
      createdBy: userId,
      source,
    })
    .returning();
  if (!row) throw new Error("Không ghi được task.");
  await recordAudit(tx, {
    action: "task.create",
    targetType: "task",
    targetId: row.id,
    data: { projectId: project.id, key: row.key, title: row.title },
  });
  return toTask(row);
}

export async function listTasks(tx: Tx, userId: string, projectId: string, status?: TaskStatus): Promise<Task[]> {
  const project = await loadProject(tx, projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId))) throw projectNotFound();
  const rows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), status ? eq(tasks.status, status) : undefined))
    .orderBy(asc(tasks.number));
  return rows.map(toTask);
}

export async function getTask(tx: Tx, userId: string, id: string): Promise<Task> {
  return toTask(await taskForUser(tx, userId, id, "viewer"));
}

export async function updateTask(tx: Tx, userId: string, input: TaskUpdateInput): Promise<Task> {
  const current = await taskForUser(tx, userId, input.id, "member");
  if (current.status === "cancelled") throw new ConflictError("TASK_CANCELLED", "Task đã huỷ, không sửa được.");
  if (input.status && ["queued", "running"].includes(current.status)) {
    // Đổi tay lúc run đang chạy sẽ bị run ghi đè khi kết thúc; bắt người dùng huỷ run trước cho rõ ràng.
    throw new ConflictError("TASK_RUN_ACTIVE", "Task đang có run chạy; huỷ run trước khi đổi trạng thái.");
  }
  const patch: Partial<typeof tasks.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.type !== undefined) patch.type = input.type;
  if (input.preferredCli !== undefined) patch.preferredCli = input.preferredCli;
  if (input.status !== undefined) patch.status = input.status;
  const [row] = await tx
    .update(tasks)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(tasks.id, current.id))
    .returning();
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "task.update",
    targetType: "task",
    targetId: row.id,
    data: { fields: Object.keys(patch) },
  });
  return toTask(row);
}

/**
 * Huỷ task. `cancelRuns` (module runs gắn vào) huỷ run đang chạy trong cùng transaction và trả việc cần làm sau commit
 * (gửi lệnh huỷ tới máy), để lệnh huỷ không tới máy khi transaction rollback.
 */
export async function cancelTask(
  tx: Tx,
  userId: string,
  id: string,
  cancelRuns?: (tx: Tx, taskId: string) => Promise<() => void>,
): Promise<{ task: Task; afterCommit: () => void }> {
  const current = await taskForUser(tx, userId, id, "member");
  if (current.status === "cancelled") return { task: toTask(current), afterCommit: () => {} };
  if (current.status === "done") throw new ConflictError("TASK_DONE", "Task đã xong, không huỷ được.");
  const afterCommit = cancelRuns ? await cancelRuns(tx, current.id) : () => {};
  const [row] = await tx
    .update(tasks)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(eq(tasks.id, current.id))
    .returning();
  if (!row) throw notFound();
  await recordAudit(tx, { action: "task.cancel", targetType: "task", targetId: row.id, data: { key: row.key } });
  return { task: toTask(row), afterCommit };
}
