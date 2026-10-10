import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MODEL_ROUTER } from "@xdev-hive/core";
import { presetModelProfile, stepModel, stepModelKind } from "#ui/lib/model-routing.ts";

describe("models in pipeline", () => {
  it("edits the shared spec/review/task cell, including fix", () => {
    for (const step of ["spec", "plan", "tasks"] as const) assert.equal(stepModelKind(step, "docs"), "spec");
    assert.equal(stepModelKind("review", "docs"), "review");
    assert.equal(stepModelKind("fix", "docs"), "docs");
    assert.equal(stepModelKind("build", "ui"), "ui");
    assert.equal(stepModelKind("merge", "ui"), "merge");
    assert.equal(stepModelKind("idea"), null);
    assert.equal(stepModelKind("done"), null);
  });
  it("uses hub tiers and profile shifts, and respects routing off", () => {
    const settings = structuredClone(DEFAULT_MODEL_ROUTER);
    settings.tiers.strong.claude = { model: "my-model", effort: "high" };
    settings.projects.app = { enabled: true, preferByCleanRate: false, profile: "balanced", cells: { spec: { m: "strong" } } };
    assert.equal(stepModel(settings, "app", "plan")?.models.claude?.model, "my-model");
    settings.projects.app.profile = "economy";
    assert.equal(stepModel(settings, "app", "plan")?.tier, "standard");
    settings.projects.app.enabled = false;
    assert.equal(stepModel(settings, "app", "review"), null);
  });
  it("previews preset profiles while the fast path keeps the current profile", () => {
    assert.equal(presetModelProfile("cautious"), "quality");
    assert.equal(presetModelProfile("balanced"), "balanced");
    assert.equal(presetModelProfile("maximum"), "economy");
    assert.equal(presetModelProfile("fast"), null);
  });
});
