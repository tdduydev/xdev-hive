import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Machine, MachineRun, QuotaCooldown, ReportedProfile } from "@xdev-hive/core";
import { decodeTargets, encodeTargets, hubIntakeControl, machineCards, mapMachines, profileCard } from "#ui/lib/agentmap.ts";

const now = Date.parse("2026-10-02T10:00:00Z");
const profile = (over: Partial<ReportedProfile> = {}): ReportedProfile => ({ id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0, ...over });
const run = (over: Partial<MachineRun> = {}): MachineRun => ({ runId: "R-1", project: "app", taskId: "T-1", taskTitle: "x", role: "implement", status: "running", profileId: "claude-1", since: "2026-10-02T09:50:00Z", ...over });
const machine = (over: Partial<Machine> = {}): Machine =>
  ({ id: "runner.mbp@t", machine: "mbp", version: "0.120.0", lastSeen: "2026-10-02T09:59:50Z", online: true, duplicate: false, runs: [], profiles: [profile()], projects: ["app"], acceptsRuns: true, owner: null, profileChanges: [], ...over }) as Machine;
const state = (p: Partial<ReportedProfile>, m: Partial<Machine> = {}, cooldowns: QuotaCooldown[] = []) => profileCard(machine(m), profile(p), cooldowns, now).state;

describe("agent map (roadmap 31b)", () => {
  it("shows pending hub intake until a capable machine reports its choice, and disables old apps", () => {
    const old = hubIntakeControl(machine({ runnerSettings: { maxParallel: 1, mrEnabled: false, mrWhen: "after_review" } }));
    assert.deepEqual(old, { supported: false, value: true, waiting: false });
    const pending = hubIntakeControl(machine({
      acceptsRuns: false,
      runnerSettings: { maxParallel: 1, mrEnabled: false, mrWhen: "after_review", acceptHubRuns: false },
      runnerChange: { settings: { acceptHubRuns: true }, requestedBy: "owner", requestedAt: "2026-10-02T10:00:00Z" },
    }));
    assert.deepEqual(pending, { supported: true, value: true, waiting: true });
  });
  it("says what each profile's card shows, the first that holds", () => {
    assert.equal(state({}, { online: false }), "offline");
    assert.equal(state({ enabled: false }), "off");
    assert.equal(state({ installed: false }), "noCli");
    assert.equal(state({ loggedIn: false }), "signedOut");
    assert.equal(state({ loggedIn: null }), "ready", "not known to be signed out");
    assert.equal(state({ overLimit: true }, { runs: [run()] }), "running", "a run going on shows before the limit");
    assert.equal(state({ overLimit: true }), "overLimit");
    assert.equal(state({ cooldownUntil: "2026-10-02T11:00:00Z" }), "resting");
    assert.equal(state({ cooldownUntil: "2026-10-02T09:00:00Z" }), "ready", "a rest that ended");
    assert.equal(state({}), "ready");
  });

  it("counts the runs against what the profile takes at once, and rests with its account", () => {
    const c = profileCard(machine({ runs: [run({ runId: "R-2", status: "queued" }), run({ runId: "R-1" })] }), profile({ maxConcurrent: 2, account: "duy@x" }), [{ account: "duy@x", until: "2026-10-02T12:00:00Z", reason: "limit", reportedBy: "mbp", updatedAt: "" }], now);
    assert.deepEqual([c.running, c.max, c.runs.map((r) => r.runId)], [1, 2, ["R-1", "R-2"]], "running first");
    assert.equal(c.restingUntil, "2026-10-02T12:00:00Z");
    assert.equal(profileCard(machine(), profile(), [], now).max, 1, "an app older than 0.110 takes one");
  });

  it("puts runs no profile claims in the machine's queue", () => {
    const { cards, queue } = machineCards(machine({ runs: [run(), run({ runId: "R-2", profileId: null, status: "queued" }), run({ runId: "R-3", profileId: "gone" })] }), [], now);
    assert.deepEqual(cards[0]!.runs.map((r) => r.runId), ["R-1"]);
    assert.deepEqual(queue.map((r) => r.runId), ["R-2", "R-3"]);
  });

  it("shows the machines with the picked project's repo, online first", () => {
    const list = [machine({ machine: "b", projects: ["app"], online: false }), machine({ machine: "c", projects: ["pay"] }), machine({ machine: "a", projects: ["app", "pay"] })];
    assert.deepEqual(mapMachines(list, { kind: "project", project: "app" }).map((m) => m.machine), ["a", "b"]);
    assert.deepEqual(mapMachines(list, { kind: "system", system: "shop", projects: ["pay"] }).map((m) => m.machine), ["a", "c"]);
    assert.deepEqual(mapMachines(list, { kind: "all" }).map((m) => m.machine), ["a", "c", "b"]);
  });

  it("carries picked agents to the Task page in its address", () => {
    const picks = [
      { machineId: "runner.mbp@t", profileId: "claude-1" },
      { machineId: "runner.mini@t", profileId: "codex-1" },
    ];
    assert.deepEqual(decodeTargets(encodeTargets(picks)), picks);
    assert.deepEqual(decodeTargets("runner.mbp@t|claude-1,broken,|x"), [picks[0]]);
    assert.deepEqual(decodeTargets(null), []);
  });
});
