// Pure helpers behind Quản trị › Người dùng, Vai trò & quyền and Sơ đồ tổ chức (R-72l): the lists are filtered, sorted and
// paged in the browser because the hub returns every account in one call, so none of it needs a new endpoint.
import { grantRole, PROJECT_ROLES, ROLE_PERMISSIONS, type ChatDefaults, type HiveSystem, type Machine, type HubUser, type Permission, type ProjectRole } from "@xdev-hive/core";

export type UserFilter = "all" | "admin" | "active" | "disabled" | "mustChange" | "sso";
export const USER_FILTERS: UserFilter[] = ["all", "admin", "active", "disabled", "mustChange", "sso"];
export type UserSort = "name" | "role" | "access" | "sso" | "last" | "status";
export type SortDir = "asc" | "desc";
export const USER_PAGE_SIZE = 8;

/** disabled beats must-change beats active: the one state a row shows. */
export const userStatus = (u: HubUser): "disabled" | "mustChange" | "active" => (u.disabled ? "disabled" : u.mustChangePassword ? "mustChange" : "active");

const matchesFilter = (u: HubUser, f: UserFilter): boolean =>
  f === "all" ? true : f === "admin" ? u.admin : f === "sso" ? u.sso : userStatus(u) === f;

/** Name, username or display name contain the query (no accents folded: names are matched as typed, case aside). */
export function filterUsers(users: HubUser[], query: string, filter: UserFilter): HubUser[] {
  const q = query.trim().toLowerCase();
  return users.filter((u) => matchesFilter(u, filter) && (!q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)));
}

export const filterCounts = (users: HubUser[]): Record<UserFilter, number> =>
  Object.fromEntries(USER_FILTERS.map((f) => [f, users.filter((u) => matchesFilter(u, f)).length])) as Record<UserFilter, number>;

const STATUS_ORDER = { active: 0, mustChange: 1, disabled: 2 } as const;
const key = (u: HubUser, by: UserSort): string | number => {
  switch (by) {
    case "name": return u.displayName.toLowerCase();
    case "role": return u.admin ? 0 : 1;
    case "access": return u.admin ? Number.MAX_SAFE_INTEGER : Object.keys(u.grants).length;
    case "sso": return u.sso ? 0 : 1;
    case "last": return u.lastLoginAt ? Date.parse(u.lastLoginAt) : 0;
    case "status": return STATUS_ORDER[userStatus(u)];
  }
};

/** Stable: ties keep the hub's order, and equal keys fall back to the name so a click never shuffles rows. */
export function sortUsers(users: HubUser[], by: UserSort, dir: SortDir): HubUser[] {
  const sign = dir === "asc" ? 1 : -1;
  return users
    .map((u, i) => ({ u, i }))
    .sort((a, b) => {
      const x = key(a.u, by);
      const y = key(b.u, by);
      const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : (x as number) - (y as number);
      return c ? c * sign : a.u.displayName.localeCompare(b.u.displayName) || a.i - b.i;
    })
    .map((r) => r.u);
}

export interface Paged<T> { rows: T[]; page: number; pages: number; from: number; to: number; total: number }
/** `page` is 1-based and clamped, so deleting the last row of the last page lands on the new last page. */
export function paginate<T>(items: T[], page: number, size = USER_PAGE_SIZE): Paged<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * size;
  const rows = items.slice(start, start + size);
  return { rows, page: p, pages, from: rows.length ? start + 1 : 0, to: start + rows.length, total: items.length };
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words.at(-1)![0]!).toUpperCase();
}

/** An avatar colour from the name, so a person keeps theirs on every screen. */
export function avatarHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Ids a bulk action may touch: never the signed-in admin (the hub refuses to lock oneself out, so skip rather than fail half-way). */
export const bulkTargets = (users: HubUser[], selected: ReadonlySet<string>, selfId: string | undefined): HubUser[] =>
  users.filter((u) => selected.has(u.id) && u.id !== selfId);

/** The select-all box covers the rows on the page; a mixed page reads as "not all". */
export const allSelected = (rows: HubUser[], selected: ReadonlySet<string>): boolean => rows.length > 0 && rows.every((u) => selected.has(u.id));

export interface MatrixRow { permission: Permission; cells: boolean[] }
/** One row per permission of a group, one cell per role in PROJECT_ROLES order. */
export const permissionMatrix = <G extends string>(groups: { id: G; permissions: Permission[] }[]): { id: G; rows: MatrixRow[] }[] =>
  groups.map((g) => ({ id: g.id, rows: g.permissions.map((p) => ({ permission: p, cells: PROJECT_ROLES.map((r) => ROLE_PERMISSIONS[r].includes(p)) })) }));

export const roleCounts = (): Record<ProjectRole, number> =>
  Object.fromEntries(PROJECT_ROLES.map((r) => [r, ROLE_PERMISSIONS[r].length])) as Record<ProjectRole, number>;

export type OrgRole = ProjectRole | "custom";
export interface OrgService { name: string; roles: { role: OrgRole; people: HubUser[] }[]; count: number }
export interface OrgSystem { name: string; services: OrgService[] }

/** Who holds which role on a service, read from the accounts' grants. Admins see everything, so they sit on the hub node instead. */
export function serviceRoles(users: HubUser[], project: string): OrgService {
  const by = new Map<OrgRole, HubUser[]>();
  for (const u of users) {
    if (u.admin || u.disabled) continue;
    const role = grantRole(u.grants[project]);
    if (role) by.set(role, [...(by.get(role) ?? []), u]);
  }
  const order: OrgRole[] = [...[...PROJECT_ROLES].reverse(), "custom"];
  const roles = order.filter((r) => by.has(r)).map((role) => ({ role, people: by.get(role)! }));
  return { name: project, roles, count: roles.reduce((n, r) => n + r.people.length, 0) };
}

/** Systems as the hub names them; services outside any system gather under `ungrouped` (only when there are some). */
export function orgTree(users: HubUser[], systems: HiveSystem[], projects: string[], ungrouped: string): OrgSystem[] {
  const inSystem = new Set(systems.flatMap((s) => s.projects));
  const out: OrgSystem[] = systems.map((s) => ({ name: s.name, services: s.projects.map((p) => serviceRoles(users, p)) }));
  const rest = projects.filter((p) => !inSystem.has(p));
  if (rest.length) out.push({ name: ungrouped, services: rest.map((p) => serviceRoles(users, p)) });
  return out;
}

/** How many people hold each role across every service, for the legend. */
export function orgLegend(tree: OrgSystem[]): Record<OrgRole, number> {
  const out = { viewer: 0, member: 0, qa: 0, reviewer: 0, lead: 0, custom: 0 } as Record<OrgRole, number>;
  for (const s of tree) for (const sv of s.services) for (const r of sv.roles) out[r.role] += r.people.length;
  return out;
}

export interface OrgAgent { key: string; machine: string; label: string; kind: string; online: boolean }
export interface OrgServiceAgents { leader: { machine: string; label: string } | null; agents: OrgAgent[] }

/**
 * The agents of one service, from what the hub already knows: the machines that hold the repo and their enabled, installed
 * profiles (the plan each runs on), and the leader the service's chat defaults pick. A leader whose machine or profile is
 * gone stays null rather than being guessed.
 */
export function serviceAgents(project: string, machines: Machine[], defaults: ChatDefaults | null): OrgServiceAgents {
  const agents = machines
    .filter((m) => m.projects.includes(project))
    .flatMap((m) => m.profiles.filter((p) => p.enabled && p.installed).map((p) => ({ key: `${m.id}/${p.id}`, machine: m.machine, label: p.label, kind: p.kind, online: m.online })));
  const machine = defaults?.machineId ? machines.find((m) => m.id === defaults.machineId) : undefined;
  const profile = machine?.profiles.find((p) => p.id === defaults?.profileId) ?? machine?.profiles.find((p) => p.enabled);
  return { leader: machine && profile ? { machine: machine.machine, label: profile.label } : null, agents };
}
