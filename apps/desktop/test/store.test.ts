import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunStore } from "#desktop/main/runner/store.ts";

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

  it("gives a profile's finished runs with their tokens (roadmap 46)", () => {
    const store = new RunStore(":memory:");
    const add = (profileId: string, finishedAt: string | null, cacheReadTokens: number | null) => {
      const r = store.insert({ project: "app", taskId: "T-1", taskTitle: "x", role: "implement", attempt: 1, maxAttempts: 1 }, "2026-10-01T00:00:00.000Z");
      store.update(r.id, { profileId, finishedAt, status: finishedAt ? "succeeded" : "running", inputTokens: 100, cacheWriteTokens: cacheReadTokens === null ? null : 10, cacheReadTokens, outputTokens: 5 });
    };
    add("claude-1", "2026-10-05T10:00:00.000Z", 900);
    add("claude-1", "2026-09-01T10:00:00.000Z", 900);
    add("claude-1", null, null);
    add("codex-1", "2026-10-05T10:00:00.000Z", 50);
    assert.deepEqual(store.profileTokens("claude-1", "2026-09-05T00:00:00.000Z"), [
      { finishedAt: "2026-10-05T10:00:00.000Z", inputTokens: 100, cacheWriteTokens: 10, cacheReadTokens: 900, outputTokens: 5 },
    ]);
  });
});
