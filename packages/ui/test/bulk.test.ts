import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Memory, Proposal } from "@xdev-hive/core";
import { bulkSelectableProposals, runBulk, splitMemory, splitProposals } from "#ui/lib/bulk.ts";

// The shape the client throws (a HiveError carries its code), without needing the core package at run time.
const hiveError = (code: string, message: string) => Object.assign(new Error(message), { code });

const proposal = (over: Partial<Proposal>): Proposal => ({ id: 1, docKey: "org/a", baseVersion: 1, status: "pending", content: "x", reason: "r", author: "a", ...over }) as Proposal;
const memory = (over: Partial<Memory>): Memory => ({ id: 1, project: "demo", status: "pending", conflictsWith: [], ...over }) as Memory;
const ids = (xs: Array<{ id: number }>) => xs.map((x) => x.id);

describe("bulk approve", () => {
  it("keeps operation proposals out of select all and bulk approval", () => {
    const rows = [proposal({ id: 1 }), proposal({ id: 2, docKey: "project/app/cli-action-abc" }), proposal({ id: 3, status: "approved" })];
    assert.deepEqual(ids(bulkSelectableProposals(rows, () => true)), [1]);
  });
  it("skips proposals whose doc moved past their base version", () => {
    const versions = new Map([
      ["org/a", 2],
      ["org/b", 1],
    ]);
    const r = splitProposals([proposal({ id: 1, docKey: "org/a", baseVersion: 1 }), proposal({ id: 2, docKey: "org/b", baseVersion: 1 }), proposal({ id: 3, docKey: "org/new", baseVersion: 0 })], versions);
    assert.deepEqual(ids(r.ready), [2, 3]);
    assert.deepEqual(ids(r.conflicts), [1]);
  });

  it("approves only the oldest of several picked proposals on one doc", () => {
    const r = splitProposals([proposal({ id: 9, docKey: "org/a" }), proposal({ id: 4, docKey: "org/a" }), proposal({ id: 5, docKey: "org/b" })]);
    assert.deepEqual(ids(r.ready), [4, 5]);
    assert.deepEqual(ids(r.conflicts), [9]);
  });

  it("leaves out proposals and memory that are no longer pending", () => {
    const p = splitProposals([proposal({ id: 1, status: "approved" }), proposal({ id: 2, status: "conflict" })]);
    assert.deepEqual([ids(p.ready), ids(p.conflicts)], [[], []]);
    const m = splitMemory([memory({ id: 1, status: "approved" }), memory({ id: 2 }), memory({ id: 3, conflictsWith: [7] })]);
    assert.deepEqual([ids(m.ready), ids(m.conflicts)], [[2], [3]]);
  });

  it("runs every item in order and sorts conflicts from other errors", async () => {
    const seen: number[] = [];
    const r = await runBulk([1, 2, 3, 4], async (n) => {
      seen.push(n);
      if (n === 2) return "conflict";
      if (n === 3) throw hiveError("conflict", "moved");
      if (n === 4) throw hiveError("forbidden", "no");
      return "done";
    });
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.deepEqual(r.done, [1]);
    assert.deepEqual(r.conflicts, [2, 3]);
    assert.deepEqual(
      r.failed.map((f) => f.item),
      [4],
    );
  });
});
