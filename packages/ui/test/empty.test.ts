import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyState } from "#ui/lib/empty.ts";

describe("empty state of a knowledge list", () => {
  it("says nothing while the list is still loading, or when it has rows on screen", () => {
    assert.equal(emptyState({ loaded: false, total: 0, shown: 0 }), null);
    assert.equal(emptyState({ loaded: true, total: 3, shown: 3 }), null);
  });

  it("offers to create only when the collection itself is empty", () => {
    assert.equal(emptyState({ loaded: true, total: 0, shown: 0 }), "none");
    assert.equal(emptyState({ loaded: true, total: 0, shown: 0, query: "", filtered: false }), "none");
  });

  // A search the hub ran comes back with no rows at all: that is not an empty project.
  it("blames the search when one was made and nothing came back", () => {
    assert.equal(emptyState({ loaded: true, total: 0, shown: 0, query: "qr" }), "noMatch");
  });

  it("blames the page's own search box when the rows are there but none match", () => {
    assert.equal(emptyState({ loaded: true, total: 5, shown: 0, query: "qr" }), "noMatch");
    assert.equal(emptyState({ loaded: true, total: 5, shown: 0 }), "noMatch");
  });

  // Both a search and a chip can hide the rows; the chip is the narrower one, so it is what the page offers to undo.
  it("blames the filter chip when it is on and rows came back", () => {
    assert.equal(emptyState({ loaded: true, total: 5, shown: 0, filtered: true }), "noFilter");
    assert.equal(emptyState({ loaded: true, total: 5, shown: 0, query: "qr", filtered: true }), "noFilter");
  });
});
