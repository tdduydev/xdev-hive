import assert from "node:assert/strict";
import { it } from "node:test";
import { backgroundDelay } from "#desktop/main/runner/runner.ts";

it("backs off heartbeat and poll failures with jitter at their scheduler", () => {
  assert.equal(backgroundDelay(30_000, 0, () => 0), 30_000);
  assert.equal(backgroundDelay(30_000, 1, () => 0), 11_250);
  assert.equal(backgroundDelay(30_000, 2, () => 1), 37_500);
  assert.equal(backgroundDelay(5_000, 3, () => 0.5), 10_000);
  assert.equal(backgroundDelay(5_000, 20, () => 1), 75_000);
});
