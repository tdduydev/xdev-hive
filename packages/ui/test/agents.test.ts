import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenWindows, type AgentProfileStatus, type PlanUsage } from "@xdev-hive/core";
import { machineQuota, countdown, meterTone, needsHand, profileRows, profileState, quotaView, rowFix } from "#ui/lib/agents.ts";
import { translate } from "#ui/i18n/translate.ts";

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
  codexLocalhost: false,
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
  stats: { runs: 0, succeeded: 0, failed: 0, rateLimited: 0, costUsd: 0, since: null },
  tokens: tokenWindows([], new Date()),
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

});

describe("quota block (roadmap 52)", () => {
  // A fake clock: 14:00 in Hà Nội on 6/10.
  const now = Date.parse("2026-10-06T07:00:00Z");
  const limit = (percent: number, resetsAt: string | null) => ({ percent, resets: resetsAt ? "Oct 8 at 5:59pm (Asia/Saigon)" : null, resetsAt });
  const plan = (session: ReturnType<typeof limit> | null, week: ReturnType<typeof limit> | null): PlanUsage => ({ session, week, others: [], checkedAt: "2026-10-06T06:50:00Z" });
  const stats = { runs: 14, succeeded: 11, failed: 1, rateLimited: 2, costUsd: 3.2, since: null };

  it("has all four parts on every row: both limits, the counts, the rest and the read", () => {
    const view = quotaView(
      profile({ usage: plan(limit(41, "2026-10-06T09:15:00Z"), limit(83, "2026-10-09T07:00:00Z")), stats, cooldownUntil: "2026-10-06T09:40:00Z", cooldownReason: "usage limit" }),
      now,
    );
    assert.deepEqual(view.session, { known: true, percent: 41, stop: 95, tone: "ok", resets: "Oct 8 at 5:59pm (Asia/Saigon)", resetsAt: "2026-10-06T09:15:00Z", left: { days: 0, hours: 2, minutes: 15 } });
    assert.equal(view.week.known && view.week.tone, "near", "83% is within 10 points of the week's 90% stop");
    assert.deepEqual(view.counts, { hitLimit: 2, runs: 14, done: 11, failed: 1, since: null });
    assert.deepEqual(view.rest, { until: "2026-10-06T09:40:00Z", reason: "usage limit" });
    assert.equal(view.canRead, true);
    assert.equal(quotaView(profile({ enabled: false }), now).canRead, false, "the main process does not check an off profile");
  });

  it("counts down to the reset with the clock, in whole minutes rounded up", () => {
    assert.deepEqual(countdown("2026-10-06T09:15:00Z", now), { days: 0, hours: 2, minutes: 15 });
    assert.deepEqual(countdown("2026-10-09T07:00:00Z", now), { days: 3, hours: 0, minutes: 0 });
    assert.deepEqual(countdown("2026-10-06T07:00:20Z", now), { days: 0, hours: 0, minutes: 1 }, "seconds left are not 0 minutes");
    // A minute later the page shows a minute less.
    assert.deepEqual(countdown("2026-10-06T09:15:00Z", now + 60_000), { days: 0, hours: 2, minutes: 14 });
    assert.equal(countdown("2026-10-06T06:59:00Z", now), null, "past");
    assert.equal(countdown(null, now), null);
    assert.equal(countdown("Oct 8 at 5:59pm (Asia/Saigon)", now), null, "the CLI's text is not an instant");
  });

  it("says why a limit is not known", () => {
    const signedOut = { loggedIn: false, method: null, loginCommand: "codex login", checkedAt: "" };
    const signedIn = { ...signedOut, loggedIn: true };
    const why = (over: Partial<AgentProfileStatus>) => {
      const v = quotaView(profile(over), now).week;
      return v.known ? null : v.why;
    };
    assert.equal(why({ kind: "codex", login: signedOut }), "signedOut");
    assert.equal(why({ kind: "codex", login: signedIn }), "noSession");
    assert.equal(why({ kind: "claude", login: null }), "notChecked");
    assert.equal(why({ kind: "gemini", login: signedIn }), "noReport");
    assert.equal(why({ login: signedIn, usage: plan(limit(41, null), null) }), "noReport", "a session alone: the week is still unknown");
  });

  it("colours the bar from the profile's own stop threshold", () => {
    assert.deepEqual([meterTone(40, 95), meterTone(85, 95), meterTone(95, 95), meterTone(100, 100)], ["ok", "near", "over", "over"]);
  });

  it("shows Bỏ nghỉ whenever the profile rests, even next to another button of the row", () => {
    const signedOut = { loggedIn: false, method: null, loginCommand: "claude auth login", checkedAt: "" };
    const p = profile({ login: signedOut, cooldownUntil: "2026-10-06T09:40:00Z" });
    assert.equal(rowFix(p), "login");
    assert.ok(quotaView(p, now).rest, "the rest has its own button");
    assert.equal(rowFix(profile({ cliPath: null, cooldownUntil: "2026-10-06T09:40:00Z" })), "installCli");
    assert.ok(quotaView(profile({ cliPath: null, cooldownUntil: "2026-10-06T09:40:00Z" }), now).rest);
    assert.equal(quotaView(profile(), now).rest, null);
  });

  it("writes the counts from the reset date once the counter was reset", () => {
    const since = (p: AgentProfileStatus) => {
      const c = quotaView(p, now).counts;
      return c.since ? translate("agents.quota.since", { date: c.since.slice(0, 10) }, "vi") : translate("agents.quota.sinceStart", undefined, "vi");
    };
    assert.equal(since(profile({ stats })), "từ đầu");
    assert.equal(since(profile({ stats: { ...stats, runs: 0, succeeded: 0, failed: 0, rateLimited: 0, since: "2026-10-06T07:00:00Z" } })), "từ 2026-10-06");
    assert.equal(translate("agents.quota.hitLimit", { count: 2 }, "en"), "Hit the limit 2 times");
  });
});


it("counts only available slots and finds the earliest future reset", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  const u = usage(20, 30); u.session!.resetsAt = "2026-10-06T05:00:00Z";
  const profiles = [profile({ maxConcurrent: 3, running: 1, usage: u }), profile({ enabled: false }), profile({ cliPath: null }), profile({ usage: usage(99, 30) }), profile({ cooldownUntil: "2026-10-07T00:00:00Z" }), profile({ running: 1 })];
  assert.deepEqual(machineQuota(profiles, now), { count: 1, slots: 2, reset: "2026-10-06T05:00:00Z", label: "Claude Max (gói 1)" });
});
