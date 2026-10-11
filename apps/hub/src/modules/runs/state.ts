import type { Run, RunState } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import type { ProjectRow } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { runEvents, runs } from "./schema.ts";

export type RunRow = typeof runs.$inferSelect;

/** Kênh NOTIFY của run; payload chỉ là id run (docs/architecture.md mục 9). */
export const RUNS_CHANNEL = "hive_runs";

/** Máy đang giữ lease: hub nhận gói của worker cho run ở các trạng thái này. */
export const ON_MACHINE: readonly RunState[] = ["leased", "preparing", "running", "awaiting_input", "cancelling"];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toRun(r: RunRow): Run {
  return {
    id: r.id,
    taskId: r.taskId,
    projectId: r.projectId,
    teamId: r.teamId,
    kind: r.kind,
    state: r.state,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    machineId: r.machineId,
    cli: r.cli,
    pinnedMachineId: r.pinnedMachineId,
    branch: r.branch,
    policySnapshot: r.policySnapshot,
    result: r.result
      ? {
          exit: r.result.exit,
          commitCount: r.result.commitCount,
          changedFiles: r.result.changedFiles,
          checks: r.result.checks,
          reasons: r.result.reasons,
        }
      : null,
    headSha: r.headSha,
    prUrl: r.prUrl,
    timeoutSec: r.timeoutSec,
    cost: {
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      costUsd: r.costUsd,
      turns: r.turns,
    },
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Báo cho luồng SSE có dữ liệu mới. NOTIFY trong transaction chỉ phát khi commit, nên không báo dữ liệu đã rollback. */
export async function notifyRun(tx: Tx, runId: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${RUNS_CHANNEL}, ${runId})`);
}

/** Ghi một sự kiện do hub sinh (seq null) cho lần thử hiện tại của run. */
export async function hubEvent(
  tx: Tx,
  run: Pick<RunRow, "id" | "orgId" | "attempt">,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.insert(runEvents).values({ orgId: run.orgId, runId: run.id, attempt: run.attempt, seq: null, type, data });
}

/**
 * Chuyển trạng thái run: cập nhật dòng, ghi sự kiện `state` và NOTIFY trong cùng transaction (docs/architecture.md
 * mục 4.1). `patch` là các cột đổi kèm. Trả dòng mới.
 */
export async function transition(
  tx: Tx,
  run: RunRow,
  to: RunState,
  patch: Partial<typeof runs.$inferInsert> = {},
  data: Record<string, unknown> = {},
): Promise<RunRow> {
  const [row] = await tx
    .update(runs)
    .set({ ...patch, state: to, updatedAt: sql`now()` })
    .where(eq(runs.id, run.id))
    .returning();
  if (!row) throw new Error(`Không cập nhật được run ${run.id}.`);
  await hubEvent(tx, row, "state", { from: run.state, to, ...data });
  await notifyRun(tx, run.id);
  return row;
}

/** Khoá dòng run tới hết transaction: gói của worker, hẹn giờ và người dùng đổi cùng một run lần lượt từng bên. */
export async function lockRun(tx: Tx, id: string): Promise<RunRow | null> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id)).for("update");
  return row ?? null;
}

/** Dự án đã có repo để giao run. */
export function projectReady(p: ProjectRow | null): p is ProjectRow & { repoHttpUrl: string; defaultBranch: string } {
  return p?.state === "active" && Boolean(p.repoHttpUrl) && Boolean(p.defaultBranch);
}
