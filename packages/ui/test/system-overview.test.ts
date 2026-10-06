import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemTree } from "#ui/lib/project-picker.ts";
import { systemSummary } from "#ui/lib/system-overview.ts";

describe("system overview", () => {
  const tasks = [{ project: "api", status: "review" as const }, { project: "web", status: "todo" as const }, { project: "web", status: "done" as const }, { project: "solo", status: "blocked" as const }];
  const runs = [{ project: "api", status: "running" }, { project: "api", status: "queued" }, { project: "web", status: "succeeded" }, { project: "solo", status: "running" }];
  const proposals = ["project/api/a", "system/shop/a", "org/a", "project/solo/a"].map((docKey) => ({ docKey, status: "pending" as const }));
  it("counts open work, only running runs and pending reviews by service, with system docs only in the total", () => {
    assert.deepEqual(systemSummary({ name: "shop", virtual: false, services: ["api", "web", "api"] }, tasks, runs, proposals), {
      open: 2, running: 1, pending: 3,
      services: [{ project: "api", open: 1, running: 1, pending: 2 }, { project: "web", open: 1, running: 0, pending: 0 }],
    });
  });
  it("keeps lone repos, empty systems, overlapping memberships and permitted services distinct", () => {
    const systems = [
      { name: "shop", projects: ["api", "web", "hidden"], updatedAt: "", updatedBy: "" },
      { name: "other", projects: ["api"], updatedAt: "", updatedBy: "" },
      { name: "empty", projects: [], updatedAt: "", updatedBy: "" },
    ];
    const cards = systemTree(["api", "web", "solo"], systems).map((root) => [root.name, systemSummary(root, tasks, runs, proposals)] as const);
    assert.deepEqual(cards.map(([name, c]) => [name, c.open, c.running, c.pending]), [["empty", 0, 0, 0], ["other", 1, 1, 2], ["shop", 2, 1, 3], ["solo", 1, 1, 1]]);
    assert.ok(!cards.some(([, c]) => c.services.some((s) => s.project === "hidden")));
  });
  it("does not count resolved proposals or a system document for a virtual root of the same name", () => {
    const card = systemSummary({ name: "shop", services: ["shop"], virtual: true }, [], [], [...proposals, { docKey: "project/shop/x", status: "approved" }]);
    assert.equal(card.pending, 0);
  });
});
