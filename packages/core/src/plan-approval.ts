import type { TaskSize } from "#core/task-classify.ts";

export const PLAN_APPROVAL_MODES = ["off", "medium-large", "all"] as const;
export type PlanApprovalMode = (typeof PLAN_APPROVAL_MODES)[number];
export const PLAN_MAX = 16000;
export interface PlanApprovalSettings { mode: PlanApprovalMode; timeoutMinutes: number | null }
export const DEFAULT_PLAN_APPROVAL: PlanApprovalSettings = { mode: "off", timeoutMinutes: null };
export function needsPlanApproval(settings: PlanApprovalSettings | undefined, size: TaskSize | null): boolean {
  // Unknown size is treated as medium, as the classifier's fallback, so missing data cannot bypass approval.
  return settings?.mode === "all" || (settings?.mode === "medium-large" && size !== "s");
}
export interface ImplementationPlan {
  id: number;
  project: string;
  taskId: string;
  taskTitle: string;
  machineId: string;
  requestId: number;
  runId: string | null;
  status: "planning" | "waiting" | "approved" | "changes" | "failed" | "cancelled";
  text: string | null;
  note: string | null;
  revision: number;
  createdAt: string;
  readyAt: string | null;
  deadline: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}
export interface RunPlan { id: number; phase: "plan" | "implement"; text: string | null; note: string | null }
