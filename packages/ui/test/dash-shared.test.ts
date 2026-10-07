import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capSummary, sortAttention } from "#ui/lib/summary.ts";

describe("dashboard shared rules", () => {
  it("caps the summary strip at 4 numbers", () => {
    assert.deepEqual(capSummary([1, 2, 3, 4, 5]), [1, 2, 3, 4]);
    assert.deepEqual(capSummary([1, 2]), [1, 2]);
  });
  it("lists the worst attention first and keeps the order within a level", () => {
    const out = sortAttention([
      { id: "a", level: "info" as const },
      { id: "b", level: "danger" as const },
      { id: "c", level: "warning" as const },
      { id: "d", level: "danger" as const },
    ]);
    assert.deepEqual(out.map((i) => i.id), ["b", "d", "c", "a"]);
  });
});
