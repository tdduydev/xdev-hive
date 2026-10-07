import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { toolHash, type Actor, type HiveBackend } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner, type RunnerHost, type HubUpdate } from "#desktop/main/runner/runner.ts";
import { RunStore } from "#desktop/main/runner/store.ts";

const admin: Actor = { name: "admin", role: "admin" };
const cleanups: Array<() => Promise<void>> = [];
// Heartbeat never needs a git repo or an agent process. All state here lives in a temporary directory and in-memory hub.
async function fixture(options: Pick<RunnerHost, "toolTrust" | "applyToolTrust"> & { wrap?: (backend: HiveBackend) => HiveBackend }) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-tool-approve-"));
  const hive = new SqliteHive(":memory:");
  const hubUpdates: HubUpdate[] = [];
  const backend: HiveBackend = { call: (method, input, actor) => hive.call(method, input, { ...actor, name: `${actor.name}@test` }) };
  const runner = new Runner({
    backend: () => options.wrap?.(backend) ?? backend,
    profiles: () => [],
    settings: () => ({ maxParallel: 2, maxAttempts: 3, worktreeRoot: null, acceptHubRuns: false }),
    projects: () => [{ name: "demo", repo: dataDir }],
    mode: () => "hub",
    machine: () => "test",
    env: () => ({}),
    toolTrust: options.toolTrust,
    applyToolTrust: options.applyToolTrust,
  }, { dataDir, user: "test", onHub: (u) => hubUpdates.push(u), chatPollMs: 0 });
  cleanups.push(async () => { await runner.stop(); runner.store.db.close(); hive.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { hive, runner, dataDir, hubUpdates };
}

describe("tool approvals from heartbeat (58b)", () => {
  it("persists the pinned approval before work, acknowledges it, and never restores a locally revoked decision on replay", async () => {
    let trust: Record<string, string> = {};
    let persisted = 0;
    const { hive, runner, hubUpdates, dataDir } = await fixture({
      toolTrust: () => trust,
      applyToolTrust: (next) => { trust = next; persisted++; },
    });
    const rtk = (await hive.call("tools.list", {}, admin)).find((e) => e.id === "rtk")!;
    await hive.call("tools.setProject", { id: "rtk", project: "demo", enabled: true }, admin);
    await runner.heartbeat();
    await runner.heartbeat();
    const machineId = (await hive.call("machines.list", {}, admin))[0]!.id;
    const approval = await hive.call("machines.approveTool", { machineId, toolId: "rtk", hash: toolHash(rtk) }, admin);
    await runner.heartbeat();
    assert.equal(trust.rtk, toolHash(rtk));
    assert.equal(persisted, 1);
    assert.ok(runner.store.toolApprovalApplied(approval.id));
    // Persisted receipt survives reopening the DB; a local revoke must not be overwritten even before hub ACK.
    trust = {};
    const reopened = new RunStore(path.join(dataDir, "runs.db"));
    assert.ok(reopened.toolApprovalApplied(approval.id));
    reopened.db.close();
    await runner.heartbeat();
    assert.equal(trust.rtk, undefined);
    assert.equal(persisted, 1);
    assert.equal(hubUpdates.at(-1)?.toolApprovals?.length, 0);
    const status = (await hive.call("machines.tools", { machineId }, admin)).tools.find((t) => t.id === "rtk")!;
    assert.equal(status.trust, "new");
    assert.ok(status.approval?.appliedAt);
    // A fresh human decision, after local revocation, may allow exactly the same commands again.
    const fresh = await hive.call("machines.approveTool", { machineId, toolId: "rtk", hash: toolHash(rtk) }, admin);
    assert.notEqual(fresh.id, approval.id);
    await runner.heartbeat();
    assert.equal(persisted, 2);
    await runner.stop();
  });

  it("ignores absent tools and mismatched hashes, and retries after a config write fails", async () => {
    let trust: Record<string, string> = {};
    let fail = true;
    let decision: NonNullable<HubUpdate["toolApprovals"]>[number] | undefined;
    const { hive, runner } = await fixture({
      toolTrust: () => trust,
      applyToolTrust: (next) => { if (fail) throw new Error("config write failed"); trust = next; },
      wrap: (backend) => ({ call: async (method, input, actor) => {
        const result = await backend.call(method, input, actor);
        return method === "machines.heartbeat" && decision ? { ...result as object, toolApprovals: [decision] } as typeof result : result;
      } }),
    });
    const rtk = (await hive.call("tools.list", {}, admin)).find((e) => e.id === "rtk")!;
    await hive.call("tools.setProject", { id: "rtk", project: "demo", enabled: true }, admin);
    await runner.heartbeat();
    await runner.heartbeat();
    const machineId = (await hive.call("machines.list", {}, admin))[0]!.id;
    const approval = await hive.call("machines.approveTool", { machineId, toolId: "rtk", hash: toolHash(rtk) }, admin);
    decision = { ...approval, hash: "0".repeat(64) };
    await runner.heartbeat();
    assert.deepEqual(trust, {});
    decision = { ...approval, toolId: "missing" };
    await runner.heartbeat();
    assert.deepEqual(trust, {});
    decision = approval;
    await assert.rejects(runner.heartbeat(), /config write failed/);
    assert.equal(runner.store.toolApprovalApplied(approval.id), false);
    fail = false;
    await runner.heartbeat();
    assert.equal(trust.rtk, toolHash(rtk));
    // Delayed/replayed response after revocation cannot apply the same decision twice.
    trust = {};
    await runner.heartbeat();
    assert.deepEqual(trust, {});
    await runner.stop();
  });
});

after(async () => { for (const cleanup of cleanups) await cleanup(); });
