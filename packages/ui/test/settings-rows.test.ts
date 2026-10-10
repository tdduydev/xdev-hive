import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixRoundOptions, gateModeOptions, projectSettingsPatch } from "#ui/lib/settings-rows.ts";

describe("settings rows", () => {
  it("keeps every stored field when one row changes", () => {
    const view = { gates: { spec: "human" }, effective: {}, maxFixRounds: 3, maxParallel: 4, autoDispatch: true, fastLaneKinds: [], releaseMachine: "m1" } as never;
    const out = projectSettingsPatch(view, { gates: { merge: "ai" } });
    assert.partialDeepStrictEqual(out, { gates: { spec: "human", merge: "ai" }, autoDispatch: true, maxFixRounds: 3, maxParallel: 4, releaseMachine: "m1" });
  });
  it("applies the patch over the stored value and tolerates a project with no settings", () => {
    assert.partialDeepStrictEqual(projectSettingsPatch(undefined, { autoDispatch: false, maxFixRounds: 0 }), { gates: {}, autoDispatch: false, maxFixRounds: 0, maxParallel: null });
  });
  it("offers modes up to the ceiling and never ai for release", () => {
    assert.deepEqual(gateModeOptions("merge", "ai"), ["human", "ai"]);
    assert.deepEqual(gateModeOptions("release", "auto"), ["human", "auto"]);
    assert.deepEqual(gateModeOptions("spec", undefined), ["human", "ai", "auto"]);
  });
  it("lists 0..5 fix rounds", () => assert.deepEqual(fixRoundOptions, [0, 1, 2, 3, 4, 5]));
});
