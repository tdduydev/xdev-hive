import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toneForRatio, usedPercent } from "#ui/lib/admin-ops.ts";

describe("admin ops helpers", () => {
  it("measures use against a limit, clamped to a bar", () => {
    assert.equal(usedPercent(5, 10), 50);
    assert.equal(usedPercent(15, 10), 100);
    assert.equal(usedPercent(-1, 10), 0);
    assert.equal(usedPercent(1, undefined), null);
    assert.equal(usedPercent(1, 0), null);
  });
  it("turns amber from 70% and red at the cap", () => {
    assert.equal(toneForRatio(0.69), "ok");
    assert.equal(toneForRatio(0.7), "warn");
    assert.equal(toneForRatio(1), "bad");
  });
});
