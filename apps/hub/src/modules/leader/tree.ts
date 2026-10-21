import {
  type DelegationTree,
  type RunState,
  TERMINAL_RUN_STATES,
  type TreeRun,
  type TreeSubagent,
  type TreeTask,
} from "@xdev-hive/contracts";
import { subagentEventData } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { machineNames } from "../fleet/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { runEvents, runForUser, runs } from "../runs/index.ts";
import { loadTasks, taskForUser } from "../tasks/index.ts";
import { teamRolesOf } from "../tenancy/index.ts";
import { chatThreads, leaderDelegations } from "./schema.ts";

/** Trần số run mỗi cây (plan.md, rủi ro "cây lớn"): poll 3 giây không được đọc vô hạn. */
export const TREE_RUN_LIMIT = 500;

const finished = (state: RunState) => TERMINAL_RUN_STATES.includes(state);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

type RunRow = typeof runs.$inferSelect;
type EventRow = { runId: string; attempt: number; data: Record<string, unknown> };

/**
 * Gộp sự kiện `subagent` của một run (đã xếp theo lần thử, seq) thành nút: start tạo nút, end cập nhật. Sub-agent chưa
 * end mà run đã kết thúc, hay thuộc lần thử cũ, thì không còn ai báo end nữa nên ghi `unknown` thay vì treo `running`.
 */
export function foldSubagents(
  run: { attempt: number; state: RunState },
  events: EventRow[],
): { subagents: TreeSubagent[] | null; unsupported: boolean } {
  if (events.length === 0) return { subagents: null, unsupported: false };
  const nodes = new Map<string, TreeSubagent & { attempt: number }>();
  let unsupported = false;
  for (const event of events) {
    const parsed = subagentEventData.safeParse(event.data);
    if (!parsed.success) continue;
    const d = parsed.data;
    if (d.phase === "unsupported") {
      unsupported = true;
      continue;
    }
    const prev = nodes.get(d.id);
    nodes.set(d.id, {
      id: d.id,
      parentId: d.parentId ?? prev?.parentId ?? null,
      type: d.type || prev?.type || "",
      description: d.description || prev?.description || "",
      status: d.phase === "start" && prev && prev.status !== "running" ? prev.status : d.status,
      depth: d.depth,
      tokens: d.tokens ?? prev?.tokens ?? null,
      toolUses: d.toolUses ?? prev?.toolUses ?? null,
      durationMs: d.durationMs ?? prev?.durationMs ?? null,
      attempt: event.attempt,
    });
  }
  const done = finished(run.state);
  const subagents = [...nodes.values()].map(({ attempt, ...node }) =>
    node.status === "running" && (done || attempt !== run.attempt) ? { ...node, status: "unknown" as const } : node,
  );
  return { subagents, unsupported };
}

function runError(row: RunRow): string | null {
  if (row.state !== "failed") return null;
  const reasons = row.result?.reasons ?? [];
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/**
 * Cây giao việc của một phiên Leader (specs/028): task Leader tạo hay giao run trong phiên, mọi run của các task đó (run
 * review, plan trỏ về run cha qua parentRunId) và sub-agent của từng run. Task của đội người xem không có vai trò bị ẩn
 * và chỉ đếm vào `hidden`, như taskForUser coi là không tồn tại.
 */
export async function delegationTree(tx: Tx, userId: string, threadId: string): Promise<DelegationTree> {
  // Như threads.get: phiên thấy được theo tổ chức (RLS), không thấy thì báo không tồn tại.
  const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
  if (!thread) throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
  const links = await tx
    .select({ kind: leaderDelegations.kind, taskId: leaderDelegations.taskId })
    .from(leaderDelegations)
    .where(eq(leaderDelegations.threadId, thread.id))
    .orderBy(asc(leaderDelegations.createdAt), asc(leaderDelegations.id));
  const taskOrder = [...new Set(links.map((l) => l.taskId))];
  const createdByLeader = new Set(links.filter((l) => l.kind === "task").map((l) => l.taskId));
  const taskRows = await loadTasks(tx, taskOrder);
  const roles = await teamRolesOf(tx, userId, [...new Set(taskRows.map((t) => t.teamId))]);
  const visible = taskRows.filter((t) => roles.has(t.teamId));
  const hiddenTaskIds = taskRows.filter((t) => !roles.has(t.teamId)).map((t) => t.id);

  const visibleIds = visible.map((t) => t.id);
  // Lấy run mới nhất khi quá trần: người xem cần việc đang chạy hơn lịch sử cũ.
  const runRows =
    visibleIds.length === 0
      ? []
      : (
          await tx
            .select()
            .from(runs)
            .where(inArray(runs.taskId, visibleIds))
            .orderBy(desc(runs.createdAt), desc(runs.id))
            .limit(TREE_RUN_LIMIT)
        ).reverse();
  const [hiddenRuns] =
    hiddenTaskIds.length === 0
      ? [{ n: 0 }]
      : await tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(inArray(runs.taskId, hiddenTaskIds));

  const runIds = runRows.map((r) => r.id);
  const events =
    runIds.length === 0
      ? []
      : await tx
          .select({ runId: runEvents.runId, attempt: runEvents.attempt, data: runEvents.data })
          .from(runEvents)
          .where(and(inArray(runEvents.runId, runIds), eq(runEvents.type, "subagent")))
          .orderBy(asc(runEvents.runId), asc(runEvents.attempt), asc(runEvents.seq), asc(runEvents.id));
  const eventsByRun = new Map<string, EventRow[]>();
  for (const e of events) eventsByRun.set(e.runId, [...(eventsByRun.get(e.runId) ?? []), e]);

  const names = await machineNames(tx, [...new Set(runRows.flatMap((r) => (r.machineId ? [r.machineId] : [])))]);
  const projectKeys = new Map<string, string>();
  for (const projectId of new Set(visible.map((t) => t.projectId))) {
    const project = await loadProject(tx, projectId);
    if (project) projectKeys.set(projectId, project.key);
  }

  let active = false;
  const runsByTask = new Map<string, TreeRun[]>();
  for (const row of runRows) {
    const { subagents, unsupported } = foldSubagents(row, eventsByRun.get(row.id) ?? []);
    if (!finished(row.state) || subagents?.some((s) => s.status === "running")) active = true;
    const name = row.machineId ? names.get(row.machineId) : undefined;
    const node: TreeRun = {
      id: row.id,
      kind: row.kind,
      state: row.state,
      attempt: row.attempt,
      parentRunId: row.parentRunId,
      machine: row.machineId && name !== undefined ? { id: row.machineId, name } : null,
      cli: row.cli,
      account: row.accountId,
      startedAt: iso(row.startedAt),
      endedAt: iso(row.finishedAt),
      costUsd: row.costUsd,
      error: runError(row),
      subagents,
      subagentsUnsupported: unsupported,
    };
    if (row.taskId) runsByTask.set(row.taskId, [...(runsByTask.get(row.taskId) ?? []), node]);
  }

  const byId = new Map(visible.map((t) => [t.id, t]));
  const tasks: TreeTask[] = taskOrder.flatMap((id) => {
    const t = byId.get(id);
    if (!t) return [];
    return [
      {
        id: t.id,
        key: t.key,
        title: t.title,
        status: t.status,
        // Dự án đổi key thì key của task vẫn là key cũ (chép lúc tạo); lấy key hiện tại của dự án cho bộ lọc.
        projectKey: projectKeys.get(t.projectId) ?? t.key.replace(/-\d+$/, ""),
        createdBy: createdByLeader.has(t.id) ? "leader" : "user",
        runs: runsByTask.get(t.id) ?? [],
      },
    ];
  });

  return {
    thread: { id: thread.id, title: thread.title, createdAt: thread.createdAt.toISOString() },
    tasks,
    hidden: hiddenTaskIds.length + (hiddenRuns?.n ?? 0),
    active,
  };
}

/**
 * Các phiên Leader có cây chứa task hay run này, để trang task và trang run mở được cây (specs/028). Run thuộc cây của
 * phiên nào có liên kết với task của nó, kể cả run người tự giao. Kiểm quyền xem task/run trước như trang của chúng.
 */
export async function delegationLinks(
  tx: Tx,
  userId: string,
  input: { taskId?: string | undefined; runId?: string | undefined },
): Promise<{ threadId: string; title: string }[]> {
  const taskIds = new Set<string>();
  if (input.taskId) taskIds.add((await taskForUser(tx, userId, input.taskId, "viewer")).id);
  if (input.runId) {
    const run = await runForUser(tx, userId, input.runId, "viewer");
    if (run.taskId) taskIds.add(run.taskId);
  }
  if (taskIds.size === 0) return [];
  const rows = await tx
    .select({
      threadId: chatThreads.id,
      title: chatThreads.title,
      last: sql<Date>`max(${leaderDelegations.createdAt})`.as("last"),
    })
    .from(leaderDelegations)
    .innerJoin(chatThreads, eq(chatThreads.id, leaderDelegations.threadId))
    .where(inArray(leaderDelegations.taskId, [...taskIds]))
    .groupBy(chatThreads.id, chatThreads.title)
    .orderBy(desc(sql`last`));
  return rows.map((r) => ({ threadId: r.threadId, title: r.title }));
}
