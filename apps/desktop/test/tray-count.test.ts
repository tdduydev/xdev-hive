import assert from "node:assert/strict";
import { it } from "node:test";
import { HiveError, type HiveBackend } from "@xdev-hive/core";
import { pendingProposalCount } from "#desktop/main/tray-count.ts";

const actor = { name: "desktop", role: "admin" as const };

it("uses the count response when the hub supports it", async () => {
  const calls: string[] = [];
  const backend = { call: async (method: string) => { calls.push(method); return { count: 7 }; } } as unknown as HiveBackend;
  assert.equal(await pendingProposalCount(backend, actor), 7);
  assert.deepEqual(calls, ["proposals.count"]);
});

it("falls back to listing pending proposals on an older hub", async () => {
  const calls: string[] = [];
  const backend = { call: async (method: string) => {
    calls.push(method);
    if (method === "proposals.count") throw new HiveError("bad_request", "Unknown method proposals.count");
    return [{ id: 1 }, { id: 2 }];
  } } as unknown as HiveBackend;
  assert.equal(await pendingProposalCount(backend, actor), 2);
  assert.deepEqual(calls, ["proposals.count", "proposals.list"]);
});
