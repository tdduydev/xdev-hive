import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runnerSettingsSchema } from "@xdev-hive/core";
import { IdleUpdate } from "#desktop/main/idle-update.ts";
import type { UpdateStatus } from "#desktop/main/updater.ts";

function setup() {
  let now = 100_000;
  let enabled = true;
  let busy = true;
  let drain = false;
  let installs = 0;
  let install: () => Promise<void> = async () => { installs++; status.state = "installing"; };
  const status: UpdateStatus = { state: "ready", version: "0.142.0", percent: 100, error: null, installWhen: "quit", notes: null, supported: true };
  const logs: string[] = [];
  const idle = new IdleUpdate({ status: () => status, enabled: () => enabled, drain: (v) => { drain = v; }, work: () => ({ busy, deadline: 160_000 }), install: () => install(), log: (s) => logs.push(s), now: () => now });
  return { idle, status, logs, setBusy: (v: boolean) => { busy = v; }, setEnabled: (v: boolean) => { enabled = v; }, setNow: (v: number) => { now = v; }, setInstall: (v: () => Promise<void>) => { install = v; }, drain: () => drain, installs: () => installs };
}

describe("idle app update", () => {
  it("inherits hub intake by default and preserves an explicit opt-out", () => {
    const off = runnerSettingsSchema.parse({});
    const on = runnerSettingsSchema.parse({ acceptHubRuns: true });
    const explicit = runnerSettingsSchema.parse({ acceptHubRuns: true, autoUpdateIdle: false });
    assert.equal(off.autoUpdateIdle ?? off.acceptHubRuns, false);
    assert.equal(on.autoUpdateIdle ?? on.acceptHubRuns, true);
    assert.equal(explicit.autoUpdateIdle ?? explicit.acceptHubRuns, false);
  });

  it("holds intake after download, waits through final bookkeeping, and installs once", async () => {
    const s = setup();
    s.status.state = "downloading";
    await s.idle.tick();
    assert.equal(s.drain(), false);
    s.status.state = "ready";
    await s.idle.tick();
    assert.equal(s.drain(), true);
    assert.deepEqual(s.idle.status(), { idleState: "waiting", idleDeadline: 160_000 });
    await s.idle.tick();
    assert.equal(s.installs(), 0);
    s.setBusy(false);
    await Promise.all([s.idle.tick(), s.idle.tick(), s.idle.tick()]);
    assert.equal(s.installs(), 1);
    assert.equal(s.drain(), true);
  });

  it("keeps the old build at the deadline and resumes intake until the retry", async () => {
    const s = setup();
    await s.idle.tick();
    s.setNow(160_000);
    await s.idle.tick();
    assert.equal(s.drain(), false);
    assert.equal(s.installs(), 0);
    assert.deepEqual(s.idle.status(), { idleState: "retry", idleDeadline: 460_000 });
    s.setBusy(false);
    s.setNow(459_999);
    await s.idle.tick();
    assert.equal(s.installs(), 0);
    s.setNow(460_000);
    await s.idle.tick();
    assert.equal(s.installs(), 1);
    assert.ok(s.logs.some((l) => /deadline exceeded/.test(l)));
  });

  it("cancels the hold when disabled or when the hub withdraws the offer", async () => {
    for (const disable of [true, false]) {
      const s = setup();
      await s.idle.tick();
      if (disable) s.setEnabled(false); else s.status.state = "idle";
      s.setBusy(false);
      await s.idle.tick();
      assert.equal(s.drain(), false);
      assert.equal(s.installs(), 0);
    }
  });

  it("does not install development/unsupported builds or opt-outs even with an idle rollout", async () => {
    const s = setup();
    s.setBusy(false);
    s.status.supported = false;
    await s.idle.tick();
    s.status.supported = true;
    s.status.installWhen = "idle";
    s.setEnabled(false);
    await s.idle.tick();
    assert.equal(s.installs(), 0);
  });

  it("logs install failure and releases the hold, and cannot start an update during quit", async () => {
    const s = setup();
    s.setBusy(false);
    s.setInstall(async () => { throw new Error("Cannot unpack"); });
    await s.idle.tick();
    assert.equal(s.drain(), false);
    assert.equal(s.idle.status().idleState, "retry");
    assert.match(s.logs.at(-1)!, /Cannot unpack/);
    s.idle.stop();
    s.setNow(1_000_000);
    await s.idle.tick();
    assert.equal(s.drain(), true);
    assert.equal(s.installs(), 0);
  });
});
