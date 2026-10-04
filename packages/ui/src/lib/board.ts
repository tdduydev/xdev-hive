// What the board decides from its own width and from the subscriptions, apart from how it draws them (roadmap 39g).
import { TASK_STATUSES, usageStop, type AgentProfileStatus, type TaskStatus } from "@xdev-hive/core";

/** Below this a column stops reading as a column: the cards' words break every line or two. */
export const COLUMN_MIN = 200;
/** gap-2.5 between the columns, in pixels. */
const COLUMN_GAP = 10;

/** Only these two fold away: the work in front of the reader (Chưa làm, Đang làm, Chờ review) always shows. */
export const FOLDABLE: readonly TaskStatus[] = ["blocked", "done"];

/**
 * Whether five full columns fit the width the board was given. A width of 0 is one not measured yet (the first
 * paint, a test): treat it as wide, so the board never flashes folded on a large window.
 */
export function fitsEveryColumn(width: number): boolean {
  return width === 0 || width >= TASK_STATUSES.length * COLUMN_MIN + (TASK_STATUSES.length - 1) * COLUMN_GAP;
}

/**
 * The columns shown as a narrow rail with their count: Xong and Bị chặn when they hold nothing, and — when five
 * columns no longer fit — those two whatever they hold, until the reader opens one.
 */
export function foldedColumns(width: number, count: (status: TaskStatus) => number, opened: ReadonlySet<TaskStatus>): Set<TaskStatus> {
  const narrow = !fitsEveryColumn(width);
  return new Set(FOLDABLE.filter((status) => !opened.has(status) && (narrow || count(status) === 0)));
}

/** Why a subscription is not taking work, in the order the Board says it. */
export type ProfileState = "off" | "signedOut" | "overLimit" | "resting" | "ready";
type ProfileLike = Pick<AgentProfileStatus, "enabled" | "cooldownUntil" | "login" | "usage" | "stopAtSession" | "stopAtWeek">;

/** One subscription's state. A running one is still ready: it is working, not stopped. */
export function profileState(p: ProfileLike): ProfileState {
  if (!p.enabled) return "off";
  if (p.login?.loggedIn === false) return "signedOut";
  if (usageStop(p, p.usage) !== null) return "overLimit";
  if (p.cooldownUntil !== null) return "resting";
  return "ready";
}

/** How many subscriptions are in each state, for the chip at the top of the Board ("5/7 gói sẵn sàng · 1 đang nghỉ"). */
export function profileSummary(profiles: ProfileLike[]): Record<ProfileState, number> & { total: number } {
  const out = { off: 0, signedOut: 0, overLimit: 0, resting: 0, ready: 0, total: profiles.length };
  for (const p of profiles) out[profileState(p)] += 1;
  return out;
}
