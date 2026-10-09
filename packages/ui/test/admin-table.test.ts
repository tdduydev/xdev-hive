import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterItems, pageItems, sortItems, type TableItem } from "#ui/lib/admin-table.ts";

const rows: Array<TableItem & { id: string }> = [
  { id: "a", sort: ["b", 2], search: "Beta run-1", tags: { g: "x" } },
  { id: "b", sort: ["a", 10], search: "alpha", tags: { g: "y" } },
  { id: "c", sort: ["", null], search: "gamma", tags: { g: "x" } },
  { id: "d", sort: ["c", 1], search: "delta", tags: { g: "x" } },
];
const ids = (r: Array<{ id: string }>) => r.map((x) => x.id);

describe("admin table helpers", () => {
  it("searches case-insensitively and combines filters", () => {
    assert.deepEqual(ids(filterItems(rows, "BETA", {})), ["a"]);
    assert.deepEqual(ids(filterItems(rows, "", { g: "x" })), ["a", "c", "d"]);
    assert.deepEqual(ids(filterItems(rows, "a", { g: "y" })), ["b"]);
    assert.equal(filterItems(rows, "", { g: "" }).length, 4);
  });
  it("sorts both ways, numbers numerically, blanks last", () => {
    assert.deepEqual(ids(sortItems(rows, 1, "asc")), ["d", "a", "b", "c"]);
    assert.deepEqual(ids(sortItems(rows, 1, "desc")), ["b", "a", "d", "c"]);
    assert.deepEqual(ids(sortItems(rows, 0, "asc")), ["b", "a", "d", "c"]);
    assert.equal(sortItems(rows, null, "asc"), rows);
  });
  it("pages and clamps", () => {
    assert.deepEqual(pageItems([1, 2, 3, 4, 5], 9, 2), { rows: [5], page: 3, pages: 3, from: 5, to: 5, total: 5 });
    assert.deepEqual(pageItems([], 1), { rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });
});
