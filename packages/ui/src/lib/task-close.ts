import type { Task } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import type { TFunction } from "#ui/i18n/index.tsx";

/** Keep review and merge state visible when a person closes a task. */
export async function confirmTaskClose(client: HiveClient, task: Task, t: TFunction): Promise<boolean> {
  const runs = await client.call("runs.list", { project: task.project, taskId: task.id, limit: 200 });
  const latestReview = runs.find(run => run.role === "review");
  const branchRun = runs.find(run => !!run.branch);
  const queue = await client.call("mergeQueue.get", { project: task.project, landing: branchRun?.branch
    ? { taskId: task.id, branch: branchRun.branch, runId: branchRun.runId, machineId: branchRun.machineId } : undefined });
  const mergedInQueue = queue.landed === true;
  const mergedByMr = !!branchRun?.branch && runs.some(run => run.runId === branchRun.runId && run.machineId === branchRun.machineId
    && run.branch === branchRun.branch && (run.merge?.status === "merged" || run.mr?.status === "merged"));
  const unmerged = !!branchRun?.branch && !mergedInQueue && !mergedByMr;
  if (latestReview?.verdict === "approve" && !unmerged) return true;
  const reasons = [
    latestReview?.verdict !== "approve" ? t("tasks.closeReviewWarning", { verdict: latestReview?.verdict === "changes" ? t("tasks.closeReviewChanges") : t("tasks.closeNoReview") }) : "",
    unmerged ? t("tasks.closeBranchWarning", { branch: branchRun!.branch!, target: queue.config.target }) : "",
  ].filter(Boolean).join("\n\n");
  const queueHint = queue.config.enabled && queue.waiting.some(item => item.taskId === task.id && item.runId === branchRun?.runId && item.machineId === branchRun?.machineId)
    ? t("tasks.closeQueueHint") : "";
  return window.confirm(`${t("tasks.closeWarning", { id: task.id })}\n\n${reasons}${queueHint ? `\n\n${queueHint}` : ""}`);
}
