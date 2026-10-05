// The Agent page's list (roadmap 39c): the one state a subscription is in, and how the rows are grouped.
import { usageStop, type AgentProfileStatus } from "@xdev-hive/core";

export type ProfileState = "running" | "ready" | "off" | "noCli" | "signedOut" | "overLimit" | "resting" | "near";

/**
 * The first that holds wins. A run going on shows before a limit, as on the agent map: what the machine is doing now
 * matters more than what it may not start.
 */
export function profileState(p: AgentProfileStatus): ProfileState {
  if (!p.enabled) return "off";
  if (p.cliPath === null) return "noCli";
  if (p.login?.loggedIn === false) return "signedOut";
  if (p.running) return "running";
  if (usageStop(p, p.usage)) return "overLimit";
  if (p.cooldownUntil) return "resting";
  const top = Math.max(p.usage?.session?.percent ?? 0, p.usage?.week?.percent ?? 0);
  if (top >= 85) return "near";
  return "ready";
}

/** The states the person has to do something about: those rows carry the one button that fixes them. */
export const needsHand = (state: ProfileState) => state === "noCli" || state === "signedOut";

export interface ProfileRows {
  /** Rows shown right away, what needs a hand first. */
  on: AgentProfileStatus[];
  /** Off subscriptions, folded into "n gói đang tắt" until the person opens them. */
  off: AgentProfileStatus[];
  /** A row has no usage numbers, so the table carries its one footnote instead of a sentence per row. */
  someWithoutUsage: boolean;
}

export const hasUsage = (p: AgentProfileStatus) => Boolean(p.usage?.session || p.usage?.week);

/** Usage numbers older than this get "cập nhật lúc …": Codex's are those of its last turn, which may be hours back. */
export const USAGE_STALE_MS = 3600_000;

/** When usage taken at `checkedAt` is old enough to say so; null while it is fresh or not known. */
export function usageAsOf(checkedAt: string | null | undefined, now = Date.now()): string | null {
  const at = checkedAt ? Date.parse(checkedAt) : NaN;
  return !Number.isNaN(at) && now - at > USAGE_STALE_MS ? checkedAt! : null;
}

/** Splits the machine's subscriptions the way the table shows them (roadmap 39, "Nguyên tắc chung"). */
export function profileRows(profiles: AgentProfileStatus[]): ProfileRows {
  const on = profiles.filter((p) => p.enabled);
  const off = profiles.filter((p) => !p.enabled);
  // Stable: what needs a hand goes up, the rest keeps the order of the config.
  const rank = (p: AgentProfileStatus) => (needsHand(profileState(p)) ? 0 : 1);
  on.sort((a, b) => rank(a) - rank(b));
  return { on, off, someWithoutUsage: profiles.some((p) => !hasUsage(p)) };
}
