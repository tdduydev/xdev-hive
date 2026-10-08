import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Machine, Task } from "@xdev-hive/core";
import { buildBlockers, holdKind } from "#ui/lib/blockers.ts";
const task = (over: Partial<Task> = {}): Task => ({ id: "T-1", project: "demo", title: "Work", status: "todo", waitingOn: [], dependsOn: [], agent: null, ...over }) as Task;
describe("blocker centre", () => {
  it("keeps simultaneous causes and hidden dependency counts without exposing IDs", () => {
    const t = task({ waitingHidden: 1, agent: { machineId: "m", machine: "Mac", hold: { key: "audit.policy", message: "Restricted" } } as Task["agent"] });
    const rows = buildBlockers([t], [{ id: "m", online: false } as Machine], []);
    assert.deepEqual(rows.map(r => r.kind), ["dependency", "policy", "offline"]);
    assert.equal(rows[0]!.detail, "");
    assert.equal(rows[0]!.permission, "taskWork");
  });
  it("does not infer diagnoses from arbitrary notes or unknown machines", () => {
    const rows = buildBlockers([task({ status: "blocked", note: "quota conflict", agent: { machineId: "missing", hold: null } as Task["agent"] })], [], []);
    assert.deepEqual(rows.map(r => r.kind), ["unknown"]);
    assert.equal(holdKind("errors.budgetExceeded"), "quota");
  });
  it("keeps project identities distinct and excludes completed work", () => {
    assert.equal(buildBlockers([task({ status: "done", waitingOn: ["D"] })], [], []).length, 0);
    const rows = buildBlockers([task({ status: "review" }), task({ status: "review", project: "pay" })], [], []);
    assert.equal(new Set(rows.map(r => r.key)).size, 2);
    assert.ok(rows.every(r => r.permission === "codeReview"));
  });
  it("uses queue reasons, deduplicates holds and excludes tasks outside the visible scope", () => {
    const t = task({ agent: { hold: { key: "quota.limit", message: "Hold" } } as Task["agent"] });
    const rows = buildBlockers([t], [], [], [{ task: t, waiting: { key: "quota.limit", message: "Hold" } }, { task: task({ project: "secret" }), waiting: { key: "audit.policy", message: "Private" } }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "quota");
  });
});
