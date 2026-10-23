import type { Deploy } from "@xdev-hive/contracts";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { ConflictError, ForbiddenError, type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { effectivePermissions, teamRoleOf } from "../tenancy/index.ts";
import { pgCode } from "./connections/jenkins.ts";
import { deployNotFound, deployView, deployViews, loadLocatedDeploy, locatedDeploys } from "./deploys/board.ts";
import { emitDeployEvent } from "./deploys/events.ts";
import { type DeployJob, queueDeploy } from "./deploys/orchestrator.ts";
import type { DeliveryDeps } from "./deps.ts";
import { loadEnvironment } from "./environments.ts";
import { notifyDeploy } from "./logs.ts";
import { DELIVERY_APPROVAL_EXPIRE_QUEUE } from "./queues.ts";
import { deployApprovals, deployEnvironments, deploys } from "./schema.ts";

// Cổng duyệt trước khi giao việc cho máy chạy (FR-027, specs/032 FR-020): đủ số người duyệt thì lần chuyển sang `queued`
// và mới được giao; một người từ chối là dừng. Hết hạn chờ thì `expired` qua job hẹn giờ.

type EnvRow = NonNullable<Awaited<ReturnType<typeof loadEnvironment>>>;
type DeployRow = typeof deploys.$inferSelect;

/** Người duyệt được: có `deploy.approve` của đội, vai trò trong `approveRoles` nếu có, không phải người yêu cầu. */
async function approverCheck(tx: Tx, userId: string, env: EnvRow, deploy: DeployRow): Promise<string | null> {
  const granted = await effectivePermissions(tx, userId, env.teamId);
  if (!granted.has("ci.view")) return "not_found";
  if (!granted.has("deploy.approve"))
    return "Bạn chưa có quyền deploy.approve của đội sở hữu môi trường này nên chưa duyệt được.";
  const roles = env.policy.approveRoles as string[];
  if (roles.length > 0 && !roles.includes((await teamRoleOf(tx, userId, env.teamId)) ?? ""))
    return `Môi trường ${env.name} chỉ cho một số vai trò duyệt; vai trò của bạn chưa nằm trong đó.`;
  if (deploy.requestedBy === userId) return "Người yêu cầu triển khai không tự duyệt lần của mình.";
  return null;
}

async function loadForDecision(tx: Tx, userId: string, id: string) {
  const [deploy] = await tx.select().from(deploys).where(eq(deploys.id, id)).for("update");
  const located = deploy ? await loadLocatedDeploy(tx, id) : null;
  const env = located ? await loadEnvironment(tx, located.environmentId) : null;
  if (!deploy || !located || !env) throw deployNotFound();
  const problem = await approverCheck(tx, userId, env, deploy);
  if (problem === "not_found") throw deployNotFound();
  if (deploy.state !== "pending_approval")
    throw new ConflictError("DEPLOY_NOT_PENDING", "Lần triển khai này không còn chờ duyệt.");
  if (problem) throw new ForbiddenError("DEPLOY_APPROVE_DENIED", problem);
  if (deploy.approvalExpiresAt && deploy.approvalExpiresAt <= new Date())
    throw new ConflictError(
      "APPROVAL_EXPIRED",
      "Lần triển khai này đã hết hạn chờ duyệt. Bấm triển khai lại nếu vẫn cần.",
    );
  return { deploy, located };
}

async function decide(
  tx: Tx,
  deploy: DeployRow,
  userId: string,
  decision: "approve" | "reject",
  reason: string | null,
) {
  try {
    await tx.insert(deployApprovals).values({ orgId: deploy.orgId, deployId: deploy.id, userId, decision, reason });
  } catch (e) {
    if (pgCode(e) === "23505") throw new ConflictError("ALREADY_DECIDED", "Bạn đã duyệt hoặc từ chối lần này rồi.");
    throw e;
  }
  await recordAudit(tx, {
    action: decision === "approve" ? "delivery.deploy.approve" : "delivery.deploy.reject",
    targetType: "deploy",
    targetId: deploy.id,
    actorUserId: userId,
    data: { targetId: deploy.targetId, ...(reason ? { reason } : {}) },
  });
}

/** Lần đang chờ chính người này duyệt, mới nhất trước. */
export async function pendingApprovals(tx: Tx, userId: string, systemId?: string): Promise<Deploy[]> {
  const rows = await locatedDeploys(
    tx,
    and(eq(deploys.state, "pending_approval"), systemId ? eq(deployEnvironments.systemId, systemId) : undefined),
  ).orderBy(deploys.createdAt);
  const decided = new Set(
    (
      await tx
        .select({ deployId: deployApprovals.deployId })
        .from(deployApprovals)
        .where(eq(deployApprovals.userId, userId))
    ).map((r) => r.deployId),
  );
  const envs = new Map<string, EnvRow | null>();
  const mine = [];
  for (const r of rows) {
    if (decided.has(r.deploy.id)) continue;
    if (!envs.has(r.environmentId)) envs.set(r.environmentId, await loadEnvironment(tx, r.environmentId));
    const env = envs.get(r.environmentId);
    if (env && (await approverCheck(tx, userId, env, r.deploy)) === null) mine.push(r);
  }
  return deployViews(tx, mine.reverse());
}

/** Duyệt; đủ số người thì lần chuyển `queued` và được giao cho máy chạy. */
export async function approveDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  userId: string,
  input: { id: string; comment?: string | undefined },
): Promise<Deploy> {
  const { deploy } = await loadForDecision(tx, userId, input.id);
  await decide(tx, deploy, userId, "approve", input.comment?.trim() || null);
  const approved = await tx
    .select({ id: deployApprovals.id })
    .from(deployApprovals)
    .where(and(eq(deployApprovals.deployId, deploy.id), eq(deployApprovals.decision, "approve")));
  if (approved.length >= deploy.approvalsRequired) await queueDeploy(tx, deps, deploy.id);
  else await notifyDeploy(tx, deploy.id);
  const located = await loadLocatedDeploy(tx, deploy.id);
  if (!located) throw deployNotFound();
  return deployView(tx, located);
}

export async function rejectDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  userId: string,
  input: { id: string; reason: string },
): Promise<Deploy> {
  const { deploy } = await loadForDecision(tx, userId, input.id);
  await decide(tx, deploy, userId, "reject", input.reason.trim());
  const now = new Date();
  await tx.update(deploys).set({ state: "rejected", finishedAt: now, updatedAt: now }).where(eq(deploys.id, deploy.id));
  await emitDeployEvent(tx, deps, deploy.id, "rejected");
  await notifyDeploy(tx, deploy.id);
  const located = await loadLocatedDeploy(tx, deploy.id);
  if (!located) throw deployNotFound();
  return deployView(tx, located);
}

/** Job hẹn đúng giờ hết hạn: lần còn chờ duyệt thì `expired` và nhả khoá đích. */
export async function expireApproval(tx: Tx, deps: DeliveryDeps, deployId: string, now: Date): Promise<void> {
  const [deploy] = await tx.select().from(deploys).where(eq(deploys.id, deployId)).for("update");
  if (deploy?.state !== "pending_approval" || !deploy.approvalExpiresAt) return;
  if (deploy.approvalExpiresAt > now) {
    // Job chạy sớm (đồng hồ lệch): hẹn lại thay vì bỏ, để lần không chờ mãi.
    await deps.jobs?.enqueue<DeployJob>(
      DELIVERY_APPROVAL_EXPIRE_QUEUE,
      { orgId: deploy.orgId, deployId },
      { tx, singletonKey: deployId, startAfter: deploy.approvalExpiresAt },
    );
    return;
  }
  await tx.update(deploys).set({ state: "expired", finishedAt: now, updatedAt: now }).where(eq(deploys.id, deployId));
  await emitDeployEvent(tx, deps, deployId, "expired");
  await notifyDeploy(tx, deployId);
}

export async function registerApprovals(
  jobs: Jobs,
  deps: DeliveryDeps,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { pool } = deps;
  if (!pool) return;
  const withJobs: DeliveryDeps = { ...deps, jobs };
  await jobs.work<DeployJob>(DELIVERY_APPROVAL_EXPIRE_QUEUE, (job) =>
    withTenant(pool, { orgId: job.data.orgId }, (tx) => expireApproval(tx, withJobs, job.data.deployId, now())),
  );
}
