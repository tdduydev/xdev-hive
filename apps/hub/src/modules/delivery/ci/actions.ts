import type { CiActionResult, CiSource } from "@xdev-hive/contracts";
import { recordAudit } from "../../audit/index.ts";
import { BadRequestError, ForbiddenError, type Tx, withTenant } from "../../platform/index.ts";
import { JenkinsError, type JenkinsParamValue } from "../clients/jenkins.ts";
import { type JenkinsAuth, jenkinsAuth } from "../connections/credentials.ts";
import { jenkinsClient, jenkinsDomainError, requireMasterKey } from "../connections/jenkins.ts";
import {
  type CiActor,
  type CiDeps,
  ciProject,
  expectScmSource,
  jenkinsRunId,
  type ParsedRunId,
  type ProjectJob,
  parseRunId,
  projectJob,
  requirePool,
  type ScmTarget,
  scmDomainError,
  scmTarget,
} from "./feed.ts";

// Thao tác CI (FR-008, FR-009, FR-035). GitLab, GitHub dùng token kết nối Git của dự án; Jenkins dùng token của chính người bấm
// để Jenkins ghi đúng người (Q3), không bao giờ mượn token người theo dõi. Mỗi lần bấm một dòng audit, kể cả khi nguồn
// từ chối, để tra được ai đã thử gì.

type ActionName = "retry" | "cancel" | "play" | "build" | "stop" | "input" | "approveDeployment";

/** Hạn chờ build rời hàng đợi Jenkins; quá hạn thì trả `runId: null`, build vẫn chạy khi tới lượt. */
const TRIGGER_WAIT_MS = 10_000;

interface Audit {
  action: ActionName;
  projectId: string;
  source: CiSource;
  data: Record<string, unknown>;
}

const errorCode = (e: unknown) => (e as { code?: unknown }).code ?? (e as Error).name ?? "Error";

/** Ghi audit sau khi gọi nguồn xong, trong transaction ngắn riêng. */
async function audited(
  deps: CiDeps,
  actor: CiActor,
  audit: Audit,
  run: () => Promise<{ result: CiActionResult; data?: Record<string, unknown> }>,
): Promise<CiActionResult> {
  const write = (data: Record<string, unknown>) =>
    withTenant(requirePool(deps), actor, (tx) =>
      recordAudit(tx, {
        action: `delivery.ci.${audit.action}`,
        targetType: "project",
        targetId: audit.projectId,
        data: { source: audit.source, ...audit.data, ...data },
      }),
    );
  let outcome: Awaited<ReturnType<typeof run>>;
  try {
    outcome = await run();
  } catch (e) {
    await write({ ok: false, error: String(errorCode(e)) });
    throw e;
  }
  await write({ ok: true, resultRunId: outcome.result.runId, resultStepId: outcome.result.stepId, ...outcome.data });
  return outcome.result;
}

// ---- Chuẩn bị trong transaction --------------------------------------------------------------------------------------

type Prepared =
  | { kind: "git"; target: ScmTarget; run: Extract<ParsedRunId, { source: "gitlab" | "github" }> }
  | { kind: "jenkins"; job: ProjectJob; auth: JenkinsAuth; build: number | null };

/** Token Jenkins của chính người bấm; chưa có thì `JENKINS_NO_TOKEN`. */
function ownAuth(tx: Tx, deps: CiDeps, actor: CiActor, job: ProjectJob, action: ActionName) {
  return jenkinsAuth(tx, requireMasterKey(deps), {
    connectionId: job.connectionId,
    userId: actor.userId,
    reason: `ci.${action}`,
  });
}

async function prepareRun(
  deps: CiDeps,
  actor: CiActor,
  projectId: string,
  runId: string,
  action: ActionName,
): Promise<Prepared> {
  const run = parseRunId(runId);
  return withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, projectId, "ci.operate");
    if (run.source !== "jenkins") {
      expectScmSource(project, run);
      return { kind: "git", target: await scmTarget(tx, deps, project), run };
    }
    const job = await projectJob(tx, project.id, run.jobId);
    return { kind: "jenkins", job, auth: await ownAuth(tx, deps, actor, job, action), build: run.build };
  });
}

// ---- Lỗi ------------------------------------------------------------------------------------------------------------

/** Jenkins từ chối vì quyền: nói rõ tài khoản nào thiếu quyền gì ở job nào (US2 scenario 4). */
function jenkinsWriteError(e: unknown, job: ProjectJob, auth: JenkinsAuth, permission: string): unknown {
  if (e instanceof JenkinsError && e.code === "FORBIDDEN")
    return new ForbiddenError(
      "JENKINS_FORBIDDEN",
      `Tài khoản Jenkins "${auth.user}" không có quyền ${permission} trên job ${job.jobPath} (${job.connectionName}). Nhờ quản trị Jenkins cấp quyền này cho tài khoản của bạn.`,
    );
  return jenkinsDomainError(e, job.connectionId);
}

function onlyGit(p: Prepared, message: string): Extract<Prepared, { kind: "git" }> {
  if (p.kind !== "git") throw new BadRequestError("CI_UNSUPPORTED", message);
  return p;
}

function onlyJenkins(p: Prepared, message: string): Extract<Prepared, { kind: "jenkins" }> & { build: number } {
  if (p.kind !== "jenkins" || p.build === null) throw new BadRequestError("CI_UNSUPPORTED", message);
  return { ...p, build: p.build };
}

const sourceOf = (p: Prepared): CiSource => (p.kind === "git" ? p.target.source : "jenkins");

function auditBase(p: Prepared, runId: string | null): Record<string, unknown> {
  if (p.kind === "git") return { runId, repo: `${p.target.ref.owner}/${p.target.ref.name}` };
  return {
    runId,
    jobId: p.job.id,
    connectionId: p.job.connectionId,
    jobPath: p.job.jobPath,
    jenkinsUser: p.auth.user,
  };
}

// ---- Thao tác ---------------------------------------------------------------------------------------------------------

/** Mật khẩu không ghi giá trị vào audit. */
function auditParams(
  params: Record<string, JenkinsParamValue>,
  passwords: ReadonlySet<string>,
): Record<string, JenkinsParamValue> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, passwords.has(k) ? "***" : v]));
}

async function triggerJenkins(
  deps: CiDeps,
  job: ProjectJob,
  auth: JenkinsAuth,
  params: Record<string, JenkinsParamValue>,
  /** Chạy lại build cũ: tham số lấy từ build đó, không kiểm tên. */
  strict: boolean,
): Promise<{ result: CiActionResult; data: Record<string, unknown> }> {
  const client = jenkinsClient(deps, auth);
  try {
    const def = await client.job(job.jobPath);
    const names = new Set(def.parameters.map((p) => p.name));
    const unknown = Object.keys(params).filter((k) => !names.has(k));
    if (strict && unknown.length > 0)
      throw new BadRequestError("CI_PARAM_UNKNOWN", `Job ${job.jobPath} không có tham số ${unknown.join(", ")}.`);
    const passwords = new Set(def.parameters.filter((p) => p.kind === "password").map((p) => p.name));
    const sent = Object.fromEntries(Object.entries(params).filter(([k]) => names.has(k)));
    const res = await client.triggerBuild(job.jobPath, def.parameters.length > 0 ? sent : undefined, {
      waitMs: TRIGGER_WAIT_MS,
    });
    return {
      result: { ok: true, runId: res.number === null ? null : jenkinsRunId(job.id, res.number), stepId: null },
      data: { params: auditParams(sent, passwords), queueId: res.queueId, queueCancelled: res.cancelled },
    };
  } catch (e) {
    throw jenkinsWriteError(e, job, auth, "Job/Build");
  }
}

export async function ciRetry(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string; stepId?: string | undefined },
): Promise<CiActionResult> {
  const p = await prepareRun(deps, actor, input.projectId, input.runId, "retry");
  const audit = {
    action: "retry" as const,
    projectId: input.projectId,
    source: sourceOf(p),
    data: { ...auditBase(p, input.runId), stepId: input.stepId ?? null },
  };
  return audited(deps, actor, audit, async () => {
    if (p.kind === "git") {
      const { target, run } = p;
      try {
        if (input.stepId) {
          const job = await target.provider.retryJob(target.ref, input.stepId);
          return { result: { ok: true, runId: input.runId, stepId: job.id } };
        }
        await target.provider.retryPipeline(target.ref, run.pipelineId);
        return { result: { ok: true, runId: input.runId, stepId: null } };
      } catch (e) {
        throw scmDomainError(e, target, "chạy lại pipeline");
      }
    }
    const j = onlyJenkins(p, "Chọn một build Jenkins để chạy lại.");
    let previous: Record<string, JenkinsParamValue>;
    try {
      previous = (await jenkinsClient(deps, j.auth).getBuild(j.job.jobPath, j.build)).parameters;
    } catch (e) {
      throw jenkinsWriteError(e, j.job, j.auth, "Job/Read");
    }
    return triggerJenkins(deps, j.job, j.auth, previous, false);
  });
}

export async function ciCancel(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string; stepId?: string | undefined },
): Promise<CiActionResult> {
  const p = onlyGit(
    await prepareRun(deps, actor, input.projectId, input.runId, "cancel"),
    "Build Jenkins dùng nút Dừng, không dùng Huỷ.",
  );
  const audit = {
    action: "cancel" as const,
    projectId: input.projectId,
    source: sourceOf(p),
    data: { ...auditBase(p, input.runId), stepId: input.stepId ?? null },
  };
  return audited(deps, actor, audit, async () => {
    try {
      if (input.stepId) await p.target.provider.cancelJob(p.target.ref, input.stepId);
      else await p.target.provider.cancelPipeline(p.target.ref, p.run.pipelineId);
      return { result: { ok: true, runId: input.runId, stepId: input.stepId ?? null } };
    } catch (e) {
      throw scmDomainError(e, p.target, "huỷ pipeline");
    }
  });
}

export async function ciPlay(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string; stepId: string },
): Promise<CiActionResult> {
  const p = onlyGit(
    await prepareRun(deps, actor, input.projectId, input.runId, "play"),
    "Chỉ job chờ tay của GitLab mới chạy bằng nút này. Build Jenkins dùng Build; GitHub chờ duyệt dùng Duyệt deployment.",
  );
  const audit = {
    action: "play" as const,
    projectId: input.projectId,
    source: sourceOf(p),
    data: { ...auditBase(p, input.runId), stepId: input.stepId },
  };
  return audited(deps, actor, audit, async () => {
    try {
      const job = await p.target.provider.playJob(p.target.ref, input.stepId);
      return { result: { ok: true, runId: input.runId, stepId: job.id } };
    } catch (e) {
      throw scmDomainError(e, p.target, "chạy job chờ tay");
    }
  });
}

export async function ciBuild(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; jobId: string; params: Record<string, string | boolean> },
): Promise<CiActionResult> {
  const p = await withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, input.projectId, "ci.operate");
    const job = await projectJob(tx, project.id, input.jobId);
    return { kind: "jenkins" as const, job, auth: await ownAuth(tx, deps, actor, job, "build"), build: null };
  });
  const audit = {
    action: "build" as const,
    projectId: input.projectId,
    source: "jenkins" as const,
    data: auditBase(p, null),
  };
  return audited(deps, actor, audit, () => triggerJenkins(deps, p.job, p.auth, input.params, true));
}

export async function ciStop(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string },
): Promise<CiActionResult> {
  const j = onlyJenkins(
    await prepareRun(deps, actor, input.projectId, input.runId, "stop"),
    "Pipeline GitLab, GitHub dùng nút Huỷ, không dùng Dừng.",
  );
  const audit = {
    action: "stop" as const,
    projectId: input.projectId,
    source: "jenkins" as const,
    data: auditBase(j, input.runId),
  };
  return audited(deps, actor, audit, async () => {
    try {
      await jenkinsClient(deps, j.auth).stop(j.job.jobPath, j.build);
      return { result: { ok: true, runId: input.runId, stepId: null } };
    } catch (e) {
      throw jenkinsWriteError(e, j.job, j.auth, "Job/Cancel");
    }
  });
}

export async function ciInput(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string; inputId: string; action: "proceed" | "abort" },
): Promise<CiActionResult> {
  const j = onlyJenkins(
    await prepareRun(deps, actor, input.projectId, input.runId, "input"),
    "Chỉ build Jenkins có bước input mới tiếp tục hoặc dừng được.",
  );
  const audit = {
    action: "input" as const,
    projectId: input.projectId,
    source: "jenkins" as const,
    data: { ...auditBase(j, input.runId), inputId: input.inputId, decision: input.action },
  };
  return audited(deps, actor, audit, async () => {
    const client = jenkinsClient(deps, j.auth);
    try {
      if (input.action === "proceed") await client.inputProceed(j.job.jobPath, j.build, input.inputId);
      else await client.inputAbort(j.job.jobPath, j.build, input.inputId);
      return { result: { ok: true, runId: input.runId, stepId: null } };
    } catch (e) {
      throw jenkinsWriteError(e, j.job, j.auth, "Job/Build (hoặc là người được duyệt của bước input)");
    }
  });
}

export async function ciApproveDeployment(
  deps: CiDeps,
  actor: CiActor,
  input: {
    projectId: string;
    runId: string;
    environments: string[];
    decision: "approve" | "reject";
    comment?: string | undefined;
  },
): Promise<CiActionResult> {
  const p = onlyGit(
    await prepareRun(deps, actor, input.projectId, input.runId, "approveDeployment"),
    "Chỉ workflow GitHub Actions chờ duyệt environment mới duyệt được. Build Jenkins có bước input dùng Tiếp tục.",
  );
  const review = p.target.provider.reviewDeployments;
  if (p.target.source !== "github" || !review)
    throw new BadRequestError("CI_UNSUPPORTED", "Chỉ workflow GitHub Actions có duyệt deployment theo environment.");
  const environments = [...new Set(input.environments)];
  const audit = {
    action: "approveDeployment" as const,
    projectId: input.projectId,
    source: sourceOf(p),
    data: { ...auditBase(p, input.runId), environments, decision: input.decision, comment: input.comment ?? null },
  };
  return audited(deps, actor, audit, async () => {
    try {
      await review.call(p.target.provider, p.target.ref, p.run.pipelineId, {
        environments,
        decision: input.decision,
        comment: input.comment ?? "",
      });
      return { result: { ok: true, runId: input.runId, stepId: null } };
    } catch (e) {
      throw scmDomainError(e, p.target, "duyệt deployment");
    }
  });
}
