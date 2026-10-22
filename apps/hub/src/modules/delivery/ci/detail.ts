import type { CiRun, CiRunDetail, CiRunStatus, CiStep, JenkinsParam } from "@xdev-hive/contracts";
import { withTenant } from "../../platform/index.ts";
import type { CiJob } from "../../scm/index.ts";
import type { JenkinsParamDef } from "../clients/jenkins.ts";
import { jenkinsClient, jenkinsDomainError } from "../connections/jenkins.ts";
import {
  type CiActor,
  type CiDeps,
  ciProject,
  expectScmSource,
  gitRun,
  gitStatus,
  jenkinsReadAuth,
  jenkinsRun,
  jenkinsStageStatus,
  parseRunId,
  projectJob,
  requirePool,
  type ScmTarget,
  scmDomainError,
  scmTarget,
} from "./feed.ts";

// Chi tiết một lượt CI: job GitLab hoặc giai đoạn Jenkins (FR-007). Đọc database trước, gọi nguồn sau khi đã trả kết
// nối, như feed.ts.

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);

function gitStep(j: CiJob): CiStep {
  return {
    id: j.id,
    kind: "job",
    name: j.name,
    group: j.stage || null,
    status: gitStatus(j.status),
    rawStatus: j.status,
    startedAt: j.startedAt,
    durationSec: j.durationSec,
    allowFailure: j.allowFailure,
    playable: j.status === "manual",
    hasLog: true,
    url: j.url,
  };
}

/** Trạng thái pipeline suy từ job, khi không tìm được pipeline trong danh sách của nguồn. */
function statusFromJobs(steps: CiStep[]): CiRunStatus {
  const has = (s: CiRunStatus) => steps.some((x) => x.status === s);
  if (has("running")) return "running";
  if (steps.some((x) => x.status === "failed" && !x.allowFailure)) return "failed";
  if (has("waiting")) return "waiting";
  if (has("queued")) return "queued";
  if (has("canceled")) return "canceled";
  if (steps.length > 0 && steps.every((x) => x.status === "skipped")) return "skipped";
  return "success";
}

async function gitDetail(target: ScmTarget, pipelineId: string): Promise<CiRunDetail> {
  const jobs = await target.provider.pipelineJobs(target.ref, pipelineId);
  const steps = jobs.map(gitStep);
  // `GitProvider` chưa có hàm đọc một pipeline: tìm trong danh sách theo sha của job, thường chỉ vài pipeline.
  const sha = jobs[0]?.sha ?? undefined;
  const page = await target.provider.listPipelines(target.ref, { page: 1, perPage: 100, ...(sha ? { sha } : {}) });
  const pipeline = page.items.find((p) => p.id === pipelineId);
  const run: CiRun = pipeline
    ? gitRun(target.source, pipeline)
    : {
        ...gitRun(target.source, {
          id: pipelineId,
          ref: jobs[0]?.ref ?? "",
          sha: sha ?? null,
          status: "pending",
          url: null,
          createdAt: jobs[0]?.createdAt ?? null,
          startedAt: null,
          finishedAt: null,
          durationSec: null,
          user: jobs[0]?.user ?? null,
        }),
        status: statusFromJobs(steps),
        rawStatus: "unknown",
      };
  return { run, steps, pendingInputs: [] };
}

export async function ciDetail(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string },
): Promise<CiRunDetail> {
  const run = parseRunId(input.runId);
  const ready = await withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, input.projectId, "ci.view");
    if (run.source !== "jenkins") {
      expectScmSource(project, run);
      return { kind: "git" as const, target: await scmTarget(tx, deps, project), pipelineId: run.pipelineId };
    }
    const job = await projectJob(tx, project.id, run.jobId);
    const auth = await jenkinsReadAuth(tx, deps, actor.userId, project.id, job);
    return { kind: "jenkins" as const, job, auth, build: run.build };
  });

  if (ready.kind === "git") {
    try {
      return await gitDetail(ready.target, ready.pipelineId);
    } catch (e) {
      throw scmDomainError(e, ready.target, "đọc pipeline");
    }
  }

  const { job, auth, build } = ready;
  const client = jenkinsClient(deps, auth);
  try {
    const b = await client.getBuild(job.jobPath, build);
    const [stages, inputs] = await Promise.all([
      client.stages(job.jobPath, build),
      b.building ? client.pendingInputs(job.jobPath, build) : Promise.resolve([]),
    ]);
    const base = jenkinsRun(job, b);
    return {
      run: inputs.length > 0 ? { ...base, status: "waiting" } : base,
      steps: (stages?.stages ?? []).map(
        (s): CiStep => ({
          id: s.id,
          kind: "stage",
          name: s.name,
          group: null,
          status: jenkinsStageStatus(s.status),
          rawStatus: s.status,
          startedAt: iso(s.startedAt),
          durationSec: s.durationMs > 0 ? s.durationMs / 1000 : null,
          allowFailure: false,
          playable: false,
          hasLog: false,
          url: null,
        }),
      ),
      pendingInputs: inputs.map((i) => ({ id: i.id, message: i.message })),
    };
  } catch (e) {
    throw jenkinsDomainError(e, job.connectionId);
  }
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Tham số của Jenkins thành dạng của hợp đồng; mật khẩu không bao giờ trả giá trị mặc định. */
export function jenkinsParamView(p: JenkinsParamDef): JenkinsParam {
  const base = { name: p.name, description: p.description || null };
  switch (p.kind) {
    case "string":
    case "text":
      return { type: p.kind, ...base, default: text(p.default) };
    case "boolean":
      return { type: "boolean", ...base, default: typeof p.default === "boolean" ? p.default : null };
    case "choice":
      return { type: "choice", ...base, choices: p.choices ?? [], default: text(p.default) };
    case "password":
      return { type: "password", ...base };
    default:
      return { type: "other", ...base, rawType: p.type, default: text(p.default) };
  }
}

export async function ciJenkinsParams(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; jobId: string },
): Promise<{ parameters: JenkinsParam[] }> {
  const { job, auth } = await withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, input.projectId, "ci.view");
    const job = await projectJob(tx, project.id, input.jobId);
    return { job, auth: await jenkinsReadAuth(tx, deps, actor.userId, project.id, job) };
  });
  try {
    const def = await jenkinsClient(deps, auth).job(job.jobPath);
    return { parameters: def.parameters.map(jenkinsParamView) };
  } catch (e) {
    throw jenkinsDomainError(e, job.connectionId);
  }
}
