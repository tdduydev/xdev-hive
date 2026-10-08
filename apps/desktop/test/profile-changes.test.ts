import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, saveConfig, loadConfig } from "@xdev-hive/core/node";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentProfileSchema, type ProfileChange } from "@xdev-hive/core";
import { applyProfileChanges, applyRunnerChange } from "#desktop/main/profile-changes.ts";

const profile = (id: string, over: Record<string, unknown> = {}) => agentProfileSchema.parse({ id, label: id, kind: "claude", bin: "claude", args: [], ...over });
const change = (profileId: string, enabled: boolean | null, priority: number | null): ProfileChange => ({
  machineId: "runner.duy-mbp@duy-mbp",
  profileId,
  enabled,
  priority,
  requestedBy: "tu",
  requestedAt: "2026-10-02T03:00:00.000Z",
});

describe("profile changes from the hub (roadmap 18d)", () => {
  it("turns a profile off and moves another's priority, leaving the rest as they are", () => {
    const agents = [profile("claude-1"), profile("codex-1", { kind: "codex", bin: "codex", priority: 20 }), profile("claude-2")];
    const { agents: next, applied } = applyProfileChanges(agents, [change("claude-1", false, null), change("codex-1", null, 5)]);
    assert.deepEqual(next.map((p) => [p.id, p.enabled, p.priority]), [["claude-1", false, 10], ["codex-1", true, 5], ["claude-2", true, 10]]);
    assert.deepEqual(applied.map((a) => a.profile.id), ["claude-1", "codex-1"]);
    assert.equal(next[2], agents[2], "untouched profiles are the same objects");
    assert.equal(agents[0]!.enabled, true, "the input is not changed");
  });

  it("does nothing for a change already in, or for a profile this machine does not have", () => {
    const agents = [profile("claude-1", { enabled: false })];
    const { agents: next, applied } = applyProfileChanges(agents, [change("claude-1", false, 10), change("gemini-1", true, null)]);
    assert.deepEqual(applied, []);
    assert.deepEqual(next, agents);
  });
});

it("updates stop thresholds, preserves local profile configuration and is idempotent", () => {
  const agents = [profile("claude-1", { env: { LOCAL: "keep" }, stopAtSession: 95, stopAtWeek: 90 })];
  const changes = [{ ...change("claude-1", null, null), stopAtSession: 60, stopAtWeek: 50 }];
  const result = applyProfileChanges(agents, changes);
  assert.equal(result.agents[0]!.stopAtSession, 60);
  assert.equal(result.agents[0]!.stopAtWeek, 50);
  assert.deepEqual(result.agents[0]!.env, agents[0]!.env);
  assert.equal(result.applied.length, 1);
  assert.equal(applyProfileChanges(result.agents, changes).applied.length, 0);
});

it("saves runner and threshold changes without losing unrelated local config", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-remote-settings-"));
  try {
    const file = join(dir, "config.json");
    const config = configSchema.parse({ runner: { maxParallel: 2, maxAttempts: 5 }, gitlab: { mr: { enabled: false, labels: ["custom"] } }, agents: [profile("claude-1")] });
    const next = applyRunnerChange(config, { settings: { maxParallel: 1, mrEnabled: true, mrWhen: "after_success" }, requestedBy: "tu", requestedAt: "2026-10-08T00:00:00.000Z" });
    next.agents = applyProfileChanges(config.agents, [{ ...change("claude-1", null, null), stopAtSession: 70, stopAtWeek: 60 }]).agents;
    saveConfig(next, file);
    const loaded = loadConfig(file);
    assert.equal(loaded.runner.maxParallel, 1);
    assert.equal(loaded.runner.maxAttempts, 5);
    assert.equal(loaded.gitlab.mr.enabled, true);
    assert.equal(loaded.gitlab.mr.when, "after_success");
    assert.deepEqual(loaded.gitlab.mr.labels, ["custom"]);
    assert.equal(loaded.agents[0]!.stopAtSession, 70);
    assert.equal(loaded.agents[0]!.stopAtWeek, 60);
    assert.equal(config.runner.maxParallel, 2);
    assert.equal(config.gitlab.mr.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
