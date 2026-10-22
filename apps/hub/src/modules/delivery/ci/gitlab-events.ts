import { loadProject } from "../../catalog/index.ts";
import type { Jobs } from "../../platform/index.ts";
import {
  CI_ACTIVE_STATUSES,
  type CiStatus,
  type ScmEventHandler,
  type ScmEventRegistry,
  scmEvents,
} from "../../scm/index.ts";
import type { DeliveryDeps } from "../deps.ts";
import { type CiPollDeps, markGitPipelineActive, queueGitlabRecheck, recordGitPipeline } from "./poll.ts";

// Sự kiện pipeline và job của GitLab cập nhật `ci_runs_seen` và báo đỏ/xanh ngay trong transaction của webhook (FR-006).
// Pipeline còn chạy thì hẹn hỏi lại sau 5 phút, phòng webhook lúc xong bị lỡ.

const active = (s: CiStatus) => (CI_ACTIVE_STATUSES as readonly CiStatus[]).includes(s);

export function gitlabEventHandlers(
  deps: CiPollDeps,
  jobs: Jobs | undefined,
): { pipeline: ScmEventHandler<"pipeline">; job: ScmEventHandler<"job"> } {
  const now = () => (deps.now ?? Date.now)();
  const recheck = async (tx: Parameters<ScmEventHandler>[1]["tx"], orgId: string, projectId: string) => {
    if (jobs) await queueGitlabRecheck(jobs, { orgId, projectId }, { tx, now: now() });
  };
  return {
    async pipeline(event, ctx) {
      const project = await loadProject(ctx.tx, ctx.projectId);
      if (!project || project.scmKind !== event.provider) return;
      await recordGitPipeline(ctx.tx, ctx.orgId, project, event.pipeline, {
        publicUrl: deps.publicUrl,
        jobs,
        now: now(),
      });
      if (project.scmKind === "gitlab" && active(event.pipeline.status)) await recheck(ctx.tx, ctx.orgId, project.id);
    },
    async job(event, ctx) {
      // Job xong không nói pipeline xong hay chưa: chờ sự kiện pipeline hoặc lần hỏi lại.
      if (!active(event.job.status)) return;
      const project = await loadProject(ctx.tx, ctx.projectId);
      if (!project || project.scmKind !== event.provider) return;
      await markGitPipelineActive(ctx.tx, ctx.orgId, project, event.job, {
        publicUrl: deps.publicUrl,
        jobs,
        now: now(),
      });
      if (project.scmKind === "gitlab") await recheck(ctx.tx, ctx.orgId, project.id);
    },
  };
}

export async function registerGitlabEvents(
  jobs: Jobs,
  deps: DeliveryDeps,
  registry: ScmEventRegistry = scmEvents,
): Promise<void> {
  if (!deps.pool) return;
  const handlers = gitlabEventHandlers(deps, jobs);
  registry.on("pipeline", handlers.pipeline);
  registry.on("job", handlers.job);
}
