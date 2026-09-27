// What the whole app is looking at: every project, only the team-wide (shared) data, or one project.
// Chosen once in the sidebar; every page filters by it and new items default to it.
import { translate } from "../i18n/translate.ts";

export type Scope = { kind: "all" } | { kind: "shared" } | { kind: "project"; project: string };

export const ALL: Scope = { kind: "all" };
export const SHARED: Scope = { kind: "shared" };
export const projectScope = (project: string): Scope => ({ kind: "project", project });

const STORAGE = "xdev-hive.scope";
const SHARED_KEY = "@shared";

export function scopeLabel(s: Scope): string {
  return s.kind === "all" ? translate("common.allProjects") : s.kind === "shared" ? translate("common.sharedTeam") : s.project;
}

/** The project of a scope, or null for all / shared. */
export const scopeProject = (s: Scope): string | null => (s.kind === "project" ? s.project : null);

export function sameScope(a: Scope, b: Scope): boolean {
  return a.kind === b.kind && scopeProject(a) === scopeProject(b);
}

export function readScope(): Scope {
  try {
    const v = localStorage.getItem(STORAGE);
    return !v ? ALL : v === SHARED_KEY ? SHARED : projectScope(v);
  } catch {
    return ALL;
  }
}

export function writeScope(s: Scope): void {
  try {
    localStorage.setItem(STORAGE, s.kind === "all" ? "" : s.kind === "shared" ? SHARED_KEY : s.project);
  } catch {
    // Storage blocked (private window): the choice lasts for this session only.
  }
}

/** Where a doc key belongs: `org/…` is shared by every project, `project/<p>/…` belongs to p. */
export function docOwner(key: string): string | null {
  const m = /^project\/([^/]+)\//.exec(key);
  return m ? m[1]! : null;
}

/** Does an item owned by `owner` (null = shared) show up in this scope? Shared items show in every project. */
export function inScope(s: Scope, owner: string | null): boolean {
  if (s.kind === "all") return true;
  if (s.kind === "shared") return owner === null;
  return owner === null || owner === s.project;
}
