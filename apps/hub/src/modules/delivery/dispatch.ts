import type { DeliveryJobKind, DeliveryJobSpec, DeployStep, DeployVersion, TargetConfig } from "@xdev-hive/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { emitDeployEvent } from "./deploys/events.ts";
import type { DeliveryDeps } from "./deps.ts";
import { loadEnvironment } from "./environments.ts";
import { notifyDeploy } from "./logs.ts";
import { DELIVERY_JOB_CHECK_QUEUE } from "./queues.ts";
import { type RunnerCandidate, selectRunner } from "./runner-select.ts";
import { runnerCandidatesOf } from "./runners.ts";
import { ciJenkinsConnections, deliveryJobs, deployConnections, deploys, deployTargets } from "./schema.ts";
import { createDeliveryJob, type DeliveryJobRow, expireLostJobs, LEASE_TTL_MS } from "./worker-jobs.ts";

// Giao lần triển khai cho máy chạy (specs/032 FR-013, FR-014): hub chỉ dựng spec (tên credential, không giá trị), chọn
// máy theo runner-select rồi ghi việc. Worker bấm job Jenkins hoặc sync Argo CD; hub không gọi ra ngoài trên đường này.

type DeployRow = typeof deploys.$inferSelect;
type TargetRow = typeof deployTargets.$inferSelect;
type EnvRow = NonNullable<Awaited<ReturnType<typeof loadEnvironment>>>;

/** Không có máy nhận quá chừng này thì lần triển khai thất bại (FR-014). */
export const RUNNER_WAIT_MS = 15 * 60 * 1000;
/** Việc đang chờ máy: chọn lại sau mỗi khoảng này (máy vừa bật, vừa thêm credential). */
export const RUNNER_RETRY_MS = 30 * 1000;
/** Bước hiện trên lần triển khai khi hết chờ máy. */
export const RUNNER_WAIT_STEP = "Chờ máy chạy";
const RUNNER_OFFLINE = "Đội chưa có máy chạy deploy nào đang trực tuyến. Bật worker trên một máy của đội.";

const WORKER_KINDS: ReadonlySet<string> = new Set<DeliveryJobKind>(["jenkins-job", "argocd"]);

export interface DeliveryJobCheck {
  orgId: string;
  jobId: string;
}

export class DispatchError extends Error {}

/** `{{commit}}`, `{{tag}}`, `{{env}}` trong tham số Jenkins lấy từ lần triển khai. */
export function renderParam(value: string, version: DeployVersion, envName: string): string {
  return value
    .replaceAll("{{commit}}", version.commit ?? "")
    .replaceAll("{{tag}}", version.tag ?? "")
    .replaceAll("{{env}}", envName);
}

type JenkinsConfig = Extract<TargetConfig, { method: "jenkins-job" }>;
type ArgoConfig = Extract<TargetConfig, { method: "argocd" }>;

/** Phần spec không phụ thuộc database, tách ra để test thuần. */
export function buildJobSpec(input: {
  deploy: Pick<DeployRow, "id" | "version" | "configVersion" | "rollbackOf">;
  config: TargetConfig;
  baseUrl: string;
  envName: string;
}): Omit<DeliveryJobSpec, "jobId"> {
  const { deploy, config, baseUrl, envName } = input;
  const base = { deployId: deploy.id, configVersion: deploy.configVersion ?? 0 };
  if (config.method === "jenkins-job") {
    const c = config as JenkinsConfig;
    // Lần quay về chạy job quay về riêng nếu đích có (FR-034); không có thì chạy lại job thường với bản cũ.
    const job = deploy.rollbackOf !== null && c.rollbackJob ? c.rollbackJob : { jobPath: c.jobPath, params: c.params };
    const parameters: Record<string, string> = Object.fromEntries(
      job.params.map((p) => [p.name, renderParam(p.value, deploy.version, envName)]),
    );
    if (c.promote && deploy.version.jenkinsBuild !== null)
      parameters[c.promote.buildParam] = String(deploy.version.jenkinsBuild);
    return {
      ...base,
      kind: "jenkins-job",
      target: { baseUrl, job: job.jobPath },
      credential: c.credential,
      params: { parameters },
      timeoutSeconds: 3600,
    };
  }
  if (config.method === "argocd") {
    const c = config as ArgoConfig;
    const revision = deploy.version.revision ?? deploy.version.commit;
    // Quay về bằng sync tới revision cũ: hub không biết id history của Argo CD.
    const pin = c.syncToRevision || deploy.rollbackOf !== null;
    return {
      ...base,
      kind: "argocd",
      target: { baseUrl, app: c.application },
      credential: c.credential,
      params: { action: "sync", ...(pin && revision ? { revision } : {}) },
      timeoutSeconds: c.timeoutSec,
    };
  }
  throw new DispatchError(
    `Cách triển khai ${config.method} không chạy trên máy chạy deploy. Đổi đích sang Jenkins hoặc Argo CD, hoặc để môi trường chạy kiểu cũ.`,
  );
}

async function baseUrlOf(tx: Tx, config: TargetConfig): Promise<string> {
  const connectionId = (config as { connectionId?: string }).connectionId;
  if (!connectionId) throw new DispatchError("Đích chưa có kết nối.");
  const table = config.method === "jenkins-job" ? ciJenkinsConnections : deployConnections;
  const [row] = await tx.select({ url: table.url }).from(table).where(eq(table.id, connectionId));
  if (!row) throw new DispatchError("Kết nối của đích đã bị xoá. Chọn lại kết nối cho đích.");
  return row.url;
}

export async function jobSpecOf(
  tx: Tx,
  deploy: DeployRow,
  target: TargetRow,
  env: EnvRow,
): Promise<Omit<DeliveryJobSpec, "jobId">> {
  const config = target.config as TargetConfig;
  // Cách không chạy trên worker thì buildJobSpec báo lỗi, không cần đọc kết nối.
  const baseUrl = WORKER_KINDS.has(config.method) ? await baseUrlOf(tx, config) : "";
  return buildJobSpec({ deploy, config, baseUrl, envName: env.name });
}

async function select(tx: Tx, env: EnvRow, spec: Omit<DeliveryJobSpec, "jobId">) {
  const online = await runnerCandidatesOf(tx, env);
  // Máy đã chọn mà đang tắt vẫn là ứng viên (online: false) để lý do chờ là "chưa trực tuyến", không phải "chưa có máy".
  const onlineIds = new Set(online.map((c) => c.machineId));
  const offline: RunnerCandidate[] = env.runnerMachines
    .filter((id) => !onlineIds.has(id))
    .map((machineId) => ({ machineId, orgId: env.orgId, online: false, labels: [], methods: [], credentials: [] }));
  const candidates = [...online, ...offline];
  // Môi trường chưa chọn máy thì máy trực tuyến nào của đội đủ điều kiện cũng được.
  const machines = env.runnerMachines.length > 0 ? env.runnerMachines : online.map((c) => c.machineId);
  if (machines.length === 0) return { ok: false as const, message: RUNNER_OFFLINE };
  return selectRunner(candidates, machines, {
    orgId: env.orgId,
    method: spec.kind,
    credential: spec.credential,
    requireLabel: env.runnerLabelRequired,
  });
}

async function enqueueCheck(tx: Tx, deps: DeliveryDeps, job: DeliveryJobRow, at: Date): Promise<void> {
  if (!deps.jobs) throw new Error("Hub chưa bật hàng đợi job nên chưa theo dõi được việc giao cho máy.");
  await deps.jobs.enqueue<DeliveryJobCheck>(
    DELIVERY_JOB_CHECK_QUEUE,
    { orgId: job.orgId, jobId: job.id },
    { tx, singletonKey: job.id, startAfter: at },
  );
}

/**
 * Giao lần `queued` cho máy chạy. Có máy thì việc `leased` ngay; chưa có thì `waiting` kèm lý do, chọn lại theo nhịp.
 * Lần triển khai giữ `queued` tới khi máy báo `started`. Lỗi cấu hình (cách không hỗ trợ, kết nối mất) ném DispatchError
 * để bộ điều phối đánh dấu thất bại.
 */
export async function dispatchDeploy(
  tx: Tx,
  deps: DeliveryDeps,
  deploy: DeployRow,
  target: TargetRow,
  env: EnvRow,
  now: Date,
): Promise<DeliveryJobRow> {
  // pg-boss có thể chạy lại job bắt đầu (hub chết sau commit): không giao lần thứ hai cho máy khác.
  const [active] = await tx
    .select()
    .from(deliveryJobs)
    .where(and(eq(deliveryJobs.deployId, deploy.id), inArray(deliveryJobs.state, ["waiting", "leased", "running"])));
  if (active) return active;
  const spec = await jobSpecOf(tx, deploy, target, env);
  const picked = await select(tx, env, spec);
  const job = await createDeliveryJob(tx, {
    orgId: deploy.orgId,
    deployId: deploy.id,
    kind: spec.kind,
    configVersion: deploy.configVersion,
    credentialNames: spec.credential ? [spec.credential] : [],
    workerId: picked.ok ? picked.machineId : null,
    spec,
    waitReason: picked.ok ? null : picked.message,
    now,
  });
  await tx.update(deploys).set({ ranLegacy: false, updatedAt: now }).where(eq(deploys.id, deploy.id));
  await enqueueCheck(tx, deps, job, new Date(now.getTime() + (picked.ok ? LEASE_TTL_MS : RUNNER_RETRY_MS)));
  await notifyDeploy(tx, deploy.id);
  return job;
}

async function failWaiting(tx: Tx, deps: DeliveryDeps, job: DeliveryJobRow, deploy: DeployRow, now: Date) {
  const reason = job.waitReason ?? "Không có máy chạy deploy nhận việc.";
  await tx
    .update(deliveryJobs)
    .set({
      state: "failed",
      errorCode: "no_runner",
      errorMessage: reason.slice(0, 200),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(deliveryJobs.id, job.id));
  const at = now.toISOString();
  const step: DeployStep = {
    key: RUNNER_WAIT_STEP,
    state: "failed",
    startedAt: job.createdAt.toISOString(),
    finishedAt: at,
    exitCode: null,
    message: `Quá 15 phút không có máy nhận: ${reason}`,
  };
  await tx
    .update(deploys)
    .set({ state: "failed", steps: [...deploy.steps, step], finishedAt: now, updatedAt: now })
    .where(eq(deploys.id, deploy.id));
  await emitDeployEvent(tx, deps, deploy.id, "failed");
  await notifyDeploy(tx, deploy.id);
}

/**
 * Một nhịp theo dõi việc giao cho máy. Việc chờ: chọn lại máy, quá 15 phút thì thất bại (FR-014). Việc đã giao: tới hạn
 * lease mà máy im thì `lost` (expireLostJobs), còn hạn thì hẹn lại đúng lúc hết hạn.
 */
export async function checkDeliveryJob(tx: Tx, deps: DeliveryDeps, data: DeliveryJobCheck, now: Date): Promise<void> {
  const [job] = await tx.select().from(deliveryJobs).where(eq(deliveryJobs.id, data.jobId)).for("update");
  if (!job) return;
  if (job.state === "leased" || job.state === "running") {
    if (job.leaseExpiresAt && job.leaseExpiresAt > now) return enqueueCheck(tx, deps, job, job.leaseExpiresAt);
    await expireLostJobs(tx, deps, now);
    return;
  }
  if (job.state !== "waiting" || !job.deployId) return;
  const [deploy] = await tx.select().from(deploys).where(eq(deploys.id, job.deployId)).for("update");
  if (deploy?.state !== "queued") {
    // Lần đã huỷ hay kết thúc theo đường khác: việc chờ không còn ý nghĩa.
    await tx
      .update(deliveryJobs)
      .set({ state: "canceled", finishedAt: now, updatedAt: now })
      .where(eq(deliveryJobs.id, job.id));
    return;
  }
  if (now.getTime() - job.createdAt.getTime() >= RUNNER_WAIT_MS) return failWaiting(tx, deps, job, deploy, now);

  const [target] = await tx.select().from(deployTargets).where(eq(deployTargets.id, deploy.targetId));
  const env = target ? await loadEnvironment(tx, target.environmentId) : null;
  if (!env) return;
  const picked = await select(tx, env, job.spec as Omit<DeliveryJobSpec, "jobId">);
  if (picked.ok) {
    const [leased] = await tx
      .update(deliveryJobs)
      .set({
        state: "leased",
        workerId: picked.machineId,
        waitReason: null,
        leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
        updatedAt: now,
      })
      .where(eq(deliveryJobs.id, job.id))
      .returning();
    if (leased) await enqueueCheck(tx, deps, leased, leased.leaseExpiresAt ?? now);
  } else {
    if (picked.message !== job.waitReason)
      await tx
        .update(deliveryJobs)
        .set({ waitReason: picked.message, updatedAt: now })
        .where(eq(deliveryJobs.id, job.id));
    const deadline = job.createdAt.getTime() + RUNNER_WAIT_MS;
    await enqueueCheck(tx, deps, job, new Date(Math.min(now.getTime() + RUNNER_RETRY_MS, deadline)));
  }
  await notifyDeploy(tx, deploy.id);
}

export async function registerDispatch(
  jobs: Jobs,
  deps: DeliveryDeps,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { pool } = deps;
  if (!pool) return;
  const withJobs: DeliveryDeps = { ...deps, jobs };
  await jobs.work<DeliveryJobCheck>(DELIVERY_JOB_CHECK_QUEUE, (job) =>
    withTenant(pool, { orgId: job.data.orgId }, (tx) => checkDeliveryJob(tx, withJobs, job.data, now())),
  );
}
