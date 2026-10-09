import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { type Actor } from "#core/index.ts";
import { ROUTED_KINDS } from "#core/model-router.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "manager", role: "admin" };
const runner: Actor = { name: "runner", role: "agent" };
const profile = (id = "codex-1", extra = {}) => ({ id, label: id, kind: id.split("-")[0]!, enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, ...extra });
function fixture(file = ":memory:") {
  const hive = new SqliteHive(file);
  const beat = (extra = {}, actor = runner) => hive.call("machines.heartbeat", { machine: actor.name, instance: "aabbccdd", projects: ["app"], profiles: [profile()], acceptsRuns: true, maxParallel: 2, ...extra }, actor);
  const create = (id: string, extra = {}) => hive.call("tasks.create", { id, project: "app", title: `Fix ${id}`, kind: "small-fix", size: "s", ...extra }, admin);
  const enable = (extra = {}) => hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, autoDispatch: true, ...extra } }, admin);
  const tasks = () => hive.call("tasks.list", { project: "app" }, admin);
  return { hive, beat, create, enable, tasks };
}

describe("auto-dispatch (60a)", () => {
  it("routes platform tasks only to a matching heartbeat OS, including manual dispatch", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    const mac: Actor = { name: "mac-runner", role: "agent" };
    await beat({ platform: "linux" });
    await beat({ platform: "mac" }, mac);
    await create("mac-only", { platforms: ["mac"] });
    assert.deepEqual((await tasks())[0]?.platforms, ["mac"]);
    await assert.rejects(hive.call("runs.dispatch", { project: "app", taskId: "mac-only", machineId: runner.name }, admin), (e: unknown) => (e as { key?: string }).key === "errors.machinePlatformMismatch");
    await enable();
    assert.equal((await beat()).runRequests.length, 0);
    assert.equal((await beat({ platform: "mac" }, mac)).runRequests[0]?.taskId, "mac-only");
    hive.close();
  });

  it("normalizes a Windows heartbeat and rejects an unknown machine OS", async () => {
    const { hive, beat, create } = fixture();
    const unknown: Actor = { name: "old-runner", role: "agent" };
    await beat({ platform: "win" });
    await beat({}, unknown);
    await create("win-only", { platforms: ["windows"] });
    assert.equal((await hive.call("machines.list", {}, admin)).find((m) => m.id === runner.name)?.platform, "windows");
    await assert.rejects(hive.call("runs.dispatch", { project: "app", taskId: "win-only", machineId: unknown.name }, admin), (e: unknown) => (e as { key?: string }).key === "errors.machinePlatformMismatch");
    assert.equal((await hive.call("runs.dispatch", { project: "app", taskId: "win-only", machineId: runner.name }, admin)).machineId, runner.name);
    hive.close();
  });

  it("requires explicit opt-in, preserves it on unrelated edits, resets it explicitly", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    await create("T1");
    assert.equal((await beat()).runRequests.length, 0);
    await enable();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { review: "auto" } } }, admin);
    assert.equal((await hive.call("sdlc.get", {}, admin)).projects.app?.autoDispatch, true);
    const sent = (await beat()).runRequests;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.profileId, "codex-1");
    assert.equal((await tasks())[0]?.agent?.by, "manager");
    assert.ok(sent[0]?.selection);
    const audit = await hive.call("admin.audit", {}, admin);
    assert.equal(audit.filter((a) => a.action === "tasks.autoAssign").length, 1);
    await beat();
    assert.equal((await hive.call("admin.audit", {}, admin)).filter((a) => a.action === "tasks.autoAssign").length, 1);
    await hive.call("sdlc.setProject", { project: "app", settings: null }, admin);
    assert.equal((await hive.call("sdlc.get", {}, admin)).projects.app?.autoDispatch, false);
    hive.close();
  });

  it("orders priority, open dependents, then insertion age, never updated time", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    await create("old"); await create("blocker");
    await create("dependent", { dependsOn: ["blocker"] });
    await create("urgent", { priority: 0 });
    await hive.call("tasks.update", { id: "old", status: "todo", note: "edited last" }, admin);
    await enable({ maxParallel: 3 });
    const sent = (await beat({ profiles: [profile("codex-1", { maxConcurrent: 5 })], maxParallel: 3 })).runRequests;
    assert.deepEqual(sent.map((r) => r.taskId), ["urgent", "blocker", "old"]);
    assert.equal((await tasks()).find((t) => t.id === "dependent")?.agent, null);
    hive.close();
  });

  it("counts pending and accepted-unreported requests across machines against the service cap", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    await create("T1"); await create("T2"); await enable({ maxParallel: 1 });
    const first = (await beat()).runRequests[0]!;
    await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R1" }, runner);
    assert.equal((await beat({}, { name: "other", role: "agent" })).runRequests.length, 0);
    assert.equal((await tasks()).find((t) => t.id === "T2")?.agent, null);
    await hive.call("runs.push", { machine: "runner", runs: [{ runId: "R1", project: "app", taskId: "T1", taskTitle: "T1", role: "implement", status: "succeeded", profileId: "codex-1", createdAt: new Date().toISOString() }] }, runner);
    await beat();
    assert.ok((await tasks()).find((t) => t.id === "T2")?.agent);
    hive.close();
  });

  it("honors machine maxParallel even with several free profiles", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    await create("T1"); await create("T2"); await enable();
    assert.equal((await beat({ maxParallel: 1, profiles: [profile(), profile("claude-1")] })).runRequests.length, 1);
    assert.equal((await tasks()).filter((t) => t.agent).length, 1);
    hive.close();
  });

  it("uses two idle plans without charging one plan for the other's pending request", async () => {
    const { hive, beat, create, enable } = fixture();
    await create("T1"); await create("T2"); await enable();
    const sent = (await beat({ maxParallel: 2, profiles: [profile(), profile("claude-1")] })).runRequests;
    assert.equal(sent.length, 2);
    assert.equal(new Set(sent.map((r) => r.profileId)).size, 2);
    hive.close();
  });

  it("filters quota, disabled plans, missing login, cooldown and allowed vendors", async () => {
    const { hive, beat, create, enable } = fixture();
    await create("T1"); await enable({ allowedAgentKinds: ["codex"] });
    for (const extra of [{ overLimit: true }, { enabled: false }, { installed: false }, { loggedIn: false }, { cooldownUntil: "2099-01-01T00:00:00Z" }]) {
      assert.equal((await beat({ profiles: [profile("codex-1", extra), profile("claude-1")] })).runRequests.length, 0);
    }
    assert.equal((await beat()).runRequests.length, 1);
    hive.close();
  });

  it("honors the latest shared-account quota report", async () => {
    const { hive, beat, create, enable } = fixture();
    await beat({ projects: [], profiles: [profile("codex-other", { account: "same", overLimit: true, usageCheckedAt: "2026-10-07T10:00:00Z" })] }, { name: "other", role: "agent" });
    await create("T1"); await enable();
    assert.equal((await beat({ profiles: [profile("codex-1", { account: "same", usageCheckedAt: "2026-10-07T09:00:00Z" })] })).runRequests.length, 0);
    hive.close();
  });

  it("leaves account-specific model version resolution to the runner", async () => {
    const { hive, beat, create, enable } = fixture();
    try {
      await create("T1"); await enable();
      const sent = (await beat({ profiles: [profile("codex-1", { supportedModels: ["gpt-6.1-sol"] })] })).runRequests;
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.profileId, "codex-1");
    } finally { hive.close(); }
  });

  it("does not take leased, blocked, assigned, or manually dispatched tasks", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    for (const id of ["leased", "blocked", "manual", "assigned"]) await create(id);
    await hive.call("tasks.claim", { id: "leased" }, admin);
    await hive.call("tasks.update", { id: "blocked", status: "blocked" }, admin);
    await beat({ maxParallel: 8, profiles: [profile("codex-1", { maxConcurrent: 8 })] });
    await hive.call("tasks.assign", { id: "assigned", machineId: "runner", profileId: "codex-1" }, admin);
    await hive.call("runs.dispatch", { project: "app", taskId: "manual", machineId: "runner" }, admin);
    await enable(); await beat({ maxParallel: 8, profiles: [profile("codex-1", { maxConcurrent: 8 })] });
    assert.equal((await tasks()).filter((t) => t.agent).length, 1);
    assert.equal((await hive.call("admin.audit", {}, admin)).filter((a) => a.action === "tasks.autoAssign").length, 0);
    hive.close();
  });

  it("waits while paused and respects an empty allowlist and a busy machine", async () => {
    const { hive, beat, create, enable } = fixture();
    await create("T1"); await enable();
    await hive.call("agents.stop", { project: "app" }, admin);
    assert.equal((await beat()).runRequests.length, 0);
    await hive.call("agents.resume", { project: "app" }, admin);
    await enable({ allowedAgentKinds: [] });
    assert.equal((await beat()).runRequests.length, 0);
    await enable({ allowedAgentKinds: ["codex"] });
    assert.equal((await beat({ acceptsRuns: false })).runRequests.length, 0);
    assert.equal((await beat({ maxParallel: 1, runs: [{ runId: "other", project: "elsewhere", taskId: "busy", taskTitle: "Busy", role: "implement", status: "running", since: new Date().toISOString(), profileId: "codex-1" }] })).runRequests.length, 0);
    assert.equal((await beat()).runRequests.length, 1);
    hive.close();
  });

  it("selects a plan-capable runner and reserves its project slot through approval", async () => {
    const { hive, beat, create, enable } = fixture();
    await create("T1"); await create("T2");
    await enable({ maxParallel: 1, planApproval: { mode: "all", timeoutMinutes: null } });
    const sent = (await beat({ profiles: [profile("claude-old"), profile("codex-new", { planApproval: true })] })).runRequests;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.profileId, "codex-new");
    assert.equal(sent[0]?.plan?.phase, "plan");
    assert.equal((await beat({}, { name: "other", role: "agent" })).runRequests.length, 0);
    hive.close();
  });

  it("holds a failed assignment when there is no resumable branch", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    await create("T1"); await enable();
    const first = (await beat()).runRequests[0]!;
    await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R1" }, runner);
    await hive.call("runs.push", { machine: "runner", runs: [{ runId: "R1", project: "app", taskId: "T1", taskTitle: "T1", role: "implement", status: "failed", profileId: "codex-1", createdAt: new Date().toISOString() }] }, runner);
    assert.ok((await tasks())[0]?.agent?.hold);
    assert.equal((await beat()).runRequests.length, 0);
    hive.close();
  });

  it("redispatches once on another plan, preserves the branch and blocks after the retry fails", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    try {
      await create("T1"); await enable();
      const profiles = [profile("codex-1", { redispatch: true, priority: 0 }), profile("claude-2", { redispatch: true })];
      const first = (await beat({ profiles })).runRequests[0]!;
      assert.equal(first.profileId, "codex-1");
      await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R1" }, runner);
      await hive.call("tasks.claim", { id: "T1" }, runner);
      const fail = (runId: string, profileId: string) => hive.call("runs.push", { machine: "runner", runs: [{ runId, project: "app", taskId: "T1", taskTitle: "T1", role: "implement", status: "failed", profileId, branch: "ai/T1", baseSha: "a".repeat(40), createdAt: new Date().toISOString(), error: "fixture failure" }] }, runner);
      await fail("R1", "codex-1");
      const retry = (await beat({ profiles })).runRequests[0]!;
      assert.equal(retry.profileId, "claude-2");
      assert.deepEqual(retry.redispatch, { machineId: "runner", runId: "R1", continueBranch: true, branch: "ai/T1", baseSha: "a".repeat(40) });
      await fail("R1", "codex-1");
      assert.equal((await tasks())[0]?.agent?.hold, null);
      await hive.call("runs.requestResult", { id: retry.id, status: "accepted", runId: "R2" }, runner);
      await fail("R2", "claude-2");
      const task = (await tasks())[0]!;
      assert.equal(task.status, "blocked"); assert.ok(task.agent?.hold);
      assert.match(task.note!, /R2/);
      assert.equal((await beat({ profiles })).runRequests.length, 0);
      const run = await hive.call("runs.get", { machineId: "runner", runId: "R2" }, admin);
      assert.equal(run?.parentRun, "R1");
    } finally { hive.close(); }
  });

  it("uses every routed plan kind until the service picks some, as the dispatch editor shows", async () => {
    const { hive, beat, create, enable } = fixture();
    await create("T1");
    const view = await enable();
    assert.deepEqual(view.projects.app?.allowedAgentKinds, [...ROUTED_KINDS]);
    const requests = (await beat({ profiles: [profile("gemini-1")] })).runRequests;
    assert.deepEqual(requests.map((r) => r.profileId), ["gemini-1"]);
    hive.close();
  });

  it("holds human cancellation without scheduling an automatic retry", async () => {
    const { hive, beat, create, enable, tasks } = fixture();
    try {
      await create("T1"); await enable();
      const first = (await beat({ profiles: [profile("codex-1", { redispatch: true })] })).runRequests[0]!;
      await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R1" }, runner);
      await hive.call("runs.push", { machine: "runner", runs: [{ runId: "R1", project: "app", taskId: "T1", taskTitle: "T1", role: "implement", status: "cancelled", profileId: "codex-1", branch: "ai/T1", createdAt: new Date().toISOString() }] }, runner);
      assert.ok((await tasks())[0]?.agent?.hold);
      assert.equal((await beat({ profiles: [profile("claude-2", { redispatch: true })] })).runRequests.length, 0);
    } finally { hive.close(); }
  });

  it("persists a waiting retry through restart and respects disabling auto-dispatch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-auto-retry-"));
    const file = path.join(dir, "hive.db");
    const { hive, beat, create, enable } = fixture(file);
    let closed = false;
    try {
      await create("T1"); await enable();
      const first = (await beat({ profiles: [profile("codex-1", { redispatch: true })] })).runRequests[0]!;
      await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "R1" }, runner);
      await hive.call("runs.push", { machine: "runner", runs: [{ runId: "R1", project: "app", taskId: "T1", taskTitle: "T1", role: "implement", status: "failed", profileId: "codex-1", branch: "ai/T1", createdAt: new Date().toISOString() }] }, runner);
      assert.equal((await beat()).runRequests.length, 0, "same plan cannot repeat the run");
      await hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, autoDispatch: false } }, admin);
      hive.close(); closed = true;
      const restarted = new SqliteHive(file);
      try {
        const heartbeat = () => restarted.call("machines.heartbeat", { machine: "runner", instance: "aabbccdd", projects: ["app"], acceptsRuns: true, profiles: [profile("claude-2", { redispatch: true })] }, runner);
        assert.equal((await heartbeat()).runRequests.length, 0);
        await restarted.call("sdlc.setProject", { project: "app", settings: { gates: {}, autoDispatch: true } }, admin);
        const retry = (await heartbeat()).runRequests[0]!;
        assert.equal(retry.redispatch?.runId, "R1");
        assert.equal(retry.profileId, "claude-2");
        assert.equal((await heartbeat()).runRequests.length, 1, "heartbeat repeats the same pending request");
      } finally { restarted.close(); }
    } finally { if (!closed) hive.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("upgrades a full previous database without losing tasks", async () => {
    const db = new DatabaseSync(":memory:");
    const hive = new SqliteHive(db);
    await hive.call("tasks.create", { id: "old", project: "app", title: "Old" }, admin);
    db.exec(`ALTER TABLE tasks DROP COLUMN agent_auto; ALTER TABLE tasks DROP COLUMN agent_retries; ALTER TABLE tasks DROP COLUMN agent_retry_source; ALTER TABLE tasks DROP COLUMN priority; ALTER TABLE machines DROP COLUMN max_parallel; PRAGMA user_version = ${migrationIndex("ALTER TABLE tasks ADD COLUMN priority")}`);
    const upgraded = new SqliteHive(db, { migrateTo: migrationIndex("ALTER TABLE tasks ADD COLUMN priority") + 1 });
    assert.equal((await upgraded.call("tasks.list", {}, admin))[0]?.priority, 50);
    assert.equal((await upgraded.call("sdlc.get", {}, admin)).projects.app?.autoDispatch, false);
    upgraded.close();
  });
});
