import type { DeliveryEvent, DeliveryJobKind, DeployState } from "@xdev-hive/contracts";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { emitDeployEvent } from "./deploys/orchestrator.ts";
import type { DeliveryDeps } from "./deps.ts";
import { applyDeliveryEvent, type DeployOutcome, isSettled } from "./job-events.ts";
import { notifyDeploy } from "./logs.ts";
import { deliveryJobs, deploys } from "./schema.ts";

// Việc giao cho worker (specs/032): hub giữ hàng việc, lease và trạng thái; log ở lại máy chạy. Hàm ở đây chạy trong
// withTenant của tổ chức nên RLS luôn áp; không hàm nào nhận orgId để lọc thay RLS.

export type DeliveryJobRow = typeof deliveryJobs.$inferSelect;

/** Máy mất liên lạc quá hạn này thì việc `lost` (A4 của spec 032). */
export const LEASE_TTL_MS = 3 * 60 * 1000;

export interface NewDeliveryJob {
  orgId: string;
  deployId: string | null;
  kind: DeliveryJobKind;
  configVersion: number | null;
  /** Chỉ tên credential; giá trị không bao giờ qua hub. */
  credentialNames: string[];
  /** Máy đã chọn (runner-select). null thì việc chờ, chưa có lease. */
  workerId: string | null;
  now: Date;
}

export async function createDeliveryJob(tx: Tx, input: NewDeliveryJob): Promise<DeliveryJobRow> {
  const leased = input.workerId !== null;
  const [row] = await tx
    .insert(deliveryJobs)
    .values({
      orgId: input.orgId,
      deployId: input.deployId,
      kind: input.kind,
      state: leased ? "leased" : "waiting",
      workerId: input.workerId,
      configVersion: input.configVersion,
      credentialNames: input.credentialNames,
      leaseExpiresAt: leased ? new Date(input.now.getTime() + LEASE_TTL_MS) : null,
    })
    .returning();
  if (!row) throw new Error("Không tạo được việc delivery");
  return row;
}

/** Heartbeat của máy giữ lease: kéo dài hạn. Máy khác, hay việc đã xong thì không đổi gì và trả `false`. */
export async function renewLease(tx: Tx, jobId: string, workerId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(deliveryJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS), updatedAt: now })
    .where(
      and(
        eq(deliveryJobs.id, jobId),
        eq(deliveryJobs.workerId, workerId),
        inArray(deliveryJobs.state, ["leased", "running"]),
      ),
    )
    .returning({ id: deliveryJobs.id });
  return rows.length > 0;
}

export type IngestResult = "applied" | "duplicate" | "rejected" | "unknown_job";

const JOB_FINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "lost", "canceled"]);

function outcomeOf(deploy: typeof deploys.$inferSelect): DeployOutcome {
  return {
    state: deploy.state as DeployState,
    steps: deploy.steps,
    external: (deploy.external as DeployOutcome["external"]) ?? null,
    health: (deploy.health as DeployOutcome["health"]) ?? null,
    startedAt: deploy.startedAt?.toISOString() ?? null,
    finishedAt: deploy.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Nhận một sự kiện từ máy chạy. Bỏ trùng theo `(jobId, seq)`: seq không lớn hơn `last_seq` thì là gửi lại. Sự kiện từ máy
 * không giữ lease bị `rejected` (FR-023). Không ghi log: hub không giữ log của việc chạy trên worker.
 */
export async function ingestDeliveryEvent(
  tx: Tx,
  deps: DeliveryDeps,
  input: { workerId: string; event: DeliveryEvent; now: Date },
): Promise<IngestResult> {
  const { event, workerId, now } = input;
  const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, event.jobId)).for("update");
  if (!job) return "unknown_job";
  if (job.workerId !== workerId || job.state === "lost") return "rejected";
  if (event.seq <= job.lastSeq || JOB_FINAL.has(job.state)) return "duplicate";

  const final = event.type === "finished";
  await tx
    .update(deliveryJobs)
    .set({
      lastSeq: event.seq,
      state: final ? event.state : "running",
      errorCode: final ? (event.error?.code ?? null) : job.errorCode,
      errorMessage: final ? (event.error?.message ?? null) : job.errorMessage,
      finishedAt: final ? now : null,
      leaseExpiresAt: final ? null : new Date(now.getTime() + LEASE_TTL_MS),
      updatedAt: now,
    })
    .where(eq(deliveryJobs.id, job.id));

  if (!job.deployId) return "applied";
  const [deploy] = await tx.select().from(deploys).where(eq(deploys.id, job.deployId)).for("update");
  if (!deploy || isSettled(deploy.state as DeployState)) return "applied";

  const before = outcomeOf(deploy);
  const after = applyDeliveryEvent(before, event);
  await tx
    .update(deploys)
    .set({
      state: after.state,
      steps: after.steps,
      external: after.external,
      health: after.health,
      ranOnWorkerId: workerId,
      startedAt: after.startedAt ? new Date(after.startedAt) : deploy.startedAt,
      finishedAt: after.finishedAt ? new Date(after.finishedAt) : null,
      updatedAt: now,
    })
    .where(eq(deploys.id, deploy.id));
  if (after.state !== before.state) await emitDeployEvent(tx, deps, deploy.id, after.state);
  await notifyDeploy(tx, deploy.id);
  return "applied";
}

/**
 * Việc mà máy giữ lease đã im quá hạn: `lost`, lần triển khai thành `unknown` (không biết các bước đã đi tới đâu, không
 * tự giao lại để khỏi chạy hai lần). Trả số việc đã đổi.
 */
export async function expireLostJobs(tx: Tx, deps: DeliveryDeps, now: Date): Promise<number> {
  const lost = await tx
    .update(deliveryJobs)
    .set({
      state: "lost",
      errorCode: "lease_expired",
      errorMessage: "Máy chạy mất liên lạc quá hạn.",
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(inArray(deliveryJobs.state, ["leased", "running"]), lt(deliveryJobs.leaseExpiresAt, now)))
    .returning({ id: deliveryJobs.id, deployId: deliveryJobs.deployId });
  for (const { deployId } of lost) {
    if (!deployId) continue;
    const [deploy] = await tx.select().from(deploys).where(eq(deploys.id, deployId)).for("update");
    if (!deploy || isSettled(deploy.state as DeployState)) continue;
    await tx.update(deploys).set({ state: "unknown", finishedAt: now, updatedAt: now }).where(eq(deploys.id, deployId));
    await emitDeployEvent(tx, deps, deployId, "unknown");
    await notifyDeploy(tx, deployId);
  }
  return lost.length;
}

/** Huỷ từ hub: việc chưa xong thành `canceled`; máy chạy được báo dừng qua kênh (T017). */
export async function cancelDeliveryJobs(tx: Tx, deployId: string, now: Date): Promise<DeliveryJobRow[]> {
  return tx
    .update(deliveryJobs)
    .set({ state: "canceled", finishedAt: now, leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(deliveryJobs.deployId, deployId), inArray(deliveryJobs.state, ["waiting", "leased", "running"])))
    .returning();
}
