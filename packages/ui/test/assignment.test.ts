import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Machine, ReportedProfile, RunRequest, Task } from "@xdev-hive/core";
import { agentKey, agentLabel, agentLanes, agentStatus, agentTasks, assignableMachines, assignmentInput, assignInOrder, filterAgent } from "#ui/lib/assignment.ts";
import { buildInbox } from "#ui/lib/inbox.ts";
import { requestErrorText } from "#ui/lib/runs.ts";
import { setActiveLocale } from "#ui/i18n/translate.ts";

const target = { machineId: "runner.mac", profileId: "claude-1" };
const task = (id: string, order: number, assigned = true): Task => ({ id, project: "app", title: id, status: "todo", owner: null, leaseUntil: null, note: null, updatedAt: "2026-10-06", dependsOn: [], waitingOn: [], agent: assigned ? { ...target, machine: "Mac", order, by: "lan", at: "2026-10-06", hold: null } : null });
const machine = (over: Partial<Machine> = {}): Machine => ({ id: "runner.mac", machine: "Mac", online: false, acceptsRuns: true, projects: ["app"], profiles: [{ id: "claude-1", enabled: true }], ...over }) as Machine;

describe("agent assignment UI model", () => {
  it("allows an offline machine to queue work, requiring every selected project's repo and hub acceptance", () => {
    const m = machine();
    assert.deepEqual(assignableMachines([m], ["app"]), [m]);
    assert.deepEqual(assignableMachines([m], ["app", "other"]), []);
    assert.deepEqual(assignableMachines([machine({ acceptsRuns: false })], ["app"]), []);
  });
  it("tells each choice of the agent box apart: free or not, its worst quota, and what is already queued for it", () => {
    const plan = (id: string, over: Partial<ReportedProfile> = {}): ReportedProfile =>
      ({ id, label: id, enabled: true, maxConcurrent: 1, sessionPercent: null, weekPercent: null, ...over }) as ReportedProfile;
    const busy = machine({
      online: true,
      profiles: [plan("claude-1", { sessionPercent: 23.6, weekPercent: 12 }), plan("claude-2", { maxConcurrent: 2, sessionPercent: 70 }), plan("codex-1", { enabled: false, sessionPercent: 99 })],
      runs: [{ profileId: "claude-1", status: "running" }],
    } as Partial<Machine>);
    // Unpinned: the hub may put it on any plan, so it takes a place from each of them.
    const src = { tasks: [task("A", 1), task("B", 2), { ...task("C", 3), status: "done" as const }], requests: [{ machineId: "runner.mac", status: "pending", profileId: null }] as RunRequest[] };
    const pinned = busy.profiles[0]!;
    assert.deepEqual(agentStatus(busy, pinned, src), { state: "busy", session: "24%", week: "12%", queued: 2 });
    // Two places, one run and one request: still room for a third.
    assert.equal(agentStatus(busy, busy.profiles[1]!, src).state, "free");
    assert.equal(agentStatus(busy, busy.profiles[1]!, src).queued, 0);
    // "Gói nào cũng được" adds up the enabled plans only, and shows the worst number any of them reports.
    assert.deepEqual(agentStatus(busy, null, src), { state: "free", session: "70%", week: "12%", queued: 2 });
    assert.equal(agentStatus(machine({ ...busy, online: false } as Partial<Machine>), null, src).state, "offline");
    assert.equal(agentStatus(machine({ online: true, profiles: [plan("x")], runs: [] } as Partial<Machine>), null, { tasks: [], requests: [] }).session, "—");
  });
  it("filters unassigned and exact machine/profile, including rotating assignments", () => {
    const a = task("A", 2), b = task("B", 1), c = task("C", 0, false);
    b.agent!.profileId = null;
    assert.deepEqual(filterAgent([a,b,c], ""), [a,b,c]);
    assert.deepEqual(filterAgent([a,b,c], "unassigned"), [c]);
    assert.deepEqual(filterAgent([a,b,c], agentKey(target)), [a]);
    assert.equal(agentLabel(b.agent, "Any"), "Any · Mac");
  });
  it("orders a lane by hub order without mutating the source and retains removed agents", () => {
    const a = task("A", 7), b = task("B", 2);
    assert.deepEqual(agentTasks([a,b], agentKey(target)).map((t) => t.id), ["B", "A"]);
    const lanes = agentLanes([], [a,b], "Any", "Unassigned");
    assert.deepEqual(lanes.map((l) => l.key), ["unassigned", agentKey(target)]);
    assert.equal(agentLanes([machine()], [a], "Any", "Unassigned").length, 3);
  });
  it("uses before for both drop-on-card and keyboard reorder; cross-lane append omits before", () => {
    assert.deepEqual(assignmentInput("B", target, "A"), { id: "B", ...target, before: "A" });
    assert.deepEqual(assignmentInput("B", target), { id: "B", ...target });
    assert.deepEqual(assignmentInput("B", target, "B"), { id: "B", ...target });
  });
  it("assigns batches in click order and repairs preserved positions for existing assignments", async () => {
    const a = task("A", 7), b = task("B", 2), c = task("C", 1);
    const all = [a, b, c];
    const calls: string[] = [];
    await assignInOrder(all, target, undefined, async (input) => {
      calls.push(`${input.id}:${input.before ?? ""}`);
      const current = all.find((t) => t.id === input.id)!;
      if (input.before) current.agent!.order = all.find((t) => t.id === input.before)!.agent!.order - 0.25;
      return structuredClone(current);
    });
    assert.deepEqual(calls, ["A:", "B:", "C:", "B:C", "A:B"]);
    assert.deepEqual(agentTasks(all, agentKey(target)).map((t) => t.id), ["A", "B", "C"]);
  });
  it("shows structured hold errors and routes paused tasks to dispatchers or their assigner", () => {
    const a = task("A", 1);
    a.agent!.hold = { key: "errors.agentBusy", vars: { machine: "Mac" }, message: "busy" };
    setActiveLocale("vi");
    assert.match(requestErrorText(a.agent!.hold), /Mac/);
    assert.equal(buildInbox({ assignedTasks: [a], can: () => false, principal: "other" }).length, 0);
    assert.equal(buildInbox({ assignedTasks: [a], can: () => false, principal: "lan" })[0]?.kind, "agentHold");
    assert.equal(buildInbox({ assignedTasks: [a], can: (_, p) => p === "runDispatch" })[0]?.kind, "agentHold");
    a.agent!.hold = null;
    assert.equal(buildInbox({ assignedTasks: [a] }).length, 0);
  });
});
