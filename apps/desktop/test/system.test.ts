import assert from "node:assert/strict";
import { it } from "node:test";
import os from "node:os";
import path from "node:path";
import { SystemSampler, volume } from "#desktop/main/runner/system.ts";
import { schemas } from "@xdev-hive/core";

it("samples bounded host measurements and the volume of a not-yet-created worktree root", async () => {
  const root = path.join(os.tmpdir(), `hive-system-missing-${process.pid}`, "worktrees");
  const sampler = new SystemSampler();
  const s = await sampler.sample(root);
  assert.ok(s.osName && s.hardware);
  assert.ok(s.uptimeSeconds! >= 0);
  assert.equal(s.ram!.totalBytes, os.totalmem());
  assert.ok(s.ram!.percent >= 0 && s.ram!.percent <= 100);
  assert.ok(s.disk!.totalBytes! > 0);
  assert.ok(s.disk!.freeBytes! <= s.disk!.totalBytes!);
  assert.equal((await volume(root))!.totalBytes, (await volume(path.dirname(root)))!.totalBytes);
  schemas["machines.heartbeat"].parse({ machine: "test", instance: "aaaaaaaa", system: s });
  const next = await sampler.sample(root);
  if (next.cpu) { assert.equal(next.cpu.cores, os.cpus().length); assert.ok(next.cpu.percent >= 0 && next.cpu.percent <= 100); }
});

it("computes CPU utilization from elapsed CPU ticks rather than load average", async () => {
  const { mock } = await import("node:test");
  const base = os.cpus()[0]!;
  let ticks = { ...base, times: { user: 20, nice: 0, sys: 0, idle: 80, irq: 0 } };
  const stub = mock.method(os, "cpus", () => [ticks]);
  try {
    const sampler = new SystemSampler();
    ticks = { ...base, times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } };
    assert.equal((await sampler.sample(os.tmpdir())).cpu!.percent, 80);
    ticks = { ...base, times: { user: 125, nice: 0, sys: 0, idle: 175, irq: 0 } };
    assert.equal((await sampler.sample(os.tmpdir())).cpu!.percent, 25);
    assert.equal((await sampler.sample(os.tmpdir())).cpu, undefined, "no elapsed CPU ticks is an unknown measurement");
  } finally { stub.mock.restore(); }
});

it("keeps the last sample and shares an in-flight refresh", async () => {
  const sampler = new SystemSampler();
  assert.equal(sampler.latest, undefined);
  const [a, b] = [sampler.refresh(os.tmpdir()), sampler.refresh(os.tmpdir())];
  assert.equal(a, b, "a second tick while sampling reuses the same promise");
  const s = await a;
  assert.equal(sampler.latest, s);
  assert.notEqual(sampler.refresh(os.tmpdir()), a, "the next refresh starts a new sample");
});
