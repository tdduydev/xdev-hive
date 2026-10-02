import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor, type RunMr } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Duy's machine ran the task on his token: the run is his. Hoa reviews code in app, Minh only works on tasks there.
const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "member", onBehalf: "duy", account: "duy" };
const hoa: Actor = { name: "hoa", role: "member", account: "hoa", access: { projects: { app: "reviewer" } } };
const minh: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { app: "member" } } };
const duy: Actor = { name: "duy", role: "member", account: "duy", access: { projects: { app: "reviewer" } } };
const MR = "https://gitlab.example/team/app/-/merge_requests/7";

const mr = (over: Partial<RunMr> = {}): RunMr => ({ iid: 7, status: "opened", draft: false, pipeline: "success", pipelineUrl: "https://gitlab.example/team/app/-/pipelines/90", checkedAt: "2026-10-02T03:00:00.000Z", ...over });
const run = (over: Record<string, unknown> = {}) => ({
  runId: "R-abc123",
  project: "app",
  taskId: "T-1",
  taskTitle: "Login page",
  role: "implement" as const,
  status: "succeeded" as const,
  profileId: "claude-1",
  mrUrl: MR,
  mr: mr(),
  createdAt: "2026-10-02T02:00:00.000Z",
  finishedAt: "2026-10-02T02:30:00.000Z",
  ...over,
});

function clock(start = "2026-10-02T03:00:00.000Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => (t += minutes * 60_000) };
}

async function setup(opts: { accepts?: boolean; mr?: RunMr | null } = {}) {
  const c = clock();
  const hive = new SqliteHive(":memory:", { now: c.now });
  const beat = () => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: opts.accepts ?? true }, machine);
  await beat();
  await hive.call("runs.push", { machine: "duy-mbp", runs: [run(opts.mr === undefined ? {} : { mr: opts.mr })] }, machine);
  const merge = (actor: Actor) => hive.call("runs.merge", { machineId: machine.name, runId: "R-abc123" }, actor);
  const get = async () => (await hive.call("runs.get", { machineId: machine.name, runId: "R-abc123" }, { name: "admin", role: "admin" }))!;
  return { hive, c, beat, merge, get };
}
const fails = (key: string) => (e: unknown) => e instanceof HiveError && e.key === key;

describe("merge from the web (roadmap 18c)", () => {
  it("keeps the MR as the machine last saw it, and only an http(s) pipeline link", async () => {
    const { hive, get } = await setup();
    assert.deepEqual((await get()).mr, mr());
    // An older app sends no mr: the hub keeps what it had.
    const { mr: _, ...old } = run({ summary: "again" });
    await hive.call("runs.push", { machine: "duy-mbp", runs: [old] }, machine);
    assert.deepEqual((await get()).mr, mr());
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run({ mr: mr({ pipeline: "running", pipelineUrl: "javascript:alert(1)" }) })] }, machine);
    assert.deepEqual((await get()).mr, mr({ pipeline: "running", pipelineUrl: null }));
  });

  it("lets a reviewer of the project merge, not a member, nor the one whose run it is", async () => {
    const { merge } = await setup();
    await assert.rejects(merge(minh), (e: unknown) => e instanceof HiveError && e.code === "forbidden");
    await assert.rejects(merge(duy), fails("errors.selfApprove"));
    const r = await merge(hoa);
    assert.equal(r.merge?.status, "pending");
    assert.equal(r.merge?.requestedBy, "hoa");
  });

  it("sends the merge at each heartbeat until the machine reports, then shows it merged", async () => {
    const { hive, beat, merge, get } = await setup();
    await merge(hoa);
    assert.deepEqual((await beat()).mergeRuns, [{ runId: "R-abc123", mrUrl: MR, requestedBy: "hoa" }]);
    assert.equal((await beat()).mergeRuns.length, 1, "again until it reports");
    const done = await hive.call("runs.mergeResult", { runId: "R-abc123", ok: true }, machine);
    assert.equal(done.merge?.status, "merged");
    assert.equal(done.mr?.status, "merged", "merged at once, before the watcher's next look");
    assert.deepEqual((await beat()).mergeRuns, []);
    await assert.rejects(merge(hoa), fails("errors.mrNotOpen"));
    assert.equal((await hive.call("admin.audit", { limit: 20 }, { name: "admin", role: "admin" })).find((e) => e.action === "runs.merge")?.actor, "hoa");
    assert.equal((await get()).merge?.finishedAt !== null, true);
  });

  it("keeps the forge's reason when the merge fails, and lets someone try again", async () => {
    const { hive, merge } = await setup();
    await merge(hoa);
    const failed = await hive.call("runs.mergeResult", { runId: "R-abc123", ok: false, error: { message: "GitLab 405: Method Not Allowed" } }, machine);
    assert.deepEqual([failed.merge?.status, failed.merge?.error?.message, failed.mr?.status], ["failed", "GitLab 405: Method Not Allowed", "opened"]);
    assert.equal((await merge(hoa)).merge?.status, "pending");
  });

  it("refuses a draft, a failed pipeline, a run without MR, a second merge, and a machine that takes no runs from the hub", async () => {
    await assert.rejects((await setup({ mr: mr({ draft: true }) })).merge(hoa), fails("errors.mrDraft"));
    await assert.rejects((await setup({ mr: mr({ pipeline: "failed" }) })).merge(hoa), fails("errors.mrPipelineFailed"));
    await assert.rejects((await setup({ accepts: false })).merge(hoa), fails("errors.machineNoHubRuns"));
    const s = await setup();
    await s.hive.call("runs.push", { machine: "duy-mbp", runs: [run({ runId: "R-plain1", mrUrl: null, mr: null })] }, machine);
    await assert.rejects(s.hive.call("runs.merge", { machineId: machine.name, runId: "R-plain1" }, hoa), fails("errors.runNoMr"));
    // Its review run points at the same MR: one merge at a time.
    await s.hive.call("runs.push", { machine: "duy-mbp", runs: [run({ runId: "R-rev001", role: "review" })] }, machine);
    await s.merge(hoa);
    await assert.rejects(s.hive.call("runs.merge", { machineId: machine.name, runId: "R-rev001" }, hoa), fails("errors.mergePending"));
  });

  it("fails a merge no machine reported on within 15 minutes; another machine cannot report it", async () => {
    const { hive, c, merge, get } = await setup();
    await merge(hoa);
    const other: Actor = { name: "runner.lan-mbp@lan-mbp", role: "member", onBehalf: "lan" };
    await assert.rejects(hive.call("runs.mergeResult", { runId: "R-abc123", ok: true }, other), (e: unknown) => e instanceof HiveError && e.code === "not_found");
    c.advance(16);
    await hive.call("machines.heartbeat", { machine: "lan-mbp", instance: "b1b2c3d4", projects: ["app"] }, other);
    const r = await get();
    assert.deepEqual([r.merge?.status, r.merge?.error?.key], ["failed", "errors.mergeExpired"]);
  });
});
