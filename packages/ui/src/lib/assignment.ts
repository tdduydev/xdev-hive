import type { Machine, ReportedProfile, RunRequest, Task } from "@xdev-hive/core";

export type AssignmentTarget = { machineId: string; profileId: string | null };
export const agentKey = (a: AssignmentTarget | null): string => a ? JSON.stringify([a.machineId, a.profileId]) : "unassigned";
export const agentLabel = (a: Task["agent"], any: string): string => a ? `${a.profileId ?? any} · ${a.machine}` : "";
export const assignableMachines = (machines: Machine[], projects: string[]) => machines.filter((m) => m.acceptsRuns && projects.every((p) => m.projects.includes(p)));
export const agentTasks = (tasks: Task[], key: string) => tasks.filter((task) => agentKey(task.agent) === key).sort((a, b) => (a.agent?.order ?? 0) - (b.agent?.order ?? 0));
export const filterAgent = (tasks: Task[], key: string) => key ? tasks.filter((task) => agentKey(task.agent) === key) : tasks;
export const assignmentInput = (id: string, target: AssignmentTarget, before?: string) => ({ id, ...target, ...(before && before !== id ? { before } : {}) });

/** Include removed agents so their tasks can still be found and reassigned. */
export function agentLanes(machines: Machine[], tasks: Task[], any: string, unassigned: string) {
  const lanes = new Map<string, { key: string; label: string; target: AssignmentTarget | null }>();
  lanes.set("unassigned", { key: "unassigned", label: unassigned, target: null });
  for (const m of machines) {
    for (const profileId of [null, ...m.profiles.filter((p) => p.enabled).map((p) => p.id)]) {
      const target = { machineId: m.id, profileId };
      const key = agentKey(target);
      lanes.set(key, { key, label: `${profileId ?? any} · ${m.machine}`, target });
    }
  }
  for (const task of tasks) if (task.agent && !lanes.has(agentKey(task.agent))) {
    const target = { machineId: task.agent.machineId, profileId: task.agent.profileId };
    const key = agentKey(target);
    lanes.set(key, { key, label: agentLabel(task.agent, any), target });
  }
  return [...lanes.values()];
}

/** What one choice of the picker says about itself, so a person sees the wait before they pick it. */
export interface AgentStatus {
  state: "offline" | "busy" | "free";
  /** The worst of the profiles in play, as text; "—" when none of them reports a number. */
  session: string;
  week: string;
  queued: number;
}

/**
 * The same places `#freeMachine` counts, from what the web already holds: the machine's own runs plus the requests
 * nobody has taken. `profile` null is *Gói nào cũng được*, which may land on any enabled profile of the machine.
 */
export function agentStatus(machine: Machine, profile: ReportedProfile | null, src: { tasks: Task[]; requests: RunRequest[] }): AgentStatus {
  const profiles = profile ? [profile] : machine.profiles.filter((p) => p.enabled);
  const running = machine.runs.filter((r) => r.status === "running" && (!profile || r.profileId === profile.id)).length;
  // An unpinned request can still come down on this profile, so it takes a place from every one of them.
  const pending = src.requests.filter((r) => r.machineId === machine.id && r.status === "pending" && (!profile || !r.profileId || r.profileId === profile.id)).length;
  const places = profiles.reduce((n, p) => n + (p.maxConcurrent ?? 1), 0);
  const pct = (key: "sessionPercent" | "weekPercent") => {
    const values = profiles.map((p) => p[key]).filter((v): v is number => v != null);
    return values.length ? `${Math.round(Math.max(...values))}%` : "—";
  };
  return {
    state: !machine.online ? "offline" : running + pending >= places ? "busy" : "free",
    session: pct("sessionPercent"),
    week: pct("weekPercent"),
    // A done task keeps its agent for the record; it is not waiting for anybody.
    queued: src.tasks.filter((t) => t.status !== "done" && t.agent?.machineId === machine.id && (!profile || t.agent.profileId === profile.id)).length,
  };
}

/** Preserve click order even for tasks already on this machine: the hub keeps their old order without `before`. */
export async function assignInOrder(
  tasks: Task[], target: AssignmentTarget, before: string | undefined,
  assign: (input: ReturnType<typeof assignmentInput>) => Promise<Task>,
): Promise<void> {
  const assigned: Task[] = [];
  for (const task of tasks) assigned.push(await assign(assignmentInput(task.id, target, before)));
  for (let i = assigned.length - 2; i >= 0; i--) {
    if (assigned[i]!.agent!.order >= assigned[i + 1]!.agent!.order) {
      assigned[i] = await assign(assignmentInput(assigned[i]!.id, target, assigned[i + 1]!.id));
    }
  }
}
