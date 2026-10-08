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
}

/** Usage numbers older than this get "cập nhật lúc …": Codex's are those of its last turn, which may be hours back. */
export const USAGE_STALE_MS = 3600_000;

/** When usage taken at `checkedAt` is old enough to say so; null while it is fresh or not known. */
export function usageAsOf(checkedAt: string | null | undefined, now = Date.now()): string | null {
  const at = checkedAt ? Date.parse(checkedAt) : NaN;
  return !Number.isNaN(at) && now - at > USAGE_STALE_MS ? checkedAt! : null;
}

/** How long until a limit resets, in whole minutes split up; null when that is not known or already past. */
export function countdown(resetsAt: string | null | undefined, now: number): { days: number; hours: number; minutes: number } | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at) || at <= now) return null;
  // Rounded up: "còn 0 phút" while a few seconds are left would read as already reset.
  const total = Math.ceil((at - now) / 60_000);
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** Why a subscription has no number for a limit (roadmap 52): the short reason shown after "chưa biết". */
export type UsageUnknown = "signedOut" | "notChecked" | "noSession" | "noReport";

export function usageUnknown(p: Pick<AgentProfileStatus, "kind" | "login" | "usage">): UsageUnknown {
  if (p.login?.loggedIn === false) return "signedOut";
  if (!p.login) return "notChecked";
  // Codex writes its limits into a session file only when it runs: none yet on this sign-in folder.
  if (p.kind === "codex") return "noSession";
  return "noReport";
}

/** The bar's colour against the profile's own stop threshold (3c): at the mark the runner stops using the profile. */
export function meterTone(percent: number, stop: number): "ok" | "near" | "over" {
  return percent >= stop ? "over" : percent >= stop - 10 ? "near" : "ok";
}

export type QuotaLimit =
  | { known: true; percent: number; stop: number; tone: "ok" | "near" | "over"; resets: string | null; resetsAt: string | null; left: ReturnType<typeof countdown> }
  | { known: false; why: UsageUnknown };

/**
 * The quota block every row shows (roadmap 52), whatever state the row is in: both limits (or why one is unknown), the
 * counts since the counter's mark, the rest with its Bỏ nghỉ, and whether Đọc lại can check the profile.
 */
export interface QuotaView {
  session: QuotaLimit;
  week: QuotaLimit;
  counts: { hitLimit: number; runs: number; done: number; failed: number; since: string | null };
  /** Set whenever the profile rests: the quota line says until when. */
  rest: { until: string; reason: string | null } | null;
  /**
   * Hive holds the profile back (its rest, a stop threshold): Dùng tiếp shows, next to any other button of the row,
   * because Hive's own guess is what a person may want to overrule.
   */
  canResume: boolean;
  /** A Dùng tiếp still in force: thresholds off until `until`, and who asked. */
  resumed: { until: string; at: string; by: string } | null;
  /** The main process checks enabled profiles only. */
  canRead: boolean;
}

export function quotaView(p: AgentProfileStatus, now: number): QuotaView {
  const limit = (which: "session" | "week"): QuotaLimit => {
    const l = p.usage?.[which];
    if (!l) return { known: false, why: usageUnknown(p) };
    const stop = which === "session" ? p.stopAtSession : p.stopAtWeek;
    const percent = Math.max(0, Math.min(100, Math.round(l.percent)));
    return { known: true, percent, stop, tone: meterTone(percent, stop), resets: l.resets, resetsAt: l.resetsAt ?? null, left: countdown(l.resetsAt, now) };
  };
  return {
    session: limit("session"),
    week: limit("week"),
    counts: { hitLimit: p.stats.rateLimited, runs: p.stats.runs, done: p.stats.succeeded, failed: p.stats.failed, since: p.stats.since },
    rest: p.cooldownUntil ? { until: p.cooldownUntil, reason: p.cooldownReason } : null,
    canResume: !!p.cooldownUntil || usageStop(p, p.usage, now) !== null,
    resumed: p.resumed && Date.parse(p.resumed.until) > now ? p.resumed : null,
    canRead: p.enabled,
  };
}

/** The one button the row's actions carry for its state; Dùng tiếp is not one of them (see QuotaView.canResume). */
export function rowFix(p: AgentProfileStatus): "installCli" | "login" | null {
  const state = profileState(p);
  return state === "noCli" ? "installCli" : state === "signedOut" && p.login?.loginCommand ? "login" : null;
}

/** Splits the machine's subscriptions the way the table shows them (roadmap 39, "Nguyên tắc chung"). */
export function profileRows(profiles: AgentProfileStatus[]): ProfileRows {
  const on = profiles.filter((p) => p.enabled);
  const off = profiles.filter((p) => !p.enabled);
  // Stable: what needs a hand goes up, the rest keeps the order of the config.
  const rank = (p: AgentProfileStatus) => (needsHand(profileState(p)) ? 0 : 1);
  on.sort((a, b) => rank(a) - rank(b));
  return { on, off };
}

export function machineQuota(profiles: AgentProfileStatus[], now: number) {
  const available = profiles.filter((p) => p.enabled && p.cliPath !== null && p.login?.loggedIn !== false && !usageStop(p, p.usage) && (!p.cooldownUntil || Date.parse(p.cooldownUntil) <= now) && p.running < p.maxConcurrent);
  const resets = profiles.filter((p) => p.enabled).flatMap((p) => [p.usage?.session?.resetsAt, p.usage?.week?.resetsAt].filter((at): at is string => !!at && Date.parse(at) > now).map((at) => ({ at, label: p.label }))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { count: available.length, slots: available.reduce((sum, p) => sum + Math.max(0, p.maxConcurrent - p.running), 0), reset: resets[0]?.at ?? null, label: resets[0]?.label ?? null };
}
