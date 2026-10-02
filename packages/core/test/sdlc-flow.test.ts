import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type RunRequest } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 34b: a Spec Kit flow the hub drives through the project's gates, with a fake machine.

const admin: Actor = { name: "duy", role: "admin" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };

const profile = (id: string, kind: string, priority = 10) => ({ id, label: id, kind, enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0, priority });

async function hub() {
  const clock = { at: Date.parse("2026-10-02T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  await hive.call("tasks.create", { id: "T-0", project: "app", title: "Other work" }, admin);
  const tick = () => (clock.at += 1000);
  const beat = async () => (tick(), (await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles: [profile("claude-1", "claude"), profile("codex-1", "codex", 20)], projects: ["app"], acceptsRuns: true, runs: [] }, mbp)).runRequests);
  let n = 0;
  /** The machine takes what the hub sent and runs it to the end with this status and report. */
  const run = async (req: RunRequest, status: "succeeded" | "failed", summary: string | null = null) => {
    const runId = `R-${++n}`;
    tick();
    await hive.call("runs.requestResult", { id: req.id, status: "accepted", runId }, mbp);
    const base = { runId, project: "app", taskId: req.taskId, taskTitle: req.taskTitle, role: req.role, profileId: req.profileId ?? "claude-1", createdAt: "2026-10-02T08:00:00.000Z" };
    await hive.call("runs.push", { machine: "duy-mbp", runs: [{ ...base, status: "running" }] }, mbp);
    tick();
    await hive.call("runs.push", { machine: "duy-mbp", runs: [{ ...base, status, summary }] }, mbp);
    return runId;
  };
  const push = async (taskId: string, files: Record<string, string>) => {
    tick();
    await hive.call("specs.push", { project: "app", features: [{ dir: "001-login", branch: `ai/${taskId}`, commit: `abc${n}0`, files: { spec: null, plan: null, tasks: null, ...files } }] }, mbp);
  };
  const flow = async (taskId: string) => (await hive.call("sdlc.flows", { project: "app" }, admin)).find((f) => f.taskId === taskId)!;
  return { hive, beat, run, push, flow, tick };
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

const TASKS_MD = "# Tasks\n\n## Phase 1: Setup\n\n- [ ] T001 Add the SSO config in src/config.ts\n- [ ] T002 Add the login route in src/login.ts\n";

describe("a Spec Kit flow through the gates (roadmap 34b)", () => {
  it("goes on by itself, through an AI check, and waits for a person, each as the project set its gates", async () => {
    const { hive, beat, run, push, flow } = await hub();
    await beat();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { spec: "auto", plan: "ai" } } }, lead);
    const started = await hive.call("specs.runStep", { project: "app", step: "specify", taskId: "SPEC-1", title: "Spec: SSO login", input: "Sign in with the company SSO.", machineId: mbp.name }, lead);
    assert.deepEqual([started.task.id, started.flow.state, started.flow.step], ["SPEC-1", "running", "specify"]);
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "SPEC-1" }, lead)), "errors.taskInFlow");
    assert.match(started.request.instructions, /Spec Kit step "specify"[\s\S]*Sign in with the company SSO\./);

    // specify done; spec gate "auto": the plan comes next, once the machine says which folder the spec is in.
    const [specify] = await beat();
    await run(specify!, "succeeded");
    assert.deepEqual([(await flow("SPEC-1")).state, (await flow("SPEC-1")).step], ["next", "plan"]);
    await push("SPEC-1", { spec: "# SSO login\n" });
    const planFlow = await flow("SPEC-1");
    assert.deepEqual([planFlow.state, planFlow.dir], ["running", "001-login"]);
    const [plan] = await beat();
    assert.match(plan!.instructions, /Spec Kit step "plan" for the feature in specs\/001-login/);

    // plan done; plan gate "ai": a review on the other vendor, whose verdict lets the flow go on.
    await run(plan!, "succeeded");
    await beat();
    const [check] = await beat();
    assert.deepEqual([check!.role, check!.profileId], ["review", "codex-1"], "the step ran on claude-1: the check goes to codex");
    assert.match(check!.instructions, /"plan" gate[\s\S]*specs\/001-login\/plan\.md/);
    await run(check!, "succeeded", "The plan covers the spec.\n\nVerdict: approve");
    const [tasksStep] = await beat();
    assert.match(tasksStep!.instructions, /Spec Kit step "tasks"/);

    // tasks done; tasks gate "human": it waits; asking for changes runs the step again with the note.
    await run(tasksStep!, "succeeded");
    const waiting = await flow("SPEC-1");
    assert.deepEqual([waiting.state, waiting.gate?.gate, waiting.gate?.status, waiting.gate?.mode], ["gate", "tasks", "waiting", "human"]);
    assert.equal(await refusal(hive.call("sdlc.decide", { gateId: waiting.gate!.id, decision: "pass" }, dev)), "errors.need.taskManage");
    await hive.call("sdlc.decide", { gateId: waiting.gate!.id, decision: "changes", note: "Split the login route into two tasks." }, lead);
    const [again] = await beat();
    assert.match(again!.instructions, /Spec Kit step "tasks"[\s\S]*Split the login route into two tasks\./);
    await run(again!, "succeeded");

    // Passed: the tasks.md pushed after the gate goes into the board.
    const second = await flow("SPEC-1");
    await hive.call("sdlc.decide", { gateId: second.gate!.id, decision: "pass" }, lead);
    assert.equal((await flow("SPEC-1")).state, "next", "the tasks.md the hub has is older than the gate");
    await push("SPEC-1", { spec: "# SSO login\n", plan: "# Plan\n", tasks: TASKS_MD });
    const done = await flow("SPEC-1");
    assert.equal(done.state, "done");
    const ids = (await hive.call("tasks.list", { project: "app" }, admin)).map((t) => t.id);
    assert.ok(ids.includes("S001-T001") && ids.includes("S001-T002"), ids.join(", "));

    const gates = await hive.call("sdlc.gates", { taskId: "SPEC-1" }, admin);
    assert.deepEqual(
      gates.map((g) => [g.gate, g.mode, g.status, g.decidedBy?.split("/")[0]]).reverse(),
      [
        ["spec", "auto", "passed", "auto"],
        ["plan", "ai", "passed", "run:runner.duy-mbp@duy-mbp"],
        ["tasks", "human", "rejected", "lan"],
        ["tasks", "human", "passed", "lan"],
      ],
    );
  });

  it("hands the gate to a person when the check asks for changes, and stops on a failed step", async () => {
    const { hive, beat, run, push, flow } = await hub();
    await beat();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { spec: "ai" } } }, admin);
    await hive.call("specs.runStep", { project: "app", step: "specify", taskId: "SPEC-2", title: "Spec: export", input: "CSV export", machineId: mbp.name }, admin);
    await push("SPEC-2", { spec: "# Export\n" });
    const [specify] = await beat();
    await run(specify!, "succeeded");
    await beat();
    const [check] = await beat();
    await run(check!, "succeeded", "Two requirements cannot be tested.\n\nVerdict: changes needed");
    const escalated = await flow("SPEC-2");
    assert.deepEqual([escalated.state, escalated.gate?.status], ["gate", "escalated"]);
    assert.match(escalated.gate!.note!, /cannot be tested/);
    await hive.call("sdlc.decide", { gateId: escalated.gate!.id, decision: "pass" }, admin);

    const [plan] = await beat();
    await run(plan!, "failed");
    assert.equal((await flow("SPEC-2")).state, "stopped");
    assert.equal(await refusal(hive.call("specs.runStep", { project: "app", step: "plan", taskId: "SPEC-2", dir: "001-login", machineId: mbp.name }, dev)), "errors.need.taskManage");
    await hive.call("sdlc.retry", { taskId: "SPEC-2" }, admin);
    const [retried] = await beat();
    assert.match(retried!.instructions, /Spec Kit step "plan"/);
  });

  it("leaves every gate to a person when the project set nothing, as before", async () => {
    const { hive, beat, run, flow } = await hub();
    await beat();
    await hive.call("specs.runStep", { project: "app", step: "specify", taskId: "SPEC-3", title: "Spec: audit", input: "Audit log", machineId: mbp.name }, admin);
    const [specify] = await beat();
    await run(specify!, "succeeded");
    const f = await flow("SPEC-3");
    assert.deepEqual([f.state, f.gate?.gate, f.gate?.mode], ["gate", "spec", "human"]);
    assert.deepEqual(await beat(), [], "nothing runs until a person decides");
    // Run again by hand from the Spec page: the gate it waited at is over, the step runs.
    await hive.call("specs.runStep", { project: "app", step: "specify", taskId: "SPEC-3", input: "Audit log, also exports", machineId: mbp.name }, admin);
    assert.equal((await hive.call("sdlc.gates", { taskId: "SPEC-3" }, admin))[0]?.status, "rejected");
    assert.equal((await flow("SPEC-3")).state, "running");
    assert.equal(await refusal(hive.call("specs.runStep", { project: "app", step: "specify", taskId: "SPEC-3", input: "x", machineId: mbp.name }, admin)), "errors.flowBusy");
  });
});
