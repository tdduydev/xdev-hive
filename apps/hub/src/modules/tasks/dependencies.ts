import type { Task, TaskBlocker, TaskSetDependenciesInput } from "@xdev-hive/contracts";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { checkTeamRole, teamRolesOf } from "../tenancy/index.ts";
import { taskDependencies, tasks } from "./schema.ts";

type TaskRow = typeof tasks.$inferSelect;

export interface TaskDependencyView {
  dependsOn: string[];
  blockedBy: TaskBlocker[];
}

const notFound = () => new NotFoundError("TASK_NOT_FOUND", "Không tìm thấy task trong tổ chức.");

/**
 * Phụ thuộc và phần còn chặn của nhiều task trong một truy vấn. Không kiểm quyền: task chặn thuộc dự án khác vẫn hiện
 * để người xem biết đang chờ gì (FR-027). Key dự án đọc thẳng `hive.projects` vì tasks không import bảng của catalog.
 */
export async function dependenciesOf(tx: Tx, taskIds: string[]): Promise<Map<string, TaskDependencyView>> {
  const out = new Map<string, TaskDependencyView>(taskIds.map((id) => [id, { dependsOn: [], blockedBy: [] }]));
  if (taskIds.length === 0) return out;
  const rows = await tx
    .select({
      taskId: taskDependencies.taskId,
      id: tasks.id,
      key: tasks.key,
      title: tasks.title,
      status: tasks.status,
      projectId: tasks.projectId,
      projectKey: sql<string>`(select p.key from hive.projects p where p.id = ${tasks.projectId})`,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
    .where(inArray(taskDependencies.taskId, taskIds))
    .orderBy(tasks.key);
  for (const { taskId, ...dep } of rows) {
    const view = out.get(taskId);
    if (!view) continue;
    view.dependsOn.push(dep.id);
    // Task phụ thuộc đã huỷ vẫn chặn: nó không bao giờ `done`, người duyệt phải bỏ phụ thuộc hoặc huỷ theo.
    if (dep.status !== "done") view.blockedBy.push(dep);
  }
  return out;
}

export async function withDependencies(tx: Tx, task: Task): Promise<Task> {
  const view = (await dependenciesOf(tx, [task.id])).get(task.id);
  return { ...task, ...view };
}

/**
 * Tìm đường từ một task trong `starts` đi theo cạnh "phụ thuộc" về lại `target`; có đường thì thêm cạnh target → start
 * sẽ thành vòng. Cạnh cũ của `target` bỏ qua vì sắp bị thay. Đi từng tầng, mỗi tầng một truy vấn, nên đồ thị của cả tổ
 * chức không phải nạp hết. Trả đường đi `target → … → target` hoặc null.
 */
async function findCycle(tx: Tx, target: string, starts: string[]): Promise<string[] | null> {
  const parent = new Map<string, string>(starts.map((s) => [s, target]));
  let frontier = starts;
  while (frontier.length > 0) {
    const edges = await tx
      .select({ from: taskDependencies.taskId, to: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .where(and(inArray(taskDependencies.taskId, frontier), ne(taskDependencies.taskId, target)));
    const next: string[] = [];
    for (const { from, to } of edges) {
      if (to === target) {
        const path = [target];
        for (let at: string | undefined = from; at && at !== target; at = parent.get(at)) path.unshift(at);
        path.unshift(target);
        return path;
      }
      if (parent.has(to)) continue;
      parent.set(to, from);
      next.push(to);
    }
    frontier = next;
  }
  return null;
}

/**
 * Thay cả danh sách phụ thuộc của task. `userId` null là tác nhân hệ thống (áp bản tách của `sdlc`): không kiểm quyền
 * người. Người dùng phải sửa được task ở mọi dự án bị đụng tới, gồm cả dự án của cạnh bị bỏ (D24).
 */
export async function setTaskDependencies(
  tx: Tx,
  userId: string | null,
  input: TaskSetDependenciesInput,
): Promise<{ task: TaskRow; added: string[]; removed: string[] }> {
  const dependsOn = [...new Set(input.dependsOn)];
  // Khoá theo tổ chức: hai lần ghi cùng lúc ở hai dự án vẫn có thể cùng tạo một vòng nếu chỉ khoá theo dự án.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('task_dependencies:' || hive.ctx_org()::text, 0))`,
  );
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!task) throw notFound();

  const current = await tx
    .select({ id: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, task.id));
  const before = new Set(current.map((r) => r.id));
  const added = dependsOn.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !dependsOn.includes(id));

  const touched = await loadTasks(tx, [...added, ...removed]);
  if (added.some((id) => !touched.has(id))) throw notFound();
  if (userId) await requireEditable(tx, userId, task, added, touched);
  // Kiểm sau quyền để người không thấy task không biết được trạng thái hay key của nó.
  if (task.status === "cancelled") throw new ConflictError("TASK_CANCELLED", "Task đã huỷ, không sửa được.");
  if (dependsOn.includes(task.id)) {
    throw new ConflictError("TASK_DEPENDENCY_CYCLE", `Phụ thuộc vòng: ${task.key} → ${task.key}.`);
  }

  if (added.length > 0) {
    const cycle = await findCycle(tx, task.id, added);
    if (cycle) {
      const keys = await loadTasks(tx, cycle);
      const path = cycle.map((id) => keys.get(id)?.key ?? id).join(" → ");
      throw new ConflictError("TASK_DEPENDENCY_CYCLE", `Phụ thuộc vòng: ${path}.`);
    }
  }

  if (removed.length > 0) {
    await tx
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.taskId, task.id), inArray(taskDependencies.dependsOnId, removed)));
  }
  if (added.length > 0) {
    await tx
      .insert(taskDependencies)
      .values(added.map((id) => ({ orgId: sql`hive.ctx_org()`, taskId: task.id, dependsOnId: id })))
      .onConflictDoNothing();
  }
  if (added.length > 0 || removed.length > 0) {
    const projectIds = [...new Set([task.projectId, ...[...touched.values()].map((t) => t.projectId)])];
    await recordAudit(tx, {
      action: "task.dependencies",
      targetType: "task",
      targetId: task.id,
      // Ghi mọi dự án bị đụng tới để audit của dự án bên kia cũng tìm ra thay đổi liên dự án.
      data: {
        key: task.key,
        projectId: task.projectId,
        projectIds,
        added: added.map((id) => touched.get(id)?.key ?? id),
        removed: removed.map((id) => touched.get(id)?.key ?? id),
        system: userId === null,
      },
    });
  }
  return { task, added, removed };
}

async function loadTasks(tx: Tx, ids: string[]): Promise<Map<string, TaskRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select().from(tasks).where(inArray(tasks.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Người dùng cần vai trò thành viên trở lên ở đội của task và của mọi task phụ thuộc thêm hay bỏ. Task thêm vào mà
 * người dùng không thấy được báo như không tồn tại, giống taskForUser.
 */
async function requireEditable(
  tx: Tx,
  userId: string,
  task: TaskRow,
  added: string[],
  touched: Map<string, TaskRow>,
): Promise<void> {
  const all = [task, ...touched.values()];
  const roles = await teamRolesOf(tx, userId, [...new Set(all.map((t) => t.teamId))]);
  if (!roles.has(task.teamId) || added.some((id) => !roles.has(touched.get(id)?.teamId ?? ""))) throw notFound();
  for (const t of all) checkTeamRole(roles.get(t.teamId) ?? null, "member");
}
