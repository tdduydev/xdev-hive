import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_AUTOMATION_GATES, type SdlcGateRecord } from "@xdev-hive/core";
import { gateMetrics, modeWithinCeiling, presetGates, stepCounts, passedGates, taskStep, PIPELINE_STEPS, PIPELINE_STEP_GATES } from "#ui/lib/pipeline.ts";

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
    const metrics = gateMetrics([record(), record({ id: 2, taskId: "F-2", status: "rejected", decidedAt: "2026-10-05T16:00:00.000Z" }), record({ id: 3, createdAt: "2026-08-01T00:00:00.000Z" })], Date.parse("2026-10-06T00:00:00.000Z"));
    assert.equal(metrics.spec.medianHours, 4);
    assert.equal(metrics.spec.firstPass, 50);
  });
  it("has twelve fixed stages and exactly the nine policy gates", () => {
    assert.equal(PIPELINE_STEPS.length, 12);
    assert.deepEqual(Object.values(PIPELINE_STEP_GATES), ["spec", "plan", "tasks", "dispatch", "review", "fix", "test", "merge", "release"]);
  });
  it("never counts approval after a rejection as first pass", () => {
    const metrics = gateMetrics([record({ id: 1, status: "rejected" }), record({ id: 2 }), record({ id: 3, taskId: "F-2" }), record({ id: 4, taskId: "F-3", firstAttempt: false })], Date.parse("2026-10-06T00:00:00Z"));
    assert.equal(metrics.spec.firstPass, 50);
    assert.equal(gateMetrics([record({ mode: "ai", decidedBy: "lan" })], Date.parse("2026-10-06T00:00:00Z")).spec.firstPass, 0);
    assert.equal(passedGates([record(), record({ id: 2, status: "waiting", decidedAt: null })]).has("spec"), false);
    assert.equal(passedGates([record(), record({ id: 2, taskId: "F-2", status: "waiting", decidedAt: null })]).has("spec"), false);
    assert.equal(passedGates([record()]).has("spec"), true);
  });
  it("uses the actual gate for a task waiting at Fix or Merge", () => {
    const task = { taskId: "T-1", flowTask: "F-1", project: "app", stage: "gate" as const, gate: record({ gate: "merge" }), fixRounds: 0, machineId: null, runId: null, note: null, updatedAt: at };
    assert.equal(taskStep(task), "merge");
    assert.equal(taskStep({ ...task, gate: record({ gate: "fix" }) }), "fix");
    assert.equal(taskStep({ ...task, gate: null, stage: "queued" }), "dispatch");
  });

});
