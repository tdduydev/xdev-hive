import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameData } from "#ui/hooks.ts";

describe("sameData (a poll that brings the same answer keeps the old object)", () => {
  it("compares JSON-shaped answers by value", () => {
    assert.equal(sameData([{ id: "T-1", tags: ["a"], owner: null }], [{ id: "T-1", tags: ["a"], owner: null }]), true);
    assert.equal(sameData({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
    assert.equal(sameData([{ id: "T-1", status: "todo" }], [{ id: "T-1", status: "doing" }]), false);
    assert.equal(sameData({ a: 1 }, { a: 1, b: undefined }), false);
    assert.equal(sameData([1, 2], [1, 2, 3]), false);
    assert.equal(sameData(undefined, null), false);
  });

  it("never calls two different bytes, dates or class objects the same", () => {
    assert.equal(sameData(new Uint8Array([1]), new Uint8Array([2])), false);
    assert.equal(sameData(new Uint8Array([1]), new Uint8Array([1])), false);
    assert.equal(sameData({ when: new Date(1) }, { when: new Date(2) }), false);
    assert.equal(sameData(new Map(), new Map()), false);
    const bytes = new Uint8Array([1]);
    assert.equal(sameData({ bytes }, { bytes }), true);
  });
});
