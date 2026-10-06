import type { HiveSystem } from "@xdev-hive/core";
import { fold } from "#ui/lib/text.ts";
import { ALL, outsideSystems, projectScope, scopeId, SHARED, systemScope, type Scope } from "#ui/lib/scope.ts";

export interface PickerGroup {
  kind: "recent" | "system" | "other";
  name?: string;
  items: Scope[];
}

export interface PickerLabels { all: string; shared: string }

/** Build visible choices from permitted projects; a matching system exposes all its permitted children.
 *  `labels` are the shown names of "all" and "shared", so people find them by what they read, not by the kind. */
export function pickerGroups(projects: string[], systems: HiveSystem[], mode: "scope" | "project", query: string, recentIds: string[], includeShared = false, labels: PickerLabels = { all: "all", shared: "shared" }): PickerGroup[] {
  const allowed = new Set(projects);
  const q = fold(query.trim());
  const matches = (name: string) => fold(name).includes(q);
  const name = (item: Scope) => item.kind === "project" ? item.project : item.kind === "system" ? item.system : labels[item.kind];
  const systemChoices = systems.map((system) => ({
    name: system.name,
    projects: system.projects.filter((project) => allowed.has(project)),
  }));
  const choices: Scope[] = [
    ...(mode === "scope" ? [ALL, SHARED] : includeShared ? [SHARED] : []),
    ...(mode === "scope" ? systemChoices.map((system) => systemScope(system.name, system.projects)) : []),
    ...projects.map(projectScope),
  ];
  const byId = new Map(choices.map((item) => [scopeId(item), item]));
  const recent = [...new Set(recentIds)].slice(0, 5).map((id) => byId.get(id)).filter((item): item is Scope => !!item && (!q || matches(name(item))));
  const groups: PickerGroup[] = [];
  if (recent.length) groups.push({ kind: "recent", items: recent });
  if (mode === "scope") {
    const top = [ALL, SHARED].filter((item) => !q || matches(name(item)));
    if (top.length) groups.push({ kind: "other", items: top });
  } else if (includeShared && (!q || matches(labels.shared))) groups.push({ kind: "other", items: [SHARED] });
  const assigned = new Set<string>();
  for (const system of systemChoices) {
    system.projects.forEach((project) => assigned.add(project));
    const systemMatches = matches(system.name);
    const children = system.projects.filter((project) => systemMatches || matches(project)).map(projectScope);
    if ((mode === "scope" && systemMatches) || children.length) {
      groups.push({ kind: "system", name: system.name, items: [...(mode === "scope" && systemMatches ? [systemScope(system.name, system.projects)] : []), ...children] });
    }
  }
  const other = projects.filter((project) => !assigned.has(project) && matches(project)).map(projectScope);
  if (other.length) groups.push({ kind: "other", name: "projects", items: other });
  return groups;
}

/** A root of the scope picker (roadmap 40a): a system, or a repo in no system shown as a system of that one service.
 *  The second is virtual: it is not in the hub's systems, and picking it is that project's scope. */
export interface SystemRoot { name: string; services: string[]; virtual: boolean }

/** The systems with the services the person may see, and a virtual one per repo in no system, by name. */
export function systemTree(projects: string[], systems: HiveSystem[]): SystemRoot[] {
  const allowed = new Set(projects);
  const real = systems.map((system) => ({ name: system.name, services: system.projects.filter((project) => allowed.has(project)), virtual: false }));
  const lone = outsideSystems(projects, systems).map((project) => ({ name: project, services: [project], virtual: true }));
  return [...real, ...lone].sort((a, b) => a.name.localeCompare(b.name) || Number(a.virtual) - Number(b.virtual));
}

/** What picking a root means: a system's scope, or the project's for a virtual one (no new kind of scope). */
export const rootScope = (root: SystemRoot): Scope => root.virtual ? projectScope(root.name) : systemScope(root.name, root.services);

export interface ScopeRow {
  scope: Scope;
  /** What the row reads: a recent service as `system › service`, so it is told apart from the same name elsewhere. */
  label: string;
  section: "recent" | "top" | "systems";
  /** 1: a service inside the system above it. */
  depth: 0 | 1;
  /** The system a systems row is or sits in. */
  root?: SystemRoot;
  /** Its own name matched the search: the keyboard starts on the first such row, not on the system around it. */
  match: boolean;
}

/** The scope picker's rows: recent, then all and shared, then the systems. A system's services show when it is in
 *  `expanded`, or, while searching, when the system's name matches (all of them) or theirs do (only those). */
export function scopeRows(projects: string[], systems: HiveSystem[], query: string, recentIds: string[], expanded: ReadonlySet<string>, labels: PickerLabels = { all: "all", shared: "shared" }): ScopeRow[] {
  const q = fold(query.trim());
  const matches = (name: string) => !!q && fold(name).includes(q);
  const roots = systemTree(projects, systems);
  const titled = (project: string) => {
    const system = roots.find((root) => !root.virtual && root.services.includes(project));
    return system ? `${system.name} › ${project}` : project;
  };
  const named = (item: Scope) => item.kind === "project" ? titled(item.project) : item.kind === "system" ? item.system : labels[item.kind];
  // All and shared are always at the top: as recent too they would show twice.
  const byId = new Map<string, Scope>([...roots.map(rootScope), ...projects.map(projectScope)].map((item) => [scopeId(item), item]));
  const rows: ScopeRow[] = [];
  for (const id of [...new Set(recentIds)].slice(0, 5)) {
    const item = byId.get(id);
    if (item && (!q || matches(named(item)))) rows.push({ scope: item, label: named(item), section: "recent", depth: 0, match: !!q });
  }
  for (const item of [ALL, SHARED]) if (!q || matches(labels[item.kind as "all" | "shared"])) rows.push({ scope: item, label: named(item), section: "top", depth: 0, match: !!q });
  for (const root of roots) {
    const own = matches(root.name);
    const services = root.virtual ? [] : !q ? (expanded.has(root.name) ? root.services : []) : own ? root.services : root.services.filter(matches);
    if (q && !own && !services.length) continue;
    rows.push({ scope: rootScope(root), label: root.name, section: "systems", depth: 0, root, match: own });
    for (const service of services) rows.push({ scope: projectScope(service), label: service, section: "systems", depth: 1, root, match: matches(service) });
  }
  return rows;
}

const STORAGE = "xdev-hive.project-picker.recent";
let sessionRecent: string[] = [];
export function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    sessionRecent = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 5) : [];
  } catch { /* Keep recent choices for this tab when browser storage is blocked. */ }
  return sessionRecent;
}

export function rememberRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((previous) => previous !== id)].slice(0, 5);
  sessionRecent = next;
  try { localStorage.setItem(STORAGE, JSON.stringify(next)); } catch { /* The selection still works when browser storage is blocked. */ }
  return next;
}
