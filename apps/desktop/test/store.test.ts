import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunStore } from "../src/main/runner/store.ts";

describe("the run store", () => {
  it("lists one project's runs, a system's, or every one", () => {
    const store = new RunStore(":memory:");
    for (const [i, project] of ["app", "web", "api"].entries()) {
      store.insert({ project, taskId: `T-${i}`, taskTitle: project, role: "implement", attempt: 1, maxAttempts: 1 }, `2026-09-30T08:0${i}:00.000Z`);
    }
    const projects = (runs: Array<{ project: string }>) => runs.map((r) => r.project);
    assert.deepEqual(projects(store.list()), ["api", "web", "app"], "newest first");
    assert.deepEqual(projects(store.list({ project: "web" })), ["web"]);
    assert.deepEqual(projects(store.list({ projects: ["app", "api"] })), ["api", "app"]);
    assert.deepEqual(store.list({ projects: [] }), []);
    // Whatever the page sends, only strings go into the list.
    assert.deepEqual(projects(store.list({ projects: [1, "web"] as never })), ["web"]);
  });
});
