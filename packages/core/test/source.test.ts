import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentSource, parseSource, readSourceHeader, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const run = { via: "mcp", machine: "duy-mbp", run: "R-1fa9e2", task: "T-7" } as const;
const agent: Actor = { name: "claude-1.duy-mbp@duy", role: "agent", source: run };
const admin: Actor = { name: "duy", role: "admin", source: { via: "web" } };

describe("write sources", () => {
  it("keeps well-formed fields and drops the rest", () => {
    assert.deepEqual(parseSource(run), run);
    assert.deepEqual(parseSource({ via: "desktop", machine: "Not A Machine!", run: "x".repeat(80), task: "T 1" }), { via: "desktop" });
    assert.equal(parseSource({ machine: "duy-mbp" }), null, "via is required");
    assert.equal(parseSource({ via: "email" }), null);
    assert.deepEqual(agentSource("duy-mbp", { HIVE_RUN: "R-1fa9e2", HIVE_TASK: "T-7" }), run);
    assert.deepEqual(agentSource("duy-mbp", {}), { via: "mcp", machine: "duy-mbp" });
  });

  it("never lets a token client claim to be the web page", () => {
    assert.deepEqual(readSourceHeader(JSON.stringify(run)), run);
    assert.deepEqual(readSourceHeader(JSON.stringify({ via: "web", machine: "duy-mbp" })), { via: "api", machine: "duy-mbp" });
    assert.deepEqual(readSourceHeader("not json"), { via: "api" });
    assert.deepEqual(readSourceHeader(undefined), { via: "api" });
  });

  it("stores the source with each doc version, proposal and memory", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/style", content: "Tabs", baseVersion: 0 }, admin);
    const p = await hive.call("proposals.create", { docKey: "org/style", baseVersion: 1, content: "Spaces", reason: "team voted" }, agent);
    assert.deepEqual(p.source, run);
    await hive.call("proposals.approve", { id: p.id }, admin);
    const [v2, v1] = await hive.call("docs.history", { key: "org/style" }, admin);
    assert.deepEqual(v1!.source, { via: "web" });
    assert.deepEqual(v2!.source, run, "an approved version keeps where its text came from");

    const m = await hive.call("memory.write", { project: "app", kind: "gotcha", content: "Build needs Node 26" }, agent);
    assert.deepEqual(m.source, run);
    assert.equal(m.taskId, "T-7", "the run's task, when the agent does not name one");
    const named = await hive.call("memory.write", { project: "app", kind: "gotcha", content: "Other", taskId: "T-2" }, agent);
    assert.equal(named.taskId, "T-2");
    const bare = await hive.call("memory.write", { project: "app", kind: "context", content: "No source" }, { name: "duy", role: "admin" });
    assert.equal(bare.source, null);
    const seeded = new SqliteHive(":memory:");
    seeded.seed();
    assert.equal((await seeded.call("docs.history", { key: "org/agent-protocol" }, admin))[0]!.source, null);
  });
});
