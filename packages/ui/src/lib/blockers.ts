import type { Machine, Permission, RunRequestError, Task, TaskAgentQueueItem } from "@xdev-hive/core";
import { gatePermission, type InboxItem } from "#ui/lib/inbox.ts";

export const BLOCKER_KINDS = ["dependency", "quota", "policy", "review", "test", "conflict", "release", "offline", "unknown"] as const;
export type BlockerKind = typeof BLOCKER_KINDS[number];
export interface Blocker {
  key: string;
  kind: BlockerKind;
  project: string;
  subject: string;
  detail: string;
  task?: Task;
  item?: InboxItem;
  permission: Permission;
  error?: RunRequestError;
}

/** Classify machine errors by their stable key; arbitrary log prose is not a reliable diagnosis. */
export function holdKind(key?: string): BlockerKind {
  if (!key) return "unknown";
  if (/quota|budget|cooldown|rateLimit/i.test(key)) return "quota";
  if (/policy|paused|permission|denied/i.test(key)) return "policy";
  if (/offline|machineMissing|machineGone|machineNotFound/i.test(key)) return "offline";
  if (/conflict/i.test(key)) return "conflict";
  return "unknown";
}

/** Several causes may block one task; each cause has its own stable identity. */
export function buildBlockers(tasks: Task[], machines: Machine[], items: InboxItem[], queues: TaskAgentQueueItem[] = []): Blocker[] {
  const rows: Blocker[] = [];
  const add = (task: Task, kind: BlockerKind, detail = "") => {
    const key = `${task.project}/${task.id}/${kind}`;
    if (!rows.some(row => row.key === key)) rows.push({ key, kind, project: task.project, subject: `${task.id} · ${task.title}`, detail, task, permission: kind === "review" ? "codeReview" : kind === "release" ? "projectSettings" : kind === "dependency" ? "taskWork" : "runDispatch" });
  };
  for (const task of tasks) {
    if (task.status === "done") continue;
    const start = rows.length;
    if (task.waitingOn.length || task.waitingHidden) add(task, "dependency", task.waitingOn.join(", "));
    if (task.agent?.hold) add(task, holdKind(task.agent.hold.key), task.agent.hold.message);
    if (task.agent && machines.some(m => m.id === task.agent!.machineId && !m.online)) add(task, "offline", task.agent.machine);
    if (/^OPS-release-/.test(task.id)) add(task, "release", task.note ?? "");
    if (task.status === "review") add(task, "review");
    if (task.status === "blocked" && rows.length === start) add(task, "unknown", task.note ?? "");
  }
  for (const entry of queues) {
    if (!entry.waiting || entry.task.status === "done" || !tasks.some(t => t.id === entry.task.id && t.project === entry.task.project)) continue;
    const kind = holdKind(entry.waiting.key);
    const key = `${entry.task.project}/${entry.task.id}/${kind}`;
    if (/agentTaskBusy|agentBusy|taskInFlow/.test(entry.waiting.key ?? "")) continue;
    if (entry.waiting.key === "errors.taskWaiting") continue;
    if (!rows.some(row => row.key === key)) {
      add(entry.task, kind, entry.waiting.message);
      rows[rows.length - 1]!.error = entry.waiting;
    }
  }
  for (const item of items) {
    // Tasks above include read-only blockers too; avoid repeating their actionable inbox versions.
    if (item.kind === "agentHold" || item.kind === "review" || item.kind === "releaseFailure") continue;
    let kind: BlockerKind;
    let permission: Permission = "runDispatch";
    let subject: string;
    let detail = "";
    switch (item.kind) {
      case "waitingRun": kind = item.reason === "quota" ? "quota" : item.reason === "ci" ? "test" : "unknown"; subject = `${item.run.taskId} · ${item.run.taskTitle}`; detail = item.run.error ?? item.run.summary ?? ""; break;
      case "ci": kind = "test"; subject = item.run.taskId; break;
      case "gate": kind = item.gate.gate === "test" ? "test" : item.gate.gate === "release" ? "release" : "review"; subject = item.gate.taskId; permission = gatePermission(item.gate); break;
      case "plan": kind = "review"; subject = item.plan.taskId; break;
      case "conflict": kind = "conflict"; subject = `#${item.memory.id} / #${item.other.id}`; detail = item.memory.content; permission = "memoryApprove"; break;
      default: continue;
    }
    rows.push({ key: item.key, kind, project: item.scope, subject, detail, item, permission });
  }
  return rows;
}
