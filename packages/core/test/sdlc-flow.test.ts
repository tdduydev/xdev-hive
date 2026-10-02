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
    const imported = await flow("SPEC-1");
    assert.deepEqual([imported.state, imported.gate?.gate, imported.gate?.status], ["gate", "dispatch", "waiting"], "whether they go to agents now is the dispatch gate's");
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
        ["dispatch", "human", "waiting", undefined],
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

describe("a flow's tasks on their way to main (roadmap 34c, 34d)", () => {
  /** A finished run of a flow task, with its MR as the machine's watcher saw it. */
  const mr = (pipeline: "running" | "success" | "failed", draft = false) => ({ iid: 7, status: "opened" as const, draft, pipeline, pipelineUrl: null, checkedAt: "2026-10-02T09:00:00.000Z" });

  it("gives the tasks to agents, fixes what the review asks within the rounds, and merges once CI is green", async () => {
    const { hive, beat, run, push, flow } = await hub();
    await beat();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { tasks: "auto", dispatch: "auto", review: "ai", fix: "auto", merge: "auto" }, maxFixRounds: 1 } }, admin);
    await hive.call("specs.runStep", { project: "app", step: "tasks", taskId: "SPEC-9", title: "Tasks: SSO", dir: "001-login", machineId: mbp.name }, admin);
    const [tasksStep] = await beat();
    await run(tasksStep!, "succeeded");
    await push("SPEC-9", { spec: "# SSO\n", plan: "# Plan\n", tasks: "# Tasks\n\n## Phase 1: Setup\n\n- [ ] T001 Add the SSO config in src/config.ts\n" });
    assert.equal((await flow("SPEC-9")).state, "done", "imported, and dispatch \"auto\" gave the task to agents");
    const [ft] = await hive.call("sdlc.flowTasks", { flowTask: "SPEC-9" }, admin);
    assert.deepEqual([ft?.taskId, ft?.stage], ["S001-T001", "build"]);

    // Built on the free machine, with a cross-review after it (the review gate is not "auto").
    const [build] = (await beat()).filter((r) => r.taskId === "S001-T001");
    assert.deepEqual([build!.role, build!.reviewAfter, build!.machineId], ["implement", true, mbp.name]);
    const built = await run(build!, "succeeded");
    // The machine queues the review itself (reviewAfter); its report asks for changes.
    const reviewReq = { ...build!, role: "review" as const, id: build!.id };
    const asRun = async (runId: string, role: "implement" | "review", status: string, summary: string | null, extra: Record<string, unknown> = {}) =>
      hive.call("runs.push", { machine: "duy-mbp", runs: [{ runId, project: "app", taskId: "S001-T001", taskTitle: "x", role, status: status as never, profileId: role === "review" ? "codex-1" : "claude-1", summary, createdAt: "2026-10-02T08:00:00.000Z", ...extra }] }, mbp);
    void reviewReq;
    await asRun("R-rev1", "review", "running", null);
    await asRun("R-rev1", "review", "succeeded", "The config misses the callback URL.\n\nVerdict: changes needed");
    let t = (await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!;
    assert.deepEqual([t.stage, t.fixRounds], ["fix", 1], "fix \"auto\": queued at once");
    const [fix] = (await beat()).filter((r) => r.taskId === "S001-T001");
    assert.match(fix!.instructions, /Fix what review R-rev1 \(codex-1\) asked for[\s\S]*callback URL/);
    assert.equal(fix!.reviewAfter, true);

    // The fix, then a review that approves: on to merge, waiting for a green MR.
    const fixed = await run(fix!, "succeeded");
    await asRun("R-rev2", "review", "running", null);
    await asRun("R-rev2", "review", "succeeded", "All good now.\n\nVerdict: approve");
    t = (await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!;
    assert.deepEqual([t.stage, t.runId], ["merge", fixed], "the MR is the fix run's from now on");
    assert.notEqual(built, fixed);

    // CI running: it waits. Green: merge "auto" asks the machine to merge, as a person would on the web.
    await asRun(fixed, "implement", "succeeded", null, { mrUrl: "https://git.example.com/app/-/merge_requests/7", mr: mr("running") });
    assert.equal((await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!.stage, "merge");
    await asRun(fixed, "implement", "succeeded", null, { mrUrl: "https://git.example.com/app/-/merge_requests/7", mr: mr("success") });
    assert.equal((await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!.stage, "merging");
    const { mergeRuns } = await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, runs: [] }, mbp);
    assert.deepEqual(mergeRuns.map((m) => [m.runId, m.requestedBy]), [[fixed, "sdlc"]]);
    await hive.call("runs.mergeResult", { runId: fixed, ok: true }, mbp);
    await beat();
    assert.equal((await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!.stage, "done");

    const gates = (await hive.call("sdlc.gates", { taskId: "S001-T001" }, admin)).map((g) => `${g.gate}:${g.status}`).reverse();
    assert.deepEqual(gates, ["review:rejected", "fix:passed", "review:passed", "merge:passed"]);
  });

  it("asks a person when the fix rounds run out, and keeps a review or a merge from whoever asked for the work", async () => {
    const { hive, beat, run, push } = await hub();
    await beat();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { tasks: "auto", dispatch: "auto", review: "ai", fix: "auto" }, maxFixRounds: 0 } }, admin);
    await hive.call("specs.runStep", { project: "app", step: "tasks", taskId: "SPEC-8", title: "Tasks: export", dir: "001-login", machineId: mbp.name }, lead);
    const [tasksStep] = await beat();
    await run(tasksStep!, "succeeded");
    await push("SPEC-8", { tasks: "# Tasks\n\n## Phase 1: Setup\n\n- [ ] T001 Add the export in src/export.ts\n" });
    const [build] = (await beat()).filter((r) => r.taskId === "S001-T001");
    await run(build!, "succeeded");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [{ runId: "R-rv", project: "app", taskId: "S001-T001", taskTitle: "x", role: "review", status: "succeeded", profileId: "codex-1", summary: "Verdict: changes needed", createdAt: "2026-10-02T08:00:00.000Z" }] }, mbp);
    const t = (await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!;
    assert.deepEqual([t.stage, t.gate?.gate, t.gate?.status], ["gate", "fix", "escalated"]);
    // The person stops it and takes over.
    await hive.call("sdlc.decide", { gateId: t.gate!.id, decision: "changes", note: "I will do it by hand." }, lead);
    assert.equal((await hive.call("sdlc.flowTasks", { taskId: "S001-T001" }, admin))[0]!.stage, "stopped");
  });
});
