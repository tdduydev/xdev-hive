// Team policy: which setup items every machine should have. Browser-safe (web portal and desktop use it).
import type { SetupItem, SetupReport, TeamPolicy } from "./types.ts";

export const EMPTY_POLICY: TeamPolicy = {
  requiredClis: [],
  requireShim: false,
  projects: {},
  profileTemplates: [],
  updatedAt: null,
  updatedBy: null,
};

/** SetupItem ids the policy requires on a machine that has these projects. */
export function requiredItemIds(policy: TeamPolicy, projects: string[]): Set<string> {
  const ids = new Set<string>(policy.requiredClis.map((kind) => `cli:${kind}`));
  if (policy.requireShim) ids.add("shim");
  for (const project of projects) for (const part of policy.projects[project] ?? []) ids.add(`${project}:${part}`);
  return ids;
}

/** Required items that are not installed, plus required CLIs the report does not mention at all. */
export function missingRequired(policy: TeamPolicy, report: SetupReport): SetupItem[] {
  const required = requiredItemIds(policy, report.projects.map((p) => p.project));
  const items = [...report.machine, ...report.projects.flatMap((p) => p.items)];
  return items.filter((i) => required.has(i.id) && i.state !== "installed");
}
