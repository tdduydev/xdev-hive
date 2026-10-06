import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteHive } from "#core/node.ts";
import type { Actor } from "#core/index.ts";
const admin: Actor = { name: "admin", role: "admin" };
const machine: Actor = { name: "runner.mac@mac", role: "agent" };
const other: Actor = { name: "runner.other@other", role: "agent" };
const lead: Actor = { name: "lead", role: "member", account: "lead", source: { via: "web" }, access: { projects: { app: "lead" } } };
const viewer: Actor = { name: "viewer", role: "viewer", access: { projects: { app: "viewer" } } };

async function setup() {
  let now = new Date("2026-10-06T00:00:00Z");
  const hive = new SqliteHive(":memory:", { now: () => now });
  await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: true }, machine);
  const a = await hive.call("memory.write", { project: "app", kind: "decision", content: "Use aliases", files: ["src/a.ts"] }, admin);
  const b = await hive.call("memory.write", { project: "app", kind: "decision", content: "Use package aliases", files: ["src/b.ts"] }, admin);
  await hive.call("memory.write", { project: "secret", kind: "decision", content: "Other project's facts" }, admin);
  await hive.call("memory.write", { shared: true, kind: "decision", content: "Shared facts" }, admin);
  await hive.call("memory.setCleanup", { project: "app", enabled: true }, lead);
  return { hive, a, b, advance: (days: number) => { now = new Date(now.getTime() + days * 86400_000); } };
}
async function finish(hive: SqliteHive, ids: number[], kind: "merge" | "remove" = "merge") {
  hive.queueMemoryCleanup();
  const run = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
  await hive.call("memory.cleanupFinish", { id: run.id, suggestions: [{ kind, ids, reason: "Same convention", ...(kind === "merge" ? { content: "Use package aliases" } : {}) }] }, machine);
  return (await hive.call("memory.cleanupProposals", { project: "app" }, lead))[0]!;
}

describe("weekly memory review", () => {
  it("queues at most once a week across restarts and does not overlap active runs", async () => {
    const { hive, advance } = await setup();
    assert.equal(hive.queueMemoryCleanup(), 1);
    assert.equal(hive.queueMemoryCleanup(), 0);
    advance(8);
    assert.equal(hive.queueMemoryCleanup(), 0, "the queued run still waits for a machine");
    const run = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
    await hive.call("memory.cleanupFinish", { id: run.id, suggestions: [] }, machine);
    assert.equal(hive.queueMemoryCleanup(), 1, "missed weeks catch up once");
    assert.equal(hive.queueMemoryCleanup(), 0);
    hive.close();
  });
  it("reads project memory only, requires the taking machine, and does not count review as usage", async () => {
    const { hive, a, b } = await setup(); hive.queueMemoryCleanup();
    assert.equal(await hive.call("memory.cleanupTake", { projects: ["app"] }, other), null);
    const job = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
    const read = await hive.call("memory.cleanupRead", { id: job.id }, machine);
    assert.deepEqual(read.entries.map((m) => m.id), [a.id, b.id]);
    assert.equal(read.next, null);
    await assert.rejects(hive.call("memory.cleanupRead", { id: job.id }, other), { code: "forbidden" });
    await assert.rejects(hive.call("memory.cleanupFinish", { id: job.id, suggestions: [{ kind: "remove", ids: [999], reason: "out of project" }] }, machine), { code: "bad_request" });
    assert.equal((await hive.call("memory.list", { project: "app" }, admin))[0]!.useCount, 0);
    hive.close();
  });
  it("creates suggestions without changing originals; a human merge keeps sources and citations", async () => {
    const { hive, a, b } = await setup(); const p = await finish(hive, [a.id, b.id]);
    assert.equal((await hive.call("memory.list", { project: "app" }, admin)).length, 2);
    await assert.rejects(hive.call("memory.decideCleanup", { id: p.id, accept: true }, machine), { code: "forbidden" });
    await assert.rejects(hive.call("memory.decideCleanup", { id: p.id, accept: true }, viewer), { code: "forbidden" });
    assert.equal((await hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead)).status, "approved");
    const entries = await hive.call("memory.list", { project: "app" }, lead);
    const merged = entries.find((m) => !m.supersededBy)!;
    assert.equal(merged.content, "Use package aliases");
    assert.deepEqual(merged.files.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
    assert.ok(entries.filter((m) => m.id !== merged.id).every((m) => m.supersededBy === merged.id));
    await assert.rejects(hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead), { code: "conflict" });
    hive.close();
  });
  it("rejecting keeps memory; approving removal deletes only the named facts", async () => {
    const { hive, a, b, advance } = await setup(); const p = await finish(hive, [a.id], "remove");
    await hive.call("memory.decideCleanup", { id: p.id, accept: false }, lead);
    assert.equal((await hive.call("memory.list", { project: "app" }, lead)).length, 2);
    advance(7); const second = await finish(hive, [a.id], "remove");
    await hive.call("memory.decideCleanup", { id: second.id, accept: true }, lead);
    assert.deepEqual((await hive.call("memory.list", { project: "app" }, lead)).map((m) => m.id), [b.id]);
    hive.close();
  });
  it("conflicts atomically when any original changed or disappeared", async () => {
    const { hive, a, b } = await setup(); const p = await finish(hive, [a.id, b.id]);
    await hive.call("memory.remove", { id: b.id }, lead);
    assert.equal((await hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead)).status, "conflict");
    assert.deepEqual((await hive.call("memory.list", { project: "app" }, lead)).map((m) => m.id), [a.id]);
    hive.close();
  });
  it("moves external contradiction links to the merged fact without leaving historical sources in conflict", async () => {
    const { hive, a, b } = await setup();
    const other = await hive.call("memory.write", { project: "app", kind: "decision", content: "Use relative imports", contradicts: a.id }, admin);
    const p = await finish(hive, [a.id, b.id]);
    await hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead);
    const rows = await hive.call("memory.list", { project: "app" }, lead);
    const merged = rows.find((m) => m.id !== other.id && !m.supersededBy)!;
    assert.deepEqual(merged.conflictsWith, [other.id]);
    assert.deepEqual(rows.find((m) => m.id === other.id)!.conflictsWith, [merged.id]);
    assert.deepEqual(rows.find((m) => m.id === a.id)!.conflictsWith, []);
    hive.close();
  });
  it("search usage does not conflict with a merge, while agent tokens with approval grants still cannot decide", async () => {
    const { hive, a, b } = await setup(); const p = await finish(hive, [a.id, b.id]);
    await hive.call("memory.search", { project: "app", query: "aliases" }, machine);
    const privilegedAgent: Actor = { ...machine, access: { projects: { app: "lead" } } };
    await assert.rejects(hive.call("memory.decideCleanup", { id: p.id, accept: true }, privilegedAgent), { code: "forbidden" });
    assert.equal((await hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead)).status, "approved");
    hive.close();
  });
  it("pages through all project facts and expires a lost worker without modifying them", async () => {
    const { hive, advance } = await setup();
    for (let i = 0; i < 11; i++) await hive.call("memory.write", { project: "app", kind: "context", content: `Fact ${i}` }, admin);
    hive.queueMemoryCleanup();
    const run = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
    const first = await hive.call("memory.cleanupRead", { id: run.id }, machine);
    assert.equal(first.entries.length, 10); assert.equal(first.next, 10);
    const last = await hive.call("memory.cleanupRead", { id: run.id, offset: first.next! }, machine);
    assert.equal(last.entries.length, 3); assert.equal(last.next, null);
    advance(1); hive.queueMemoryCleanup();
    const expired = (await hive.call("memory.cleanupRuns", { project: "app" }, lead))[0]!;
    assert.equal(expired.status, "failed"); assert.equal(expired.error, "expired");
    assert.equal((await hive.call("memory.list", { project: "app" }, lead)).length, 13);
    assert.equal((await hive.call("memory.cleanupFinish", { id: run.id, suggestions: [] }, machine)).ok, false);
    hive.close();
  });
  it("does not repeat undecided weekly proposals and rejects overlapping suggestions atomically", async () => {
    const { hive, a, b, advance } = await setup(); await finish(hive, [a.id, b.id]);
    advance(7); await finish(hive, [a.id, b.id]);
    assert.equal((await hive.call("memory.cleanupProposals", { project: "app" }, lead)).length, 1);
    advance(7); hive.queueMemoryCleanup();
    const run = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
    await assert.rejects(hive.call("memory.cleanupFinish", { id: run.id, suggestions: [
      { kind: "remove", ids: [a.id], reason: "Old" }, { kind: "remove", ids: [a.id], reason: "Duplicate id" },
    ] }, machine), { code: "bad_request" });
    assert.equal((await hive.call("memory.cleanupRuns", { project: "app" }, lead))[0]!.status, "running");
    hive.close();
  });
  it("disabled, paused and archived projects do not run; settings and proposal lists respect project access", async () => {
    const { hive, a } = await setup();
    await assert.rejects(hive.call("memory.setCleanup", { project: "app", enabled: false }, viewer), { code: "forbidden" });
    await hive.call("agents.stop", { project: "app" }, lead);
    assert.equal(hive.queueMemoryCleanup(), 0);
    await hive.call("agents.resume", { project: "app" }, lead);
    const p = await finish(hive, [a.id], "remove");
    await hive.call("memory.setCleanup", { project: "secret", enabled: true }, admin);
    assert.deepEqual((await hive.call("memory.cleanupSettings", {}, viewer)).map((x) => x.project), ["app"]);
    await hive.call("projects.archive", { project: "app" }, admin);
    await assert.rejects(hive.call("memory.decideCleanup", { id: p.id, accept: true }, lead), { code: "conflict" });
    assert.equal((await hive.call("memory.cleanupProposals", {}, lead)).length, 0);
    hive.close();
  });
});
