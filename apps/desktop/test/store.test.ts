import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunStore } from "#desktop/main/runner/store.ts";

describe("the run store", () => {
  it("counts active runs across scopes regardless of pagination, excluding diff summaries", t => {
    const store = new RunStore(":memory:");
    t.after(() => store.db.close());
    for (let i = 0; i < 205; i++) {
      const r = store.insert({ project: "app", taskId: `T-${i}`, taskTitle: "active", role: "implement", attempt: 1, maxAttempts: 1 }, "2026-10-09T00:00:00Z");
      store.update(r.id, { status: "running" });
    }
    const queued = store.insert({ project: "web", taskId: "queued", taskTitle: "queued", role: "implement", attempt: 1, maxAttempts: 1 }, "2026-10-09T00:00:00Z");
    const summary = store.insert({ project: "app", taskId: "summary", taskTitle: "summary", role: "implement", attempt: 1, maxAttempts: 1 }, "2026-10-09T00:00:00Z");
    store.update(summary.id, { status: "running", diffSummaryFor: queued.id });
    assert.deepEqual(store.countActive(), { running: 205, queued: 1 });
    assert.deepEqual(store.countActive({ projects: ["app"] }), { running: 205, queued: 0 });
    assert.deepEqual(store.countActive({ project: "web" }), { running: 0, queued: 1 });
    assert.deepEqual(store.countActive({ projects: [] }), { running: 0, queued: 0 });
    store.update(queued.id, { status: "succeeded" });
    assert.deepEqual(store.countActive({ project: "web" }), { running: 0, queued: 0 });
  });

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

  it("selects only list metadata for desktop runs", () => {
    const store = new RunStore(":memory:");
    const run = store.insert({ project: "app", taskId: "T-1", taskTitle: "Task", role: "implement", attempt: 1, maxAttempts: 1, instructions: "large prompt" }, "2026-10-01T00:00:00.000Z");
    store.update(run.id, { diffPatch: "large patch", summary: "done", status: "succeeded" });
    const listed = store.listForDesktop();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.summary, "done");
    assert.equal(listed[0]!.diffPatch, null);
    assert.equal(listed[0]!.instructions, "large prompt", "retry keeps the original instructions");
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
