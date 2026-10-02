import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, parseParts, type Actor, type RunGroup } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 31c: a big job in parts, run side by side by the agents of one machine, then merged by one run, always.

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "member" } } };

const profile = (id: string) => ({ id, label: id, kind: id.split("-")[0]!, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 1 });

async function hub() {
  const clock = { at: Date.parse("2026-10-02T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  const beat = async () =>
    (
      await hive.call(
        "machines.heartbeat",
        { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1"), profile("codex-1"), profile("claude-2")], projects: ["app"], acceptsRuns: true },
        mbp,
      )
    ).runRequests ?? [];
  /** The machine takes each request and reports its run as R-<task>, with the given end. */
  const run = async (sent: Array<{ id: number; taskId: string; role: string }>, status: "succeeded" | "failed") => {
    for (const r of sent) {
      const runId = `R-${r.taskId}-${r.id}`;
      await hive.call("runs.requestResult", { id: r.id, status: "accepted", runId }, mbp);
      const base = { runId, project: "app", taskId: r.taskId, taskTitle: r.taskId, role: r.role as never, profileId: "claude-1", createdAt: "2026-10-02T08:00:00.000Z" };
      await hive.call("runs.push", { machine: "duy-mbp", runs: [{ ...base, status: "running" }] }, mbp);
      await hive.call("runs.push", { machine: "duy-mbp", runs: [{ ...base, status }] }, mbp);
    }
  };
  const group = async (id: number) => (await hive.call("runs.groups", { project: "app" }, admin)).find((g) => g.id === id)!;
  return { hive, beat, run, group };
}

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

const tasks = async (hive: SqliteHive, ids: string[]) => {
  const all = await hive.call("tasks.list", { project: "app" }, admin);
  return ids.map((id) => `${id}:${all.find((t) => t.id === id)?.status}`);
};

describe("map-reduce (roadmap 31c)", () => {
  it("runs the parts side by side on one machine, then merges them in the job's task", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g: RunGroup = await hive.call(
      "runs.mapReduce",
      { project: "app", title: "Settings page", prompt: "Build the settings page.", parts: ["Form in src/settings/form.tsx", "API in src/api/settings.ts", "Docs"], profiles: ["claude-1", "codex-1"], maxParallel: 2 },
      lead,
    );
    assert.deepEqual([g.kind, g.phase, g.parentTask, g.machineId, g.reviewAfter], ["mapreduce", "map", "P-1", mbp.name, true]);
    assert.deepEqual(
      g.items.map((i) => [i.taskId, i.profileId, i.status]),
      [
        ["P-1-1", "claude-1", "sent"],
        ["P-1-2", "codex-1", "sent"],
        ["P-1-3", "claude-1", "held"],
      ],
    );
    const parent = (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "P-1")!;
    assert.deepEqual(parent.waitingOn, ["P-1-1", "P-1-2", "P-1-3"], "the job waits for its parts");
    let sent = await beat();
    assert.ok(sent.every((r) => !r.reviewAfter && r.instructions.includes("part 1 of 3") === (r.taskId === "P-1-1") && r.instructions.includes("Build the settings page.")));
    await run(sent, "succeeded");
    sent = await beat();
    assert.deepEqual(sent.map((r) => r.taskId), ["P-1-3"], "the third part when a place is free");
    await run(sent, "succeeded");

    const merging = await group(g.id);
    assert.equal(merging.phase, "reduce");
    assert.deepEqual(await tasks(hive, ["P-1-1", "P-1-2", "P-1-3"]), ["P-1-1:done", "P-1-2:done", "P-1-3:done"]);
    const [merge] = await beat();
    assert.deepEqual([merge!.taskId, merge!.machineId, merge!.reviewAfter], ["P-1", mbp.name, true], "on the parts' machine, reviewed after");
    for (const b of ["ai/P-1-1", "ai/P-1-2", "ai/P-1-3"]) assert.ok(merge!.instructions.includes(b), b);
    await run([merge!], "succeeded");
    const done = await group(g.id);
    assert.deepEqual([done.phase, !!done.closedAt, done.phaseRun?.status], ["done", true, "succeeded"]);
  });

  it("stops when a part fails, and runs only that part again", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.mapReduce", { project: "app", prompt: "Two halves.", parts: ["Left", "Right"] }, lead);
    const sent = await beat();
    await run(sent.filter((r) => r.taskId === "P-1-1"), "succeeded");
    await run(sent.filter((r) => r.taskId === "P-1-2"), "failed");
    const stopped = await group(g.id);
    assert.deepEqual([stopped.phase, stopped.phaseError?.key, !!stopped.closedAt], ["stopped", "errors.mapPartsFailed", true]);
    assert.equal(await refusal(hive.call("runs.resumeGroup", { id: g.id }, dev)), "errors.need.taskManage");
    const again = await hive.call("runs.resumeGroup", { id: g.id }, lead);
    assert.deepEqual([again.phase, again.closedAt], ["map", null]);
    const retry = await beat();
    assert.deepEqual(retry.map((r) => r.taskId), ["P-1-2"]);
    await run(retry, "succeeded");
    assert.equal((await group(g.id)).phase, "reduce");
    assert.equal(await refusal(hive.call("runs.resumeGroup", { id: g.id }, lead)), "errors.mapNotStopped");
  });

  it("asks an agent to split the job, then runs the parts a person checked", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.mapSplit", { project: "app", prompt: "Move billing to the new API.", machineId: mbp.name, profileId: "claude-2" }, lead);
    assert.deepEqual([g.phase, g.parentTask, g.items.length], ["split", "P-1", 0]);
    const [plan] = await beat();
    assert.deepEqual([plan!.taskId, plan!.role, plan!.profileId], ["P-1", "plan", "claude-2"]);
    assert.ok(plan!.instructions.includes('starting with "- "'));
    // The plan run writes its list in the task's note, as task_update does.
    await hive.call("runs.requestResult", { id: plan!.id, status: "accepted", runId: "R-plan" }, mbp);
    await hive.call("tasks.claim", { id: "P-1" }, mbp);
    await hive.call("tasks.update", { id: "P-1", status: "review", note: "Chia thành:\n- Invoices endpoint\n- Refunds endpoint\n1. Webhooks" }, mbp);
    await hive.call("runs.push", { machine: "duy-mbp", runs: [{ runId: "R-plan", project: "app", taskId: "P-1", taskTitle: "P-1", role: "plan", status: "succeeded", profileId: "claude-2", createdAt: "2026-10-02T08:00:00.000Z" }] }, mbp);
    const ready = await group(g.id);
    assert.deepEqual([ready.phase, ready.parts], ["ready", ["Invoices endpoint", "Refunds endpoint", "Webhooks"]]);
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", groupId: g.id + 1, parts: ["a", "b"] }, lead)), "errors.runGroupNotFound");
    const going = await hive.call("runs.mapReduce", { project: "app", groupId: g.id, parts: ["Invoices endpoint", "Refunds and webhooks"] }, lead);
    assert.deepEqual([going.id, going.phase, going.items.map((i) => i.taskId)], [g.id, "map", ["P-1-1", "P-1-2"]]);
    assert.deepEqual(await tasks(hive, ["P-1"]), ["P-1:todo"]);
    const sent = await beat();
    assert.ok(sent.every((r) => r.instructions.includes("Move billing to the new API.")), "the job reaches the parts though the note was replaced");
    await run(sent, "succeeded");
    assert.equal((await group(g.id)).phase, "reduce");
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", groupId: g.id, parts: ["a", "b"] }, lead)), "errors.mapNotReady");
  });

  it("checks the machine, the profiles and the parts first, and makes nothing then", async () => {
    const { hive, beat } = await hub();
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", prompt: "x", parts: ["a", "b"] }, lead)), "errors.noFreeMachine");
    await beat();
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", prompt: "x", parts: ["a", "b"], profiles: ["gemini-9"] }, lead)), "errors.profileNotOnMachine");
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", parts: ["a", "b"] }, lead)), "errors.mapNoJob");
    assert.equal(await refusal(hive.call("runs.mapReduce", { project: "app", prompt: "x", parts: ["a", "b"] }, dev)), "errors.need.taskManage");
    assert.deepEqual(await hive.call("tasks.list", { project: "app" }, admin), []);
  });

  it("reads the parts an agent listed", () => {
    assert.deepEqual(parseParts("Plan:\n- One\n* Two\n  3) Three\n- [ ] Four\nnot a part\n-\n"), ["One", "Two", "Three", "Four"]);
    assert.equal(parseParts(Array.from({ length: 20 }, (_, i) => `- p${i}`).join("\n")).length, 12);
    assert.deepEqual(parseParts(null), []);
  });
});
