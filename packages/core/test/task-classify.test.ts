import assert from "node:assert/strict";
import { it } from "node:test";
import { classifyTaskRule, DEFAULT_TASK_CLASS, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const runner: Actor = { name: "runner.mac@duy", role: "agent" };
const profile = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, loggedIn: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };

it("classifies rules, permits manual partial corrections and stores provenance", async () => {
  const hive = new SqliteHive(":memory:");
  const docs = await hive.call("tasks.create", { id: "T-1", project: "app", title: "Update docs for migration" }, admin);
  assert.deepEqual([docs.kind, docs.risk, docs.classifiedBy], ["docs", "high", "rule"]);
  const changed = await hive.call("tasks.classify", { id: "T-1", size: "s" }, admin);
  assert.deepEqual([changed.kind, changed.size, changed.risk, changed.classifiedBy], ["docs", "s", "high", "duy"]);
  assert.equal((await hive.call("tasks.classifyConfig", { project: "app" }, admin)).enabled, true);
  assert.equal(classifyTaskRule("Investigate API failure", null).kind, "debug");
  assert.equal(classifyTaskRule("Draft", null).kind, undefined);
  hive.close();
});

it("queues a small classifier before an assigned task, then releases implementation", async () => {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-2", project: "app", title: "Build account flow" }, admin);
  const beat = () => hive.call("machines.heartbeat", { machine: "mac", instance: "one", profiles: [profile], projects: ["app"], acceptsRuns: true }, runner);
  await beat();
  await hive.call("tasks.assign", { id: "T-2", machineId: runner.name }, admin);
  const first = (await beat()).runRequests[0]!;
  assert.equal(first.role, "classify");
  await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "C-1" }, runner);
  await hive.call("runs.push", { machine: "mac", runs: [{ runId: "C-1", project: "app", taskId: "T-2", taskTitle: "Build account flow", role: "classify", status: "succeeded", profileId: profile.id, summary: '{"kind":"feature","size":"l","risk":"normal","reason":"Several screens"}', createdAt: new Date().toISOString() }] }, runner);
  const next = (await beat()).runRequests.find((r) => r.role === "implement");
  assert.ok(next);
  const task = (await hive.call("tasks.list", { project: "app" }, admin))[0]!;
  assert.deepEqual([task.kind, task.size, task.risk, task.classifiedBy], ["feature", "l", "normal", "ai"]);
  hive.close();
});

it("uses the default after an invalid classifier result, and can disable AI per project", async () => {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-3", project: "app", title: "Build account flow" }, admin);
  const beat = () => hive.call("machines.heartbeat", { machine: "mac", instance: "one", profiles: [profile], projects: ["app"], acceptsRuns: true }, runner);
  await beat();
  await hive.call("tasks.assign", { id: "T-3", machineId: runner.name }, admin);
  const first = (await beat()).runRequests[0]!;
  await hive.call("runs.requestResult", { id: first.id, status: "accepted", runId: "C-2" }, runner);
  await hive.call("runs.push", { machine: "mac", runs: [{ runId: "C-2", project: "app", taskId: "T-3", taskTitle: "Build account flow", role: "classify", status: "succeeded", profileId: profile.id, summary: "not JSON", createdAt: new Date().toISOString() }] }, runner);
  const task = (await hive.call("tasks.list", { project: "app" }, admin))[0]!;
  assert.deepEqual([task.kind, task.size, task.risk], [DEFAULT_TASK_CLASS.kind, DEFAULT_TASK_CLASS.size, DEFAULT_TASK_CLASS.risk]);
  await hive.call("tasks.setClassifyConfig", { project: "app", enabled: false }, admin);
  await hive.call("tasks.create", { id: "T-4", project: "app", title: "Build billing flow" }, admin);
  await hive.call("tasks.assign", { id: "T-4", machineId: runner.name }, admin);
  assert.equal((await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-4")?.kind, "feature");
  hive.close();
});
