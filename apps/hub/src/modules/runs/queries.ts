import type { Run, RunEventView, RunLogChunk } from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { machineNames } from "../fleet/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { taskForUser } from "../tasks/index.ts";
import { type TeamRole, teamRoleOf } from "../tenancy/index.ts";
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
  const roles = new Map<string, TeamRole | null>();
  for (const teamId of new Set(rows.map((r) => r.teamId))) roles.set(teamId, await teamRoleOf(tx, userId, teamId));
  return withMachineNames(tx, rows.filter((r) => roles.get(r.teamId)).map(toRun));
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
