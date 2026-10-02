import type { HiveSystem } from "@xdev-hive/core";
import { fold } from "#ui/lib/text.ts";
import { ALL, projectScope, scopeId, SHARED, systemScope, type Scope } from "#ui/lib/scope.ts";

export interface PickerGroup {
  kind: "recent" | "system" | "other";
  name?: string;
  items: Scope[];
}

/** Build visible choices from permitted projects; a matching system exposes all its permitted children. */
export function pickerGroups(projects: string[], systems: HiveSystem[], mode: "scope" | "project", query: string, recentIds: string[], includeShared = false): PickerGroup[] {
  const allowed = new Set(projects);
  const q = fold(query.trim());
  const matches = (name: string) => fold(name).includes(q);
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
  const recent = [...new Set(recentIds)].slice(0, 5).map((id) => byId.get(id)).filter((item): item is Scope => !!item && (!q || matches(item.kind === "project" ? item.project : item.kind === "system" ? item.system : item.kind)));
  const groups: PickerGroup[] = [];
  if (recent.length) groups.push({ kind: "recent", items: recent });
  if (mode === "scope") {
    const top = [ALL, SHARED].filter((item) => !q || matches(item.kind));
    if (top.length) groups.push({ kind: "other", items: top });
  } else if (includeShared && (!q || matches("shared"))) groups.push({ kind: "other", items: [SHARED] });
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
