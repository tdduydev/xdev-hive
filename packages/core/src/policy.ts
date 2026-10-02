// Team policy: which setup items every machine should have. Browser-safe (web portal and desktop use it).
import { toolSetupItems } from "./tools.ts";
import type { SetupItem, SetupReport, TeamPolicy, ToolEntry } from "./types.ts";

export const EMPTY_POLICY: TeamPolicy = {
  requiredClis: [],
  requireShim: false,
  projects: {},
  profileTemplates: [],
  selfApproval: "admins",
  updatedAt: null,
  updatedBy: null,
};

/**
 * A catalog tool as far as required items go (roadmap 28b-2): tools.list's ToolView is one, so the web passes the
 * catalog as it reads it; the desktop builds it from its heartbeat's.
 */
export interface RequiredTool extends Pick<ToolEntry, "id" | "handler"> {
  projects: ReadonlyArray<{ project: string; required: boolean }>;
}

/**
 * The setup items a tool a project requires stands for. Not codegraph's index: a run builds it in its own worktree
 * (prepare), so the main checkout's index is a convenience, not what the project asked for.
 */
const requiredToolItems = (tool: RequiredTool, project: string) => toolSetupItems(tool, project).filter((id) => id !== `${project}:codegraph-index`);

/** SetupItem ids the policy, and the tools the catalog marks required, require on a machine that has these projects. */
export function requiredItemIds(policy: TeamPolicy, projects: string[], tools: readonly RequiredTool[] = []): Set<string> {
  const ids = new Set<string>(policy.requiredClis.map((kind) => `cli:${kind}`));
  if (policy.requireShim) ids.add("shim");
  for (const project of projects) {
    for (const part of policy.projects[project] ?? []) ids.add(`${project}:${part}`);
    for (const tool of tools) {
      if (tool.projects.some((p) => p.project === project && p.required)) for (const id of requiredToolItems(tool, project)) ids.add(id);
    }
  }
  return ids;
}

/** Required items that are not installed. */
export function missingRequired(policy: TeamPolicy, report: SetupReport, tools: readonly RequiredTool[] = []): SetupItem[] {
  const required = requiredItemIds(policy, report.projects.map((p) => p.project), tools);
  const items = [...report.machine, ...report.projects.flatMap((p) => p.items)];
  return items.filter((i) => required.has(i.id) && i.state !== "installed");
}
