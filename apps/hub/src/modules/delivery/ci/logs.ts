import type { CiLogChunk } from "@xdev-hive/contracts";
import { BadRequestError, withTenant } from "../../platform/index.ts";
import { jenkinsClient, jenkinsDomainError } from "../connections/jenkins.ts";
import {
  type CiActor,
  type CiDeps,
  ciProject,
  expectScmSource,
  jenkinsReadAuth,
  parseRunId,
  projectJob,
  requirePool,
  scmDomainError,
  scmTarget,
} from "./feed.ts";

// Log CI đọc thẳng từ nguồn theo đoạn, không lưu (Q12). `from`, `next` tính theo byte như cả hai nguồn.

export async function ciLog(
  deps: CiDeps,
  actor: CiActor,
  input: { projectId: string; runId: string; stepId?: string | undefined; from: number },
): Promise<CiLogChunk> {
  const run = parseRunId(input.runId);
  const ready = await withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, input.projectId, "ci.view");
    if (run.source !== "jenkins") {
      expectScmSource(project, run);
      if (!input.stepId) throw new BadRequestError("CI_STEP_REQUIRED", "Chọn một job của pipeline để xem log.");
      return { kind: "git" as const, target: await scmTarget(tx, deps, project), jobId: input.stepId };
    }
    const job = await projectJob(tx, project.id, run.jobId);
    return {
      kind: "jenkins" as const,
      job,
      auth: await jenkinsReadAuth(tx, deps, actor.userId, project.id, job),
      build: run.build,
    };
  });

  if (ready.kind === "git") {
    try {
      const chunk = await ready.target.provider.jobLog(ready.target.ref, ready.jobId, input.from);
      return { text: chunk.text, next: chunk.next, more: !chunk.complete };
    } catch (e) {
      throw scmDomainError(e, ready.target, "đọc log job");
    }
  }
  try {
    const chunk = await jenkinsClient(deps, ready.auth).log(ready.job.jobPath, ready.build, input.from);
    return { text: chunk.text, next: chunk.next, more: chunk.more };
  } catch (e) {
    throw jenkinsDomainError(e, ready.job.connectionId);
  }
}
