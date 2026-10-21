import type { Task, TaskChecklistItem, TaskCreateInput, TaskStatus, TaskUpdateInput } from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { allowWith, checkTeamRole, type TeamRole, teamRoleOf, teamRolesOf } from "../tenancy/index.ts";
import { dependenciesOf, withDependencies } from "./dependencies.ts";
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
    checklist: t.checklist,
  };
}

/** Agent đánh dấu mục theo id, nên hai mục trùng id thì không biết đánh vào mục nào. */
function checkChecklist(items: TaskChecklistItem[]): TaskChecklistItem[] {
  const ids = items.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new BadRequestError("TASK_CHECKLIST_DUPLICATE", `Checklist có hai mục cùng id "${dup}".`);
  return items;
}

/** Task trong tổ chức của context, không kiểm quyền: dành cho job và module runs (đã kiểm quyền ở chỗ khác). */
export async function loadTask(tx: Tx, id: string): Promise<TaskRow | null> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id));
  return row ?? null;
}

/** Nhiều task trong một truy vấn, không kiểm quyền: người gọi tự lọc theo đội (cây giao việc của Leader, specs/028). */
export async function loadTasks(tx: Tx, ids: string[]): Promise<TaskRow[]> {
  if (ids.length === 0) return [];
  return tx.select().from(tasks).where(inArray(tasks.id, ids));
}

/** Mã và tiêu đề của nhiều task trong một truy vấn, cho danh sách run. Không kiểm quyền; người gọi đã lọc theo đội. */
export async function taskSummaries(tx: Tx, ids: string[]): Promise<Map<string, { key: string; title: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: tasks.id, key: tasks.key, title: tasks.title })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  return new Map(rows.map((r) => [r.id, { key: r.key, title: r.title }]));
}

/** Task mà người dùng có ít nhất vai trò `min` trong đội sở hữu; không thấy được thì báo như không tồn tại. */
export async function taskForUser(
  tx: Tx,
  userId: string,
  id: string,
  min: TeamRole,
  /** Quyền của vai trò tự tạo thay được vai trò `min` (vd. plans.decide cho người xem đội). */
  permission?: string,
): Promise<TaskRow> {
  const row = await loadTask(tx, id);
  const role = row && (await teamRoleOf(tx, userId, row.teamId));
  if (!row || !role) throw notFound();
  if (permission) await allowWith(tx, userId, permission, async () => checkTeamRole(role, min), row.teamId);
  else checkTeamRole(role, min);
  return row;
}

/**
 * Task theo key (vd. `HD-12`) mà người dùng có ít nhất vai trò `min`; agent và CLI biết task qua key chứ không qua id.
 * Key chép lúc tạo nên dự án đổi key rồi trùng key cũ thì có thể ra hai dòng; lấy task mới nhất.
 */
export async function taskByKeyForUser(tx: Tx, userId: string, key: string, min: TeamRole): Promise<TaskRow> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.key, key)).orderBy(desc(tasks.createdAt)).limit(1);
  const role = row && (await teamRoleOf(tx, userId, row.teamId));
  if (!row || !role) throw notFound();
  checkTeamRole(role, min);
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
  const role = project && (await teamRoleOf(tx, userId, project.teamId));
  if (!project || !role) throw projectNotFound();
  checkTeamRole(role, "member");
  return toTask(await insertTask(tx, project, input, userId, source));
}

/**
 * Task do hệ thống tạo (issue GitHub/GitLab), không có người dùng hub đứng sau nên không kiểm vai trò. `createdBy` ghi
 * nguồn (vd. `github:lan`) để audit còn biết ai gây ra.
 */
export async function createSystemTask(
  tx: Tx,
  createdBy: string,
  input: TaskCreateInput & { checklist?: TaskChecklistItem[] },
  source: Record<string, unknown>,
): Promise<TaskRow> {
  const project = await loadProject(tx, input.projectId);
  if (!project) throw projectNotFound();
  return insertTask(tx, project, input, createdBy, source);
}

async function insertTask(
  tx: Tx,
  project: ProjectRow,
  input: TaskCreateInput & { checklist?: TaskChecklistItem[] },
  createdBy: string,
  source: Record<string, unknown>,
): Promise<TaskRow> {
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
      createdBy,
      source,
      checklist: checkChecklist(input.checklist ?? []),
    })
    .returning();
  if (!row) throw new Error("Không ghi được task.");
  await recordAudit(tx, {
    action: "task.create",
    targetType: "task",
    targetId: row.id,
    data: { projectId: project.id, key: row.key, title: row.title },
  });
  return row;
}

/** Task của dự án theo key (nhánh `ai/<key>` của run). Key chép lúc tạo nên có thể trùng sau khi đổi key; lấy mới nhất. */
export async function findTaskByKey(tx: Tx, projectId: string, key: string): Promise<TaskRow | null> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.key, key)))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return row ?? null;
}

/** Task đã tạo từ một issue của dự án, theo `source` ghi lúc tạo. */
export async function findTaskByIssue(
  tx: Tx,
  projectId: string,
  issue: { provider: string; number: number },
): Promise<TaskRow | null> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.source} @> ${JSON.stringify({ kind: "issue", provider: issue.provider, number: issue.number })}::jsonb`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Task của một dự án theo số thứ tự; không có `projectId` thì lấy task của mọi đội mình có vai trò, mới nhất trước. */
export async function listTasks(
  tx: Tx,
  userId: string,
  projectId?: string,
  status?: TaskStatus,
  mine?: boolean,
): Promise<Task[]> {
  // Việc của tôi: task mình tạo, hoặc có run mình giao. Hỏi bảng runs bằng SQL vì module tasks không import runs
  // (runs đã import tasks).
  const byMine = mine
    ? sql`(${tasks.createdBy} = ${userId} or exists (select 1 from hive.runs r where r.task_id = ${tasks.id} and r.owner_user_id = ${userId}))`
    : undefined;
  const byStatus = and(status ? eq(tasks.status, status) : undefined, byMine);
  if (projectId) {
    const project = await loadProject(tx, projectId);
    if (!project || !(await teamRoleOf(tx, userId, project.teamId))) throw projectNotFound();
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), byStatus))
      .orderBy(asc(tasks.number));
    return withDependenciesAll(tx, rows);
  }
  const rows = await tx.select().from(tasks).where(byStatus).orderBy(desc(tasks.createdAt));
  const roles = await teamRolesOf(
    tx,
    userId,
    rows.map((r) => r.teamId),
  );
  return withDependenciesAll(
    tx,
    rows.filter((r) => roles.has(r.teamId)),
  );
}

async function withDependenciesAll(tx: Tx, rows: TaskRow[]): Promise<Task[]> {
  const deps = await dependenciesOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...toTask(r), ...deps.get(r.id) }));
}

export async function getTask(tx: Tx, userId: string, id: string): Promise<Task> {
  return withDependencies(tx, toTask(await taskForUser(tx, userId, id, "viewer")));
}

export async function updateTask(tx: Tx, userId: string, input: TaskUpdateInput): Promise<Task> {
  const current = await taskForUser(tx, userId, input.id, "member");
  if (current.status === "cancelled") throw new ConflictError("TASK_CANCELLED", "Task đã huỷ, không sửa được.");
  if (input.status && ["queued", "running", "awaiting_plan"].includes(current.status)) {
    // Đổi tay lúc run đang chạy (hay đang chờ duyệt kế hoạch) sẽ bị run ghi đè khi kết thúc; bắt người dùng huỷ run
    // trước cho rõ ràng.
    throw new ConflictError("TASK_RUN_ACTIVE", "Task đang có run chạy; huỷ run trước khi đổi trạng thái.");
  }
  const patch: Partial<typeof tasks.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.type !== undefined) patch.type = input.type;
  if (input.preferredCli !== undefined) patch.preferredCli = input.preferredCli;
  if (input.status !== undefined) patch.status = input.status;
  if (input.checklist !== undefined) patch.checklist = checkChecklist(input.checklist);
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
  return withDependencies(tx, toTask(row));
}

/**
 * Đánh dấu xong/chưa xong từng mục checklist theo id, cho agent qua `task_update` và cho job; không kiểm quyền người
 * (người gọi đã kiểm run thuộc task). Không thay chữ của mục: chữ do người hay bản tách đặt. Id lạ thì từ chối cả lần
 * để agent biết mình đánh nhầm thay vì tưởng đã xong.
 */
export async function updateChecklist(tx: Tx, id: string, marks: { id: string; done: boolean }[]): Promise<TaskRow> {
  const [current] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!current) throw notFound();
  const done = new Map(marks.map((m) => [m.id, m.done]));
  const unknown = [...done.keys()].filter((k) => !current.checklist.some((c) => c.id === k));
  if (unknown.length > 0) {
    throw new BadRequestError(
      "TASK_CHECKLIST_ITEM_NOT_FOUND",
      `Checklist của task không có mục: ${unknown.join(", ")}.`,
    );
  }
  const checklist = current.checklist.map((c) => (done.has(c.id) ? { ...c, done: done.get(c.id) ?? c.done } : c));
  const [row] = await tx.update(tasks).set({ checklist, updatedAt: sql`now()` }).where(eq(tasks.id, id)).returning();
  if (!row) throw notFound();
  return row;
}

/**
 * Sửa task do hệ thống tạo khi nguồn của nó đổi (bản tách của AI SDLC duyệt lại): không kiểm quyền người. Chỉ sửa task
 * còn `todo`: task đã chạy giữ nguyên chữ để run và PR khớp với việc đã giao.
 */
export async function updateSystemTask(
  tx: Tx,
  id: string,
  patch: { title?: string; body?: string; checklist?: TaskChecklistItem[] },
): Promise<TaskRow | null> {
  const set: Partial<typeof tasks.$inferInsert> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.checklist !== undefined) set.checklist = checkChecklist(patch.checklist);
  const [row] = await tx
    .update(tasks)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(tasks.id, id), eq(tasks.status, "todo")))
    .returning();
  if (row)
    await recordAudit(tx, {
      action: "task.update",
      targetType: "task",
      targetId: row.id,
      data: { fields: Object.keys(set) },
    });
  return row ?? null;
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
