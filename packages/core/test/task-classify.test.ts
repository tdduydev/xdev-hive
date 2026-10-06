import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTaskRule, DEFAULT_TASK_CLASS, HiveError, parseTaskClass, type Actor, type Task } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 54b: a task's kind, size and risk. The hub's rules first; a short classify run on the machine about to take a
// task with no kind; a person (or a confirmed leader proposal) over both.

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const dev: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { app: "contribute" } }, source: { via: "web" } };

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
  classify: true,
  ...over,
});

async function hub(profiles = [profile("claude-1")]) {
  const clock = { at: Date.parse("2026-10-06T08:00:00.000Z") };
  const hive = new SqliteHive(":memory:", { now: () => new Date(clock.at) });
  const beat = () => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", profiles, projects: ["app"], acceptsRuns: true }, mbp);
  const sent = async () => (await beat()).runRequests;
  const take = (id: number, runId: string) => hive.call("runs.requestResult", { id, status: "accepted", runId }, mbp);
  const push = (runId: string, taskId: string, role: string, status: string, summary: string | null = null) =>
    hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [{ runId, project: "app", taskId, taskTitle: taskId, role: role as never, status: status as never, profileId: "claude-1", summary, createdAt: "2026-10-06T08:00:00.000Z" }] },
      mbp,
    );
  const task = async (id: string): Promise<Task> => (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === id)!;
  const later = (minutes: number) => (clock.at += minutes * 60_000);
  await beat();
  return { hive, beat, sent, take, push, task, later };
}

const answer = (kind: string, size: string, risk: string) => JSON.stringify({ kind, size, risk, reason: "test" });

describe("task classification rules", () => {
  it("reads roles, Spec Kit steps and vi/en keywords, and leaves the rest empty", () => {
    assert.deepEqual(classifyTaskRule("Anything", null, "review"), { kind: "review" });
    assert.deepEqual(classifyTaskRule("Login page", null, null, "plan"), { kind: "spec" });
    assert.equal(classifyTaskRule("Viết tài liệu hướng dẫn", null).kind, "docs");
    assert.equal(classifyTaskRule("Add i18n strings", null).kind, "docs");
    assert.equal(classifyTaskRule("Gộp nhánh ai/R-1", null).kind, "merge");
    assert.equal(classifyTaskRule("Phát hành 0.136.0", null).kind, "ops");
    assert.equal(classifyTaskRule("Fix flaky e2e tests", null).kind, "test");
    assert.equal(classifyTaskRule("Investigate the API timeout", null).kind, "debug");
    assert.equal(classifyTaskRule("Sửa giao diện trang Chat", null).kind, "ui");
    assert.equal(classifyTaskRule("Tái cấu trúc runner", null).kind, "refactor");
    assert.equal(classifyTaskRule("Typo in the header", null).kind, "small-fix");
    // "review" outranks "docs": reviewing docs is a review.
    assert.equal(classifyTaskRule("Review the docs", null).kind, "review");
    // A note counts as much as the title.
    assert.equal(classifyTaskRule("T-12", "Viết test cho trang đăng nhập").kind, "test");
    assert.deepEqual(classifyTaskRule("Build the account flow", null), {});
    // "cài đặt" is settings as often as an install: left to the classify run.
    assert.deepEqual(classifyTaskRule("Thêm trang cài đặt", null), {});
    assert.deepEqual(classifyTaskRule("Login flow", "needs a migration of the users table"), { risk: "high" });
    assert.equal(classifyTaskRule("Đổi phân quyền dự án", null).risk, "high");
  });

  it("parses only a whole, known answer", () => {
    assert.deepEqual(parseTaskClass({ kind: "ui", size: "s", risk: "normal", reason: "x" }), { kind: "ui", size: "s", risk: "normal" });
    assert.equal(parseTaskClass({ kind: "ui", size: "xl", risk: "normal" }), null);
    assert.equal(parseTaskClass({ kind: "frontend", size: "s", risk: "normal" }), null);
    assert.equal(parseTaskClass("ui"), null);
  });
});

describe("task classification on the hub", () => {
  it("applies the rules on create, a person's choice over them, and keeps that choice through notes", async () => {
    const { hive, task } = await hub();
    const docs = await hive.call("tasks.create", { id: "T-1", project: "app", title: "Update docs for the migration" }, admin);
    assert.deepEqual([docs.kind, docs.size, docs.risk, docs.classifiedBy], ["docs", null, "high", "rule"]);
    const plain = await hive.call("tasks.create", { id: "T-2", project: "app", title: "Build account flow" }, admin);
    assert.deepEqual([plain.kind, plain.risk, plain.classifiedBy, plain.classifiedAt], [null, null, null, null]);
    // A note the rules can read fills the empty kind.
    await hive.call("tasks.update", { id: "T-2", status: "todo", note: "Viết test cho luồng tài khoản" }, admin);
    assert.deepEqual([(await task("T-2")).kind, (await task("T-2")).classifiedBy], ["test", "rule"]);
    // By hand: only what is given changes, and it is theirs from then on.
    const changed = await hive.call("tasks.classify", { id: "T-1", size: "s" }, admin);
    assert.deepEqual([changed.kind, changed.size, changed.risk, changed.classifiedBy], ["docs", "s", "high", "duy"]);
    await hive.call("tasks.update", { id: "T-1", status: "todo", note: "Debug the release script" }, admin);
    assert.equal((await task("T-1")).kind, "docs");
    // Given when it is created: the rules leave it alone.
    const given = await hive.call("tasks.create", { id: "T-3", project: "app", title: "Fix docs typo", kind: "small-fix", size: "s" }, admin);
    assert.deepEqual([given.kind, given.size, given.risk, given.classifiedBy], ["small-fix", "s", null, "duy"]);
    await assert.rejects(hive.call("tasks.classify", { id: "T-3" } as never, admin));
    // A contributor works tasks but does not manage them.
    await assert.rejects(hive.call("tasks.classify", { id: "T-3", kind: "ui" }, dev), (e: unknown) => e instanceof HiveError);
    hive.close();
  });

  it("runs a classify run before an assigned task with no kind, then its own run", async () => {
    const { hive, sent, take, push, task } = await hub();
    await hive.call("tasks.create", { id: "T-2", project: "app", title: "Build account flow" }, admin);
    await hive.call("tasks.assign", { id: "T-2", machineId: mbp.name }, admin);
    const first = await sent();
    assert.deepEqual(first.map((r) => [r.taskId, r.role]), [["T-2", "classify"]]);
    await take(first[0]!.id, "C-1");
    // Nothing more while the classify run goes.
    assert.deepEqual(await sent(), []);
    await push("C-1", "T-2", "classify", "running");
    await push("C-1", "T-2", "classify", "succeeded", answer("feature", "l", "normal"));
    const t = await task("T-2");
    assert.deepEqual([t.kind, t.size, t.risk, t.classifiedBy], ["feature", "l", "normal", "ai"]);
    const next = await sent();
    assert.deepEqual(next.map((r) => [r.taskId, r.role]), [["T-2", "implement"]]);
    hive.close();
  });

  it("gives the default class when the classify run fails or answers nonsense, and keeps a high risk the rules found", async () => {
    const { hive, sent, take, push, task } = await hub();
    await hive.call("tasks.create", { id: "T-3", project: "app", title: "Login flow", dependsOn: [] }, admin);
    await hive.call("tasks.update", { id: "T-3", status: "todo", note: "Touches permissions" }, admin);
    assert.deepEqual([(await task("T-3")).kind, (await task("T-3")).risk], [null, "high"]);
    await hive.call("tasks.assign", { id: "T-3", machineId: mbp.name }, admin);
    const [req] = await sent();
    assert.equal(req!.role, "classify");
    await take(req!.id, "C-2");
    await push("C-2", "T-3", "classify", "succeeded", "not JSON");
    const t = await task("T-3");
    assert.deepEqual([t.kind, t.size, t.risk, t.classifiedBy], [DEFAULT_TASK_CLASS.kind, DEFAULT_TASK_CLASS.size, "high", "ai"]);
    assert.deepEqual((await sent()).map((r) => r.role), ["implement"]);
    hive.close();

    const other = await hub();
    await other.hive.call("tasks.create", { id: "T-4", project: "app", title: "Billing flow" }, admin);
    await other.hive.call("tasks.assign", { id: "T-4", machineId: mbp.name }, admin);
    const [again] = await other.sent();
    assert.equal(again!.role, "classify");
    await other.take(again!.id, "C-3");
    await other.push("C-3", "T-4", "classify", "failed");
    assert.deepEqual([(await other.task("T-4")).kind, (await other.task("T-4")).risk], ["feature", "normal"]);
    other.hive.close();
  });

  it("stops waiting for a classify run that never reports", async () => {
    const { hive, sent, take, task, later } = await hub();
    await hive.call("tasks.create", { id: "T-5", project: "app", title: "Build account flow" }, admin);
    await hive.call("tasks.assign", { id: "T-5", machineId: mbp.name }, admin);
    const [req] = await sent();
    await take(req!.id, "C-5");
    later(11);
    const next = await sent();
    assert.equal((await task("T-5")).kind, "feature");
    assert.deepEqual(next.map((r) => r.role), ["implement"]);
    hive.close();
  });

  it("holds a runs.dispatch call until its classify run ends, then sends it as asked", async () => {
    const { hive, sent, take, push, task } = await hub();
    await hive.call("tasks.create", { id: "T-6", project: "app", title: "Build account flow" }, admin);
    const answered = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-6", instructions: "Keep it small" }, admin);
    assert.equal(answered.role, "classify");
    const [req] = await sent();
    await take(req!.id, "C-6");
    await push("C-6", "T-6", "classify", "succeeded", answer("ui", "s", "normal"));
    assert.equal((await task("T-6")).kind, "ui");
    const [run] = await sent();
    assert.deepEqual([run!.role, run!.instructions, run!.requestedBy], ["implement", "Keep it small", "duy"]);
    // A review needs no classify run, and a task only reviewed is a review.
    await hive.call("tasks.create", { id: "T-7", project: "app", title: "Check account flow" }, admin);
    const review = await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-7", role: "review" }, admin);
    assert.equal(review.role, "review");
    assert.equal((await task("T-7")).kind, "review");
    hive.close();
  });

  it("sends no classify run when the project turned it off or the machine cannot do one", async () => {
    const { hive, sent, task } = await hub();
    await hive.call("tasks.setClassifyConfig", { project: "app", enabled: false }, admin);
    assert.deepEqual(await hive.call("tasks.classifyConfig", {}, admin), [{ project: "app", enabled: false }]);
    await assert.rejects(hive.call("tasks.setClassifyConfig", { project: "app", enabled: true }, dev), (e: unknown) => e instanceof HiveError);
    await hive.call("tasks.create", { id: "T-8", project: "app", title: "Build billing flow" }, admin);
    await hive.call("tasks.assign", { id: "T-8", machineId: mbp.name }, admin);
    assert.deepEqual((await sent()).map((r) => r.role), ["implement"]);
    assert.equal((await task("T-8")).kind, null);

    // An app from before 54b reports no classify flag: its runs go as they always did.
    const old = await hub([profile("claude-1", { classify: undefined })]);
    await old.hive.call("tasks.create", { id: "T-9", project: "app", title: "Build billing flow" }, admin);
    await old.hive.call("tasks.assign", { id: "T-9", machineId: mbp.name }, admin);
    assert.deepEqual((await old.sent()).map((r) => r.role), ["implement"]);
    hive.close();
    old.hive.close();
  });

  it("marks a Spec Kit step's task as a spec", async () => {
    const { hive, task } = await hub();
    await hive.call("specs.runStep", { project: "app", step: "specify", taskId: "S-1", title: "Account settings", input: "Let users change their email", machineId: mbp.name, profileId: null }, admin);
    const t = await task("S-1");
    assert.deepEqual([t.kind, t.classifiedBy], ["spec", "rule"]);
    hive.close();
  });
});
