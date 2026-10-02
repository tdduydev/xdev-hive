// Small helpers shared by the Board (this machine's runs) and the Runs page (the runs machines pushed to the hub).
export { fixInstructions } from "@xdev-hive/core";
import { hasKey, translate, type MessageKey } from "#ui/i18n/translate.ts";

type Timed = { startedAt: string | null; finishedAt: string | null };

/** How long a run ran, or has been running: "42s", "3m05". Empty before it starts. */
export function runDuration(run: Timed, now: Date = new Date()): string {
  if (!run.startedAt) return "";
  const end = run.finishedAt ? new Date(run.finishedAt) : now;
  const s = Math.max(0, Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/** Still worth following: it waits for a plan or an agent is on it. */
export const isLive = (run: { status: string }): boolean => run.status === "queued" || run.status === "running";

/**
 * A run's status or role in the viewer's language. The hub stores what machines sent, and a newer machine may send
 * one this page does not know yet: shown as it came.
 */
export function runLabel(kind: "runStatus" | "agentRole", value: string): string {
  const key = `${kind}.${value}`;
  return hasKey(key) ? translate(key as MessageKey) : value;
}

/** Badge tone of a run request's status. */
export const REQUEST_TONE: Record<string, string> = { pending: "info", accepted: "ok", rejected: "danger", cancelled: "neutral", expired: "warn" };

/** Why a machine refused a run request, in the viewer's language when the machine sent a key this page knows. */
export function requestErrorText(error: { message: string; key?: string; vars?: Record<string, string | number> }): string {
  return error.key && hasKey(error.key) ? translate(error.key as MessageKey, error.vars) : error.message;
}

/** The newest review run of each task (runs come newest first): only that one offers a fix. Keys: machineId/runId. */
export function latestReviews(runs: Array<{ machineId: string; runId: string; project: string; taskId: string; role: string }>): Set<string> {
  const seen = new Set<string>();
  const latest = new Set<string>();
  for (const r of runs) {
    if (r.role !== "review") continue;
    const task = `${r.project}/${r.taskId}`;
    if (seen.has(task)) continue;
    seen.add(task);
    latest.add(`${r.machineId}/${r.runId}`);
  }
  return latest;
}
