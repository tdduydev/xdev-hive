import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentProfileSchema, type ProfileChange } from "@xdev-hive/core";
import { applyProfileChanges } from "#desktop/main/profile-changes.ts";

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
