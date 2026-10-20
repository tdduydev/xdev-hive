import type { Jobs } from "../platform/index.ts";
import { registerApprovals } from "./approvals.ts";
import { registerGitlabEvents } from "./ci/gitlab-events.ts";
import { registerCiPoll } from "./ci/poll.ts";
import { registerWebhookRefresh } from "./ci/webhook-refresh.ts";
import { registerExternalDeploys } from "./deploys/external.ts";
import { registerOrchestrator } from "./deploys/orchestrator.ts";
import type { DeliveryDeps } from "./deps.ts";
import { registerRetention } from "./retention.ts";

// Tên queue nằm ở queues.ts để phần nghiệp vụ xếp job được mà không vòng lại qua phần đăng ký worker.
export * from "./queues.ts";

export async function registerDelivery(jobs: Jobs, deps: DeliveryDeps): Promise<void> {
  await registerCiPoll(jobs, deps);
  await registerGitlabEvents(jobs, deps);
  await registerWebhookRefresh(jobs, deps);
  await registerOrchestrator(jobs, deps);
  await registerExternalDeploys(jobs, deps);
  await registerApprovals(jobs, deps);
  await registerRetention(jobs, deps);
}
