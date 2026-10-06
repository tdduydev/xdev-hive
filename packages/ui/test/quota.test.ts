import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Machine, ReportedProfile } from "@xdev-hive/core";
import { quotaRows, quotaTotals } from "#ui/lib/quota.ts";
const now = Date.parse("2026-10-06T10:00:00Z");
const profile = (extra: Partial<ReportedProfile> = {}): ReportedProfile => ({ id: "p", label: "Plan", kind: "codex", enabled: true, installed: true, loggedIn: true, account: "shared", cooldownUntil: null, runs: 0, rateLimited: 0, fullSessionsLeft: 9, resetsLeft: 23, usageCheckedAt: "2026-10-06T09:00:00Z", ...extra });
const machine = (id: string, p = profile(), extra: Partial<Machine> = {}): Machine => ({ id, machine: id, profiles: [p], online: true, acceptsRuns: true, duplicate: false, runs: [], projects: [], lastSeen: "", owner: null, version: "", profileChanges: [], ...extra });
describe("team quota outlook", () => {
  it("counts shared quota once and sums capacity across its machines", () => {
    const rows = quotaRows([machine("a", profile({ maxConcurrent: 2 })), machine("b")], [], now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.members.length, 2);
    assert.equal(quotaRows([machine("a", profile({ maxConcurrent: 2 })), machine("b")], [], now, "b")[0]!.slots, 1);
    assert.deepEqual(quotaTotals(rows), { available: 1, slots: 3, full: 9, unknown: 0, nextAt: null });
  });
  it("counts occupancy hidden by project permissions", () => {
    const row = quotaRows([machine("a", profile({ maxConcurrent: 3, running: 2 }))], [], now)[0]!;
    assert.equal(row.slots, 1);
    assert.equal(row.members[0]!.card.running, 2);
  });
  it("uses newest usage even when filtering a machine would select the old copy", () => {
    const rows = quotaRows([machine("a"), machine("b", profile({ fullSessionsLeft: 3, usageCheckedAt: "2026-10-06T09:30:00Z", overLimit: true }))], [], now);
    assert.equal(rows[0]!.full, 3);
    assert.equal(rows[0]!.slots, 0);
  });
  it("blocks exhausted shared reports and selects the next weekly replenishment", () => {
    const weekAt = "2026-10-12T10:00:00Z";
    const row = quotaRows([machine("a", profile({ weekPercent: 100, sessionResetsAt: "2026-10-06T15:00:00Z", weekResetsAt: weekAt }))], [], now)[0]!;
    assert.equal(row.slots, 0);
    assert.equal(row.nextAt, weekAt);
    assert.equal(quotaRows([machine("a", profile({ sessionPercent: 100 }))], [], now)[0]!.slots, 0);
    assert.equal(quotaRows([machine("a", profile({ spendControlReached: true }))], [], now)[0]!.slots, 0);
  });
  it("separates providers and unidentified profiles, flags missing estimates", () => {
    const rows = quotaRows([machine("a"), machine("b", profile({ kind: "claude" })), machine("c", profile({ account: null, fullSessionsLeft: null })), machine("d", profile({ account: null, fullSessionsLeft: 100 }))], [], now);
    assert.equal(rows.length, 4);
    assert.equal(quotaTotals(rows).full, 41);
    assert.equal(quotaTotals(rows).unknown, 1);
    assert.equal(quotaTotals([]).full, null);
  });
  it("excludes offline, nonaccepting, duplicated, logged out and busy capacity", () => {
    for (const extra of [{ online: false }, { acceptsRuns: false }, { duplicate: true }]) assert.equal(quotaRows([machine("a", profile(), extra)], [], now)[0]!.slots, 0);
    assert.equal(quotaRows([machine("a", profile({ loggedIn: false }))], [], now)[0]!.slots, 0);
    assert.equal(quotaRows([machine("a", profile({ overLimit: true }), { runs: [{ runId: "r", project: "", taskId: "", taskTitle: "", role: "implement", status: "running", profileId: "p", since: "" }] })], [], now)[0]!.slots, 0);
    assert.equal(quotaRows([machine("a")], [{ account: "shared", until: "2026-10-06T12:00:00Z", reason: "", reportedBy: "", updatedAt: "" }], now)[0]!.slots, 0);
  });
});
