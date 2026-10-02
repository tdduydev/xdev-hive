// What the whole app is looking at: every project, only the team-wide (shared) data, one project, or a system.
// Chosen once in the sidebar; every page filters by it and new items default to it.
import { systemOf, systemOwner, type HiveSystem } from "@xdev-hive/core";
import { translate } from "#ui/i18n/translate.ts";

export type Scope =
  | { kind: "all" }
  | { kind: "shared" }
  | { kind: "project"; project: string }
  /** A system (roadmap 19b): its projects come from the hub's list, none until it has loaded. */
  | { kind: "system"; system: string; projects: string[] };

export const ALL: Scope = { kind: "all" };
export const SHARED: Scope = { kind: "shared" };
export const projectScope = (project: string): Scope => ({ kind: "project", project });
export const systemScope = (system: string, projects: string[] = []): Scope => ({ kind: "system", system, projects });

const STORAGE = "xdev-hive.scope";
const SHARED_KEY = "@shared";
const SYSTEM_PREFIX = "@system:";

export function scopeLabel(s: Scope): string {
  if (s.kind === "all") return translate("common.allProjects");
  if (s.kind === "shared") return translate("common.sharedTeam");
  return s.kind === "system" ? s.system : s.project;
}

/** The project of a scope, or null for all / shared / a system. */
export const scopeProject = (s: Scope): string | null => (s.kind === "project" ? s.project : null);

/** The projects a scope narrows lists to: its one, its system's, or null for all / shared. */
export const scopeProjects = (s: Scope): string[] | null => (s.kind === "project" ? [s.project] : s.kind === "system" ? s.projects : null);

/** What the list methods take for a scope: a `project`, a system's `projects`, or nothing (all / shared). */
export function scopeFilter(s: Scope): { project?: string; projects?: string[] } {
  return s.kind === "project" ? { project: s.project } : s.kind === "system" ? { projects: s.projects } : {};
}

/** Which scope this is (a system by its name): changes when another one is picked. */
export const scopeId = (s: Scope): string => (s.kind === "project" ? `project:${s.project}` : s.kind === "system" ? `system:${s.system}` : s.kind);

/** Changes when what a scope lists does, a system's projects included: for query dependencies. */
export const scopeKey = (s: Scope): string => (s.kind === "system" ? `${scopeId(s)}:${s.projects.join(",")}` : scopeId(s));

export function sameScope(a: Scope, b: Scope): boolean {
  return scopeId(a) === scopeId(b);
}

/** A system's projects filled in from the hub's list; a system that is gone is all projects again. */
export function resolveScope(s: Scope, systems: HiveSystem[] | undefined): Scope {
  if (s.kind !== "system" || !systems) return s;
  const found = systems.find((x) => x.name === s.system);
  return found ? systemScope(found.name, found.projects) : ALL;
}

export function readScope(): Scope {
  try {
    const v = localStorage.getItem(STORAGE);
    if (!v) return ALL;
    if (v === SHARED_KEY) return SHARED;
    return v.startsWith(SYSTEM_PREFIX) ? systemScope(v.slice(SYSTEM_PREFIX.length)) : projectScope(v);
  } catch {
    return ALL;
  }
}

export function writeScope(s: Scope): void {
  try {
    const v = s.kind === "all" ? "" : s.kind === "shared" ? SHARED_KEY : s.kind === "system" ? `${SYSTEM_PREFIX}${s.system}` : s.project;
    localStorage.setItem(STORAGE, v);
  } catch {
    // Storage blocked (private window): the choice lasts for this session only.
  }
}

/** Where a doc key belongs: `org/…` is shared by every project, `project/<p>/…` belongs to p, `system/<s>/…` to sys:s. */
export function docOwner(key: string): string | null {
  const m = /^project\/([^/]+)\//.exec(key);
  if (m) return m[1]!;
  const s = /^system\/([^/]+)\//.exec(key);
  return s ? systemOwner(s[1]!) : null;
}

/** An owner as people read it: the project, "Hệ thống <name>" for a system's (roadmap 19c), `shared` for the team's. */
export function ownerName(owner: string | null, shared: string): string {
  const system = systemOf(owner);
  return system !== null ? translate("docs.systemSpace", { system }) : (owner ?? shared);
}

/** Where new pages of an owner go: `org/`, `project/<p>/` or `system/<s>/` (roadmap 19c). */
export function docPrefix(owner: string | null): string {
  if (owner === null) return "org/";
  const system = systemOf(owner);
  return system === null ? `project/${owner}/` : `system/${system}/`;
}

/** Does an item owned by `owner` (null = shared) show up in this scope? Shared items show in every project and system. */
export function inScope(s: Scope, owner: string | null): boolean {
  if (s.kind === "all") return true;
  if (s.kind === "shared") return owner === null;
  if (s.kind === "system") return owner === null || s.projects.includes(owner) || owner === systemOwner(s.system);
  return owner === null || owner === s.project;
}
