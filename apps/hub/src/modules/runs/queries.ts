import type { Run, RunEventView, RunLogChunk } from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { taskForUser } from "../tasks/index.ts";
import { runForUser } from "./engine.ts";
import { runEvents, runLogs, runs } from "./schema.ts";
import { toRun } from "./state.ts";

export async function getRun(tx: Tx, userId: string, id: string): Promise<Run> {
  return toRun(await runForUser(tx, userId, id, "viewer"));
}

export async function listRuns(tx: Tx, userId: string, taskId: string): Promise<Run[]> {
  await taskForUser(tx, userId, taskId, "viewer");
  const rows = await tx.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.createdAt));
  return rows.map(toRun);
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
