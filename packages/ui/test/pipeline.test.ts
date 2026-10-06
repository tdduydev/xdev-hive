import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_AUTOMATION_GATES, type SdlcGateRecord } from "@xdev-hive/core";
import { gateMetrics, modeWithinCeiling, presetGates, stepCounts } from "#ui/lib/pipeline.ts";

const at = "2026-10-05T10:00:00.000Z";
const record = (over: Partial<SdlcGateRecord> = {}): SdlcGateRecord => ({ id: 1, project: "app", taskId: "F-1", gate: "spec", mode: "human", status: "passed", decidedBy: "lan", note: null, createdAt: at, decidedAt: "2026-10-05T12:00:00.000Z", ...over });

describe("pipeline page", () => {
  it("caps every preset gate and keeps the fast path's existing gates", () => {
    const ceiling = { ...MAX_AUTOMATION_GATES, spec: "human" as const, merge: "ai" as const };
    assert.equal(presetGates("maximum", ceiling).spec, "human");
    assert.equal(presetGates("maximum", ceiling).merge, "ai");
    assert.equal(presetGates("balanced", ceiling).review, "ai");
    assert.equal(presetGates("cautious", ceiling).plan, "human");
    assert.deepEqual(presetGates("fast", ceiling, presetGates("balanced", ceiling)), presetGates("balanced", ceiling));
    assert.equal(modeWithinCeiling("auto", "ai"), false);
  });
  it("counts current stages and uses 30-day decisions for median wait and first-pass rate", () => {
    const counts = stepCounts([
      { taskId: "F-1", project: "app", dir: null, step: "specify", state: "gate", machineId: "m", machine: "m", profileId: null, gate: null, note: null, createdBy: "lan", createdAt: at, updatedAt: at },
    ], []);
    assert.equal(counts.spec, 1);
    const metrics = gateMetrics([record(), record({ id: 2, status: "rejected", decidedAt: "2026-10-05T16:00:00.000Z" }), record({ id: 3, createdAt: "2026-08-01T00:00:00.000Z" })], Date.parse("2026-10-06T00:00:00.000Z"));
    assert.equal(metrics.spec.medianHours, 4);
    assert.equal(metrics.spec.firstPass, 50);
  });
});
