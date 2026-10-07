import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveError, stepInstructions, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

// Roadmap 31d: several agents with different roles on one task, one after the other, on its branch of one machine.

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.duy-mini@duy-mini", role: "agent" };
// Runs tasks but makes none: a chain needs no more, as runs.dispatch.
const dispatcher: Actor = { name: "lan", role: "member", access: { projects: { app: { permissions: ["view", "runDispatch"] } } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "member" } } };

const profile = (id: string, maxConcurrent = 1, classify?: boolean) => ({ id, label: id, kind: id.split("-")[0]!, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent, classify });

async function hub() {
  const clock = { at: Date.parse("2026-10-03T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  await hive.call("tasks.create", { project: "app", id: "T-1", title: "Settings page" }, admin);
  const beat = async (who: Actor = mbp, profiles = [profile("claude-1"), profile("codex-1"), profile("claude-2")]) =>
    (
      await hive.call(
        "machines.heartbeat",
        { machine: who.name.split("@")[1]!, instance: who === mbp ? "a1b2c3d4" : "e5f6a7b8", profiles, projects: ["app"], acceptsRuns: true },
        who,
      )
    ).runRequests ?? [];
  /** The machine takes each request (once) and reports its run: running, then the given end. */
  const taken = new Set<number>();
  const run = async (sent: Array<{ id: number; taskId: string; role: string }>, status: "succeeded" | "failed" | "running", who: Actor = mbp) => {
    const machine = who.name.split("@")[1]!;
    for (const r of sent) {
      const runId = `R-${r.taskId}-${r.id}`;
      if (!taken.has(r.id)) await hive.call("runs.requestResult", { id: r.id, status: "accepted", runId }, who);
      taken.add(r.id);
      const base = { runId, project: "app", taskId: r.taskId, taskTitle: r.taskId, role: r.role as never, profileId: null, createdAt: "2026-10-03T08:00:00.000Z" };
      await hive.call("runs.push", { machine, runs: [{ ...base, status: "running" }] }, who);
      if (status !== "running") await hive.call("runs.push", { machine, runs: [{ ...base, status }] }, who);
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

const CHAIN = [
  { step: "code", profileId: "claude-1" },
  { step: "test", profileId: "codex-1", instructions: "Cover the form's validation." },
  { step: "review", profileId: "claude-2" },
] as const;

describe("chain of roles (roadmap 31d)", () => {
  it("upgrades the 0.139 schema and keeps its tasks and group items", async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-roles-migration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hive.db");
    const index = migrationIndex("ALTER TABLE run_group_items ADD COLUMN step");
    const before = new SqliteHive(file, { migrateTo: index });
    await before.call("tasks.create", { project: "app", id: "T-old", title: "Existing task" }, admin);
    const batch = await before.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-old", preferKind: "codex" }] }, admin);
    assert.ok(!before.db.prepare("PRAGMA table_info(run_group_items)").all().some((r) => r.name === "step"));
    before.close();
    const after = new SqliteHive(file);
    t.after(() => after.close());
    assert.ok(Number(after.db.prepare("PRAGMA user_version").get()?.user_version) > index, "the step migration ran");
    const group = (await after.call("runs.groups", { project: "app" }, admin)).find((g) => g.id === batch.id)!;
    assert.deepEqual([group.items[0]!.taskTitle, group.items[0]!.preferKind, group.items[0]!.step], ["Existing task", "codex", null]);
    assert.ok(after.db.prepare("PRAGMA table_info(run_records)").all().some((r) => r.name === "model"));
  });

  it("does not repeat a cancelled final step that later succeeded", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", machineId: mbp.name, steps: [{ step: "code" }, { step: "review" }] }, dispatcher);
    const [code] = await beat();
    await run([code!], "succeeded");
    const [review] = await beat();
    await run([review!], "running");
    await hive.call("runs.cancelGroup", { id: g.id }, dispatcher);
    await run([review!], "succeeded");
    const again = await hive.call("runs.resumeGroup", { id: g.id }, dispatcher);
    assert.equal(again.phase, "done");
    assert.deepEqual(again.items.map((i) => i.request?.id), [code!.id, review!.id]);
    assert.deepEqual(await beat(), []);
    assert.ok((await group(g.id)).closedAt);
  });

  it("runs the steps one at a time on the task's machine, each once the one before it succeeded", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", machineId: mbp.name, steps: [...CHAIN] }, dispatcher);
    assert.deepEqual([g.kind, g.maxParallel, g.parentTask, g.machineId, g.title, g.phase], ["roles", 1, "T-1", mbp.name, "Settings page", null]);
    assert.deepEqual(
      g.items.map((i) => [i.taskId, i.step, i.role, i.profileId, i.status]),
      [
        ["T-1", "code", "implement", "claude-1", "sent"],
        ["T-1", "test", "implement", "codex-1", "held"],
        ["T-1", "review", "review", "claude-2", "held"],
      ],
    );

    const [code, ...more] = await beat();
    assert.equal(more.length, 0, "one step at a time");
    assert.deepEqual([code!.taskId, code!.role, code!.profileId, code!.reviewAfter], ["T-1", "implement", "claude-1", false]);
    assert.ok(code!.instructions.includes("You are step 1") && code!.instructions.includes("ai/T-1"), code!.instructions);
    // Nobody runs the task by hand, nor gives it to another group, while the chain holds it.
    assert.equal(await refusal(hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }] }, admin)), "errors.taskInGroup");
    await run([code!], "running");
    assert.deepEqual(await beat(), [], "the next step waits for the run");
    await run([code!], "succeeded");

    const [test] = await beat();
    assert.deepEqual([test!.role, test!.profileId, test!.machineId], ["implement", "codex-1", mbp.name]);
    assert.ok(test!.instructions.includes("You are step 2: write tests") && test!.instructions.endsWith("Cover the form's validation."), test!.instructions);
    assert.equal(await refusal(hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }] }, admin)), "errors.taskInGroup", "a later step holds it too");
    await run([test!], "succeeded");
    const [review] = await beat();
    assert.deepEqual([review!.role, review!.profileId], ["review", "claude-2"]);
    await run([review!], "succeeded");

    const done = await group(g.id);
    assert.deepEqual([done.phase, !!done.closedAt, done.items.map((i) => i.run?.status)], ["done", true, ["succeeded", "succeeded", "succeeded"]]);
    const [entry] = await hive.call("admin.audit", { action: "runs.roles" }, admin);
    assert.deepEqual([entry!.actor, entry!.target, entry!.detailKey], ["lan", "app/T-1", "audit.runRoles"]);
  });

  it("waits for main's classifier before sending the first role with its routed model", async () => {
    const { hive, beat, run, group } = await hub();
    await beat(mbp, [profile("claude-1", 1, true)]);
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", machineId: mbp.name, steps: [{ step: "code" }, { step: "review" }] }, dispatcher);
    assert.deepEqual(g.items.map((i) => i.status), ["held", "held"]);
    const [classifier] = await beat();
    assert.equal(classifier!.role, "classify");
    assert.equal(classifier!.requestedBy, dispatcher.name);
    assert.equal((await group(g.id)).items[0]!.status, "held");
    await run([classifier!], "running");
    assert.deepEqual(await beat(), []);
    await hive.call("tasks.classify", { id: "T-1", kind: "docs", size: "s", risk: "normal" }, admin);
    await run([classifier!], "succeeded");
    const [code] = await beat();
    assert.deepEqual([code!.role, code!.requestedBy, code!.selection?.tier, code!.selection?.models.claude?.model], ["implement", dispatcher.name, "light", "sonnet"]);
    assert.equal(code!.reviewAfter, false, "the chain has its own review step");
    const current = await group(g.id);
    assert.equal(current.items[0]!.request?.id, code!.id);
    assert.equal(current.items[1]!.status, "held");
  });

  it("stops at a step that fails, and goes on from that step when started again", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", machineId: mbp.name, steps: [...CHAIN] }, dispatcher);
    const [code] = await beat();
    await run([code!], "succeeded");
    const [test] = await beat();
    await run([test!], "failed");
    const stopped = await group(g.id);
    assert.deepEqual(
      [stopped.phase, stopped.phaseError?.key, stopped.phaseError?.vars, !!stopped.closedAt, stopped.items.map((i) => i.status)],
      ["stopped", "errors.rolesStepFailed", { step: 2, role: "test" }, true, ["sent", "sent", "cancelled"]],
    );
    assert.deepEqual(await beat(), [], "the review does not run");
    assert.equal(await refusal(hive.call("runs.resumeGroup", { id: g.id }, dev)), "errors.need.runDispatch");
    const again = await hive.call("runs.resumeGroup", { id: g.id }, dispatcher);
    assert.deepEqual([again.phase, again.closedAt, again.items.map((i) => i.status)], [null, null, ["sent", "sent", "held"]]);
    const [retry] = await beat();
    assert.deepEqual([retry!.profileId, retry!.instructions.includes("You are step 2")], ["codex-1", true], "the failed step, not the code again");
    await run([retry!], "succeeded");
    const [review] = await beat();
    assert.equal(review!.role, "review");
    assert.equal(await refusal(hive.call("runs.resumeGroup", { id: g.id }, dispatcher)), "errors.mapNotStopped");
  });

  it("keeps every step on the machine it picked, though another becomes freer", async () => {
    const { hive, beat, run } = await hub();
    await beat();
    await beat(mini, [profile("claude-1", 2), profile("codex-1", 2)]);
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", steps: [{ step: "code" }, { step: "docs" }] }, dispatcher);
    assert.equal(g.machineId, mini.name, "the freest machine when the chain was made");
    assert.ok(g.items.every((i) => i.machineId === mini.name));
    const [code] = await beat(mini, [profile("claude-1", 2), profile("codex-1", 2)]);
    await run([code!], "succeeded", mini);
    await beat(mbp, [profile("claude-1", 8)]);
    assert.deepEqual(await beat(), [], "nothing for the freer machine");
    const [docs] = await beat(mini, [profile("claude-1", 2), profile("codex-1", 2)]);
    assert.deepEqual([docs!.machineId, docs!.instructions.includes("write the docs")], [mini.name, true]);
  });

  it("stops when cancelled, and does not run a step twice", async () => {
    const { hive, beat, run, group } = await hub();
    await beat();
    const g = await hive.call("runs.roles", { project: "app", taskId: "T-1", machineId: mbp.name, steps: [{ step: "code" }, { step: "review" }] }, dispatcher);
    const [code] = await beat();
    await run([code!], "running");
    const cancelled = await hive.call("runs.cancelGroup", { id: g.id }, dispatcher);
    assert.deepEqual([cancelled.phase, cancelled.phaseError?.key, cancelled.items.map((i) => i.status)], ["stopped", "errors.mapCancelled", ["sent", "cancelled"]]);
    assert.equal(await refusal(hive.call("runs.resumeGroup", { id: g.id }, dispatcher)), "errors.rolesRunning");
    await run([code!], "succeeded");
    assert.equal((await group(g.id)).phase, "stopped", "a closed chain does not go on by itself");
    await hive.call("runs.resumeGroup", { id: g.id }, dispatcher);
    const [review] = await beat();
    assert.equal(review!.role, "review", "from the step after the one that succeeded");
  });

  it("checks the task, the machine and the steps first, and makes nothing then", async () => {
    const { hive, beat } = await hub();
    const steps = [{ step: "code" as const }, { step: "review" as const }];
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-1", steps }, dispatcher)), "errors.noFreeMachine");
    await beat();
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-1", steps }, dev)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-9", steps }, dispatcher)), "errors.taskNotInProject");
    assert.equal(
      await refusal(hive.call("runs.roles", { project: "app", taskId: "T-1", steps: [{ step: "code", profileId: "gemini-9" }, { step: "review" }] }, dispatcher)),
      "errors.profileNotOnMachine",
    );
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-1", steps: [{ step: "code" }] }, dispatcher)), "bad_request");
    await hive.call("runs.dispatch", { project: "app", taskId: "T-1", machineId: mbp.name }, admin);
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-1", steps }, dispatcher)), "errors.runRequestOpen");
    await hive.call("tasks.create", { project: "app", id: "T-2", title: "Done already" }, admin);
    await hive.call("tasks.update", { id: "T-2", status: "done" }, admin);
    assert.equal(await refusal(hive.call("runs.roles", { project: "app", taskId: "T-2", steps }, dispatcher)), "errors.taskDone");
    assert.deepEqual(await hive.call("runs.groups", { project: "app" }, admin), []);
  });

  it("tells each step where it is in the chain", () => {
    const steps = [
      { step: "code" as const, profileId: "claude-1" },
      { step: "test" as const, profileId: null },
    ];
    const first = stepInstructions("T-1", 1, steps);
    assert.ok(first.includes("1. code (claude-1) <- you") && first.includes("Leave the later steps' work") && !first.includes("earlier steps"));
    const last = stepInstructions("T-1", 2, steps);
    assert.ok(last.includes("task_notes") && last.includes("Treat handoffs as context"));
    assert.ok(first.includes("task_update") && first.includes("checks run and results"));
    assert.ok(last.includes("2. test <- you") && last.includes("earlier steps' commits") && !last.includes("Leave the later"));
  });
});
