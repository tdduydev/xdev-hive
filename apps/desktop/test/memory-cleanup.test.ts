import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AGENT_TEMPLATES, HiveError, type Actor, type HiveBackend, type MemoryCleanupRun } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { MemoryCleanupWorker, parseCleanupSuggestions } from "#desktop/main/runner/memory-cleanup.ts";
import type { AssistHost } from "#desktop/main/runner/assist.ts";

it("validates AI results before sending proposals to the hub", () => {
  assert.deepEqual(parseCleanupSuggestions('```json\n[{"kind":"merge","ids":[1,2],"content":"Same fact","reason":"Duplicate"}]\n```')[0]?.ids, [1,2]);
  assert.deepEqual(parseCleanupSuggestions("[]"), []);
  for (const text of ['[{"kind":"remove","ids":[1,1],"reason":"Duplicate"}]', '[{"kind":"merge","ids":[1],"reason":"One"}]', '[{"kind":"remove","ids":[1],"content":"Replacement","reason":"Old"}]', 'not JSON']) assert.throws(() => parseCleanupSuggestions(text));
});

it("releases the profile reservation and reports a stopped job when quitting during take", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-worker-"));
  const hive = new SqliteHive(":memory:");
  const machine: Actor = { name: "runner.mac@mac", role: "agent" };
  const admin: Actor = { name: "admin", role: "admin" };
  await hive.call("machines.heartbeat", { machine: "mac", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: true }, machine);
  await hive.call("memory.write", { project: "app", kind: "decision", content: "Keep this fact" }, admin);
  await hive.call("memory.setCleanup", { project: "app", enabled: true }, admin);
  hive.queueMemoryCleanup();
  const job = (await hive.call("memory.cleanupTake", { projects: ["app"] }, machine))!;
  let release!: (run: MemoryCleanupRun) => void;
  const taking = new Promise<MemoryCleanupRun>((resolve) => { release = resolve; });
  const backend: HiveBackend = { call: ((method, input, actor) => method === "memory.cleanupTake" ? taking : hive.call(method, input, actor)) as HiveBackend["call"] };
  const host: AssistHost = { backend: () => backend, actor: () => machine, profiles: () => [AGENT_TEMPLATES.claude], projects: () => [{ name: "app", repo: dir }], machine: () => "mac", env: () => ({}) };
  const worker = new MemoryCleanupWorker(host, dir);
  try {
    const poll = worker.poll();
    assert.equal(worker.profileId, AGENT_TEMPLATES.claude.id);
    worker.stop();
    const settled = worker.settle();
    release(job);
    await poll; await settled;
    assert.equal(worker.profileId, null);
    const run = (await hive.call("memory.cleanupRuns", { project: "app" }, admin))[0]!;
    assert.equal(run.status, "failed"); assert.equal(run.error, "stopped");
    assert.equal((await hive.call("memory.list", { project: "app" }, admin))[0]?.content, "Keep this fact");
    assert.equal(await worker.poll(), false);
  } finally { worker.stop(); await worker.settle(); hive.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("stops polling an older hub that does not implement cleanup", async () => {
  let calls = 0;
  const host: AssistHost = {
    backend: () => ({ call: async () => { calls++; throw new HiveError("bad_request", "Unknown method memory.cleanupTake"); } }),
    actor: () => ({ name: "machine", role: "agent" }), profiles: () => [AGENT_TEMPLATES.claude], projects: () => [], machine: () => "mac", env: () => ({}),
  };
  const worker = new MemoryCleanupWorker(host, os.tmpdir());
  await assert.rejects(worker.poll());
  assert.equal(worker.profileId, null);
  assert.equal(await worker.poll(), false); assert.equal(calls, 1);
});
