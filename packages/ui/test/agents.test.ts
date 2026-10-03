import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfileStatus, PlanUsage } from "@xdev-hive/core";
import { hasUsage, needsHand, profileRows, profileState } from "#ui/lib/agents.ts";

const usage = (session: number | null, week: number | null): PlanUsage => ({
  session: session === null ? null : { percent: session, resets: null },
  week: week === null ? null : { percent: week, resets: null },
  others: [],
  checkedAt: "2026-10-03T10:00:00Z",
});

const profile = (over: Partial<AgentProfileStatus> = {}): AgentProfileStatus => ({
  id: "claude-max-1",
  label: "Claude Max (gói 1)",
  kind: "claude",
  bin: "claude",
  args: ["{prompt}"],
  env: {},
  enabled: true,
  readOnly: false,
  container: null,
  priority: 10,
  roles: ["plan", "implement", "review"],
  maxConcurrent: 1,
  cooldownMinutes: 60,
  timeoutMinutes: 60,
  stopAtSession: 95,
  stopAtWeek: 90,
  running: 0,
  cooldownUntil: null,
  cooldownReason: null,
  cooldownFrom: null,
  cliPath: "/usr/local/bin/claude",
  login: null,
  usage: null,
  hasToken: false,
  lastUsedAt: null,
  stats: { runs: 0, succeeded: 0, failed: 0, rateLimited: 0, costUsd: 0 },
  autonomy: { own: "full", flag: null, hub: null, projects: [] },
  ...over,
});

const signedOut = { loggedIn: false, method: null, loginCommand: "claude auth login", checkedAt: "" };

describe("agent rows (roadmap 39c)", () => {
  it("gives each subscription one state, the first that holds", () => {
    assert.equal(profileState(profile({ enabled: false, cliPath: null })), "off", "off before anything else");
    assert.equal(profileState(profile({ cliPath: null })), "noCli");
    assert.equal(profileState(profile({ login: signedOut })), "signedOut");
    assert.equal(profileState(profile({ login: { ...signedOut, loggedIn: null } })), "ready", "not known to be signed out");
    assert.equal(profileState(profile({ running: 1, usage: usage(99, 10) })), "running", "a run going on shows before a limit");
    assert.equal(profileState(profile({ usage: usage(99, 10) })), "overLimit");
    assert.equal(profileState(profile({ usage: usage(10, 95) })), "overLimit", "the week has its own threshold");
    assert.equal(profileState(profile({ cooldownUntil: "2026-10-03T12:00:00Z" })), "resting");
    assert.equal(profileState(profile({ usage: usage(86, 10) })), "near");
    assert.equal(profileState(profile({ usage: usage(41, 83) })), "ready");
  });

  it("marks the states whose row carries a button that fixes them", () => {
    assert.deepEqual(
      (["noCli", "signedOut", "overLimit", "resting", "off", "ready", "near", "running"] as const).filter(needsHand),
      ["noCli", "signedOut"],
    );
  });

  it("folds the off subscriptions away and puts what needs a hand first", () => {
    const rows = profileRows([
      profile({ id: "codex-plus", usage: usage(5, 5) }),
      profile({ id: "claude-box", enabled: false }),
      profile({ id: "claude-max-2", login: signedOut }),
      profile({ id: "gemini-pro", usage: usage(41, 83) }),
    ]);
    assert.deepEqual(rows.on.map((p) => p.id), ["claude-max-2", "codex-plus", "gemini-pro"], "the signed-out one up, the rest in order");
    assert.deepEqual(rows.off.map((p) => p.id), ["claude-box"]);
  });

  it("asks for the one footnote under the table only while a row has no numbers to show", () => {
    assert.equal(profileRows([profile({ usage: usage(41, 83) })]).someWithoutUsage, false);
    assert.equal(profileRows([profile({ usage: usage(41, null) })]).someWithoutUsage, false, "a session alone is still numbers");
    assert.equal(profileRows([profile({ usage: usage(41, 83) }), profile({ id: "codex-plus", kind: "codex" })]).someWithoutUsage, true);
    assert.equal(hasUsage(profile({ usage: usage(null, null) })), false, "a check that found neither limit");
  });
});
