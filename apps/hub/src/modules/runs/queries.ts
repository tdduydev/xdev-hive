import {
  RUN_STATUS_GROUPS,
  type Run,
  type RunEventView,
  type RunLogChunk,
  type RunSearchInput,
  type RunSearchResult,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { machineNames } from "../fleet/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { taskForUser, taskSummaries } from "../tasks/index.ts";
import { teamRoleOf, teamRolesOf, visibleTeamIds } from "../tenancy/index.ts";
import { runForUser } from "./engine.ts";
import { runEvents, runLogs, runs } from "./schema.ts";
import { toRun } from "./state.ts";

/** Điền tên máy cho run trả về người xem, một truy vấn cho cả danh sách. */
export async function withMachineNames(tx: Tx, list: Run[]): Promise<Run[]> {
  const ids = [...new Set(list.flatMap((r) => (r.machineId ? [r.machineId] : [])))];
  if (ids.length === 0) return list;
  const names = await machineNames(tx, ids);
  return list.map((r) => ({ ...r, machineName: r.machineId ? (names.get(r.machineId) ?? null) : null }));
}

export async function getRun(tx: Tx, userId: string, id: string): Promise<Run> {
  const run = toRun(await runForUser(tx, userId, id, "viewer"));
  const [named = run] = await withMachineNames(tx, [run]);
  return named;
}

export async function listRuns(tx: Tx, userId: string, taskId: string): Promise<Run[]> {
  await taskForUser(tx, userId, taskId, "viewer");
  const rows = await tx.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.createdAt));
  return withMachineNames(tx, rows.map(toRun));
}

/**
 * Run code mới nhất của mỗi task (run review chéo không tính), trong một dự án hoặc mọi đội mình có vai trò. Bảng việc
 * gọi một lần thay vì runs.list cho từng task.
 */
export async function latestRuns(tx: Tx, userId: string, projectId?: string): Promise<Run[]> {
  if (projectId) {
    const project = await loadProject(tx, projectId);
    if (!project || !(await teamRoleOf(tx, userId, project.teamId))) {
      throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
    }
  }
  const rows = await tx
    .selectDistinctOn([runs.taskId])
    .from(runs)
    .where(and(eq(runs.kind, "code"), projectId ? eq(runs.projectId, projectId) : undefined))
    .orderBy(runs.taskId, desc(runs.createdAt));
  const roles = await teamRolesOf(
    tx,
    userId,
    rows.map((r) => r.teamId),
  );
  return withMachineNames(tx, rows.filter((r) => roles.has(r.teamId)).map(toRun));
}

/** Số máy tối đa trong ô lọc theo máy. */
const MACHINE_FACET_LIMIT = 200;

/**
 * Run của mọi đội mình có vai trò, mới nhất trước. Phân trang bằng con trỏ là id run cuối của trang trước: so
 * (created_at, id) ngay trong SQL với dòng của con trỏ, vì created_at có độ chính xác micro giây còn Date của JS chỉ
 * tới mili giây, mang thời gian ra JS rồi gửi lại sẽ bỏ sót hoặc lặp run tạo cùng mili giây.
 */
export async function searchRuns(tx: Tx, userId: string, input: RunSearchInput): Promise<RunSearchResult> {
  if (input.projectId) {
    const project = await loadProject(tx, input.projectId);
    if (!project || !(await teamRoleOf(tx, userId, project.teamId))) {
      throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
    }
  }
  const teamIds = await visibleTeamIds(tx, userId);
  if (teamIds.length === 0) return { items: [], nextCursor: null, machines: [] };
  const visible = inArray(runs.teamId, teamIds);
  const filters: (SQL | undefined)[] = [
    visible,
    input.status ? inArray(runs.state, [...RUN_STATUS_GROUPS[input.status]]) : undefined,
    input.projectId ? eq(runs.projectId, input.projectId) : undefined,
    input.cli ? eq(runs.cli, input.cli) : undefined,
    input.machineId ? eq(runs.machineId, input.machineId) : undefined,
    input.mine ? eq(runs.ownerUserId, userId) : undefined,
    // Con trỏ không còn (run đã bị xoá cùng task) thì so với null, trang trả rỗng thay vì quay về trang đầu.
    input.cursor
      ? sql`(${runs.createdAt}, ${runs.id}) < (select r.created_at, r.id from hive.runs r where r.id = ${input.cursor})`
      : undefined,
  ];
  const rows = await tx
    .select()
    .from(runs)
    .where(and(...filters))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const named = await withMachineNames(tx, page.map(toRun));
  // Run leader không gắn task: hiện như một cuộc trao đổi với leader thay vì mã việc.
  const tasks = await taskSummaries(tx, [...new Set(named.flatMap((r) => (r.taskId ? [r.taskId] : [])))]);
  const items = named.map((r) => ({
    ...r,
    taskKey: r.taskId ? (tasks.get(r.taskId)?.key ?? "") : "leader",
    taskTitle: r.taskId ? (tasks.get(r.taskId)?.title ?? "") : "Trao đổi với leader",
  }));
  let machines: RunSearchResult["machines"] = [];
  if (!input.cursor) {
    // Đi từ máy của tổ chức, mỗi máy hỏi index runs_machine xem có run của đội mình thấy không: số máy ít và không tăng
    // theo số run, còn distinct machine_id trên runs phải đọc mọi run của các đội. Máy đã xoá không có tên nên vốn không
    // hiện trong ô lọc. Hỏi bảng machines bằng SQL vì runs chỉ import fleet qua index.ts, như tasks hỏi bảng runs.
    const ids = await tx.execute<{ id: string }>(
      sql`select m.id from hive.machines m where exists (select 1 from ${runs} where ${runs.machineId} = m.id and ${visible}) limit ${MACHINE_FACET_LIMIT}`,
    );
    const names = await machineNames(
      tx,
      ids.rows.map((r) => r.id),
    );
    machines = [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }
  const last = page.at(-1);
  return { items, nextCursor: rows.length > input.limit && last ? last.id : null, machines };
}

/** Sự kiện có id lớn hơn `after`, cũ trước. Không kiểm quyền; người gọi đã kiểm. */
export async function eventsAfter(tx: Tx, runId: string, after: number, limit: number): Promise<RunEventView[]> {
  const rows = await tx
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, after)))
    .orderBy(asc(runEvents.id))
    .limit(limit);
  return rows.map((e) => ({
    id: e.id,
    attempt: e.attempt,
    seq: e.seq,
    type: e.type,
    data: e.data,
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function logsAfter(tx: Tx, runId: string, after: number, limit: number): Promise<RunLogChunk[]> {
  const rows = await tx
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, runId), gt(runLogs.id, after)))
    .orderBy(asc(runLogs.id))
    .limit(limit);
  return rows.map((l) => ({
    id: l.id,
    attempt: l.attempt,
    offset: l.offset,
    bytes: l.data.toString("base64"),
    createdAt: l.createdAt.toISOString(),
  }));
}

export async function listEvents(tx: Tx, userId: string, id: string, after: number, limit: number) {
  await runForUser(tx, userId, id, "viewer");
  return eventsAfter(tx, id, after, limit);
}

export async function listLogs(tx: Tx, userId: string, id: string, after: number, limit: number) {
  await runForUser(tx, userId, id, "viewer");
  return logsAfter(tx, id, after, limit);
}
