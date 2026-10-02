// Small helpers of the Tasks page.
import type { Task, TaskStatus } from "@xdev-hive/core";

/**
 * Who holds a task, split for display: an agent's lease is `<profile>.<machine>`, and a hub appends `@<token>`
 * (`codex-1.duy-mbp@duy-mbp` → codex-1 on duy-mbp). A person's name has no machine.
 */
export function ownerLabel(owner: string): { who: string; machine: string | null } {
  const base = owner.split("@")[0]!;
  const dot = base.indexOf(".");
  return dot > 0 && dot < base.length - 1 ? { who: base.slice(0, dot), machine: base.slice(dot + 1) } : { who: base, machine: null };
}

/**
 * The next id for a project: the prefix most of its tasks use (T-, AUTH-…) and one past the highest number, padded
 * like the existing ones. A project without numbered tasks starts at T-001.
 */
export function nextTaskId(tasks: Pick<Task, "id">[]): string {
  const counts = new Map<string, { n: number; max: number; width: number }>();
  for (const { id } of tasks) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (!m) continue;
    const [, prefix, digits] = m as unknown as [string, string, string];
    const c = counts.get(prefix) ?? { n: 0, max: 0, width: 0 };
    counts.set(prefix, { n: c.n + 1, max: Math.max(c.max, Number(digits)), width: Math.max(c.width, digits.length) });
  }
  const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].max - a[1].max)[0];
  if (!best) return "T-001";
  const [prefix, { max, width }] = best;
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

/** A task it depends on as the board names it: another service's with its project in front (roadmap 19d). */
export const depLabel = (task: Pick<Task, "depProjects">, id: string): string => (task.depProjects?.[id] ? `${task.depProjects[id]}/${id}` : id);

/** What a task still waits for, named, plus how many in projects the reader cannot see ("+2"). */
export function waitingLabels(task: Pick<Task, "waitingOn" | "depProjects" | "waitingHidden">): string[] {
  const named = (task.waitingOn ?? []).map((id) => depLabel(task, id));
  return task.waitingHidden ? [...named, `+${task.waitingHidden}`] : named;
}

/** A task waiting on others shows as blocked until they are done; it is still "to do" underneath. */
export const columnOf = (task: Pick<Task, "status" | "waitingOn" | "waitingHidden">): TaskStatus =>
  task.status === "todo" && (task.waitingOn?.length || task.waitingHidden) ? "blocked" : task.status;
