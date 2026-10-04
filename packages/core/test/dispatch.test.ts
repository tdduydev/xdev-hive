import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const mini: Actor = { name: "runner.lan-mini@lan-mini", role: "agent" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };

const profile = (id: string, enabled = true) => ({
  id,
  label: id,
  kind: id.split("-")[0]!,
  enabled,
  account: null,
  installed: true,
  cooldownUntil: null,
  runs: 0,
  rateLimited: 0,
});

async function hub() {
  const clock = { at: Date.parse("2026-09-29T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "Login page" }, admin);
  await hive.call("tasks.create", { id: "T-2", project: "app", title: "Logout", dependsOn: ["T-1"] }, admin);
  await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
  const beat = (actor: Actor, over: Record<string, unknown> = {}) =>
    hive.call(
      "machines.heartbeat",
      {
        machine: actor.name.split("@")[1]!,
        instance: "a1b2c3d4",
        profiles: [profile("claude-1"), profile("codex-1", false)],
        projects: ["app", "site"],
        acceptsRuns: true,
        ...over,
      },
      actor,
    );
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  return { hive, beat, later };
}

/** The error key a call fails with. */
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

describe("run requests from the web", () => {
  it("keeps which repos a machine has and whether it takes runs; an older app counts as neither", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await hive.call("machines.heartbeat", { machine: "lan-mini", instance: "b1b2c3d4" }, mini);
    const list = await hive.call("machines.list", {}, admin);
    assert.deepEqual(
      list.map((m) => [m.machine, m.projects, m.acceptsRuns]).sort(),
      [
        ["duy-mbp", ["app", "site"], true],
        ["lan-mini", [], false],
      ],
    );
    // A project the viewer does not see stays out of the list, like its runs.
    const [seen] = (await hive.call("machines.list", {}, lead)).filter((m) => m.machine === "duy-mbp");
    assert.deepEqual(seen!.projects, ["app"]);
  });

  it("hands a manager's request to that machine only, at its next heartbeat, and records the answer", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini);
    const req = await hive.call(
      "runs.dispatch",
      { machineId: mbp.name, project: "app", taskId: "T-1", reviewAfter: true, instructions: "Keep the old URL working." },
      lead,
    );
    assert.deepEqual(
      [req.status, req.machine, req.role, req.profileId, req.candidates, req.taskTitle, req.requestedBy],
      ["pending", "duy-mbp", "implement", null, 1, "Login page", "lan"],
    );
    assert.deepEqual((await beat(mini)).runRequests, []);
    const [sent] = (await beat(mbp)).runRequests;
    assert.deepEqual([sent!.id, sent!.reviewAfter, sent!.instructions], [req.id, true, "Keep the old URL working."]);

    assert.equal(await refusal(hive.call("runs.requestResult", { id: req.id, status: "accepted", runId: "R-1" }, mini)), "forbidden");
    const taken = await hive.call("runs.requestResult", { id: req.id, status: "accepted", runId: "R-abc123" }, mbp);
    assert.deepEqual([taken.status, taken.runId, taken.error], ["accepted", "R-abc123", null]);
    assert.deepEqual((await beat(mbp)).runRequests, [], "answered: not sent again");
    assert.equal(await refusal(hive.call("runs.requestResult", { id: req.id, status: "rejected" }, mbp)), "errors.runRequestNotPending");

    const [entry] = await hive.call("admin.audit", { action: "runs.dispatch" }, admin);
    assert.deepEqual([entry!.actor, entry!.target, entry!.detailKey], ["lan", "app/T-1", "audit.runDispatch"]);
  });

  it("keeps the kind a rotating run prefers, and none for a pinned one (roadmap 24c)", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const req = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1", preferKind: "codex" }, lead);
    assert.equal(req.preferKind, "codex");
    const [sent] = (await beat(mbp)).runRequests;
    assert.equal(sent!.preferKind, "codex", "the machine hears it with the request");
    const { request } = await hive.call("runs.prompt", { project: "app", prompt: "Go", machineId: mbp.name, profileId: "claude-1", preferKind: "codex" }, lead);
    assert.equal(request.preferKind, null, "a pinned profile wins");
    assert.equal((await hive.call("runs.prompt", { project: "app", prompt: "Go on", machineId: mbp.name }, lead)).request.preferKind, null);
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1", preferKind: "custom" as never }, lead)), "bad_request");
  });

  it("keeps the reason a machine refused, cleaned for the web", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const req = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, lead);
    const secret = `ghp_${"a".repeat(36)}`;
    const refused = await hive.call(
      "runs.requestResult",
      {
        id: req.id,
        status: "rejected",
        runId: "R-ignored",
        error: { message: `git push failed\ntoken ${secret}`, key: "errors.projectNotAdded", vars: { project: "app" } },
      },
      mbp,
    );
    assert.equal(refused.status, "rejected");
    assert.equal(refused.runId, null, "a refused request has no run");
    assert.equal(refused.error!.key, "errors.projectNotAdded");
    assert.deepEqual(refused.error!.vars, { project: "app" });
    assert.match(refused.error!.message, /^git push failed\n/);
    assert.ok(!refused.error!.message.includes(secret), "the secret-looking line is hidden");
  });

  it("only lets a project manager queue runs, on projects they see", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const input = { machineId: mbp.name, project: "app", taskId: "T-1" };
    assert.equal(await refusal(hive.call("runs.dispatch", input, dev)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("runs.dispatch", input, mbp)), "errors.need.runDispatch", "an agent token never queues runs");
    assert.equal(await refusal(hive.call("runs.dispatch", input, outsider)), "errors.notFound", "a hidden project answers like a missing one");
    assert.equal(await refusal(hive.call("runs.dispatch", input, { name: "viewer", role: "viewer" })), "errors.roleTooLow");
    assert.equal((await hive.call("runs.dispatch", input, admin)).status, "pending");
  });

  it("refuses what the machine's Board would refuse, before anything is sent", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp, { projects: ["site"], acceptsRuns: false });
    const ask = (over: Record<string, unknown> = {}) =>
      refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1", ...over }, admin));
    assert.equal(await ask({ machineId: "runner.nobody@x" }), "errors.machineNotFound");
    assert.equal(await ask(), "errors.machineNoHubRuns");
    await beat(mbp, { projects: ["site"] });
    assert.equal(await ask(), "errors.machineNoRepo");
    await beat(mbp);
    assert.equal(await ask({ taskId: "S-1" }), "errors.taskNotInProject");
    assert.equal(await ask({ taskId: "T-2" }), "errors.taskWaiting");
    assert.equal(await ask({ profileId: "codex-1" }), "errors.profileNotOnMachine", "a disabled profile");
    assert.equal(await ask({ profileId: "gemini-1" }), "errors.profileNotOnMachine");
    assert.equal(await ask({ role: "review", candidates: 2 }), "errors.candidatesImplementOnly");
    assert.equal(await ask({ profileId: "claude-1", candidates: 2 }), "errors.candidatesPinned");
    assert.equal(await ask({ instructions: "use ​this" }), "errors.hidden.zeroWidth", "hidden characters would reach the agent's prompt");

    await hive.call("tasks.update", { id: "T-1", status: "done" }, admin);
    assert.equal(await ask(), "errors.taskDone");
    await hive.call("tasks.update", { id: "T-1", status: "todo" }, admin);

    later(3);
    assert.equal(await ask(), "errors.machineOffline");
  });

  it("allows one request per task, and none while a machine runs it", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const first = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin);
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin)), "errors.runRequestOpen");
    await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R-abc123" }, mbp);
    await beat(mbp, {
      runs: [{ runId: "R-abc123", project: "app", taskId: "T-1", taskTitle: "Login page", role: "implement", status: "running", profileId: "claude-1", since: "2026-09-29T08:00:00.000Z" }],
    });
    assert.equal(await refusal(hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin)), "errors.taskRunning");
  });

  it("lets a manager withdraw a request no machine took; one nobody took expires", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp);
    const req = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, lead);
    assert.equal(await refusal(hive.call("runs.cancelRequest", { id: req.id }, dev)), "errors.need.runDispatch");
    assert.equal((await hive.call("runs.cancelRequest", { id: req.id }, lead)).status, "cancelled");
    assert.deepEqual((await beat(mbp)).runRequests, []);
    assert.equal(await refusal(hive.call("runs.cancelRequest", { id: req.id }, lead)), "errors.runRequestNotPending");
    assert.equal(await refusal(hive.call("runs.cancelRequest", { id: 999 }, lead)), "errors.runRequestNotFound");

    const again = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, lead);
    later(16);
    const [expired] = await hive.call("runs.requests", { project: "app" }, lead);
    assert.deepEqual([expired!.id, expired!.status], [again.id, "expired"]);
  });

  it("tells the web at once when the machine stops taking runs", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const req = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, lead);
    assert.deepEqual((await beat(mbp, { acceptsRuns: false })).runRequests, []);
    const [after] = await hive.call("runs.requests", {}, lead);
    assert.deepEqual([after!.id, after!.status, after!.error?.key, after!.error?.vars], [req.id, "rejected", "errors.machineNoHubRuns", { machine: "duy-mbp" }]);
  });

  it("lists requests newest first, only of projects the reader sees", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const a = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin);
    const s = await hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1", role: "plan" }, admin);
    assert.deepEqual((await hive.call("runs.requests", {}, admin)).map((r) => r.id), [s.id, a.id]);
    assert.deepEqual((await hive.call("runs.requests", {}, lead)).map((r) => r.id), [a.id]);
    assert.equal(await refusal(hive.call("runs.requests", { project: "site" }, lead)), "errors.notFound");
    assert.deepEqual((await hive.call("runs.requests", { project: "site" }, outsider)).map((r) => [r.taskId, r.role]), [["S-1", "plan"]]);
  });
});

describe("cancelling a run from the web", () => {
  const push = (hive: SqliteHive, actor: Actor, runId: string, status: string, project = "app") =>
    hive.call(
      "runs.push",
      {
        machine: actor.name.split("@")[1]!,
        runs: [{ runId, project, taskId: "T-1", taskTitle: "Login page", role: "implement", status: status as never, profileId: "claude-1", createdAt: "2026-09-29T08:00:00.000Z" }],
      },
      actor,
    );

  it("asks the machine at its heartbeats until it reports the run ended", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await push(hive, mbp, "R-aaaaaa", "running");
    await push(hive, mbp, "R-bbbbbb", "queued");
    assert.deepEqual((await beat(mbp)).cancelRuns, []);

    const asked = await hive.call("runs.cancel", { machineId: mbp.name, runId: "R-aaaaaa" }, lead);
    assert.deepEqual([asked.status, asked.cancelRequestedBy], ["running", "lan"], "the run goes on until the machine stops it");
    await hive.call("runs.cancel", { machineId: mbp.name, runId: "R-bbbbbb" }, admin);
    // A second click keeps who asked first.
    assert.equal((await hive.call("runs.cancel", { machineId: mbp.name, runId: "R-aaaaaa" }, admin)).cancelRequestedBy, "lan");
    assert.deepEqual((await beat(mbp)).cancelRuns, [
      { runId: "R-aaaaaa", requestedBy: "lan" },
      { runId: "R-bbbbbb", requestedBy: "duy" },
    ]);
    assert.deepEqual((await beat(mini)).cancelRuns, [], "only that machine's runs");

    // The machine stopped it and pushed it: asked no more, and what was asked stays on the record.
    await push(hive, mbp, "R-aaaaaa", "cancelled");
    assert.deepEqual((await beat(mbp)).cancelRuns, [{ runId: "R-bbbbbb", requestedBy: "duy" }]);
    const [record] = (await hive.call("runs.list", { project: "app" }, admin)).filter((r) => r.runId === "R-aaaaaa");
    assert.deepEqual([record!.status, record!.cancelRequestedBy], ["cancelled", "lan"]);
    assert.equal(await refusal(hive.call("runs.cancel", { machineId: mbp.name, runId: "R-aaaaaa" }, lead)), "errors.runEnded");
    // Nothing while it takes no runs from the hub: its user did not let the web drive it.
    assert.deepEqual((await beat(mbp, { acceptsRuns: false })).cancelRuns, []);
  });

  it("only lets a project manager cancel, on a machine that takes runs from the hub", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await beat(mini, { acceptsRuns: false });
    await push(hive, mbp, "R-aaaaaa", "running");
    await push(hive, mini, "R-cccccc", "running");
    await push(hive, mbp, "R-dddddd", "running", "site");
    assert.equal(await refusal(hive.call("runs.cancel", { machineId: mbp.name, runId: "R-aaaaaa" }, dev)), "errors.need.runDispatch");
    assert.equal(await refusal(hive.call("runs.cancel", { machineId: mbp.name, runId: "R-dddddd" }, lead)), "errors.notFound", "a project it cannot see");
    assert.equal(await refusal(hive.call("runs.cancel", { machineId: mini.name, runId: "R-cccccc" }, admin)), "errors.machineNoHubRuns");
    assert.equal(await refusal(hive.call("runs.cancel", { machineId: mbp.name, runId: "R-ffffff" }, admin)), "errors.runNotFound");
  });
});

describe("a free prompt from the web (roadmap 32b)", () => {
  it("makes task P-<n> and the request to run it, in one go", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const prompt = "Add a dark theme toggle to the settings page.\n\nKeep the current colours as the light theme.";
    const first = await hive.call("runs.prompt", { project: "app", prompt, machineId: mbp.name, profileId: "claude-1", reviewAfter: true }, lead);
    assert.deepEqual([first.task.id, first.task.project, first.task.title, first.task.status, first.task.note], ["P-1", "app", "Add a dark theme toggle to the settings page.", "todo", prompt]);
    assert.deepEqual(
      [first.request.taskId, first.request.taskTitle, first.request.profileId, first.request.reviewAfter, first.request.instructions, first.request.requestedBy],
      ["P-1", first.task.title, "claude-1", true, "", "lan"],
      "the agent reads the prompt once, as the task's note",
    );
    const [sent] = (await beat(mbp)).runRequests;
    assert.equal(sent!.taskId, "P-1", "the machine gets it like any dispatched run");

    const long = `Rewrite the importer.\n${"x".repeat(2500)}`;
    const third = await hive.call("runs.prompt", { project: "app", prompt: long, machineId: mbp.name }, lead);
    assert.equal(third.task.note, long.slice(0, 2000));
    assert.equal(third.request.instructions, long, "a note cut short: the whole prompt goes as the instructions");

    const second = await hive.call("runs.prompt", { project: "app", title: "  Fix the footer  ", prompt: "The footer overlaps on phones.", machineId: mbp.name }, lead);
    assert.deepEqual([second.task.id, second.task.title, second.request.profileId], ["P-3", "Fix the footer", null]);

    const [entry] = await hive.call("admin.audit", { action: "runs.prompt" }, admin);
    assert.deepEqual([entry!.actor, entry!.target, entry!.detailKey], ["lan", "app/P-3", "audit.runPrompt"]);
  });

  it("numbers past any P-<n> already on the hub, in any project", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    await hive.call("tasks.create", { id: "P-7", project: "site", title: "By hand" }, admin);
    await hive.call("tasks.create", { id: "P-9b", project: "app", title: "Not a number" }, admin);
    const { task } = await hive.call("runs.prompt", { project: "app", prompt: "Go", machineId: mbp.name }, admin);
    assert.equal(task.id, "P-8");
  });

  it("leaves no task behind when a check fails", async () => {
    const { hive, beat, later } = await hub();
    await beat(mbp, { acceptsRuns: false });
    const ask = (over: Record<string, unknown> = {}) => refusal(hive.call("runs.prompt", { project: "app", prompt: "Go", machineId: mbp.name, ...over }, admin));
    assert.equal(await ask(), "errors.machineNoHubRuns");
    await beat(mbp);
    assert.equal(await ask({ profileId: "codex-1" }), "errors.profileNotOnMachine");
    assert.equal(await ask({ prompt: "use ​this" }), "errors.hidden.zeroWidth");
    assert.equal(await ask({ prompt: `deploy with ghp_${"a".repeat(36)}` }), "errors.secret");
    assert.equal(await ask({ title: `token ghp_${"b".repeat(36)}` }), "errors.secret");
    later(3);
    assert.equal(await ask(), "errors.machineOffline");
    const tasks = await hive.call("tasks.list", { project: "app" }, admin);
    assert.deepEqual(tasks.map((t) => t.id).sort(), ["T-1", "T-2"]);
  });

  it("needs both queueing runs and making tasks in the project", async () => {
    const { hive, beat } = await hub();
    await beat(mbp);
    const input = { project: "app", prompt: "Go", machineId: mbp.name };
    assert.equal(await refusal(hive.call("runs.prompt", input, dev)), "errors.need.taskManage");
    assert.equal(await refusal(hive.call("runs.prompt", input, mbp)), "errors.need.taskManage", "an agent token never sends prompts");
    assert.equal(await refusal(hive.call("runs.prompt", input, outsider)), "errors.notFound");
    assert.equal((await hive.call("runs.prompt", input, lead)).task.id, "P-1");
  });
});
