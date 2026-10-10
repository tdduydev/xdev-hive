// What the board decides from its own width and from the subscriptions, apart from how it draws them (roadmap 39g).
import { TASK_STATUSES, usageStop, type AgentProfileStatus, type TaskStatus } from "@xdev-hive/core";

/** Below this a column stops reading as a column: the cards' words break every line or two. */
export const COLUMN_MIN = 200;
/** gap-2.5 between the columns, in pixels. */
const COLUMN_GAP = 10;

/** The order the columns are drawn in (the design's); TASK_STATUSES stays the core's order. */
export const BOARD_ORDER: readonly TaskStatus[] = ["todo", "doing", "review", "blocked", "done"];

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
 * The columns shown as a narrow rail with their count: Xong and Bị chặn, only when five
 * columns no longer fit, whatever they hold, until the reader opens one.
 */
export function foldedColumns(width: number, _count: (status: TaskStatus) => number, opened: ReadonlySet<TaskStatus>): Set<TaskStatus> {
  // An empty column stays open: the design shows all five, and the board scrolls sideways when they do not fit.
  const narrow = !fitsEveryColumn(width);
  return new Set(FOLDABLE.filter((status) => !opened.has(status) && narrow));
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

/**
 * The projects the Board's picker offers. In local mode (and on the web's old Board) every project the reader sees,
 * the ones with a repo here first. The app connected to a hub shows this machine's work only (roadmap 44, after 35a):
 * just the projects in its config, since a run can only start where the repo is; the rest is on the hub's web.
 * A system picked in the sidebar narrows either list to its projects.
 */
export function boardProjects(input: { local: string[]; seen: string[]; system: string[] | null; machineOnly: boolean }): string[] {
  const { local, seen, system, machineOnly } = input;
  const inSystem = (p: string) => !system || system.includes(p);
  if (machineOnly) return [...new Set(local.filter(inSystem))];
  return system ? [...new Set([...local.filter(inSystem), ...system])] : [...new Set([...local, ...seen])];
}
