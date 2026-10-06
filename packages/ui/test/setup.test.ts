import assert from "node:assert/strict";
import { test } from "node:test";
import type { SetupItem, SetupReport } from "@xdev-hive/core";
import { installSetupSequence, needsSetup, setupGroups, setupOrder } from "#ui/lib/setup.ts";
const item = (id: string, state: SetupItem["state"] = "missing", action: string | null = "Install"): SetupItem => ({ id, state, action, label: id, detail: id });
const report = (): SetupReport => ({ machine: [item("cli:specify")], projects: [
  { project: "a", repo: "/a", items: [item("a:codegraph-index"), item("a:speckit", "missing", null), item("a:agents")] },
  { project: "b", repo: "/b", items: [item("b:agents", "installed", null)] },
  { project: "c", repo: "/c", items: [item("c:agents")] },
] });
test("systems contain only local projects once; outside projects come last", () => {
  assert.deepEqual(setupGroups(report().projects, [{ name: "one", projects: ["b", "a", "remote"] }, { name: "two", projects: ["a"] }]).map((g) => [g.name, g.projects.map((p) => p.project)]), [["one", ["a", "b"]], ["", ["c"]]]);
});
test("machine prerequisites first, integrations before index, scope respected", () => {
  assert.deepEqual(setupOrder(report()).map((i) => i.id), ["cli:specify", "a:speckit", "a:agents", "a:codegraph-index", "c:agents"]);
  assert.deepEqual(setupOrder(report(), ["a"]).map((i) => i.id), ["a:speckit", "a:agents", "a:codegraph-index"]);
  assert.equal(needsSetup({ ...item("cli:codex", "installed"), version: "1.0.0", latest: "2.0.0" }), true);
});
test("refresh unlocks dependent installs; every install is sequential", async () => {
  const current = report(); const calls: string[] = [];
  const left = await installSetupSequence(current, undefined, {
    async installSetup(id) {
      calls.push(id);
      const all = [...current.machine, ...current.projects.flatMap((p) => p.items)];
      const installed = all.find((i) => i.id === id)!; installed.state = "installed"; installed.action = null;
      if (id === "cli:specify") all.find((i) => i.id === "a:speckit")!.action = "Install";
      return { item: installed, output: "" };
    }, async setupStatus() { return current; },
  }, () => {}, () => {});
  assert.deepEqual(calls, ["cli:specify", "a:speckit", "a:agents", "a:codegraph-index", "c:agents"]);
  assert.deepEqual(left, []);
});
test("failed verification stops the batch and preserves the refreshed report", async () => {
  let changed = false; const calls: string[] = [];
  await assert.rejects(installSetupSequence(report(), ["a"], {
    async installSetup(id) { calls.push(id); return { item: item(id), output: "failed" }; },
    async setupStatus() { return report(); },
  }, () => { changed = true; }, () => {}), /failed/);
  assert.deepEqual(calls, ["a:agents"]); assert.equal(changed, true);
});
test("manual items remain visible without attempting an unsupported install", async () => {
  const r = { machine: [item("agy", "manual", null)], projects: [] };
  const left = await installSetupSequence(r, undefined, { async installSetup() { throw new Error("must not run"); }, async setupStatus() { return r; } }, () => {}, () => {});
  assert.equal(left.length, 1);
});

test("install exception names the failing item and stops before later items", async () => {
  const calls: string[] = [];
  await assert.rejects(installSetupSequence(report(), undefined, {
    async installSetup(id) { calls.push(id); throw new Error("installer failed"); },
    async setupStatus() { throw new Error("must not refresh after exception"); },
  }, () => {}, () => {}), /cli:specify: installer failed/);
  assert.deepEqual(calls, ["cli:specify"]);
});


test("machine-only guide step stays scoped after refreshing the full report", async () => {
  const current = report(); const calls: string[] = [];
  const left = await installSetupSequence(current, "machine", {
    async installSetup(id) {
      calls.push(id);
      const i = current.machine.find((i) => i.id === id)!;
      i.state = "installed";
      return { item: i, output: "" };
    },
    async setupStatus() { return current; },
  }, () => {}, () => {});
  assert.deepEqual(calls, ["cli:specify"]);
  assert.deepEqual(left, []);
  assert.equal(current.projects[0]!.items[0]!.state, "missing");
});
