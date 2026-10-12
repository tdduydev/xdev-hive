import { useQuery } from "@tanstack/react-query";
import type { ScopeView } from "@xdev-hive/contracts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";

export function useKnowledgeAccess() {
  const { api, org } = useOrg();
  const me = useMe();
  const members = useQuery({ ...api.orgMembers.list.queryOptions(), enabled: !isOrgAdmin(org.role) });
  const teams = useQuery(api.teams.list.queryOptions());
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const memberships = members.data?.find((member) => member.userId === me.id)?.teams ?? [];
  function allowed(scope: ScopeView, action: "write" | "manage") {
    if (isOrgAdmin(org.role)) return true;
    if (scope.level === "org") return false;
    const teamId = scope.teamId ?? projects.data?.find((project) => project.id === scope.projectId)?.teamId;
    const role = memberships.find((team) => team.teamId === teamId)?.role;
    return action === "manage" ? role === "admin" : role === "admin" || role === "member";
  }
  const scopes: { value: string; label: string; scope: ScopeView }[] = [
    { value: "org", label: org.name, scope: { level: "org", teamId: null, projectId: null } },
    ...(teams.data ?? []).map((team) => ({
      value: `team:${team.id}`,
      label: team.name,
      scope: { level: "team" as const, teamId: team.id, projectId: null },
    })),
    ...(projects.data ?? []).map((project) => ({
      value: `project:${project.id}`,
      label: project.name,
      scope: { level: "project" as const, teamId: project.teamId, projectId: project.id },
    })),
  ];
  return { allowed, scopes: scopes.filter((item) => allowed(item.scope, "write")) };
}

/** Linear-space line diff avoids allocating a matrix for documents up to 200,000 characters. */
export function contentDiff(before: string, after: string): { kind: "same" | "removed" | "added"; content: string }[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  return [
    ...oldLines.slice(0, prefix).map((content) => ({ kind: "same" as const, content })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((content) => ({ kind: "removed" as const, content })),
    ...newLines.slice(prefix, newLines.length - suffix).map((content) => ({ kind: "added" as const, content })),
    ...oldLines.slice(oldLines.length - suffix).map((content) => ({ kind: "same" as const, content })),
  ];
}
