// Who may see and do what in each project (roadmap 25). Browser-safe: the UI uses the same rules to hide controls.
//
// Hub accounts get a grant per project: a role (Người xem, Thành viên, Reviewer, Quản lý dự án) or exactly the
// permissions picked for them. The shared data ("Chung": org docs, shared memory and skills) has a grant of its own;
// an account without one sees it, and may propose and write memory there when it may do so in some project.
// Grants saved before roadmap 25 (view, contribute, manage) read as viewer, member and lead, which allow the same.
//
// Actors without `access` are unrestricted: local mode, hub admins and tokens that belong to no account (created
// before accounts existed). For them the role alone decides, as it always has. Whatever the grants, a role caps what
// may be done: an agent token works on tasks and proposes, it never approves its own work.
import type { Actor, Role } from "./types.ts";

export const PERMISSIONS = [
  /** Tasks, runs, docs, memory, skills, chat and the agent context of the project. */
  "view",
  /** Take a task and update it, send what a run did (agents, and people working a task by hand). */
  "taskWork",
  /** Create tasks and change what they wait for. */
  "taskManage",
  /** Ask a machine to run a task, stop a run, cancel a request. */
  "runDispatch",
  /** Talk to the project's leader in Chat. */
  "chatUse",
  /** Accept or refuse what the leader proposes to do (create tasks, run them…). */
  "chatApprove",
  /** Propose a change to a doc or skill, attach files, ask the writing assistant. */
  "docPropose",
  /** Save a doc as a new version, make pages and folders, move them. */
  "docEdit",
  /** Approve or reject proposed changes to docs and skills. */
  "docApprove",
  /** What agents read: AGENTS.md, decisions, docs for some paths or put in AGENTS.md, skills (edit, approve). */
  "contextEdit",
  /** Write memory (it waits for approval). */
  "memoryWrite",
  /** Approve memory, keep one of two that disagree, remove an entry. */
  "memoryApprove",
  /** Review code: move a task out of review to done. */
  "codeReview",
  /** The project's systems, its chat defaults and the leader's commands. */
  "projectSettings",
  /** Add accounts to the project and set their role (never above one's own). */
  "membersManage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PROJECT_ROLES = ["viewer", "member", "reviewer", "lead"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const MEMBER: Permission[] = ["view", "taskWork", "docPropose", "memoryWrite"];
export const ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  viewer: ["view"],
  member: MEMBER,
  reviewer: [...MEMBER, "docApprove", "memoryApprove", "chatApprove", "codeReview"],
  lead: PERMISSIONS,
};

/** The levels grants had before roadmap 25: still read (as viewer, member, lead), never written. */
export type LegacyLevel = "view" | "contribute" | "manage";

/** A role, or exactly these permissions ("Tuỳ chỉnh"). */
export type Grant = ProjectRole | LegacyLevel | { permissions: Permission[] };

export interface Access {
  /** Project key → grant. Projects not listed are invisible. */
  projects: Record<string, Grant>;
  /** The shared data; absent: view, and propose / write memory when the account may in some project. */
  shared?: Grant | null;
}

/** Levels saved before roadmap 25, and what they read as. */
const LEGACY: Record<LegacyLevel, ProjectRole> = { view: "viewer", contribute: "member", manage: "lead" };

/** A grant as stored or sent (an old level, a role, a permission list), or null when it is none of those. */
export function readGrant(raw: unknown): ProjectRole | { permissions: Permission[] } | null {
  if (typeof raw === "string") return (PROJECT_ROLES as readonly string[]).includes(raw) ? (raw as ProjectRole) : (LEGACY[raw as LegacyLevel] ?? null);
  const list = (raw as { permissions?: unknown } | null)?.permissions;
  if (!Array.isArray(list)) return null;
  const picked = PERMISSIONS.filter((p) => list.includes(p));
  if (picked.length !== new Set(list).size) return null;
  // Every other permission needs the project to be visible.
  return { permissions: picked.length && !picked.includes("view") ? ["view", ...picked] : picked };
}

export function grantPermissions(grant: Grant | null | undefined): Set<Permission> {
  const g = readGrant(grant);
  if (g === null) return new Set();
  return new Set(typeof g === "string" ? ROLE_PERMISSIONS[g] : g.permissions);
}

/** The role a set of permissions is, or "custom". */
export function grantRole(grant: Grant | null | undefined): ProjectRole | "custom" | null {
  const g = readGrant(grant);
  if (g === null) return null;
  if (typeof g === "string") return g;
  const has = grantPermissions(g);
  return PROJECT_ROLES.find((r) => ROLE_PERMISSIONS[r].length === has.size && ROLE_PERMISSIONS[r].every((p) => has.has(p))) ?? "custom";
}

/** The most a role may do, whatever the grants say: an agent token never approves its own work. */
const ROLE_CAP: Record<Role, readonly Permission[]> = { viewer: ["view"], agent: MEMBER, member: PERMISSIONS, admin: PERMISSIONS };

/**
 * Unrestricted actors: the role alone, as before roadmap 25 (contribute then also moved a task to done, which the local
 * MR watcher and an agent finishing on one person's machine still do). Hub accounts get codeReview from a grant only.
 */
const CONTRIBUTE: Permission[] = [...MEMBER, "codeReview"];
const ROLE_DEFAULT: Record<Role, readonly Permission[]> = { viewer: ["view"], agent: CONTRIBUTE, member: CONTRIBUTE, admin: PERMISSIONS };

/** What an account may do in the shared data: its own grant there, else derived from its projects. */
export function sharedPermissions(access: Access): Set<Permission> {
  if (access.shared !== undefined && access.shared !== null) return grantPermissions(access.shared);
  const anyWhere = Object.values(access.projects).map(grantPermissions);
  const out = new Set<Permission>(["view"]);
  for (const p of ["docPropose", "memoryWrite"] as const) if (anyWhere.some((s) => s.has(p))) out.add(p);
  return out;
}

/** What an actor may do in a project (owner) or in the shared data (owner null); null = cannot see it. */
export function permissionsOn(actor: Actor, owner: string | null): Set<Permission> | null {
  const cap = ROLE_CAP[actor.role];
  if (!actor.access) return new Set(ROLE_DEFAULT[actor.role]);
  const granted = owner === null ? sharedPermissions(actor.access) : grantPermissions(actor.access.projects[owner]);
  if (!granted.has("view")) return null;
  return new Set([...granted].filter((p) => cap.includes(p)));
}

/** Whether an actor sees a project (owner) or the shared data (owner null). */
export const sees = (actor: Actor, owner: string | null): boolean => permissionsOn(actor, owner) !== null;

export function may(actor: Actor, owner: string | null, permission: Permission): boolean {
  return permissionsOn(actor, owner)?.has(permission) ?? false;
}

/** What two actors may both do (the chat leader acts with its sender's rights, never more than its machine's). */
export function intersectAccess(a: Access | undefined, b: Access | undefined): Access | undefined {
  if (!a || !b) return a ?? b;
  const projects: Record<string, Grant> = {};
  for (const [project, grant] of Object.entries(a.projects)) {
    if (!(project in b.projects)) continue;
    const other = grantPermissions(b.projects[project]);
    projects[project] = { permissions: PERMISSIONS.filter((p) => grantPermissions(grant).has(p) && other.has(p)) };
  }
  const shared = sharedPermissions(b);
  return { projects, shared: { permissions: PERMISSIONS.filter((p) => sharedPermissions(a).has(p) && shared.has(p)) } };
}

/**
 * Docs agents read, which take contextEdit to change (roadmap 25): a project's AGENTS.md and decisions, skills, and
 * any doc for some paths or put in every project's AGENTS.md.
 */
export function isContextDoc(key: string, doc?: { paths?: readonly string[]; includeInAgents?: boolean } | null): boolean {
  if (/^project\/[^/]+\/(agents|decisions)$/.test(key) || /(^|\/)skills\//.test(key)) return true;
  return Boolean(doc && ((doc.paths?.length ?? 0) > 0 || doc.includeInAgents));
}

// ── systems (roadmap 19c) ─────────────────────────────────────────────────────

/** Docs and memory of a system belong to `sys:<name>`: no project name has a ":", so it is never a project's. */
export const SYSTEM_OWNER_PREFIX = "sys:";
export const systemOwner = (name: string): string => `${SYSTEM_OWNER_PREFIX}${name}`;
/** The system an owner is (`sys:pay` → `pay`), null for a project or the shared data. */
export const systemOf = (owner: string | null | undefined): string | null =>
  owner?.startsWith(SYSTEM_OWNER_PREFIX) ? owner.slice(SYSTEM_OWNER_PREFIX.length) : null;

/** What a person in any one service may do in its system's data: read it, propose a change, note what they learned. */
const SYSTEM_ANY: readonly Permission[] = ["view", "docPropose", "memoryWrite", "chatUse"];

/**
 * An account's grants with one for each system it sees, derived from its services' (asked 30/9 for 19, spelled out in
 * docs/specs/19c-system-docs.md): what it may do in any one of them for reading, proposing and writing memory, what
 * it may do in every one of them for the rest (editing a contract every service follows, approving). Unrestricted
 * actors (no access) need none.
 */
export function withSystemGrants(access: Access | undefined, systems: ReadonlyArray<{ name: string; projects: readonly string[] }>): Access | undefined {
  if (!access || !systems.length) return access;
  const projects: Record<string, Grant> = { ...access.projects };
  for (const s of systems) {
    const each = s.projects.map((p) => grantPermissions(access.projects[p]));
    if (!each.some((g) => g.has("view"))) continue;
    const permissions = PERMISSIONS.filter((p) => (SYSTEM_ANY.includes(p) ? each.some((g) => g.has(p)) : each.every((g) => g.has(p))));
    projects[systemOwner(s.name)] = { permissions };
  }
  return { ...access, projects };
}
