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

export { waitingReason } from "@xdev-hive/core";

export function handoffSections(summary: string | null): Array<{ id: "done" | "left" | "verify" | "risk"; text: string }> {
  if (!summary) return [];
  const headings: Array<["done" | "left" | "verify" | "risk", RegExp]> = [
    ["done", /^(?:#{1,4}\s*)?(?:ĐÃ LÀM|DONE)\s*:?\s*(.*)$/i],
    ["left", /^(?:#{1,4}\s*)?(?:CHƯA LÀM|NOT DONE|REMAINING)\s*:?\s*(.*)$/i],
    ["verify", /^(?:#{1,4}\s*)?(?:CÁCH KIỂM|HOW TO VERIFY|VERIFICATION)\s*:?\s*(.*)$/i],
    ["risk", /^(?:#{1,4}\s*)?(?:RỦI RO|RISKS?)\s*:?\s*(.*)$/i],
  ];
  const found: Array<{ id: "done" | "left" | "verify" | "risk"; text: string }> = [];
  for (const line of summary.split("\n")) {
    const match = headings.map(([id, re]) => ({ id, match: line.trim().replace(/\*\*/g, "").match(re) })).find((x) => x.match);
    if (match) found.push({ id: match.id, text: match.match![1] ?? "" });
    else if (found.length) found[found.length - 1]!.text += `${found[found.length - 1]!.text ? "\n" : ""}${line}`;
  }
  return headings.flatMap(([id]) => {
    const text = found.filter((item) => item.id === id).map((item) => item.text.trim()).filter(Boolean).join("\n");
    return found.some((item) => item.id === id) ? [{ id, text }] : [];
  });
}

/**
 * A run's status or role in the viewer's language. The hub stores what machines sent, and a newer machine may send
 * one this page does not know yet: shown as it came.
 */
export function runLabel(kind: "runStatus" | "agentRole", value: string): string {
  const key = `${kind}.${value}`;
  return hasKey(key) ? translate(key as MessageKey) : value;
}

/** A run's merge request as a person names it: a GitLab MR by its !iid, a GitHub PR by its #iid. */
export function mrLabel(mr: { mrUrl: string | null; iid: number | null }): string {
  return /\/pull\/\d+$/.test(mr.mrUrl ?? "") ? `PR #${mr.iid ?? "?"}` : `MR !${mr.iid ?? "?"}`;
}

/**
 * Which quick filter (Đang chạy / Lỗi / Xong) a run belongs to. The three cover every status, one from a newer
 * machine included, so no run falls out of all of them: anything that ended without succeeding reads as a problem,
 * a cancelled run too.
 */
export function runGroup(status: string): "live" | "bad" | "done" {
  return isLive({ status }) ? "live" : status === "succeeded" ? "done" : "bad";
}

/** Fields the result line reads, as AgentRun (this machine) and RunRecord (the hub) each have them. */
export interface OutcomeRun {
  status: string;
  activity?: string | null;
  error?: string | null;
  commits?: number;
  mrUrl?: string | null;
  mrIid?: number | null;
  mr?: { iid: number | null } | null;
}

/** One line, so a result keeps the list row's height whatever the agent wrote. */
function firstLine(text: string, max = 80): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What happened, in the viewer's words, under the task's title: "Xong · 2 commit · MR !12", "Lỗi: TypeError…",
 * "Đang chạy · Viết test". A row has no log, so a live run shows what the agent last said it was doing
 * (AgentRun.activity); which step that is belongs to the detail's steps.
 */
export function runOutcome(run: OutcomeRun): string {
  const state = runLabel("runStatus", run.status);
  const group = runGroup(run.status);
  if (group === "live") return run.activity ? `${state} · ${firstLine(run.activity)}` : state;
  if (group === "bad") return run.error ? translate("runs.outcomeWhy", { state, why: firstLine(run.error) }) : state;
  const parts = [state];
  if (run.commits) parts.push(translate("board.commits", { count: run.commits }));
  const iid = run.mrIid ?? run.mr?.iid ?? null;
  if (iid !== null || run.mrUrl) parts.push(mrLabel({ mrUrl: run.mrUrl ?? null, iid }));
  return parts.join(" · ");
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

/** Timeout is reported as failed by the runner. */
export const canRedispatch = (run: { status: string }): boolean => ["failed", "cancelled", "rate_limited"].includes(run.status);

/** Machine-qualified links also work when two machines reported the same run id. */
export const runLink = (machineId: string, runId: string): string => `#/runs?run=${encodeURIComponent(`${machineId}/${runId}`)}`;
