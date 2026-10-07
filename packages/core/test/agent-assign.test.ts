import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type Task } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 50a: a task is given to one agent (a machine, and maybe one of its plans) and the hub queues its run by
// itself as soon as that agent is free. Nothing here may change how a task nobody assigned behaves.

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.lan-mini@lan-mini", role: "agent" };
const lead: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { app: "lead" } }, source: { via: "web" } };
const dev: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { app: "contribute" } }, source: { via: "web" } };
/** An agent run by the Claude CLI on duy-mbp: its write source says which machine it sits on. */
const onMbp: Actor = { name: "claude-1.duy-mbp@duy", role: "agent", agent: "claude-1.duy-mbp", source: { via: "mcp", machine: "duy-mbp" } };
const onMini: Actor = { name: "claude-1.lan-mini@lan", role: "agent", agent: "claude-1.lan-mini", source: { via: "mcp", machine: "lan-mini" } };

const profile = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: id.split("-")[0]!,
  enabled: true,
  account: null,
  installed: true,
  loggedIn: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
  ...over,
});

async function hub() {
  const clock = { at: Date.parse("2026-10-06T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  for (const n of [1, 2, 3]) await hive.call("tasks.create", { id: `T-${n}`, project: "app", title: `Task ${n}` }, admin);
  await hive.call("tasks.create", { id: "T-4", project: "app", title: "After T-1", dependsOn: ["T-1"] }, admin);
  const beat = (actor: Actor, over: Record<string, unknown> = {}) =>
    hive.call(
      "machines.heartbeat",
      { machine: actor.name.split("@")[1]!, instance: "a1b2c3d4", profiles: [profile("claude-1")], projects: ["app"], acceptsRuns: true, ...over },
      actor,
    );
  const push = (actor: Actor, runId: string, taskId: string, status: string) =>
    hive.call(
      "runs.push",
      {
        machine: actor.name.split("@")[1]!,
        runs: [{ runId, project: "app", taskId, taskTitle: taskId, role: "implement", status: status as never, profileId: "claude-1", createdAt: "2026-10-06T08:00:00.000Z" }],
      },
      actor,
    );
  /** The requests waiting for a machine, as its next heartbeat would hand them over. */
  const sent = async (actor: Actor) => (await beat(actor)).runRequests;
  const take = (actor: Actor, id: number, taskId: string) => hive.call("runs.requestResult", { id, status: "accepted", runId: `R-${taskId}` }, actor);
  const task = async (id: string): Promise<Task> => (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === id)!;
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, beat, push, sent, take, task, later };
}

const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

describe("a task given to one agent (roadmap 50)", () => {
  it("assigns, reorders and unassigns, and says who did it", async () => {
    const { hive, beat, task } = await hub();
    await beat(mbp);
    const first = await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name, profileId: "claude-1" }, lead);
    assert.deepEqual(
      [first.agent?.machineId, first.agent?.machine, first.agent?.profileId, first.agent?.order, first.agent?.by, first.agent?.hold],
      [mbp.name, "duy-mbp", "claude-1", 1, "lan", null],
    );
    // The machine's one place is taken by T-1's request, so the rest only queue up.
    await hive.call("tasks.assign", { id: "T-2", machineId: "duy-mbp" }, lead);
    await hive.call("tasks.assign", { id: "T-3", machineId: "duy-mbp" }, lead);
    const order = async () => (await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead)).map((q) => q.task.id);
    assert.deepEqual(await order(), ["T-1", "T-2", "T-3"]);
    // Dragged in front of T-1: only that task's place changes.
    await hive.call("tasks.assign", { id: "T-3", machineId: "duy-mbp", before: "T-1" }, lead);
    assert.deepEqual(await order(), ["T-3", "T-1", "T-2"]);
    assert.deepEqual([(await task("T-1")).agent?.order, (await task("T-2")).agent?.order], [1, 2], "the others keep theirs");
    await assert.rejects(hive.call("tasks.assign", { id: "T-2", machineId: "duy-mbp", before: "T-4" }, lead), fails("errors.agentBeforeOther"));
    assert.equal((await hive.call("tasks.unassign", { id: "T-3" }, lead)).agent, null);
    assert.deepEqual(await order(), ["T-1", "T-2"]);
    const log = (await hive.call("admin.audit", { limit: 50 }, admin)).filter((e) => e.action.startsWith("tasks.") && e.action !== "tasks.create" && e.target === "T-3");
    assert.deepEqual(log.map((e) => e.action), ["tasks.unassign", "tasks.assign", "tasks.assign"], "newest first");
  });

  it("takes the right to queue the project's runs, and refuses a machine without its repo or plan", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini, { projects: ["site"] });
    await assert.rejects(hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, dev), fails("errors.need.runDispatch"));
    await assert.rejects(hive.call("tasks.unassign", { id: "T-1" }, dev), fails("errors.need.runDispatch"));
    await assert.rejects(hive.call("tasks.assign", { id: "T-1", machineId: mini.name }, lead), fails("errors.machineNoRepo"));
    await assert.rejects(hive.call("tasks.assign", { id: "T-1", machineId: mbp.name, profileId: "codex-1" }, lead), fails("errors.profileNotOnMachine"));
    await assert.rejects(hive.call("tasks.assign", { id: "T-1", machineId: "nowhere" }, lead), fails("errors.machineNotFound"));
    // A machine whose user turned the hub's runs off would never be given the task.
    await beat(mbp, { acceptsRuns: false });
    await assert.rejects(hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead), fails("errors.machineNoHubRuns"));
  });

  it("queues the run itself once the task waits for nothing", async () => {
    const { hive, beat, sent, task } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-4", machineId: mbp.name }, lead);
    assert.deepEqual(await sent(mbp), [], "T-4 still waits for T-1");
    const queue = await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead);
    assert.equal(queue[0]!.waiting?.key, "errors.taskWaiting");
    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    const out = await sent(mbp);
    assert.deepEqual(
      out.map((r) => [r.taskId, r.role, r.profileId, r.requestedBy]),
      [["T-4", "implement", null, "lan"]],
      "the run counts for whoever gave the agent the task",
    );
    assert.equal((await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead))[0]!.waiting?.key, "errors.agentTaskBusy");
    assert.equal((await task("T-4")).agent?.hold, null);
  });

  it("gives an agent no more than its free places, and the next task when the run before it ends", async () => {
    const { hive, beat, push, sent, take } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    await hive.call("tasks.assign", { id: "T-2", machineId: mbp.name }, lead);
    const first = await sent(mbp);
    assert.deepEqual(first.map((r) => r.taskId), ["T-1"], "one plan, one place");
    // Taken but not pushed yet: the task and the place are still its own, or the hub would send T-2 into the window.
    await take(mbp, first[0]!.id, "T-1");
    assert.deepEqual(await sent(mbp), [], "the machine took it and has not reported the run yet");
    await push(mbp, "R-T-1", "T-1", "running");
    assert.deepEqual(await sent(mbp), []);
    assert.equal((await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead))[1]!.waiting?.key, "errors.agentBusy");
    await push(mbp, "R-T-1", "T-1", "succeeded");
    assert.deepEqual((await sent(mbp)).map((r) => r.taskId), ["T-2"], "the place is free again");
  });

  it("leaves alone a task someone already started another way", async () => {
    const { hive, beat, push, sent, take } = await hub();
    await beat(mbp);
    await beat(mini);
    await hive.call("tasks.assign", { id: "T-2", machineId: mbp.name }, lead);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const first = await sent(mbp);
    assert.deepEqual(first.map((r) => r.taskId), ["T-2"], "the one place went to the first of the queue");
    // Meanwhile a person runs T-1 by hand on the other machine, which takes it but has not pushed the run yet.
    const byHand = await hive.call("runs.dispatch", { machineId: mini.name, project: "app", taskId: "T-1" }, lead);
    await take(mini, byHand.id, "T-1");
    // duy-mbp's place comes free, and T-1 is next in its queue — but it is already running on lan-mini.
    await take(mbp, first[0]!.id, "T-2");
    await push(mbp, "R-T-2", "T-2", "succeeded");
    assert.deepEqual(await sent(mbp), [], "never a second run of the same task");
    const queue = await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead);
    assert.equal(queue.find((q) => q.task.id === "T-1")!.waiting?.key, "errors.agentTaskBusy");
  });

  it("stops at a task whose run failed until someone starts it again", async () => {
    const { hive, beat, push, sent, take, task } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    await hive.call("tasks.assign", { id: "T-2", machineId: mbp.name }, lead);
    const first = await sent(mbp);
    await take(mbp, first[0]!.id, "T-1");
    await push(mbp, "R-T-1", "T-1", "failed");
    const held = await task("T-1");
    assert.deepEqual([held.agent?.hold?.key, held.agent?.hold?.vars?.run], ["errors.agentRunFailed", "R-T-1"]);
    assert.equal(held.status, "todo", "the machine never moved it, and still it is not sent again");
    const queue = await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead);
    assert.equal(queue[0]!.waiting?.key, "errors.agentRunFailed");
    // The place is free, so the next task of the queue goes out; the held one does not come back.
    const next = await sent(mbp);
    assert.deepEqual(next.map((r) => r.taskId), ["T-2"]);
    await take(mbp, next[0]!.id, "T-2");
    assert.deepEqual(await sent(mbp), [], "nothing is sent for the task on hold");
    // *Chạy lại*: assigning it again clears the hold and keeps its place in the queue.
    const again = await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    assert.deepEqual([again.agent?.hold, again.agent?.order], [null, 1]);
    await push(mbp, "R-T-2", "T-2", "cancelled");
    assert.equal((await task("T-2")).agent?.hold?.key, "errors.agentRunCancelled");
    assert.deepEqual((await sent(mbp)).map((r) => r.taskId), ["T-1"], "and only the one started again goes out");
  });

  /** A run of T-1 reported by mbp, with the fields the turn rules look at. */
  const report = (hive: SqliteHive, runId: string, role: string, status: string, extra: Record<string, unknown> = {}) =>
    hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [{ runId, project: "app", taskId: "T-1", taskTitle: "T-1", role: role as never, status: status as never, profileId: "claude-1", createdAt: "2026-10-06T08:00:00.000Z", ...extra }] },
      mbp,
    );

  it("does not count a run the app closed, or a rate limit, as the agent's turn, but not for ever", async () => {
    const { hive, beat, sent, task } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const closed = "The app closed while the run was going";
    for (const [n, run] of [[1, { status: "failed", error: closed }], [2, { status: "rate_limited" }], [3, { status: "failed", error: closed }]] as const) {
      const out = await sent(mbp);
      assert.deepEqual(out.map((r) => r.taskId), ["T-1"], `turn ${n} is handed out again`);
      await hive.call("runs.requestResult", { id: out[0]!.id, status: "accepted", runId: `R-${n}` }, mbp);
      await report(hive, `R-${n}`, "implement", run.status, "error" in run ? { error: run.error } : {});
      assert.equal((await task("T-1")).agent?.hold, null, "cut short is not a failure");
    }
    // Three cut-short runs in a row: the task would only be cut short again, so it stops like any task that ran.
    const queue = await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead);
    assert.equal(queue[0]!.waiting?.key, "errors.agentTurnOver");
    assert.deepEqual(await sent(mbp), []);
  });

  it("counts the turn by the attempt the runner started after a rate limit, not by the rate-limited one", async () => {
    const { hive, beat, sent } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const out = await sent(mbp);
    await hive.call("runs.requestResult", { id: out[0]!.id, status: "accepted", runId: "R-1" }, mbp);
    await report(hive, "R-1", "implement", "rate_limited");
    await report(hive, "R-1b", "implement", "succeeded", { parentRun: "R-1", attempt: 2 });
    const queue = await hive.call("tasks.agentQueue", { machineId: mbp.name }, lead);
    assert.equal(queue[0]!.waiting?.key, "errors.agentTurnOver", "the next attempt used the turn");
    assert.deepEqual(await sent(mbp), []);
  });

  it("gives back a task its cut-short run had claimed, so the next turn is handed out", async () => {
    const { hive, beat, sent, task } = await hub();
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const out = await sent(mbp);
    await hive.call("runs.requestResult", { id: out[0]!.id, status: "accepted", runId: "R-1" }, mbp);
    await hive.call("tasks.claim", { id: "T-1" }, onMbp);
    assert.equal((await task("T-1")).status, "doing");
    await report(hive, "R-1", "implement", "failed", { error: "The app closed while the run was going" });
    assert.equal((await task("T-1")).status, "todo", "not left in doing until a lease that may never run out");
    assert.deepEqual((await sent(mbp)).map((r) => r.taskId), ["T-1"]);
  });

  it("uses the full report's verdict when the pushed review summary is clipped", async () => {
    const { hive, beat, sent } = await hub();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { fix: "ai" } } }, admin);
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const first = await sent(mbp);
    await hive.call("runs.requestResult", { id: first[0]!.id, status: "accepted", runId: "R-1" }, mbp);
    await report(hive, "R-1", "implement", "succeeded");
    await hive.call("tasks.update", { id: "T-1", status: "review" }, admin);
    await report(hive, "R-1r", "review", "succeeded", { parentRun: "R-1", summary: "Review findings clipped before the verdict line", verdict: "changes" });
    assert.deepEqual((await sent(mbp)).map((r) => [r.taskId, r.role]), [["T-1", "implement"]]);
  });

  it("gives a task the review asked changes of a new turn on its own machine, within maxFixRounds", async () => {
    const { hive, beat, sent, task } = await hub();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { fix: "ai" }, maxFixRounds: 1 } }, admin);
    await beat(mbp);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const first = await sent(mbp);
    await hive.call("runs.requestResult", { id: first[0]!.id, status: "accepted", runId: "R-1" }, mbp);
    await report(hive, "R-1", "implement", "succeeded");
    await hive.call("tasks.update", { id: "T-1", status: "review" }, admin);
    // A review of some other run (a late report of an older one) does not give the agent a turn.
    await report(hive, "R-0r", "review", "succeeded", { parentRun: "R-0", summary: "Verdict: changes needed" });
    assert.deepEqual(await sent(mbp), []);
    await report(hive, "R-1r", "review", "succeeded", { parentRun: "R-1", summary: "Verdict: changes needed" });
    const fix = await sent(mbp);
    assert.deepEqual(fix.map((r) => [r.taskId, r.role]), [["T-1", "implement"]], "the fix round runs without anyone pressing anything");
    assert.match(fix[0]!.instructions, /\S/);
    await hive.call("runs.requestResult", { id: fix[0]!.id, status: "accepted", runId: "R-2" }, mbp);
    await report(hive, "R-2", "implement", "succeeded");
    await report(hive, "R-2r", "review", "succeeded", { parentRun: "R-2", summary: "Verdict: changes needed" });
    assert.deepEqual(await sent(mbp), [], "maxFixRounds is 1: a second fix is for a person");
    assert.equal((await task("T-1")).agent?.hold, null);
  });

  it("leaves a task that is in a run group to its group, and lends the group its machine", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    // A machine with more room, so the hub's own pick for an item that names none would not be duy-mbp.
    await beat(mini, { profiles: [profile("claude-1", { maxConcurrent: 3 })] });
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    await hive.call("tasks.assign", { id: "T-2", machineId: mbp.name }, lead);
    const group = await hive.call("runs.dispatchMany", { project: "app", items: [{ taskId: "T-1" }, { taskId: "T-2" }], maxParallel: 5 }, lead);
    const requests = await hive.call("runs.requests", { project: "app" }, lead);
    assert.equal(requests.filter((r) => r.taskId === "T-1").length, 1, "the run the assignment started, never a second one");
    assert.equal(group.items.find((i) => i.taskId === "T-1")!.status, "held", "the group waits for that run instead");
    // The item named no machine: it took the task's agent rather than the machine with the most free places.
    assert.equal(group.items.find((i) => i.taskId === "T-2")!.machineId, mbp.name);
    assert.equal(requests.filter((r) => r.taskId === "T-2").length, 1, "the group sent it, and the queue left it alone");
  });

  it("keeps another machine's agent off the task: task_next skips it and task_claim is refused", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name }, lead);
    const ids = async (actor: Actor) => (await hive.call("tasks.next", { project: "app", limit: 10 }, actor)).map((t) => t.id);
    assert.deepEqual(await ids(onMini), ["T-2", "T-3"], "T-1 is somebody else's, T-4 still waits");
    assert.deepEqual(await ids(onMbp), ["T-1", "T-2", "T-3"], "its own comes first");
    assert.deepEqual(await ids(lead), ["T-1", "T-2", "T-3"], "a person sees the whole board as before");
    await assert.rejects(hive.call("tasks.claim", { id: "T-1" }, onMini), fails("errors.taskAssignedElsewhere"));
    assert.equal((await hive.call("tasks.claim", { id: "T-1" }, onMbp)).claimed, true);
    // A hub admin may still take it, to unblock a task whose agent will never come back.
    assert.equal((await hive.call("tasks.claim", { id: "T-2" }, onMini)).claimed, true, "nobody's task is claimed as before");
  });

  it("is what a leader proposes and a project manager confirms", async () => {
    const { hive, beat, sent } = await hub();
    await beat(mbp);
    const message = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Give T-2 to duy-mbp" }, lead);
    await hive.call("chat.progress", { replyId: message.reply.id, text: "…" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat", role: "agent", access: { projects: { app: "member" } }, agent: "claude-1.duy-mbp", chatReply: message.reply.id, source: { via: "mcp" } };
    await assert.rejects(
      hive.call("chat.propose", { action: { kind: "task.assign", taskId: "T-2", machine: "duy-mbp", profileId: "codex-9" }, reason: "x" }, leader),
      fails("errors.chatProfileNotFound"),
    );
    const action = await hive.call("chat.propose", { action: { kind: "task.assign", taskId: "T-2", machine: "duy-mbp" }, reason: "Minh is away" }, leader);
    assert.deepEqual([action.kind, action.status, action.input.machineId], ["task.assign", "proposed", mbp.name]);
    // A member who may chat but not queue runs cannot confirm it.
    await assert.rejects(hive.call("chat.decide", { actionId: action.id, accept: true }, dev), fails("errors.need.chatApprove"));
    const done = await hive.call("chat.decide", { actionId: action.id, accept: true }, lead);
    assert.deepEqual([done.status, done.result?.taskId], ["done", "T-2"]);
    assert.deepEqual((await sent(mbp)).map((r) => r.taskId), ["T-2"]);
  });
});
