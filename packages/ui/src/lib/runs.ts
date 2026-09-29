// Small helpers shared by the Board (this machine's runs) and the Runs page (the runs machines pushed to the hub).
import { hasKey, translate, type MessageKey } from "../i18n/translate.ts";

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
