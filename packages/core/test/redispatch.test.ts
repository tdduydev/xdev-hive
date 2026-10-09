import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SqliteHive, migrationIndex } from "#core/node.ts";
import { HiveError, type Actor, type MethodInput } from "#core/index.ts";

const admin: Actor = { name: "admin", role: "admin" };
const first: Actor = { name: "runner@one", role: "agent" };
const second: Actor = { name: "runner@two", role: "agent" };
const lead: Actor = { name: "lead", role: "member", access: { projects: { app: "manage" } } };
const reader: Actor = { name: "reader", role: "member", access: { projects: { app: "view" } } };
const sha = "a".repeat(40);
const at = "2026-10-07T01:00:00.000Z";
const profile = { id: "codex", label: "Codex", kind: "codex", enabled: true, installed: true, planApproval: true, redispatch: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };
type PushRun = MethodInput<"runs.push">["runs"][number];
const record = (over: Partial<PushRun> = {}): PushRun => ({ runId: "R-old", project: "app", taskId: "T-1", taskTitle: "Work", role: "implement", profileId: "codex", status: "failed", branch: "ai/T-1", baseSha: sha, instructions: "Keep the old URL.", createdAt: at, startedAt: at, finishedAt: at, ...over });
async function setup() {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { project: "app", id: "T-1", title: "Work", kind: "feature" }, admin);
  const beat = (actor: Actor, over: Record<string, unknown> = {}) => hive.call("machines.heartbeat", { machine: actor.name.split("@")[1]!, instance: "abcdef01", projects: ["app"], acceptsRuns: true, profiles: [profile], ...over }, actor);
  await beat(first); await beat(second);
  const push = (actor: Actor, over: Partial<PushRun> = {}) => hive.call("runs.push", { machine: actor.name.split("@")[1]!, runs: [record(over)] }, actor);
  const dispatch = (over: Record<string, unknown> = {}, actor: Actor = lead) => hive.call("runs.dispatch", { machineId: second.name, project: "app", taskId: "T-1", profileId: "codex", instructions: "Keep the old URL.", redispatch: { machineId: first.name, runId: "R-old", continueBranch: true }, ...over }, actor);
  return { hive, beat, push, dispatch };
}
const key = async (call: Promise<unknown>, expected: string) => assert.rejects(call, (err: unknown) => err instanceof HiveError && err.key === expected);

describe("run redispatch", () => {
  it("appends its migration, preserving old records and requests", async t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-redispatch-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hive.db");
    const before = new SqliteHive(file);
    await before.call("tasks.create", { project: "app", id: "T-1", title: "Work" }, admin);
    await before.call("machines.heartbeat", { machine: "one", instance: "abcdef01", projects: ["app"], acceptsRuns: true, profiles: [profile] }, first);
    const request = await before.call("runs.dispatch", { project: "app", taskId: "T-1", machineId: first.name, instructions: "Old instructions", timeoutMinutes: 20 }, admin);
    await before.call("runs.requestResult", { id: request.id, status: "accepted", runId: "R-old" }, first);
    await before.call("runs.push", { machine: "one", runs: [record()] }, first);
    for (const [table, column] of [["run_requests", "redispatch"], ["run_records", "parent_machine_id"], ["run_records", "instructions"], ["run_records", "base_sha"]]) before.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    const index = migrationIndex("ALTER TABLE run_requests ADD COLUMN redispatch");
    before.db.exec(`PRAGMA user_version = ${index}`);
    before.close();
    const after = new SqliteHive(file, { migrateTo: index + 1 });
    t.after(() => after.close());
    assert.equal(after.db.prepare("PRAGMA user_version").get()?.user_version, index + 1);
    assert.equal((await after.call("runs.get", { machineId: first.name, runId: "R-old" }, admin))?.instructions, "Old instructions");
    assert.equal((await after.call("runs.requests", {}, admin))[0]?.redispatch, null);
    assert.equal((await after.call("runs.requests", {}, admin))[0]?.timeoutMinutes, 20);
  });

  it("accepts failed, timed out, cancelled and quota-limited sources; sends branch and base to a new machine", async t => {
    for (const status of ["failed", "cancelled", "rate_limited"] as const) {
      const { hive, push, dispatch, beat } = await setup(); t.after(() => hive.close());
      await push(first, { status, error: status === "failed" ? "Timed out" : null });
      const request = await dispatch();
      assert.deepEqual(request.redispatch, { machineId: first.name, runId: "R-old", continueBranch: true, branch: "ai/T-1", baseSha: sha });
      assert.equal(request.profileId, "codex");
      assert.equal((await beat(second)).runRequests[0]?.redispatch?.runId, "R-old");
      assert.deepEqual((await beat(first)).runRequests, []);
    }
  });

  it("links same-numbered runs across machines, regardless of push/result order, and survives retention and old pushes", async t => {
    const { hive, push, dispatch } = await setup(); t.after(() => hive.close());
    await push(first);
    const request = await dispatch();
    await push(second, { instructions: undefined, parentRun: null, status: "queued" });
    await hive.call("runs.requestResult", { id: request.id, status: "accepted", runId: "R-old" }, second);
    const get = () => hive.call("runs.get", { machineId: second.name, runId: "R-old" }, admin);
    assert.equal((await get())?.parentMachineId, first.name);
    hive.db.prepare("DELETE FROM run_requests WHERE id = ?").run(request.id);
    await push(second, { instructions: undefined, parentRun: null, status: "failed" });
    assert.equal((await get())?.parentRun, "R-old");
    assert.equal((await get())?.parentMachineId, first.name);
    assert.equal((await get())?.instructions, "Keep the old URL.");
    const next = await dispatch({ redispatch: { machineId: second.name, runId: "R-old", continueBranch: false } });
    await hive.call("runs.requestResult", { id: next.id, status: "accepted", runId: "R-next" }, second);
    await push(second, { runId: "R-next", parentRun: null });
    assert.equal((await hive.call("runs.get", { machineId: second.name, runId: "R-next" }, admin))?.parentRun, "R-old");
    assert.equal((await hive.call("runs.list", { project: "app", taskId: "T-1" }, lead)).length, 3);
    assert.equal((await hive.call("runs.list", { project: "app", taskId: "missing" }, lead)).length, 0);
  });

  it("uses a fresh branch without needing an existing source branch", async t => {
    const { hive, push, dispatch } = await setup(); t.after(() => hive.close());
    await push(first, { branch: null, baseSha: null });
    await key(dispatch(), "errors.redispatchBranch");
    const request = await dispatch({ redispatch: { machineId: first.name, runId: "R-old", continueBranch: false } });
    assert.deepEqual([request.redispatch?.branch, request.redispatch?.baseSha], [null, null]);
  });

  it("checks status, identity, permissions and dispatch constraints before creating a request", async t => {
    const { hive, push, dispatch, beat } = await setup(); t.after(() => hive.close());
    for (const status of ["queued", "running", "succeeded"] as const) { await push(first, { status }); await key(dispatch(), "errors.redispatchState"); }
    await push(first);
    await key(dispatch({}, reader), "errors.need.runDispatch");
    await key(dispatch({ taskId: "unknown" }), "errors.taskNotInProject");
    await hive.call("tasks.create", { project: "app", id: "T-other", title: "Other" }, admin);
    await key(dispatch({ taskId: "T-other" }), "errors.runNotFound");
    await key(dispatch({ candidates: 2 }), "errors.redispatchOne");
    await key(dispatch({ timeoutMinutes: 61 }), "errors.runTimeoutCeiling");
    await beat(second, { runs: [{ runId: "R-active", taskTitle: "Work", since: at, project: "app", taskId: "T-1", role: "implement", profileId: "codex", status: "running" }] });
    await key(dispatch(), "errors.taskRunning");
    await beat(second, { runs: [] });
    assert.equal((await hive.call("runs.requests", {}, admin)).length, 0);
    const request = await dispatch();
    await key(dispatch(), "errors.runRequestOpen");
    await hive.call("runs.cancelRequest", { id: request.id }, admin);
  });

  it("refuses old runners before queueing work", async t => {
    const { hive, push, dispatch, beat } = await setup(); t.after(() => hive.close());
    await push(first);
    await beat(second, { profiles: [{ ...profile, redispatch: undefined }] });
    await key(dispatch(), "errors.redispatchRunnerRequired");
    assert.equal((await hive.call("runs.requests", {}, admin)).length, 0);
  });

  it("keeps source and branch choice while waiting for a classifier", async t => {
    const { hive, push, beat } = await setup(); t.after(() => hive.close());
    await hive.call("tasks.create", { project: "app", id: "T-new", title: "Build account flow" }, admin);
    await beat(second, { profiles: [{ ...profile, classify: true }] });
    await push(first, { taskId: "T-new" });
    const classification = await hive.call("runs.dispatch", { project: "app", taskId: "T-new", machineId: second.name, timeoutMinutes: 25, redispatch: { machineId: first.name, runId: "R-old", continueBranch: true } }, lead);
    assert.equal(classification.role, "classify");
    await hive.call("runs.requestResult", { id: classification.id, status: "accepted", runId: "C-new" }, second);
    await push(second, { taskId: "T-new", runId: "C-new", role: "classify", status: "succeeded", summary: JSON.stringify({ kind: "feature", size: "s", risk: "normal", reason: "test" }) });
    const request = (await hive.call("runs.requests", {}, admin)).find(r => r.taskId === "T-new" && r.role === "implement")!;
    assert.equal(request.redispatch?.runId, "R-old");
    assert.equal(request.redispatch?.branch, "ai/T-1");
    assert.equal(request.timeoutMinutes, 25);
  });

  it("retains redispatch when plan approval copies the request into implementation", async t => {
    const { hive, push, dispatch } = await setup(); t.after(() => hive.close());
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, planApproval: { mode: "all", timeoutMinutes: null } } }, admin);
    await push(first);
    const request = await dispatch({ timeoutMinutes: 30 });
    assert.equal(request.plan?.phase, "plan");
    await hive.call("runs.requestResult", { id: request.id, status: "accepted", runId: "R-plan" }, second);
    await push(second, { runId: "R-plan", status: "succeeded", planText: "Approved plan" });
    await hive.call("runs.decidePlan", { id: request.plan!.id, decision: "approve", revision: 1 }, admin);
    const next = (await hive.call("runs.requests", {}, admin))[0]!;
    assert.equal(next.plan?.phase, "implement");
    assert.deepEqual(next.redispatch, request.redispatch);
    assert.equal(next.timeoutMinutes, 30);
  });
});

describe("remote run state", () => {
  it("round-trips push metadata, preserves it from old clients and sends the hub SHA on redispatch", async t => {
    const { hive, push, dispatch } = await setup(); t.after(() => hive.close());
    const head = "b".repeat(40);
    await push(first, { startSha: sha, headSha: head, remoteSha: head, pushed: true, pushError: null });
    await push(first);
    const get = await hive.call("runs.get", { machineId: first.name, runId: "R-old" }, admin);
    const list = await hive.call("runs.list", { project: "app" }, admin);
    for (const r of [get, list[0]]) {
      assert.equal(r?.startSha, sha); assert.equal(r?.headSha, head);
      assert.equal(r?.remoteSha, head); assert.equal(r?.pushed, true); assert.equal(r?.pushError, null);
    }
    assert.equal((await dispatch()).redispatch?.headSha, head);
  });

  it("avoids dispatch to a machine that reports it cannot push a remote task", async t => {
    const { hive, push, dispatch, beat } = await setup(); t.after(() => hive.close());
    await push(first, { headSha: sha, remoteSha: sha, pushed: true });
    await beat(second, { gitPush: { app: false } });
    await assert.rejects(dispatch(), /cannot push/);
    await beat(second, { gitPush: { app: true } });
    assert.ok((await dispatch()).id);
  });

  it("migrates existing run rows with unknown push state", async t => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "hive-remote-migration-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, "hive.db");
    const index = migrationIndex("ALTER TABLE run_records ADD COLUMN start_sha");
    const before = new SqliteHive(file, { migrateTo: index });
    before.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, commits, log, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)").run(first.name, "R-old", "one", "app", "T-1", "Work", "implement", "failed", at, at);
    before.close();
    const after = new SqliteHive(file); t.after(() => after.close());
    const run = await after.call("runs.get", { machineId: first.name, runId: "R-old" }, admin);
    assert.equal(run?.pushed, null); assert.equal(run?.startSha, null); assert.equal(run?.pushError, null);
  });
});
