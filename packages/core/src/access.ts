// Who may see and change which project's data. Browser-safe: the UI uses the same rules to hide controls.
//
// Hub accounts get a level per project (view < contribute < manage). Data shared by the whole team
// ("Chung": org docs, shared memory) is visible to every account; changing it is for hub admins,
// except that anyone who contributes to a project may also contribute to the shared data
// (propose shared docs, write shared memory, which still waits for approval on the hub).
//
// Actors without `access` are unrestricted: local mode, hub admins and tokens that belong to no
// account (created before accounts existed). For them the role alone decides, as it always has.
import type { Actor, Role } from "./types.ts";

export const LEVELS = ["view", "contribute", "manage"] as const;
export type Level = (typeof LEVELS)[number];

export interface Access {
  /** Project key → level. Projects not listed are invisible. */
  projects: Record<string, Level>;
}

const RANK: Record<Level, number> = { view: 0, contribute: 1, manage: 2 };

/** The most a role may do, whatever the grants say: an agent token never approves its own work. */
const ROLE_CAP: Record<Role, Level> = { viewer: "view", agent: "contribute", member: "manage", admin: "manage" };

/** Unrestricted actors: the old role rules. */
const ROLE_LEVEL: Record<Role, Level> = { viewer: "view", agent: "contribute", member: "contribute", admin: "manage" };

const lower = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);

/** The level an actor has on a project (owner) or on the shared data (owner null); null = cannot see it. */
export function levelOn(actor: Actor, owner: string | null): Level | null {
  if (!actor.access) return ROLE_LEVEL[actor.role];
  const granted = owner === null ? sharedLevel(actor.access) : (actor.access.projects[owner] ?? null);
  return granted === null ? null : lower(granted, ROLE_CAP[actor.role]);
}

function sharedLevel(access: Access): Level {
  return Object.values(access.projects).some((l) => RANK[l] >= RANK.contribute) ? "contribute" : "view";
}

export function can(actor: Actor, owner: string | null, need: Level): boolean {
  const level = levelOn(actor, owner);
  return level !== null && RANK[level] >= RANK[need];
}

export const LEVEL_LABEL: Record<Level, string> = { view: "Xem", contribute: "Đóng góp", manage: "Quản trị" };
