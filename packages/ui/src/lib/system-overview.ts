import type { Proposal, Task } from "@xdev-hive/core";
import { docOwner } from "#ui/lib/scope.ts";
import type { SystemRoot } from "#ui/lib/project-picker.ts";

type Work = Pick<Task, "project" | "status">;
type Run = { project: string; status: string };

/** A shared service contributes to each of its systems, but only once within each card. Shared docs belong to neither. */
export function systemSummary(root: SystemRoot, tasks: Work[], runs: Run[], proposals: Pick<Proposal, "docKey" | "status">[]) {
  const count = (services: Set<string>, owner?: string) => ({
    open: tasks.filter((t) => services.has(t.project) && t.status !== "done").length,
    running: runs.filter((r) => services.has(r.project) && r.status === "running").length,
    pending: tasks.filter((t) => services.has(t.project) && t.status === "review").length
      + proposals.filter((p) => { const o = docOwner(p.docKey); return p.status === "pending" && o !== null && (services.has(o) || o === owner); }).length,
  });
  return {
    ...count(new Set(root.services), root.virtual ? undefined : `sys:${root.name}`),
    services: [...new Set(root.services)].map((project) => ({ project, ...count(new Set([project])) })),
  };
}
