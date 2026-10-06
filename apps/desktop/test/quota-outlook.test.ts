import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { quotaOutlook, readCodexUsage, type UsageSample } from "#desktop/main/runner/usage.ts";
import { RunStore } from "#desktop/main/runner/store.ts";
import type { PlanUsage } from "@xdev-hive/core";

const now = new Date("2026-10-06T00:00:00.000Z");
const usage = (session = 40, week = 20): PlanUsage => ({ session: { percent: session, resets: null, resetsAt: "2026-10-06T05:00:00.000Z" }, week: { percent: week, resets: null, resetsAt: "2026-10-06T15:00:00.000Z" }, others: [], checkedAt: now.toISOString() });
it("counts reset boundaries, including a session after the weekly reset", () => {
  assert.equal(quotaOutlook(usage(), [], now)?.resetsLeft, 3);
  const u = usage(); u.session!.resetsAt = "2026-10-07T00:00:00Z";
  assert.equal(quotaOutlook(u, [], now)?.resetsLeft, 0);
  u.session!.resetsAt = null;
  assert.equal(quotaOutlook(u, [], now)?.resetsLeft, null);
});
it("uses the median of three completed windows and excludes weekly resets", () => {
  const history: UsageSample[] = [];
  for (const [i, cost] of [10, 20, 90].entries()) {
    const at = new Date(+now - (4 - i) * 5 * 3600_000);
    const reset = new Date(+at + 5 * 3600_000).toISOString();
    history.push({ at: at.toISOString(), session: 0, week: 0, sessionResetsAt: reset });
    history.push({ at: new Date(+at + 3600_000).toISOString(), session: 100, week: cost, sessionResetsAt: reset });
  }
  history.push({ at: now.toISOString(), session: 40, week: 20, sessionResetsAt: usage().session!.resetsAt! });
  const out = quotaOutlook(usage(), history, now)!;
  assert.equal(out.weekPerSession, 20);
  assert.equal(out.fullSessionsLeft, 4);
  assert.equal(quotaOutlook({ ...usage(), week: null }, history, now)?.fullSessionsLeft, null);
  assert.equal(quotaOutlook(usage(), history.slice(0, 4), now)?.weekPerSession, 50);
  assert.equal(quotaOutlook(usage(2, 3), [], now)?.fullSessionsLeft, null);
  assert.equal(quotaOutlook(usage(0, 20), [], now)?.weekPerSession, null);
});
it("stores unique observed samples, retains fourteen days and survives reopening", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quota-store-"));
  try {
    const file = path.join(dir, "runs.db"); let store = new RunStore(file);
    const sample = { at: now.toISOString(), session: 40, week: 20, sessionResetsAt: null };
    store.recordUsage("p", sample, now); store.recordUsage("p", sample, now);
    assert.equal(store.usageHistory("p", now).length, 1);
    store.db.close(); store = new RunStore(file);
    assert.equal(store.usageHistory("p", now).length, 1);
    const later = new Date(+now + 15 * 86400_000);
    store.recordUsage("q", { ...sample, at: later.toISOString() }, later);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM profile_usage_history WHERE profile_id = 'p'").get()!.n, 0);
    store.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("reads Codex credits, plan and spending cap while skipping premium rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quota-codex-"));
  try {
    const sessions = path.join(dir, "sessions/2026/10/06"); mkdirSync(sessions, { recursive: true });
    const event = (rate_limits: object) => JSON.stringify({ timestamp: now.toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits } });
    writeFileSync(path.join(sessions, "rollout-fixture.jsonl"), [event({ limit_id: "codex", primary: { used_percent: 40, window_minutes: 300, resets_at: +now / 1000 + 18000 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: +now / 1000 + 54000 }, credits: { has_credits: true, unlimited: false, balance: "12.50" }, plan_type: "pro", spend_control_reached: true }), event({ limit_id: "premium", primary: null, secondary: null })].join("\n"));
    const u = readCodexUsage(dir, now)!;
    assert.deepEqual(u.credits, { hasCredits: true, unlimited: false, balance: "12.50" });
    assert.equal(u.planType, "pro"); assert.equal(u.spendControlReached, true);
    assert.equal(u.session!.resetsAt, "2026-10-06T05:00:00.000Z");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not turn a weekly reset into a completed-window ratio", () => {
  const history: UsageSample[] = [
    { at: "2026-10-05T18:00:00Z", session: 10, week: 95, sessionResetsAt: "2026-10-05T23:00:00Z" },
    { at: "2026-10-05T19:00:00Z", session: 20, week: 2, sessionResetsAt: "2026-10-05T23:00:00Z" },
    { at: "2026-10-05T20:00:00Z", session: 30, week: 4, sessionResetsAt: "2026-10-05T23:00:00Z" },
  ];
  assert.equal(quotaOutlook(usage(40, 20), history, now)?.weekPerSession, 50);
});
